"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const express = require("express");
const { createWebRouter, sourcesFrom } = require("./web");

process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = "true";
let groqRequests = [];
let groqReply = { status: 200, body: {} };
let site;
let siteUrl;
let server;
let api;

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>Release notes</title><style>.x{}</style></head><body><nav>Home · Docs</nav><main><h1>Version 2</h1><p>Adds <b>dark mode</b> &amp; faster sync.</p><script>steal()</script></main><footer>©</footer></body></html>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  const fakeFetch = async (url, init) => {
    groqRequests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    // An array of replies answers one request each, in order.
    const reply = Array.isArray(groqReply) ? groqReply.shift() : groqReply;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  const getRequestProvider = (req) => {
    const key = req.get("x-groq-api-key");
    if (!key) throw Object.assign(new Error("Add your Groq API key."), { status: 401 });
    return { provider: { baseUrl: "https://api.groq.com/openai/v1" }, apiKey: key };
  };
  const app = express();
  app.use("/api", createWebRouter({ getRequestProvider, fetchImpl: fakeFetch }));
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { site?.close(); server?.close(); });

const post = async (path, body, headers = {}) => {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test("web search asks Groq's browser search with the visitor's own key and returns the answer and sources", async () => {
  groqReply = { status: 200, body: { model: "openai/gpt-oss-20b", choices: [{ message: { content: "Node.js 24 is the current LTS【1†L2】. Source: https://nodejs.org/en/about/previous-releases.", executed_tools: [{ type: "browser_search", search_results: { results: [{ title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases" }, { title: "Endoflife", url: "https://endoflife.date/nodejs" }] } }] } }] } };
  const answer = await post("/web/search", { query: "current Node.js LTS" }, { "X-Groq-API-Key": "gsk_visitor" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  // Groq's own reference codes (【1†L2】) are removed: they point at nothing the reader can open.
  assert.equal(answer.body.answer, "Node.js 24 is the current LTS. Source: https://nodejs.org/en/about/previous-releases.");
  assert.deepEqual(answer.body.sources, [{ title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases" }, { title: "Endoflife", url: "https://endoflife.date/nodejs" }]);
  const sent = groqRequests.at(-1);
  assert.equal(sent.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer gsk_visitor");
  assert.deepEqual(sent.body.tools, [{ type: "browser_search" }]);
  assert.equal(sent.body.tool_choice, "required");
  assert.match(sent.body.model, /^openai\/gpt-oss/);
  assert.equal(sent.body.messages.at(-1).content, "current Node.js LTS");
});

test("web search without a key, with Groq busy, or with nothing found says so", async () => {
  assert.equal((await post("/web/search", { query: "x" })).status, 401);
  assert.equal((await post("/web/search", { query: "" }, { "X-Groq-API-Key": "gsk_v" })).status, 400);
  groqReply = { status: 429, body: { error: { message: "rate limit" } } };
  const busy = await post("/web/search", { query: "news" }, { "X-Groq-API-Key": "gsk_v" });
  assert.equal(busy.status, 429);
  assert.match(busy.body.error, /busy/);
  groqReply = { status: 200, body: { choices: [{ message: { content: "" } }] } };
  assert.equal((await post("/web/search", { query: "news" }, { "X-Groq-API-Key": "gsk_v" })).body.reason, "empty");
});

test("cited URLs are used as sources when Groq lists none", () => {
  assert.deepEqual(sourcesFrom({ content: "See https://example.com/a. And https://example.com/a again, plus (https://docs.example.org/b)." }), [{ title: "example.com", url: "https://example.com/a" }, { title: "docs.example.org", url: "https://docs.example.org/b" }]);
});

test("reading a page returns its title and readable text, without scripts, styles or navigation", async () => {
  const page = await post("/web/read", { url: `${siteUrl}/notes` });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.title, "Release notes");
  assert.equal(page.body.text, "# Version 2\nAdds dark mode & faster sync.");
  assert.equal(page.body.truncated, false);
  assert.equal((await post("/web/read", { url: `${siteUrl}/pdf` })).status, 415);
  delete process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK;
  try {
    for (const url of [`${siteUrl}/notes`, "http://169.254.169.254/latest/meta-data/", "http://localhost/"]) {
      const blocked = await post("/web/read", { url });
      assert.equal(blocked.status, 400, url);
      assert.equal(blocked.body.reason, "blocked");
    }
  } finally {
    process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = "true";
  }
});

test("a search that fails on the first model is tried once more on the second", async () => {
  groqRequests = [];
  groqReply = [
    { status: 500, body: { error: { message: "internal" } } },
    { status: 200, body: { model: "openai/gpt-oss-120b", choices: [{ message: { content: "Go 1.25 is current. https://go.dev/doc/devel/release" } }] } },
  ];
  const response = await fetch(`${api}/web/search`, { method: "POST", headers: { "Content-Type": "application/json", "X-Groq-API-Key": "gsk_test" }, body: JSON.stringify({ query: "latest go" }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.answer, /Go 1.25/);
  assert.deepEqual(groqRequests.map((request) => request.body.model), ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
});

test("a rate-limited search answers 429 right away instead of trying the other model", async () => {
  groqRequests = [];
  groqReply = [{ status: 429, body: {} }, { status: 200, body: { choices: [{ message: { content: "unused" } }] } }];
  const response = await fetch(`${api}/web/search`, { method: "POST", headers: { "Content-Type": "application/json", "X-Groq-API-Key": "gsk_test" }, body: JSON.stringify({ query: "latest go" }) });
  assert.equal(response.status, 429);
  assert.equal(groqRequests.length, 1);
});

test("when every search model fails, the last error is reported", async () => {
  groqRequests = [];
  groqReply = [{ status: 503, body: {} }, { status: 500, body: {} }];
  const response = await fetch(`${api}/web/search`, { method: "POST", headers: { "Content-Type": "application/json", "X-Groq-API-Key": "gsk_test" }, body: JSON.stringify({ query: "latest go" }) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Groq answered 500/);
});
