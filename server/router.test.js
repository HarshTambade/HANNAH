const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test, before, after, beforeEach } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "router-test-token-0123456789-abcdefghijklmnopq";
// Groq stays on its real HTTPS URL: these tests must prove it's never called in Private mode.
process.env.GROQ_API_KEY = "gsk_routerTestServerKey0123456789abcdefghij";

const router = require("./router");
const { getProvider } = require("./providers/catalog");

// One fake OpenAI-compatible server on loopback plays two self-hosted runtimes.
const requests = [];
const fake = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ path: req.url, model: body.model });
  if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "fail-model" }, { id: "local-model" }] }));
  if (body.model === "fail-model") { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: "warming up" } })); }
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ reply: `from ${body.model}`, emotion: "neutral" }) } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
});

let server;
let baseUrl;
const operator = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}`, "Content-Type": "application/json" };
const post = (path, body, headers = operator) => fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const hello = [{ role: "user", content: "hey, how are you?" }];
const noteTool = [{ type: "function", function: { name: "save_note", description: "Save a note", parameters: { type: "object", properties: { text: { type: "string" } } } } }];

before(async () => {
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const url = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.CUSTOM_BASE_URL = url;
  process.env.CUSTOM_MODEL = "fail-model";
  process.env.LMSTUDIO_BASE_URL = url;
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fake.close();
});

beforeEach(() => {
  router.resetStats();
  requests.length = 0;
});

// ---------------------------------------------------------------------------
// Unit: policy and ranking on catalog providers

const groq = { ...getProvider("groq"), baseUrl: "https://api.groq.com/openai/v1" };
const openai = { ...getProvider("openai"), baseUrl: "https://api.openai.com/v1" };
const ollama = { ...getProvider("ollama"), baseUrl: "http://127.0.0.1:11434", models: [{ id: "llama3.2:3b", label: "Llama 3.2 3B", tools: true }] };
const coding = [{ role: "user", content: "Debug this and then refactor it:\n```js\nfunction add(a, b) { return a - b }\n```\n" + "x".repeat(400) }];

test("routing policies are validated", () => {
  assert.equal(router.normalizeRouting(undefined), null);
  assert.deepEqual(router.normalizeRouting({ mode: "private" }), { mode: "private", providers: null, maxTier: null, localOnly: true });
  assert.equal(router.normalizeRouting({ mode: "offline" }).localOnly, true);
  assert.deepEqual(router.normalizeRouting({ mode: "custom", providers: ["groq"], maxTier: "strong" }), { mode: "custom", providers: ["groq"], maxTier: "strong", localOnly: false });
  // Custom fields only apply in custom mode.
  assert.equal(router.normalizeRouting({ mode: "budget", providers: ["groq"] }).providers, null);
  assert.throws(() => router.normalizeRouting({ mode: "cheapest" }), { code: "invalid_routing" });
  assert.throws(() => router.normalizeRouting({ mode: "custom", maxTier: "huge" }), { code: "invalid_routing" });
  assert.throws(() => router.normalizeRouting({ mode: "custom", providers: ["../etc"] }), { code: "invalid_routing" });
  assert.throws(() => router.normalizeRouting("quality"), { code: "invalid_routing" });
});

test("each mode ranks models for its goal", () => {
  const usableProviders = [groq, openai, ollama];
  const quality = router.route({ messages: hello, policy: router.normalizeRouting({ mode: "quality" }), usableProviders });
  assert.equal(quality.tier, "frontier");

  const balanced = router.route({ messages: hello, policy: router.normalizeRouting({ mode: "balanced" }), usableProviders: [groq] });
  assert.equal(balanced.model, "llama-3.1-8b-instant");
  assert.match(balanced.reason, /^Balanced: /);

  const budget = router.route({ messages: coding, policy: router.normalizeRouting({ mode: "budget" }), usableProviders: [groq, openai] });
  assert.ok(["strong", "frontier"].includes(budget.tier), `budget still meets a complex request (got ${budget.tier})`);
  assert.equal(budget.providerId, "groq");

  const privateRoute = router.route({ messages: coding, policy: router.normalizeRouting({ mode: "private" }), usableProviders });
  assert.equal(privateRoute.providerId, "ollama");
  assert.equal(privateRoute.local, true);
  assert.equal(privateRoute.privacy, "local-only");
  assert.ok(privateRoute.alternatives.every((choice) => choice.local), "private alternatives are self-hosted too");

  const custom = router.route({ messages: coding, policy: router.normalizeRouting({ mode: "custom", providers: ["groq"], maxTier: "efficient" }), usableProviders });
  assert.equal(custom.providerId, "groq");
  assert.ok(["small", "efficient"].includes(custom.tier));
});

test("private mode refuses when no self-hosted model exists", () => {
  assert.throws(() => router.route({ messages: hello, policy: router.normalizeRouting({ mode: "private" }), usableProviders: [groq, openai] }), { code: "no_private_route", status: 409 });
  assert.throws(() => router.route({ messages: hello, policy: router.normalizeRouting({ mode: "custom", providers: ["anthropic"] }), usableProviders: [groq] }), { code: "no_route" });
});

test("fastest uses measured latency, and failing providers are avoided", () => {
  for (let index = 0; index < 3; index += 1) {
    router.recordOutcome("groq", { ok: true, latencyMs: 2400 });
    router.recordOutcome("openai", { ok: true, latencyMs: 300 });
  }
  const fastest = router.route({ messages: hello, policy: router.normalizeRouting({ mode: "fastest" }), usableProviders: [groq, openai] });
  assert.equal(fastest.providerId, "openai");
  assert.match(fastest.reason, /fastest measured model/);

  router.resetStats();
  for (let index = 0; index < 3; index += 1) router.recordOutcome("groq", { ok: false, retryable: true });
  assert.equal(router.providerHealth("groq").healthy, false);
  const avoided = router.route({ messages: hello, policy: router.normalizeRouting({ mode: "balanced" }), usableProviders: [groq, openai], preferredProviderId: "groq" });
  assert.equal(avoided.providerId, "openai");
  router.recordOutcome("groq", { ok: true, latencyMs: 100 });
  assert.equal(router.providerHealth("groq").healthy, true);
});

test("estimates appear only for verified prices", () => {
  const cloud = router.route({ messages: hello, policy: router.normalizeRouting({ mode: "balanced" }), usableProviders: [groq] });
  assert.equal(cloud.estimate.usd, null);
  assert.equal(cloud.estimate.basis, "unverified");
  assert.ok(cloud.estimate.inputTokens > 0);
  const local = router.route({ messages: hello, policy: router.normalizeRouting({ mode: "private" }), usableProviders: [ollama] });
  assert.equal(local.estimate.usd, 0);
  assert.equal(local.estimate.basis, "local");

  const { verifiedPriceFor } = require("./cost-tracking");
  assert.equal(verifiedPriceFor("gpt-4o-mini"), null, "carried-over prices have no verification date");
});

test("self-hosted means a local runtime, a private address, or an operator declaration", () => {
  assert.equal(router.selfHosted(ollama), true);
  assert.equal(router.selfHosted(groq), false);
  assert.equal(router.selfHosted({ id: "custom", baseUrl: "http://192.168.1.20:8000/v1" }), true);
  assert.equal(router.selfHosted({ id: "custom", baseUrl: "https://inference.example.com/v1" }), false);
  process.env.HANNAH_SELF_HOSTED_PROVIDERS = "custom";
  assert.equal(router.selfHosted({ id: "custom", baseUrl: "https://inference.example.com/v1" }), true);
  delete process.env.HANNAH_SELF_HOSTED_PROVIDERS;
  assert.equal(router.privacyBlocks(router.normalizeRouting({ mode: "private" }), groq), true);
  assert.equal(router.privacyBlocks(router.normalizeRouting({ mode: "quality" }), groq), false);
});

// ---------------------------------------------------------------------------
// API

test("the route preview explains the choice without calling a model", async () => {
  const response = await post("/api/route/preview", { messages: hello, routing: { mode: "private" } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(["custom", "lmstudio"].includes(body.providerId));
  assert.equal(body.local, true);
  assert.equal(body.estimate.usd, 0);
  assert.equal(typeof body.reason, "string");
  assert.equal(requests.length, 0, "preview never contacts a provider");

  const quality = await (await post("/api/route/preview", { messages: coding, routing: { mode: "quality" } })).json();
  assert.equal(quality.providerId, "groq");
  assert.equal(quality.tier, "frontier");
  assert.equal(quality.estimate.usd, null);

  assert.equal((await post("/api/route/preview", { messages: hello, routing: { mode: "nope" } })).status, 400);
  assert.equal((await post("/api/route/preview", { messages: [] })).status, 400);
});

test("private mode never sends a pinned request to a hosted provider", async () => {
  const response = await post("/api/agent", { mode: "cloud", provider: "groq", model: "llama-3.1-8b-instant", messages: hello, tools: noteTool, routing: { mode: "private" } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "privacy_blocked");
  assert.equal(requests.length, 0);
});

test("routed requests fall back to the next allowed provider on a retryable failure", async () => {
  const response = await post("/api/agent", { mode: "cloud", provider: "custom", model: "auto", messages: hello, tools: noteTool, routing: { mode: "custom", providers: ["custom", "lmstudio"] } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.providerId, "lmstudio");
  assert.match(body.message.content, /from local-model/);
  assert.deepEqual(body.routing.fellBackFrom, [{ providerId: "custom", model: "fail-model", code: "unavailable" }]);
  assert.deepEqual(requests.filter((request) => request.path.endsWith("/chat/completions")).map((request) => request.model), ["fail-model", "local-model"]);
  assert.equal(body.routing.mode, "custom");
});

test("a visitor with only a Groq key gets a clear answer in private mode", async () => {
  const visitor = { "Content-Type": "application/json", "X-Groq-API-Key": "gsk_routerVisitorKey0123456789abcdefghijkl" };
  const response = await post("/api/route/preview", { messages: hello, routing: { mode: "private" } }, visitor);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "no_private_route");
  const balanced = await (await post("/api/route/preview", { messages: hello, routing: { mode: "balanced" } }, visitor)).json();
  assert.equal(balanced.providerId, "groq", "a visitor's key is only ever used with Groq");
});

test("/v1 accepts a routing policy for hannah-auto and enforces privacy", async () => {
  const routed = await post("/v1/chat/completions", { model: "hannah-auto", messages: hello, hannah: { routing: { mode: "custom", providers: ["lmstudio"] } } });
  assert.equal(routed.status, 200);
  const body = await routed.json();
  assert.equal(body.model, "lmstudio/local-model");
  assert.equal(body.hannah.routing.mode, "custom");

  const blocked = await post("/v1/chat/completions", { model: "groq/llama-3.1-8b-instant", messages: hello, hannah: { routing: { mode: "private" } } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, "privacy_blocked");
});
