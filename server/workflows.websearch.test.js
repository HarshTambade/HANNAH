/**
 * The "Search the web" workflow step against the real server, database and
 * worker, with Groq's browser search played by a recording stand-in.
 */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workflow-search-test-token-0123456789-abcdef";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "b".repeat(64);
process.env.WORKFLOW_WORKER = "off";
delete process.env.HANNAH_ACCOUNTS_USE_SERVER_KEYS;

const realFetch = globalThis.fetch;
const searches = [];
let searchStatus = 200;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.groq.com/")) return realFetch(input, init);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/models")) return reply({ data: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }] });
  const body = JSON.parse(init.body || "{}");
  if ((body.tools || []).some((tool) => tool.type === "browser_search")) {
    searches.push({ query: body.messages.at(-1).content, auth: init.headers.Authorization });
    if (searchStatus !== 200) return reply({ error: { message: "busy" } }, searchStatus);
    return reply({ model: body.model, choices: [{ message: { content: "1. Chip launch (https://news.example.org/chips)", executed_tools: [{ search_results: { results: [{ url: "https://news.example.org/chips", title: "Chip launch" }] } }] } }] });
  }
  return reply({ choices: [{ message: { content: "ok" } }] });
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

async function account(email, groqKey) {
  const response = await realFetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const call = async (method, path, body) => {
    const reply = await realFetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: reply.status, body: await reply.json().catch(() => ({})) };
  };
  if (groqKey) assert.equal((await call("PUT", "/account/credentials/groq", { apiKey: groqKey })).status, 200);
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body) };
}

const definition = (nodes, connections) => ({ format: "hannah-workflow", version: 2, nodes, connections: connections.map(([source, target]) => ({ source, target, sourceOutput: "main", targetInput: "main" })), settings: { timezone: "UTC" } });

async function run(api, nodes, connections) {
  const created = await api.post("/workflows", { name: "News", definition: definition(nodes, connections) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api.post(`/workflows/${created.body.workflow.id}/publish`)).status, 200);
  const started = await api.post(`/workflows/${created.body.workflow.id}/run`, {});
  for (let round = 0; round < 20; round += 1) {
    await runtime.tick({ budgetMs: 10_000 });
    const { body } = await api.get(`/workflows/executions/${started.body.executionId}`);
    if (!["queued", "running"].includes(body.execution.status)) return body;
  }
  return (await api.get(`/workflows/executions/${started.body.executionId}`)).body;
}

const nodes = [
  { id: "t", name: "Start", type: "trigger.manual", params: { sample: { topic: "chips" } } },
  { id: "s", name: "News", type: "web.search", params: { query: "Latest {{ $json.topic }} news" } },
];

test("the step catalog offers Search the web", async () => {
  const api = await account("wf-search-catalog@example.com");
  const { body } = await api.get("/workflows/catalog");
  assert.ok(body.nodes.some((node) => node.type === "web.search" && node.status === "available"));
});

test("Search the web runs with the account's Groq key and returns the answer with its sources", async () => {
  const api = await account("wf-search@example.com", "gsk_searchTestKey0123456789abcdefghijklm");
  const detail = await run(api, nodes, [["t", "s"]]);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution));
  const item = detail.nodes.find((node) => node.name === "News").output.main.items[0];
  assert.match(item.answer, /Chip launch/);
  assert.deepEqual(item.sources, [{ url: "https://news.example.org/chips", title: "Chip launch" }]);
  assert.equal(item.topic, "chips");
  assert.equal(searches.at(-1).query, "Latest chips news");
  assert.equal(searches.at(-1).auth, "Bearer gsk_searchTestKey0123456789abcdefghijklm");
});

test("without a Groq key the step fails with what to do", async () => {
  const api = await account("wf-search-nokey@example.com");
  const detail = await run(api, nodes, [["t", "s"]]);
  assert.equal(detail.execution.status, "failed");
  assert.match(JSON.stringify(detail.execution), /save your Groq key/);
});
