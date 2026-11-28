"use strict";

/**
 * What model provider calls actually did, in this server process: each
 * finished call's provider, outcome, error class and latency, the last 500
 * of them. Diagnostics reads this; it never contains prompts, replies, keys
 * or user ids. A fresh process (or a serverless instance) starts empty, and
 * diagnostics says "no calls recorded" rather than "healthy".
 */
const MAX = 500;
const outcomes = [];

function recordProviderOutcome({ providerId, status, errorType = null, httpStatus = null, latencyMs = null, at = Date.now() }) {
  outcomes.push({ providerId: String(providerId || "unknown").slice(0, 64), ok: status === "success", errorType: errorType ? String(errorType).slice(0, 40) : null, httpStatus: Number.isInteger(httpStatus) ? httpStatus : null, latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null, at });
  if (outcomes.length > MAX) outcomes.splice(0, outcomes.length - MAX);
}

/** Per provider over the last `windowMs`: calls, failures, the share failing, the last error and median latency. */
function providerHealth({ windowMs = 15 * 60_000, now = Date.now() } = {}) {
  const by = {};
  for (const item of outcomes) {
    if (now - item.at > windowMs) continue;
    const entry = (by[item.providerId] ||= { calls: 0, failures: 0, lastError: null, lastErrorAt: null, lastOkAt: null, latencies: [] });
    entry.calls += 1;
    if (item.ok) { entry.lastOkAt = item.at; if (item.latencyMs !== null) entry.latencies.push(item.latencyMs); } else { entry.failures += 1; entry.lastError = item.errorType || (item.httpStatus ? `HTTP ${item.httpStatus}` : "error"); entry.lastErrorAt = item.at; }
  }
  return Object.fromEntries(Object.entries(by).map(([id, entry]) => {
    const sorted = entry.latencies.sort((a, b) => a - b);
    return [id, { calls: entry.calls, failures: entry.failures, failureShare: entry.calls ? Number((entry.failures / entry.calls).toFixed(3)) : null, lastError: entry.lastError, lastErrorAt: entry.lastErrorAt, lastOkAt: entry.lastOkAt, medianLatencyMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }];
  }));
}

function resetProviderHealth() { outcomes.length = 0; }

module.exports = { providerHealth, recordProviderOutcome, resetProviderHealth };
