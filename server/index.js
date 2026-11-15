require("dotenv").config();

const cors = require("cors");
const express = require("express");
const {
  defaultModelFor,
  defaultProviderId,
  listProviders,
  modelChain,
  providerKey,
  resolveProvider,
} = require("./providers/catalog");
const {
  discoverProviderModels,
  requestWithProviderFallback,
} = require("./providers/runtime");

// Preserve the previous single-provider environment variables as aliases for
// the generic custom OpenAI-compatible provider.
if (process.env.CLOUD_API_URL && !process.env.CUSTOM_BASE_URL) process.env.CUSTOM_BASE_URL = process.env.CLOUD_API_URL;
if (process.env.CLOUD_API_KEY && !process.env.CUSTOM_API_KEY && process.env.CLOUD_API_URL) process.env.CUSTOM_API_KEY = process.env.CLOUD_API_KEY;
if (process.env.CLOUD_MODEL && !process.env.CUSTOM_MODEL && process.env.CLOUD_API_URL) process.env.CUSTOM_MODEL = process.env.CLOUD_MODEL;
if (process.env.CLOUD_MODEL_FALLBACKS && !process.env.CUSTOM_MODELS && process.env.CLOUD_API_URL) process.env.CUSTOM_MODELS = process.env.CLOUD_MODEL_FALLBACKS;
if (!process.env.CLOUD_API_URL && process.env.CLOUD_API_KEY && !process.env.GROQ_API_KEY) process.env.GROQ_API_KEY = process.env.CLOUD_API_KEY;
if (!process.env.CLOUD_API_URL && process.env.CLOUD_MODEL && !process.env.GROQ_MODEL) process.env.GROQ_MODEL = process.env.CLOUD_MODEL;
if (!process.env.CLOUD_API_URL && process.env.CLOUD_MODEL_FALLBACKS && !process.env.GROQ_MODEL_FALLBACKS) process.env.GROQ_MODEL_FALLBACKS = process.env.CLOUD_MODEL_FALLBACKS;
if (process.env.CLOUD_API_URL && !process.env.SHANAYA_DEFAULT_PROVIDER) process.env.SHANAYA_DEFAULT_PROVIDER = "custom";

const app = express();
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST?.trim() || "127.0.0.1";
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173,capacitor://localhost,http://localhost,https://localhost")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const localDevelopmentHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const corsOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  if (process.env.NODE_ENV !== "production") {
    try {
      if (localDevelopmentHosts.has(new URL(origin).hostname)) return callback(null, true);
    } catch {
      // Invalid Origin values are rejected below.
    }
  }
  return callback(null, false);
};
const configuredDefaultProvider = resolveProvider({ id: defaultProviderId() });
const cloudApiKey = providerKey(configuredDefaultProvider);
const cloudModels = modelChain(configuredDefaultProvider, defaultModelFor(configuredDefaultProvider));
const cloudRequestTimeout = Math.max(3_000, Math.min(120_000, Number(process.env.CLOUD_REQUEST_TIMEOUT_MS) || 60_000));
const cloudProvider = configuredDefaultProvider.label;

function getRequestProviderApiKey(req, provider) {
  const suppliedKey = req.get("x-groq-api-key")?.trim();
  if (!suppliedKey) return providerKey(provider);
  // A visitor-provided Groq key may only go to Groq's official HTTPS API.
  let officialGroq = false;
  try {
    const url = new URL(provider.baseUrl);
    officialGroq = provider.id === "groq" && url.protocol === "https:" && url.hostname === "api.groq.com" && !url.port;
  } catch {
    officialGroq = false;
  }
  if (!officialGroq) {
    const error = new Error("A visitor-provided Groq key can only be used with the official Groq API endpoint.");
    error.status = 400;
    throw error;
  }
  if (suppliedKey.length > 512 || /[\r\n]/.test(suppliedKey)) {
    const error = new Error("The Groq API key is invalid.");
    error.status = 400;
    throw error;
  }
  return suppliedKey;
}

function getRequestProvider(req, providerId) {
  let provider;
  try {
    provider = resolveProvider({ id: providerId });
  } catch (error) {
    error.status = 400;
    throw error;
  }
  const apiKey = getRequestProviderApiKey(req, provider);
  if (!provider.local && provider.id !== "custom" && !apiKey) {
    const error = new Error(`Configure ${provider.envKey || "provider credentials"} on the server or use a Groq key for Groq.`);
    error.status = 503;
    throw error;
  }
  return { provider, apiKey };
}
const systemPrompt = [
  "You are Shanaya, a warm, attentive, candid companion and capable personal assistant. Sound natural and emotionally perceptive, while staying honest that you are an AI and never inventing real-world personal experiences.",
  "Before replying, silently understand the user's intent, entities, constraints, references to earlier turns, emotional cues, and preferred language or register. Understand informal wording, typos, shorthand, and mixed-language messages without correcting them unless asked.",
  "Use the conversation history to resolve pronouns and follow-ups. Acknowledge feelings with proportionate empathy, then respond to the actual need. Keep the response specific and as concise or detailed as the request calls for.",
  "Vary your phrasing naturally. Avoid canned greetings, repeating the user's question, generic filler, forced emojis, and ending every reply with a question. Ask one focused follow-up only when missing information prevents a useful answer; otherwise make a reasonable interpretation.",
  "Take initiative within the user's stated request and use available tools to complete bounded multi-step tasks. Ask a follow-up only when an important detail is missing.",
  "Respect the user's privacy and all app confirmation flows. Sending messages, changing settings, spending money, writing or deleting files, and controlling a computer require confirmation. Never claim an action succeeded before its tool result confirms it.",
  'Respond only as a JSON object with this exact shape: {"reply":"your message","emotion":"happy|sad|angry|neutral|surprised|thinking"}.',
  "Use one allowed emotion that best matches the tone of your reply. Do not wrap the JSON in markdown.",
].join(" ");
const allowedEmotions = new Set(["happy", "sad", "angry", "neutral", "surprised", "thinking"]);

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "12mb" }));

if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const startedAt = Date.now();
    res.on("finish", () => {
      console.info(`[api] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
    });
    next();
  });
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", provider: cloudProvider, ready: Boolean((cloudApiKey || configuredDefaultProvider.local) && cloudModels.length) });
});

app.get("/api/providers", (_req, res) => {
  const providers = listProviders().map(({ id, label, kind, local, free, docs, requiresKey, configured, defaultModel }) => ({
    id, label, kind, local, free, docs, requiresKey, configured, defaultModel,
  }));
  res.json({ defaultProvider: defaultProviderId(), providers });
});

app.get("/api/models", async (req, res) => {
  const providerId = typeof req.query.provider === "string" && req.query.provider.trim()
    ? req.query.provider.trim()
    : defaultProviderId();
  try {
    const { provider, apiKey } = getRequestProvider(req, providerId);
    const { models, liveModels } = await discoverProviderModels(provider, apiKey, Math.min(5_000, cloudRequestTimeout));
    const configuredModel = defaultModelFor(provider);
    const defaultModel = liveModels.includes(configuredModel) ? configuredModel : liveModels[0] || configuredModel;
    const requestedModels = modelChain(provider, defaultModel);
    return res.json({
      provider: provider.label,
      providerId: provider.id,
      defaultModel,
      models: [...new Set([...requestedModels, ...models])].slice(0, 200),
    });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || "Could not load models for this provider." });
  }
});

app.get("/api/pinecall/token", async (_req, res) => {
  const tokenIssuerUrl = process.env.PINECALL_TOKEN_URL;
  if (!tokenIssuerUrl) {
    return res.status(503).json({ error: "Configure PINECALL_TOKEN_URL with your server-side Pinecall token issuer to enable voice calls." });
  }

  try {
    const response = await fetch(tokenIssuerUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || typeof token.token !== "string" || typeof token.server !== "string") {
      return res.status(502).json({ error: "The Pinecall token issuer returned an invalid response." });
    }
    return res.json({ token: token.token, server: token.server, expires_in: token.expires_in ?? token.expiresIn });
  } catch (error) {
    console.error(`Pinecall token issuer request failed (${error?.name || "request error"}).`);
    return res.status(502).json({ error: "Could not get a call token. Check the Pinecall token issuer configuration." });
  }
});

function parseJsonObject(content) {
  const candidate = content.trim().replace(/^```(?:[a-z0-9_-]+)?\s*/i, "").replace(/\s*```$/, "");
  for (let start = 0; start < candidate.length; start += 1) {
    if (candidate[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const character = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(candidate.slice(start, index + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function parseAssistantOutput(content) {
  const parsed = parseJsonObject(content);
  const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : "";
  const emotion = allowedEmotions.has(parsed?.emotion) ? parsed.emotion : "neutral";
  if (reply) return { reply, emotion };
  return { reply: content.trim().replace(/^```(?:[a-z0-9_-]+)?\s*/i, "").replace(/\s*```$/, ""), emotion: "neutral" };
}

async function requestCloud(messages, models = cloudModels, apiKey = cloudApiKey) {
  if (!apiKey || models.length === 0) throw new Error(`Configure a key for ${configuredDefaultProvider.label} to enable cloud AI.`);
  const message = await requestWithProviderFallback({
    provider: configuredDefaultProvider,
    apiKey,
    requestedModel: models[0] || defaultModelFor(configuredDefaultProvider),
    messages,
    systemPrompt,
    timeoutMs: cloudRequestTimeout,
  });
  return parseAssistantOutput(message.content || "");
}

async function requestOllama(messages) {
  const provider = resolveProvider({ id: "ollama" });
  const message = await requestWithProviderFallback({
    provider,
    apiKey: providerKey(provider),
    requestedModel: defaultModelFor(provider),
    messages,
    systemPrompt,
    timeoutMs: 120_000,
  });
  return parseAssistantOutput(message.content || "");
}

function isValidAgentMessage(message) {
  if (!message || !["user", "assistant", "tool"].includes(message.role)) return false;
  if (typeof message.content !== "string" || message.content.length > 8000) return false;
  if (message.role === "tool" && (typeof message.tool_call_id !== "string" || message.tool_call_id.length > 160)) return false;
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 8) return false;
    if (!message.tool_calls.every((call) => call && typeof call.id === "string" && call.function && typeof call.function.name === "string" && typeof call.function.arguments === "string")) return false;
  }
  return true;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 20) return null;
  const normalized = [];
  for (const tool of tools) {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(fn.name)) return null;
    if (!fn.parameters || typeof fn.parameters !== "object" || fn.parameters.type !== "object") return null;
    normalized.push({ type: "function", function: { name: fn.name, description: String(fn.description || "").slice(0, 1000), parameters: fn.parameters } });
  }
  return normalized;
}

async function requestCloudAgent(messages, tools, models = cloudModels, apiKey = cloudApiKey) {
  return requestWithProviderFallback({
    provider: configuredDefaultProvider,
    apiKey,
    requestedModel: models[0] || defaultModelFor(configuredDefaultProvider),
    messages,
    tools,
    systemPrompt,
    timeoutMs: cloudRequestTimeout,
  });
}

async function requestOllamaAgent(messages, tools) {
  const provider = resolveProvider({ id: "ollama" });
  return requestWithProviderFallback({
    provider,
    apiKey: providerKey(provider),
    requestedModel: defaultModelFor(provider),
    messages,
    tools,
    systemPrompt,
    timeoutMs: 120_000,
  });
}

app.post("/api/agent", async (req, res) => {
  const { messages, mode = "cloud", model } = req.body || {};
  if (mode !== "cloud" && mode !== "ollama") return res.status(400).json({ error: "Agent mode must be cloud or ollama." });
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 40 || !messages.every(isValidAgentMessage)) {
    return res.status(400).json({ error: "The agent conversation is invalid or too long." });
  }
  const tools = normalizeTools(req.body?.tools);
  if (!tools) return res.status(400).json({ error: "The agent tool schemas are invalid." });
  const providerId = mode === "ollama" ? "ollama" : (req.body?.provider || defaultProviderId());
  let provider;
  let requestApiKey;
  try {
    ({ provider, apiKey: requestApiKey } = getRequestProvider(req, providerId));
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (typeof model === "string" && (model.length > 200 || /[\r\n]/.test(model))) {
    return res.status(400).json({ error: "The selected model identifier is invalid." });
  }
  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : defaultModelFor(provider);
  const selectedModels = modelChain(provider, requestedModel);
  if (!selectedModels.length) return res.status(400).json({ error: `No model is configured for ${provider.label}.` });

  try {
    const normalizedMessages = messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    }));
    const message = await requestWithProviderFallback({
      provider,
      apiKey: requestApiKey,
      requestedModel: selectedModels[0],
      messages: normalizedMessages,
      tools,
      systemPrompt,
      timeoutMs: provider.local ? 120_000 : cloudRequestTimeout,
    });
    return res.json({ message: { content: typeof message.content === "string" ? message.content : "", tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : [] } });
  } catch (error) {
    console.error(`${provider.label} agent request failed (${error?.name || "request error"}).`);
    const rejectedKey = error?.status === 401 || error?.status === 403;
    const status = rejectedKey ? error.status : 502;
    return res.status(status).json({
      error: mode === "ollama" || provider.local
        ? "Could not reach Ollama or its model does not support tool calling."
        : rejectedKey
          ? `${provider.label} rejected the configured API key. Check that the key is valid and active.`
          : `${provider.label} could not complete an agent step with the configured models.`,
    });
  }
});

app.post("/api/tts", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const language = req.body?.language;
  const languageMap = { "en-US": "en", "hi-IN": "hi", "mr-IN": "mr" };
  const ttsUrl = (process.env.MITHI_TTS_URL || "").replace(/\/+$/, "");
  if (!text || text.length > 5000 || !languageMap[language]) {
    return res.status(400).json({ error: "Provide text up to 5,000 characters and a supported voice language." });
  }
  if (!ttsUrl) return res.status(503).json({ error: "Mithi voice is not configured. The app can use an installed system voice instead." });
  try {
    const response = await fetch(`${ttsUrl}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/wav" },
      body: JSON.stringify({ text, language: languageMap[language], voice: "charvi" }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return res.status(502).json({ error: "Mithi voice synthesis failed." });
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length || audio.length > 20 * 1024 * 1024) return res.status(502).json({ error: "Mithi returned an invalid audio response." });
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    return res.send(audio);
  } catch (error) {
    console.error(`Mithi TTS request failed (${error?.name || "request error"}).`);
    return res.status(502).json({ error: "Could not reach the configured Mithi TTS service." });
  }
});

app.post("/api/desktop/computer", async (req, res) => {
  const messages = req.body?.messages;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Configure ANTHROPIC_API_KEY on the server to enable desktop computer use." });
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 30 || messages.some((message) => !message || !["user", "assistant"].includes(message.role) || !(typeof message.content === "string" || Array.isArray(message.content)) || JSON.stringify(message.content).length > 8 * 1024 * 1024)) {
    return res.status(400).json({ error: "Desktop agent messages are invalid or too large." });
  }
  try {
    const anthropic = new (require("@anthropic-ai/sdk"))({ apiKey });
    const result = await anthropic.messages.create({
      model: process.env.ANTHROPIC_DESKTOP_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 1400,
      system: "You are Shanaya, a warm, attentive, natural-sounding desktop assistant. Silently infer the user's intent, entities, constraints, earlier-turn references, and emotional cues; understand informal language and typos without correcting them unless asked. Respond specifically and proportionately, with natural variation and no canned filler. Stay honest that you are an AI; do not invent personal experiences. Take initiative within the stated task and use the provided computer tool when useful. Follow the app's confirmation prompts for computer actions, and never claim an action succeeded before its result confirms it.",
      tools: [{
        type: "computer_toolset_20260801",
        configs: Object.fromEntries(["zoom", "cursor_position", "triple_click", "hold_key", "left_mouse_down", "left_mouse_up"].map((name) => [name, { enabled: false }])),
      }],
      messages,
    });
    return res.json({ content: result.content, stop_reason: result.stop_reason });
  } catch (error) {
    console.error(`Desktop computer agent request failed (${error?.name || "request error"}).`);
    return res.status(502).json({ error: "The desktop agent could not complete the Anthropic request." });
  }
});

app.post("/api/chat", async (req, res) => {
  const { messages, mode = "cloud", model } = req.body || {};
  if (mode !== "cloud" && mode !== "ollama") {
    return res.status(400).json({ error: "mode must be either cloud or ollama; local inference runs directly in the client." });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
    return res.status(400).json({ error: "messages must be an array containing 1 to 40 messages." });
  }

  const validMessages = messages.every(
    (message) =>
      message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0 &&
      message.content.length <= 4000,
  );

  if (!validMessages) {
    return res.status(400).json({ error: "Each message needs a valid role and non-empty content up to 4,000 characters." });
  }

  const providerId = mode === "ollama" ? "ollama" : (req.body?.provider || defaultProviderId());
  let provider;
  let requestApiKey;
  try {
    ({ provider, apiKey: requestApiKey } = getRequestProvider(req, providerId));
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  if (typeof model === "string" && (model.length > 200 || /[\r\n]/.test(model))) {
    return res.status(400).json({ error: "The selected model identifier is invalid." });
  }
  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : defaultModelFor(provider);
  const selectedModels = modelChain(provider, requestedModel);
  if (!selectedModels.length) return res.status(400).json({ error: `No model is configured for ${provider.label}.` });

  try {
    const normalizedMessages = messages.map(({ role, content }) => ({ role, content: content.trim() }));
    const message = await requestWithProviderFallback({
      provider,
      apiKey: requestApiKey,
      requestedModel: selectedModels[0],
      messages: normalizedMessages,
      systemPrompt,
      timeoutMs: provider.local ? 120_000 : cloudRequestTimeout,
    });
    const result = parseAssistantOutput(message.content || "");
    if (!result.reply) return res.status(502).json({ error: "The AI returned an empty response. Please try again." });
    return res.json(result);
  } catch (error) {
    console.error(`${provider.label} chat request failed (${error?.name || "request error"}).`);
    const rejectedKey = error?.status === 401 || error?.status === 403;
    const message = mode === "ollama" || provider.local
      ? "Could not reach your Ollama server. Check that it is running and that OLLAMA_BASE_URL is correct."
      : rejectedKey
        ? `${provider.label} rejected the configured API key. Check that the key is valid and active.`
        : `${provider.label} could not respond using its configured model fallback chain.`;
    return res.status(rejectedKey ? error.status : 502).json({ error: message });
  }
});

async function startServer() {
  const mcpEnabled = process.env.MCP_ENABLED === "true";
  if (mcpEnabled) {
    const { mountShanayaMcpEndpoint } = await import("./mcp-http.mjs");
    mountShanayaMcpEndpoint(app, process.env.MCP_API_TOKEN);
  }

  const server = app.listen(port, host, () => {
    console.log(`Shanaya API listening on http://${host}:${port}`);
    if (mcpEnabled) console.log(`Shanaya MCP endpoint enabled at http://${host}:${port}/mcp`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Shanaya API could not start: port ${port} is already in use. Stop the existing process or set PORT to another value.`);
    } else {
      console.error(`Shanaya API could not start (${error.code || error.name || "startup error"}).`);
    }
    process.exitCode = 1;
  });
}

// Export the Express app for serverless adapters while preserving direct startup
// when this file is launched with Node from the desktop/dev scripts.
Object.assign(app, { cloudModels, parseAssistantOutput, requestCloud, requestCloudAgent, startServer });
module.exports = app;

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Shanaya API could not start (${error?.code || error?.name || "startup error"}).`);
    process.exitCode = 1;
  });
}
