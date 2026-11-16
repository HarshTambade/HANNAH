const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "a2a-test-token-0123456789-abcdefghijklmnopqrs";
delete process.env.DATABASE_URL;

let lastSystem = "";
const fake = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  lastSystem = body.messages?.[0]?.content || "";
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ reply: `A2A says: ${body.messages.at(-1).content}`, emotion: "happy" }) } }], usage: { prompt_tokens: 3, completion_tokens: 3 } }));
});

let server;
let baseUrl;
const headers = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}`, "Content-Type": "application/json" };

before(async () => {
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.CUSTOM_MODEL = "test-model";
  process.env.HANNAH_DEFAULT_PROVIDER = "custom";
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fake.close();
});

const rpc = (payload, extra = headers) => fetch(`${baseUrl}/api/a2a`, { method: "POST", headers: extra, body: JSON.stringify(payload) }).then((r) => r.json());

test("the agent card is public and points at the JSON-RPC endpoint", async () => {
  const card = await fetch(`${baseUrl}/.well-known/agent-card.json`).then((r) => r.json());
  assert.equal(card.name, "HANNAH");
  assert.equal(card.preferredTransport, "JSONRPC");
  assert.equal(card.url, `${baseUrl}/api/a2a`);
  assert.equal(card.skills[0].id, "conversation");
  const same = await fetch(`${baseUrl}/api/a2a/agent-card`).then((r) => r.json());
  assert.deepEqual(same, card);
});

test("message/send answers with an agent message", async () => {
  const body = await rpc({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", contextId: "c1", parts: [{ kind: "text", text: "hello" }] } } });
  assert.equal(body.id, 1);
  assert.equal(body.result.kind, "message");
  assert.equal(body.result.role, "agent");
  assert.equal(body.result.contextId, "c1");
  assert.equal(body.result.parts[0].text, "A2A says: hello");
  assert.match(lastSystem, /another AI agent over A2A/);
});

test("unsupported methods, parts and missing credentials are refused", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 2, method: "tasks/resubscribe" })).error.code, -32601);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { role: "user", parts: [{ kind: "file", file: {} }] } } })).error.code, -32005);
  const anonymous = await fetch(`${baseUrl}/api/a2a`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 401);
});
