"use strict";

/**
 * Calendar and email: Google and Microsoft accounts connected with their own
 * sign-in (OAuth 2.0 authorization code flow with PKCE).
 *
 * The operator registers an OAuth app with each provider and sets
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET (MICROSOFT_TENANT, default "common")
 * with the redirect URI <public URL>/api/account/connections/<provider>/callback.
 * A provider without its variables shows as "not set up on this server".
 *
 * - HANNAH never sees the user's Google or Microsoft password.
 * - Tokens are stored per user, envelope-encrypted with the vault
 *   (HANNAH_VAULT_KEY), and only sent to that provider's own APIs.
 * - The sign-in "state" is single-use, expires after 10 minutes and is bound to
 *   the user who started it, so a callback can't attach an account to someone else.
 * - Reading is a plain API call. Creating events, saving drafts and sending mail
 *   are separate endpoints the app only calls after the user approves the action.
 */

const express = require("express");
const { createHash, randomBytes } = require("node:crypto");
const { getDatabase } = require("./db");
const { decryptSecret, encryptSecret, vaultConfigured } = require("./vault");

const STATE_TTL_MS = 10 * 60_000;
const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,190}\.[^\s@<>,;"]{2,63}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const base64url = (buffer) => Buffer.from(buffer).toString("base64url");

const PROVIDERS = {
  google: {
    id: "google",
    label: "Google",
    services: "Google Calendar and Gmail",
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
    // offline + consent: Google only returns a refresh token on a consented sign-in.
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  microsoft: {
    id: "microsoft",
    label: "Microsoft",
    services: "Outlook Calendar and Mail",
    env: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    authorizeUrl: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    scopes: ["openid", "email", "offline_access", "User.Read", "Calendars.ReadWrite", "Mail.ReadWrite", "Mail.Send"],
    extraParams: { prompt: "select_account" },
  },
};

function tenant() {
  const value = String(process.env.MICROSOFT_TENANT || "common").trim();
  return /^[A-Za-z0-9.-]{1,100}$/.test(value) ? value : "common";
}

function credentials(provider) {
  const [idVar, secretVar] = provider.env;
  const clientId = String(process.env[idVar] || "").trim();
  const clientSecret = String(process.env[secretVar] || "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function publicBaseUrl(req) {
  const configured = String(process.env.HANNAH_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("x-forwarded-host") || req.get("host")}`;
}

const redirectUri = (req, provider) => `${publicBaseUrl(req)}/api/account/connections/${provider.id}/callback`;

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

// ---------- tokens ----------

async function postForm(fetchImpl, url, form) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function sealTokens(userId, providerId, tokens) {
  return encryptSecret(JSON.stringify(tokens), { userId, providerId: `connection:${providerId}` });
}

function openTokens(userId, providerId, row) {
  return JSON.parse(decryptSecret(row, { userId, providerId: `connection:${providerId}` }).secret);
}

async function accountEmail(fetchImpl, provider, accessToken) {
  const url = provider.id === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  const email = provider.id === "google" ? body.email : body.mail || body.userPrincipalName;
  return typeof email === "string" ? email.slice(0, 254) : null;
}

/** A valid access token for the user's connection, refreshing it when needed. */
async function accessTokenFor(db, userId, providerId, { fetchImpl, now }) {
  const provider = PROVIDERS[providerId];
  const { rows } = await db.query("SELECT * FROM hannah_connections WHERE user_id = $1 AND provider = $2", [userId, providerId]);
  if (!rows[0]) throw fail(404, `${provider.label} isn't connected. Connect it in Settings → Calendar and email.`, "not-connected");
  const tokens = openTokens(userId, providerId, rows[0]);
  if (tokens.accessToken && tokens.expiresAt - 60_000 > now()) return tokens.accessToken;
  const creds = credentials(provider);
  if (!creds || !tokens.refreshToken) throw fail(401, `Reconnect ${provider.label} in Settings → Calendar and email.`, "reconnect");
  const result = await postForm(fetchImpl, provider.tokenUrl(), {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    ...(provider.id === "microsoft" ? { scope: provider.scopes.join(" ") } : {}),
  });
  if (!result.ok || !result.body.access_token) {
    // The user revoked access or the grant expired: they need to sign in again.
    if (result.body?.error === "invalid_grant") await db.query("DELETE FROM hannah_connections WHERE user_id = $1 AND provider = $2", [userId, providerId]);
    throw fail(401, `${provider.label} asked to sign in again. Reconnect it in Settings → Calendar and email.`, "reconnect");
  }
  const next = {
    accessToken: result.body.access_token,
    // Microsoft rotates refresh tokens; Google usually keeps the old one.
    refreshToken: result.body.refresh_token || tokens.refreshToken,
    expiresAt: now() + Math.max(60, Number(result.body.expires_in) || 3600) * 1000,
  };
  const sealed = sealTokens(userId, providerId, next);
  await db.query("UPDATE hannah_connections SET key_id = $1, wrapped_key = $2, ciphertext = $3, updated_at = $4 WHERE user_id = $5 AND provider = $6", [sealed.keyId, sealed.wrappedKey, sealed.ciphertext, now(), userId, providerId]);
  return next.accessToken;
}

async function providerCall(fetchImpl, accessToken, url, { method = "GET", body, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const status = response.status === 401 ? 401 : response.status === 403 ? 403 : response.status === 404 ? 404 : 502;
    const message = response.status === 403
      ? "The connected account didn't allow this. Reconnect it and accept every permission HANNAH asks for."
      : response.status === 404 ? "That item wasn't found in the connected account." : `The provider answered ${response.status}.`;
    throw fail(status, message);
  }
  return data;
}

// ---------- calendar ----------

function isoTime(value, label) {
  const date = new Date(String(value ?? ""));
  if (!value || Number.isNaN(date.getTime())) throw fail(400, `${label} must be a date and time, such as 2026-11-17T09:00:00+05:30.`);
  return date.toISOString();
}

const graphTime = (value) => (value?.dateTime ? new Date(/Z|[+-]\d\d:\d\d$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`).toISOString() : null);

async function listEvents(fetchImpl, providerId, token, { from, to, max }) {
  if (providerId === "google") {
    const params = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: String(max) });
    const data = await providerCall(fetchImpl, token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
    return (data.items || []).map((item) => ({
      provider: "google", id: item.id, title: item.summary || "(no title)",
      start: item.start?.dateTime || item.start?.date || null, end: item.end?.dateTime || item.end?.date || null,
      allDay: Boolean(item.start?.date && !item.start?.dateTime), location: item.location || "", link: item.htmlLink || "",
    }));
  }
  const params = new URLSearchParams({ startDateTime: from, endDateTime: to, $top: String(max), $orderby: "start/dateTime", $select: "subject,start,end,isAllDay,location,webLink" });
  const data = await providerCall(fetchImpl, token, `https://graph.microsoft.com/v1.0/me/calendarView?${params}`, { headers: { Prefer: 'outlook.timezone="UTC"' } });
  return (data.value || []).map((item) => ({
    provider: "microsoft", id: item.id, title: item.subject || "(no title)", start: graphTime(item.start), end: graphTime(item.end),
    allDay: Boolean(item.isAllDay), location: item.location?.displayName || "", link: item.webLink || "",
  }));
}

async function createEvent(fetchImpl, providerId, token, event) {
  if (providerId === "google") {
    const data = await providerCall(fetchImpl, token, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      body: { summary: event.title, start: { dateTime: event.start }, end: { dateTime: event.end }, ...(event.location ? { location: event.location } : {}), ...(event.description ? { description: event.description } : {}) },
    });
    return { provider: "google", id: data.id, title: data.summary, start: data.start?.dateTime || event.start, end: data.end?.dateTime || event.end, link: data.htmlLink || "" };
  }
  const data = await providerCall(fetchImpl, token, "https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    body: {
      subject: event.title,
      start: { dateTime: event.start.replace(/Z$/, ""), timeZone: "UTC" },
      end: { dateTime: event.end.replace(/Z$/, ""), timeZone: "UTC" },
      ...(event.location ? { location: { displayName: event.location } } : {}),
      ...(event.description ? { body: { contentType: "text", content: event.description } } : {}),
    },
  });
  return { provider: "microsoft", id: data.id, title: data.subject, start: event.start, end: event.end, link: data.webLink || "" };
}

// ---------- mail ----------

const headerValue = (value, max) => String(value ?? "").replace(/[\r\n\u0000]+/g, " ").trim().slice(0, max);

function recipients(value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(/[,;]/)).map((item) => String(item).trim()).filter(Boolean);
  if (!list.length) throw fail(400, "Add at least one recipient.");
  if (list.length > 20) throw fail(400, "Up to 20 recipients.");
  for (const item of list) if (!EMAIL.test(item)) throw fail(400, `“${item.slice(0, 80)}” isn't an email address.`);
  return list;
}

function encodedHeader(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** An RFC 5322 plain-text message for Gmail. Header values can't contain line breaks. Exported for tests. */
function buildRawMessage({ to, cc = [], subject, body }) {
  const lines = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodedHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return base64url(lines.join("\r\n"));
}

function readMail(body) {
  const to = recipients(body?.to);
  const cc = body?.cc ? recipients(body.cc) : [];
  const subject = headerValue(body?.subject, 250);
  const text = String(body?.body ?? "").slice(0, 50_000);
  if (!subject && !text.trim()) throw fail(400, "Write a subject or a message.");
  return { to, cc, subject, body: text };
}

const graphRecipients = (list) => list.map((address) => ({ emailAddress: { address } }));

function decodePart(data) {
  return data ? Buffer.from(String(data), "base64url").toString("utf8") : "";
}

function gmailText(payload) {
  const stack = [payload];
  let html = "";
  while (stack.length) {
    const part = stack.shift();
    if (!part) continue;
    if (part.mimeType === "text/plain" && part.body?.data) return decodePart(part.body.data);
    if (part.mimeType === "text/html" && part.body?.data && !html) html = decodePart(part.body.data);
    stack.push(...(part.parts || []));
  }
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

const header = (headers, name) => (headers || []).find((item) => item.name?.toLowerCase() === name)?.value || "";

async function searchMail(fetchImpl, providerId, token, { query, max }) {
  if (providerId === "google") {
    const params = new URLSearchParams({ maxResults: String(max), ...(query ? { q: query } : {}) });
    const list = await providerCall(fetchImpl, token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
    const ids = (list.messages || []).slice(0, max).map((item) => item.id);
    const messages = await Promise.all(ids.map((id) => providerCall(fetchImpl, token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    return messages.map((item) => ({
      provider: "google", id: item.id, from: header(item.payload?.headers, "from"), subject: header(item.payload?.headers, "subject") || "(no subject)",
      date: item.internalDate ? new Date(Number(item.internalDate)).toISOString() : header(item.payload?.headers, "date"), snippet: item.snippet || "",
      unread: (item.labelIds || []).includes("UNREAD"), link: `https://mail.google.com/mail/u/0/#all/${item.threadId || item.id}`,
    }));
  }
  const params = new URLSearchParams({ $top: String(max), $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,webLink" });
  // Graph doesn't allow $orderby together with $search.
  if (query) params.set("$search", `"${query.replace(/"/g, "")}"`);
  else params.set("$orderby", "receivedDateTime desc");
  const data = await providerCall(fetchImpl, token, `https://graph.microsoft.com/v1.0/me/messages?${params}`);
  return (data.value || []).map((item) => ({
    provider: "microsoft", id: item.id, from: item.from?.emailAddress ? `${item.from.emailAddress.name || ""} <${item.from.emailAddress.address || ""}>`.trim() : "",
    subject: item.subject || "(no subject)", date: item.receivedDateTime || "", snippet: item.bodyPreview || "", unread: item.isRead === false, link: item.webLink || "",
  }));
}

async function readMessage(fetchImpl, providerId, token, id) {
  if (providerId === "google") {
    const item = await providerCall(fetchImpl, token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    const headers = item.payload?.headers;
    return { provider: "google", id: item.id, from: header(headers, "from"), to: header(headers, "to"), subject: header(headers, "subject"), date: header(headers, "date"), body: gmailText(item.payload).slice(0, 20_000) };
  }
  const item = await providerCall(fetchImpl, token, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,receivedDateTime,body,webLink`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
  return {
    provider: "microsoft", id: item.id, from: item.from?.emailAddress?.address || "", to: (item.toRecipients || []).map((entry) => entry.emailAddress?.address).filter(Boolean).join(", "),
    subject: item.subject || "", date: item.receivedDateTime || "", body: String(item.body?.content || "").slice(0, 20_000), link: item.webLink || "",
  };
}

async function saveDraft(fetchImpl, providerId, token, mail) {
  if (providerId === "google") {
    const data = await providerCall(fetchImpl, token, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST", body: { message: { raw: buildRawMessage(mail) } } });
    return { provider: "google", id: data.id, link: "https://mail.google.com/mail/u/0/#drafts" };
  }
  const data = await providerCall(fetchImpl, token, "https://graph.microsoft.com/v1.0/me/messages", {
    method: "POST",
    body: { subject: mail.subject, body: { contentType: "Text", content: mail.body }, toRecipients: graphRecipients(mail.to), ccRecipients: graphRecipients(mail.cc) },
  });
  return { provider: "microsoft", id: data.id, link: data.webLink || "" };
}

async function sendMail(fetchImpl, providerId, token, mail) {
  if (providerId === "google") {
    const data = await providerCall(fetchImpl, token, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: { raw: buildRawMessage(mail) } });
    return { provider: "google", id: data.id, sent: true };
  }
  await providerCall(fetchImpl, token, "https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    body: { message: { subject: mail.subject, body: { contentType: "Text", content: mail.body }, toRecipients: graphRecipients(mail.to), ccRecipients: graphRecipients(mail.cc) }, saveToSentItems: true },
  });
  return { provider: "microsoft", sent: true };
}

// ---------- routes ----------

function callbackPage(title, message, status = 200) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  return {
    status,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · HANNAH</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font:16px/1.5 system-ui,sans-serif}main{max-width:28rem;margin:1.5rem;padding:2rem;border-radius:1.25rem;background:#fff;box-shadow:0 20px 50px -30px rgba(15,23,42,.45)}h1{margin:0 0 .5rem;font-size:1.35rem}p{margin:0;color:#475569}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`,
  };
}

/**
 * `allowedOrigins` are the app origins a finished sign-in may return to (the
 * server's CLIENT_ORIGIN list); anything else gets a plain "you can close this" page.
 */
function createConnectionsRouter({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), allowedOrigins = [] } = {}) {
  const router = express.Router();
  const withUser = (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account || account.via !== "session") return res.status(401).json({ error: "Sign in to connect your calendar and email.", reason: "signin-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Calendar and email need the account database." });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (!error.status) console.error(`Connection request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "The calendar or email request failed.", ...(error.reason ? { reason: error.reason } : {}) });
    }
  };
  const providerFrom = (value) => {
    const provider = PROVIDERS[String(value || "")];
    if (!provider) throw fail(404, "Unknown provider. Use google or microsoft.");
    return provider;
  };
  const connected = async (db, userId) => (await db.query("SELECT provider, account_email, scopes, created_at FROM hannah_connections WHERE user_id = $1", [userId])).rows;
  /** The one provider to act on: the one asked for, or the only connected one. */
  const target = async (db, userId, wanted) => {
    const rows = await connected(db, userId);
    if (wanted) {
      const provider = providerFrom(wanted);
      if (!rows.some((row) => row.provider === provider.id)) throw fail(404, `${provider.label} isn't connected.`, "not-connected");
      return [provider.id];
    }
    if (!rows.length) throw fail(404, "No calendar or email account is connected. Connect Google or Microsoft in Settings → Calendar and email.", "not-connected");
    return rows.map((row) => row.provider);
  };
  const single = async (db, userId, wanted) => {
    const ids = await target(db, userId, wanted);
    if (ids.length > 1) throw fail(400, "Both Google and Microsoft are connected. Say which one to use (provider: google or microsoft).");
    return ids[0];
  };
  const tokenFor = (db, userId, providerId) => accessTokenFor(db, userId, providerId, { fetchImpl, now });

  router.get("/account/connections", withUser(async (req, res, db, account) => {
    const rows = await connected(db, account.id);
    res.json({
      vault: vaultConfigured(),
      providers: Object.values(PROVIDERS).map((provider) => {
        const row = rows.find((item) => item.provider === provider.id);
        return {
          id: provider.id, label: provider.label, services: provider.services, configured: Boolean(credentials(provider)),
          redirectUri: redirectUri(req, provider),
          connected: Boolean(row), email: row?.account_email || null, connectedAt: row ? Number(row.created_at) : null,
        };
      }),
    });
  }));

  router.post("/account/connections/:provider/start", withUser(async (req, res, db, account) => {
    const provider = providerFrom(req.params.provider);
    const creds = credentials(provider);
    if (!creds) throw fail(503, `${provider.label} sign-in isn't set up on this server. The operator needs to set ${provider.env.join(" and ")}.`, "provider-unconfigured");
    if (!vaultConfigured()) throw fail(503, "Connecting accounts needs encrypted storage. The operator needs to set HANNAH_VAULT_KEY.", "vault-unconfigured");
    let returnTo = null;
    try {
      const url = new URL(String(req.body?.returnTo || ""));
      // Only back to the app itself: its configured origins or this server's own site.
      const allowed = new Set([...allowedOrigins, new URL(publicBaseUrl(req)).origin]);
      if ((url.protocol === "https:" || url.protocol === "http:") && allowed.has(url.origin)) returnTo = `${url.origin}${url.pathname}`;
    } catch {
      returnTo = null;
    }
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const sealed = encryptSecret(verifier, { userId: account.id, providerId: `oauth-state:${provider.id}` });
    await db.query("DELETE FROM hannah_oauth_states WHERE expires_at < $1", [now()]);
    await db.query("INSERT INTO hannah_oauth_states (id, user_id, provider, key_id, wrapped_key, ciphertext, return_to, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [sha256(state), account.id, provider.id, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, returnTo, now() + STATE_TTL_MS]);
    const params = new URLSearchParams({
      client_id: creds.clientId, redirect_uri: redirectUri(req, provider), response_type: "code", scope: provider.scopes.join(" "),
      state, code_challenge: challenge, code_challenge_method: "S256", ...provider.extraParams,
    });
    res.json({ url: `${provider.authorizeUrl()}?${params}` });
  }));

  // Public: the provider sends the browser here. The state identifies the user.
  router.get("/account/connections/:provider/callback", async (req, res) => {
    const send = ({ status, html }) => res.status(status).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).send(html);
    const provider = PROVIDERS[String(req.params.provider || "")];
    if (!provider) return send(callbackPage("Unknown provider", "This sign-in link isn't for Google or Microsoft.", 404));
    const db = await getDatabase().catch(() => null);
    if (!db) return send(callbackPage("Not available", "This server has no account database.", 503));
    const state = String(req.query.state || "");
    const { rows } = state ? await db.query("SELECT * FROM hannah_oauth_states WHERE id = $1 AND provider = $2", [sha256(state), provider.id]) : { rows: [] };
    const saved = rows[0];
    // Single use, whatever happens next.
    if (saved) await db.query("DELETE FROM hannah_oauth_states WHERE id = $1", [saved.id]);
    if (!saved || Number(saved.expires_at) < now()) return send(callbackPage("This sign-in link expired", "Start again from Settings → Calendar and email in HANNAH.", 400));
    const finish = (ok, message) => {
      if (saved.return_to) {
        const url = new URL(saved.return_to);
        url.searchParams.set(ok ? "connected" : "connection-error", provider.id);
        if (!ok) url.searchParams.set("message", message.slice(0, 200));
        return res.redirect(303, url.toString());
      }
      return send(callbackPage(ok ? `${provider.label} connected` : "Not connected", ok ? "You can close this tab and go back to HANNAH." : message, ok ? 200 : 400));
    };
    if (req.query.error) return finish(false, req.query.error === "access_denied" ? "You cancelled the sign-in, so nothing was connected." : `${provider.label} didn't finish the sign-in.`);
    const creds = credentials(provider);
    const code = String(req.query.code || "");
    if (!creds || !code) return finish(false, `${provider.label} didn't send a sign-in code.`);
    try {
      const verifier = decryptSecret(saved, { userId: saved.user_id, providerId: `oauth-state:${provider.id}` }).secret;
      const result = await postForm(fetchImpl, provider.tokenUrl(), {
        grant_type: "authorization_code", code, redirect_uri: redirectUri(req, provider), client_id: creds.clientId, client_secret: creds.clientSecret, code_verifier: verifier,
      });
      if (!result.ok || !result.body.access_token) return finish(false, `${provider.label} didn't accept the sign-in. Try again.`);
      if (!result.body.refresh_token) return finish(false, `${provider.label} didn't grant offline access, so HANNAH couldn't stay connected. Try again and accept every permission.`);
      const tokens = { accessToken: result.body.access_token, refreshToken: result.body.refresh_token, expiresAt: now() + Math.max(60, Number(result.body.expires_in) || 3600) * 1000 };
      const email = await accountEmail(fetchImpl, provider, tokens.accessToken).catch(() => null);
      const sealed = sealTokens(saved.user_id, provider.id, tokens);
      const at = now();
      await db.query("DELETE FROM hannah_connections WHERE user_id = $1 AND provider = $2", [saved.user_id, provider.id]);
      await db.query("INSERT INTO hannah_connections (user_id, provider, account_email, scopes, key_id, wrapped_key, ciphertext, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)", [saved.user_id, provider.id, email, String(result.body.scope || provider.scopes.join(" ")).slice(0, 2000), sealed.keyId, sealed.wrappedKey, sealed.ciphertext, at]);
      await db.query("INSERT INTO hannah_audit (id, user_id, event, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [base64url(randomBytes(12)), saved.user_id, "connection.added", JSON.stringify({ provider: provider.id }), at]).catch(() => {});
      return finish(true, "");
    } catch (error) {
      console.error(`OAuth callback failed (${error?.code || error?.name || "error"}).`);
      return finish(false, "Something went wrong while connecting. Try again.");
    }
  });

  router.delete("/account/connections/:provider", withUser(async (req, res, db, account) => {
    const provider = providerFrom(req.params.provider);
    const { rows } = await db.query("SELECT * FROM hannah_connections WHERE user_id = $1 AND provider = $2", [account.id, provider.id]);
    if (rows[0] && provider.id === "google") {
      // Revoke at Google too (best effort). Microsoft has no per-app token revoke
      // for personal accounts; the user can remove the app at account.microsoft.com.
      try {
        const { refreshToken } = openTokens(account.id, provider.id, rows[0]);
        await postForm(fetchImpl, "https://oauth2.googleapis.com/revoke", { token: refreshToken });
      } catch {
        // Deleting our copy still disconnects HANNAH.
      }
    }
    await db.query("DELETE FROM hannah_connections WHERE user_id = $1 AND provider = $2", [account.id, provider.id]);
    if (rows[0]) await db.query("INSERT INTO hannah_audit (id, user_id, event, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [base64url(randomBytes(12)), account.id, "connection.removed", JSON.stringify({ provider: provider.id }), now()]).catch(() => {});
    res.json({ ok: true, removed: Boolean(rows[0]) });
  }));

  router.get("/account/calendar/events", withUser(async (req, res, db, account) => {
    const from = isoTime(req.query.from || new Date(now()).toISOString(), "from");
    const to = isoTime(req.query.to || new Date(now() + 7 * 86_400_000).toISOString(), "to");
    if (Date.parse(to) <= Date.parse(from)) throw fail(400, "to must be after from.");
    if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw fail(400, "Ask for at most 92 days at a time.");
    const max = Math.min(50, Math.max(1, Number(req.query.max) || 20));
    const ids = await target(db, account.id, req.query.provider);
    const lists = await Promise.all(ids.map(async (id) => listEvents(fetchImpl, id, await tokenFor(db, account.id, id), { from, to, max })));
    const events = lists.flat().sort((a, b) => String(a.start).localeCompare(String(b.start))).slice(0, max);
    res.json({ from, to, events });
  }));

  router.post("/account/calendar/events", withUser(async (req, res, db, account) => {
    const providerId = await single(db, account.id, req.body?.provider);
    const title = headerValue(req.body?.title, 200);
    if (!title) throw fail(400, "Give the event a title.");
    const start = isoTime(req.body?.start, "start");
    const end = req.body?.end ? isoTime(req.body.end, "end") : new Date(Date.parse(start) + 60 * 60_000).toISOString();
    if (Date.parse(end) <= Date.parse(start)) throw fail(400, "The event must end after it starts.");
    const event = await createEvent(fetchImpl, providerId, await tokenFor(db, account.id, providerId), {
      title, start, end, location: headerValue(req.body?.location, 200), description: String(req.body?.description ?? "").slice(0, 4000),
    });
    res.status(201).json({ event });
  }));

  router.get("/account/mail/messages", withUser(async (req, res, db, account) => {
    const query = String(req.query.q || "").slice(0, 200);
    const max = Math.min(20, Math.max(1, Number(req.query.max) || 10));
    const ids = await target(db, account.id, req.query.provider);
    const lists = await Promise.all(ids.map(async (id) => searchMail(fetchImpl, id, await tokenFor(db, account.id, id), { query, max })));
    res.json({ messages: lists.flat().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, max) });
  }));

  router.get("/account/mail/messages/:provider/:id", withUser(async (req, res, db, account) => {
    const provider = providerFrom(req.params.provider);
    const id = String(req.params.id || "");
    if (!/^[A-Za-z0-9_=+/-]{1,400}$/.test(id)) throw fail(400, "That isn't a message id.");
    await target(db, account.id, provider.id);
    res.json({ message: await readMessage(fetchImpl, provider.id, await tokenFor(db, account.id, provider.id), id) });
  }));

  router.post("/account/mail/drafts", withUser(async (req, res, db, account) => {
    const providerId = await single(db, account.id, req.body?.provider);
    const mail = readMail(req.body);
    res.status(201).json({ draft: await saveDraft(fetchImpl, providerId, await tokenFor(db, account.id, providerId), mail) });
  }));

  router.post("/account/mail/send", withUser(async (req, res, db, account) => {
    const providerId = await single(db, account.id, req.body?.provider);
    const mail = readMail(req.body);
    const result = await sendMail(fetchImpl, providerId, await tokenFor(db, account.id, providerId), mail);
    await db.query("INSERT INTO hannah_audit (id, user_id, event, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [base64url(randomBytes(12)), account.id, "mail.sent", JSON.stringify({ provider: providerId, recipients: mail.to.length + mail.cc.length }), now()]).catch(() => {});
    res.json(result);
  }));

  return router;
}

module.exports = { accessTokenFor, publicBaseUrl, recipients, buildRawMessage, createConnectionsRouter, createEvent, gmailText, listEvents, PROVIDERS, readMessage, saveDraft, searchMail, sendMail };
