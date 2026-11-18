"use strict";

/**
 * MCP client: lets HANNAH use tools from outside MCP servers.
 *
 * The operator lists servers in HANNAH_MCP_SERVERS (JSON):
 *   [{"id":"docs","name":"Team docs","url":"https://mcp.example.com/mcp",
 *     "headers":{"Authorization":"Bearer …"}}]
 *
 * Only the Streamable HTTP transport is supported (JSON or SSE responses,
 * Mcp-Session-Id sessions). Servers and their credentials belong to the
 * operator, so these routes need the operator token; visitors and accounts
 * can't reach them. The app wraps each tool so every call is screened by the
 * Guardian and approved by the user before it runs.
 */

const express = require("express");
const { isLocalHostname } = require("./providers/catalog");

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "hannah", version: "1.0.0" };
const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const TOOL_CACHE_MS = 60_000;

function parseServers(raw = process.env.HANNAH_MCP_SERVERS) {
  if (!raw || !String(raw).trim()) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    console.error("HANNAH_MCP_SERVERS isn't valid JSON; no MCP servers were loaded.");
    return [];
  }
  if (!Array.isArray(list)) return [];
  const servers = [];
  for (const item of list.slice(0, 10)) {
    try {
      if (!item || !ID_PATTERN.test(String(item.id))) throw new Error("id");
      const url = new URL(String(item.url));
      if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHostname(url.hostname))) throw new Error("https");
      const headers = {};
      for (const [key, value] of Object.entries(item.headers && typeof item.headers === "object" ? item.headers : {})) {
        if (/^[A-Za-z0-9-]{1,64}$/.test(key) && typeof value === "string" && !/[\r\n]/.test(value)) headers[key] = value;
      }
      servers.push({ id: item.id, name: String(item.name || item.id).slice(0, 60), url: url.toString(), headers });
    } catch {
      console.error(`Skipped an MCP server entry: it needs an id (lowercase letters, digits, dashes) and an https URL.`);
    }
  }
  return servers;
}

/** Read one JSON-RPC response from a JSON or SSE body. Exported for tests. */
async function readRpcResponse(response, id) {
  const type = String(response.headers.get("content-type") || "");
  const text = await response.text();
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        const message = JSON.parse(data);
        if (message && message.id === id) return message;
      } catch {
        // Ignore non-JSON events.
      }
    }
    return null;
  }
  try {
    const message = text ? JSON.parse(text) : null;
    return Array.isArray(message) ? message.find((item) => item?.id === id) || null : message;
  } catch {
    return null;
  }
}

class McpHttpClient {
  /** fetchImpl: how requests are made (connectors pass an SSRF-safe one for URLs people enter). */
  constructor(server, { timeoutMs = 30_000, fetchImpl = (...args) => fetch(...args) } = {}) {
    this.server = server;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.initialized = null;
    this.nextId = 1;
    this.tools = null;
    this.toolsAt = 0;
  }

  async post(body, { expectResponse = true } = {}) {
    const headers = {
      ...this.server.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
    };
    const response = await this.fetchImpl(this.server.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!expectResponse) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? `${this.server.name} rejected HANNAH's credentials.` : `${this.server.name} returned HTTP ${response.status}.`);
      error.status = response.status;
      error.wwwAuthenticate = response.headers.get("www-authenticate") || "";
      throw error;
    }
    const message = await readRpcResponse(response, body.id);
    if (!message) throw new Error(`${this.server.name} sent no usable response.`);
    if (message.error) throw Object.assign(new Error(`${this.server.name}: ${String(message.error.message || "error").slice(0, 200)}`), { rpc: message.error });
    return message.result;
  }

  async request(method, params, retried = false) {
    await this.initialize();
    try {
      return await this.post({ jsonrpc: "2.0", id: this.nextId++, method, ...(params ? { params } : {}) });
    } catch (error) {
      // An expired session answers 404: start a new one once.
      if (error.status === 404 && this.sessionId && !retried) {
        this.sessionId = null;
        this.initialized = null;
        return this.request(method, params, true);
      }
      throw error;
    }
  }

  initialize() {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { expectResponse: false });
      })().catch((error) => {
        this.initialized = null;
        throw error;
      });
    }
    return this.initialized;
  }

  async listTools() {
    if (this.tools && Date.now() - this.toolsAt < TOOL_CACHE_MS) return this.tools;
    const tools = [];
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : undefined);
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    this.tools = tools.slice(0, 50).filter((tool) => typeof tool?.name === "string").map((tool) => ({
      name: tool.name,
      title: typeof tool.title === "string" ? tool.title : "",
      description: String(tool.description || "").slice(0, 1000),
      inputSchema: tool.inputSchema && tool.inputSchema.type === "object" ? tool.inputSchema : { type: "object", properties: {} },
      readOnly: tool.annotations?.readOnlyHint === true,
    }));
    this.toolsAt = Date.now();
    return this.tools;
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = (Array.isArray(result?.content) ? result.content : [])
      .map((part) => (part?.type === "text" ? part.text : part?.type ? `[${part.type} content]` : ""))
      .filter(Boolean)
      .join("\n");
    return {
      isError: result?.isError === true,
      text: (text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : "")).slice(0, 8000),
      ...(result?.structuredContent ? { structured: result.structuredContent } : {}),
    };
  }
}

function createMcpClientRouter({ timeoutMs } = {}) {
  const router = express.Router();
  let clients = null;
  let configKey = null;
  const getClients = () => {
    const raw = process.env.HANNAH_MCP_SERVERS || "";
    if (!clients || configKey !== raw) {
      configKey = raw;
      clients = new Map(parseServers(raw).map((server) => [server.id, new McpHttpClient(server, { timeoutMs })]));
    }
    return clients;
  };

  router.get("/mcp/servers", async (_req, res) => {
    const servers = await Promise.all([...getClients().values()].map(async (client) => {
      try {
        return { id: client.server.id, name: client.server.name, ok: true, tools: await client.listTools() };
      } catch (error) {
        return { id: client.server.id, name: client.server.name, ok: false, error: error.message, tools: [] };
      }
    }));
    res.json({ servers });
  });

  router.post("/mcp/call", async (req, res) => {
    const client = getClients().get(String(req.body?.server || ""));
    const tool = typeof req.body?.tool === "string" ? req.body.tool : "";
    const args = req.body?.arguments && typeof req.body.arguments === "object" && !Array.isArray(req.body.arguments) ? req.body.arguments : {};
    if (!client) return res.status(404).json({ error: "That MCP server isn't configured." });
    try {
      const known = await client.listTools();
      if (!known.some((item) => item.name === tool)) return res.status(404).json({ error: `${client.server.name} has no tool named “${tool}”.` });
      const result = await client.callTool(tool, args);
      return res.json({ server: client.server.id, tool, ...result });
    } catch (error) {
      return res.status(502).json({ error: error.message || "The MCP server call failed." });
    }
  });

  return router;
}

module.exports = { createMcpClientRouter, McpHttpClient, parseServers, readRpcResponse };
