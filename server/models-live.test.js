"use strict";

// Auto and the model lists follow what the provider really serves today: a
// retired model is never picked, and speech or safety-classifier models are
// never offered as chat models.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { after, before, beforeEach, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "models-live-test-token-0123456789-abcdefghijk";
process.env.GROQ_API_KEY = "gsk_modelsLiveTestKey0123456789abcdefghijkl";
delete process.env.GROQ_MODEL;
delete process.env.GROQ_MODELS;
delete process.env.GROQ_MODEL_FALLBACKS;

// Groq today: two chat models, plus speech and guard models; the catalog's Llama models are retired.
const LIVE = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "whisper-large-v3-turbo", "meta-llama/llama-prompt-guard-2-86m", "canopylabs/orpheus-v1-english"];
const calls = [];
const busy = new Set();
// Models that spend the whole token limit before writing anything (reasoning models with a small max_tokens).
const cutShort = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.groq.com/")) return realFetch(input, init);
  if (url.endsWith("/models")) return new Response(JSON.stringify({ data: LIVE.map((id) => ({ id })) }), { status: 200, headers: { "content-type": "application/json" } });
  const body = JSON.parse(init.body || "{}");
  calls.push(body.model);
  if (busy.has(body.model)) return new Response(JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
  if (cutShort.has(body.model)) return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 24 } }), { status: 200, headers: { "content-type": "application/json" } });
  if (!LIVE.includes(body.model)) return new Response(JSON.stringify({ error: { message: `The model ${body.model} does not exist`, code: "model_not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify({ reply: `from ${body.model}`, emotion: "neutral" }) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
};

const { isChatModel } = require("./providers/runtime");
const { rememberServed, resetServed, servedStatus } = require("./providers/served");

let server;
let base;
const operator = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}`, "Content-Type": "application/json" };

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls.length = 0;
  busy.clear();
  cutShort.clear();
  resetServed();
});

test("chat models are told apart from speech, text-to-speech, guard and embedding models", () => {
  for (const id of ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "allam-2-7b", "claude-sonnet-4-5", "gemini-2.5-flash", "llama3.1:8b"]) assert.equal(isChatModel(id), true, id);
  for (const id of ["whisper-large-v3-turbo", "canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-86m", "openai/gpt-oss-safeguard-20b", "llama-guard-4-12b", "text-embedding-3-small", "gpt-4o-mini-tts", "gpt-4o-transcribe", "omni-moderation-latest"]) assert.equal(isChatModel(id), false, id);
});

test("the served-model registry knows, forgets after its time, and says unknown otherwise", () => {
  assert.equal(servedStatus("groq", "openai/gpt-oss-120b"), null);
  rememberServed("groq", ["openai/gpt-oss-120b"], 1_000);
  assert.equal(servedStatus("groq", "openai/gpt-oss-120b", 2_000), true);
  assert.equal(servedStatus("groq", "llama-3.1-8b-instant", 2_000), false);
  assert.equal(servedStatus("groq", "openai/gpt-oss-120b", 1_000 + 31 * 60_000), null);
  rememberServed("groq", []);
  assert.equal(servedStatus("groq", "x"), null);
});

test("the model list offers only chat models the provider serves", async () => {
  const data = await (await fetch(`${base}/api/models?provider=groq`, { headers: operator })).json();
  assert.deepEqual(data.models.sort(), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  assert.equal(data.defaultModel, "openai/gpt-oss-120b");
});

test("the catalog marks retired models unavailable", async () => {
  const data = await (await fetch(`${base}/api/catalog`, { headers: operator })).json();
  const groq = data.providers.find((provider) => provider.id === "groq");
  const byId = Object.fromEntries(groq.models.map((model) => [model.id, model.available]));
  assert.equal(byId["openai/gpt-oss-120b"], true);
  assert.equal(byId["llama-3.1-8b-instant"], false);
  assert.equal(byId["llama-3.3-70b-versatile"], false);
});

test("Auto on the agent route never picks a retired model, and answers", async () => {
  for (const routing of [undefined, { mode: "balanced" }]) {
    calls.length = 0;
    resetServed();
    const response = await fetch(`${base}/api/agent`, { method: "POST", headers: operator, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "auto", tools: [], ...(routing ? { routing } : {}) }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok(calls.length >= 1);
    for (const model of calls) assert.ok(LIVE.includes(model), `asked Groq for ${model}`);
  }
});

test("Auto on the plain chat route picks a real model instead of sending “auto”", async () => {
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: operator, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "auto" }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok(!calls.includes("auto"));
  for (const model of calls) assert.ok(LIVE.includes(model), `asked Groq for ${model}`);
});

test("the route preview recommends only served models", async () => {
  const data = await (await fetch(`${base}/api/route/preview`, { method: "POST", headers: operator, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).json();
  assert.ok(LIVE.includes(data.model), data.model);
  for (const alternative of data.alternatives || []) if (alternative.providerId === "groq") assert.ok(LIVE.includes(alternative.model), alternative.model);
});

test("a rate-limited model hands over to another model the provider serves", async () => {
  const { requestWithProviderFallback } = require("./providers/runtime");
  const { getProvider } = require("./providers/catalog");
  rememberServed("groq", LIVE);
  busy.add("openai/gpt-oss-120b");
  const message = await requestWithProviderFallback({ provider: getProvider("groq"), apiKey: "gsk_x", requestedModel: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "", timeoutMs: 5_000 });
  assert.equal(message.model, "openai/gpt-oss-20b");
  assert.deepEqual(calls, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
});

test("a configured fallback the provider retired is skipped", async () => {
  const { requestWithProviderFallback } = require("./providers/runtime");
  const { getProvider } = require("./providers/catalog");
  rememberServed("groq", LIVE);
  busy.add("openai/gpt-oss-20b");
  process.env.GROQ_MODEL_FALLBACKS = "llama-3.1-8b-instant,openai/gpt-oss-120b";
  try {
    const message = await requestWithProviderFallback({ provider: getProvider("groq"), apiKey: "gsk_x", requestedModel: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "", timeoutMs: 5_000 });
    assert.equal(message.model, "openai/gpt-oss-120b");
    assert.ok(!calls.includes("llama-3.1-8b-instant"));
  } finally {
    delete process.env.GROQ_MODEL_FALLBACKS;
  }
});

test("the OpenAI-compatible API and A2A never pick or list a retired model", async () => {
  const list = await (await fetch(`${base}/v1/models`, { headers: operator })).json();
  const groq = list.data.map((model) => model.id).filter((id) => id.startsWith("groq/"));
  assert.deepEqual(groq.sort(), ["groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"]);
  resetServed();
  calls.length = 0;
  const chat = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: operator, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(chat.status, 200, await chat.clone().text());
  resetServed();
  const a2a = await (await fetch(`${base}/api/a2a`, { method: "POST", headers: operator, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "text", text: "hi" }] } } }) })).json();
  assert.ok(a2a.result, JSON.stringify(a2a));
  for (const model of calls) assert.ok(LIVE.includes(model), `asked Groq for ${model}`);
});

test("a reply the token limit cut off says so on the OpenAI-compatible API", async () => {
  cutShort.add("openai/gpt-oss-20b");
  const send = async (model) => (await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: operator, body: JSON.stringify({ model, max_tokens: 24, messages: [{ role: "user", content: "hi" }] }) })).json();
  const short = await send("groq/openai/gpt-oss-20b");
  assert.equal(short.choices[0].finish_reason, "length");
  assert.equal(short.choices[0].message.content, "");
  const whole = await send("groq/openai/gpt-oss-120b");
  assert.equal(whole.choices[0].finish_reason, "stop");
});
