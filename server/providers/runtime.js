"use strict";

const {
  defaultModelFor,
  modelChain,
  providerKey,
  providerModelOverrides,
  resolveProvider,
  validateBaseUrl,
} = require("./catalog");
const { createLlmTrace } = require("../observability/llm-tracing");

function withPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (!basePath.endsWith(normalizedSuffix)) url.pathname = `${basePath}${normalizedSuffix}`;
  return url.toString();
}

function openAiChatUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")) return url.toString();
  return withPath(baseUrl, "/chat/completions");
}

function openAiModelsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath.endsWith("/chat/completions")) {
    url.pathname = basePath.slice(0, -"/chat/completions".length) + "/models";
    return url.toString();
  }
  if (basePath.endsWith("/models")) return url.toString();
  return withPath(baseUrl, "/models");
}

function anthropicUrl(baseUrl, resource) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/v1/${resource}`)) return url.toString();
  if (path.endsWith("/v1/messages")) {
    url.pathname = path.slice(0, -"messages".length) + resource;
    return url.toString();
  }
  if (path.endsWith("/v1/models")) {
    url.pathname = path.slice(0, -"models".length) + resource;
    return url.toString();
  }
  if (path.endsWith("/v1")) {
    url.pathname = `${path}/${resource}`;
    return url.toString();
  }
  return withPath(baseUrl, `/v1/${resource}`);
}

function ollamaUrl(baseUrl, resource) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(`/api/${resource}`)) return url.toString();
  if (path.endsWith("/api")) {
    url.pathname = `${path}/${resource}`;
    return url.toString();
  }
  return withPath(baseUrl, `/api/${resource}`);
}

function providerConfigured(provider, apiKey = providerKey(provider)) {
  if (provider.local) return true;
  if (provider.id === "custom") return Boolean(provider.baseUrl);
  return Boolean(apiKey) || provider.id === "groq";
}

function resolveConfiguredProvider(id, apiKey) {
  const provider = resolveProvider({ id });
  if (!providerConfigured(provider, apiKey)) {
    const error = new Error(`Configure ${provider.envKey || "provider credentials"} on the server before selecting ${provider.label}.`);
    error.status = 503;
    throw error;
  }
  return provider;
}

function normalizeOpenAiMessage(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    content: typeof message?.content === "string" ? message.content : "",
    tool_calls: calls.map((call) => ({
      id: String(call?.id || ""),
      type: "function",
      function: {
        name: String(call?.function?.name || ""),
        arguments: typeof call?.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call?.function?.arguments || {}),
      },
    })),
  };
}

function toAnthropicMessages(messages) {
  const system = [];
  const converted = [];
  const appendUserBlock = (block) => {
    const previous = converted[converted.length - 1];
    if (previous?.role === "user") {
      if (!Array.isArray(previous.content)) {
        previous.content = previous.content ? [{ type: "text", text: previous.content }] : [];
      }
      previous.content.push(block);
    } else {
      converted.push({ role: "user", content: [block] });
    }
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      appendUserBlock({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: input && typeof input === "object" && !Array.isArray(input) ? input : {},
        });
      }
      converted.push({ role: "assistant", content });
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content || " ";
    const previous = converted[converted.length - 1];
    if (previous?.role === role && role === "user") {
      if (!Array.isArray(previous.content)) previous.content = [{ type: "text", text: previous.content }];
      previous.content.push({ type: "text", text: content });
    } else {
      converted.push({ role, content });
    }
  }
  return { system: system.join("\n"), messages: converted };
}

function normalizeAnthropicMessage(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return {
    content: blocks.filter((block) => block?.type === "text").map((block) => block.text).join("\n"),
    tool_calls: blocks.filter((block) => block?.type === "tool_use").map((block) => ({
      id: String(block.id || ""),
      type: "function",
      function: {
        name: String(block.name || ""),
        arguments: JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}),
      },
    })),
  };
}

async function readProviderJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Provider returned HTTP ${response.status}.`);
    error.status = response.status;
    error.providerMessage = String(data?.error?.message || data?.message || "").slice(0, 500);
    // How long the provider asks callers to wait (rate limits), so HANNAH can pass it on.
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = Math.min(300, Math.ceil(retryAfter));
    throw error;
  }
  return data;
}

function providerHeaders(provider, apiKey) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = process.env.HANNAH_PUBLIC_URL || "https://projecthannah.com";
    headers["X-Title"] = "HANNAH";
  }
  return headers;
}

/** Extract only numeric token counts; never retain provider response content. */
function extractUsage(providerKind, data) {
  const usage = data?.usage && typeof data.usage === "object" ? data.usage : {};
  if (providerKind === "anthropic") {
    return {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
        ? usage.input_tokens + usage.output_tokens
        : undefined,
    };
  }
  if (providerKind === "ollama") {
    return {
      promptTokens: data?.prompt_eval_count,
      completionTokens: data?.eval_count,
      totalTokens: Number.isFinite(data?.prompt_eval_count) && Number.isFinite(data?.eval_count)
        ? data.prompt_eval_count + data.eval_count
        : undefined,
    };
  }
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? (
      Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? promptTokens + completionTokens : undefined
    ),
  };
}

async function callProviderMeasured({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs, maxTokens, temperature }) {
  // An empty systemPrompt sends the caller's own messages unchanged (developer API).
  const system = systemPrompt
    ? `${systemPrompt}${tools?.length ? " When useful, call the provided tools. Never say an action succeeded before the tool result confirms it." : ""}`
    : "";
  const withSystem = (list) => (system ? [{ role: "system", content: system }, ...list] : list);
  const tokenLimit = Number.isFinite(maxTokens) ? maxTokens : tools?.length ? 1400 : 900;
  let attemptStartedAt = Date.now();
  let firstResponseAt;
  const resetTiming = () => {
    attemptStartedAt = Date.now();
    firstResponseAt = undefined;
  };
  const timing = () => ({
    ttfbMs: firstResponseAt === undefined ? undefined : firstResponseAt - attemptStartedAt,
    totalMs: Date.now() - attemptStartedAt,
  });
  const requestJson = async (url, init) => {
    const response = await fetch(url, init);
    if (firstResponseAt === undefined) firstResponseAt = Date.now();
    return readProviderJson(response);
  };

  if (provider.kind === "ollama") {
    const ollamaMessages = withSystem(messages);
    const data = await requestJson(ollamaUrl(provider.baseUrl, "chat"), {
      method: "POST",
      headers: providerHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        ...(tools?.length ? { tools } : systemPrompt ? { format: "json" } : {}),
        stream: false,
        options: { temperature: Number.isFinite(temperature) ? temperature : tools?.length ? 0.4 : 0.7, num_predict: tokenLimit },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!data.message || (typeof data.message.content !== "string" && !Array.isArray(data.message.tool_calls))) {
      throw new Error("Ollama returned neither a reply nor a tool request.");
    }
    return {
      message: normalizeOpenAiMessage(data.message),
      usage: extractUsage("ollama", data),
      ...timing(),
    };
  }

  if (provider.kind === "anthropic") {
    const converted = toAnthropicMessages(withSystem(messages));
    const anthropicTools = (tools || []).map((tool, index, all) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
      ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
    const data = await requestJson(anthropicUrl(provider.baseUrl, "messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        ...(converted.system ? { system: [{ type: "text", text: converted.system, cache_control: { type: "ephemeral" } }] } : {}),
        messages: converted.messages,
        max_tokens: tokenLimit,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(anthropicTools.length ? { tools: anthropicTools } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      message: normalizeAnthropicMessage(data),
      usage: extractUsage("anthropic", data),
      ...timing(),
    };
  }

  const url = openAiChatUrl(provider.baseUrl);
  const body = {
    model,
    messages: withSystem(messages),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    temperature: Number.isFinite(temperature) ? temperature : tools?.length ? 0.4 : 0.7,
    max_completion_tokens: tokenLimit,
  };
  let data;
  try {
    data = await requestJson(url, {
      method: "POST",
      headers: providerHeaders(provider, apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.status !== 400 || !/max_completion_tokens/i.test(error.providerMessage || "")) throw error;
    resetTiming();
    const compatibleBody = { ...body, max_tokens: body.max_completion_tokens };
    delete compatibleBody.max_completion_tokens;
    data = await requestJson(url, {
      method: "POST",
      headers: providerHeaders(provider, apiKey),
      body: JSON.stringify(compatibleBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  const message = data.choices?.[0]?.message;
  if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) {
    throw new Error("The provider returned neither a reply nor a tool request.");
  }
  return {
    message: normalizeOpenAiMessage(message),
    usage: extractUsage(provider.kind, data),
    ...timing(),
  };
}

/** Backwards-compatible provider call that returns only the normalized message. */
async function callProvider(args) {
  const result = await callProviderMeasured(args);
  return result.message;
}

function isNetworkFailure(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return error instanceof TypeError
    || ["AbortError", "TimeoutError"].includes(error?.name)
    || ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT"].includes(code);
}

/**
 * The models to try, in order: the requested one, the configured fallbacks,
 * then up to two more chat models the provider serves today. Rate limits are
 * per model on most providers, so a busy model hands over to another. Models
 * the provider retired are skipped (the requested one stays first: the
 * provider says so if it's gone).
 */
function fallbackChain(provider, requested) {
  const chain = modelChain(provider, requested).filter((model, index) => index === 0 || servedStatus(provider.id, model) !== false);
  const extra = servedModels(provider.id).filter((model) => isChatModel(model) && !chain.includes(model));
  if (extra.length) {
    const preferred = defaultModelFor(provider);
    extra.sort((a, b) => (b === preferred) - (a === preferred));
  }
  return [...chain, ...extra.slice(0, 2)];
}

async function requestWithProviderFallback({ provider, apiKey, requestedModel, messages, tools, systemPrompt, timeoutMs, maxTokens, temperature, singleModel = false }) {
  // singleModel: the caller pinned one exact model, so don't silently swap it.
  const models = singleModel && requestedModel ? [requestedModel] : fallbackChain(provider, requestedModel || defaultModelFor(provider));
  const trace = createLlmTrace({
    provider,
    requestedModel: requestedModel || models[0] || defaultModelFor(provider),
    operation: tools?.length ? "agent" : "chat",
  });
  if (!models.length) {
    const error = new Error(`No model is configured for ${provider.label}.`);
    trace.fail(error);
    throw error;
  }
  let lastError;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const attemptStartedAt = Date.now();
    try {
      const result = await callProviderMeasured({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs, maxTokens, temperature });
      trace.succeed({
        model,
        usage: result.usage,
        ttfbMs: result.ttfbMs,
        totalMs: result.totalMs,
      });
      if (result.message && typeof result.message === "object") {
        result.message.usage = result.usage;
        result.message.model = model;
      }
      return result.message;
    } catch (error) {
      lastError = error;
      const stop = isNetworkFailure(error) || error.status === 401 || error.status === 403;
      const nextModel = stop ? null : models[index + 1] || null;
      trace.recordFailure({
        model,
        error,
        durationMs: Date.now() - attemptStartedAt,
        nextModel,
      });
      if (stop) break;
      if (error.status === 429) console.warn(`${provider.label} model ${model} was rate limited; trying the next configured model.`);
      else console.warn(`${provider.label} model ${model} failed; trying the next configured model.`);
    }
  }
  const finalError = lastError || new Error(`No ${provider.label} models are configured.`);
  trace.fail(finalError);
  throw finalError;
}

/**
 * Stream one completion. OpenAI-compatible providers stream token deltas over
 * SSE; other wire protocols fall back to one non-streamed call delivered as a
 * single delta, so callers always get the same events.
 */
async function streamProvider({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs, maxTokens, temperature, onDelta, signal }) {
  if (provider.kind !== "openai") {
    const result = await callProviderMeasured({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs, maxTokens, temperature });
    if (result.message.content) onDelta({ content: result.message.content });
    return { content: result.message.content, tool_calls: result.message.tool_calls, usage: result.usage, streamed: false };
  }
  const system = systemPrompt || "";
  const body = {
    model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1400,
    stream: true,
    stream_options: { include_usage: true },
  };
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(openAiChatUrl(provider.baseUrl), {
    method: "POST",
    headers: { ...providerHeaders(provider, apiKey), Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) await readProviderJson(response);

  let content = "";
  let usage = {};
  const calls = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.usage) usage = extractUsage("openai", event);
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onDelta({ content: delta.content });
      }
      for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(part.index) ? part.index : calls.length;
        calls[index] = calls[index] || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (part.id) calls[index].id = part.id;
        if (part.function?.name) calls[index].function.name += part.function.name;
        if (part.function?.arguments) calls[index].function.arguments += part.function.arguments;
      }
    }
  }
  return { content, tool_calls: calls.filter(Boolean), usage, streamed: true };
}

/**
 * Whether a model id is a chat model. Providers' model lists also carry speech
 * (Whisper), text-to-speech (Orpheus, PlayAI, tts-*), safety classifiers
 * (prompt guards, safeguards), embedding, moderation and image models; none of
 * those can answer a chat or run tools.
 */
const NON_CHAT_MODEL = /(^|[/_.-])(whisper|distil-whisper|orpheus|playai|tts|transcribe|prompt-guard|guard|safeguard|embed|embedding|embeddings|rerank|moderation|dall-e|gpt-image|imagen|veo|lyria|sora)([/_.-]|\d|$)/i;
function isChatModel(id) {
  return typeof id === "string" && Boolean(id.trim()) && !NON_CHAT_MODEL.test(id);
}

const { knowsServed, rememberServed, servedModels, servedStatus } = require("./served");

async function discoverProviderModels(provider, apiKey, timeoutMs) {
  const fallback = [...new Set([
    ...providerModelOverrides(provider),
    ...(provider.models || []).map((model) => model.id),
  ])];
  if (!apiKey && !provider.local && provider.id !== "custom") return { models: fallback, liveModels: [] };
  try {
    let response;
    if (provider.kind === "anthropic") {
      response = await fetch(anthropicUrl(provider.baseUrl, "models"), {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else if (provider.kind === "ollama") {
      response = await fetch(ollamaUrl(provider.baseUrl, "tags"), {
        headers: providerHeaders(provider, apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else {
      response = await fetch(openAiModelsUrl(provider.baseUrl), {
        headers: providerHeaders(provider, apiKey),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    if (!response.ok) return { models: fallback, liveModels: [], status: response.status };
    const data = await response.json().catch(() => ({}));
    const openAiModels = Array.isArray(data.data)
      ? data.data.filter((model) => model && model.active !== false).map((model) => model.id)
      : [];
    const discovered = provider.kind === "ollama"
      ? (Array.isArray(data.models) ? data.models.map((model) => model.name) : [])
      : (openAiModels.length ? openAiModels : Array.isArray(data.models) ? data.models.map((model) => model.id || model.name) : []);
    const models = discovered.filter((model) => typeof model === "string" && model.trim()).map((model) => model.trim());
    const liveModels = [...new Set(models)].slice(0, 200);
    // A hosted provider's list is the same for every key; local and custom ones differ per address.
    if (!provider.local && provider.id !== "custom") rememberServed(provider.id, liveModels);
    return {
      models: liveModels.length ? [...new Set([...liveModels, ...providerModelOverrides(provider)])].slice(0, 200) : fallback,
      liveModels,
    };
  } catch {
    return { models: fallback, liveModels: [] };
  }
}

/**
 * Learn which models a hosted provider serves (kept for 30 minutes, see
 * served.js) before a model is picked for it, so Auto never picks one the
 * provider retired. Accepts { provider, apiKey } items; never throws.
 */
async function ensureServed(...targets) {
  await Promise.all(targets.flat()
    .filter((item) => item?.provider && !item.provider.local && item.provider.id !== "custom" && !knowsServed(item.provider.id))
    .map((item) => discoverProviderModels(item.provider, item.apiKey, 2_500).catch(() => null)));
}

module.exports = {
  ensureServed,
  anthropicUrl,
  isChatModel,
  callProvider,
  callProviderMeasured,
  discoverProviderModels,
  extractUsage,
  isNetworkFailure,
  ollamaUrl,
  openAiChatUrl,
  providerConfigured,
  providerHeaders,
  requestWithProviderFallback,
  resolveConfiguredProvider,
  streamProvider,
  validateBaseUrl,
};
