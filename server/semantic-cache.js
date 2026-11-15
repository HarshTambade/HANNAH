"use strict";

const { createHash } = require("node:crypto");

const CACHE = new Map();
const STATS = { hits: 0, misses: 0, byModel: {} };

function hashPrefix(systemPrompt, tools) {
  return createHash("sha256").update(JSON.stringify({ systemPrompt, tools })).digest("hex");
}

function get(key) {
  const entry = CACHE.get(key);
  if (!entry) {
    STATS.misses += 1;
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    CACHE.delete(key);
    STATS.misses += 1;
    return null;
  }
  STATS.hits += 1;
  STATS.byModel[entry.model] = STATS.byModel[entry.model] || { hits: 0, misses: 0 };
  STATS.byModel[entry.model].hits += 1;
  return entry.value;
}

function set(key, value, model, ttlMs = 300_000) {
  CACHE.set(key, { value, model, expiresAt: Date.now() + ttlMs });
  STATS.byModel[model] = STATS.byModel[model] || { hits: 0, misses: 0 };
}

function stats() {
  return {
    hits: STATS.hits,
    misses: STATS.misses,
    hitRate: STATS.hits + STATS.misses > 0 ? STATS.hits / (STATS.hits + STATS.misses) : 0,
    byModel: STATS.byModel,
  };
}

module.exports = { hashPrefix, get, set, stats };
PY