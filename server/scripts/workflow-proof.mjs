#!/usr/bin/env node
/**
 * Workflow engine proof against real services.
 *
 *   node server/scripts/workflow-proof.mjs
 *
 * Starts the real server (node server/index.js) with a fresh SQLite account
 * database and the built-in worker, signs up, and runs the milestone workflow
 *   Manual trigger → HTTP request (GitHub's public API) → Process JSON (Code)
 *   → If → Send notification → Create document (the run's record)
 * with real network calls, then:
 *   1. success: real data passes through every step;
 *   2. failure: a repository that doesn't exist (GitHub 404), reported as such;
 *   3. retry: a real HTTP 503 (httpbin.org) retried with backoff, then failed with the attempts counted;
 *   4. cancellation: a run cancelled during a Wait; nothing after it runs;
 *   5. restart: the server is killed (SIGKILL) during a slow real request (httpbin.org/delay)
 *      and started again; the run is recovered and finishes;
 *   6. history: after the restart, every run above is still there with its steps.
 * Needs network access. Prints what happened and exits non-zero if anything didn't.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "hannah-proof-"));
const port = 4900 + Math.floor(Math.random() * 90);
const api = `http://127.0.0.1:${port}/api`;
let server = null;
let log = "";
let token = "";
const results = [];

function start() {
  server = spawn(process.execPath, ["index.js"], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", HANNAH_API_TOKEN: "", DATABASE_URL: `sqlite:${join(dataDir, "hannah.db")}`, HANNAH_VAULT_KEY: "b".repeat(64), WORKFLOW_LEASE_MS: "5000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { log += chunk; });
  server.stderr.on("data", (chunk) => { log += chunk; });
  return waitFor(async () => (await fetch(`${api}/health`).catch(() => null))?.ok, 20_000, "the server to start");
}
async function kill() {
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${what}.\n${log.slice(-2000)}`);
}
async function call(method, path, body) {
  const response = await fetch(`${api}${path}`, { method, headers: { "Content-Type": "application/json", "x-hannah-session": "bearer", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
}
const detail = async (id) => (await call("GET", `/workflows/executions/${id}`)).body;
const finished = (id, ms = 60_000) => waitFor(async () => { const body = await detail(id); return ["completed", "failed", "cancelled", "timed-out"].includes(body.execution.status) && body; }, ms, `run ${id}`);
function check(name, ok, evidence) {
  results.push({ name, ok: Boolean(ok), evidence });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${evidence}`);
}

const link = (source, target, sourceOutput = "main") => ({ id: `${source}-${target}`, source, target, sourceOutput, targetInput: "main" });
function milestone(url, { httpSettings, before } = {}) {
  const nodes = [
    { id: "t", name: "Start", type: "trigger.manual", params: {} },
    ...(before ? [before] : []),
    { id: "h", name: "HTTP request", type: "action.http", params: { method: "GET", url, responseFormat: "json" }, ...(httpSettings ? { settings: httpSettings } : {}) },
    { id: "p", name: "Process JSON", type: "data.code", params: { mode: "all", code: "return items.map((item) => ({ repo: item.body.full_name, stars: item.body.stargazers_count, openIssues: item.body.open_issues_count, popular: item.body.stargazers_count > 50000 }));" } },
    { id: "i", name: "IF popular", type: "logic.if", params: { conditions: [{ left: "{{ $json.popular }}", operator: "isTrue", right: "" }] } },
    { id: "n", name: "Send notification", type: "action.notify", params: { title: "{{ $json.repo }} has {{ $json.stars }} stars", body: "{{ $json.openIssues }} open issues" } },
    { id: "r", name: "Save execution record", type: "action.report", params: { format: "markdown", title: "Execution record", template: "- {{ $json.repo }}: {{ $json.stars }} stars, {{ $json.openIssues }} open issues (run {{ $execution.id }})" } },
  ].map((node, index) => ({ ...node, position: { x: 80 + index * 260, y: 160 } }));
  const first = before ? [link("t", before.id), link(before.id, "h")] : [link("t", "h")];
  return { format: "hannah-workflow", version: 2, nodes, connections: [...first, link("h", "p"), link("p", "i"), link("i", "n", "true"), link("n", "r")], settings: { timezone: "UTC" } };
}
async function startRun(name, definition) {
  const created = await call("POST", "/workflows", { name, definition });
  if (created.status !== 201) throw new Error(`Creating “${name}” failed: ${JSON.stringify(created.body)}`);
  const run = await call("POST", `/workflows/${created.body.workflow.id}/run`, {});
  if (run.status !== 202) throw new Error(`Running “${name}” failed: ${JSON.stringify(run.body)}`);
  return run.body.executionId;
}
const step = (body, id) => body.nodes.find((node) => node.nodeId === id);

try {
  await start();
  token = (await call("POST", "/account/register", { email: `proof-${Date.now()}@example.com`, password: "correct horse battery staple" })).body.sessionToken;
  const ids = {};

  // 1. Success with real data.
  ids.success = await startRun("Node.js stars", milestone("https://api.github.com/repos/nodejs/node"));
  const ok = await finished(ids.success);
  const processed = step(ok, "p")?.output?.main?.items?.[0];
  const record = step(ok, "r")?.output?.main?.items?.[0]?.document?.content || "";
  check("success: real GitHub data passes through every step", ok.execution.status === "completed" && processed?.repo === "nodejs/node" && processed.stars > 50000 && step(ok, "i").output.true.count === 1 && step(ok, "n").status === "done" && record.includes("nodejs/node"),
    `status ${ok.execution.status}; Process JSON → ${JSON.stringify(processed)}; record: ${record.trim().split("\n").pop()}`);
  const notes = (await call("GET", "/notifications")).body.notifications;
  check("success: the notification was really stored", notes.some((note) => note.title.startsWith("nodejs/node has")), notes.map((note) => note.title).join(" | "));

  // 2. Failure: GitHub answers 404; a 4xx isn't retried.
  ids.failure = await startRun("Missing repo", milestone("https://api.github.com/repos/hannah-proof-missing/none", { httpSettings: { retries: 2, retryDelayMs: 1000 } }));
  const bad = await finished(ids.failure);
  check("failure: the 404 fails the run at the HTTP step, with GitHub's answer, and isn't retried", bad.execution.status === "failed" && bad.execution.errorNode === "h" && /404/.test(bad.execution.error) && step(bad, "h").attempts === 1 && !step(bad, "n"),
    `status ${bad.execution.status} at ${bad.execution.errorNode}: ${bad.execution.error} (attempts ${step(bad, "h").attempts})`);

  // 3. Retry: a real 503, retried twice with backoff, then failed with the attempts counted.
  ids.retry = await startRun("Flaky service", milestone("https://httpbin.org/status/503", { httpSettings: { retries: 2, retryDelayMs: 1000 } }));
  const flaky = await finished(ids.retry);
  const ms = (step(flaky, "h").finishedAt || 0) - (step(flaky, "h").startedAt || 0);
  check("retry: a 503 is retried twice with backoff, then reported with its attempts", flaky.execution.status === "failed" && step(flaky, "h").attempts === 3 && /503/.test(flaky.execution.error) && /after 3 attempts/.test(flaky.execution.error) && ms >= 2500,
    `${flaky.execution.error} (step took ${ms} ms)`);

  // 4. Cancellation during a Wait.
  ids.cancel = await startRun("Cancelled", milestone("https://api.github.com/repos/nodejs/node", { before: { id: "w", name: "Wait a minute", type: "logic.wait", params: { mode: "duration", amount: 1, unit: "minutes" } } }));
  await waitFor(async () => (await detail(ids.cancel)).execution.status === "waiting", 20_000, "the wait");
  const cancelled = await call("POST", `/workflows/executions/${ids.cancel}/cancel`);
  const after = await detail(ids.cancel);
  check("cancellation: a waiting run is cancelled and nothing after the wait runs", cancelled.body.status === "cancelled" && after.execution.status === "cancelled" && !step(after, "h"),
    `cancel → ${JSON.stringify(cancelled.body)}; status ${after.execution.status}; HTTP step ${step(after, "h") ? "ran" : "never ran"}`);

  // 5. Restart: kill the server during a slow real request, start it again.
  const slowDefinition = milestone("https://httpbin.org/delay/8");
  slowDefinition.nodes.find((node) => node.id === "p").params.code = "return items.map((item) => ({ repo: 'httpbin/delay', stars: 60000, openIssues: 0, popular: true, waited: item.body.url }));";
  ids.restart = await startRun("Killed mid-request", slowDefinition);
  await waitFor(async () => step(await detail(ids.restart), "h")?.status === "running", 20_000, "the slow request to start");
  await kill();
  const killedAt = Date.now();
  await start();
  const recovered = await finished(ids.restart, 90_000);
  check("restart: a run killed mid-request is recovered after the restart and finishes", recovered.execution.status === "completed" && recovered.execution.recoveries === 1 && step(recovered, "n").status === "done",
    `status ${recovered.execution.status}, recoveries ${recovered.execution.recoveries}, finished ${Math.round((recovered.execution.finishedAt - killedAt) / 1000)} s after the kill`);

  // 6. History survives the restart.
  const runs = (await call("GET", "/workflows/executions?limit=50")).body.executions;
  const byId = new Map(runs.map((run) => [run.id, run]));
  check("history: every run is still recorded after the restart, with its steps", Object.values(ids).every((id) => byId.has(id)) && (await detail(ids.success)).nodes.length === 6,
    Object.entries(ids).map(([name, id]) => `${name}=${byId.get(id)?.status}`).join(", "));
} catch (error) {
  check("the proof ran to the end", false, error.message);
} finally {
  if (server) await kill();
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
