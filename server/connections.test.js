const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const { test, before, after } = require("node:test");
const express = require("express");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);
process.env.HANNAH_PUBLIC_URL = "https://hannah.example";
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.MICROSOFT_CLIENT_ID = "ms-client";
process.env.MICROSOFT_CLIENT_SECRET = "ms-secret";

const { getDatabase, resetDatabase } = require("./db");
const { buildRawMessage, createConnectionsRouter, gmailText } = require("./connections");
const { createDeviceTaskRouter } = require("./device-tasks");

let clock = Date.parse("2026-11-16T09:00:00Z");
const calls = [];
const replies = new Map();
/** A fake Google and Microsoft: answers by "METHOD host/path" prefix and records every call. */
async function fakeFetch(url, init = {}) {
  const target = new URL(url);
  const key = `${init.method || "GET"} ${target.host}${target.pathname}`;
  calls.push({ key, url: target, init, body: init.body });
  const match = [...replies.keys()].find((prefix) => key.startsWith(prefix));
  const reply = match ? replies.get(match) : { status: 404, body: {} };
  const value = typeof reply === "function" ? reply(target, init) : reply;
  return new Response(JSON.stringify(value.body ?? {}), { status: value.status ?? 200, headers: { "Content-Type": "application/json" } });
}

let server;
let base;
let user = "user-1";

before(async () => {
  const db = await getDatabase();
  for (const id of ["user-1", "user-2"]) {
    await db.query("INSERT INTO hannah_users (id, email, password_hash, display_name, created_at, updated_at) VALUES ($1, $2, 'x', '', 0, 0)", [id, `${id}@example.com`]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!req.path.endsWith("/callback")) res.locals.hannahAccount = { id: user, via: "session" };
    // A browser that finishes a sign-in while signed in to HANNAH.
    else if (req.get("x-test-finisher")) res.locals.hannahAccount = { id: req.get("x-test-finisher"), via: "session" };
    next();
  });
  app.use("/api", createConnectionsRouter({ fetchImpl: fakeFetch, now: () => clock, allowedOrigins: ["https://app.example"] }));
  app.use("/api", createDeviceTaskRouter({ now: () => clock, emit: async () => [] }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await resetDatabase();
});

const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (path) => fetch(`${base}${path}`);

async function connect(provider, { email = "me@example.com", refresh = "refresh-1" } = {}) {
  const started = await (await post(`/account/connections/${provider}/start`, { returnTo: "https://app.example/settings" })).json();
  const authorize = new URL(started.url);
  const state = authorize.searchParams.get("state");
  replies.set(provider === "google" ? "POST oauth2.googleapis.com/token" : "POST login.microsoftonline.com/common/oauth2/v2.0/token", { body: { access_token: `${provider}-access-1`, refresh_token: refresh, expires_in: 3600, scope: "granted" } });
  replies.set(provider === "google" ? "GET openidconnect.googleapis.com/v1/userinfo" : "GET graph.microsoft.com/v1.0/me", { body: provider === "google" ? { email } : { mail: email } });
  const callback = await fetch(`${base}/account/connections/${provider}/callback?state=${state}&code=auth-code`, { redirect: "manual" });
  return { authorize, state, callback };
}

test("connecting Google uses PKCE, a single-use state, and returns to the app", async () => {
  const { authorize, state, callback } = await connect("google");
  assert.equal(authorize.origin + authorize.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(authorize.searchParams.get("redirect_uri"), "https://hannah.example/api/account/connections/google/callback");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("access_type"), "offline");
  assert.match(authorize.searchParams.get("scope"), /calendar\.events.*gmail\.readonly.*gmail\.compose/);

  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "https://app.example/settings?connected=google");
  const exchange = calls.find((call) => call.key === "POST oauth2.googleapis.com/token");
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("grant_type"), "authorization_code");
  // The verifier sent to Google matches the challenge in the sign-in link.
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), authorize.searchParams.get("code_challenge"));

  const status = await (await get("/account/connections")).json();
  const google = status.providers.find((item) => item.id === "google");
  assert.equal(google.connected, true);
  assert.equal(google.email, "me@example.com");
  // Tokens are stored encrypted, never in plain text.
  const db = await getDatabase();
  const { rows } = await db.query("SELECT ciphertext FROM hannah_connections WHERE user_id = 'user-1' AND provider = 'google'");
  assert.ok(!rows[0].ciphertext.includes("refresh-1"));

  // The same state can't be used twice.
  const replay = await fetch(`${base}/account/connections/google/callback?state=${state}&code=auth-code`, { redirect: "manual" });
  assert.equal(replay.status, 400);
});

test("a sign-in only returns to the app's own origins", async () => {
  const started = await (await post("/account/connections/microsoft/start", { returnTo: "https://evil.example/steal" })).json();
  const state = new URL(started.url).searchParams.get("state");
  replies.set("POST login.microsoftonline.com/common/oauth2/v2.0/token", { body: { access_token: "x", refresh_token: "y", expires_in: 3600 } });
  const callback = await fetch(`${base}/account/connections/microsoft/callback?state=${state}&code=c`, { redirect: "manual" });
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /Microsoft connected/);
});

test("calendar events from Google come back in one shape, and an expired token is refreshed", async () => {
  replies.set("GET www.googleapis.com/calendar/v3/calendars/primary/events", { body: { items: [
    { id: "e2", summary: "Standup", start: { dateTime: "2026-11-17T09:00:00+05:30" }, end: { dateTime: "2026-11-17T09:15:00+05:30" }, htmlLink: "https://calendar.google.com/e2" },
    { id: "e1", summary: "Holiday", start: { date: "2026-11-17" }, end: { date: "2026-11-18" } },
  ] } });
  clock += 2 * 3_600_000;
  replies.set("POST oauth2.googleapis.com/token", { body: { access_token: "google-access-2", expires_in: 3600 } });
  user = "user-1";
  const response = await get("/account/calendar/events?provider=google&from=2026-11-17T00:00:00Z&to=2026-11-18T00:00:00Z");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.events.map((event) => [event.title, event.allDay]), [["Holiday", true], ["Standup", false]]);
  const refresh = calls.filter((call) => call.key === "POST oauth2.googleapis.com/token").at(-1);
  assert.equal(new URLSearchParams(refresh.body).get("grant_type"), "refresh_token");
  const listCall = calls.filter((call) => call.key.startsWith("GET www.googleapis.com/calendar")).at(-1);
  assert.equal(listCall.init.headers.Authorization, "Bearer google-access-2");
});

test("creating an event on Outlook sends UTC times", async () => {
  replies.set("POST graph.microsoft.com/v1.0/me/events", (_url, init) => ({ status: 201, body: { id: "ms-1", subject: JSON.parse(init.body).subject, webLink: "https://outlook.office.com/e" } }));
  const response = await post("/account/calendar/events", { provider: "microsoft", title: "Dentist", start: "2026-11-18T10:00:00+05:30" });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const sent = JSON.parse(calls.at(-1).body);
  assert.deepEqual(sent.start, { dateTime: "2026-11-18T04:30:00.000", timeZone: "UTC" });
  assert.deepEqual(sent.end, { dateTime: "2026-11-18T05:30:00.000", timeZone: "UTC" });
  // With both accounts connected, a write must say which one.
  const ambiguous = await post("/account/calendar/events", { title: "Lunch", start: "2026-11-18T12:00:00Z" });
  assert.equal(ambiguous.status, 400);
});

test("mail: search, read, draft and send, with header injection refused", async () => {
  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/messages/m1", { body: { id: "m1", threadId: "t1", snippet: "Lunch?", labelIds: ["UNREAD"], internalDate: String(Date.parse("2026-11-16T08:00:00Z")),
    payload: { headers: [{ name: "From", value: "Sam <sam@example.com>" }, { name: "Subject", value: "Lunch" }], mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Want lunch tomorrow?").toString("base64url") } }] } } });
  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/messages", { body: { messages: [{ id: "m1" }] } });
  const search = await (await get("/account/mail/messages?provider=google&q=from:sam")).json();
  assert.deepEqual(search.messages.map((item) => [item.subject, item.unread, item.from]), [["Lunch", true, "Sam <sam@example.com>"]]);
  const read = await (await get("/account/mail/messages/google/m1")).json();
  assert.equal(read.message.body, "Want lunch tomorrow?");

  replies.set("POST gmail.googleapis.com/gmail/v1/users/me/drafts", { body: { id: "d1" } });
  const draft = await post("/account/mail/drafts", { provider: "google", to: "sam@example.com", subject: "Re: Lunch", body: "Yes, 1pm?" });
  assert.equal(draft.status, 201);
  const raw = Buffer.from(JSON.parse(calls.at(-1).body).message.raw, "base64url").toString("utf8");
  assert.match(raw, /^To: sam@example\.com\r\nSubject: Re: Lunch\r\n/);

  const injected = await post("/account/mail/send", { provider: "google", to: "sam@example.com\r\nBcc: spy@example.com", subject: "Hi", body: "x" });
  assert.equal(injected.status, 400);
  const subjectBreak = buildRawMessage({ to: ["a@example.com"], subject: "Hi there", body: "x" });
  assert.ok(!Buffer.from(subjectBreak, "base64url").toString().includes("Bcc"));

  replies.set("POST graph.microsoft.com/v1.0/me/sendMail", { status: 202, body: {} });
  const sent = await post("/account/mail/send", { provider: "microsoft", to: ["sam@example.com"], subject: "Héllo", body: "Hi" });
  assert.equal(sent.status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).body).message.toRecipients, [{ emailAddress: { address: "sam@example.com" } }]);
});

test("a revoked grant disconnects the account and asks to reconnect", async () => {
  clock += 2 * 3_600_000;
  replies.set("POST login.microsoftonline.com/common/oauth2/v2.0/token", { status: 400, body: { error: "invalid_grant" } });
  const response = await get("/account/mail/messages?provider=microsoft");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, "reconnect");
  const status = await (await get("/account/connections")).json();
  assert.equal(status.providers.find((item) => item.id === "microsoft").connected, false);
});

test("connections belong to one user, and disconnecting Google revokes the token", async () => {
  user = "user-2";
  const other = await get("/account/calendar/events?provider=google");
  assert.equal(other.status, 404);
  user = "user-1";
  replies.set("POST oauth2.googleapis.com/revoke", { body: {} });
  const removed = await fetch(`${base}/account/connections/google`, { method: "DELETE" });
  assert.deepEqual(await removed.json(), { ok: true, removed: true });
  assert.ok(calls.some((call) => call.key === "POST oauth2.googleapis.com/revoke"));
});

test("a provider without client credentials says it isn't set up", async () => {
  const saved = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    const response = await post("/account/connections/google/start", {});
    assert.equal(response.status, 503);
    assert.equal((await response.json()).reason, "provider-unconfigured");
    const status = await (await get("/account/connections")).json();
    assert.equal(status.providers.find((item) => item.id === "google").configured, false);
  } finally {
    process.env.GOOGLE_CLIENT_SECRET = saved;
  }
});

test("gmail bodies fall back to text from HTML", () => {
  assert.equal(gmailText({ mimeType: "text/html", body: { data: Buffer.from("<p>Hello <b>there</b></p><script>x()</script>").toString("base64url") } }), "Hello there");
});

test("an approval nobody answers expires and can't be approved later", async () => {
  const device = { deviceId: "laptop-device-0001", deviceName: "MacBook" };
  const put = await fetch(`${base}/account/tasks/approval-expire`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...device, kind: "approval", title: "Send a message", expiresInMs: 60_000 }) });
  assert.equal(put.status, 201);
  clock += 2 * 60_000;
  const late = await post("/account/tasks/approval-expire/decision", { ...device, approve: true });
  assert.equal(late.status, 409);
  const body = await late.json();
  assert.equal(body.task.status, "expired");
  assert.match(body.error, /expired/);
});

test("a sign-in started by one account and finished in another account's browser connects nothing", async () => {
  user = "user-1";
  const started = await (await post("/account/connections/google/start", {})).json();
  const state = new URL(started.url).searchParams.get("state");
  replies.set("POST oauth2.googleapis.com/token", { body: { access_token: "victim-access", refresh_token: "victim-refresh", expires_in: 3600, scope: "granted" } });
  replies.set("GET openidconnect.googleapis.com/v1/userinfo", { body: { email: "victim@example.com" } });
  const db = await getDatabase();
  const before = (await db.query("SELECT user_id, account_email FROM hannah_connections WHERE provider = 'google'")).rows;
  const callback = await fetch(`${base}/account/connections/google/callback?state=${state}&code=auth-code`, { headers: { "x-test-finisher": "user-2" }, redirect: "manual" });
  assert.equal(callback.status, 403);
  assert.match(await callback.text(), /different HANNAH account/);
  const after = (await db.query("SELECT user_id, account_email FROM hannah_connections WHERE provider = 'google'")).rows;
  assert.deepEqual(after, before, "no connection was stored or replaced");
  assert.equal(after.some((row) => row.account_email === "victim@example.com"), false);
});
