#!/usr/bin/env node
/**
 * An example HANNAH plugin: a remote MCP server (Streamable HTTP transport)
 * with two tools. No dependencies; Node 20+.
 *
 *   PORT=8787 PLUGIN_TOKEN=<a long random secret> node server.mjs
 *
 * Then, behind https, add it in HANNAH → Marketplace → Connectors → Add a
 * custom connector: its URL (https://your.host/mcp) and the token. HANNAH sends
 * the token as "Authorization: Bearer …", lists the tools, and asks the user
 * before each call. See docs/API-INTEGRATION.md → "Build a plugin".
 *
 * MCP pieces implemented: initialize (with an Mcp-Session-Id), the
 * notifications/initialized notification, tools/list, tools/call, ping, and
 * DELETE to end a session. Origin is checked (DNS rebinding), as the MCP
 * specification requires of HTTP servers.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY = 256 * 1024;

export const TOOLS = [
  {
    name: "word_count",
    title: "Count words",
    description: "Count the words, characters and lines in a piece of text, and estimate reading time at 200 words a minute.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The text to count." } }, required: ["text"] },
    annotations: { readOnlyHint: true },
    run({ text }) {
      if (typeof text !== "string") throw new ToolError("text must be a string.");
      const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
      const result = { words, characters: [...text].length, lines: text ? text.split(/\r?\n/).length : 0, readingMinutes: Math.max(words ? 1 : 0, Math.round(words / 200)) };
      return { text: `${result.words} words, ${result.characters} characters, ${result.lines} lines (about ${result.readingMinutes} min to read).`, structured: result };
    },
  },
  {
    name: "current_time",
    title: "Current time",
    description: "The current date and time in a time zone (an IANA name such as Asia/Kolkata or Europe/London; default UTC).",
    inputSchema: { type: "object", properties: { timeZone: { type: "string", description: "IANA time zone, for example Asia/Kolkata." } } },
    annotations: { readOnlyHint: true },
    run({ timeZone = "UTC" }, now = new Date()) {
      let formatted;
      try {
        formatted = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }).format(now);
      } catch {
        throw new ToolError(`“${String(timeZone).slice(0, 60)}” isn't a time zone. Use an IANA name such as Asia/Kolkata.`);
      }
      return { text: `${formatted} (${timeZone})`, structured: { timeZone, iso: now.toISOString(), formatted } };
    },
  },
];

class ToolError extends Error {}

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};

/** One JSON-RPC message → its response (or null for a notification). Exported for tests. */
export function handleMessage(message, session) {
  const { id, method, params } = message || {};
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (message?.jsonrpc !== "2.0" || typeof method !== "string") return error(-32600, "Invalid request.");
  if (id === undefined) return null; // notifications (notifications/initialized …) need no answer
  if (method === "initialize") return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hannah-example-plugin", version: "1.0.0" }, instructions: "Word counts and the current time." });
  if (!session) return error(-32000, "Initialize first.");
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
  if (method === "tools/call") {
    const tool = TOOLS.find((item) => item.name === params?.name);
    if (!tool) return error(-32602, `Unknown tool “${String(params?.name).slice(0, 60)}”.`);
    try {
      const result = tool.run(params?.arguments && typeof params.arguments === "object" ? params.arguments : {});
      return reply({ content: [{ type: "text", text: result.text }], structuredContent: result.structured, isError: false });
    } catch (failure) {
      if (failure instanceof ToolError) return reply({ content: [{ type: "text", text: failure.message }], isError: true });
      return error(-32603, "The tool failed.");
    }
  }
  return error(-32601, `Unknown method ${method.slice(0, 60)}.`);
}

/**
 * The HTTP server. `token`: required bearer token (recommended). `allowedOrigins`:
 * browser origins allowed to call it (server-to-server calls send no Origin).
 */
export function createPluginServer({ token = process.env.PLUGIN_TOKEN || "", allowedOrigins = (process.env.PLUGIN_ALLOWED_ORIGINS || "").split(",").filter(Boolean) } = {}) {
  const sessions = new Set();
  return http.createServer((req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const url = new URL(req.url, "http://plugin");
    if (url.pathname !== "/mcp") return send(404, { error: "Not found." });
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return send(403, { error: "Origin not allowed." });
    if (token && !sameSecret(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), token)) return send(401, { error: "A valid bearer token is required." }, { "WWW-Authenticate": "Bearer" });
    const sessionId = String(req.headers["mcp-session-id"] || "");
    if (req.method === "DELETE") { sessions.delete(sessionId); return send(204); }
    if (req.method !== "POST") return send(405, { error: "This server answers POST (no server-sent event stream)." }, { Allow: "POST, DELETE" });
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { send(413, { error: "Too large." }); req.destroy(); } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }); }
      if (Array.isArray(message)) return send(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches aren't supported." } });
      if (message.method === "initialize") {
        const fresh = randomUUID();
        sessions.add(fresh);
        return send(200, handleMessage(message, fresh), { "Mcp-Session-Id": fresh });
      }
      if (sessionId && !sessions.has(sessionId)) return send(404, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32001, message: "Session not found; initialize again." } });
      const answer = handleMessage(message, sessionId && sessions.has(sessionId) ? sessionId : null);
      return answer === null ? send(202) : send(200, answer);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || "127.0.0.1";
  if (!process.env.PLUGIN_TOKEN) console.warn("PLUGIN_TOKEN isn't set: anyone who can reach this server can call its tools.");
  createPluginServer().listen(port, host, () => console.log(`HANNAH example plugin: http://${host}:${port}/mcp`));
}
