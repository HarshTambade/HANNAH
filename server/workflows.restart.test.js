"use strict";

/**
 * Workflows survive the server process being killed.
 *
 * Starts the real server (`node index.js`) as a child process with a SQLite
 * account database on disk and the built-in worker, kills it with SIGKILL in
 * the middle of a run, starts it again on the same database, and checks that
 * the run finishes from its checkpoint:
 * - killed during an HTTP step: the lease expires, the run is recovered and
 *   finishes; the step that was in flight runs again (at-least-once, as
 *   documented), finished steps don't, and the notification is sent once;
 * - killed during a Wait: the wait continues after the restart.
 *
 * The workflow is the one from the milestone: Manual trigger → HTTP request →
 * Process JSON (Code) → If → Send notification → Create document (the run's
 * record). The HTTP target is a local server in this test (allowed with
 * WORKFLOW_ALLOW_PRIVATE_NETWORK, the self-hosting setting).
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const { once } = require("node:events");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, before, test } = require("node:test");

const dataDir = mkdtempSync(join(tmpdir(), "hannah-restart-"));
const port = 4100 + Math.floor(Math.random() * 800);
const api = `http://127.0.0.1:${port}/api`;
let server = null;
let log = "";
let target;
let targetUrl;
const hits = [];

function startServer() {
  server = spawn(process.execPath, ["index.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      HOST: "127.0.0.1",
      HANNAH_API_TOKEN: "",
      DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`,
      HANNAH_VAULT_KEY: "a".repeat(64),
      WORKFLOW_ALLOW_PRIVATE_NETWORK: "true",
      WORKFLOW_LEASE_MS: "5000",
      WORKFLOW_WORKER: "on",
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

let token = "";
async function call(method, path, body) {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "x-hannah-session": "bearer", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data };
}

const run = (id) => call("GET", `/workflows/executions/${id}`).then((result) => result.body);

function milestoneWorkflow(url) {
  const nodes = [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: { repo: "hannah/demo" } } },
    { id: "h", name: "Get stats", type: "action.http", params: { method: "GET", url, responseFormat: "json" } },
    { id: "p", name: "Process JSON", type: "data.code", params: { mode: "all", code: "return items.map((item) => ({ repo: item.body.name, stars: item.body.stars, popular: item.body.stars > 1000 }));" } },
    { id: "i", name: "Popular?", type: "logic.if", params: { conditions: [{ left: "{{ $json.popular }}", operator: "isTrue", right: "" }] } },
    { id: "n", name: "Tell me", type: "action.notify", params: { title: "{{ $json.repo }} is popular", body: "{{ $json.stars }} stars" } },
    { id: "r", name: "Save execution record", type: "action.report", params: { format: "markdown", title: "Run record", template: "- {{ $json.repo }}: {{ $json.stars }} stars" } },
  ].map((node, index) => ({ ...node, position: { x: 80 + index * 260, y: 160 } }));
  const links = [["t", "h"], ["h", "p"], ["p", "i"], ["i", "n", "true"], ["n", "r"]];
  return { format: "hannah-workflow", version: 2, nodes, connections: links.map(([source, target, sourceOutput = "main"], index) => ({ id: `c${index}`, source, target, sourceOutput, targetInput: "main" })), settings: { timezone: "UTC" } };
}

before(async () => {
  target = http.createServer((req, res) => {
    hits.push(req.url);
    const reply = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: "hannah/demo", stars: 4321 })); };
    // The first call to /slow takes long enough to kill the server while it's in flight.
    if (req.url === "/slow" && hits.filter((url) => url === "/slow").length === 1) setTimeout(reply, 8000);
    else reply();
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  targetUrl = `http://127.0.0.1:${target.address().port}`;
  await startServer();
  const registered = await call("POST", "/account/register", { email: "restart@example.com", password: "correct horse battery staple" });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  token = registered.body.sessionToken;
});

after(async () => {
  if (server) await killServer();
  target?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the milestone workflow runs end to end on the real server and its record is kept", async () => {
  const created = await call("POST", "/workflows", { name: "Repo check", definition: milestoneWorkflow(`${targetUrl}/stats`) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await call("POST", `/workflows/${created.body.workflow.id}/run`, {});
  const done = await waitFor(async () => { const body = await run(started.body.executionId); return ["completed", "failed"].includes(body.execution.status) && body; }, 20_000, "the run");
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  const node = (id) => done.nodes.find((entry) => entry.nodeId === id);
  assert.deepEqual(node("p").output.main.items[0], { repo: "hannah/demo", stars: 4321, popular: true });
  assert.equal(node("i").output.true.count, 1);
  assert.equal(node("n").status, "done");
  assert.match(node("r").output.main.items[0].document.content, /hannah\/demo: 4321 stars/);
  const notifications = await call("GET", "/notifications");
  assert.ok(notifications.body.notifications.some((entry) => entry.title === "hannah/demo is popular"));
});

test("a run killed mid-step is recovered after the server restarts, without repeating finished steps", async () => {
  const created = await call("POST", "/workflows", { name: "Crash during HTTP", definition: milestoneWorkflow(`${targetUrl}/slow`) });
  const started = await call("POST", `/workflows/${created.body.workflow.id}/run`, {});
  const executionId = started.body.executionId;
  await waitFor(async () => (await run(executionId)).nodes.some((entry) => entry.nodeId === "h" && entry.status === "running"), 15_000, "the HTTP step to start");
  await killServer();
  assert.equal(hits.filter((url) => url === "/slow").length, 1);

  await startServer();
  const done = await waitFor(async () => { const body = await run(executionId); return ["completed", "failed"].includes(body.execution.status) && body; }, 40_000, "the recovered run");
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.recoveries, 1);
  assert.equal(hits.filter((url) => url === "/slow").length, 2, "the step that was in flight ran again (at-least-once)");
  const notifications = (await call("GET", "/notifications")).body.notifications.filter((entry) => entry.title === "hannah/demo is popular");
  assert.equal(notifications.length, 2, "one from the first test's run, one from this run: the notification wasn't sent twice");
});

test("a run waiting at a Wait step continues after the server restarts", async () => {
  const definition = milestoneWorkflow(`${targetUrl}/stats`);
  definition.nodes.splice(1, 0, { id: "w", name: "Wait a moment", type: "logic.wait", params: { mode: "duration", amount: 4, unit: "seconds" }, position: { x: 0, y: 0 } });
  definition.connections = definition.connections.filter((connection) => connection.source !== "t");
  definition.connections.push({ id: "cw1", source: "t", target: "w", sourceOutput: "main", targetInput: "main" }, { id: "cw2", source: "w", target: "h", sourceOutput: "main", targetInput: "main" });
  const created = await call("POST", "/workflows", { name: "Wait across restart", definition });
  const started = await call("POST", `/workflows/${created.body.workflow.id}/run`, {});
  const executionId = started.body.executionId;
  await waitFor(async () => (await run(executionId)).execution.status === "waiting", 15_000, "the wait");
  await killServer();
  await startServer();
  const done = await waitFor(async () => { const body = await run(executionId); return ["completed", "failed"].includes(body.execution.status) && body; }, 30_000, "the run after the wait");
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.nodes.find((entry) => entry.nodeId === "w").status, "done");
  assert.equal(done.execution.recoveries, 0, "a wait isn't a crash");
});
