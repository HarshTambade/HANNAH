"use strict";

/**
 * Metadata-only LLM tracing.
 *
 * Every trace is appended locally as JSONL and, when Langfuse credentials are
 * configured, exported through Langfuse's ingestion API. This module never
 * accepts or serializes prompt text, completion text, tool arguments, or API
 * keys. Callers pass only provider/model identifiers, latency, token counts,
 * and typed fallback metadata.
 *
 * The provider runtime is currently non-streaming. `timeToFirstTokenMs` is
 * therefore null and `timeToFirstByteMs` records when response headers arrived;
 * Langfuse receives that value as `completionStartTime`. If a streaming path is
 * added later, it can populate the same field without changing the schema.
 */

const { randomUUID } = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const TRACE_VERSION = 1;
const MAX_ATTEMPTS = 30;

let writeQueue = Promise.resolve();
let writeWarningShown = false;

function tracingDisabled() {
  return process.env.LLM_TRACING_DISABLED === "true";
}

function traceLogPath() {
  const configured = process.env.LLM_TRACE_LOG?.trim() || "logs/llm_traces.jsonl";
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function langfuseConfig() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return null;
  const baseUrl = (process.env.LANGFUSE_BASEURL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").trim().replace(/\/+$/, "");
  return { publicKey, secretKey, baseUrl };
}

function safeLabel(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]/g, " ").trim().slice(0, maxLength);
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function nonNegativeInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const prompt = nonNegativeInteger(rawUsage.promptTokens);
  const completion = nonNegativeInteger(rawUsage.completionTokens);
  const total = nonNegativeInteger(rawUsage.totalTokens) ?? (
    prompt !== null && completion !== null ? prompt + completion : null
  );
  if (prompt === null && completion === null && total === null) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function normalizeError(error) {
  return {
    type: safeLabel(error?.name || "Error", 80) || "Error",
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
  };
}

function buildFallbackEvent({ fromModel, toModel, error, durationMs }) {
  const normalized = normalizeError(error);
  return {
    fromModel: safeLabel(fromModel),
    toModel: safeLabel(toModel),
    reason: normalized.httpStatus === 429 ? "rate_limited" : "provider_error",
    errorType: normalized.type,
    httpStatus: normalized.httpStatus,
    durationMs: nonNegativeInteger(durationMs),
  };
}

/**
 * Create an in-memory trace. The returned object exposes only metadata methods;
 * it cannot accept message content by design.
 */
function createLlmTrace({ provider, requestedModel, operation = "chat", source = "node" } = {}) {
  const startedAt = Date.now();
  let finished = false;
  const trace = {
    type: "llm_trace",
    version: TRACE_VERSION,
    id: randomUUID(),
    timestamp: iso(startedAt),
    source,
    name: `hannah.llm.${safeLabel(operation, 40) || "chat"}`,
    operation: safeLabel(operation, 40) || "chat",
    provider: {
      id: safeLabel(provider?.id, 64) || "unknown",
      label: safeLabel(provider?.label, 80) || "Unknown provider",
    },
    requestedModel: safeLabel(requestedModel, 200) || null,
    model: null,
    status: "running",
    streaming: false,
    latency: null,
    usage: null,
    attempts: [],
    fallbacks: [],
    error: null,
  };

  function recordFailure({ model, error, durationMs, nextModel = null }) {
    if (finished) return;
    const normalized = normalizeError(error);
    trace.attempts.push({
      model: safeLabel(model),
      errorType: normalized.type,
      httpStatus: normalized.httpStatus,
      durationMs: nonNegativeInteger(durationMs),
    });
    if (trace.attempts.length > MAX_ATTEMPTS) trace.attempts.shift();
    if (nextModel) {
      trace.fallbacks.push(buildFallbackEvent({ fromModel: model, toModel: nextModel, error, durationMs }));
      if (trace.fallbacks.length > MAX_ATTEMPTS) trace.fallbacks.shift();
    }
  }

  function succeed({ model, usage, ttfbMs, totalMs }) {
    if (finished) return;
    finished = true;
    trace.status = "success";
    trace.model = safeLabel(model) || trace.requestedModel;
    trace.usage = normalizeUsage(usage);
    trace.latency = {
      timeToFirstByteMs: nonNegativeInteger(ttfbMs),
      // Non-streaming responses do not expose a token boundary. Keep the field
      // present for dashboards and populate it only when streaming is enabled.
      timeToFirstTokenMs: null,
      totalMs: nonNegativeInteger(totalMs),
      streaming: false,
    };
    finishTrace(trace);
  }

  function fail(error) {
    if (finished) return;
    finished = true;
    trace.status = "error";
    trace.error = normalizeError(error);
    finishTrace(trace);
  }

  return {
    id: trace.id,
    requestedModel: trace.requestedModel,
    recordFailure,
    succeed,
    fail,
  };
}

function serializeTrace(trace) {
  return JSON.stringify(sanitizeTraceObject(trace));
}

function sanitizeTraceObject(trace) {
  // Rebuild an allow-listed object so a future caller cannot accidentally add a
  // prompt, response, or credential field to the local trace file.
  return {
    type: "llm_trace",
    version: TRACE_VERSION,
    id: trace.id,
    timestamp: trace.timestamp,
    source: trace.source,
    name: trace.name,
    operation: trace.operation,
    provider: trace.provider,
    requestedModel: trace.requestedModel,
    model: trace.model,
    status: trace.status,
    streaming: Boolean(trace.streaming),
    latency: trace.latency,
    usage: trace.usage,
    attempts: trace.attempts.slice(0, MAX_ATTEMPTS),
    fallbacks: trace.fallbacks.slice(0, MAX_ATTEMPTS),
    error: trace.error,
  };
}

async function appendTrace(trace) {
  if (tracingDisabled()) return;
  const target = traceLogPath();
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fsp.appendFile(target, `${serializeTrace(trace)}\n`, { encoding: "utf8", mode: 0o600 });
  }).catch((error) => {
    if (!writeWarningShown) {
      writeWarningShown = true;
      console.warn(`[observability] Could not write LLM traces (${error?.code || error?.name || "I/O error"}).`);
    }
  });
  await writeQueue;
}

function buildLangfuseBatch(trace) {
  const endTime = trace.latency?.totalMs
    ? new Date(new Date(trace.timestamp).getTime() + trace.latency.totalMs).toISOString()
    : new Date().toISOString();
  const startTime = trace.timestamp;
  const completionStartTime = trace.latency?.timeToFirstByteMs
    ? new Date(new Date(startTime).getTime() + trace.latency.timeToFirstByteMs).toISOString()
    : null;
  const generationBody = {
    id: `${trace.id}-generation`,
    traceId: trace.id,
    name: "generation",
    startTime,
    endTime,
    ...(completionStartTime ? { completionStartTime } : {}),
    model: trace.model || trace.requestedModel,
    modelParameters: {
      provider: trace.provider.id,
      providerLabel: trace.provider.label,
      streaming: trace.streaming,
    },
    level: trace.status === "success" ? "DEFAULT" : "ERROR",
    ...(trace.status === "error" && trace.error ? { statusMessage: trace.error.type } : {}),
    ...(trace.usage ? {
      usage: {
        ...(trace.usage.promptTokens !== null ? { input: trace.usage.promptTokens } : {}),
        ...(trace.usage.completionTokens !== null ? { output: trace.usage.completionTokens } : {}),
        ...(trace.usage.totalTokens !== null ? { total: trace.usage.totalTokens } : {}),
        unit: "TOKENS",
      },
    } : {}),
    metadata: {
      operation: trace.operation,
      requestedModel: trace.requestedModel,
      fallbacks: trace.fallbacks,
      attempts: trace.attempts,
      latency: trace.latency,
      source: trace.source,
    },
  };

  return {
    batch: [
      {
        id: randomUUID(),
        type: "trace-create",
        timestamp: startTime,
        body: {
          id: trace.id,
          timestamp: startTime,
          name: trace.name,
          metadata: {
            provider: trace.provider,
            operation: trace.operation,
            requestedModel: trace.requestedModel,
            status: trace.status,
            source: trace.source,
          },
          tags: ["hannah", trace.provider.id, trace.operation],
        },
      },
      {
        id: randomUUID(),
        type: "generation-create",
        timestamp: startTime,
        body: generationBody,
      },
    ],
  };
}

function exportToLangfuse(trace) {
  const config = langfuseConfig();
  if (!config || typeof fetch !== "function") return;
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
  fetch(`${config.baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
    },
    body: JSON.stringify(buildLangfuseBatch(trace)),
    signal: AbortSignal.timeout(5_000),
  }).then((response) => {
    if (!response.ok) console.warn(`[observability] Langfuse rejected an LLM trace (HTTP ${response.status}).`);
  }).catch(() => {
    console.warn("[observability] Langfuse trace export failed (network error).");
  });
}

function finishTrace(trace) {
  if (tracingDisabled()) return;
  try {
    void appendTrace(trace);
    exportToLangfuse(trace);
  } catch (error) {
    // Observability is best-effort. A trace serialization/export failure must
    // never turn a successful model response into a fallback or an error.
    if (!writeWarningShown) {
      writeWarningShown = true;
      console.warn(`[observability] Could not record an LLM trace (${error?.name || "serialization error"}).`);
    }
  }
}

/** Await pending local writes (used by tests and graceful shutdown). */
async function flushLlmTraces() {
  await writeQueue;
}

module.exports = {
  buildLangfuseBatch,
  createLlmTrace,
  flushLlmTraces,
  normalizeUsage,
  serializeTrace,
  traceLogPath,
};
