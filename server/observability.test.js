"use strict";

/**
 * Phase 7 observability regressions.
 *
 * These tests deliberately use no network: provider probes and feedback
 * delivery inject a fake fetch. The goal is to prove that error reports, LLM
 * traces, and feedback payloads stay free of prompts, credentials, and IPs.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const privacy = require("./observability/privacy");
const {
  buildDiscordPayload,
  buildFeedbackDocument,
  createFeedbackHandler,
  validateFeedbackPayload,
} = require("./feedback");
const { checkAgentHealth } = require("./health");
const {
  buildLangfuseBatch,
  createLlmTrace,
  flushLlmTraces,
} = require("./observability/llm-tracing");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("privacy scrubbers remove credentials, chat payloads, and local paths", () => {
  const key = "gsk_abcdefghijklmnopqrstuvwxyz123456";
  const redacted = privacy.redactSensitiveText(
    `key=${key} Authorization: Bearer abcdefghijklmnopqrstuvwxyz path=/Users/anya/private/notes.md`
  );
  assert.equal(redacted.includes(key), false);
  assert.equal(redacted.includes("/Users/anya"), false);
  assert.match(redacted, /<redacted>/);
  assert.match(redacted, /<file-path>/);
});

test("Sentry events lose identity, request bodies, auth headers, and prompt text", () => {
  const event = {
    user: { id: "user-1", email: "anya@example.com", ip_address: "203.0.113.9" },
    server_name: "local-mac",
    message: "Failed with gsk_abcdefghijklmnopqrstuvwxyz123456",
    request: {
      url: "https://api.example.com/chat?token=secret#fragment",
      data: { messages: [{ role: "user", content: "My private journal" }] },
      cookies: { session: "abc" },
      query_string: "token=secret",
      headers: {
        Authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
        Cookie: "session=abc",
        "Content-Type": "application/json",
        "X-Request-Id": "req-123",
      },
    },
    extra: {
      prompt: "Tell me a secret",
      nested: { reply: "private answer", model: "gpt-oss-120b" },
      accessToken: "opaque-access-token-value",
      userMessage: "My private journal",
      sourceURL: "https://user:pass@api.example.com/chat?token=secret",
    },
    breadcrumbs: [
      { category: "console", message: "user typed a private message", data: { text: "hi" } },
      { category: "navigation", message: "Opened /chat", data: { path: "/chat" } },
    ],
    exception: {
      values: [{
        type: "Error",
        value: "Request failed with Bearer abcdefghijklmnopqrstuvwxyz",
        stacktrace: {
          frames: [{
            filename: "/Users/anya/project/server/index.js",
            abs_path: "/Users/anya/project/server/index.js",
            lineno: 12,
            vars: { userMessage: "My private journal" },
            context_line: "const key = 'gsk_abcdefghijklmnopqrstuvwxyz123456';",
            pre_context: ["// private source"],
            post_context: ["// private source"],
          }, {
            filename: "https://shanaya.example/assets/main.js?token=secret",
            abs_path: "https://shanaya.example/assets/main.js#x",
            lineno: 3,
          }],
        },
      }],
    },
  };

  const clean = privacy.sanitizeSentryEvent(event);
  assert.equal("user" in clean, false);
  assert.equal("server_name" in clean, false);
  assert.equal("data" in clean.request, false);
  assert.equal("cookies" in clean.request, false);
  assert.equal("query_string" in clean.request, false);
  assert.equal(clean.request.headers.Authorization, undefined);
  assert.equal(clean.request.headers.Cookie, undefined);
  assert.equal(clean.request.headers["X-Request-Id"], undefined);
  assert.equal(clean.request.url.includes("token"), false);
  assert.equal(clean.extra.prompt, "<redacted>");
  assert.equal(clean.extra.nested.reply, "<redacted>");
  assert.equal(clean.extra.nested.model, "gpt-oss-120b");
  assert.equal(clean.extra.accessToken, "<redacted>");
  assert.equal(clean.extra.userMessage, "<redacted>");
  assert.equal(clean.extra.sourceURL, "https://api.example.com/chat");
  assert.equal(clean.breadcrumbs[0].message, "[redacted]");
  assert.equal(clean.breadcrumbs[0].data, undefined);
  assert.equal(clean.exception.values[0].value.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(clean.exception.values[0].stacktrace.frames[0].filename, "<file-path>/index.js");
  assert.equal(clean.exception.values[0].stacktrace.frames[0].abs_path, "<file-path>/index.js");
  for (const key of ["vars", "context_line", "pre_context", "post_context"]) {
    assert.equal(key in clean.exception.values[0].stacktrace.frames[0], false, key);
  }
  assert.equal(clean.exception.values[0].stacktrace.frames[1].filename, "https://shanaya.example/assets/main.js");
  assert.equal(clean.exception.values[0].stacktrace.frames[1].abs_path, "https://shanaya.example/assets/main.js");
});

test("transaction spans redact descriptions and span data", () => {
  const clean = privacy.sanitizeSentryTransaction({
    transaction: "POST /chat",
    spans: [{
      description: "fetch https://api.example.com/chat?key=secret",
      data: {
        prompt: "private ask",
        provider: "groq",
        "http.request.body": "private request body",
        "http.request.header.authorization": "Bearer abcdefghijklmnopqrstuvwxyz",
        "db.statement": "INSERT INTO notes VALUES ('private journal')",
        "db.query.text": "SELECT * FROM notes WHERE body = 'private'",
        "gen_ai.usage.input_tokens": 42,
      },
    }],
  });
  assert.equal(clean.spans[0].description.includes("secret"), false);
  assert.equal(clean.spans[0].data.prompt, "<redacted>");
  assert.equal(clean.spans[0].data.provider, "groq");
  assert.equal(clean.spans[0].data["http.request.body"], "<redacted>");
  assert.equal(clean.spans[0].data["http.request.header.authorization"], "<redacted>");
  assert.equal(clean.spans[0].data["db.statement"], "<redacted>");
  assert.equal(clean.spans[0].data["db.query.text"], "<redacted>");
  assert.equal(clean.spans[0].data["gen_ai.usage.input_tokens"], 42);
});

test("LLM traces keep timing, usage, and fallbacks without message content", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shanaya-trace-test-"));
  const previousLog = process.env.LLM_TRACE_LOG;
  const previousPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const previousSecretKey = process.env.LANGFUSE_SECRET_KEY;
  process.env.LLM_TRACE_LOG = path.join(directory, "llm_traces.jsonl");
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;

  try {
    const trace = createLlmTrace({
      provider: { id: "groq", label: "Groq" },
      requestedModel: "llama-3.3-70b-versatile",
    });
    const rateLimited = Object.assign(new Error("slow down"), { status: 429 });
    trace.recordFailure({
      model: "llama-3.3-70b-versatile",
      error: rateLimited,
      durationMs: 120,
      nextModel: "openai/gpt-oss-120b",
    });
    trace.succeed({
      model: "openai/gpt-oss-120b",
      usage: { promptTokens: 100, completionTokens: 20 },
      ttfbMs: 250,
      totalMs: 900,
    });
    await flushLlmTraces();

    const raw = fs.readFileSync(process.env.LLM_TRACE_LOG, "utf8").trim();
    const recorded = JSON.parse(raw);
    assert.equal(recorded.status, "success");
    assert.equal(recorded.model, "openai/gpt-oss-120b");
    assert.equal(recorded.latency.timeToFirstTokenMs, null);
    assert.equal(recorded.latency.timeToFirstByteMs, 250);
    assert.equal(recorded.usage.totalTokens, 120);
    assert.equal(recorded.fallbacks[0].reason, "rate_limited");
    assert.equal(recorded.fallbacks[0].toModel, "openai/gpt-oss-120b");
    assert.equal(Object.hasOwn(recorded, "messages"), false);
    assert.equal(Object.hasOwn(recorded, "prompt"), false);
    assert.equal(Object.hasOwn(recorded, "completion"), false);
    assert.equal(Object.hasOwn(recorded, "content"), false);

    const batch = buildLangfuseBatch(recorded);
    const generation = batch.batch.find((item) => item.type === "generation-create").body;
    assert.equal(generation.usage.total, 120);
    assert.equal(generation.metadata.fallbacks.length, 1);
    assert.equal(generation.metadata.latency.timeToFirstTokenMs, null);
    assert.equal(JSON.stringify(batch).includes("private journal"), false);
  } finally {
    if (previousLog === undefined) delete process.env.LLM_TRACE_LOG;
    else process.env.LLM_TRACE_LOG = previousLog;
    if (previousPublicKey === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
    else process.env.LANGFUSE_PUBLIC_KEY = previousPublicKey;
    if (previousSecretKey === undefined) delete process.env.LANGFUSE_SECRET_KEY;
    else process.env.LANGFUSE_SECRET_KEY = previousSecretKey;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("feedback validation accepts only the allow-listed schema", () => {
  const accepted = validateFeedbackPayload({
    message: "  The settings panel overlaps the send button.  ",
    category: "bug",
    appVersion: "1.2.3",
    platform: "iOS",
    inferenceMode: "cloud",
    modeDetail: "mobileclaw",
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.message, "The settings panel overlaps the send button.");
  assert.equal(accepted.value.inferenceMode, "Cloud");

  for (const payload of [
    { message: "", platform: "Web", inferenceMode: "Local" },
    { message: "hello", platform: "Windows", inferenceMode: "Local" },
    { message: "hello", platform: "Web", inferenceMode: "Private" },
    { message: "hello", platform: "Web", inferenceMode: "Local", category: "spam" },
    { message: "hello", platform: "Web", inferenceMode: "Local", modeDetail: "../../etc/passwd" },
  ]) {
    assert.equal(validateFeedbackPayload(payload).ok, false, JSON.stringify(payload));
  }
});

test("feedback documents and Discord payloads contain no reporter identity", () => {
  const document = buildFeedbackDocument(
    {
      message: "Please add a dark theme.",
      appVersion: "1.2.3",
      platform: "Android",
      inferenceMode: "Local",
      modeDetail: "native",
      category: "idea",
    },
    { id: "feedback-1", receivedAt: new Date("2026-11-15T10:00:00Z") }
  );
  for (const key of ["ip", "ipAddress", "userAgent", "userId", "email", "sessionId"]) {
    assert.equal(Object.hasOwn(document, key), false, key);
  }
  assert.equal(document.message, "Please add a dark theme.");
  assert.equal(document.receivedAt, "2026-11-15T10:00:00.000Z");

  const discord = buildDiscordPayload(document);
  assert.equal(discord.allowed_mentions.parse.length, 0);
  assert.equal(discord.embeds[0].description, "Please add a dark theme.");
  assert.equal(discord.embeds[0].fields.find((field) => field.name === "Inference").value, "Local (native)");
});

test("feedback handler delivers once and never reads the client IP", async () => {
  const deliveries = [];
  const handler = createFeedbackHandler({
    env: { FEEDBACK_DISCORD_WEBHOOK_URL: "https://discord.example/api/webhooks/1/token" },
    idFactory: () => "feedback-1",
    now: () => new Date("2026-11-15T10:00:00Z"),
    fetchImpl: async (url, init) => {
      deliveries.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 204 };
    },
  });
  const res = mockResponse();
  const req = {
    body: {
      message: "The mic indicator stays on after a call.",
      category: "bug",
      appVersion: "1.2.3",
      platform: "iOS",
      inferenceMode: "local",
      modeDetail: "native",
    },
    ip: "203.0.113.9",
    socket: { remoteAddress: "203.0.113.9" },
  };

  await handler(req, res);

  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { ok: true, id: "feedback-1" });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].url, "https://discord.example/api/webhooks/1/token");
  assert.equal(deliveries[0].body.embeds[0].description, "The mic indicator stays on after a call.");
  assert.equal(JSON.stringify(deliveries[0].body).includes("203.0.113.9"), false);
  assert.equal(JSON.stringify(deliveries[0].body).includes("User-Agent"), false);
});

test("feedback handler reports 503 when no delivery channel is configured", async () => {
  const handler = createFeedbackHandler({ env: {}, fetchImpl: async () => { throw new Error("must not fetch"); } });
  const res = mockResponse();
  await handler({
    body: {
      message: "hello",
      category: "other",
      appVersion: "1.0.0",
      platform: "Web",
      inferenceMode: "Cloud",
    },
  }, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /not configured/);
  assert.equal(JSON.stringify(res.body).includes("hello"), false);
});

test("feedback delivery failures never log the message or reporter identity", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const handler = createFeedbackHandler({
      env: { FEEDBACK_DISCORD_WEBHOOK_URL: "https://discord.example/api/webhooks/1/token" },
      idFactory: () => "feedback-2",
      now: () => new Date("2026-11-15T10:00:00Z"),
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    const res = mockResponse();
    await handler({
      body: {
        message: "My private journal mentions a breakup.",
        category: "bug",
        appVersion: "1.2.3",
        platform: "Web",
        inferenceMode: "cloud",
      },
      ip: "203.0.113.9",
    }, res);

    assert.equal(res.statusCode, 502);
    const logged = warnings.join("\n");
    assert.equal(logged.includes("private journal"), false);
    assert.equal(logged.includes("203.0.113.9"), false);
    assert.equal(logged.includes("discord.example"), false);
    assert.match(logged, /Delivery failed \(status 500\)/);
  } finally {
    console.warn = originalWarn;
  }
});

test("agent health reports Python and Ollama readiness without credentials", async () => {
  const originalFetch = globalThis.fetch;
  const previousPython = process.env.PYTHON_FALLBACK_URL;
  const previousOllamaBase = process.env.OLLAMA_BASE_URL;
  const previousOllamaModel = process.env.OLLAMA_MODEL;
  process.env.PYTHON_FALLBACK_URL = "http://127.0.0.1:8000";
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.OLLAMA_MODEL = "qwen3:8b";

  try {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === "http://127.0.0.1:8000/api/health") return jsonResponse({ status: "ok" });
      if (String(url) === "http://127.0.0.1:11434/api/tags") {
        return jsonResponse({ models: [{ name: "qwen3:8b" }, { name: "llama3:8b" }] });
      }
      throw new Error(`Unexpected probe ${url}`);
    };

    const health = await checkAgentHealth();
    assert.equal(health.status, "ok");
    assert.equal(health.httpStatus, 200);
    assert.equal(health.checks.pythonFallback.ready, true);
    assert.equal(health.checks.ollama.ready, true);
    assert.equal(health.checks.ollama.modelPresent, true);
    assert.equal(calls.every((url) => url.startsWith("http://127.0.0.1:")), true);
    assert.equal(JSON.stringify(health).includes("Authorization"), false);

    globalThis.fetch = async (url) => {
      if (String(url) === "http://127.0.0.1:8000/api/health") return jsonResponse({ status: "ok" });
      return jsonResponse({ models: [{ name: "another-model:latest" }] });
    };
    const degraded = await checkAgentHealth();
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.httpStatus, 200);
    assert.equal(degraded.checks.ollama.ready, false);
    assert.equal(degraded.checks.ollama.error, "model_missing");

    globalThis.fetch = async () => { throw new Error("offline"); };
    const unavailable = await checkAgentHealth();
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.httpStatus, 503);
    assert.equal(unavailable.checks.pythonFallback.error, "unreachable");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPython === undefined) delete process.env.PYTHON_FALLBACK_URL;
    else process.env.PYTHON_FALLBACK_URL = previousPython;
    if (previousOllamaBase === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousOllamaBase;
    if (previousOllamaModel === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = previousOllamaModel;
  }
});
