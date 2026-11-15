"use strict";

const {
  defaultModelFor,
  modelChain,
  providerKey,
  providerModelOverrides,
  resolveProvider,
  validateBaseUrl,
} = require("./catalog");

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

async function callProvider({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs }) {
  const system = `${systemPrompt}${tools?.length ? " When useful, call the provided tools. Never say an action succeeded before the tool result confirms it." : ""}`;
  if (provider.kind === "ollama") {
    const ollamaMessages = [{ role: "system", content: system }, ...messages];
    const data = await readProviderJson(await fetch(ollamaUrl(provider.baseUrl, "chat"), {
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
    }));
    if (!data.message || (typeof data.message.content !== "string" && !Array.isArray(data.message.tool_calls))) {
      throw new Error("Ollama returned neither a reply nor a tool request.");
    }
    return normalizeOpenAiMessage(data.message);
  }

  if (provider.kind === "anthropic") {
    const converted = toAnthropicMessages([{ role: "system", content: system }, ...messages]);
    const anthropicTools = (tools || []).map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    const data = await readProviderJson(await fetch(anthropicUrl(provider.baseUrl, "messages"), {
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
    }));
    return normalizeAnthropicMessage(data);
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
    data = await readProviderJson(await fetch(url, {
      method: "POST",
      headers: providerHeaders(provider, apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch (error) {
    if (error.status !== 400 || !/max_completion_tokens/i.test(error.providerMessage || "")) throw error;
    const compatibleBody = { ...body, max_tokens: body.max_completion_tokens };
    delete compatibleBody.max_completion_tokens;
    data = await readProviderJson(await fetch(url, {
      method: "POST",
      headers: providerHeaders(provider, apiKey),
      body: JSON.stringify(compatibleBody),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  }
  const message = data.choices?.[0]?.message;
  if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) {
    throw new Error("The provider returned neither a reply nor a tool request.");
  }
  return normalizeOpenAiMessage(message);
}

function isNetworkFailure(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return error instanceof TypeError
    || ["AbortError", "TimeoutError"].includes(error?.name)
    || ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ETIMEDOUT"].includes(code);
}

async function requestWithProviderFallback({ provider, apiKey, requestedModel, messages, tools, systemPrompt, timeoutMs }) {
  const models = modelChain(provider, requestedModel || defaultModelFor(provider));
  if (!models.length) throw new Error(`No model is configured for ${provider.label}.`);
  let lastError;
  for (const model of models) {
    try {
      return await callProvider({ provider, apiKey, model, messages, tools, systemPrompt, timeoutMs });
    } catch (error) {
      lastError = error;
      if (isNetworkFailure(error) || error.status === 401 || error.status === 403) break;
      if (error.status === 429) console.warn(`${provider.label} model ${model} was rate limited; trying the next configured model.`);
      else console.warn(`${provider.label} model ${model} failed; trying the next configured model.`);
    }
  }
  throw lastError || new Error(`No ${provider.label} models are configured.`);
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
  discoverProviderModels,
  isNetworkFailure,
  openAiChatUrl,
  providerConfigured,
  requestWithProviderFallback,
  resolveConfiguredProvider,
  validateBaseUrl,
};
