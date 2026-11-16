"use strict";

const { createHash } = require("node:crypto");
const { appendFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

const COST_LOG = process.env.TOKEN_COST_LOG?.trim() || "logs/token_usage.jsonl";

// Conservative USD per 1M tokens. Unknown models fall back to the default.
const MODEL_PRICES = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "qwen/qwen3-32b": { input: 0.29, output: 0.59 },
};

const DEFAULT_PRICE = { input: 0.5, output: 1.5 };

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
  return match ? match.price : null;
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
    if (usage && (req.path === "/chat" || req.path === "/agent")) {
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
  hashUserId,
  tokenUsageMiddleware,
};
module.exports.appendUsage = appendUsage;
module.exports.logPath = logPath;