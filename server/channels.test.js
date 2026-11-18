"use strict";

/**
 * Telegram channel end to end on the real app: connect a bot (checked with
 * getMe, webhook set with a secret), pair your own chat with the one-time
 * code, then chat (replies from your account's AI key). Strangers, wrong
 * secrets, group chats and Telegram's retries get nothing from the AI.
 */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "channels-test-token-0123456789-abcdefghijklm";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.HANNAH_PUBLIC_URL = "https://hannah.example";
delete process.env.POSTGRES_URL;

const BOT = "123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra";
const telegramCalls = [];
const aiPrompts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.telegram.org/")) {
    const method = url.split("/").pop();
    const body = init.body ? JSON.parse(init.body) : {};
    telegramCalls.push({ method, body, token: url.split("/bot")[1].split("/")[0] });
    if (method === "getMe") return Response.json({ ok: true, result: { id: 42, is_bot: true, username: "hannah_test_bot" } });
    return Response.json({ ok: true, result: true });
  }
  if (url.startsWith("https://api.groq.com/")) {
    const body = JSON.parse(init.body);
    aiPrompts.push(body.messages.map((message) => message.content).join("\n"));
    return Response.json({ id: "c", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "It's 4." }, finish_reason: "stop" }] });
  }
  return realFetch(input, init);
};

let server;
let base;
let session;
before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
  const registered = await (await realFetch(`${base}/account/register`, { method: "POST", headers: { "Content-Type": "application/json", "x-hannah-session": "bearer" }, body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery staple" }) })).json();
  session = registered.sessionToken;
  const db = await require("./db").getDatabase();
  const { rows: [user] } = await db.query("SELECT id FROM hannah_users WHERE email = $1", ["owner@example.com"]);
  const sealed = require("./vault").encryptSecret("gsk_channelsTestKey0123456789abcdefghijk", { userId: user.id, providerId: "groq" });
  await db.query("INSERT INTO hannah_credentials (user_id, provider_id, key_id, wrapped_key, ciphertext, hint, created_at, updated_at) VALUES ($1, 'groq', $2, $3, $4, 'gsk…hijk', $5, $5)", [user.id, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, Date.now()]);
});
after(() => server?.close());

const api = async (method, path, body) => {
  const response = await realFetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
let updateId = 100;
const deliver = (id, secret, message, { sameUpdate = false } = {}) => realFetch(`${base}/hooks/telegram/${id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
  body: JSON.stringify({ update_id: sameUpdate ? updateId : ++updateId, message: { message_id: updateId, date: 0, chat: { id: message.chat ?? 111, type: message.type ?? "private" }, from: { id: message.chat ?? 111, first_name: message.name ?? "Harsh" }, text: message.text } }),
});
const sentTo = (chat) => telegramCalls.filter((call) => call.method === "sendMessage" && call.body.chat_id === chat).map((call) => call.body.text);

test("connect a bot, pair your chat with the one-time code, and chat with HANNAH; strangers get nothing", async () => {
  assert.equal((await api("POST", "/channels/telegram", { botToken: "not-a-token" })).status, 400);
  const connected = await api("POST", "/channels/telegram", { botToken: BOT });
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  assert.equal(connected.body.channel.name, "@hannah_test_bot");
  const { code, link } = connected.body.pairing;
  assert.equal(link, `https://t.me/hannah_test_bot?start=${code}`);
  const hook = telegramCalls.find((call) => call.method === "setWebhook");
  const id = connected.body.channel.id;
  assert.equal(hook.body.url, `https://hannah.example/api/hooks/telegram/${id}`);
  assert.deepEqual(hook.body.allowed_updates, ["message"]);
  const secret = hook.body.secret_token;
  assert.ok(secret.length >= 40);

  // The bot token is sealed, never stored in the clear.
  const db = await require("./db").getDatabase();
  const { rows: [row] } = await db.query("SELECT * FROM hannah_channels WHERE id = $1", [id]);
  assert.ok(!JSON.stringify(row).includes(BOT.split(":")[1]), "the token isn't in the database in the clear");
  assert.ok(!JSON.stringify(row).includes(secret) && !JSON.stringify(row).includes(code), "secrets and codes are hashed");

  // Without Telegram's secret, nothing.
  assert.equal((await deliver(id, null, { text: "hi" })).status, 401);
  assert.equal((await deliver(id, "wrong-secret", { text: "hi" })).status, 401);

  // A stranger before pairing: told it's private, no AI.
  assert.equal((await deliver(id, secret, { chat: 999, text: "hello?", name: "Stranger" })).status, 200);
  assert.match(sentTo(999).at(-1), /private/);
  assert.equal(aiPrompts.length, 0);
  // A wrong code doesn't pair.
  await deliver(id, secret, { chat: 999, text: "/start hnWRONGCODE1234" });
  assert.equal((await api("GET", "/channels")).body.channels[0].paired, false);

  // The owner pairs with the code from the link.
  await deliver(id, secret, { text: `/start ${code}` });
  assert.match(sentTo(111).at(-1), /^Paired\. Hi Harsh/);
  const listed = (await api("GET", "/channels")).body.channels[0];
  assert.deepEqual([listed.paired, listed.pairedName, listed.pairingOpen], [true, "Harsh", false]);

  // Chat: HANNAH answers with the account's AI key, and keeps context.
  await deliver(id, secret, { text: "What's 2+2?" });
  assert.equal(sentTo(111).at(-1), "It's 4.");
  assert.match(aiPrompts.at(-1), /User: What's 2\+2\?/);
  await deliver(id, secret, { text: "And times 3?" });
  assert.match(aiPrompts.at(-1), /User: What's 2\+2\?\nHANNAH: It's 4\.\nUser: And times 3\?/);
  const asked = aiPrompts.length;

  // Telegram retrying the same update: answered once. A group chat or a stranger: no AI. The used code can't pair again.
  await deliver(id, secret, { text: "And times 3?" }, { sameUpdate: true });
  await deliver(id, secret, { chat: -5, type: "group", text: "hey bot" });
  await deliver(id, secret, { chat: 999, text: `/start ${code}` });
  assert.equal(aiPrompts.length, asked);
  assert.equal(sentTo(999).at(-1), "This HANNAH bot is private.");
  assert.deepEqual(sentTo(-5), []);

  // Disconnect removes the webhook.
  assert.equal((await api("DELETE", `/channels/${id}`)).status, 200);
  assert.ok(telegramCalls.some((call) => call.method === "deleteWebhook" && call.token === BOT));
  assert.equal((await deliver(id, secret, { text: "still there?" })).status, 401);
});

test("channels need a signed-in account", async () => {
  const response = await realFetch(`${base}/channels`, { headers: { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}` } });
  assert.equal(response.status, 401);
});
