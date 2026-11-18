"use strict";

/**
 * HANNAH provider catalog.
 *
 * Every entry describes how to reach one AI provider or gateway. Groq is the
 * default base provider; every other entry is optional and only becomes active
 * when a credential (or, for local runtimes, a reachable base URL) exists.
 *
 * `kind` selects the wire protocol:
 *   - "openai"    OpenAI-compatible /chat/completions (most markets + gateways)
 *   - "anthropic" Anthropic /v1/messages
 *   - "ollama"    Ollama native /api/chat (falls back to OpenAI mode when needed)
 *
 * Model lists are seeds for the picker. `listProviderModels()` queries the
 * provider's own `/models` endpoint at runtime so new market models appear
 * without a code change.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** @typedef {{id:string,label:string,tools?:boolean,vision?:boolean,context?:number,free?:boolean,notes?:string}} ModelPreset */
/** @typedef {{id:string,label:string,kind:"openai"|"anthropic"|"ollama",baseUrl:string,envKey:string,envBaseUrl?:string,envModels?:string,envDefaultModel?:string,local?:boolean,free?:boolean,docs?:string,models:ModelPreset[]}} ProviderPreset */

/** @type {ProviderPreset[]} */
const PROVIDERS = [
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: GROQ_BASE_URL,
    envKey: "GROQ_API_KEY",
    envBaseUrl: "GROQ_API_URL",
    envModels: "GROQ_MODELS",
    envDefaultModel: "GROQ_MODEL",
    free: true,
    docs: "https://console.groq.com/keys",
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tools: true, free: true, context: 131072 },
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile", tools: true, free: true, context: 131072 },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", tools: true, free: true, context: 131072 },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", tools: true, free: true, context: 131072 },
      { id: "qwen/qwen3.8-27b", label: "Qwen3.8 27B (sees images)", tools: true, vision: true, free: true, context: 131072 },
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick 17B", tools: true, vision: true, free: true, context: 131072 },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B", tools: true, vision: true, free: true, context: 131072 },
      { id: "qwen/qwen3-32b", label: "Qwen3 32B", tools: true, free: true, context: 131072 },
      { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2 Instruct", tools: true, free: true, context: 131072 },
      { id: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill 70B", tools: false, free: true, context: 131072 },
      { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", tools: false, free: true, notes: "Audio transcription, not chat." },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    envBaseUrl: "OPENAI_BASE_URL",
    envModels: "OPENAI_MODELS",
    envDefaultModel: "OPENAI_MODEL",
    docs: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4.1", label: "GPT-4.1", tools: true, vision: true, context: 1047576 },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", tools: true, vision: true, context: 1047576 },
      { id: "gpt-4o", label: "GPT-4o", tools: true, vision: true, context: 128000 },
      { id: "gpt-4o-mini", label: "GPT-4o mini", tools: true, vision: true, context: 128000 },
      { id: "o4-mini", label: "o4-mini (reasoning)", tools: true, context: 200000 },
      { id: "o3", label: "o3 (reasoning)", tools: true, context: 200000 },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    envBaseUrl: "ANTHROPIC_BASE_URL",
    envModels: "ANTHROPIC_MODELS",
    envDefaultModel: "ANTHROPIC_MODEL",
    docs: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", tools: true, vision: true, context: 200000 },
      { id: "claude-opus-4-1", label: "Claude Opus 4.1", tools: true, vision: true, context: 200000 },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", tools: true, vision: true, context: 200000 },
      { id: "claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", tools: true, vision: true, context: 200000 },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    envModels: "GEMINI_MODELS",
    envDefaultModel: "GEMINI_MODEL",
    free: true,
    docs: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tools: true, vision: true, free: true, context: 1048576 },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tools: true, vision: true, free: true, context: 1048576 },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", tools: true, vision: true, free: true, context: 1048576 },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter (gateway)",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    envBaseUrl: "OPENROUTER_BASE_URL",
    envModels: "OPENROUTER_MODELS",
    free: true,
    docs: "https://openrouter.ai/keys",
    models: [
      { id: "openrouter/auto", label: "Auto router (best available)", tools: true },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", tools: true, vision: true },
      { id: "openai/gpt-4.1", label: "GPT-4.1", tools: true, vision: true },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", tools: true, vision: true },
      { id: "deepseek/deepseek-chat", label: "DeepSeek V3", tools: true },
      { id: "qwen/qwen3-coder", label: "Qwen3 Coder", tools: true },
      { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free tier)", tools: true, free: true },
      { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (free tier)", tools: false, free: true },
    ],
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    envBaseUrl: "TOGETHER_BASE_URL",
    envModels: "TOGETHER_MODELS",
    free: true,
    docs: "https://api.together.ai/settings/api-keys",
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B Turbo", tools: true },
      { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", label: "Qwen2.5 72B Turbo", tools: true },
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3", tools: true },
      { id: "meta-llama/Llama-Vision-Free", label: "Llama Vision (free)", tools: false, vision: true, free: true },
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    envBaseUrl: "CEREBRAS_BASE_URL",
    envModels: "CEREBRAS_MODELS",
    free: true,
    docs: "https://cloud.cerebras.ai/",
    models: [
      { id: "llama-3.3-70b", label: "Llama 3.3 70B", tools: true, free: true },
      { id: "llama3.1-8b", label: "Llama 3.1 8B", tools: true, free: true },
      { id: "qwen-3-32b", label: "Qwen3 32B", tools: true, free: true },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    envBaseUrl: "DEEPSEEK_BASE_URL",
    envModels: "DEEPSEEK_MODELS",
    docs: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", label: "DeepSeek V3 Chat", tools: true },
      { id: "deepseek-reasoner", label: "DeepSeek R1 Reasoner", tools: false },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    envBaseUrl: "MISTRAL_BASE_URL",
    envModels: "MISTRAL_MODELS",
    free: true,
    docs: "https://console.mistral.ai/api-keys",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large", tools: true },
      { id: "mistral-small-latest", label: "Mistral Small", tools: true, free: true },
      { id: "codestral-latest", label: "Codestral", tools: true, free: true },
    ],
  },
  {
    id: "xai",
    label: "xAI Grok",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    envBaseUrl: "XAI_BASE_URL",
    envModels: "XAI_MODELS",
    docs: "https://console.x.ai/",
    models: [
      { id: "grok-4", label: "Grok 4", tools: true, vision: true },
      { id: "grok-3", label: "Grok 3", tools: true },
      { id: "grok-3-mini", label: "Grok 3 mini", tools: true },
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
    envBaseUrl: "FIREWORKS_BASE_URL",
    envModels: "FIREWORKS_MODELS",
    docs: "https://fireworks.ai/account/api-keys",
    models: [
      { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B", tools: true },
      { id: "accounts/fireworks/models/deepseek-v3", label: "DeepSeek V3", tools: true },
      { id: "accounts/fireworks/models/qwen3-235b-a22b", label: "Qwen3 235B", tools: true },
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    kind: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    envBaseUrl: "NVIDIA_BASE_URL",
    envModels: "NVIDIA_MODELS",
    free: true,
    docs: "https://build.nvidia.com/",
    models: [
      { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B", tools: true, free: true },
      { id: "deepseek-ai/deepseek-r1", label: "DeepSeek R1", tools: false, free: true },
      { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B", tools: true, free: true },
    ],
  },
  {
    id: "sambanova",
    label: "SambaNova",
    kind: "openai",
    baseUrl: "https://api.sambanova.ai/v1",
    envKey: "SAMBANOVA_API_KEY",
    envBaseUrl: "SAMBANOVA_BASE_URL",
    envModels: "SAMBANOVA_MODELS",
    free: true,
    docs: "https://cloud.sambanova.ai/apis",
    models: [
      { id: "Meta-Llama-3.3-70B-Instruct", label: "Llama 3.3 70B", tools: true, free: true },
      { id: "DeepSeek-R1", label: "DeepSeek R1", tools: false, free: true },
    ],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    envKey: "PERPLEXITY_API_KEY",
    envBaseUrl: "PERPLEXITY_BASE_URL",
    envModels: "PERPLEXITY_MODELS",
    docs: "https://www.perplexity.ai/settings/api",
    models: [
      { id: "sonar", label: "Sonar (web-grounded)", tools: false },
      { id: "sonar-pro", label: "Sonar Pro (web-grounded)", tools: false },
    ],
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    kind: "openai",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    envKey: "HYPERBOLIC_API_KEY",
    envBaseUrl: "HYPERBOLIC_BASE_URL",
    envModels: "HYPERBOLIC_MODELS",
    docs: "https://app.hyperbolic.xyz/settings",
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct", label: "Llama 3.3 70B", tools: true },
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3", tools: true },
    ],
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    envKey: "OLLAMA_API_KEY",
    envBaseUrl: "OLLAMA_BASE_URL",
    envModels: "OLLAMA_MODELS",
    local: true,
    free: true,
    docs: "https://ollama.com/download",
    models: [
      { id: "qwen3:8b", label: "Qwen3 8B", tools: true, free: true },
      { id: "llama3.3", label: "Llama 3.3", tools: true, free: true },
      { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", tools: true, free: true },
    ],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:1234/v1",
    envKey: "LMSTUDIO_API_KEY",
    envBaseUrl: "LMSTUDIO_BASE_URL",
    envModels: "LMSTUDIO_MODELS",
    local: true,
    free: true,
    docs: "https://lmstudio.ai/",
    models: [{ id: "local-model", label: "Loaded local model", tools: true, free: true }],
  },
  {
    id: "llamacpp",
    label: "llama.cpp server (local)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8080/v1",
    envKey: "LLAMACPP_API_KEY",
    envBaseUrl: "LLAMACPP_BASE_URL",
    envModels: "LLAMACPP_MODELS",
    local: true,
    free: true,
    docs: "https://github.com/ggml-org/llama.cpp",
    models: [{ id: "local-model", label: "Loaded GGUF model", tools: true, free: true }],
  },
  {
    id: "vllm",
    label: "vLLM / LiteLLM gateway (local)",
    kind: "openai",
    baseUrl: "http://127.0.0.1:8000/v1",
    envKey: "VLLM_API_KEY",
    envBaseUrl: "VLLM_BASE_URL",
    envModels: "VLLM_MODELS",
    local: true,
    free: true,
    docs: "https://docs.vllm.ai/",
    models: [{ id: "local-model", label: "Served model", tools: true, free: true }],
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible gateway",
    kind: "openai",
    baseUrl: "",
    envKey: "CUSTOM_API_KEY",
    envBaseUrl: "CUSTOM_BASE_URL",
    envModels: "CUSTOM_MODELS",
    docs: "https://platform.openai.com/docs/api-reference/chat",
    models: [{ id: "custom-model", label: "Custom model id", tools: true }],
  },
];

const DEFAULT_PROVIDER_ID = "groq";
const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

function listProviders() {
  return PROVIDERS.map((provider) => {
    const key = providerKey(provider);
    const hasCustomBaseUrl = Boolean(provider.envBaseUrl && String(process.env[provider.envBaseUrl] || "").trim());
    return {
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      baseUrl: providerBaseUrl(provider),
      local: Boolean(provider.local),
      free: Boolean(provider.free),
      docs: provider.docs || "",
      requiresKey: !provider.local && provider.id !== "custom",
      configured: provider.id === "groq"
        || (provider.id === "custom" ? hasCustomBaseUrl
          : provider.local ? Boolean(provider.id === "ollama" || hasCustomBaseUrl)
            : Boolean(key && providerBaseUrl(provider))),
      defaultModel: defaultModelFor(provider),
      models: provider.models.map((model) => ({ ...model })),
    };
  });
}

function getProvider(id) {
  const normalized = typeof id === "string" ? id.trim().toLowerCase() : "";
  return byId.get(normalized) || null;
}

function defaultProviderId() {
  const configured = (process.env.HANNAH_DEFAULT_PROVIDER || "").trim().toLowerCase();
  return byId.has(configured) ? configured : DEFAULT_PROVIDER_ID;
}

function providerKey(provider) {
  if (!provider || !provider.envKey) return "";
  const value = process.env[provider.envKey];
  return typeof value === "string" ? value.trim() : "";
}

function providerBaseUrl(provider) {
  if (!provider) return "";
  const override = provider.envBaseUrl ? process.env[provider.envBaseUrl] : "";
  const base = (override && String(override).trim()) || provider.baseUrl || "";
  return base.replace(/\/+$/, "");
}

function providerModelOverrides(provider) {
  if (!provider || !provider.envModels) return [];
  return String(process.env[provider.envModels] || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function defaultModelFor(provider) {
  const envDefaultModel = provider?.envDefaultModel || (provider ? `${provider.id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_MODEL` : "");
  return (envDefaultModel && String(process.env[envDefaultModel] || "").trim())
    || providerModelOverrides(provider)[0]
    || (provider && provider.models[0] ? provider.models[0].id : "");
}

/** Build the ordered model retry list without trying every catalog seed. */
function modelChain(provider, requested) {
  if (!provider) return [];
  let fallbacks = [];
  if (provider.id === "groq") {
    fallbacks = (process.env.GROQ_MODEL_FALLBACKS || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
  }
  return [...new Set([
    requested,
    ...providerModelOverrides(provider),
    ...fallbacks,
  ].filter(Boolean))];
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(hostname).toLowerCase());
}

/**
 * Validate an operator- or visitor-supplied base URL. Remote endpoints must use
 * HTTPS; plain HTTP is only allowed for loopback runtimes.
 */
function validateBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new Error("A provider base URL is required.");
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("The provider base URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The provider base URL must use HTTPS (or HTTP on loopback).");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Provider URLs must not embed credentials or query parameters.");
  if (parsed.protocol === "http:" && !isLocalHostname(parsed.hostname)) {
    throw new Error("Plain HTTP is only allowed for local model servers; use HTTPS for remote providers.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** Resolve a provider by id, or synthesize one for a custom base URL. */
function resolveProvider({ id, baseUrl } = {}) {
  const preset = id
    ? getProvider(id)
    : getProvider(defaultProviderId()) || getProvider(DEFAULT_PROVIDER_ID);
  if (preset) {
    const resolved = { ...preset, baseUrl: providerBaseUrl(preset) };
    if (baseUrl) resolved.baseUrl = validateBaseUrl(baseUrl);
    if (!resolved.baseUrl) throw new Error(`Provider ${preset.label} needs a base URL (set ${preset.envBaseUrl}).`);
    resolved.baseUrl = validateBaseUrl(resolved.baseUrl);
    return resolved;
  }
  if (baseUrl) {
    return {
      id: String(id || "custom"),
      label: String(id || "Custom provider"),
      kind: "openai",
      baseUrl: validateBaseUrl(baseUrl),
      envKey: "",
      models: [],
    };
  }
  throw new Error(`Unknown provider "${id}".`);
}

module.exports = {
  DEFAULT_PROVIDER_ID,
  GROQ_BASE_URL,
  PROVIDERS,
  defaultModelFor,
  defaultProviderId,
  getProvider,
  isLocalHostname,
  listProviders,
  modelChain,
  providerBaseUrl,
  providerKey,
  providerModelOverrides,
  resolveProvider,
  validateBaseUrl,
};
