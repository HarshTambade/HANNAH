"use strict";

/**
 * Connectors end to end against a local MCP server that signs people in the
 * way the MCP authorization spec describes: a 401 with resource metadata,
 * authorization server metadata, dynamic client registration, an authorize
 * step that redirects back with a code, a token endpoint that checks PKCE
 * (S256), refresh tokens, and tools that need the bearer token.
 *
 * HANNAH's routes do discovery, registration, the token exchange and tool
 * calls; the test plays the browser (it follows the authorize redirect and keeps
 * the tokens, as the app does in localStorage). The server stores nothing.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const express = require("express");
const { createConnectorsRouter, CATALOG } = require("./connectors");

process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = "true";

const SITE = "https://hannah.example";
const REDIRECT = `${SITE}/connectors/callback`;
let vendor;
let vendorUrl;
let hannah;
let api;
const state = { clients: new Map(), codes: new Map(), tokens: new Map(), refresh: new Map(), calls: [] };

function vendorApp(base) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json({ resource: `${base()}/mcp`, authorization_servers: [base()], scopes_supported: ["read", "write"] }));
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({
    issuer: base(), authorization_endpoint: `${base()}/authorize`, token_endpoint: `${base()}/token`, registration_endpoint: `${base()}/register`,
    code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"],
  }));
  app.post("/register", (req, res) => {
    if (!Array.isArray(req.body.redirect_uris) || req.body.token_endpoint_auth_method !== "none") return res.status(400).json({ error: "invalid_client_metadata" });
    const clientId = `client_${crypto.randomBytes(6).toString("hex")}`;
    state.clients.set(clientId, req.body.redirect_uris);
    res.status(201).json({ client_id: clientId, redirect_uris: req.body.redirect_uris });
  });
  // The person approves; the server redirects back with a code bound to the PKCE challenge.
  app.get("/authorize", (req, res) => {
    const { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: method, state: st, resource } = req.query;
    if (!state.clients.get(clientId)?.includes(redirectUri) || method !== "S256" || !challenge || resource !== `${base()}/mcp`) return res.status(400).send("bad authorize request");
    const code = crypto.randomBytes(8).toString("hex");
    state.codes.set(code, { clientId, redirectUri, challenge });
    res.redirect(`${redirectUri}?code=${code}&state=${encodeURIComponent(st)}`);
  });
  app.post("/token", (req, res) => {
    const issue = () => {
      const access = `at_${crypto.randomBytes(8).toString("hex")}`;
      const refresh = `rt_${crypto.randomBytes(8).toString("hex")}`;
      state.tokens.set(access, true);
      state.refresh.set(refresh, req.body.client_id);
      res.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
    };
    if (req.body.grant_type === "refresh_token") {
      if (state.refresh.get(req.body.refresh_token) !== req.body.client_id) return res.status(400).json({ error: "invalid_grant" });
      state.refresh.delete(req.body.refresh_token);
      return issue();
    }
    const code = state.codes.get(req.body.code);
    state.codes.delete(req.body.code);
    const verified = code && crypto.createHash("sha256").update(String(req.body.code_verifier || "")).digest("base64url") === code.challenge;
    if (!verified || code.clientId !== req.body.client_id || code.redirectUri !== req.body.redirect_uri) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE or code mismatch" });
    issue();
  });
  app.post("/mcp", (req, res) => {
    const token = /^Bearer (.+)$/.exec(req.get("authorization") || "")?.[1];
    if (!token || !state.tokens.get(token)) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: "unauthorized" });
    }
    const { id, method, params } = req.body;
    if (method === "notifications/initialized") return res.status(202).end();
    if (method === "initialize") return res.setHeader("Mcp-Session-Id", "s1").json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-tracker", version: "1" } } });
    if (method === "tools/list") return res.json({ jsonrpc: "2.0", id, result: { tools: [{ name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }, { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] } });
    if (method === "tools/call") {
      state.calls.push(params);
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Created “${params.arguments.title}” as TRK-1` }] } });
    }
    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } });
  });
  return app;
}

before(async () => {
  vendor = http.createServer(vendorApp(() => vendorUrl));
  vendor.listen(0, "127.0.0.1");
  await once(vendor, "listening");
  vendorUrl = `http://127.0.0.1:${vendor.address().port}`;
  const app = express();
  app.use("/api", createConnectorsRouter({ publicBaseUrl: () => SITE }));
  hannah = http.createServer(app);
  hannah.listen(0, "127.0.0.1");
  await once(hannah, "listening");
  api = `http://127.0.0.1:${hannah.address().port}/api`;
});
after(() => { vendor?.close(); hannah?.close(); });

const post = async (path, body) => {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test("sign in with OAuth (discovery, registration, PKCE), then list and call tools with the token", async () => {
  const url = `${vendorUrl}/mcp`;
  const discovered = await post("/connectors/discover", { url });
  assert.deepEqual(discovered.body, { auth: "oauth", registration: true, scope: "read write" });

  const registered = await post("/connectors/register", { url, redirectUri: REDIRECT });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.match(registered.body.clientId, /^client_/);
  assert.equal(registered.body.authorizationEndpoint, `${vendorUrl}/authorize`);
  assert.equal(registered.body.resource, url);

  // The browser: PKCE, then the authorize page redirects back with a code.
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(registered.body.authorizationEndpoint);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: registered.body.clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", resource: registered.body.resource, scope: registered.body.scope })) authorize.searchParams.set(key, value);
  const consent = await fetch(authorize, { redirect: "manual" });
  assert.equal(consent.status, 302);
  const back = new URL(consent.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "st-1");

  // A code without its verifier is refused.
  const stolen = await post("/connectors/token", { url, clientId: registered.body.clientId, code: back.searchParams.get("code"), codeVerifier: "wrong", redirectUri: REDIRECT });
  assert.equal(stolen.status, 401);
  assert.equal(stolen.body.reason, "reauth");

  // The real exchange (a fresh code, since codes are single-use).
  const again = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location"));
  const tokens = await post("/connectors/token", { url, clientId: registered.body.clientId, code: again.searchParams.get("code"), codeVerifier: verifier, redirectUri: REDIRECT });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  assert.match(tokens.body.accessToken, /^at_/);
  assert.match(tokens.body.refreshToken, /^rt_/);
  assert.ok(tokens.body.expiresAt > Date.now());

  const listed = await post("/connectors/rpc", { url, token: tokens.body.accessToken, action: "list", name: "Tracker" });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.tools.map((tool) => [tool.name, tool.readOnly]), [["create_issue", false], ["list_issues", true]]);
  const called = await post("/connectors/rpc", { url, token: tokens.body.accessToken, action: "call", tool: "create_issue", arguments: { title: "Fix login" }, name: "Tracker" });
  assert.deepEqual(called.body, { isError: false, text: "Created “Fix login” as TRK-1" });
  assert.deepEqual(state.calls.at(-1), { name: "create_issue", arguments: { title: "Fix login" } });

  // Refresh gives a new token; the old refresh token can't be reused.
  const refreshed = await post("/connectors/token", { url, clientId: registered.body.clientId, refreshToken: tokens.body.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.accessToken, tokens.body.accessToken);
  assert.equal((await post("/connectors/token", { url, clientId: registered.body.clientId, refreshToken: tokens.body.refreshToken })).body.reason, "reauth");

  // A revoked or wrong token asks the person to sign in again.
  state.tokens.delete(refreshed.body.accessToken);
  const revoked = await post("/connectors/rpc", { url, token: refreshed.body.accessToken, action: "list", name: "Tracker" });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.body.reason, "reauth");
  assert.match(revoked.body.error, /sign in again/);
});

test("redirect URIs must be this site's callback, and internal addresses are refused", async () => {
  const url = `${vendorUrl}/mcp`;
  for (const redirectUri of ["https://evil.example/connectors/callback", `${SITE}/somewhere-else`, `${SITE}/connectors/callback?next=x`]) {
    const refused = await post("/connectors/register", { url, redirectUri });
    assert.equal(refused.status, 400, redirectUri);
    assert.equal(refused.body.reason, "invalid-redirect");
  }
  delete process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK;
  try {
    for (const blocked of ["http://127.0.0.1:1/mcp", "https://169.254.169.254/latest/meta-data", "https://localhost/mcp", "ftp://example.com/mcp", "https://user:pass@example.com/mcp"]) {
      const answer = await post("/connectors/rpc", { url: blocked, action: "list" });
      assert.equal(answer.status, 400, `${blocked}: ${JSON.stringify(answer.body)}`);
      assert.match(answer.body.reason, /blocked|invalid-url/);
    }
  } finally {
    process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = "true";
  }
});

test("the catalog lists only checked vendor servers, each with https, an auth type and docs", async () => {
  const response = await fetch(`${api}/connectors/catalog`);
  const { connectors } = await response.json();
  // This server is reached at a public address (hannah.example), so the connectors that only register local
  // redirect addresses are left out; a local install lists all of them.
  const localOnly = CATALOG.filter((entry) => entry.localOnly).map((entry) => entry.id).sort();
  assert.deepEqual(localOnly, ["intercom", "square", "vercel"]);
  assert.equal(connectors.length, CATALOG.length - localOnly.length);
  assert.ok(connectors.length >= 28);
  assert.ok(connectors.every((entry) => !localOnly.includes(entry.id) && !("localOnly" in entry)));
  const local = express();
  local.use("/api", createConnectorsRouter({ publicBaseUrl: () => "http://localhost:3001" }));
  const localServer = http.createServer(local);
  localServer.listen(0, "127.0.0.1");
  await once(localServer, "listening");
  try { assert.equal((await (await fetch(`http://127.0.0.1:${localServer.address().port}/api/connectors/catalog`)).json()).connectors.length, CATALOG.length); } finally { localServer.close(); }
  const ids = new Set();
  for (const entry of connectors) {
    assert.ok(!ids.has(entry.id), `unique id ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.url, /^https:\/\//, entry.id);
    assert.match(entry.docs, /^https:\/\//, entry.id);
    assert.ok(["oauth", "none", "token"].includes(entry.auth), entry.id);
    assert.ok(entry.description.length > 10 && entry.category, entry.id);
  }
  for (const unapproved of ["asana", "box", "hubspot", "slack"]) assert.ok(!ids.has(unapproved), `${unapproved} only accepts apps it approves`);
});

test("a visitor with no account or key can connect the directory's connectors, and nothing else", async () => {
  const { requireApiToken } = require("./api-security");
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "1" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const app = express();
  app.use("/api", requireApiToken, createConnectorsRouter({ publicBaseUrl: () => SITE, fetchImpl }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const listed = CATALOG.find((entry) => entry.auth === "none");
    const found = await send("/connectors/discover", { url: listed.url });
    assert.equal(found.status, 200);
    assert.equal(found.body.auth, "none");
    assert.deepEqual(asked, [listed.url]);

    // An address outside the directory is refused before anything is fetched.
    for (const path of ["/connectors/discover", "/connectors/register", "/connectors/token", "/connectors/rpc"]) {
      const refused = await send(path, { url: "https://mcp.somewhere-else.example/mcp", action: "list", redirectUri: REDIRECT, clientId: "x" });
      assert.equal(refused.status, 401, path);
      assert.equal(refused.body.reason, "sign-in-required", path);
    }
    assert.equal(asked.length, 1);

    // Other routes stay closed to visitors.
    const closed = await fetch(`${base}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(closed.status, 401);
  } finally {
    server.close();
  }
});
