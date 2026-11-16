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

test("production refuses to load without a valid API token", () => {
  for (const apiToken of ["", "too-short"]) {
    const result = spawnSync(process.execPath, ["-e", "require('./index')"], {
      cwd: __dirname,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", HANNAH_API_TOKEN: apiToken },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HANNAH_API_TOKEN/);
  }
});

test("production accepts the legacy SHANAYA_API_TOKEN name", () => {
  const env = { ...process.env, NODE_ENV: "production", SHANAYA_API_TOKEN: "legacy-token-for-shanaya-deployments-0123456789" };
  delete env.HANNAH_API_TOKEN;
  const result = spawnSync(process.execPath, ["-e", "require('./index')"], { cwd: __dirname, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
});
