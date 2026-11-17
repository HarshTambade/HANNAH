/**
 * The workflow engine end to end: the real server, a real database (SQLite
 * here; Postgres via workflows.pglite.test.js), real HTTP for webhooks and the
 * HTTP node (a local test server, allowed through WORKFLOW_ALLOW_PRIVATE_NETWORK
 * the way a self-hoster would), and the real worker driven by tick().
 * Only the AI provider is a local stand-in for api.groq.com.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workflow-test-token-0123456789-abcdefghijkl";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "d".repeat(64);
process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = "true";
process.env.CRON_SECRET = "cron-secret-for-tests-0123456789";

let server;
let baseUrl;
let target; // a local service the HTTP node calls
let targetUrl;
const targetHits = [];
let runtime;

// The AI provider stand-in: every call to api.groq.com lands here.
const aiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.groq.com/")) {
    const body = JSON.parse(init.body || "{}");
    const prompt = body.messages?.find((message) => message.role === "user")?.content || "";
    aiCalls.push({ model: body.model, prompt, system: body.messages?.find((message) => message.role === "system")?.content || "" });
    const system = body.messages?.find((message) => message.role === "system")?.content || "";
    if (/You design automations/.test(system)) {
      // A model's draft, including things the server must strip: an unknown step type and a credential id.
      const draft = { name: "Morning mail summary", notes: "Connect Google or Microsoft first.", nodes: [
        { id: "t", name: "Every morning", type: "trigger.schedule", params: { mode: "daily", time: "07:30" } },
        { id: "m", name: "Newest mail", type: "action.email", params: { mode: "search", query: "newer_than:1d" }, credentialId: "cred_stolen" },
        { id: "x", name: "Run shell", type: "code.shell", params: { command: "rm -rf /" } },
        { id: "s", name: "Summarize", type: "ai.prompt", params: { prompt: "Summarize: {{ json($json) }}" } },
        { id: "n", name: "Tell me", type: "action.notify", params: { title: "Mail", body: "{{ $json.answer }}" } },
      ], connections: [{ source: "t", target: "m" }, { source: "m", target: "s" }, { source: "s", target: "n" }, { source: "x", target: "n" }] };
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(draft) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const content = /Fields: \{/.test(prompt) ? JSON.stringify({ vendor: /from (\w+)/i.exec(prompt)?.[1] || null, amount: Number(/total ([\d.]+)/i.exec(prompt)?.[1]) || null }) : `Summary of: ${prompt.slice(0, 60)}`;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://gmail.googleapis.com/")) return fakeGmail(url, init);
  return realFetch(input, init);
};

// A Gmail stand-in for the New email trigger: a mailbox the tests add to.
const mailbox = [];
const gmailRequests = [];
let gmailDown = false;
function fakeGmail(url, init) {
  const parsed = new URL(url);
  gmailRequests.push({ path: parsed.pathname, q: parsed.searchParams.get("q"), auth: init.headers?.Authorization });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (gmailDown) return reply(503, { error: { message: "backend error" } });
  const id = /\/messages\/([^/?]+)$/.exec(parsed.pathname)?.[1];
  if (!id) return reply(200, { messages: [...mailbox].sort((a, b) => b.at - a.at).slice(0, Number(parsed.searchParams.get("maxResults")) || 20).map((item) => ({ id: item.id, threadId: `t-${item.id}` })) });
  const item = mailbox.find((entry) => entry.id === decodeURIComponent(id));
  if (!item) return reply(404, { error: { message: "not found" } });
  const headers = [{ name: "From", value: item.from }, { name: "Subject", value: item.subject }, { name: "To", value: "me@example.com" }, { name: "Date", value: new Date(item.at).toUTCString() }];
  const body = parsed.searchParams.get("format") === "full" ? { mimeType: "text/plain", body: { data: Buffer.from(item.body).toString("base64url") } } : {};
  return reply(200, { id: item.id, threadId: `t-${item.id}`, internalDate: String(item.at), snippet: item.body.slice(0, 40), labelIds: ["UNREAD", "INBOX"], payload: { headers, ...body } });
}

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  runtime = app.workflowRuntime;
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let flaky = 0;
  target = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      targetHits.push({ method: req.method, url: req.url, body, idempotencyKey: req.headers["idempotency-key"], auth: req.headers.authorization });
      if (req.url.startsWith("/flaky")) { flaky += 1; res.writeHead(flaky % 3 === 0 ? 200 : 503, { "content-type": "application/json" }); return res.end(JSON.stringify({ attempt: flaky })); }
      if (req.url.startsWith("/broken")) { res.writeHead(500, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "boom" })); }
      if (req.url.startsWith("/slow")) { setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }, 4000); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null, rates: { usd: 1, inr: 83.2 } }));
    });
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  targetUrl = `http://127.0.0.1:${target.address().port}`;
});

after(async () => {
  server?.close();
  target?.close();
  globalThis.fetch = realFetch;
  await require("./db").resetDatabase();
});

async function signUp(email) {
  const response = await realFetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get("set-cookie").split(";")[0];
}

function client(cookie) {
  const call = async (method, path, body) => {
    const response = await realFetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json };
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
    put: (path, body) => call("PUT", path, body),
    del: (path) => call("DELETE", path),
  };
}

const definition = (nodes, connections, settings = {}) => ({ format: "hannah-workflow", version: 2, nodes, connections: connections.map(([source, target, sourceOutput = "main", targetInput = "main"]) => ({ source, target, sourceOutput, targetInput })), settings: { timezone: "Asia/Kolkata", ...settings } });

async function createWorkflow(api, name, def) {
  const created = await api.post("/workflows", { name, definition: def });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.workflow.id;
}

async function runToEnd(api, executionId, rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    await runtime.tick({ budgetMs: 10_000 });
    const { body } = await api.get(`/workflows/executions/${executionId}`);
    if (!["queued", "running"].includes(body.execution.status)) return body;
  }
  return (await api.get(`/workflows/executions/${executionId}`)).body;
}

async function saveGroqKey(email) {
  const db = await require("./db").getDatabase();
  const { rows: [user] } = await db.query("SELECT id FROM hannah_users WHERE email = $1", [email]);
  const sealed = require("./vault").encryptSecret("gsk_workflowTestKey0123456789abcdefghijkl", { userId: user.id, providerId: "groq" });
  await db.query("INSERT INTO hannah_credentials (user_id, provider_id, key_id, wrapped_key, ciphertext, hint, created_at, updated_at) VALUES ($1, 'groq', $2, $3, $4, 'gsk_…ijkl', $5, $5)", [user.id, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, Date.now()]);
}

test("a draft is saved with version checks, validated, and runs with real data passing between nodes", async () => {
  const api = client(await signUp("builder@example.com"));
  const id = await createWorkflow(api, "Order check", definition([
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: { order: "A-17", total: "2,400" } } },
    { id: "h", name: "Fetch rates", type: "action.http", params: { method: "POST", url: `${targetUrl}/rates`, body: { order: "{{ $json.order }}" } } },
    { id: "i", name: "Large?", type: "logic.if", params: { conditions: [{ left: "{{ number($node['Start'].json.total) }}", operator: "gt", right: "1000" }] } },
    { id: "s", name: "Mark", type: "data.set", params: { fields: [{ name: "flag", value: "large order {{ $node['Start'].json.order }} at {{ $json.body.rates.inr }}" }] } },
  ], [["t", "h"], ["h", "i"], ["i", "s", "true"]]));

  const loaded = await api.get(`/workflows/${id}`);
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.validation.errors, []);
  assert.equal(loaded.body.workflow.draftVersion, 1);

  const stale = await api.put(`/workflows/${id}`, { baseVersion: 0, name: "Renamed" });
  assert.equal(stale.status, 409, "a save based on an old version is refused");
  const saved = await api.put(`/workflows/${id}`, { baseVersion: 1, name: "Order check v2" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.workflow.draftVersion, 2);

  const started = await api.post(`/workflows/${id}/run`, {});
  assert.equal(started.status, 202);
  const done = await runToEnd(api, started.body.executionId);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.mode, "test", "running the draft is a test run");
  const byName = Object.fromEntries(done.nodes.map((node) => [node.name, node]));
  assert.equal(byName.Mark.output.main.items[0].flag, "large order A-17 at 83.2", "data from two earlier nodes reached the last one");
  assert.equal(byName["Fetch rates"].output.main.items[0].body.echo.order, "A-17", "the HTTP node really sent the order");
  assert.equal(byName["Large?"].output.true.count, 1);
  assert.ok(byName["Fetch rates"].durationMs >= 0);
  assert.equal(targetHits.filter((hit) => hit.url === "/rates").length, 1);
});

test("invalid workflows can't be run, published or activated, and the reasons point at the node", async () => {
  const api = client(await signUp("invalid@example.com"));
  const id = await createWorkflow(api, "Broken", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "h", name: "Call", type: "action.http", params: { url: "" } }], [["t", "h"]]));
  const run = await api.post(`/workflows/${id}/run`, {});
  assert.equal(run.status, 422);
  assert.equal(run.body.validation.errors[0].nodeId, "h");
  assert.match(run.body.validation.errors[0].message, /URL is required/);
  assert.equal((await api.post(`/workflows/${id}/publish`)).status, 422);
  assert.equal((await api.post(`/workflows/${id}/activate`, { approvedPermissions: [] })).status, 409);
});

test("webhook workflow: token auth, permission consent, replay protection, AI extraction, branching and a notification", async () => {
  const email = "invoices@example.com";
  const api = client(await signUp(email));
  await saveGroqKey(email);
  const id = await createWorkflow(api, "Invoices", definition([
    { id: "hook", name: "Invoice arrives", type: "trigger.webhook" },
    { id: "x", name: "Extract", type: "ai.extract", params: { text: "{{ $json.body.text }}", fields: [{ field: "vendor", type: "string", required: true }, { field: "amount", type: "number", required: true }] } },
    { id: "big", name: "Over 1000", type: "logic.if", params: { conditions: [{ left: "{{ $json.amount }}", operator: "gt", right: "1000" }] } },
    { id: "save", name: "Save", type: "action.http", params: { method: "POST", url: `${targetUrl}/ledger`, body: { vendor: "{{ $json.vendor }}", amount: "{{ $json.amount }}" } } },
    { id: "tell", name: "Tell me", type: "action.notify", params: { title: "Large invoice from {{ $node['Extract'].json.vendor }}", body: "{{ $node['Extract'].json.amount }}" } },
  ], [["hook", "x"], ["x", "big"], ["big", "save", "true"], ["save", "tell"]]));

  const published = await api.post(`/workflows/${id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const permissions = published.body.permissions;
  assert.deepEqual(permissions.map((entry) => entry.permission), ["ai", "network", "notify", "receive-webhooks"]);
  const refused = await api.post(`/workflows/${id}/activate`, { approvedPermissions: [] });
  assert.equal(refused.status, 409, "activation needs the reviewed permissions");
  const activated = await api.post(`/workflows/${id}/activate`, { approvedPermissions: permissions });
  assert.equal(activated.status, 200);
  // The webhook and its secret are created when the workflow is first published, so the sender can be set up before activation; the secret is shown once.
  const [{ secret, triggerId }] = [...published.body.webhookSecrets, ...activated.body.webhookSecrets];
  assert.match(secret, /^whsec_/);
  const hookUrl = activated.body.webhooks[0].url;
  assert.equal(hookUrl, `${baseUrl}/api/hooks/${triggerId}`);

  const send = (headers, body = { text: "INVOICE from Acme total 1250.50" }) => realFetch(hookUrl, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await send({})).status, 401, "no token");
  assert.equal((await send({ "X-Hannah-Token": "whsec_wrong" })).status, 401, "wrong token");
  const accepted = await send({ "X-Hannah-Token": secret, "X-Hannah-Delivery": "delivery-1" });
  assert.equal(accepted.status, 202);
  const { executionId } = await accepted.json();
  const replay = await send({ "X-Hannah-Token": secret, "X-Hannah-Delivery": "delivery-1" });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true, "a repeated delivery id is not run twice");

  const done = await runToEnd(api, executionId);
  assert.equal(done.execution.status, "completed", JSON.stringify(done.execution));
  assert.equal(done.execution.mode, "webhook");
  assert.match(aiCalls.at(-1).prompt, /INVOICE from Acme total 1250.50/, "the model read the webhook body");
  assert.deepEqual(JSON.parse(targetHits.find((hit) => hit.url === "/ledger").body), { vendor: "Acme", amount: 1250.5 });
  const notifications = await api.get("/notifications");
  assert.equal(notifications.body.notifications[0].title, "Large invoice from Acme");
  assert.equal(notifications.body.notifications[0].body, "1250.5");

  const listed = await api.get(`/workflows/executions?workflowId=${id}`);
  assert.equal(listed.body.executions.length, 1);
  assert.equal(listed.body.executions[0].nodes.done, 5);
});

test("HMAC-signed webhooks verify the exact body and reject old timestamps", async () => {
  const api = client(await signUp("hmac@example.com"));
  const id = await createWorkflow(api, "Signed", definition([{ id: "hook", name: "Signed hook", type: "trigger.webhook", params: { auth: "hmac" } }, { id: "s", name: "Keep", type: "data.set", params: { fields: [{ name: "got", value: "{{ $json.body.n }}" }] } }], [["hook", "s"]]));
  const published = await api.post(`/workflows/${id}/publish`);
  const activated = await api.post(`/workflows/${id}/activate`, { approvedPermissions: published.body.permissions });
  const { secret } = [...published.body.webhookSecrets, ...activated.body.webhookSecrets][0];
  const url = activated.body.webhooks[0].url;
  const sign = (timestamp, body) => `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const body = JSON.stringify({ n: 7 });
  const now = Math.floor(Date.now() / 1000);
  const post = (headers, payload = body) => realFetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: payload });
  assert.equal((await post({ "X-Hannah-Timestamp": String(now), "X-Hannah-Signature": sign(now, body) }, JSON.stringify({ n: 8 }))).status, 401, "a changed body fails");
  assert.equal((await post({ "X-Hannah-Timestamp": String(now - 900), "X-Hannah-Signature": sign(now - 900, body) })).status, 401, "an old timestamp fails");
  const good = await post({ "X-Hannah-Timestamp": String(now), "X-Hannah-Signature": sign(now, body) });
  assert.equal(good.status, 202);
  const replayed = await post({ "X-Hannah-Timestamp": String(now), "X-Hannah-Signature": sign(now, body) });
  assert.equal((await replayed.json()).duplicate, true, "the same signed request can't be replayed");
  const done = await runToEnd(api, (await good.json()).executionId);
  assert.equal(done.nodes.find((node) => node.name === "Keep").output.main.items[0].got, 7);
});

test("a failing node is retried with backoff; a permanent failure names the node; retry continues from the failure", async () => {
  const api = client(await signUp("retries@example.com"));
  const flakyId = await createWorkflow(api, "Flaky", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "h", name: "Flaky call", type: "action.http", params: { url: `${targetUrl}/flaky` }, settings: { retries: 3, retryDelayMs: 500 } }], [["t", "h"]]));
  const flaky = await runToEnd(api, (await api.post(`/workflows/${flakyId}/run`, {})).body.executionId);
  assert.equal(flaky.execution.status, "completed");
  assert.equal(flaky.nodes.find((node) => node.name === "Flaky call").attempts, 3, "two 503s, then success");

  const brokenId = await createWorkflow(api, "Broken", definition([
    { id: "t", name: "Start", type: "trigger.manual" },
    { id: "a", name: "Record", type: "action.http", params: { method: "POST", url: `${targetUrl}/record`, body: { step: "first" } } },
    { id: "b", name: "Broken call", type: "action.http", params: { url: `${targetUrl}/broken` } },
  ], [["t", "a"], ["a", "b"]]));
  const failed = await runToEnd(api, (await api.post(`/workflows/${brokenId}/run`, {})).body.executionId);
  assert.equal(failed.execution.status, "failed");
  assert.equal(failed.execution.errorNode, "b");
  assert.match(failed.execution.error, /Broken call: GET .*\/broken returned HTTP 500/);
  assert.equal(failed.nodes.find((node) => node.name === "Record").status, "done", "earlier steps stay done");
  const recorded = targetHits.filter((hit) => hit.url === "/record").length;

  const retried = await api.post(`/workflows/executions/${failed.execution.id}/retry`, {});
  assert.equal(retried.status, 202);
  const second = await runToEnd(api, retried.body.executionId);
  assert.equal(second.execution.retryOf, failed.execution.id);
  assert.equal(second.execution.status, "failed", "it still fails: the service is still broken, and that's reported");
  assert.equal(targetHits.filter((hit) => hit.url === "/record").length, recorded, "retrying from the failure didn't repeat the first call");
});

test("cancel stops a waiting run and a running one; approvals continue a run", async () => {
  const api = client(await signUp("control@example.com"));
  const waitId = await createWorkflow(api, "Wait a day", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "w", name: "Wait", type: "logic.wait", params: { amount: 1, unit: "days" } }, { id: "s", name: "After", type: "data.set" }], [["t", "w"], ["w", "s"]]));
  const waiting = await runToEnd(api, (await api.post(`/workflows/${waitId}/run`, {})).body.executionId);
  assert.equal(waiting.execution.status, "waiting");
  assert.equal((await api.post(`/workflows/executions/${waiting.execution.id}/cancel`)).body.status, "cancelled");
  assert.equal((await api.get(`/workflows/executions/${waiting.execution.id}`)).body.execution.status, "cancelled");

  const slowId = await createWorkflow(api, "Slow", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "h", name: "Slow call", type: "action.http", params: { url: `${targetUrl}/slow` } }, { id: "s", name: "After", type: "data.set" }], [["t", "h"], ["h", "s"]]));
  const started = (await api.post(`/workflows/${slowId}/run`, {})).body.executionId;
  const ticking = runtime.tick({ budgetMs: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await api.post(`/workflows/executions/${started}/cancel`)).body.status, "cancelling");
  await ticking;
  const cancelled = (await api.get(`/workflows/executions/${started}`)).body;
  assert.equal(cancelled.execution.status, "cancelled");
  assert.ok(!cancelled.nodes.some((node) => node.name === "After" && node.status === "done"), "the next step never ran");

  const approvalId = await createWorkflow(api, "Ask first", definition([{ id: "t", name: "Start", type: "trigger.manual", params: { sample: { amount: 90 } } }, { id: "a", name: "OK?", type: "logic.approval", params: { message: "Pay {{ $json.amount }}?" } }, { id: "s", name: "Paid", type: "data.set" }], [["t", "a"], ["a", "s", "approved"]]));
  const asking = await runToEnd(api, (await api.post(`/workflows/${approvalId}/run`, {})).body.executionId);
  assert.equal(asking.execution.status, "waiting-approval");
  const approvals = await api.get("/workflows/approvals");
  assert.equal(approvals.body.approvals[0].waiting.message, "Pay 90?");
  await api.post(`/workflows/executions/${asking.execution.id}/resume`, { approved: true });
  const approved = await runToEnd(api, asking.execution.id);
  assert.equal(approved.execution.status, "completed");
  assert.equal(approved.nodes.find((node) => node.name === "Paid").status, "done");
});

test("a run interrupted by a worker crash continues from its checkpoint; repeated crashes dead-letter it", async () => {
  const api = client(await signUp("crash@example.com"));
  const id = await createWorkflow(api, "Crashy", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "a", name: "First", type: "action.http", params: { method: "POST", url: `${targetUrl}/first-call`, body: { n: 1 } } }, { id: "b", name: "Second", type: "data.set", params: { fields: [{ name: "status", value: "{{ $json.status }}" }] } }], [["t", "a"], ["a", "b"]]));
  const executionId = (await api.post(`/workflows/${id}/run`, {})).body.executionId;
  const db = await require("./db").getDatabase();
  // A worker claimed it, finished "First", then died (lease expired, never finished).
  const state = { nodes: { t: { status: "done", outputs: { main: [{ json: {} }] } }, a: { status: "done", outputs: { main: [{ json: { status: 200 } }] } } } };
  await db.query("UPDATE hannah_workflow_executions SET status = 'running', attempts = 1, lease_owner = 'w-dead', lease_expires_at = 1, state = $1 WHERE id = $2", [JSON.stringify(state), executionId]);
  const before = targetHits.filter((hit) => hit.url === "/first-call").length;
  const report = await runtime.tick({ budgetMs: 10_000 });
  assert.equal(report.recovered, 1);
  const done = await runToEnd(api, executionId);
  assert.equal(done.execution.status, "completed");
  assert.equal(targetHits.filter((hit) => hit.url === "/first-call").length, before, "the finished step wasn't repeated");

  const second = (await api.post(`/workflows/${id}/run`, {})).body.executionId;
  await db.query("UPDATE hannah_workflow_executions SET status = 'running', attempts = 3, lease_owner = 'w-dead', lease_expires_at = 1 WHERE id = $1", [second]);
  const dead = await runtime.tick({ budgetMs: 10_000 });
  assert.equal(dead.deadLettered, 1);
  const row = (await api.get(`/workflows/executions/${second}`)).body.execution;
  assert.equal(row.status, "failed");
  assert.match(row.error, /Dead-lettered/);
});

test("schedules fire once per slot in the workflow's time zone, and pausing stops them", async () => {
  const api = client(await signUp("schedule@example.com"));
  const id = await createWorkflow(api, "Morning", definition([{ id: "t", name: "Every morning", type: "trigger.schedule", params: { mode: "daily", time: "07:30" } }, { id: "s", name: "Note", type: "data.set", params: { fields: [{ name: "for", value: "{{ $json.scheduledFor }}" }] } }], [["t", "s"]]));
  const published = await api.post(`/workflows/${id}/publish`);
  await api.post(`/workflows/${id}/activate`, { approvedPermissions: published.body.permissions });
  const db = await require("./db").getDatabase();
  const { rows: [trigger] } = await db.query("SELECT id, next_run_at FROM hannah_workflow_triggers WHERE workflow_id = $1", [id]);
  const next = new Date(Number(trigger.next_run_at));
  assert.equal(next.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }), "07:30", "next run is 07:30 in the workflow's time zone");

  const slot = Date.now() - 60_000;
  await db.query("UPDATE hannah_workflow_triggers SET next_run_at = $1 WHERE id = $2", [slot, trigger.id]);
  await Promise.all([runtime.tick({ budgetMs: 10_000 }), runtime.tick({ budgetMs: 10_000 })]);
  await runtime.tick({ budgetMs: 10_000 });
  const runs = (await api.get(`/workflows/executions?workflowId=${id}`)).body.executions;
  assert.equal(runs.length, 1, "two workers ticking at once still ran the slot once");
  assert.equal(runs[0].mode, "schedule");
  assert.equal(runs[0].status, "completed");

  await api.post(`/workflows/${id}/deactivate`);
  await db.query("UPDATE hannah_workflow_triggers SET next_run_at = $1 WHERE id = $2", [Date.now() - 1000, trigger.id]);
  await runtime.tick({ budgetMs: 10_000 });
  assert.equal((await api.get(`/workflows/executions?workflowId=${id}`)).body.executions.length, 1, "a paused workflow doesn't run");
});

test("one workflow finishing starts another through a HANNAH event trigger", async () => {
  const api = client(await signUp("events@example.com"));
  const first = await createWorkflow(api, "First", definition([{ id: "t", name: "Hook", type: "trigger.webhook" }, { id: "s", name: "Set", type: "data.set" }], [["t", "s"]]));
  const second = await createWorkflow(api, "Follow-up", definition([{ id: "e", name: "When First finishes", type: "trigger.event", params: { event: "workflow.completed" } }, { id: "s", name: "Keep", type: "data.set", params: { fields: [{ name: "from", value: "{{ $json.data.workflowId }}" }] } }], [["e", "s"]]));
  for (const id of [first, second]) {
    const published = await api.post(`/workflows/${id}/publish`);
    const activated = await api.post(`/workflows/${id}/activate`, { approvedPermissions: published.body.permissions });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
  }
  const firstRun = await realFetch((await api.get(`/workflows/${first}`)).body.webhooks[0].url, { method: "POST", headers: { "Content-Type": "application/json", "X-Hannah-Token": (await api.post(`/workflows/${first}/webhooks/t/rotate`)).body.secret }, body: "{}" });
  assert.equal(firstRun.status, 202);
  await runToEnd(api, (await firstRun.json()).executionId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await runtime.tick({ budgetMs: 10_000 });
  const followUps = (await api.get(`/workflows/executions?workflowId=${second}`)).body.executions;
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].mode, "event");
  const detail = (await api.get(`/workflows/executions/${followUps[0].id}`)).body;
  assert.equal(detail.nodes.find((node) => node.name === "Keep").output.main.items[0].from, first);
});

test("accounts are isolated: workflows, runs and credentials; secrets are never returned", async () => {
  const alice = client(await signUp("alice@example.com"));
  const bob = client(await signUp("bob@example.com"));
  const anonymous = client(null);
  const created = await alice.post("/workflows/credentials", { name: "Alice's API", type: "bearer", data: { token: "secret-token-value-0123456789" } });
  assert.equal(created.status, 201);
  const credentialId = created.body.credential.id;
  assert.equal(created.body.credential.hint.includes("secret-token-value"), false);
  const listed = await alice.get("/workflows/credentials");
  assert.equal(JSON.stringify(listed.body).includes("secret-token-value"), false, "credential values are never sent back");

  const aliceFlow = await createWorkflow(alice, "Private", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "h", name: "Call", type: "action.http", params: { url: `${targetUrl}/authed` }, credentialId }], [["t", "h"]]));
  const run = await runToEnd(alice, (await alice.post(`/workflows/${aliceFlow}/run`, {})).body.executionId);
  assert.equal(run.execution.status, "completed");
  assert.equal(targetHits.find((hit) => hit.url === "/authed").auth, "Bearer secret-token-value-0123456789", "the credential was used");
  assert.equal(JSON.stringify(run).includes("secret-token-value"), false, "and never shows up in the execution");

  assert.equal((await bob.get(`/workflows/${aliceFlow}`)).status, 404);
  assert.equal((await bob.get(`/workflows/executions/${run.execution.id}`)).status, 404);
  assert.equal((await bob.post(`/workflows/executions/${run.execution.id}/cancel`)).status, 404);
  const stolen = await createWorkflow(bob, "Steal", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "h", name: "Call", type: "action.http", params: { url: `${targetUrl}/x` }, credentialId }], [["t", "h"]]));
  const attempt = await bob.post(`/workflows/${stolen}/run`, {});
  assert.equal(attempt.status, 422, "Bob can't use Alice's credential id");
  assert.match(attempt.body.validation.errors[0].message, /doesn't exist/);
  assert.equal((await anonymous.get("/workflows")).status, 401);
  assert.equal((await anonymous.get("/workflows/catalog")).status, 200, "the node catalog is public");

  const exported = await alice.get(`/workflows/${aliceFlow}/export`);
  const imported = await bob.post("/workflows/import", exported.body);
  assert.equal(imported.status, 201);
  assert.equal(imported.body.definition.nodes[1].credentialId, undefined, "importing drops credentials the importer doesn't own");
  assert.equal(imported.body.workflow.active, false, "an import is never active");
});

test("the cron tick needs CRON_SECRET; a single node can be tested on its own", async () => {
  const tick = (secret) => realFetch(`${baseUrl}/api/workflows/tick`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
  assert.equal((await tick()).status, 401);
  assert.equal((await tick("wrong-secret-0123456789")).status, 401);
  assert.equal((await tick(process.env.CRON_SECRET)).status, 200);

  const api = client(await signUp("single@example.com"));
  const id = await createWorkflow(api, "Single", definition([{ id: "t", name: "Start", type: "trigger.manual" }, { id: "s", name: "Double", type: "data.set", params: { fields: [{ name: "twice", value: "{{ $json.n * 2 }}" }] } }], [["t", "s"]]));
  const result = await api.post(`/workflows/${id}/test-node`, { nodeId: "s", items: [{ n: 21 }, { n: 5 }] });
  assert.equal(result.body.status, "done");
  assert.deepEqual(result.body.output.main.items.map((item) => item.twice), [42, 10]);
});

test("a description becomes an inactive draft with only real steps and no smuggled credentials", async () => {
  const email = "describe@example.com";
  const api = client(await signUp(email));
  await saveGroqKey(email);
  const drafted = await api.post("/workflows/from-text", { description: "Every morning, summarize my new emails and notify me", timezone: "Asia/Kolkata" });
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  assert.equal(drafted.body.workflow.name, "Morning mail summary");
  assert.equal(drafted.body.workflow.active, false);
  const types = drafted.body.definition.nodes.map((node) => node.type);
  assert.deepEqual(types, ["trigger.schedule", "action.email", "ai.prompt", "action.notify"], "the unknown step was dropped");
  assert.equal(drafted.body.definition.nodes.some((node) => node.credentialId), false);
  assert.equal(drafted.body.definition.connections.some((connection) => connection.source === "x"), false);
  assert.equal(drafted.body.definition.settings.timezone, "Asia/Kolkata");
  assert.deepEqual(drafted.body.validation.errors, []);
  assert.match(drafted.body.notes, /Connect Google/);
});

async function connectGoogle(email) {
  const db = await require("./db").getDatabase();
  const { rows: [user] } = await db.query("SELECT id FROM hannah_users WHERE email = $1", [email]);
  const sealed = require("./vault").encryptSecret(JSON.stringify({ accessToken: "ya29.workflow-test", refreshToken: "1//refresh", expiresAt: Date.now() + 3_600_000 }), { userId: user.id, providerId: "connection:google" });
  await db.query("INSERT INTO hannah_connections (user_id, provider, account_email, scopes, key_id, wrapped_key, ciphertext, created_at, updated_at) VALUES ($1, 'google', $2, 'gmail.readonly', $3, $4, $5, $6, $6)", [user.id, email, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, Date.now()]);
}

test("new-email trigger: the first check only records the mailbox; each new message then runs once, with its text", async () => {
  const email = "mailtrigger@example.com";
  const api = client(await signUp(email));
  await connectGoogle(email);
  mailbox.push({ id: "old-1", from: "Billing <billing@acme.test>", subject: "Old invoice", body: "Invoice total 10", at: Date.now() - 86_400_000 });
  const id = await createWorkflow(api, "Invoices by mail", definition([
    { id: "m", name: "Invoice mail", type: "trigger.email", params: { query: "from:billing@acme.test", minutes: 5, includeBody: true } },
    { id: "s", name: "Keep", type: "data.set", params: { fields: [{ name: "subject", value: "{{ $json.subject }}" }, { name: "text", value: "{{ $json.body }}" }] } },
  ], [["m", "s"]]));

  // A test run uses the newest real message.
  const test = await api.post(`/workflows/${id}/run`, {});
  const tested = await runToEnd(api, test.body.executionId);
  assert.equal(tested.execution.status, "completed", JSON.stringify(tested.execution));
  assert.equal(tested.nodes.find((node) => node.name === "Keep").output.main.items[0].subject, "Old invoice");

  const published = await api.post(`/workflows/${id}/publish`);
  assert.deepEqual(published.body.permissions.map((entry) => entry.permission), ["read-email"]);
  assert.equal((await api.post(`/workflows/${id}/activate`, { approvedPermissions: published.body.permissions })).status, 200);
  const live = async () => (await api.get(`/workflows/executions?workflowId=${id}`)).body.executions.filter((run) => run.mode === "email");

  await runtime.tick({ budgetMs: 10_000 });
  assert.equal((await live()).length, 0, "mail that was already there doesn't start runs");
  assert.ok(gmailRequests.some((request) => request.q === "from:billing@acme.test" && request.auth === "Bearer ya29.workflow-test"), "the filter and the account's token reach Gmail");

  const db = await require("./db").getDatabase();
  const due = () => db.query("UPDATE hannah_workflow_triggers SET next_run_at = $1 WHERE workflow_id = $2 AND kind = 'email'", [Date.now() - 1000, id]);
  mailbox.push({ id: "new-1", from: "Billing <billing@acme.test>", subject: "Invoice 2041", body: "Invoice from Acme, total 1499", at: Date.now() + 1000 });
  mailbox.push({ id: "new-2", from: "Billing <billing@acme.test>", subject: "Invoice 2042", body: "Invoice from Acme, total 20", at: Date.now() + 2000 });
  await due();
  await Promise.all([runtime.tick({ budgetMs: 10_000 }), runtime.tick({ budgetMs: 10_000 })]);
  await due();
  await runtime.tick({ budgetMs: 10_000 });
  const runs = await live();
  assert.equal(runs.length, 2, "two new messages, two runs, even with overlapping checks");
  const details = await Promise.all(runs.map((run) => runToEnd(api, run.id)));
  const kept = details.map((detail) => detail.nodes.find((node) => node.name === "Keep").output.main.items[0]).sort((a, b) => a.subject.localeCompare(b.subject));
  assert.deepEqual(kept.map((item) => item.subject), ["Invoice 2041", "Invoice 2042"]);
  assert.equal(kept[0].text, "Invoice from Acme, total 1499", "the body was read");

  // A failing mailbox check is shown on the workflow and doesn't lose the cursor.
  gmailDown = true;
  await due();
  await runtime.tick({ budgetMs: 10_000 });
  gmailDown = false;
  const listed = (await api.get("/workflows")).body.workflows.find((workflow) => workflow.id === id);
  assert.match(listed.mailbox.lastError, /./);
  await due();
  await runtime.tick({ budgetMs: 10_000 });
  assert.equal((await live()).length, 2, "after recovering it doesn't re-run messages it already handled");
  assert.equal((await api.get("/workflows")).body.workflows.find((workflow) => workflow.id === id).mailbox.lastError, null);
});

test("file trigger: an uploaded CSV becomes one item per row; limits and wrong workflows are refused", async () => {
  const cookie = await signUp("filetrigger@example.com");
  const api = client(cookie);
  const id = await createWorkflow(api, "Expenses", definition([
    { id: "f", name: "Expense sheet", type: "trigger.file", params: { output: "rows" } },
    { id: "s", name: "Amount", type: "data.set", params: { fields: [{ name: "inr", value: "{{ number($json.amount) * 83 }}" }] } },
  ], [["f", "s"]]));
  const upload = (workflowId, body, { name = "expenses.csv", type = "text/csv", query = "", contentType = "application/octet-stream" } = {}) => realFetch(`${baseUrl}/api/workflows/${workflowId}/files${query}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": contentType, "X-File-Name": encodeURIComponent(name), "X-File-Type": type }, body });

  const notActive = await upload(id, "item,amount\nTaxi,12\n");
  assert.equal(notActive.status, 409);
  const tested = await upload(id, "item,amount\nTaxi,12\nLunch,\"3,5\"\n", { query: "?test=1", name: "Expenses May.csv" });
  assert.equal(tested.status, 202, await tested.clone().text());
  const testRun = await tested.json();
  assert.equal(testRun.file.name, "Expenses May.csv");
  assert.equal(testRun.file.sha256, crypto.createHash("sha256").update("item,amount\nTaxi,12\nLunch,\"3,5\"\n").digest("hex"));
  const detail = await runToEnd(api, testRun.executionId);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  const rows = detail.nodes.find((node) => node.name === "Amount").output.main.items;
  assert.deepEqual(rows.map((row) => [row.item, row.$file.name]), [["Taxi", "Expenses May.csv"], ["Lunch", "Expenses May.csv"]]);
  assert.equal(rows[0].inr, 996);
  assert.equal(rows[1].amount, "3,5", "quoted commas stay in their cell");

  const published = await api.post(`/workflows/${id}/publish`);
  await api.post(`/workflows/${id}/activate`, { approvedPermissions: published.body.permissions });
  const live = await upload(id, "item,amount\nHotel,100\n");
  assert.equal(live.status, 202);
  const liveRun = await runToEnd(api, (await live.json()).executionId);
  assert.equal(liveRun.execution.mode, "file");
  assert.equal(liveRun.nodes.find((node) => node.name === "Amount").output.main.items[0].inr, 8300);

  assert.equal((await upload(id, Buffer.alloc(1024 * 1024 + 10, 65))).status, 413, "files over 1 MB are refused");
  assert.equal((await upload(id, "")).status, 400);
  assert.equal((await upload(id, JSON.stringify([{ a: 1 }]), { contentType: "application/json" })).status, 415, "a body the JSON parser already consumed is refused with a reason");
  const other = await createWorkflow(api, "No file step", definition([{ id: "t", name: "Start", type: "trigger.manual" }], []));
  assert.equal((await upload(other, "a,b\n1,2\n", { query: "?test=1" })).status, 409);
  const stranger = await signUp("filestranger@example.com");
  assert.equal((await realFetch(`${baseUrl}/api/workflows/${id}/files?test=1`, { method: "POST", headers: { Cookie: stranger, "Content-Type": "application/octet-stream" }, body: "a,b\n1,2\n" })).status, 404, "another account can't upload to it");

  // A binary file arrives as base64 and can't be read into rows.
  const binaryFlow = await createWorkflow(api, "Binary", definition([{ id: "f", name: "Upload", type: "trigger.file", params: { output: "file" } }], []));
  const binary = await upload(binaryFlow, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]), { name: "pixel.png", type: "image/png", query: "?test=1" });
  const binaryRun = await runToEnd(api, (await binary.json()).executionId);
  const file = binaryRun.nodes.find((node) => node.name === "Upload").output.main.items[0].file;
  assert.equal(file.base64, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]).toString("base64"));
  assert.equal(file.text, undefined);
});

test("code step: runs in the sandbox with items and logs; escapes, endless loops and memory bombs are stopped", async () => {
  const api = client(await signUp("codestep@example.com"));
  const flow = (code, mode = "all") => definition([{ id: "t", name: "Start", type: "trigger.manual", params: { sample: { amounts: [100, 250] } } }, { id: "split", name: "Each", type: "logic.split", params: { field: "amounts" } }, { id: "c", name: "Code", type: "data.code", params: { mode, code } }], [["t", "split"], ["split", "c"]]);
  const run = async (code, mode) => {
    const id = await createWorkflow(api, "Code", flow(code, mode));
    const started = await api.post(`/workflows/${id}/run`, {});
    return runToEnd(api, started.body.executionId);
  };

  const all = await run("console.log('count', items.length); return [{ total: items.reduce((sum, item) => sum + item.value, 0) }];");
  assert.equal(all.execution.status, "completed", JSON.stringify(all.execution));
  const node = all.nodes.find((entry) => entry.name === "Code");
  assert.deepEqual(node.output.main.items, [{ total: 350 }]);
  assert.deepEqual(node.logs, ["count 2"]);

  const each = await run("return $index === 0 ? { ...$json, gst: $json.value * 0.18 } : null;", "each");
  assert.deepEqual(each.nodes.find((entry) => entry.name === "Code").output.main.items, [{ value: 100, $index: 0, gst: 18 }]);

  const escape = await run("return [{ seen: [typeof require, typeof process, typeof fetch, typeof setTimeout, (function () {}).constructor('return typeof process')()].join(',') }];");
  assert.equal(escape.nodes.find((entry) => entry.name === "Code").output.main.items[0].seen, "undefined,undefined,undefined,undefined,undefined");

  const loop = await run("while (true) {}");
  assert.equal(loop.execution.status, "failed");
  assert.match(loop.execution.error, /longer than 2 seconds/);
  const bomb = await run("const keep = []; for (let i = 0; i < 5000; i++) keep.push('x'.repeat(100000) + i); return [];");
  assert.equal(bomb.execution.status, "failed");
  assert.match(bomb.execution.error, /more than 32 MB/);
  const broken = await run("return {");
  assert.match(broken.execution.error, /SyntaxError/);

  const published = await api.post(`/workflows/${(await api.get("/workflows")).body.workflows[0].id}/publish`);
  assert.ok(published.body.permissions.some((entry) => entry.permission === "run-code"), "activation asks before running code");
});

test("desktop steps: the run waits for a job; one device claims it; its result resumes the run; failures, cancel and expiry are reported", async () => {
  const api = client(await signUp("desktopjobs@example.com"));
  const id = await createWorkflow(api, "Read the status page", definition([
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: { site: "https://status.example.com/" } } },
    { id: "b", name: "Read page", type: "device.browser", params: { url: "{{ $json.site }}", pickupMinutes: 30 } },
    { id: "s", name: "Keep", type: "data.set", params: { fields: [{ name: "title", value: "{{ $json.page.title }}" }, { name: "by", value: "{{ $json.device }}" }] } },
  ], [["t", "b"], ["b", "s"]]));
  const published = await api.post(`/workflows/${id}/publish`);
  assert.ok(published.body.permissions.some((entry) => entry.permission === "desktop"));

  const start = async () => {
    const run = await api.post(`/workflows/${id}/run`, {});
    const detail = await runToEnd(api, run.body.executionId);
    assert.equal(detail.execution.status, "waiting", JSON.stringify(detail.execution));
    const { jobs } = (await api.get("/workflows/device-jobs")).body;
    const job = jobs.find((entry) => entry.executionId === run.body.executionId);
    assert.ok(job, "the job is offered to the account's desktop apps");
    return { executionId: run.body.executionId, job };
  };

  // Success.
  const first = await start();
  assert.equal(first.job.kind, "browser");
  assert.equal(first.job.workflowName, "Read the status page");
  assert.deepEqual(first.job.input, { url: "https://status.example.com/", waitFor: "", screenshot: false });
  const laptop = { deviceId: "laptop-0123456789", deviceName: "Maya's laptop" };
  const desktop = { deviceId: "desktop-0123456789", deviceName: "Office PC" };
  assert.equal((await api.post(`/workflows/device-jobs/${first.job.id}/claim`, laptop)).status, 200);
  assert.equal((await api.post(`/workflows/device-jobs/${first.job.id}/claim`, desktop)).status, 409, "only one device gets it");
  assert.equal((await api.get("/workflows/device-jobs")).body.jobs.some((entry) => entry.id === first.job.id), false, "a claimed job isn't offered again");
  assert.equal((await api.post(`/workflows/device-jobs/${first.job.id}/complete`, { ...desktop, ok: true, output: { title: "Fake" } })).status, 409, "another device can't finish it");
  const stranger = client(await signUp("desktopjobs-stranger@example.com"));
  assert.equal((await stranger.get("/workflows/device-jobs")).body.jobs.length, 0);
  assert.equal((await stranger.post(`/workflows/device-jobs/${first.job.id}/complete`, { ...laptop, ok: true, output: {} })).status, 404, "another account can't see or finish it");
  const done = await api.post(`/workflows/device-jobs/${first.job.id}/complete`, { ...laptop, ok: true, output: { title: "All systems operational", url: "https://status.example.com/", text: "OK" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const finished = await runToEnd(api, first.executionId);
  assert.equal(finished.execution.status, "completed", JSON.stringify(finished.execution));
  assert.deepEqual(finished.nodes.find((node) => node.name === "Keep").output.main.items[0].title, "All systems operational");
  assert.equal(finished.nodes.find((node) => node.name === "Keep").output.main.items[0].by, "Maya's laptop");
  assert.equal((await api.post(`/workflows/device-jobs/${first.job.id}/complete`, { ...laptop, ok: true, output: {} })).status, 409, "a finished job can't be reported twice");

  // The person says no on the desktop: the run fails with that reason.
  const second = await start();
  await api.post(`/workflows/device-jobs/${second.job.id}/claim`, laptop);
  await api.post(`/workflows/device-jobs/${second.job.id}/complete`, { ...laptop, ok: false, error: "You declined to open this page." });
  const declined = await runToEnd(api, second.executionId);
  assert.equal(declined.execution.status, "failed");
  assert.match(declined.execution.error, /You declined to open this page/);

  // Cancelling the run withdraws the job.
  const third = await start();
  await api.post(`/workflows/executions/${third.executionId}/cancel`);
  assert.equal((await api.post(`/workflows/device-jobs/${third.job.id}/claim`, laptop)).status, 409);

  // Nobody picks it up in time.
  const fourth = await start();
  const db = await require("./db").getDatabase();
  await db.query("UPDATE hannah_workflow_executions SET wait_until = $1 WHERE id = $2", [Date.now() - 1000, fourth.executionId]);
  await runtime.tick({ budgetMs: 10_000 });
  const expired = (await api.get(`/workflows/executions/${fourth.executionId}`)).body;
  assert.equal(expired.execution.status, "timed-out");
  assert.match(expired.execution.error, /No desktop app finished the task in time/);
  assert.equal((await api.post(`/workflows/device-jobs/${fourth.job.id}/claim`, laptop)).status, 409);

  // A coding step sends its folder and task; a single-step test is refused with a reason.
  const coding = await createWorkflow(api, "Fix the build", definition([
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: { title: "CI is red" } } },
    { id: "c", name: "Investigate", type: "device.coding", params: { folder: "hannah", task: "Find why: {{ $json.title }}", allowCommands: false } },
  ], [["t", "c"]]));
  const single = await api.post(`/workflows/${coding}/test-node`, { nodeId: "c", items: [{ title: "x" }] });
  assert.match(single.body.error, /Use Test run/);
  const codingRun = await api.post(`/workflows/${coding}/run`, {});
  await runToEnd(api, codingRun.body.executionId);
  const codingJob = (await api.get("/workflows/device-jobs")).body.jobs.find((entry) => entry.executionId === codingRun.body.executionId);
  assert.deepEqual(codingJob.input, { folder: "hannah", task: "Find why: CI is red", allowCommands: false });
});
