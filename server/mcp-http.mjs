import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createHANNAHMcpServer } from "./mcp-core.mjs";

function matchesBearerToken(header, expectedToken) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(header || "");
  if (!match) return false;
  const candidate = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/**
 * The remote MCP endpoint (streamable HTTP) at /mcp.
 *
 * A caller uses the credential they already have, the same ones /v1 and A2A
 * accept: an account's developer key or the operator token as a Bearer token,
 * or their own Groq key in X-Groq-API-Key. `authorize` is the API's own
 * credential check, so there is one set of rules. Each tool call goes to
 * HANNAH's API with that same credential, so it has that caller's limits,
 * budget and model access, and nothing more.
 *
 * `token` (MCP_API_TOKEN) is optional and kept for existing setups: a host
 * that sends it acts with the operator token.
 */
export function mountHANNAHMcpEndpoint(app, { token, authorize = [], apiBaseUrl } = {}) {
  if (token !== undefined && token !== "" && (typeof token !== "string" || token.length < 32)) {
    throw new Error("MCP_API_TOKEN must be a random value of at least 32 characters.");
  }
  const operatorToken = (process.env.HANNAH_API_TOKEN || process.env.SHANAYA_API_TOKEN || "").trim();

  if (!authorize.length && !token) throw new Error("The MCP endpoint needs the API's credential check, or MCP_API_TOKEN.");
  const withMcpToken = (req, res, next) => {
    const matches = Boolean(token) && matchesBearerToken(req.get("authorization"), token);
    // Mounted on its own (no credential check passed in): only the dedicated token gets in.
    if (!authorize.length && !matches) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ error: "A valid HANNAH MCP bearer token is required." });
    }
    // The dedicated MCP token stands in for the operator token.
    if (matches && operatorToken) req.headers.authorization = `Bearer ${operatorToken}`;
    return next();
  };
  const refuseEmpty = (req, res, next) => {
    // A signed-in browser on HANNAH's own pages has a session cookie instead of a header; the credential check below reads it.
    if (req.get("authorization") || req.get("x-groq-api-key") || (authorize.length && req.get("cookie"))) return next();
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Send a HANNAH developer key or access token as a Bearer token, or your Groq key in X-Groq-API-Key." });
  };

  app.all("/mcp", withMcpToken, refuseEmpty, ...authorize, (req, res) => {
    const headers = {};
    if (req.get("authorization")) headers.Authorization = req.get("authorization");
    if (req.get("x-groq-api-key")) headers["X-Groq-API-Key"] = req.get("x-groq-api-key");
    if (!headers.Authorization && req.get("cookie")) headers.Cookie = req.get("cookie");
    const base = typeof apiBaseUrl === "function" ? apiBaseUrl(req) : apiBaseUrl;
    const nodeHandler = toNodeHandler(createMcpHandler(() => createHANNAHMcpServer({ headers, ...(base ? { apiBaseUrl: base } : {}) })));
    res.setHeader("Cache-Control", "no-store");
    void nodeHandler(req, res, req.body).catch((error) => {
      // Avoid Express' default error handler, which may serialize provider details.
      const errorName = error instanceof Error ? error.name : "unknown error";
      console.error(`HANNAH MCP HTTP request failed (${errorName}).`);
      if (res.headersSent) return res.destroy();
      return res.status(500).json({ error: "HANNAH MCP request failed." });
    });
  });
}
