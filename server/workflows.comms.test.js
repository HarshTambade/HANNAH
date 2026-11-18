/**
 * Workflow communication steps against the real server, database and worker:
 * mail that needs a reply → a reply draft in the thread, and Google Chat read
 * and post (with approval). Google is a recording stand-in for its APIs; the
 * connection row is sealed with the real vault, as the OAuth callback does.
 */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workflow-comms-test-token-0123456789-abcdef";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "a".repeat(64);
process.env.WORKFLOW_WORKER = "off";

const realFetch = globalThis.fetch;
const google = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (!/googleapis\.com$/.test(url.host)) return realFetch(input, init);
  google.push({ method: init.method || "GET", url, body: init.body ? JSON.parse(init.body) : null });
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const path = `${url.host}${url.pathname}`;
  if (path === "gmail.googleapis.com/gmail/v1/users/me/threads") return reply({ threads: [{ id: "t1" }] });
  if (path === "gmail.googleapis.com/gmail/v1/users/me/threads/t1") return reply({ id: "t1", messages: [{ id: "m1", threadId: "t1", internalDate: String(Date.now()), snippet: "Can you send the deck?", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "Aman <aman@example.com>" }, { name: "Subject", value: "Deck" }] } }] });
  if (path === "gmail.googleapis.com/gmail/v1/users/me/messages/m1") return reply({ id: "m1", threadId: "t1", payload: { headers: [{ name: "From", value: "Aman <aman@example.com>" }, { name: "Subject", value: "Deck" }, { name: "Message-ID", value: "<m1@mail>" }] } });
  if (path === "gmail.googleapis.com/gmail/v1/users/me/drafts") return reply({ id: "d1" });
  if (path === "chat.googleapis.com/v1/spaces/AAA/messages" && (init.method || "GET") === "GET") return reply({ messages: [{ name: "spaces/AAA/messages/1", sender: { displayName: "Priya" }, text: "Release is Friday", createTime: "2026-11-17T08:00:00Z" }] });
  if (path === "chat.googleapis.com/v1/spaces/AAA/messages") return reply({ name: "spaces/AAA/messages/2", createTime: "2026-11-17T09:00:00Z" });
  return new Response("{}", { status: 404 });
};

let server;
let baseUrl;
let runtime;

before(async () => {
  const app = require("./index");
  runtime = app.workflowRuntime;
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  await require("./db").resetDatabase();
});

async function account(email, scopes) {
  const response = await realFetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const db = await require("./db").getDatabase();
  const { rows: [user] } = await db.query("SELECT id FROM hannah_users WHERE email = $1", [email]);
  const sealed = require("./vault").encryptSecret(JSON.stringify({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 }), { userId: user.id, providerId: "connection:google" });
  await db.query("INSERT INTO hannah_connections (user_id, provider, account_email, scopes, key_id, wrapped_key, ciphertext, created_at, updated_at) VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, $7)", [user.id, email, scopes, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, Date.now()]);
  const call = async (method, path, body) => {
    const reply = await realFetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: reply.status, body: await reply.json() };
  };
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body) };
}

const definition = (nodes, connections) => ({ format: "hannah-workflow", version: 2, nodes, connections: connections.map(([source, target]) => ({ source, target, sourceOutput: "main", targetInput: "main" })), settings: { timezone: "UTC" } });

async function runToEnd(api, executionId) {
  for (let round = 0; round < 20; round += 1) {
    await runtime.tick({ budgetMs: 10_000 });
    const { body } = await api.get(`/workflows/executions/${executionId}`);
    if (!["queued", "running"].includes(body.execution.status)) return body;
  }
  return (await api.get(`/workflows/executions/${executionId}`)).body;
}

async function publishAndRun(api, name, nodes, connections) {
  const created = await api.post("/workflows", { name, definition: definition(nodes, connections) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const published = await api.post(`/workflows/${created.body.workflow.id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const run = await api.post(`/workflows/${created.body.workflow.id}/run`, {});
  return { executionId: run.body.executionId, permissions: published.body.permissions.map((entry) => entry.permission) };
}

const CHAT = "https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.messages.create";

test("email steps: conversations needing a reply become reply drafts in their threads", async () => {
  const api = await account("wf-mail@example.com", "openid email https://www.googleapis.com/auth/gmail.modify");
  const { executionId, permissions } = await publishAndRun(api, "Follow up", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } },
    { id: "n", name: "Needs reply", type: "action.email", params: { mode: "needs-reply", provider: "google", days: 3 } },
    { id: "r", name: "Draft reply", type: "action.email", params: { mode: "reply-draft", provider: "google", messageId: "{{ $json.id }}", replyBody: "Hi {{ $json.from }}, sending it today." } },
  ], [["t", "n"], ["n", "r"]]);
  assert.ok(permissions.includes("read-email") && permissions.includes("send-email"));
  const detail = await runToEnd(api, executionId);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  const draft = detail.nodes.find((node) => node.name === "Draft reply").output.main.items[0].draft;
  assert.deepEqual(draft, { provider: "google", id: "d1", threadId: "t1", to: "aman@example.com", cc: [], link: "https://mail.google.com/mail/u/0/#drafts", sent: false });
  const posted = google.find((call) => call.url.pathname.endsWith("/drafts"));
  assert.equal(posted.body.message.threadId, "t1");
  const [headers, encoded] = Buffer.from(posted.body.message.raw, "base64url").toString().split("\r\n\r\n");
  assert.match(headers, /In-Reply-To: <m1@mail>/);
  assert.equal(Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString(), "Hi Aman <aman@example.com>, sending it today.");
  assert.match(google.find((call) => call.url.pathname.endsWith("/threads")).url.searchParams.get("q"), /newer_than:3d/);
});

test("Google Chat step: reads a space; posting waits for approval; without the Chat permission it fails clearly", async () => {
  const api = await account("wf-chat@example.com", `openid email ${CHAT}`);
  const { executionId } = await publishAndRun(api, "Chat digest", [
    { id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } },
    { id: "r", name: "Read", type: "action.gchat", params: { operation: "read", space: "spaces/AAA", max: 10 } },
    { id: "s", name: "Post", type: "action.gchat", params: { operation: "send", space: "spaces/AAA", text: "Noted: {{ $json.transcript }}" } },
  ], [["t", "r"], ["r", "s"]]);
  let detail = await runToEnd(api, executionId);
  assert.equal(detail.execution.status, "waiting-approval", JSON.stringify(detail.execution));
  assert.match(detail.execution.waiting.message, /Post in Google Chat as you/);
  assert.equal(google.some((call) => call.method === "POST" && call.url.host === "chat.googleapis.com"), false, "nothing is posted before the approval");
  assert.equal(detail.nodes.find((node) => node.name === "Read").output.main.items[0].transcript, "Priya: Release is Friday");
  await api.post(`/workflows/executions/${executionId}/resume`, { approved: true });
  detail = await runToEnd(api, executionId);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  assert.deepEqual(google.filter((call) => call.method === "POST" && call.url.host === "chat.googleapis.com").at(-1).body, { text: "Noted: Priya: Release is Friday" });

  const noChat = await account("wf-nochat@example.com", "openid email");
  const failed = await runToEnd(noChat, (await publishAndRun(noChat, "Chat", [{ id: "t", name: "Start", type: "trigger.manual", params: { sample: {} } }, { id: "r", name: "Read", type: "action.gchat", params: { operation: "read", space: "spaces/AAA" } }], [["t", "r"]])).executionId);
  assert.equal(failed.execution.status, "failed");
  assert.match(failed.execution.error, /Also connect Google Chat/);
});
