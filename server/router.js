"use strict";

/**
 * HANNAH model router: decides which provider and model answer a request.
 *
 * The gateway (gateway.js) moves bytes; this module makes the decision. It
 * classifies the request, collects every model the caller may use, filters by
 * the caller's routing policy, ranks what's left for the chosen mode, and
 * returns the choice with its reason, alternatives, limitations and a cost
 * estimate where a verified price exists.
 *
 * Modes:
 *   quality   the most capable model available
 *   balanced  fit the model to the request (the default)
 *   budget    the cheapest model that can still do the job
 *   fastest   lowest measured latency, then models profiled as fast
 *   private   only models on this server's own hardware (Ollama, LM Studio,
 *             llama.cpp, vLLM); nothing goes to a cloud AI provider
 *   offline   like private on the server; the app runs it on the device
 *   custom    the caller's own provider list and tier ceiling
 *
 * Privacy is enforced here, in code, for every candidate and every fallback:
 * a private request can never reach a hosted provider.
 */

const profiles = require("../shared/model-profiles.json");
const { defaultModelFor, isLocalHostname } = require("./providers/catalog");
const { knownPriceFor, verifiedPriceFor } = require("./cost-tracking");
const { classifyRequest, modelSupportsTools } = require("./gateway");
const { servedStatus } = require("./providers/served");

const MODES = ["quality", "balanced", "budget", "fastest", "private", "offline", "custom"];
const TIERS = ["small", "efficient", "strong", "frontier"];
const TIER_RANK = { small: 1, efficient: 2, strong: 3, frontier: 4, unrated: 2 };
const DESIRED = { simple: 1, standard: 2.5, complex: 4 };
/** Lowest tier that can reasonably handle each request level (budget and fastest modes). */
const NEEDED = { simple: 1, standard: 2, complex: 3 };
/** Reply length assumed for estimates, in tokens. Stated in every estimate. */
const ASSUMED_OUTPUT_TOKENS = 700;

class RoutingError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Validate a routing policy from a request. Unknown fields are ignored; bad values are rejected. */
function normalizeRouting(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RoutingError("The routing settings are invalid.", "invalid_routing");
  const mode = raw.mode === undefined ? "balanced" : raw.mode;
  if (!MODES.includes(mode)) throw new RoutingError(`Routing mode must be one of: ${MODES.join(", ")}.`, "invalid_routing");
  let providers = null;
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers) || raw.providers.length > 25 || !raw.providers.every((id) => typeof id === "string" && /^[a-z0-9_-]{1,40}$/.test(id))) {
      throw new RoutingError("Custom routing providers must be a list of provider ids.", "invalid_routing");
    }
    providers = raw.providers.length ? [...new Set(raw.providers)] : null;
  }
  let maxTier = null;
  if (raw.maxTier !== undefined && raw.maxTier !== null) {
    if (!TIERS.includes(raw.maxTier)) throw new RoutingError(`maxTier must be one of: ${TIERS.join(", ")}.`, "invalid_routing");
    maxTier = raw.maxTier;
  }
  const localOnly = mode === "private" || mode === "offline" || (mode === "custom" && raw.localOnly === true);
  return { mode, providers: mode === "custom" ? providers : null, maxTier: mode === "custom" ? maxTier : null, localOnly };
}

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/;

/**
 * Whether a provider runs on hardware the operator controls: the local
 * runtimes (Ollama, LM Studio, llama.cpp, vLLM), any provider whose endpoint
 * is loopback or a private network address, or one the operator lists in
 * HANNAH_SELF_HOSTED_PROVIDERS (for example a vLLM box on their own VPS).
 */
function selfHosted(provider) {
  if (!provider) return false;
  if (provider.local) return true;
  const declared = String(process.env.HANNAH_SELF_HOSTED_PROVIDERS || "").split(",").map((id) => id.trim().toLowerCase()).filter(Boolean);
  if (declared.includes(provider.id)) return true;
  try {
    const { hostname } = new URL(provider.baseUrl);
    return isLocalHostname(hostname) || PRIVATE_IPV4.test(hostname) || hostname.endsWith(".local");
  } catch {
    return false;
  }
}

/** Whether a policy forbids sending this provider the request. */
function privacyBlocks(policy, provider) {
  return Boolean(policy?.localOnly && !selfHosted(provider));
}

// ---------------------------------------------------------------------------
// Provider health and measured latency, per process. Real outcomes only.

const HEALTH_WINDOW_MS = 60_000;
const stats = new Map();

function recordOutcome(providerId, { ok, latencyMs, retryable = true, now = Date.now() } = {}) {
  if (!providerId) return;
  const entry = stats.get(providerId) || { latencyMs: null, samples: 0, failures: 0, lastFailureAt: 0 };
  if (ok) {
    entry.failures = 0;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      entry.latencyMs = entry.latencyMs === null ? latencyMs : entry.latencyMs * 0.7 + latencyMs * 0.3;
      entry.samples += 1;
    }
  } else if (retryable) {
    entry.failures += 1;
    entry.lastFailureAt = now;
  }
  stats.set(providerId, entry);
}

function providerHealth(providerId, now = Date.now()) {
  const entry = stats.get(providerId);
  if (!entry) return { healthy: true, latencyMs: null, samples: 0 };
  const coolingDown = entry.failures >= 3 && now - entry.lastFailureAt < HEALTH_WINDOW_MS;
  return { healthy: !coolingDown, latencyMs: entry.samples >= 3 ? Math.round(entry.latencyMs) : null, samples: entry.samples };
}

function resetStats() {
  stats.clear();
}

// ---------------------------------------------------------------------------
// Candidates and scoring

/** Every model the caller could use, from the providers they're allowed to reach. */
function collectCandidates(usableProviders, { needsTools }) {
  const out = [];
  for (const provider of usableProviders) {
    const seen = new Set();
    const add = (model, tier, strengths, speed) => {
      if (!model || seen.has(model)) return;
      const preset = provider.models.find((item) => item.id === model);
      if (needsTools && preset && preset.tools === false) return;
      if (preset?.notes && /not chat/i.test(preset.notes)) return;
      // The provider's live list doesn't have it: it was retired.
      if (servedStatus(provider.id, model) === false) return;
      seen.add(model);
      out.push({ provider, model, tier, strengths, speed, context: preset?.context ?? null, local: selfHosted(provider) });
    };
    for (const profile of profiles.hosted.filter((item) => item.provider === provider.id)) add(profile.model, profile.tier, profile.strengths, profile.speed);
    // Local and unprofiled providers: their configured default model, unrated.
    add(defaultModelFor(provider), "unrated", [], "standard");
  }
  return out;
}

function priceScore(candidate) {
  if (candidate.local) return 0;
  const price = knownPriceFor(candidate.model);
  if (price) return price.input * 0.3 + price.output;
  return candidate.provider.free ? 0.2 : 3; // Unknown paid price: assume it isn't cheap.
}

function scoreCandidate(candidate, classification, mode, { preferredProviderId, budgetTight }) {
  const rank = TIER_RANK[candidate.tier] || 2;
  const strength = candidate.strengths.includes(classification.task) ? 1 : 0;
  const health = providerHealth(candidate.provider.id);
  let score;
  if (mode === "quality") {
    score = rank * 2 + strength;
  } else if (mode === "budget") {
    score = (rank < NEEDED[classification.level] ? -6 : 0) - priceScore(candidate) * 2 - rank * 0.2 + strength * 0.3;
  } else if (mode === "fastest") {
    const latency = health.latencyMs;
    score = (rank < NEEDED[classification.level] - 1 ? -6 : 0)
      + (latency !== null ? 3 - latency / 1000 : candidate.speed === "fast" ? 2 : candidate.speed === "slow" ? 0 : 1)
      + strength * 0.3;
  } else {
    const desired = Math.min(DESIRED[classification.level], budgetTight ? 2 : 4);
    score = rank >= desired ? 3 - (rank - desired) * 0.7 : 3 - (desired - rank) * 1.3;
    score += strength;
    if (candidate.speed === "fast") score += 0.3;
    score -= priceScore(candidate) * (budgetTight ? 0.15 : 0.05);
  }
  if (candidate.tier === "unrated" && !candidate.local) score -= 0.5;
  if (candidate.provider.id === preferredProviderId) score += 0.4;
  if (!health.healthy) score -= 20;
  return score;
}

function estimateFor(candidate, inputTokens) {
  const base = { inputTokens, outputTokens: ASSUMED_OUTPUT_TOKENS, assumption: `about ${ASSUMED_OUTPUT_TOKENS} reply tokens` };
  if (candidate.local) return { ...base, usd: 0, basis: "local", note: "Runs on self-hosted hardware; no per-token charge from a provider." };
  const price = verifiedPriceFor(candidate.model);
  if (!price) {
    return { ...base, usd: null, basis: "unverified", note: candidate.provider.free ? "No verified price on file. This provider may offer a free tier; check its pricing page." : "No verified price on file, so HANNAH doesn't show an estimate." };
  }
  const usd = (inputTokens * price.input + ASSUMED_OUTPUT_TOKENS * price.output) / 1_000_000;
  return { ...base, usd: Number(usd.toFixed(6)), basis: "verified", verified: price.verified, source: price.source };
}

function approximateTokens(messages, overheadChars = 0) {
  const chars = messages.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0) + overheadChars;
  return Math.ceil(chars / 4) + messages.length * 4;
}

const MODE_LABELS = {
  quality: "Best quality", balanced: "Balanced", budget: "Budget", fastest: "Fastest", private: "Private", offline: "Offline", custom: "Custom",
};

/**
 * Choose a provider and model.
 *
 * @param {object} input
 * @param {Array} input.messages        conversation (role, content)
 * @param {Array} [input.tools]         tool schemas the request carries
 * @param {object|null} input.policy    from normalizeRouting()
 * @param {string} [input.routeHint]    "simple" | "standard" | "complex" from a specialist agent
 * @param {Array} input.usableProviders providers this caller may reach (already filtered by credentials)
 * @param {string} [input.preferredProviderId] the provider picked in the app, a tie-breaker
 * @param {boolean} [input.budgetTight] the daily cap is nearly used
 * @param {number} [input.overheadChars] system prompt and memory size, for the estimate
 */
function route({ messages, tools = [], policy, routeHint, usableProviders, preferredProviderId, budgetTight = false, overheadChars = 0 }) {
  const effective = policy || { mode: "balanced", providers: null, maxTier: null, localOnly: false };
  const classification = classifyRequest(messages, tools);
  if (["simple", "standard", "complex"].includes(routeHint)) {
    classification.level = routeHint;
    classification.reasons = [...classification.reasons, `${routeHint} requested by the specialist agent`];
  }

  const limitations = [];
  let pool = collectCandidates(usableProviders, { needsTools: tools.length > 0 });
  if (effective.localOnly) pool = pool.filter((candidate) => candidate.local);
  if (effective.providers) pool = pool.filter((candidate) => effective.providers.includes(candidate.provider.id));
  if (effective.maxTier) pool = pool.filter((candidate) => (TIER_RANK[candidate.tier] || 2) <= TIER_RANK[effective.maxTier]);

  if (!pool.length) {
    if (effective.localOnly) {
      throw new RoutingError(
        "Private mode only uses models on your own hardware, and none is set up on this server. Connect Ollama, LM Studio, llama.cpp or vLLM (with a model configured), run a model on this device, or choose another mode.",
        "no_private_route",
        409,
      );
    }
    throw new RoutingError(
      effective.mode === "custom" ? "No model you can use matches your custom routing rules. Widen the provider list or the tier limit." : "No model is available for this request. Add a provider key or connect a local model.",
      "no_route",
      409,
    );
  }

  const ranked = pool
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, classification, effective.mode, { preferredProviderId, budgetTight }) }))
    .sort((a, b) => b.score - a.score);
  const [best, ...rest] = ranked.map((item) => item.candidate);
  const inputTokens = approximateTokens(messages, overheadChars);

  const health = providerHealth(best.provider.id);
  if (!health.healthy) limitations.push(`${best.provider.label} failed several times in the last minute; it's the only option left.`);
  if (tools.length && !modelSupportsTools(best.provider.id, best.model)) limitations.push("This model has no native tool calling, so tools are described in the prompt instead.");
  if (best.context && inputTokens > best.context) limitations.push(`The conversation (about ${inputTokens.toLocaleString("en-US")} tokens) may exceed this model's ${best.context.toLocaleString("en-US")}-token context.`);
  if (budgetTight) limitations.push("Today's budget is nearly used, so HANNAH is favouring cheaper models.");
  if (best.tier === "unrated") limitations.push("HANNAH has no quality profile for this model.");

  const modeReason = {
    quality: "the most capable model you can use",
    balanced: `a ${best.tier === "unrated" ? "suitable" : best.tier} model for a ${classification.level} ${classification.task} request`,
    budget: "the lowest-cost model that can handle this request",
    fastest: health.latencyMs !== null ? `the fastest measured model (about ${health.latencyMs} ms)` : "a model profiled as fast",
    private: "a model on this server's own hardware",
    offline: "a model on this server's own hardware",
    custom: "the best match within your custom rules",
  }[effective.mode];

  const describe = (candidate) => ({
    providerId: candidate.provider.id,
    providerLabel: candidate.provider.label,
    model: candidate.model,
    tier: candidate.tier,
    local: candidate.local,
    estimate: estimateFor(candidate, inputTokens),
  });

  // Alternatives: the next distinct choices, preferring other providers so a fallback can survive an outage.
  const alternatives = [];
  const seen = new Set([`${best.provider.id}/${best.model}`]);
  for (const candidate of [...rest.filter((item) => item.provider.id !== best.provider.id), ...rest]) {
    const key = `${candidate.provider.id}/${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(describe(candidate));
    if (alternatives.length === 3) break;
  }

  return {
    mode: effective.mode,
    modeLabel: MODE_LABELS[effective.mode],
    level: classification.level,
    task: classification.task,
    reasons: classification.reasons,
    ...describe(best),
    reason: `${MODE_LABELS[effective.mode]}: ${modeReason} (${classification.reasons.join(", ")}).`,
    alternatives,
    limitations,
    privacy: effective.localOnly ? "local-only" : "any",
  };
}

module.exports = {
  ASSUMED_OUTPUT_TOKENS,
  MODES,
  RoutingError,
  approximateTokens,
  normalizeRouting,
  privacyBlocks,
  providerHealth,
  recordOutcome,
  resetStats,
  route,
  selfHosted,
};
