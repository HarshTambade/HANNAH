#!/usr/bin/env node
/**
 * Workflow triggers proof, run the way Vercel runs HANNAH.
 *
 *   node server/scripts/triggers-proof.mjs
 *
 * Starts the real server (node server/index.js) in serverless mode: VERCEL=1,
 * no background worker (WORKFLOW_WORKER=off), so nothing runs unless a request
 * or the authenticated cron tick drives it, as in production. Fresh SQLite
 * account database, real network calls. Checks:
 *   1. tick: /api/workflows/tick refuses a missing or wrong CRON_SECRET and accepts the right one;
 *   2. webhook (token): a wrong token is refused; the right one starts a run whose
 *      body reaches the next steps; a repeated delivery id is not run twice;
 *   3. webhook (HMAC): a bad or stale signature is refused; a correct one runs;
 *   4. event: POST /workflows/events starts the workflow listening for it;
 *   5. credential: a saved bearer token is sent to a real service (httpbin.org/bearer, which
 *      echoes it back) but never returned by the API, and no database row has it in the clear
 *      once the run has completed;
 *   6. schedule: a cron trigger set for the next minute fires from the tick alone;
 *   7. history: every run above is listed with the trigger that started it.
 * Takes about two minutes (the schedule). Exits non-zero if any check fails.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "hannah-triggers-"));
const port = 4990 + Math.floor(Math.random() * 9);
const origin = `http://127.0.0.1:${port}`;
const api = `${origin}/api`;
const CRON_SECRET = "triggers-proof-cron-secret-0123456789";
const BEARER = "proof-bearer-7f3c9a1e5b2d4f60";
let server = null;
let log = "";
let token = "";
const results = [];

function start() {
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", VERCEL: "1", WORKFLOW_WORKER: "off", CRON_SECRET, PORT: String(port), HOST: "127.0.0.1", HANNAH_API_TOKEN: "", HANNAH_PUBLIC_URL: origin, DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`, HANNAH_VAULT_KEY: "c".repeat(64) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { log += chunk; });
  server.stderr.on("data", (chunk) => { log += chunk; });
  return waitFor(async () => (await fetch(`${api}/health`).catch(() => null))?.ok, 20_000, "the server to start");
}
async function stop() {
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}.\n${log.slice(-2000)}`);
}
async function call(method, path, body, headers = {}) {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "x-hannah-session": "bearer", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
}
const tick = (secret = CRON_SECRET) => fetch(`${api}/workflows/tick`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
const detail = async (id) => (await call("GET", `/workflows/executions/${id}`)).body;
/** Drive a run with ticks only, as the scheduler does on Vercel. */
const finished = (id, ms = 60_000) => waitFor(async () => { await tick(); const body = await detail(id); return ["completed", "failed", "cancelled", "timed-out"].includes(body.execution?.status) && body; }, ms, `run ${id}`);
const step = (body, id) => body.nodes.find((node) => node.nodeId === id);
function check(name, ok, evidence) {
  results.push({ name, ok: Boolean(ok), evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${evidence}`);
}

const link = (source, target) => ({ id: `${source}-${target}`, source, target, sourceOutput: "main", targetInput: "main" });
function flow(trigger, rest) {
  const nodes = [trigger, ...rest].map((node, index) => ({ ...node, position: { x: 80 + index * 260, y: 160 } }));
  return { format: "hannah-workflow", version: 2, nodes, connections: nodes.slice(1).map((node, index) => link(nodes[index].id, node.id)), settings: { timezone: "UTC" } };
}
const echo = (expression) => ({ id: "s", name: "Keep", type: "data.set", params: { fields: [{ name: "got", value: expression }], keepOnlySet: true } });
/** Create, publish and activate (approving exactly the permissions shown), as the editor does. */
async function activate(name, definition) {
  const created = await call("POST", "/workflows", { name, definition });
  if (created.status !== 201) throw new Error(`Creating “${name}”: ${JSON.stringify(created.body)}`);
  const id = created.body.workflow.id;
  const published = await call("POST", `/workflows/${id}/publish`);
  if (published.status !== 200) throw new Error(`Publishing “${name}”: ${JSON.stringify(published.body)}`);
  const activated = await call("POST", `/workflows/${id}/activate`, { approvedPermissions: published.body.permissions });
  if (activated.status !== 200) throw new Error(`Activating “${name}”: ${JSON.stringify(activated.body)}`);
  return { id, ...activated.body, webhookSecrets: [...(published.body.webhookSecrets || []), ...(activated.body.webhookSecrets || [])] };
}
const hookPath = (url) => new URL(url).pathname.replace(/^\/api/, "");

try {
  await start();
  token = (await call("POST", "/account/register", { email: `triggers-${Date.now()}@example.com`, password: "correct horse battery staple" })).body.sessionToken;
  const runs = {};

  // 1. The cron tick needs CRON_SECRET.
  const [none, wrong, right] = [await tick(""), await tick("x".repeat(CRON_SECRET.length)), await tick()];
  check("tick: refuses a missing or wrong CRON_SECRET, accepts the right one", none.status === 401 && wrong.status === 401 && right.status === 200, `no secret ${none.status}, wrong ${wrong.status}, right ${right.status} ${JSON.stringify(right.body)}`);

  // 2. Webhook with a secret token.
  const tokenHook = await activate("Token webhook", flow({ id: "t", name: "Webhook", type: "trigger.webhook", params: { method: "POST", auth: "token" } }, [echo("{{ $json.body.order }}")]));
  const tokenUrl = hookPath(tokenHook.webhooks[0].url);
  const tokenSecret = tokenHook.webhookSecrets[0]?.secret;
  const refused = await call("POST", tokenUrl, { order: "A-1" }, { Authorization: "", "x-hannah-token": "not-the-secret" });
  const accepted = await call("POST", tokenUrl, { order: "A-42" }, { Authorization: "", "x-hannah-token": tokenSecret, "x-hannah-delivery": "delivery-1" });
  const repeated = await call("POST", tokenUrl, { order: "A-42" }, { Authorization: "", "x-hannah-token": tokenSecret, "x-hannah-delivery": "delivery-1" });
  runs.webhook = accepted.body.executionId;
  const hooked = runs.webhook ? await finished(runs.webhook) : null;
  check("webhook (token): wrong token refused, right token runs with the body, a repeated delivery isn't run twice",
    refused.status === 401 && accepted.status === 202 && hooked?.execution.status === "completed" && step(hooked, "s")?.output?.main?.items?.[0]?.got === "A-42" && repeated.body.duplicate === true,
    `wrong ${refused.status}; right ${accepted.status} → ${hooked?.execution.status}, got ${JSON.stringify(step(hooked || { nodes: [] }, "s")?.output?.main?.items?.[0])}; repeat ${repeated.status} ${JSON.stringify(repeated.body)}`);

  // 3. Webhook with an HMAC signature.
  const hmacHook = await activate("Signed webhook", flow({ id: "t", name: "Webhook", type: "trigger.webhook", params: { method: "POST", auth: "hmac" } }, [echo("{{ $json.body.event }}")]));
  const hmacUrl = hookPath(hmacHook.webhooks[0].url);
  const hmacSecret = hmacHook.webhookSecrets[0]?.secret;
  const sign = (timestamp, raw) => `sha256=${createHmac("sha256", hmacSecret).update(`${timestamp}.`).update(raw).digest("hex")}`;
  const raw = JSON.stringify({ event: "invoice.paid" });
  const now = Math.floor(Date.now() / 1000);
  const badSig = await call("POST", hmacUrl, raw, { Authorization: "", "x-hannah-timestamp": String(now), "x-hannah-signature": sign(now, `${raw} `) });
  const stale = await call("POST", hmacUrl, raw, { Authorization: "", "x-hannah-timestamp": String(now - 600), "x-hannah-signature": sign(now - 600, raw) });
  const signed = await call("POST", hmacUrl, raw, { Authorization: "", "x-hannah-timestamp": String(now), "x-hannah-signature": sign(now, raw) });
  runs.hmac = signed.body.executionId;
  const signedRun = runs.hmac ? await finished(runs.hmac) : null;
  check("webhook (HMAC): a tampered body and a 10-minute-old signature are refused; a correct signature runs",
    badSig.status === 401 && stale.status === 401 && signed.status === 202 && signedRun?.execution.status === "completed" && step(signedRun, "s")?.output?.main?.items?.[0]?.got === "invoice.paid",
    `tampered ${badSig.status}, stale ${stale.status}, signed ${signed.status} → ${signedRun?.execution.status}`);

  // 4. A custom HANNAH event.
  const onEvent = await activate("On event", flow({ id: "t", name: "Event", type: "trigger.event", params: { event: "custom", customName: "proof.ping" } }, [echo("{{ $json.data.n }}")]));
  const emitted = await call("POST", "/workflows/events", { name: "proof.ping", data: { n: 7 } });
  runs.event = (await call("GET", `/workflows/executions?workflowId=${onEvent.id}`)).body.executions?.[0]?.id;
  const eventRun = runs.event ? await finished(runs.event) : null;
  check("event: POST /workflows/events starts the workflow listening for it", emitted.status === 202 && emitted.body.started === 1 && eventRun?.execution.status === "completed" && String(step(eventRun, "s")?.output?.main?.items?.[0]?.got) === "7",
    `emit ${emitted.status} ${JSON.stringify(emitted.body)} → ${eventRun?.execution.status}`);

  // 5. A stored credential is used, never shown.
  const saved = await call("POST", "/workflows/credentials", { name: "httpbin bearer", type: "bearer", data: { token: BEARER } });
  const credentialId = saved.body.credential?.id;
  const created = await call("POST", "/workflows", { name: "Uses a credential", definition: flow({ id: "t", name: "Start", type: "trigger.manual", params: {} }, [{ id: "h", name: "HTTP", type: "action.http", credentialId, params: { method: "GET", url: "https://httpbin.org/bearer", responseFormat: "json" } }]) });
  const started = await call("POST", `/workflows/${created.body.workflow?.id}/run`, {});
  runs.credential = started.body.executionId;
  const credRun = runs.credential ? await finished(runs.credential) : null;
  const listed = await call("GET", "/workflows/credentials");
  // Every row of every table, as the database returns it (not free pages in the file).
  const sqlite = new DatabaseSync(join(dataDir, "hannah.db"), { readOnly: true });
  const rowsWith = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().filter(({ name }) => JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all()).includes(BEARER)).map(({ name }) => name);
  sqlite.close();
  const httpOut = step(credRun || { nodes: [] }, "h")?.output?.main?.items?.[0];
  check("credential: the saved token reaches the real service, but the API and the database never show it",
    saved.status === 201 && credRun?.execution.status === "completed" && httpOut?.status === 200 && httpOut?.body?.authenticated === true && !JSON.stringify(listed.body).includes(BEARER) && !rowsWith.length,
    `saved ${saved.status} (hint ${saved.body.credential?.hint}); httpbin.org/bearer → HTTP ${httpOut?.status}, authenticated ${httpOut?.body?.authenticated}; token in API: ${JSON.stringify(listed.body).includes(BEARER)}, in database rows: ${rowsWith.join(", ") || "none"}`);

  // 6. A schedule fires from the tick alone.
  const next = new Date(Date.now() + 60_000);
  const scheduled = await activate("Scheduled", flow({ id: "t", name: "Schedule", type: "trigger.schedule", params: { mode: "cron", cron: `${next.getUTCMinutes()} * * * *`, missed: "run-once" } }, [echo("fired")]));
  const firedRun = await waitFor(async () => {
    await tick();
    const list = (await call("GET", `/workflows/executions?limit=50&workflowId=${scheduled.id}`)).body.executions || [];
    return list.find((run) => run.workflowId === scheduled.id && run.mode === "schedule");
  }, 150_000, "the schedule to fire");
  runs.schedule = firedRun.id;
  const schedRun = await finished(runs.schedule);
  check("schedule: a cron trigger fires at its minute from the tick alone, with no worker", schedRun.execution.status === "completed" && schedRun.execution.mode === "schedule",
    `cron "${next.getUTCMinutes()} * * * *" → run ${firedRun.id} (${schedRun.execution.mode}) ${schedRun.execution.status}, started ${new Date(schedRun.execution.startedAt || firedRun.createdAt).toISOString()}`);

  // 7. History.
  const all = (await call("GET", "/workflows/executions?limit=50")).body.executions;
  const byId = new Map(all.map((run) => [run.id, run]));
  check("history: every run is listed with the trigger that started it", Object.values(runs).every((id) => byId.has(id)),
    Object.entries(runs).map(([name, id]) => `${name}=${byId.get(id)?.mode}/${byId.get(id)?.status}`).join(", "));
} catch (error) {
  check("the proof ran to the end", false, error.stack || error.message);
} finally {
  if (server) await stop();
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
