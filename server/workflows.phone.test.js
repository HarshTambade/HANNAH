/**
 * Workflow steps that use the HANNAH Phone Bridge, against the real server,
 * database, workflow worker and Phone Bridge routes. The "phone" signs its
 * requests exactly as the app does (WebCrypto ECDSA P-256 over id, time,
 * method, path and the body's SHA-256), so these runs go through the same
 * pairing, capability, online, expiry and nonce checks as a chat request.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workflow-phone-test-token-0123456789-abcdef";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.WORKFLOW_WORKER = "off";

let server;
let baseUrl;
let runtime;

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  runtime = app.workflowRuntime;
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await require("./db").resetDatabase();
});

async function signUp(email) {
  const response = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get("set-cookie").split(";")[0];
}

function client(cookie) {
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body) };
}

async function makePhone(cookie, platform = "android") {
  const keys = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const phone = { id: null };
  phone.signed = async (method, path, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const at = Date.now();
    const message = `${phone.id}\n${at}\n${method}\n/api${path}\n${crypto.createHash("sha256").update(text).digest("hex")}`;
    const signature = Buffer.from(await crypto.webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(message))).toString("base64url");
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie, "X-Hannah-Phone": phone.id, "X-Hannah-Time": String(at), "X-Hannah-Signature": signature }, body: body === undefined ? undefined : text });
    return { status: response.status, body: await response.json() };
  };
  phone.pair = async (code, capabilities, name) => {
    const response = await fetch(`${baseUrl}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ code, platform, name, publicKey, capabilities }) });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    phone.id = body.phone.id;
  };
  phone.fetch = () => phone.signed("POST", "/phone/me/commands", {});
  phone.report = (command, status, extra = {}) => phone.signed("POST", `/phone/me/commands/${command.id}/result`, { nonce: command.nonce, status, ...extra });
  return phone;
}

const definition = (nodes, connections) => ({ format: "hannah-workflow", version: 2, nodes, connections: connections.map(([source, target, sourceOutput = "main"]) => ({ source, target, sourceOutput, targetInput: "main" })), settings: { timezone: "UTC" } });

async function runToEnd(api, executionId, rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    await runtime.tick({ budgetMs: 10_000 });
    const { body } = await api.get(`/workflows/executions/${executionId}`);
    if (!["queued", "running"].includes(body.execution.status)) return body;
  }
  return (await api.get(`/workflows/executions/${executionId}`)).body;
}

async function setup(email, platform = "android") {
  const cookie = await signUp(email);
  const api = client(cookie);
  const phone = await makePhone(cookie, platform);
  const { body: { code } } = await api.post("/phone/pairing", { deviceName: "MacBook" });
  await phone.pair(code, ["call", "sms", "contacts"], platform === "ios" ? "iPhone 15" : "Pixel 8");
  return { api, phone };
}

async function publish(api, name, nodes, connections) {
  const created = await api.post("/workflows", { name, definition: definition(nodes, connections) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.workflow.id;
  const published = await api.post(`/workflows/${id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return { id, permissions: published.body.permissions.map((entry) => entry.permission) };
}

test("phone steps: look up a contact, approve, the phone's dialer opens, and only what the phone reported is recorded", async () => {
  const { api, phone } = await setup("wf-phone@example.com");
  const { id, permissions } = await publish(api, "Call Aman", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: { contact: "Aman" } } },
    { id: "s", name: "Phones", type: "phone.status" },
    { id: "f", name: "Find", type: "phone.lookup", params: { name: "{{ $json.contact }}" } },
    { id: "l", name: "First number", type: "logic.limit", params: { max: 1 } },
    { id: "c", name: "Call", type: "phone.call", params: { number: "{{ $json.number }}", name: "{{ $json.contact }}" } },
  ], [["t", "s"], ["s", "f"], ["f", "l"], ["l", "c"]]);
  assert.ok(["phone-read", "phone-contacts", "phone-call"].every((permission) => permissions.includes(permission)), permissions.join(","));

  const run = await api.post(`/workflows/${id}/run`, {});
  let detail = await runToEnd(api, run.body.executionId);
  assert.equal(detail.execution.status, "waiting", JSON.stringify(detail.execution));
  assert.equal(detail.execution.waiting.kind, "phone");
  assert.match(detail.execution.waiting.message, /Pixel 8 to look up “Aman”/);
  const status = detail.nodes.find((node) => node.name === "Phones").output.main.items[0];
  assert.equal(status.anyOnline, true);
  assert.equal(status.defaultPhone.name, "Pixel 8");

  // The phone picks up the lookup and answers with what it found on the phone.
  const { body: { commands: [lookup] } } = await phone.fetch();
  assert.equal(lookup.action, "lookup");
  assert.deepEqual(lookup.payload, { query: "Aman" });
  const reported = await phone.report(lookup, "resolved", { matches: [{ name: "Aman Gupta", numbers: [{ label: "mobile", number: "+91 98765 43210" }, { label: "work", number: "+91 22 5550 1234" }] }] });
  assert.equal(reported.status, 200, JSON.stringify(reported.body));

  // Calling waits for approval on this run, then reaches the phone.
  detail = await runToEnd(api, run.body.executionId);
  assert.equal(detail.execution.status, "waiting-approval", JSON.stringify(detail.execution));
  assert.match(detail.execution.waiting.message, /Call on your phone/);
  assert.equal((await phone.fetch()).body.commands.length, 0, "nothing reaches the phone before the approval");
  await api.post(`/workflows/executions/${run.body.executionId}/resume`, { approved: true });
  detail = await runToEnd(api, run.body.executionId);
  assert.equal(detail.execution.status, "waiting");
  const { body: { commands: [call] } } = await phone.fetch();
  assert.equal(call.action, "call");
  assert.deepEqual(call.payload, { number: "+919876543210", name: "Aman Gupta" });
  assert.equal((await phone.fetch()).body.commands.length, 0, "a request is handed out once");
  await phone.report(call, "dialer-opened");
  detail = await runToEnd(api, run.body.executionId);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  const out = detail.nodes.find((node) => node.name === "Call").output.main.items[0];
  assert.equal(out.call, "dialer-opened");
  assert.equal(out.phoneRequest.status, "dialer-opened");
  assert.equal((await phone.report(call, "dialer-opened")).status, 409, "a result is accepted once");

  // The phone's own history shows the workflow's requests.
  const { body: { commands } } = await api.get("/phone/commands");
  assert.deepEqual(commands.slice(0, 2).map((command) => [command.action, command.status, command.requestedBy]), [["call", "dialer-opened", "A workflow"], ["lookup", "resolved", "A workflow"]]);
});

test("phone steps: denial, a declined SMS, an offline phone and an unanswered request never reach or act on the phone later", async () => {
  const { api, phone } = await setup("wf-phone-2@example.com", "ios");
  const { id } = await publish(api, "Text Mum", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: { number: "+44 7700 900123" } } },
    { id: "m", name: "Text", type: "phone.sms", params: { number: "{{ $json.number }}", name: "Mum", message: "Running 20 minutes late" } },
  ], [["t", "m"]]);
  await phone.fetch(); // online

  // Denied: nothing is sent to the phone.
  const denied = await api.post(`/workflows/${id}/run`, {});
  await runToEnd(api, denied.body.executionId);
  await api.post(`/workflows/executions/${denied.body.executionId}/resume`, { approved: false });
  const deniedDetail = await runToEnd(api, denied.body.executionId);
  assert.equal(deniedDetail.execution.status, "cancelled");
  assert.equal((await phone.fetch()).body.commands.length, 0);

  // Approved; the composer opens on the iPhone and the person cancels there: the run fails with that.
  const cancelled = await api.post(`/workflows/${id}/run`, {});
  await runToEnd(api, cancelled.body.executionId);
  await api.post(`/workflows/executions/${cancelled.body.executionId}/resume`, { approved: true });
  await runToEnd(api, cancelled.body.executionId);
  const { body: { commands: [sms] } } = await phone.fetch();
  assert.deepEqual(sms.payload, { number: "+447700900123", name: "Mum", body: "Running 20 minutes late" });
  await phone.report(sms, "composer-opened");
  let detail = await runToEnd(api, cancelled.body.executionId);
  assert.equal(detail.execution.status, "waiting", "an iPhone reports Send or Cancel after the composer, so the run keeps waiting");
  await phone.report(sms, "cancelled");
  detail = await runToEnd(api, cancelled.body.executionId);
  assert.equal(detail.execution.status, "failed");
  assert.match(detail.execution.error, /cancelled on the phone/);

  // Sent on the iPhone: the run completes with "sent".
  const sent = await api.post(`/workflows/${id}/run`, {});
  await runToEnd(api, sent.body.executionId);
  await api.post(`/workflows/executions/${sent.body.executionId}/resume`, { approved: true });
  await runToEnd(api, sent.body.executionId);
  const { body: { commands: [second] } } = await phone.fetch();
  await phone.report(second, "composer-opened");
  await phone.report(second, "sent");
  detail = await runToEnd(api, sent.body.executionId);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  assert.equal(detail.nodes.find((node) => node.name === "Text").output.main.items[0].sms, "sent");

  // The phone isn't picking up: the request expires and the run times out; the phone never gets it later.
  const unanswered = await api.post(`/workflows/${id}/run`, {});
  await runToEnd(api, unanswered.body.executionId);
  await api.post(`/workflows/executions/${unanswered.body.executionId}/resume`, { approved: true });
  await runToEnd(api, unanswered.body.executionId);
  const db = await require("./db").getDatabase();
  await db.query("UPDATE hannah_phone_commands SET expires_at = $1 WHERE execution_id = $2", [Date.now() - 1000, unanswered.body.executionId]);
  await db.query("UPDATE hannah_workflow_executions SET wait_until = $1 WHERE id = $2", [Date.now() - 1000, unanswered.body.executionId]);
  await runtime.tick({ budgetMs: 10_000 });
  detail = (await api.get(`/workflows/executions/${unanswered.body.executionId}`)).body;
  assert.equal(detail.execution.status, "timed-out");
  assert.match(detail.execution.error, /Nothing will happen on the phone later/);
  assert.equal((await phone.fetch()).body.commands.length, 0, "an expired request is never handed out");

  // Offline phone: the approved step fails at once and nothing is queued.
  await db.query("UPDATE hannah_paired_phones SET last_seen_at = $1 WHERE id = $2", [Date.now() - 10 * 60_000, phone.id]);
  const offline = await api.post(`/workflows/${id}/run`, {});
  await runToEnd(api, offline.body.executionId);
  await api.post(`/workflows/executions/${offline.body.executionId}/resume`, { approved: true });
  detail = await runToEnd(api, offline.body.executionId);
  assert.equal(detail.execution.status, "failed");
  assert.match(detail.execution.error, /offline/);
  const { rows } = await db.query("SELECT COUNT(*) AS n FROM hannah_phone_commands WHERE execution_id = $1", [offline.body.executionId]);
  assert.equal(Number(rows[0].n), 0);
});

test("phone steps: a phone that answers before the run is saved as waiting still resumes it; other accounts' phones are never used", async () => {
  const { api, phone } = await setup("wf-phone-3@example.com");
  const { id } = await publish(api, "Who is Aman", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } },
    { id: "f", name: "Find", type: "phone.lookup", params: { name: "Aman" } },
  ], [["t", "f"]]);
  const run = await api.post(`/workflows/${id}/run`, {});
  await runToEnd(api, run.body.executionId);
  // Simulate the race: the phone's report lands while the run isn't marked waiting, so the hook can't resume it.
  const db = await require("./db").getDatabase();
  await db.query("UPDATE hannah_workflow_executions SET status = 'running' WHERE id = $1", [run.body.executionId]);
  const { body: { commands: [lookup] } } = await phone.fetch();
  await phone.report(lookup, "resolved", { matches: [{ name: "Aman", numbers: [{ label: null, number: "+15550100" }] }] });
  await db.query("UPDATE hannah_workflow_executions SET status = 'waiting', wait_until = $1 WHERE id = $2", [Date.now() - 1000, run.body.executionId]);
  const detail = await runToEnd(api, run.body.executionId);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  assert.equal(detail.nodes.find((node) => node.name === "Find").output.main.items[0].number, "+15550100");

  // Another account with no phone: its phone step fails; it never reaches this account's phone.
  const other = client(await signUp("wf-phone-other@example.com"));
  const created = await other.post("/workflows", { name: "Sneaky", definition: definition([{ id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } }, { id: "f", name: "Find", type: "phone.lookup", params: { name: "Aman" } }], [["t", "f"]]) });
  await other.post(`/workflows/${created.body.workflow.id}/publish`);
  const sneaky = await other.post(`/workflows/${created.body.workflow.id}/run`, {});
  const result = await runToEnd(other, sneaky.body.executionId);
  assert.equal(result.execution.status, "failed");
  assert.match(result.execution.error, /No phone is paired/);
  assert.equal((await phone.fetch()).body.commands.length, 0);
});

test("desktop open step: one job with the app, project and links; bad links are refused before anything is queued", async () => {
  const { api } = await setup("wf-open@example.com");
  const { id } = await publish(api, "Morning startup", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } },
    { id: "o", name: "Open work", type: "device.open", params: { app: "Visual Studio Code", folder: "hannah", urls: ["https://github.com/", "https://mail.google.com/"], notify: true } },
  ], [["t", "o"]]);
  const run = await api.post(`/workflows/${id}/run`, {});
  const detail = await runToEnd(api, run.body.executionId);
  assert.equal(detail.execution.status, "waiting");
  assert.match(detail.execution.waiting.message, /Visual Studio Code, https:\/\/github.com\//);
  const job = (await api.get("/workflows/device-jobs")).body.jobs.find((entry) => entry.executionId === run.body.executionId);
  assert.equal(job.kind, "open");
  assert.deepEqual(job.input, { app: "Visual Studio Code", folder: "hannah", urls: ["https://github.com/", "https://mail.google.com/"], notify: true });
  const device = { deviceId: "laptop-0123456789", deviceName: "MacBook" };
  await api.post(`/workflows/device-jobs/${job.id}/claim`, device);
  await api.post(`/workflows/device-jobs/${job.id}/complete`, { ...device, ok: true, output: { steps: [{ step: "Open Visual Studio Code with hannah", ok: true, verified: true }] } });
  const done = await runToEnd(api, run.body.executionId);
  assert.equal(done.execution.status, "completed");
  assert.equal(done.nodes.find((node) => node.name === "Open work").output.main.items[0].opened[0].verified, true);

  const bad = await publish(api, "Bad link", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } },
    { id: "o", name: "Open", type: "device.open", params: { urls: ["file:///etc/passwd"] } },
  ], [["t", "o"]]);
  const badRun = await api.post(`/workflows/${bad.id}/run`, {});
  const badDetail = await runToEnd(api, badRun.body.executionId);
  assert.equal(badDetail.execution.status, "failed");
  assert.match(badDetail.execution.error, /Only http and https/);
  assert.equal((await api.get("/workflows/device-jobs")).body.jobs.some((entry) => entry.executionId === badRun.body.executionId), false);
});
