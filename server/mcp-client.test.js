const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");
const express = require("express");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "mcp-client-test-token-0123456789-abcdefghij";
delete process.env.DATABASE_URL;
const MCP_TOKEN = "mcp-remote-test-token-0123456789-abcdefghijk";

let server;
let mcpServer;
let baseUrl;
const operator = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}`, "Content-Type": "application/json" };

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // HANNAH's own MCP server is the remote server here: a real Streamable HTTP implementation.
  process.env.HANNAH_API_URL = baseUrl;
  const { mountHANNAHMcpEndpoint } = await import("./mcp-http.mjs");
  const remote = express();
  remote.use(express.json());
  mountHANNAHMcpEndpoint(remote, MCP_TOKEN);
  mcpServer = remote.listen(0, "127.0.0.1");
  await once(mcpServer, "listening");
  process.env.HANNAH_MCP_SERVERS = JSON.stringify([
    { id: "self", name: "HANNAH MCP", url: `http://127.0.0.1:${mcpServer.address().port}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    { id: "Bad ID", url: "ftp://nope" },
    { id: "remote-plain", url: "http://example.com/mcp" },
  ]);
});

after(() => {
  server?.close();
  mcpServer?.close();
});

test("only valid servers load: https, or http on loopback", () => {
  const { parseServers } = require("./mcp-client");
  const servers = parseServers(process.env.HANNAH_MCP_SERVERS);
  assert.deepEqual(servers.map((item) => item.id), ["self"]);
});

test("SSE and JSON responses are both read", async () => {
  const { readRpcResponse } = require("./mcp-client");
  const sse = new Response('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  assert.deepEqual((await readRpcResponse(sse, 7)).result, { ok: true });
  const json = new Response('{"jsonrpc":"2.0","id":3,"result":{"x":1}}', { headers: { "Content-Type": "application/json" } });
  assert.deepEqual((await readRpcResponse(json, 3)).result, { x: 1 });
});

test("lists and calls tools on a real MCP server", async () => {
  const listed = await fetch(`${baseUrl}/api/mcp/servers`, { headers: operator }).then((r) => r.json());
  const self = listed.servers.find((item) => item.id === "self");
  assert.equal(self.ok, true, self.error);
  assert.ok(self.tools.some((tool) => tool.name === "hannah_status"));
  assert.equal(self.tools.find((tool) => tool.name === "hannah_chat").inputSchema.type, "object");

  const called = await fetch(`${baseUrl}/api/mcp/call`, { method: "POST", headers: operator, body: JSON.stringify({ server: "self", tool: "hannah_status", arguments: {} }) }).then((r) => r.json());
  assert.equal(called.isError, false);
  assert.match(called.text, /"status":"ok"/);
});

test("unknown servers and tools are refused", async () => {
  assert.equal((await fetch(`${baseUrl}/api/mcp/call`, { method: "POST", headers: operator, body: JSON.stringify({ server: "nope", tool: "x" }) })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/mcp/call`, { method: "POST", headers: operator, body: JSON.stringify({ server: "self", tool: "rm_rf" }) })).status, 404);
});

test("MCP routes need the operator token", async () => {
  const visitor = await fetch(`${baseUrl}/api/mcp/servers`, { headers: { "X-Groq-API-Key": "gsk_visitorkey0123456789abcdefgh" } });
  assert.equal(visitor.status, 401);
});
