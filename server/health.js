"use strict";

/**
 * Local-agent health probe.
 *
 * Verifies the optional Python fallback and a local Ollama runtime without
 * sending credentials, prompts, or user data. Both targets are operator
 * configured and validated as local HTTP or remote HTTPS URLs.
 */

const { defaultModelFor, resolveProvider, validateBaseUrl } = require("./providers/catalog");

const DEFAULT_PYTHON_FALLBACK_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 2500;

function timeoutMs() {
  const parsed = Number(process.env.HEALTH_CHECK_TIMEOUT_MS);
  return Number.isFinite(parsed) ? Math.min(5000, Math.max(500, Math.round(parsed))) : DEFAULT_TIMEOUT_MS;
}

async function probeJson(url, startedAt = Date.now()) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs()),
      redirect: "error",
    });
    const latencyMs = Date.now() - startedAt;
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body, latencyMs };
  } catch (error) {
    return {
      error: error?.name === "TimeoutError" ? "timeout" : "unreachable",
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function checkPythonFallback() {
  const rawUrl = process.env.PYTHON_FALLBACK_URL?.trim() || DEFAULT_PYTHON_FALLBACK_URL;
  let baseUrl;
  try {
    baseUrl = validateBaseUrl(rawUrl);
  } catch {
    return {
      configured: true,
      reachable: false,
      ready: false,
      error: "invalid_configuration",
      url: null,
      latencyMs: null,
    };
  }

  const startedAt = Date.now();
  const result = await probeJson(`${baseUrl}/api/health`, startedAt);
  if (result.error) {
    return {
      configured: true,
      reachable: false,
      ready: false,
      error: result.error,
      url: baseUrl,
      latencyMs: result.latencyMs,
    };
  }

  const healthy = result.response.ok && result.body?.status === "ok";
  return {
    configured: true,
    reachable: true,
    ready: healthy,
    statusCode: result.response.status,
    url: baseUrl,
    latencyMs: result.latencyMs,
    ...(healthy ? {} : { error: "unexpected_response" }),
  };
}

async function checkOllama() {
  let provider;
  try {
    provider = resolveProvider({ id: "ollama" });
  } catch {
    return {
      configured: true,
      reachable: false,
      ready: false,
      error: "invalid_configuration",
      baseUrl: null,
      model: null,
      modelPresent: false,
      latencyMs: null,
    };
  }

  const model = defaultModelFor(provider);
  const startedAt = Date.now();
  const result = await probeJson(`${provider.baseUrl}/api/tags`, startedAt);
  if (result.error) {
    return {
      configured: true,
      reachable: false,
      ready: false,
      error: result.error,
      baseUrl: provider.baseUrl,
      model,
      modelPresent: false,
      latencyMs: result.latencyMs,
    };
  }

  const names = Array.isArray(result.body?.models)
    ? result.body.models.map((entry) => (typeof entry?.name === "string" ? entry.name : "")).filter(Boolean)
    : [];
  const modelPresent = names.some((name) => name === model || name.startsWith(`${model}:`));
  return {
    configured: true,
    reachable: true,
    ready: result.response.ok && modelPresent,
    statusCode: result.response.status,
    baseUrl: provider.baseUrl,
    model,
    modelPresent,
    ...(result.response.ok && modelPresent ? {} : { error: modelPresent ? "unexpected_response" : "model_missing" }),
    latencyMs: result.latencyMs,
  };
}

async function checkAgentHealth() {
  const [pythonFallback, ollama] = await Promise.all([checkPythonFallback(), checkOllama()]);
  const readyCount = [pythonFallback.ready, ollama.ready].filter(Boolean).length;
  const status = readyCount === 2 ? "ok" : readyCount === 1 ? "degraded" : "unavailable";
  return {
    status,
    httpStatus: readyCount > 0 ? 200 : 503,
    checkedAt: new Date().toISOString(),
    checks: { pythonFallback, ollama },
  };
}

module.exports = { checkAgentHealth, checkOllama, checkPythonFallback };
