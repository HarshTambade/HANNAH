"use strict";

/**
 * One way for server-side pipelines (research, document writing) to ask a
 * model: with the caller's own provider and key, inside their daily budget,
 * with spending recorded, and patient with rate limits.
 *
 *   const ask = createAsk({ req, res, ... });
 *   const { text, model } = await ask({ system, prompt, maxTokens, json, level });
 *
 * A pipeline makes several calls in a row, and free provider plans limit
 * tokens per minute. Rather than failing the whole piece of work on the third
 * call, `patient` waits as long as the provider asks (within reason), says so
 * through `emit`, and tries again.
 */
const gateway = require("./gateway");
const { ensureServed } = require("./providers/runtime");

function createAsk({ req, res, getRequestProvider, preferredProviderId, timeoutMs = 90_000, providerId, model, budgetUsd }) {
  // Throws (with a status) when the caller has no usable provider; the route answers with that.
  const target = getRequestProvider(req, typeof providerId === "string" && providerId ? providerId : preferredProviderId(req, res));
  const credentialId = res.locals.hannahApiTokenId;
  return async function ask({ system = "", prompt, maxTokens = 1200, level = "standard", temperature = 0.3 }) {
    await gateway.hydrateSpend(credentialId);
    const budget = gateway.assertWithinBudget(credentialId, budgetUsd);
    let chosen = typeof model === "string" && model.trim() && model !== "auto" ? model.trim() : null;
    if (!chosen) {
      await ensureServed(target);
      chosen = gateway.pickAutoModel(target.provider.id, { level, task: "research", reasons: ["research or document writing"] }, { budgetTight: budget.tight })?.model;
    }
    try {
      const message = await gateway.complete({ provider: target.provider, apiKey: target.apiKey, model: chosen, messages: [{ role: "user", content: String(prompt).slice(0, 120_000) }], tools: [], systemPrompt: system, timeoutMs, maxTokens, temperature });
      gateway.recordSpend(credentialId, message.model || chosen, message.usage?.promptTokens, message.usage?.completionTokens);
      const text = typeof message.content === "string" ? message.content : "";
      if (!text.trim()) throw Object.assign(new Error(`${target.provider.label} returned an empty answer.`), { empty: true, cutShort: message.finishReason === "length" });
      return { text, model: message.model || chosen, provider: target.provider.label, cutShort: message.finishReason === "length" };
    } catch (error) {
      if (error.empty) throw error;
      const normalized = gateway.normalizeProviderError(error, target.provider.label);
      throw Object.assign(new Error(normalized.message), { status: normalized.status, code: normalized.code, rateLimited: normalized.code === "rate_limited", tooLarge: normalized.code === "request_too_large" || normalized.code === "context_length", retryAfter: error.retryAfter || null });
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap `ask` so a rate limit is waited out (up to `waits` times, each at most
 * `maxWaitS`) and an empty answer is asked for once more. `emit` hears about
 * each wait. `wait` is replaceable so tests don't sleep.
 */
function patient(ask, { emit = () => {}, waits = 3, maxWaitS = 70, wait = sleep } = {}) {
  return async function patientAsk(args) {
    let emptied = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await ask(args);
      } catch (error) {
        if (error.empty && !emptied) { emptied = true; continue; }
        if (!error.rateLimited || attempt >= waits) throw error;
        const seconds = Math.max(2, Math.min(maxWaitS, Math.ceil(Number(error.retryAfter) || 12 * (attempt + 1))));
        emit({ type: "status", stage: "waiting", message: `The AI provider is at its per-minute limit; continuing in ${seconds} s`, seconds });
        await wait(seconds * 1000);
      }
    }
  };
}

module.exports = { createAsk, patient };
