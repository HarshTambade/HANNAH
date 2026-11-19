/**
 * "Every Monday, research X, make a PDF and tell me": the research and
 * document steps on the real workflow engine, database and worker. They call
 * the same research engine and Document Studio as chat; only the AI provider
 * and the web are stand-ins here.
 */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workflow-studio-test-token-0123456789-abcdef";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);
process.env.WORKFLOW_WORKER = "off";
delete process.env.HANNAH_ACCOUNTS_USE_SERVER_KEYS;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith("https://api.groq.com/")) return realFetch(input, init);
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/models")) return reply({ data: [{ id: "openai/gpt-oss-120b" }, { id: "openai/gpt-oss-20b" }] });
  const body = JSON.parse(init.body || "{}");
  const system = body.messages.find((message) => message.role === "system")?.content || "";
  let content = { reply: "ok" };
  if (/You plan web research/.test(system)) content = { subquestions: [], queries: ["AI agent frameworks news"] };
  else if (/research analyst/.test(system)) content = { answer: "The Agent Protocol working group published version 2 of its specification this week [1].", summary: "Agent Protocol 2 was published [1].", findings: [{ claim: "Agent Protocol 2 was published", citations: [1], basis: "reported" }] };
  else if (/You plan a (presentation|report)/.test(system)) content = { title: "AI agents this week", subtitle: "Weekly summary", theme: "slate", sections: [{ heading: "What happened", purpose: "The protocol release", visual: "none" }, { heading: "Why it matters", purpose: "Interoperability", visual: "none" }] };
  else if (/You write/.test(system)) content = { sections: [{ heading: "What happened", blocks: [{ type: "paragraph", text: "The Agent Protocol working group published version 2 of its specification [1]." }] }, { heading: "Why it matters", blocks: [{ type: "bullets", items: ["Agents from different vendors can call each other", "Tooling can target one interface"] }] }] };
  return reply({ model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
};

let server;
let baseUrl;
let runtime;
let online = true;
before(async () => {
  const app = require("./index");
  runtime = app.workflowRuntime;
  // The web, for this test: one search provider and one page.
  runtime.researchConfig.providers = [{ id: "web", label: "Test search", kind: "web", available: () => true, search: async () => { if (!online) throw Object.assign(new Error("rate limited"), { rateLimited: true, retryAfter: 900 }); return [{ title: "Agent Protocol 2 released", url: "https://agents.example.org/protocol-2", snippet: "agent protocol version 2 published" }]; } }];
  runtime.researchConfig.request = async (url) => (url.endsWith("/protocol-2")
    ? { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><head><title>Agent Protocol 2 released</title><meta name=\"date\" content=\"2026-11-17\"></head><body><main><p>The Agent Protocol working group published version 2 of its specification this week, adding streaming task updates and a standard way for agents built by different vendors to discover and call each other.</p><p>Maintainers of several agent frameworks said they would adopt the new version in their next releases.</p></main></body></html>"), url }
    : { status: 404, headers: {}, body: Buffer.from(""), url });
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
  return { cookie, get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body) };
}

const definition = (nodes, connections) => ({ format: "hannah-workflow", version: 2, nodes, connections: connections.map(([source, target]) => ({ source, target, sourceOutput: "main", targetInput: "main" })), settings: { timezone: "UTC" } });
const nodes = [
  { id: "t", name: "Every Monday", type: "trigger.schedule", params: { mode: "weekly", days: [1], time: "08:00" } },
  { id: "r", name: "Research", type: "research.run", params: { question: "What are the latest developments in AI agents this week?", mode: "latest" } },
  { id: "d", name: "Report", type: "document.create", params: { request: "A one-page summary of this week's developments in AI agents", format: "pdf" } },
  { id: "n", name: "Tell me", type: "action.notify", params: { title: "Your weekly AI agents report is ready", body: "{{ $json.file.name }} ({{ $json.sources.length }} source)" } },
];

async function run(api) {
  const created = await api.post("/workflows", { name: "Weekly AI agents report", definition: definition(nodes, [["t", "r"], ["r", "d"], ["d", "n"]]) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const published = await api.post(`/workflows/${created.body.workflow.id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const started = await api.post(`/workflows/${created.body.workflow.id}/run`, {});
  for (let round = 0; round < 20; round += 1) {
    await runtime.tick({ budgetMs: 10_000 });
    const { body } = await api.get(`/workflows/executions/${started.body.executionId}`);
    if (!["queued", "running"].includes(body.execution.status)) return body;
  }
  return (await api.get(`/workflows/executions/${started.body.executionId}`)).body;
}

test("the step catalog offers Research a question and Create a document", async () => {
  const api = await account("wf-studio-catalog@example.com");
  const { body } = await api.get("/workflows/catalog");
  for (const type of ["research.run", "document.create"]) assert.ok(body.nodes.some((node) => node.type === type && node.status === "available"), type);
});

test("a scheduled research report: researched, written, validated, kept in the account's files, and announced", async () => {
  const api = await account("wf-studio@example.com", "gsk_studioWorkflowKey0123456789abcdefghij");
  const detail = await run(api);
  assert.equal(detail.execution.status, "completed", JSON.stringify(detail.execution).slice(0, 600));
  // Every step is in the run's history with what it produced.
  assert.deepEqual(detail.nodes.map((node) => [node.name, node.status]), [["Every Monday", "done"], ["Research", "done"], ["Report", "done"], ["Tell me", "done"]]);
  const research = detail.nodes.find((node) => node.name === "Research").output.main.items[0];
  assert.match(research.answer, /version 2 of its specification this week \[1\]/);
  assert.deepEqual(research.sources, [{ n: 1, title: "Agent Protocol 2 released", url: "https://agents.example.org/protocol-2", published: "2026-11-17" }]);
  const report = detail.nodes.find((node) => node.name === "Report").output.main.items[0];
  assert.equal(report.file.format, "pdf");
  assert.equal(report.file.name, "AI agents this week.pdf");
  assert.equal(report.research, undefined, "the bulky research record isn't carried past the step that used it");
  // The file is in the account, downloadable, and is a real PDF that cites the research's source.
  const download = await realFetch(`${baseUrl}${report.file.download}`, { headers: { Cookie: api.cookie } });
  assert.equal(download.status, 200);
  const pdf = Buffer.from(await download.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const { readFile } = require("./documents/read");
  const text = (await readFile(pdf, "report.pdf")).text;
  assert.match(text, /Agent Protocol working group published version 2/);
  assert.match(text, /References[\s\S]*Agent Protocol 2 released[\s\S]*https:\/\/agents\.example\.org\/protocol-2/);
  const files = (await api.get("/account/documents")).body.documents;
  assert.equal(files.length, 1);
  assert.match(files[0].source, /^workflow:/);
  // The research is in the account's history too.
  assert.equal((await api.get("/account/research")).body.research.length, 1);
  const notifications = (await api.get("/notifications")).body.notifications;
  assert.ok(notifications.some((item) => item.title === "Your weekly AI agents report is ready" && item.body === "AI agents this week.pdf (1 source)"), JSON.stringify(notifications));
});

test("when the research can't be done, the run fails and says why; no empty report is made", async () => {
  const api = await account("wf-studio-fail@example.com", "gsk_studioWorkflowKey0123456789abcdefghij");
  online = false;
  const detail = await run(api);
  online = true;
  assert.equal(detail.execution.status, "failed");
  assert.match(JSON.stringify(detail.execution), /couldn't research this: none of the \d+ searches could run \(rate limited\)/);
  assert.equal(detail.nodes.find((node) => node.name === "Report")?.status ?? "not run", "not run");
  assert.deepEqual((await api.get("/account/documents")).body.documents, []);
});

test("without any AI key the research step says what to add", async () => {
  const api = await account("wf-studio-nokey@example.com");
  const detail = await run(api);
  assert.equal(detail.execution.status, "failed");
  assert.match(JSON.stringify(detail.execution), /Save your Groq key|No AI provider key/);
});
