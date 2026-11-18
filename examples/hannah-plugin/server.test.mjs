// The example plugin, used the way HANNAH uses connectors: through the
// server's own MCP client (server/mcp-client.js), over real HTTP.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { createPluginServer, TOOLS } from "./server.mjs";

const require = createRequire(import.meta.url);
const { McpHttpClient } = require("../../server/mcp-client.js");
const TOKEN = "example-plugin-token-0123456789abcdef";
let server;
let url;
before(async () => {
  server = createPluginServer({ token: TOKEN, allowedOrigins: [] });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(() => server?.close());

test("HANNAH's MCP client lists the plugin's tools and calls them", async () => {
  const client = new McpHttpClient({ id: "example", name: "Example plugin", url, headers: { Authorization: `Bearer ${TOKEN}` } });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.ok(tools.every((tool) => tool.readOnly), "both tools say they only read");
  const counted = await client.callTool("word_count", { text: "Hello there, HANNAH.\nSecond line" });
  assert.equal(counted.isError, false);
  assert.deepEqual(counted.structured, { words: 5, characters: 32, lines: 2, readingMinutes: 1 });
  assert.match(counted.text, /^5 words/);
  const time = await client.callTool("current_time", { timeZone: "Asia/Kolkata" });
  assert.match(time.text, /India Standard Time|GMT\+5:30/);
  const bad = await client.callTool("current_time", { timeZone: "Mars/Olympus" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /isn't a time zone/);
  await assert.rejects(client.callTool("delete_everything", {}), /Unknown tool/);
});

test("refuses calls without the token, from other web origins, or outside a session", async () => {
  await assert.rejects(new McpHttpClient({ id: "x", name: "Example plugin", url, headers: {} }).listTools(), /rejected HANNAH's credentials/);
  await assert.rejects(new McpHttpClient({ id: "x", name: "Example plugin", url, headers: { Authorization: "Bearer wrong" } }).listTools(), /rejected/);
  const fromPage = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert.equal(fromPage.status, 403, "a web page on another origin can't use it (DNS rebinding)");
  const noSession = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.match((await noSession.json()).error.message, /Initialize first/);
  const stale = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Mcp-Session-Id": "gone", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
  assert.equal(stale.status, 404, "an unknown session answers 404, so clients start a new one");
});
