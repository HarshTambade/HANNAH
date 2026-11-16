"use strict";

/**
 * Versioned, OpenAI-compatible developer API.
 *
 *   GET  /v1/models            models this credential can use, plus "hannah-auto"
 *   POST /v1/chat/completions  chat completions, with optional SSE streaming
 *   GET  /v1/usage             today's estimated spend and budget
 *
 * Model ids are "<provider>/<model>" (for example "groq/openai/gpt-oss-120b"),
 * a bare model id for the default provider, or "hannah-auto" to let HANNAH
 * route by request complexity. Tools follow OpenAI semantics: HANNAH returns
 * tool calls for the caller to run; it never executes them on this route.
 */

const express = require("express");
const { randomUUID } = require("node:crypto");
const { defaultModelFor, listProviders } = require("./providers/catalog");
const { streamProvider } = require("./providers/runtime");
const gateway = require("./gateway");

const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 400_000;
const AUTO_MODELS = new Set(["hannah-auto", "auto"]);

function openAiError(res, status, message, code, type = "invalid_request_error") {
  return res.status(status).json({ error: { message, type, code } });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
    else return null;
  }
  return parts.join("\n");
}

/** Validate and normalize OpenAI-style messages. Returns null when invalid. */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return null;
  let total = 0;
  const result = [];
  for (const message of messages) {
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role)) return null;
    const hasCalls = message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    const content = message.content === null && hasCalls ? "" : textContent(message.content);
    if (content === null) return { unsupported: "Only text content is supported on /v1/chat/completions; image and audio parts aren't yet." };
    total += content.length;
    if (message.role === "tool" && typeof message.tool_call_id !== "string") return null;
    const normalized = { role: message.role, content };
    if (message.role === "tool") normalized.tool_call_id = message.tool_call_id.slice(0, 200);
    if (hasCalls) {
      normalized.tool_calls = message.tool_calls.slice(0, 16).map((call) => ({
        id: String(call?.id || "").slice(0, 200),
        type: "function",
        function: { name: String(call?.function?.name || "").slice(0, 64), arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments || {}) },
      }));
    }
    result.push(normalized);
  }
  return total > MAX_TOTAL_CHARS ? null : result;
}

function normalizeTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || tools.length > 64) return null;
  const result = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)) return null;
    const parameters = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} };
    if (JSON.stringify(parameters).length > 20_000) return null;
    result.push({ type: "function", function: { name: fn.name, description: typeof fn.description === "string" ? fn.description.slice(0, 2000) : "", parameters } });
  }
  return result;
}

/** "groq/openai/gpt-oss-120b" → provider groq + model openai/gpt-oss-120b. */
function parseModelRef(value, fallbackProviderId) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || AUTO_MODELS.has(raw.toLowerCase())) return { auto: true, providerId: fallbackProviderId, model: "" };
  const known = new Set(listProviders().map((provider) => provider.id));
  const slash = raw.indexOf("/");
  if (slash > 0 && known.has(raw.slice(0, slash))) return { auto: false, providerId: raw.slice(0, slash), model: raw.slice(slash + 1), explicitProvider: true };
  return { auto: false, providerId: fallbackProviderId, model: raw };
}

function createV1Router({ getRequestProvider, allowedProviderIds = () => null, defaultProviderId, timeoutMs, chatLimiter }) {
  const router = express.Router();

  router.get("/models", (req, res) => {
    const allowed = allowedProviderIds(req, res);
    const providers = listProviders().filter((provider) => (allowed ? allowed.has(provider.id) : provider.configured));
    const data = [{ id: "hannah-auto", object: "model", created: 0, owned_by: "hannah", hannah: { description: "HANNAH picks a model by request complexity." } }];
    for (const provider of providers) {
      for (const model of provider.models) {
        data.push({ id: `${provider.id}/${model.id}`, object: "model", created: 0, owned_by: provider.label, hannah: { tools: Boolean(model.tools), vision: Boolean(model.vision), context: model.context ?? null } });
      }
    }
    res.json({ object: "list", data });
  });

  router.get("/usage", async (req, res) => {
    await gateway.hydrateSpend(res.locals.hannahApiTokenId);
    res.json({ object: "usage", day: new Date().toISOString().slice(0, 10), ...gateway.budgetStatus(res.locals.hannahApiTokenId, req.get("x-hannah-daily-budget")), note: "Estimated from list prices; free tiers and unpriced models count as $0." });
  });

  router.post("/chat/completions", chatLimiter, async (req, res) => {
    const body = req.body || {};
    const messages = normalizeMessages(body.messages);
    if (messages?.unsupported) return openAiError(res, 400, messages.unsupported, "unsupported_content");
    if (!messages) return openAiError(res, 400, "messages must be 1–100 valid chat messages.", "invalid_messages");
    const tools = normalizeTools(body.tools);
    if (!tools) return openAiError(res, 400, "tools must be up to 64 OpenAI function tools.", "invalid_tools");
    const maxTokens = Number.isInteger(body.max_tokens ?? body.max_completion_tokens) ? Math.min(8192, Math.max(1, body.max_tokens ?? body.max_completion_tokens)) : undefined;
    const temperature = Number.isFinite(body.temperature) ? Math.min(2, Math.max(0, body.temperature)) : undefined;
    const ref = parseModelRef(body.model, req.get("x-hannah-provider") || defaultProviderId(req, res));

    let target;
    try {
      target = getRequestProvider(req, ref.providerId);
    } catch (error) {
      return openAiError(res, error.status || 400, error.message, "provider_unavailable");
    }
    const credentialId = res.locals.hannahApiTokenId;
    const callerBudget = req.get("x-hannah-daily-budget");
    let budget;
    await gateway.hydrateSpend(credentialId);
    try {
      budget = gateway.assertWithinBudget(credentialId, callerBudget);
    } catch (error) {
      return openAiError(res, 429, error.message, "budget_exceeded", "insufficient_quota");
    }

    let model = ref.model || defaultModelFor(target.provider);
    let routing = null;
    if (ref.auto) {
      const classification = gateway.classifyRequest(messages, tools);
      const pick = gateway.pickAutoModel(target.provider.id, classification, { needsTools: tools.length > 0, budgetTight: budget.tight });
      if (pick?.model) model = pick.model;
      routing = { ...classification, model, tier: pick?.tier, reason: pick?.reason };
    }
    const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const publicModel = (providerId, name) => `${providerId}/${name}`;

    if (body.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const chunk = (delta, finish = null) => send({ id, object: "chat.completion.chunk", created, model: publicModel(target.provider.id, model), choices: [{ index: 0, delta, finish_reason: finish }] });
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      chunk({ role: "assistant", content: "" });
      try {
        let result;
        if (tools.length && !gateway.modelSupportsTools(target.provider.id, model)) {
          const message = await gateway.complete({ provider: target.provider, apiKey: target.apiKey, model, messages, tools, timeoutMs, maxTokens, temperature, singleModel: !ref.auto });
          if (message.content) chunk({ content: message.content });
          result = { content: message.content, tool_calls: message.tool_calls, usage: message.usage || {} };
        } else {
          result = await streamProvider({ provider: target.provider, apiKey: target.apiKey, model, messages, tools, timeoutMs, maxTokens, temperature, signal: abort.signal, onDelta: (delta) => chunk(delta) });
        }
        const calls = result.tool_calls || [];
        if (calls.length) chunk({ tool_calls: calls.map((call, index) => ({ index, ...call })) });
        chunk({}, calls.length ? "tool_calls" : "stop");
        gateway.recordSpend(credentialId, model, result.usage?.promptTokens, result.usage?.completionTokens);
        send({ id, object: "chat.completion.chunk", created, model: publicModel(target.provider.id, model), choices: [], usage: { prompt_tokens: result.usage?.promptTokens ?? null, completion_tokens: result.usage?.completionTokens ?? null, total_tokens: result.usage?.totalTokens ?? null }, ...(routing ? { hannah: { routing } } : {}) });
      } catch (error) {
        if (!abort.signal.aborted) {
          const normalized = gateway.normalizeProviderError(error, target.provider.label);
          send({ error: { message: normalized.message, type: "api_error", code: normalized.code } });
        }
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    try {
      const providers = ref.auto && !ref.explicitProvider ? gateway.providerFallbacks(target.provider.id, { byok: Boolean(res.locals.hannahByok), allowed: allowedProviderIds(req, res) }) : [target.provider.id];
      const message = await gateway.completeWithFallback({
        providers,
        resolve: (providerId) => (providerId === target.provider.id ? target : getRequestProvider(req, providerId)),
        model,
        messages,
        tools,
        timeoutMs,
        maxTokens,
        temperature,
        singleModel: !ref.auto,
      });
      const usedModel = message.model || model;
      gateway.recordSpend(credentialId, usedModel, message.usage?.promptTokens, message.usage?.completionTokens);
      res.locals.tokenUsage = { provider: message.providerId, model: usedModel, inputTokens: message.usage?.promptTokens, outputTokens: message.usage?.completionTokens };
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      return res.json({
        id,
        object: "chat.completion",
        created,
        model: publicModel(message.providerId, usedModel),
        choices: [{ index: 0, message: { role: "assistant", content: calls.length && !message.content ? null : message.content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: message.usage?.promptTokens ?? null, completion_tokens: message.usage?.completionTokens ?? null, total_tokens: message.usage?.totalTokens ?? null },
        hannah: { provider: message.providerLabel, toolMode: message.toolMode, ...(routing ? { routing } : {}), budget: gateway.budgetStatus(credentialId, callerBudget) },
      });
    } catch (error) {
      const normalized = gateway.normalizeProviderError(error, error.providerLabel || target.provider.label);
      return openAiError(res, normalized.status, normalized.message, normalized.code, normalized.code === "auth" ? "authentication_error" : "api_error");
    }
  });

  return router;
}

module.exports = { createV1Router, normalizeMessages, normalizeTools, parseModelRef };
