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
    throw error;
  }
  return data;
}

function providerHeaders(provider, apiKey) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = process.env.SHANAYA_PUBLIC_URL || "https://projectshanaya.com";
    headers["X-Title"] = "Shanaya";
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

async function callProviderMeasured({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs }) {
  const system = `${systemPrompt}${tools?.length ? " When useful, call the provided tools. Never say an action succeeded before the tool result confirms it." : ""}`;
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
    const ollamaMessages = [{ role: "system", content: system }, ...messages];
    const data = await requestJson(ollamaUrl(provider.baseUrl, "chat"), {
      method: "POST",
      headers: providerHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        messages: ollamaMessages,
        ...(tools?.length ? { tools } : { format: "json" }),
        stream: false,
        options: { temperature: tools?.length ? 0.4 : 0.7 },
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
    const converted = toAnthropicMessages([{ role: "system", content: system }, ...messages]);
    const anthropicTools = (tools || []).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
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
        system: converted.system,
        messages: converted.messages,
        max_tokens: tools?.length ? 1400 : 900,
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
    messages: [{ role: "system", content: system }, ...messages],
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    temperature: tools?.length ? 0.4 : 0.7,
    max_completion_tokens: tools?.length ? 1400 : 900,
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

async function requestWithProviderFallback({ provider, apiKey, requestedModel, messages, tools, systemPrompt, timeoutMs }) {
  const models = modelChain(provider, requestedModel || defaultModelFor(provider));
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
      const result = await callProviderMeasured({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs });
      trace.succeed({
        model,
        usage: result.usage,
        ttfbMs: result.ttfbMs,
        totalMs: result.totalMs,
      });
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
    if (!response.ok) return { models: fallback, liveModels: [] };
    const data = await response.json().catch(() => ({}));
    const openAiModels = Array.isArray(data.data)
      ? data.data.filter((model) => model && model.active !== false).map((model) => model.id)
      : [];
    const discovered = provider.kind === "ollama"
      ? (Array.isArray(data.models) ? data.models.map((model) => model.name) : [])
      : (openAiModels.length ? openAiModels : Array.isArray(data.models) ? data.models.map((model) => model.id || model.name) : []);
    const models = discovered.filter((model) => typeof model === "string" && model.trim()).map((model) => model.trim());
    const liveModels = [...new Set(models)].slice(0, 200);
    return {
      models: liveModels.length ? [...new Set([...liveModels, ...providerModelOverrides(provider)])].slice(0, 200) : fallback,
      liveModels,
    };
  } catch {
    return { models: fallback, liveModels: [] };
  }
}

module.exports = {
  anthropicUrl,
  callProvider,
  callProviderMeasured,
  discoverProviderModels,
  extractUsage,
  isNetworkFailure,
  openAiChatUrl,
  providerConfigured,
  requestWithProviderFallback,
  resolveConfiguredProvider,
  validateBaseUrl,
};
