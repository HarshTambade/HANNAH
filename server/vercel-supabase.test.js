"use strict";

/**
 * A HANNAH deployment where the only setup was connecting Supabase in Vercel.
 *
 * Starts the real server with just what Vercel's Supabase integration adds:
 * POSTGRES_URL and SUPABASE_JWT_SECRET. No DATABASE_URL and no
 * HANNAH_VAULT_KEY. Accounts must turn on, a saved credential must be
 * encrypted and usable by a workflow, and it must still decrypt after a
 * restart (the derived key is stable).
 *
 * POSTGRES_URL points at a SQLite file here, because no Postgres server is
 * available in tests. The Postgres dialect is covered by the pglite suites,
 * and TLS to a real Supabase pooler by db.connection.test.js (HANNAH_LIVE_TESTS=1).
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const { once } = require("node:events");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = mkdtempSync(join(tmpdir(), "hannah-vercel-supabase-"));
const port = 5000 + Math.floor(Math.random() * 80);
const api = `http://127.0.0.1:${port}/api`;
let server = null;
let log = "";
let token = "";
let target;
let targetUrl;
const seen = [];

function startServer() {
  server = spawn(process.execPath, ["index.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      HOST: "127.0.0.1",
      HANNAH_API_TOKEN: "",
      // Only what the integration adds; blank values keep server/.env from filling them in.
      DATABASE_URL: "",
      HANNAH_VAULT_KEY: "",
      HANNAH_VAULT_PREVIOUS_KEYS: "",
      POSTGRES_URL: `sqlite:${join(dataDir, "hannah.db")}`,
      SUPABASE_JWT_SECRET: "vercel-integration-jwt-secret-0123456789abcdef",
      SUPABASE_SECRET_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      VERCEL: "1",
      WORKFLOW_WORKER: "off",
      WORKFLOW_ALLOW_PRIVATE_NETWORK: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { log += chunk; });
  server.stderr.on("data", (chunk) => { log += chunk; });
  return waitFor(async () => (await fetch(`${api}/health`).catch(() => null))?.ok, 15_000, "the server to start");
}
async function killServer() {
  const exited = once(server, "exit");
  server.kill("SIGKILL");
  await exited;
  server = null;
}
async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}.\n${log.slice(-3000)}`);
}
async function call(method, path, body) {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "x-hannah-session": "bearer", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data };
}

before(async () => {
  target = http.createServer((req, res) => {
    seen.push(req.headers.authorization || null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{\"ok\":true}");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  targetUrl = `http://127.0.0.1:${target.address().port}/check`;
  await startServer();
});
after(async () => {
  if (server) await killServer();
  target?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function runWithCredential(credentialId) {
  const definition = {
    format: "hannah-workflow", version: 2, settings: { timezone: "UTC" },
    nodes: [
      { id: "t", name: "Start", type: "trigger.manual", params: {}, position: { x: 0, y: 0 } },
      { id: "h", name: "Call", type: "action.http", params: { method: "GET", url: targetUrl, responseFormat: "json" }, credentialId, position: { x: 260, y: 0 } },
    ],
    connections: [{ id: "c", source: "t", target: "h", sourceOutput: "main", targetInput: "main" }],
  };
  const created = await call("POST", "/workflows", { name: `Uses a credential ${Date.now()}`, definition });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { executionId } = (await call("POST", `/workflows/${created.body.workflow.id}/run`, {})).body;
  return waitFor(async () => { const body = (await call("GET", `/workflows/executions/${executionId}`)).body; return ["completed", "failed"].includes(body.execution.status) && body; }, 15_000, "the run");
}

test("with only Vercel's Supabase variables, accounts and encrypted key storage turn on by themselves", async () => {
  const status = await call("GET", "/account/status");
  assert.equal(status.body.accounts.enabled, true, JSON.stringify(status.body));
  assert.equal(status.body.database.source, "POSTGRES_URL");
  assert.equal(status.body.vault, true);
  assert.equal(status.body.vaultSource, "SUPABASE_JWT_SECRET");
  assert.doesNotMatch(JSON.stringify(status.body), /vercel-integration-jwt-secret|hannah\.db/, "names only, never values");

  const registered = await call("POST", "/account/register", { email: "owner@example.com", password: "correct horse battery staple" });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  token = registered.body.sessionToken;

  const saved = await call("POST", "/workflows/credentials", { name: "Service token", type: "bearer", data: { token: "tok_live_123456" } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const done = await runWithCredential(saved.body.credential.id);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(seen.at(-1), "Bearer tok_live_123456", "the workflow decrypted and sent the credential");

  // After a restart (a new deployment, a cold start), the same secret derives the same key.
  await killServer();
  await startServer();
  const again = await runWithCredential(saved.body.credential.id);
  assert.equal(again.execution.status, "completed", JSON.stringify(again.execution));
  assert.equal(seen.at(-1), "Bearer tok_live_123456");
});
