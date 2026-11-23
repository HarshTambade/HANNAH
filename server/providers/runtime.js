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
const crypto = require("node:crypto");

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

/** The Amazon Bedrock Converse API endpoint for one model. */
function bedrockChatUrl(baseUrl, model) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return `${base}/model/${String(model || "")}`;
}

function awsAmzDate() {
  return new Date().toISOString().replace(/\.\d{3}/, "").replace(/[-:]/g, "");
}

/** AWS Signature V4 for the Amazon Bedrock Converse API. */
function signAws({ method, url, body, headers, accessKey, secretKey, sessionToken, region, service }) {
  const amzDate = awsAmzDate();
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash("sha256").update(String(body || "")).digest("hex");
  const parsed = new URL(url);
  const entries = new Map();
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key || "").trim().toLowerCase();
    if (!value) continue;
    if (["host", "content-length", "accept-encoding"].includes(name)) continue;
    entries.set(name, String(value));
  }
  entries.set("host", parsed.host);
  entries.set("x-amz-date", amzDate);
  if (sessionToken) entries.set("x-amz-security-token", String(sessionToken));
  const sorted = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = sorted.map(([key, value]) => `${key}:${value}`).join("\n") + "\n";
  const signedHeaders = sorted.map(([key]) => key).join(";");
  const canonicalRequest = [method, `${parsed.pathname}${parsed.search}`, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const kDate = crypto.createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  const kSigning = crypto.createHmac("sha256", kService).update("aws4_request").digest();
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    ...headers,
    host: parsed.host,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": String(sessionToken) } : {}),
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
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
  if (providerKind === "bedrock") {
    const usage = data?.output?.usage || {};
    const promptTokens = usage.inputTokens;
    const completionTokens = usage.outputTokens;
    return {
      promptTokens,
      completionTokens,
      totalTokens: Number.isFinite(promptTokens) && Number.isFinite(completionTokens) ? promptTokens + completionTokens : undefined,
    };
  }
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

/** Convert an OpenAI-style message list into the Amazon Bedrock Converse format. */
function toConverseMessages(messages, system) {
  const converse = [];
  if (typeof system === "string" && system.trim()) converse.push({ system: [{ text: system.trim() }] });
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "system") {
      if (typeof message.content === "string" && message.content.trim()) converse.push({ system: [{ text: message.content.trim() }] });
      continue;
    }
    if (message?.role === "tool") {
      converse.push({ role: "user", content: [{ toolResult: { toolUseId: String(message.tool_call_id || ""), content: [{ text: typeof message.content === "string" ? message.content : JSON.stringify(message.content || {}) }] } }] });
      continue;
    }
    const role = message?.role === "assistant" ? "assistant" : "user";
    const parts = typeof message?.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message?.content) ? message.content.map((part) => (typeof part === "string" ? { type: "text", text: part } : part?.type === "text" ? part : { type: "text", text: String(part?.text || "") })) : [];
    const blocks = [];
    for (const part of parts) {
      if (typeof part === "string") blocks.push({ text: part });
      else if (part?.type === "text") blocks.push({ text: String(part.text || "") });
      else if (part?.type === "image_url" && part.image_url?.url) {
        const meta = String(part.image_url.url).match(/^data:([^;]+);base64,/);
        blocks.push({ image: { source: { mediaType: meta?.[1] || "image/png", data: String(part.image_url.url).split("base64,")[1] || "" } } });
      }
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls) blocks.push({ toolUse: { toolUseId: String(call?.id || ""), tool: { name: String(call?.function?.name || ""), input: safeToolArguments(call?.function?.arguments) } } });
    }
    if (blocks.length) converse.push({ role, content: blocks });
  }
  return converse;
}

function safeToolArguments(raw) {
  if (typeof raw === "string") { try { return JSON.parse(raw) || {}; } catch { return {}; } }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
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

  if (provider.kind === "bedrock") {
    const accessKey = String(apiKey || "");
    const secretKey = String(process.env[provider.envSecretKey || "AWS_SECRET_ACCESS_KEY"] || "");
    const sessionToken = String(process.env[provider.envSessionToken || "AWS_SESSION_TOKEN"] || "");
    if (!accessKey || !secretKey) {
      throw new Error("Amazon Bedrock needs an AWS access key and secret access key (set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).");
    }
    const url = bedrockChatUrl(provider.baseUrl, model);
    const inferenceConfig = {};
    if (Number.isFinite(maxTokens)) inferenceConfig.maxTokens = maxTokens;
    if (Number.isFinite(temperature)) inferenceConfig.temperature = temperature;
    const converseBody = { modelId: model, messages: toConverseMessages(messages, system) };
    if (Object.keys(inferenceConfig).length) converseBody.inferenceConfig = inferenceConfig;
    if (tools?.length) converseBody.toolConfig = { toolConfigurations: [{ type: "FUNCTION", function: tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }] };
    const requestHeaders = signAws({ method: "POST", url, body: JSON.stringify(converseBody), headers: { "content-type": "application/json", accept: "application/json" }, accessKey, secretKey, sessionToken, region: process.env.AWS_REGION || "us-east-1", service: "bedrock" });
    const data = await requestJson(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(converseBody), signal: AbortSignal.timeout(timeoutMs) });
    const blocks = Array.isArray(data?.output?.message?.content) ? data.output.message.content : [];
    const text = blocks.filter((block) => typeof block?.text === "string").map((block) => block.text).join("\n").trim();
    const message = { content: text };
    if (blocks.some((block) => block?.toolUse)) message.tool_calls = blocks.filter((block) => block?.toolUse).map((block) => ({ id: String(block.toolUse.toolUseId || ""), type: "function", function: { name: String(block.toolUse.tool?.name || ""), arguments: JSON.stringify(block.toolUse.tool?.input || {}) } }));
    return { message, usage: extractUsage("bedrock", data), ...timing() };
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
  // "length": the token limit ended the reply (a reasoning model can spend a small limit before writing anything).
  const finishReason = data.choices?.[0]?.finish_reason === "length" ? "length" : undefined;
  return {
    message: { ...normalizeOpenAiMessage(message), ...(finishReason ? { finishReason } : {}) },
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
  bedrockChatUrl,
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
  signAws,
  streamProvider,
  validateBaseUrl,
};
