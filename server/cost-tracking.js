"use strict";

const { createHash } = require("node:crypto");
const { appendFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

const COST_LOG = process.env.TOKEN_COST_LOG?.trim() || "logs/token_usage.jsonl";

// Prices live in a dated data file so they can be checked and corrected
// without a code change. See its "about" field for how entries are used.
const priceData = require("../shared/model-prices.json");
const MODEL_PRICES = Object.fromEntries(priceData.prices.map((entry) => [entry.model, entry]));
const DEFAULT_PRICE = priceData.defaultForBudgets;
const DAY_MS = 24 * 60 * 60 * 1000;

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * List price for a model, or null when the table has no entry. The longest
 * matching key wins, so "gpt-4o-mini" is not priced as "gpt-4o".
 */
function knownPriceFor(model) {
  if (typeof model !== "string") return null;
  const normalized = model.toLowerCase();
  let match = null;
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    const candidate = key.toLowerCase();
    if (normalized.includes(candidate) && (!match || candidate.length > match.key.length)) match = { key: candidate, price };
  }
  return match ? { input: match.price.input, output: match.price.output } : null;
}

/**
 * A price that may be shown to people as an estimate: only entries with a
 * recent verification date. Returns null otherwise, so the app says "no
 * verified price" instead of guessing.
 */
function verifiedPriceFor(model, now = Date.now()) {
  if (typeof model !== "string") return null;
  const normalized = model.toLowerCase();
  let match = null;
  for (const [key, entry] of Object.entries(MODEL_PRICES)) {
    const candidate = key.toLowerCase();
    if (normalized.includes(candidate) && (!match || candidate.length > match.key.length)) match = { key: candidate, entry };
  }
  const verified = match?.entry.verified ? Date.parse(`${match.entry.verified}T00:00:00Z`) : NaN;
  if (!Number.isFinite(verified) || now - verified > priceData.verifiedMaxAgeDays * DAY_MS) return null;
  return {
    input: match.entry.input,
    output: match.entry.output,
    verified: match.entry.verified,
    source: priceData.sources[match.entry.provider] || null,
  };
}

function priceFor(model) {
  return knownPriceFor(model) || DEFAULT_PRICE;
}

function estimateCost(model, inputTokens, outputTokens) {
  const price = priceFor(model);
  return Number(((numberOrZero(inputTokens) * price.input + numberOrZero(outputTokens) * price.output) / 1_000_000).toFixed(6));
}

function hashUserId(req) {
  const source = req.get("authorization") || req.ip || "anonymous";
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function logPath() {
  return path.resolve(process.env.TOKEN_COST_LOG?.trim() || COST_LOG);
}

async function appendUsage(record) {
  const resolved = logPath();
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await appendFile(resolved, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function tokenUsageMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function patchedJson(body) {
    const usage = res.locals?.tokenUsage;
    if (usage && (req.path === "/chat" || req.path === "/agent" || req.path === "/chat/completions")) {
      const record = {
        timestamp: new Date().toISOString(),
        path: req.path,
        method: req.method,
        userIdHash: hashUserId(req),
        provider: usage.provider || "unknown",
        model: usage.model || "unknown",
        inputTokens: numberOrZero(usage.inputTokens),
        outputTokens: numberOrZero(usage.outputTokens),
        totalTokens: numberOrZero(usage.inputTokens) + numberOrZero(usage.outputTokens),
        estimatedCostUsd: estimateCost(usage.model, usage.inputTokens, usage.outputTokens),
      };
      appendUsage(record).catch(() => {
        console.error("HANNAH token usage could not be written.");
      });
    }
    return originalJson(body);
  };
  next();
}

module.exports = {
  estimateCost,
  knownPriceFor,
  verifiedPriceFor,
  hashUserId,
  tokenUsageMiddleware,
};
module.exports.appendUsage = appendUsage;
module.exports.logPath = logPath;