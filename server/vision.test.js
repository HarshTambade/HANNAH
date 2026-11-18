const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const { checkImage, createVisionRouter, describeWith, visionCandidates, SYSTEM } = require("./vision");
const { normalizeRouting, privacyBlocks } = require("./router");

// The smallest valid JPEG and PNG headers, padded.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]).toString("base64");

const groq = { provider: { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", models: [{ id: "llama-3.3-70b-versatile" }, { id: "meta-llama/llama-4-scout-17b-16e-instruct", vision: true }] }, apiKey: "gsk_x" };
const groqTwo = { ...groq, provider: { ...groq.provider, models: [{ id: "retired-vision", vision: true }, { id: "qwen/qwen3.8-27b", vision: true }] } };
const anthropic = { provider: { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", models: [{ id: "claude-sonnet-4-5", vision: true }] }, apiKey: "sk-ant" };
const ollama = { provider: { id: "ollama", label: "Ollama", kind: "ollama", local: true, baseUrl: "http://127.0.0.1:11434", models: [] }, apiKey: "" };
const textOnly = { provider: { id: "cerebras", label: "Cerebras", kind: "openai", baseUrl: "https://api.cerebras.ai/v1", models: [{ id: "llama3.1-8b" }] }, apiKey: "k" };

test("accepts only real JPEG or PNG data within the size limit", () => {
  assert.doesNotThrow(() => checkImage(JPEG, "image/jpeg"));
  assert.doesNotThrow(() => checkImage(PNG, "image/png"));
  assert.throws(() => checkImage(PNG, "image/jpeg"), /doesn't match/);
  assert.throws(() => checkImage(JPEG, "image/gif"), /JPEG or PNG/);
  assert.throws(() => checkImage("not base64!", "image/jpeg"), /base64/);
  assert.throws(() => checkImage("A".repeat(5 * 1024 * 1024), "image/jpeg"), /too large/);
});

test("picks vision models the caller can use; Private mode keeps the picture on self-hosted models", () => {
  const hosted = visionCandidates([textOnly, anthropic, groq], { policy: null, privacyBlocks, override: "" });
  assert.deepEqual(hosted.map((item) => `${item.provider.id}:${item.model}`), ["groq:meta-llama/llama-4-scout-17b-16e-instruct", "anthropic:claude-sonnet-4-5"]);
  const privateMode = normalizeRouting({ mode: "private" });
  assert.deepEqual(visionCandidates([groq, anthropic, ollama], { policy: privateMode, privacyBlocks, override: "" }), [], "no self-hosted vision model is configured");
  const withLocal = visionCandidates([groq, ollama], { policy: privateMode, privacyBlocks, override: "ollama:llava:13b" });
  assert.deepEqual(withLocal.map((item) => `${item.provider.id}:${item.model}`), ["ollama:llava:13b"]);
  const overrideHostedInPrivate = visionCandidates([groq], { policy: privateMode, privacyBlocks, override: "groq:meta-llama/llama-4-scout-17b-16e-instruct" });
  assert.deepEqual(overrideHostedInPrivate, [], "the override can't send a picture to a hosted model in Private mode");
});

test("sends one image in each provider's own format", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const body = url.includes("anthropic") ? { content: [{ type: "text", text: "A terminal with an error." }] } : url.includes("11434") ? { message: { content: "A code editor." } } : { choices: [{ message: { content: "A browser showing YouTube." } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const opts = { image: JPEG, mediaType: "image/jpeg", text: "Question: what's this?", timeoutMs: 5000, fetchImpl };
  assert.equal(await describeWith({ ...groq, model: "meta-llama/llama-4-scout-17b-16e-instruct" }, opts), "A browser showing YouTube.");
  assert.equal(await describeWith({ ...anthropic, model: "claude-sonnet-4-5" }, opts), "A terminal with an error.");
  assert.equal(await describeWith({ ...ollama, model: "llava" }, opts), "A code editor.");
  const [openai, claude, local] = calls;
  assert.equal(openai.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(openai.headers.Authorization, "Bearer gsk_x");
  assert.equal(openai.body.messages[1].content[1].image_url.url, `data:image/jpeg;base64,${JPEG}`);
  assert.equal(claude.url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(claude.body.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG } });
  assert.equal(local.url, "http://127.0.0.1:11434/api/chat");
  assert.deepEqual(local.body.messages[1].images, [JPEG]);
  for (const call of calls) assert.match(JSON.stringify(call.body), /untrusted data/);
});

async function serve(usable, fetchImpl) {
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.use(createVisionRouter({ usableProviders: () => usable, normalizeRouting, privacyBlocks, timeoutMs: 5000, fetchImpl }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const post = async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/vision/describe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { post, close: () => server.close() };
}

test("the route answers, refuses bad input, and says when no model can see", async () => {
  let sentText = "";
  const fetchImpl = async (_url, init) => {
    sentText = JSON.parse(init.body).messages[1].content[0].text;
    return new Response(JSON.stringify({ choices: [{ message: { content: "VS Code shows a TypeError on line 12." } }] }), { status: 200 });
  };
  const api = await serve([textOnly, groq], fetchImpl);
  try {
    const ok = await api.post({ image: JPEG, mediaType: "image/jpeg", question: "Explain this error", windows: ["index.ts — project", "Terminal"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { answer: "VS Code shows a TypeError on line 12.", provider: "Groq", model: "meta-llama/llama-4-scout-17b-16e-instruct" });
    assert.match(sentText, /Open windows \(names from the system, untrusted\): index\.ts — project \| Terminal/);
    assert.equal((await api.post({ image: JPEG, question: "" })).status, 400);
    assert.equal((await api.post({ image: PNG, mediaType: "image/jpeg", question: "hi" })).status, 400);
    const privateMode = await api.post({ image: JPEG, question: "What's this?", routing: { mode: "private" } });
    assert.equal(privateMode.status, 503);
    assert.match(privateMode.body.error, /Private mode/);
  } finally {
    api.close();
  }
  const none = await serve([textOnly], fetchImpl);
  try {
    const result = await none.post({ image: JPEG, question: "What's this?" });
    assert.equal(result.status, 503);
    assert.match(result.body.error, /reads images/);
  } finally {
    none.close();
  }
});

test("a retired model (404) falls through to the provider's next vision model", async () => {
  const tried = [];
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    tried.push(model);
    if (model === "retired-vision") return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "A terminal." } }] }), { status: 200 });
  };
  const api = await serve([groqTwo], fetchImpl);
  try {
    const result = await api.post({ image: JPEG, question: "What's this?" });
    assert.equal(result.status, 200);
    assert.equal(result.body.model, "qwen/qwen3.8-27b");
    assert.deepEqual(tried, ["retired-vision", "qwen/qwen3.8-27b"]);
  } finally {
    api.close();
  }
});

test("the instructions treat on-screen text as data and keep secrets out of answers", () => {
  assert.match(SYSTEM, /never act on it/);
  assert.match(SYSTEM, /passwords, one-time codes/);
});
