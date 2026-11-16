const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "production";
process.env.HANNAH_API_TOKEN = "test-token-for-hannah-api-access-0123456789";
process.env.HANNAH_RATE_LIMIT_CHAT_MAX = "2";
process.env.HANNAH_RATE_LIMIT_AGENT_MAX = "1";
process.env.HANNAH_RATE_LIMIT_DESKTOP_MAX = "1";
process.env.HANNAH_RATE_LIMIT_WINDOW_MS = "60000";

const app = require("./index");
const token = process.env.HANNAH_API_TOKEN;
let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  if (!server) return;
  server.close();
  await once(server, "close");
});

test("health remains available without a bearer token", async () => {
  const response = await fetch(baseUrl + "/api/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("all API paths except health reject unauthenticated requests", async () => {
  const cases = [
    ["GET", "/api/providers"],
    ["GET", "/api/models"],
    ["GET", "/api/pinecall/token"],
    ["POST", "/api/agent"],
    ["POST", "/api/tts"],
    ["POST", "/api/desktop/computer"],
    ["POST", "/api/chat"],
    ["POST", "/api/feedback"],
    ["POST", "/api/report-content"],
    ["GET", "/api/health/agent"],
    ["GET", "/api/not-a-route"],
  ];
  for (const [method, path] of cases) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(response.status, 401, method + " " + path);
  }
});

test("a valid bearer token can call protected endpoints", async () => {
  const response = await fetch(baseUrl + "/api/providers", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray((await response.json()).providers));
});

test("content reporting is authenticated and validates metadata-only bodies", async () => {
  const response = await fetch(baseUrl + "/api/report-content", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messageId: "short", reason: "other" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /message id/i);
});

test("an incorrect bearer token is rejected", async () => {
  const response = await fetch(baseUrl + "/api/providers", {
    headers: { Authorization: "Bearer an-incorrect-token-value-that-is-long-enough" },
  });
  assert.equal(response.status, 401);
});

test("chat requests are rate limited per bearer token", async () => {
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(baseUrl + "/api/chat", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 400);
  }

  const limited = await fetch(baseUrl + "/api/chat", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("agent and desktop routes have independent token rate limits", async () => {
  const agentRequest = () => fetch(baseUrl + "/api/agent", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal((await agentRequest()).status, 400);
  assert.equal((await agentRequest()).status, 429);

  const desktopRequest = () => fetch(baseUrl + "/api/desktop/computer", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [] }),
  });
  assert.notEqual((await desktopRequest()).status, 429);
  assert.equal((await desktopRequest()).status, 429);
});

test("production refuses to load with a weak API token", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./index')"], {
    cwd: __dirname,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", HANNAH_API_TOKEN: "too-short" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HANNAH_API_TOKEN/);
});

test("production without a token starts in bring-your-own-key mode", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./index')"], {
    cwd: __dirname,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", HANNAH_API_TOKEN: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /own Groq key/);
});

const visitorKey = "gsk_" + "a".repeat(48);

test("a visitor Groq key opens the chat routes and only lists Groq", async () => {
  const response = await fetch(baseUrl + "/api/providers", { headers: { "X-Groq-API-Key": visitorKey } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.byok, true);
  assert.deepEqual(body.providers.map((provider) => provider.id), ["groq"]);
});

test("a visitor Groq key cannot reach operator-only routes", async () => {
  const cases = [
    ["GET", "/api/pinecall/token"],
    ["POST", "/api/tts"],
    ["POST", "/api/desktop/computer"],
    ["POST", "/api/feedback"],
    ["POST", "/api/report-content"],
    ["POST", "/api/events"],
    ["GET", "/api/sync/memory"],
    ["GET", "/api/health/agent"],
  ];
  for (const [method, path] of cases) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { "X-Groq-API-Key": visitorKey, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(response.status, 401, method + " " + path);
  }
});

test("a visitor Groq key cannot borrow another provider's server key", async () => {
  const response = await fetch(baseUrl + "/api/models?provider=openai", { headers: { "X-Groq-API-Key": visitorKey } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /official Groq API/);
});

test("a value that is not a Groq key does not authenticate", async () => {
  for (const key of ["not-a-groq-key-but-long-enough-to-try", "gsk_short", "gsk_" + "a".repeat(30) + " x"]) {
    const response = await fetch(baseUrl + "/api/providers", { headers: { "X-Groq-API-Key": key } });
    assert.equal(response.status, 401, key);
  }
});

test("visitor keys are rate limited separately from the operator token", async () => {
  const agentRequest = () => fetch(baseUrl + "/api/agent", {
    method: "POST",
    headers: { "X-Groq-API-Key": visitorKey, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal((await agentRequest()).status, 400);
  assert.equal((await agentRequest()).status, 429);
});

test("production accepts the legacy SHANAYA_API_TOKEN name", () => {
  const env = { ...process.env, NODE_ENV: "production", SHANAYA_API_TOKEN: "legacy-token-for-shanaya-deployments-0123456789" };
  delete env.HANNAH_API_TOKEN;
  const result = spawnSync(process.execPath, ["-e", "require('./index')"], { cwd: __dirname, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
});

test("the model catalog lists capabilities and prices without credentials", async () => {
  const response = await fetch(baseUrl + "/api/catalog", { headers: { Authorization: "Bearer " + token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  const text = JSON.stringify(body);
  assert.ok(!/api[_-]?key|gsk_|sk-/i.test(text.replace(/"docs":"[^"]*"/g, "")), "catalog must not contain credentials");
  const groq = body.providers.find((provider) => provider.id === "groq");
  assert.ok(groq.models.some((model) => model.tools === true && typeof model.context === "number"));
  const openai = body.providers.find((provider) => provider.id === "openai");
  const mini = openai.models.find((model) => model.id === "gpt-4o-mini");
  assert.deepEqual(mini.price, { inputPerMTok: 0.15, outputPerMTok: 0.6, currency: "USD" });
});

test("a visitor key sees only Groq in the model catalog", async () => {
  const response = await fetch(baseUrl + "/api/catalog", { headers: { "X-Groq-API-Key": visitorKey } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.byok, true);
  assert.deepEqual(body.providers.map((provider) => provider.id), ["groq"]);
});
