"use strict";

/**
 * Connectors: outside services HANNAH can use as tools, each one a remote MCP
 * server run by the service itself, connected by the person with their own
 * sign-in (OAuth 2.1 with PKCE and dynamic client registration, as the MCP
 * authorization spec describes), a token, or nothing at all.
 *
 * This server stores nothing about a connection. The browser keeps the
 * connector's client id and tokens and sends the token with each call; these
 * routes only do what a browser can't:
 *   GET  /api/connectors/catalog     the directory (public)
 *   POST /api/connectors/discover    { url } → how this server signs in
 *   POST /api/connectors/register    { url, redirectUri } → a client id (dynamic client registration)
 *   POST /api/connectors/token       { url, clientId, code+codeVerifier+redirectUri | refreshToken } → tokens
 *   POST /api/connectors/rpc         { url, token?, action: "list" | "call", tool?, arguments? }
 *
 * Every outbound request goes through the SSRF-safe client (workflows/http.js):
 * https only, no internal addresses (checked at connect time), size and time
 * limits. A visitor with no account and no key may connect the directory's
 * own connectors, nothing else: a custom address needs a sign-in, so these
 * routes aren't a relay to any server on the internet. Token and registration endpoints are always the ones discovered from
 * the server's own metadata, never ones the browser names. Redirect URIs must be
 * this site's /connectors/callback.
 */
const express = require("express");
const { McpHttpClient } = require("./mcp-client");
const { RequestBlockedError, checkUrl, safeRequest } = require("./workflows/http");

/**
 * The directory. Every entry is the vendor's own remote MCP server. Each was
 * checked on 2026-11-18: an unauthenticated initialize either worked ("none")
 * or answered 401 with OAuth metadata that offers dynamic client registration
 * and PKCE ("oauth"). GitHub's server has no dynamic registration but accepts a
 * personal access token ("token"). Asana, Box, Figma, HubSpot and Slack aren't
 * listed: their servers only accept apps they approve in advance (Figma's
 * registration endpoint answered 403 when checked again on 2026-11-19).
 *
 * Vercel, Intercom and Square register HANNAH only for redirect addresses on
 * their allowlists (checked from the public site on 2026-11-20: each answered
 * "redirect URI not in the allowlist"), which in practice means a local
 * install. They are marked localOnly and left out of the directory a public
 * site serves, so nobody is shown a Connect button that can't work.
 *
 * Icons are each vendor's own, downloaded from its website and converted to
 * 128 px PNG (client/public/connectors), so the directory doesn't load
 * anything from 30 other sites. An entry without one shows its initials.
 */
const CATALOG = [
  // Developer tools
  { id: "github", icon: "/connectors/github.png", name: "GitHub", category: "Developer tools", url: "https://api.githubcopilot.com/mcp/", auth: "token", description: "Repositories, issues, pull requests, code search and Actions.", docs: "https://github.com/github/github-mcp-server", tokenHelp: "Create a fine-grained personal access token at github.com/settings/personal-access-tokens with the repositories and permissions HANNAH may use." },
  { id: "linear", icon: "/connectors/linear.png", name: "Linear", category: "Project management", url: "https://mcp.linear.app/mcp", auth: "oauth", description: "Find, create and update issues, projects and comments.", docs: "https://linear.app/docs/mcp" },
  { id: "sentry", icon: "/connectors/sentry.png", name: "Sentry", category: "Developer tools", url: "https://mcp.sentry.dev/mcp", auth: "oauth", description: "Look into errors and issues, with stack traces and releases.", docs: "https://docs.sentry.io/product/sentry-mcp/" },
  { id: "semgrep", icon: "/connectors/semgrep.png", name: "Semgrep", category: "Developer tools", url: "https://mcp.semgrep.ai/mcp", auth: "oauth", description: "Scan code for security issues and look up findings.", docs: "https://semgrep.dev/docs/mcp" },
  { id: "jam", icon: "/connectors/jam.png", name: "Jam", category: "Developer tools", url: "https://mcp.jam.dev/mcp", auth: "oauth", description: "Bug reports with console logs, network requests and repro steps.", docs: "https://jam.dev/docs/debug-a-jam/mcp" },
  { id: "huggingface", icon: "/connectors/huggingface.png", name: "Hugging Face", category: "Developer tools", url: "https://huggingface.co/mcp", auth: "none", description: "Search models, datasets, Spaces and papers on the Hub.", docs: "https://huggingface.co/settings/mcp" },
  // Hosting, cloud and databases
  { id: "vercel", localOnly: true, icon: "/connectors/vercel.png", name: "Vercel", category: "Hosting and cloud", url: "https://mcp.vercel.com", auth: "oauth", description: "Projects, deployments, build logs and Vercel's docs.", docs: "https://vercel.com/docs/mcp/vercel-mcp" },
  { id: "netlify", icon: "/connectors/netlify.png", name: "Netlify", category: "Hosting and cloud", url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", description: "Create, deploy and manage Netlify sites.", docs: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/" },
  { id: "cloudflare-bindings", icon: "/connectors/cloudflare.png", name: "Cloudflare Workers", category: "Hosting and cloud", url: "https://bindings.mcp.cloudflare.com/mcp", auth: "oauth", description: "Workers, KV, R2, D1 and other resources in your account.", docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/" },
  { id: "cloudflare-observability", icon: "/connectors/cloudflare.png", name: "Cloudflare Observability", category: "Hosting and cloud", url: "https://observability.mcp.cloudflare.com/mcp", auth: "oauth", description: "Logs and analytics from your Workers.", docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/" },
  { id: "cloudflare-radar", icon: "/connectors/cloudflare.png", name: "Cloudflare Radar", category: "Docs and research", url: "https://radar.mcp.cloudflare.com/mcp", auth: "oauth", description: "Internet traffic trends, outages and URL scans.", docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/" },
  { id: "supabase", icon: "/connectors/supabase.png", name: "Supabase", category: "Databases", url: "https://mcp.supabase.com/mcp", auth: "oauth", description: "Projects, tables, SQL queries, migrations and logs.", docs: "https://supabase.com/docs/guides/getting-started/mcp" },
  { id: "neon", icon: "/connectors/neon.png", name: "Neon", category: "Databases", url: "https://mcp.neon.tech/mcp", auth: "oauth", description: "Postgres projects, branches and SQL.", docs: "https://neon.com/docs/ai/neon-mcp-server" },
  { id: "prisma", icon: "/connectors/prisma.png", name: "Prisma Postgres", category: "Databases", url: "https://mcp.prisma.io/mcp", auth: "oauth", description: "Create and manage Prisma Postgres databases.", docs: "https://www.prisma.io/docs/postgres/integrations/mcp-server" },
  { id: "airtable", icon: "/connectors/airtable.png", name: "Airtable", category: "Databases", url: "https://mcp.airtable.com/mcp", auth: "oauth", description: "Read and update bases, tables and records.", docs: "https://support.airtable.com/docs/using-the-airtable-mcp-server" },
  // Work and knowledge
  { id: "notion", icon: "/connectors/notion.png", name: "Notion", category: "Productivity", url: "https://mcp.notion.com/mcp", auth: "oauth", description: "Search, read and write pages and databases.", docs: "https://developers.notion.com/docs/mcp" },
  { id: "atlassian", icon: "/connectors/atlassian.png", name: "Atlassian (Jira and Confluence)", category: "Project management", url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth", description: "Jira issues and Confluence pages.", docs: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/" },
  { id: "monday", icon: "/connectors/monday.png", name: "monday.com", category: "Project management", url: "https://mcp.monday.com/mcp", auth: "oauth", description: "Boards, items and updates.", docs: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration" },
  { id: "fireflies", icon: "/connectors/fireflies.png", name: "Fireflies", category: "Productivity", url: "https://api.fireflies.ai/mcp", auth: "oauth", description: "Meeting transcripts, summaries and action items.", docs: "https://docs.fireflies.ai/getting-started/mcp-configuration" },
  { id: "zapier", icon: "/connectors/zapier.png", name: "Zapier", category: "Automation", url: "https://mcp.zapier.com/api/mcp/mcp", auth: "oauth", description: "Actions in the thousands of apps you've set up in Zapier.", docs: "https://zapier.com/mcp" },
  { id: "intercom", localOnly: true, icon: "/connectors/intercom.png", name: "Intercom", category: "Customer support", url: "https://mcp.intercom.com/mcp", auth: "oauth", description: "Conversations, contacts and help center articles.", docs: "https://developers.intercom.com/docs/guides/mcp" },
  // Payments and commerce
  { id: "stripe", icon: "/connectors/stripe.png", name: "Stripe", category: "Payments", url: "https://mcp.stripe.com", auth: "oauth", description: "Customers, payments, invoices, subscriptions and Stripe's docs.", docs: "https://docs.stripe.com/mcp" },
  { id: "paypal", icon: "/connectors/paypal.png", name: "PayPal", category: "Payments", url: "https://mcp.paypal.com/mcp", auth: "oauth", description: "Invoices, orders, transactions and disputes.", docs: "https://developer.paypal.com/tools/mcp-server/" },
  { id: "square", localOnly: true, icon: "/connectors/square.png", name: "Square", category: "Payments", url: "https://mcp.squareup.com/mcp", auth: "oauth", description: "Payments, orders, catalog, customers and inventory.", docs: "https://developer.squareup.com/docs/mcp" },
  // Design and websites
  { id: "canva", icon: "/connectors/canva.png", name: "Canva", category: "Design", url: "https://mcp.canva.com/mcp", auth: "oauth", description: "Find, create and export designs.", docs: "https://www.canva.dev/docs/mcp/" },
  { id: "webflow", icon: "/connectors/webflow.png", name: "Webflow", category: "Websites", url: "https://mcp.webflow.com/mcp", auth: "oauth", description: "Sites, pages and CMS collections.", docs: "https://developers.webflow.com/mcp/reference/overview" },
  { id: "wix", icon: "/connectors/wix.png", name: "Wix", category: "Websites", url: "https://mcp.wix.com/mcp", auth: "oauth", description: "Sites, stores, bookings and content.", docs: "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp" },
  // Docs and research (no sign-in)
  { id: "context7", icon: "/connectors/context7.png", name: "Context7", category: "Docs and research", url: "https://mcp.context7.com/mcp", auth: "none", description: "Up-to-date documentation and code examples for libraries.", docs: "https://context7.com" },
  { id: "deepwiki", name: "DeepWiki", category: "Docs and research", url: "https://mcp.deepwiki.com/mcp", auth: "none", description: "Ask questions about public GitHub repositories.", docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp" },
  { id: "microsoft-learn", icon: "/connectors/microsoft.png", name: "Microsoft Learn", category: "Docs and research", url: "https://learn.microsoft.com/api/mcp", auth: "none", description: "Search Microsoft's official documentation.", docs: "https://learn.microsoft.com/en-us/training/support/mcp" },
  { id: "aws-knowledge", icon: "/connectors/aws.png", name: "AWS Knowledge", category: "Docs and research", url: "https://knowledge-mcp.global.api.aws", auth: "none", description: "AWS documentation, guidance and regional availability.", docs: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server" },
  { id: "cloudflare-docs", icon: "/connectors/cloudflare.png", name: "Cloudflare Docs", category: "Docs and research", url: "https://docs.mcp.cloudflare.com/mcp", auth: "none", description: "Search Cloudflare's documentation.", docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/" },
];

const MAX_BYTES = 4 * 1024 * 1024;
const sameServer = (value) => { const url = new URL(value); url.hash = ""; return url.toString().replace(/\/$/, ""); };
const CATALOG_URLS = new Set(CATALOG.map((entry) => sameServer(entry.url)));
/** A visitor without an account or key: fewer requests a minute than someone who signed in. */
const GUEST_LIMIT = 40;
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

/** A fetch() that goes through the SSRF-safe client. https only, unless self-hosting allows the private network. */
function safeFetch(timeoutMs) {
  return async (rawUrl, init = {}) => {
    const url = checkUrl(String(rawUrl));
    if (url.protocol !== "https:" && process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK !== "true") throw new RequestBlockedError("Connectors must use https.");
    const headers = { "User-Agent": "HANNAH-connectors/1.0", ...(init.headers || {}) };
    const result = await safeRequest(url.toString(), { method: init.method || "GET", headers, body: init.body, timeoutMs, maxBytes: MAX_BYTES });
    const flat = new Headers();
    for (const [name, value] of Object.entries(result.headers || {})) if (value !== undefined) flat.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    const status = result.status >= 200 && result.status <= 599 ? result.status : 502;
    return new Response([204, 205, 304].includes(status) ? null : result.body, { status, headers: flat });
  };
}

async function getJson(fetchImpl, url, init) {
  try {
    const response = await fetchImpl(url, { ...init, headers: { Accept: "application/json", ...(init?.headers || {}) } });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, headers: response.headers, body, text };
  } catch (error) {
    if (error instanceof RequestBlockedError) throw fail(400, error.message, "blocked");
    return { status: 0, headers: new Headers(), body: null, text: "", error };
  }
}

const authParam = (header, name) => new RegExp(`${name}="([^"]*)"`, "i").exec(header || "")?.[1] || "";

/** How a server signs in, from its own metadata (RFC 9728, RFC 8414, OpenID Connect discovery). */
async function discover(fetchImpl, rawUrl) {
  const url = new URL(rawUrl);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hannah", version: "1.0.0" } } };
  const probe = await getJson(fetchImpl, url.toString(), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(init) });
  if (probe.status === 0) throw fail(502, `${url.host} didn't answer.`, "unreachable");
  if (probe.status >= 200 && probe.status < 300) return { auth: "none", resource: url.toString() };
  if (probe.status !== 401) throw fail(502, `${url.host} isn't an MCP server HANNAH can use (HTTP ${probe.status}).`, "not-mcp");
  const www = probe.headers.get("www-authenticate") || "";
  const path = url.pathname.replace(/\/$/, "");
  const metadataUrls = [authParam(www, "resource_metadata"), `${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let resourceMetadata = null;
  for (const candidate of metadataUrls) {
    const found = await getJson(fetchImpl, candidate);
    if (found.status === 200 && found.body && typeof found.body === "object") { resourceMetadata = found.body; break; }
  }
  const issuer = new URL(resourceMetadata?.authorization_servers?.[0] || url.origin);
  const issuerPath = issuer.pathname.replace(/\/$/, "");
  const asUrls = issuerPath
    ? [`${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuer.origin}/.well-known/openid-configuration${issuerPath}`, `${issuer.origin}${issuerPath}/.well-known/openid-configuration`]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  let server = null;
  for (const candidate of asUrls) {
    const found = await getJson(fetchImpl, candidate);
    if (found.status === 200 && found.body?.authorization_endpoint && found.body?.token_endpoint) { server = found.body; break; }
  }
  if (!server) throw fail(502, `${url.host} asks for a sign-in but doesn't publish how. HANNAH can't connect to it yet.`, "no-oauth-metadata");
  for (const endpoint of [server.authorization_endpoint, server.token_endpoint, server.registration_endpoint].filter(Boolean)) {
    const checked = new URL(endpoint);
    if (checked.protocol !== "https:" && process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK !== "true") throw fail(502, `${url.host}'s sign-in doesn't use https.`, "insecure");
  }
  if (Array.isArray(server.code_challenge_methods_supported) && !server.code_challenge_methods_supported.includes("S256")) throw fail(502, `${url.host}'s sign-in doesn't support PKCE (S256), which HANNAH requires.`, "no-pkce");
  const scope = authParam(www, "scope") || (Array.isArray(resourceMetadata?.scopes_supported) ? resourceMetadata.scopes_supported.join(" ") : "");
  return {
    auth: "oauth",
    resource: typeof resourceMetadata?.resource === "string" ? resourceMetadata.resource : url.toString(),
    authorizationEndpoint: server.authorization_endpoint,
    tokenEndpoint: server.token_endpoint,
    registrationEndpoint: server.registration_endpoint || null,
    scope,
  };
}

function createConnectorsRouter({ publicBaseUrl, allowedOrigins = [], timeoutMs = 30_000, fetchImpl = safeFetch(Math.min(timeoutMs, 30_000)) } = {}) {
  const router = express.Router();
  const json = express.json({ limit: "512kb" });
  const discovered = new Map();
  const hits = new Map();

  const limited = (req, max = 120) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.at > 60_000) { hits.set(key, { at: now, n: 1 }); return false; }
    entry.n += 1;
    if (hits.size > 5000) hits.clear();
    return entry.n > max;
  };
  async function discoverCached(rawUrl) {
    const key = new URL(rawUrl).toString();
    const cached = discovered.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value;
    const value = await discover(fetchImpl, key);
    if (discovered.size > 500) discovered.clear();
    discovered.set(key, { at: Date.now(), value });
    return value;
  }
  function serverUrl(raw, res) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || value.length > 2048) throw fail(400, "Enter the connector's URL.", "invalid-url");
    let url;
    try { url = checkUrl(value); } catch (error) { throw fail(400, error.message, "blocked"); }
    if (url.protocol !== "https:" && process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK !== "true") throw fail(400, "Connectors must use https.", "invalid-url");
    url.hash = "";
    if (res?.locals?.hannahGuest && !CATALOG_URLS.has(sameServer(url.toString()))) throw fail(401, "Sign in, or add your key, to use a connector that isn't in the directory.", "sign-in-required");
    return url.toString();
  }
  /** The redirect URI must be this site's callback, on an origin this server serves. */
  function checkRedirect(req, raw) {
    let redirect;
    try { redirect = new URL(String(raw || "")); } catch { throw fail(400, "Missing redirect URI.", "invalid-redirect"); }
    const origins = new Set([publicBaseUrl ? new URL(publicBaseUrl(req)).origin : null, ...allowedOrigins].filter(Boolean));
    if (!origins.has(redirect.origin) || redirect.pathname !== "/connectors/callback" || redirect.search || redirect.hash) throw fail(400, "That redirect URI isn't this site's connector callback.", "invalid-redirect");
    return redirect.toString();
  }
  const handle = (fn) => async (req, res) => {
    try {
      if (limited(req, res.locals?.hannahGuest ? GUEST_LIMIT : 120)) throw fail(429, "Too many connector requests. Wait a minute.", "rate-limited");
      res.setHeader("Cache-Control", "no-store");
      await fn(req, res);
    } catch (error) {
      const status = error.status || (error instanceof RequestBlockedError ? 400 : 502);
      res.status(status).json({ error: status >= 500 && !error.reason ? "The connector didn't respond as expected." : error.message, reason: error.reason || (error instanceof RequestBlockedError ? "blocked" : "upstream") });
    }
  };

  /** A local install (this server reached at localhost) can use the connectors that only accept local redirect addresses. */
  const isLocal = (req) => {
    try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(publicBaseUrl ? publicBaseUrl(req) : `http://${req.get("host")}`).hostname); } catch { return false; }
  };
  router.get("/connectors/catalog", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Vary", "Host");
    res.json({ connectors: CATALOG.filter((entry) => !entry.localOnly || isLocal(req)).map((entry) => { const shown = { ...entry }; delete shown.localOnly; return shown; }) });
  });

  router.post("/connectors/discover", json, handle(async (req, res) => {
    const found = await discoverCached(serverUrl(req.body?.url, res));
    res.json({ auth: found.auth, registration: Boolean(found.registrationEndpoint), scope: found.scope || "" });
  }));

  router.post("/connectors/register", json, handle(async (req, res) => {
    const url = serverUrl(req.body?.url, res);
    const redirectUri = checkRedirect(req, req.body?.redirectUri);
    const found = await discoverCached(url);
    if (found.auth !== "oauth") throw fail(400, "This connector doesn't need a sign-in.", "no-auth");
    if (!found.registrationEndpoint) throw fail(400, "This service only accepts apps it approves in advance, so HANNAH can't register itself with it.", "no-registration");
    const registered = await getJson(fetchImpl, found.registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "HANNAH", client_uri: new URL(redirectUri).origin, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    });
    if (registered.status < 200 || registered.status >= 300 || !registered.body?.client_id) {
      throw fail(502, `The service refused HANNAH's registration (HTTP ${registered.status || "no answer"}${registered.body?.error_description ? `: ${String(registered.body.error_description).slice(0, 160)}` : ""}).`, "registration-refused");
    }
    const authorize = new URL(found.authorizationEndpoint);
    res.json({
      clientId: String(registered.body.client_id),
      ...(registered.body.client_secret ? { clientSecret: String(registered.body.client_secret), authMethod: registered.body.token_endpoint_auth_method || "client_secret_basic" } : {}),
      authorizationEndpoint: authorize.toString(),
      resource: found.resource,
      scope: found.scope || "",
    });
  }));

  router.post("/connectors/token", json, handle(async (req, res) => {
    const url = serverUrl(req.body?.url, res);
    const found = await discoverCached(url);
    if (found.auth !== "oauth") throw fail(400, "This connector doesn't need a sign-in.", "no-auth");
    const clientId = String(req.body?.clientId || "").slice(0, 512);
    if (!clientId) throw fail(400, "Missing client id.", "invalid");
    const form = new URLSearchParams({ client_id: clientId, resource: found.resource });
    if (req.body?.refreshToken) {
      form.set("grant_type", "refresh_token");
      form.set("refresh_token", String(req.body.refreshToken).slice(0, 8192));
    } else {
      form.set("grant_type", "authorization_code");
      form.set("code", String(req.body?.code || "").slice(0, 4096));
      form.set("code_verifier", String(req.body?.codeVerifier || "").slice(0, 256));
      form.set("redirect_uri", checkRedirect(req, req.body?.redirectUri));
    }
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    const secret = typeof req.body?.clientSecret === "string" ? req.body.clientSecret : "";
    if (secret && req.body?.authMethod === "client_secret_post") form.set("client_secret", secret);
    else if (secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
    const answer = await getJson(fetchImpl, found.tokenEndpoint, { method: "POST", headers, body: form.toString() });
    if (answer.status !== 200 || !answer.body?.access_token) {
      const reason = answer.body?.error === "invalid_grant" ? "reauth" : "token-refused";
      throw fail(answer.body?.error === "invalid_grant" ? 401 : 502, `The service didn't issue a token (${answer.body?.error_description || answer.body?.error || `HTTP ${answer.status || "no answer"}`}).`.slice(0, 300), reason);
    }
    res.json({
      accessToken: String(answer.body.access_token),
      ...(answer.body.refresh_token ? { refreshToken: String(answer.body.refresh_token) } : {}),
      expiresAt: Number(answer.body.expires_in) > 0 ? Date.now() + Number(answer.body.expires_in) * 1000 : null,
      scope: typeof answer.body.scope === "string" ? answer.body.scope : "",
    });
  }));

  router.post("/connectors/rpc", json, handle(async (req, res) => {
    const url = serverUrl(req.body?.url, res);
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (token && (token.length > 8192 || /[\r\n]/.test(token))) throw fail(400, "That token isn't valid.", "invalid-token");
    const name = String(req.body?.name || new URL(url).host).slice(0, 60);
    const client = new McpHttpClient({ id: "connector", name, url, headers: token ? { Authorization: `Bearer ${token}` } : {} }, { timeoutMs, fetchImpl });
    try {
      if (req.body?.action === "call") {
        const tool = String(req.body?.tool || "");
        if (!tool || tool.length > 128) throw fail(400, "Missing tool name.", "invalid");
        const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};
        return res.json(await client.callTool(tool, args));
      }
      res.json({ tools: await client.listTools() });
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw fail(401, `${name} needs you to sign in again.`, "reauth");
      throw error;
    }
  }));

  return router;
}

module.exports = { CATALOG, createConnectorsRouter, discover, safeFetch };
