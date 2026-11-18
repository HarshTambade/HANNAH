"use strict";

/**
 * Workflows on serverless hosting (Vercel), where nothing runs in the background.
 *
 * Starts the real server (`node index.js`) the way Vercel runs it: VERCEL set,
 * no worker, a SQLite account database on disk, CRON_SECRET for
 * /api/workflows/tick, and short request budgets (WORKFLOW_REQUEST_BUDGET_MS,
 * WORKFLOW_TICK_BUDGET_MS) so the limits are reached in a few seconds. Then:
 * - a run longer than one request is handed back between steps (queued, with
 *   its checkpoint) instead of being cut off mid-step, nothing moves it until
 *   a tick, and the tick finishes it without repeating steps or counting a crash;
 * - the tick refuses requests without the secret;
 * - opening the run (what the run page does while you watch) keeps it going;
 * - a webhook starts a run in its own request and the tick finishes it;
 * - a due schedule fires from the tick;
 * - a failing step is retried and reported with its attempts;
 * - a function stopped mid-step (Vercel's time limit) is recovered by a later tick.
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const http = require("node:http");
const { once } = require("node:events");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { after, before, test } = require("node:test");

const dataDir = mkdtempSync(join(tmpdir(), "hannah-serverless-"));
const dbFile = join(dataDir, "hannah.db");
const port = 4950 + Math.floor(Math.random() * 40);
const api = `http://127.0.0.1:${port}/api`;
const CRON_SECRET = "serverless-test-cron-secret-0123";
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
      DATABASE_URL: `sqlite:${dbFile}`,
      HANNAH_VAULT_KEY: "c".repeat(64),
      VERCEL: "1",
      WORKFLOW_WORKER: "off",
      CRON_SECRET,
      WORKFLOW_REQUEST_BUDGET_MS: "1000",
      WORKFLOW_TICK_BUDGET_MS: "1000",
      WORKFLOW_LEASE_MS: "5000",
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await pause(200);
  }
  throw new Error(`Timed out waiting for ${what}.\n${log.slice(-3000)}`);
}

let token = "";
async function call(method, path, body, headers = {}) {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "x-hannah-session": "bearer", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data };
}
// Opening a run (GET /executions/:id) also runs a queued one's next steps on serverless, like the run page
// does while you watch; `listed` reads a run from the list, which doesn't.
const detail = (id) => call("GET", `/workflows/executions/${id}`).then((result) => result.body);
const listed = async (id) => (await call("GET", "/workflows/executions?limit=50")).body.executions.find((entry) => entry.id === id);
const tick = (secret = CRON_SECRET) => fetch(`${api}/workflows/tick`, { method: "POST", headers: secret ? { Authorization: `Bearer ${secret}` } : {} }).then(async (response) => ({ status: response.status, body: await response.json() }));
const FINAL = ["completed", "failed", "cancelled", "timed-out"];
/** What a cron does: call the tick until the run is finished (only the tick moves it). */
async function tickUntilDone(id, ticks = 15) {
  for (let count = 0; count < ticks; count += 1) {
    if (FINAL.includes((await listed(id)).status)) return detail(id);
    assert.equal((await tick()).status, 200);
  }
  throw new Error(`Run ${id} didn't finish after ${ticks} ticks: ${JSON.stringify(await listed(id))}`);
}
const step = (body, id) => body.nodes.find((entry) => entry.nodeId === id);

const link = (source, target, sourceOutput = "main") => ({ id: `${source}-${target}-${sourceOutput}`, source, target, sourceOutput, targetInput: "main" });
/** The milestone workflow: trigger → HTTP request → Process JSON → If → Send notification → Create document. */
function milestone(url, { trigger = { type: "trigger.manual", params: {} }, httpSettings } = {}) {
  const nodes = [
    { id: "t", name: "Start", ...trigger },
    { id: "h", name: "Get stats", type: "action.http", params: { method: "GET", url, responseFormat: "json" }, ...(httpSettings ? { settings: httpSettings } : {}) },
    { id: "p", name: "Process JSON", type: "data.code", params: { mode: "all", code: "return items.map((item) => ({ repo: item.body.name, stars: item.body.stars, popular: item.body.stars > 1000 }));" } },
    { id: "i", name: "Popular?", type: "logic.if", params: { conditions: [{ left: "{{ $json.popular }}", operator: "isTrue", right: "" }] } },
    { id: "n", name: "Tell me", type: "action.notify", params: { title: "{{ $json.repo }} is popular", body: "run {{ $execution.id }}" } },
    { id: "r", name: "Save execution record", type: "action.report", params: { format: "markdown", title: "Run record", template: "- {{ $json.repo }}: {{ $json.stars }} stars" } },
  ].map((node, index) => ({ ...node, position: { x: 80 + index * 260, y: 160 } }));
  return { format: "hannah-workflow", version: 2, nodes, connections: [link("t", "h"), link("h", "p"), link("p", "i"), link("i", "n", "true"), link("n", "r")], settings: { timezone: "UTC" } };
}
async function create(name, definition) {
  const created = await call("POST", "/workflows", { name, definition });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.workflow.id;
}
async function notificationsFor(executionId) {
  return (await call("GET", "/notifications")).body.notifications.filter((entry) => entry.body === `run ${executionId}`);
}

before(async () => {
  target = http.createServer((req, res) => {
    const url = new URL(req.url, "http://target");
    hits.push(url.pathname + url.search);
    if (url.pathname === "/fail") { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "busy" })); return; }
    const reply = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ name: `hannah/${url.searchParams.get("name") || "demo"}`, stars: 4321 })); };
    const ms = Number(url.searchParams.get("ms")) || 0;
    if (ms) setTimeout(reply, ms);
    else reply();
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  targetUrl = `http://127.0.0.1:${target.address().port}`;
  await startServer();
  const registered = await call("POST", "/account/register", { email: "serverless@example.com", password: "correct horse battery staple" });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  token = registered.body.sessionToken;
});

after(async () => {
  if (server) await killServer();
  target?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a run longer than one request is handed back between steps, and the cron tick finishes it", async () => {
  const id = await create("Longer than a request", milestone(`${targetUrl}/stats?name=long&ms=1500`));
  const startedAt = Date.now();
  const run = await call("POST", `/workflows/${id}/run`, {});
  const tookMs = Date.now() - startedAt;
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const executionId = run.body.executionId;

  // The request ran the steps it had time for and answered; it didn't wait for the whole run.
  const handedBack = await listed(executionId);
  assert.equal(handedBack.status, "queued", JSON.stringify(handedBack));
  assert.deepEqual([handedBack.nodes.done, handedBack.nodes.total], [2, 2], "the trigger and the HTTP step are done; the step after the budget hasn't started");
  assert.ok(tookMs < 4_000, `the Run request took ${tookMs} ms`);
  assert.equal(handedBack.recoveries, 0);

  // Nothing runs in the background on serverless hosting.
  await pause(2_000);
  assert.deepEqual([(await listed(executionId)).status, (await listed(executionId)).nodes.total], ["queued", 2]);

  // The cron's tick needs the secret.
  assert.equal((await tick("")).status, 401);
  assert.equal((await tick("x".repeat(CRON_SECRET.length))).status, 401);

  const done = await tickUntilDone(executionId);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.recoveries, 0, "handing back isn't a crash");
  assert.deepEqual(step(done, "p").output.main.items[0], { repo: "hannah/long", stars: 4321, popular: true });
  assert.equal(step(done, "i").output.true.count, 1);
  assert.match(step(done, "r").output.main.items[0].document.content, /hannah\/long: 4321 stars/);
  assert.equal(hits.filter((hit) => hit.includes("name=long")).length, 1, "the HTTP step ran once");
  assert.equal((await notificationsFor(executionId)).length, 1, "one notification");
});

test("opening the run keeps a handed-back run going while you watch, without a cron", async () => {
  const id = await create("Watched", milestone(`${targetUrl}/stats?name=watched&ms=1500`));
  const { executionId } = (await call("POST", `/workflows/${id}/run`, {})).body;
  assert.equal((await listed(executionId)).status, "queued", "handed back after the Run request's budget");
  // The run page polls the run; each poll of a queued run runs its next steps.
  const done = await waitFor(async () => { const body = await detail(executionId); return FINAL.includes(body.execution.status) && body; }, 20_000, "the watched run");
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal((await notificationsFor(executionId)).length, 1);
});

test("a webhook starts a run in its own request, and the tick finishes it", async () => {
  const id = await create("Webhook", milestone(`${targetUrl}/stats?name=hook&ms=1500`, { trigger: { type: "trigger.webhook", params: { method: "POST", auth: "token" } } }));
  const published = await call("POST", `/workflows/${id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const activated = await call("POST", `/workflows/${id}/activate`, { approvedPermissions: published.body.permissions });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const [{ secret }] = [...published.body.webhookSecrets, ...(activated.body.webhookSecrets || [])];
  const hook = activated.body.webhooks[0].url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);
  assert.equal((await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401, "no token");
  const accepted = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "X-Hannah-Token": secret }, body: JSON.stringify({ hello: "world" }) });
  assert.equal(accepted.status, 202);
  const { executionId } = await accepted.json();
  const done = await tickUntilDone(executionId);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.mode, "webhook");
});

test("a due schedule fires from the tick and runs to the end", async () => {
  const id = await create("Scheduled", milestone(`${targetUrl}/stats?name=scheduled`, { trigger: { type: "trigger.schedule", params: { mode: "daily", time: "07:30" } } }));
  const published = await call("POST", `/workflows/${id}/publish`);
  assert.equal((await call("POST", `/workflows/${id}/activate`, { approvedPermissions: published.body.permissions })).status, 200);
  // Make the schedule due now (it's next due at 07:30).
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("UPDATE hannah_workflow_triggers SET next_run_at = ? WHERE workflow_id = ? AND kind = 'schedule'").run(Date.now() - 1000, id);
  db.close();
  const report = await tick();
  assert.equal(report.status, 200);
  assert.equal(report.body.scheduled, 1, JSON.stringify(report.body));
  const runs = (await call("GET", `/workflows/executions?workflowId=${id}`)).body.executions;
  assert.equal(runs.length, 1);
  const done = await tickUntilDone(runs[0].id);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.mode, "schedule");
});

test("a failing step is retried and the run fails with its attempts counted", async () => {
  const id = await create("Failing", milestone(`${targetUrl}/fail`, { httpSettings: { retries: 2, retryDelayMs: 1000 } }));
  const { executionId } = (await call("POST", `/workflows/${id}/run`, {})).body;
  const done = await tickUntilDone(executionId);
  assert.equal(done.execution.status, "failed");
  assert.equal(done.execution.errorNode, "h");
  assert.match(done.execution.error, /503/);
  assert.match(done.execution.error, /after 3 attempts/);
  assert.equal(step(done, "n"), undefined, "nothing after the failed step ran");
});

test("a function stopped mid-step (the hosting's time limit) is recovered by a later tick", async () => {
  const id = await create("Stopped mid-step", milestone(`${targetUrl}/stats?name=stopped&ms=6000`));
  // Vercel stops the function while the HTTP step is in flight: here, the process is killed.
  const running = call("POST", `/workflows/${id}/run`, {}).catch(() => null);
  const executionId = await waitFor(async () => {
    return (await call("GET", `/workflows/executions?workflowId=${id}`)).body.executions?.[0]?.id;
  }, 10_000, "the run to start");
  await waitFor(async () => step(await detail(executionId), "h")?.status === "running", 10_000, "the HTTP step to start");
  await killServer();
  await running;
  await startServer();
  assert.equal((await listed(executionId)).status, "running", "until its lease expires");
  await pause(5_500);
  const done = await tickUntilDone(executionId);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.recoveries, 1);
  assert.equal((await notificationsFor(executionId)).length, 1);
});
