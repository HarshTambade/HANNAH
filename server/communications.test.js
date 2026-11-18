/**
 * Replies, follow-ups, organizing, attachments and Google Chat through the
 * real connections router and database. Google and Microsoft are a recording
 * stand-in, so each test checks the exact API calls HANNAH makes.
 */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");
const express = require("express");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "f".repeat(64);
process.env.HANNAH_PUBLIC_URL = "https://hannah.example";
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.MICROSOFT_CLIENT_ID = "ms-client";
process.env.MICROSOFT_CLIENT_SECRET = "ms-secret";

const { getDatabase, resetDatabase } = require("./db");
const { createConnectionsRouter } = require("./connections");
const { CHAT_SCOPES, GMAIL_MODIFY } = require("./communications");

const calls = [];
const replies = new Map();
async function fakeFetch(url, init = {}) {
  const target = new URL(url);
  const key = `${init.method || "GET"} ${target.host}${target.pathname}`;
  calls.push({ key, url: target, body: init.body ? JSON.parse(init.body.startsWith?.("{") ? init.body : "{}") : null, raw: init.body });
  const match = [...replies.keys()].sort((a, b) => b.length - a.length).find((prefix) => key.startsWith(prefix));
  const reply = match ? replies.get(match) : { status: 404, body: {} };
  const value = typeof reply === "function" ? reply(target, init) : reply;
  return new Response(JSON.stringify(value.body ?? {}), { status: value.status ?? 200, headers: { "Content-Type": "application/json" } });
}

let server;
let base;
let user = "u-1";

before(async () => {
  const db = await getDatabase();
  for (const id of ["u-1", "u-2"]) await db.query("INSERT INTO hannah_users (id, email, password_hash, display_name, created_at, updated_at) VALUES ($1, $2, 'x', '', 0, 0)", [id, `${id}@example.com`]);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!req.path.endsWith("/callback")) res.locals.hannahAccount = { id: user, via: "session" };
    next();
  });
  app.use("/api", createConnectionsRouter({ fetchImpl: fakeFetch, allowedOrigins: ["https://app.example"] }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await resetDatabase();
});

const post = async (path, body) => { const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
const get = async (path) => { const response = await fetch(`${base}${path}`); return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers }; };

async function connect(provider, { features = [], scope } = {}) {
  const started = await post(`/account/connections/${provider}/start`, { returnTo: "https://app.example/settings", features });
  const authorize = new URL(started.body.url);
  replies.set(provider === "google" ? "POST oauth2.googleapis.com/token" : "POST login.microsoftonline.com", { body: { access_token: `${provider}-access`, refresh_token: "refresh", expires_in: 3600, scope: scope ?? authorize.searchParams.get("scope") } });
  replies.set(provider === "google" ? "GET openidconnect.googleapis.com/v1/userinfo" : "GET graph.microsoft.com/v1.0/me", { body: provider === "google" ? { email: "me@example.com" } : { mail: "me@example.com" } });
  const callback = await fetch(`${base}/account/connections/${provider}/callback?state=${authorize.searchParams.get("state")}&code=c`, { redirect: "manual" });
  assert.equal(callback.status, 303);
  return authorize;
}

const gmailMessage = (id, from, labelIds = ["INBOX"], extra = {}) => ({ id, threadId: `t-${id}`, internalDate: String(Date.parse("2026-11-17T10:00:00Z")), snippet: `snippet ${id}`, labelIds, payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: `About ${id}` }, { name: "Message-ID", value: `<${id}@mail.example>` }, { name: "To", value: "me@example.com, priya@example.com" }, { name: "Cc", value: "ravi@example.com" }] }, ...extra });

test("Gmail: conversations needing a reply leave out answered threads, my own mail and automated senders", async () => {
  user = "u-1";
  const authorize = await connect("google");
  assert.ok(authorize.searchParams.get("scope").split(" ").includes(GMAIL_MODIFY), "new connections can organize mail");
  assert.ok(!authorize.searchParams.get("scope").includes("chat."), "Google Chat is asked for only when chosen");
  const status = (await get("/account/connections")).body.providers.find((provider) => provider.id === "google");
  assert.deepEqual(status.features, { organize: true, chat: false });

  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/threads", (url) => {
    if (url.pathname.endsWith("/threads")) return { body: { threads: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] } };
    const id = url.pathname.split("/").pop();
    const threads = {
      a: [gmailMessage("a1", "Aman <aman@example.com>")],
      b: [gmailMessage("b1", "Priya <priya@example.com>"), gmailMessage("b2", "Me <me@example.com>", ["SENT"])],
      c: [gmailMessage("c1", "GitHub <noreply@github.com>")],
      d: [gmailMessage("d1", "Me <me@example.com>", ["SENT"]), gmailMessage("d2", "Ravi <ravi@example.com>", ["INBOX", "UNREAD"])],
    };
    return { body: { id, messages: threads[id] } };
  });
  const { status: code, body } = await get("/account/mail/needs-reply?days=5");
  assert.equal(code, 200, JSON.stringify(body));
  assert.deepEqual(body.messages.map((message) => [message.id, message.subject, message.unread]), [["a1", "About a1", false], ["d2", "About d1", true]]);
  const list = calls.find((entry) => entry.key === "GET gmail.googleapis.com/gmail/v1/users/me/threads");
  assert.match(list.url.searchParams.get("q"), /in:inbox newer_than:5d -category:promotions/);
});

test("Gmail: a reply draft stays in the thread with In-Reply-To and References; it is never sent", async () => {
  user = "u-1";
  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/messages/a1", { body: gmailMessage("a1", "Aman <aman@example.com>") });
  replies.set("POST gmail.googleapis.com/gmail/v1/users/me/drafts", { body: { id: "draft-1" } });
  const { status, body } = await post("/account/mail/messages/google/a1/reply-draft", { body: "Thanks Aman, I'll send it today.", replyAll: true });
  assert.equal(status, 201, JSON.stringify(body));
  assert.deepEqual(body.draft, { provider: "google", id: "draft-1", threadId: "t-a1", to: "aman@example.com", cc: ["priya@example.com", "ravi@example.com"], link: "https://mail.google.com/mail/u/0/#drafts", sent: false });
  const draft = calls.filter((entry) => entry.key === "POST gmail.googleapis.com/gmail/v1/users/me/drafts").at(-1);
  assert.equal(draft.body.message.threadId, "t-a1");
  const raw = Buffer.from(draft.body.message.raw, "base64url").toString();
  assert.match(raw, /^To: Aman <aman@example.com>\r\nCc: priya@example.com, ravi@example.com\r\nSubject: Re: About a1\r\nIn-Reply-To: <a1@mail.example>\r\nReferences: <a1@mail.example>/);
  assert.equal(calls.some((entry) => entry.key.includes("/messages/send")), false);
  assert.equal((await post("/account/mail/messages/google/a1/reply-draft", { body: "  " })).status, 400);
});

test("Gmail: archive and labels need the modify permission; labels are found or created; nothing is deleted", async () => {
  user = "u-1";
  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/labels", { body: { labels: [{ id: "Label_1", name: "Invoices" }] } });
  replies.set("POST gmail.googleapis.com/gmail/v1/users/me/labels", { body: { id: "Label_2", name: "Follow up" } });
  replies.set("POST gmail.googleapis.com/gmail/v1/users/me/messages/a1/modify", { body: { id: "a1", labelIds: ["Label_1", "Label_2"] } });
  const { status, body } = await post("/account/mail/messages/google/a1/organize", { archive: true, labels: ["invoices", "Follow up"] });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, { provider: "google", id: "a1", archived: true, labels: ["invoices", "Follow up"] });
  const modify = calls.filter((entry) => entry.key.endsWith("/a1/modify")).at(-1);
  assert.deepEqual(modify.body, { addLabelIds: ["Label_1", "Label_2"], removeLabelIds: ["INBOX"] });
  assert.equal(calls.some((entry) => entry.key.startsWith("DELETE") || entry.key.endsWith("/trash")), false);
  assert.equal((await post("/account/mail/messages/google/a1/organize", {})).status, 400);

  // An older connection without gmail.modify is told to reconnect, and nothing is called.
  user = "u-2";
  await connect("google", { scope: "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose" });
  const before = calls.length;
  const refused = await post("/account/mail/messages/google/a1/organize", { archive: true });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, "scope-missing");
  assert.equal(calls.slice(before).some((entry) => entry.key.includes("/modify")), false);
});

test("attachments: listed when reading, downloaded as a file, and refused above 10 MB", async () => {
  user = "u-1";
  const withFiles = gmailMessage("f1", "Aman <aman@example.com>", ["INBOX"], {});
  withFiles.payload = { ...withFiles.payload, mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("See attached").toString("base64url") } }, { filename: "invoice.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 5 } }, { filename: "video.mov", mimeType: "video/quicktime", body: { attachmentId: "att-2", size: 50 * 1024 * 1024 } }] };
  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/messages/f1", { body: withFiles });
  replies.set("GET gmail.googleapis.com/gmail/v1/users/me/messages/f1/attachments/att-1", { body: { data: Buffer.from("%PDF-").toString("base64url") } });
  const read = await get("/account/mail/messages/google/f1");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.message.attachments, [{ id: "att-1", name: "invoice.pdf", mimeType: "application/pdf", size: 5 }, { id: "att-2", name: "video.mov", mimeType: "video/quicktime", size: 50 * 1024 * 1024 }]);
  assert.equal(read.body.message.body, "See attached");
  const file = await get("/account/mail/messages/google/f1/attachments/att-1");
  assert.equal(file.status, 200);
  assert.equal(file.body.toString(), "%PDF-");
  assert.equal(file.headers.get("content-type"), "application/octet-stream");
  assert.match(file.headers.get("content-disposition"), /attachment; filename="invoice.pdf"/);
  assert.equal(file.headers.get("x-hannah-mime-type"), "application/pdf");
  const big = await get("/account/mail/messages/google/f1/attachments/att-2");
  assert.equal(big.status, 413);
  assert.equal((await get("/account/mail/messages/google/f1/attachments/nope")).status, 404);
});

test("Outlook: needs-reply checks Sent Items per conversation; replies use createReply; archive moves to Archive", async () => {
  user = "u-1";
  await connect("microsoft");
  replies.set("GET graph.microsoft.com/v1.0/me/mailFolders/inbox/messages", { body: { value: [
    { id: "m1", conversationId: "c1", subject: "Contract", from: { emailAddress: { name: "Aman", address: "aman@example.com" } }, receivedDateTime: "2026-11-17T09:00:00Z", bodyPreview: "Can you sign?", isRead: false, webLink: "https://outlook/m1", inferenceClassification: "focused" },
    { id: "m2", conversationId: "c2", subject: "Lunch", from: { emailAddress: { name: "Priya", address: "priya@example.com" } }, receivedDateTime: "2026-11-16T09:00:00Z", bodyPreview: "Friday?", isRead: true, webLink: "https://outlook/m2", inferenceClassification: "focused" },
    { id: "m3", conversationId: "c3", subject: "Sale!", from: { emailAddress: { name: "Shop", address: "deals@shop.example" } }, receivedDateTime: "2026-11-16T08:00:00Z", bodyPreview: "50% off", isRead: true, webLink: "", inferenceClassification: "other" },
  ] } });
  replies.set("GET graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages", (url) => ({ body: { value: url.searchParams.get("$filter").includes("'c2'") ? [{ sentDateTime: "2026-11-16T10:00:00Z" }] : [] } }));
  const needs = await get("/account/mail/needs-reply?provider=microsoft");
  assert.equal(needs.status, 200, JSON.stringify(needs.body));
  assert.deepEqual(needs.body.messages.map((message) => message.id), ["m1"]);

  replies.set("POST graph.microsoft.com/v1.0/me/messages/m1/createReply", { body: { id: "draft-m1", conversationId: "c1", toRecipients: [{ emailAddress: { address: "aman@example.com" } }], webLink: "https://outlook/draft" } });
  const reply = await post("/account/mail/messages/microsoft/m1/reply-draft", { body: "Signed, attached." });
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.body.draft, { provider: "microsoft", id: "draft-m1", threadId: "c1", to: ["aman@example.com"], link: "https://outlook/draft", sent: false });
  assert.deepEqual(calls.filter((entry) => entry.key.endsWith("/createReply")).at(-1).body, { comment: "Signed, attached." });

  replies.set("GET graph.microsoft.com/v1.0/me/messages/m1", { body: { categories: ["Blue"] } });
  replies.set("PATCH graph.microsoft.com/v1.0/me/messages/m1", { body: {} });
  replies.set("POST graph.microsoft.com/v1.0/me/messages/m1/move", { body: { id: "m1-archived" } });
  const organized = await post("/account/mail/messages/microsoft/m1/organize", { archive: true, labels: ["Follow up"] });
  assert.deepEqual(organized.body, { provider: "microsoft", id: "m1-archived", archived: true, labels: ["Follow up"] });
  assert.deepEqual(calls.filter((entry) => entry.key === "PATCH graph.microsoft.com/v1.0/me/messages/m1").at(-1).body, { categories: ["Blue", "Follow up"] });
  assert.deepEqual(calls.filter((entry) => entry.key.endsWith("/m1/move")).at(-1).body, { destinationId: "archive" });
});

test("Google Chat: only after the person also connects it; spaces, messages and a sent message, as that account", async () => {
  user = "u-2";
  const refused = await get("/account/chat/spaces");
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Also connect Google Chat/);

  const authorize = await connect("google", { features: ["chat"] });
  for (const scope of CHAT_SCOPES) assert.ok(authorize.searchParams.get("scope").split(" ").includes(scope), scope);
  assert.deepEqual((await get("/account/connections")).body.providers.find((provider) => provider.id === "google").features, { organize: true, chat: true });

  replies.set("GET chat.googleapis.com/v1/spaces", (url) => (url.pathname === "/v1/spaces"
    ? { body: { spaces: [{ name: "spaces/AAA", displayName: "Team", spaceType: "SPACE", lastActiveTime: "2026-11-17T08:00:00Z" }, { name: "spaces/BBB", spaceType: "DIRECT_MESSAGE", lastActiveTime: "2026-11-17T09:00:00Z" }] } }
    : { body: { messages: [{ name: "spaces/AAA/messages/2", sender: { displayName: "Priya", type: "HUMAN" }, text: "Deploy is at 5", createTime: "2026-11-17T08:00:00Z", thread: { name: "spaces/AAA/threads/t1" } }, { name: "spaces/AAA/messages/1", sender: { displayName: "Aman", type: "HUMAN" }, text: "Who's on call?", createTime: "2026-11-17T07:00:00Z" }] } }));
  const spaces = await get("/account/chat/spaces");
  assert.deepEqual(spaces.body.spaces.map((space) => [space.name, space.displayName]), [["spaces/BBB", "Direct message"], ["spaces/AAA", "Team"]]);
  const messages = await get("/account/chat/messages?space=spaces/AAA&max=10");
  assert.deepEqual(messages.body.messages.map((message) => message.text), ["Who's on call?", "Deploy is at 5"], "oldest first");
  assert.equal(calls.filter((entry) => entry.key === "GET chat.googleapis.com/v1/spaces/AAA/messages").at(-1).url.searchParams.get("orderBy"), "createTime desc");
  assert.equal((await get("/account/chat/messages?space=../../admin")).status, 400);

  replies.set("POST chat.googleapis.com/v1/spaces/AAA/messages", { body: { name: "spaces/AAA/messages/3", createTime: "2026-11-17T10:00:00Z" } });
  const sent = await post("/account/chat/messages", { space: "spaces/AAA", text: "I'll take it", thread: "spaces/AAA/threads/t1" });
  assert.equal(sent.status, 201);
  const call = calls.filter((entry) => entry.key === "POST chat.googleapis.com/v1/spaces/AAA/messages").at(-1);
  assert.deepEqual(call.body, { text: "I'll take it", thread: { name: "spaces/AAA/threads/t1" } });
  assert.equal(call.url.searchParams.get("messageReplyOption"), "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  const db = await getDatabase();
  const { rows } = await db.query("SELECT event FROM hannah_audit WHERE user_id = 'u-2' AND event = 'chat.sent'");
  assert.equal(rows.length, 1);

  // Another account sees none of it.
  user = "u-1";
  assert.equal((await get("/account/chat/spaces")).status, 403);
});
