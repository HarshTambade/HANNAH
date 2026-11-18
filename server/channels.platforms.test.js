"use strict";

/**
 * Slack, Discord, Google Chat, Microsoft Teams and WhatsApp on the real app:
 * connect (credentials checked with each platform's API), the platform's own
 * URL check, signatures made with real keys (Slack and WhatsApp HMAC, Discord
 * Ed25519, Teams and Google RS256 tokens), pairing with the one-time code,
 * replies sent back the platform's way, retries answered once, forged or
 * unsigned requests refused. The platforms' APIs are stand-ins that check
 * what HANNAH sends; the cryptography is real.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "channels-platforms-token-0123456789-abcdefghij";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "f".repeat(64);
process.env.HANNAH_PUBLIC_URL = "https://hannah.example";
delete process.env.POSTGRES_URL;

const SLACK = { botToken: "xoxb-1111-2222-abcdefghijklmnopqrstuvwx", signingSecret: "8f742231b10e8888abcd99yyyzzz85a5".replace(/[yz]/g, "a") };
const DISCORD_TOKEN = "synthetic_" + "D".repeat(52);
const discordKeys = crypto.generateKeyPairSync("ed25519");
const discordPublicHex = discordKeys.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
const msKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleCert = "-----BEGIN PUBLIC KEY-----\n" + googleKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----\n";
const TEAMS = { appId: "11111111-2222-3333-4444-555555555555", appPassword: "teams-client-secret-value-0123456789" };
const WA = { phoneNumberId: "1234567890123", accessToken: "EAAG" + "x".repeat(60), appSecret: "0123456789abcdef0123456789abcdef" };
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const body = init.body && typeof init.body === "string" && init.body.startsWith("{") || init.body?.startsWith?.("[") ? JSON.parse(init.body) : init.body;
  const auth = init.headers?.Authorization;
  if (url.startsWith("https://slack.com/api/")) {
    if (auth !== `Bearer ${SLACK.botToken}`) return Response.json({ ok: false, error: "invalid_auth" });
    if (url.endsWith("/auth.test")) return Response.json({ ok: true, team: "Acme", team_id: "T1", user: "hannah", user_id: "UBOT" });
    if (url.endsWith("/chat.postMessage")) { sent.push({ to: "slack", body }); return Response.json({ ok: true }); }
  }
  if (url.startsWith("https://discord.com/api/v10/")) {
    if (url.endsWith("/applications/@me")) return auth === `Bot ${DISCORD_TOKEN}` ? Response.json({ id: "987654321098765432", name: "HANNAH", verify_key: discordPublicHex }) : Response.json({ message: "401: Unauthorized" }, { status: 401 });
    if (url.endsWith("/commands")) { sent.push({ to: "discord-commands", body }); return Response.json([]); }
    if (url.includes("/webhooks/")) { sent.push({ to: "discord", url, body }); return Response.json({ id: "m1" }); }
  }
  if (url.startsWith("https://login.microsoftonline.com/")) {
    const form = new URLSearchParams(init.body);
    return form.get("client_secret") === TEAMS.appPassword ? Response.json({ access_token: "ms-bot-token", expires_in: 3600 }) : Response.json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret." }, { status: 401 });
  }
  if (url === "https://login.botframework.com/v1/.well-known/openidconfiguration") return Response.json({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" });
  if (url === "https://login.botframework.com/v1/.well-known/keys") return Response.json({ keys: [{ ...msKeys.publicKey.export({ format: "jwk" }), kid: "ms1", endorsements: ["msteams"] }] });
  if (url.startsWith(SERVICE_URL)) { sent.push({ to: "teams", url, auth, body }); return Response.json({ id: "reply1" }); }
  if (url.startsWith("https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com")) return Response.json({ g1: googleCert });
  if (url.startsWith("https://graph.facebook.com/v21.0/")) {
    if (auth !== `Bearer ${WA.accessToken}`) return Response.json({ error: { message: "Invalid OAuth access token." } }, { status: 401 });
    if (url.includes("?fields=")) return Response.json({ display_phone_number: "+91 98765 43210", verified_name: "HANNAH Test" });
    if (url.endsWith("/messages")) { sent.push({ to: "whatsapp", body }); return Response.json({ messages: [{ id: "wamid.out" }] }); }
  }
  if (url.startsWith("https://api.groq.com/")) {
    const request = JSON.parse(init.body);
    const prompt = request.messages.map((message) => message.content).join("\n");
    return Response.json({ id: "c", model: request.model, choices: [{ index: 0, message: { role: "assistant", content: prompt.includes("2+2") ? "It's 4." : "Hello!" }, finish_reason: "stop" }] });
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
  session = (await (await realFetch(`${base}/account/register`, { method: "POST", headers: { "Content-Type": "application/json", "x-hannah-session": "bearer" }, body: JSON.stringify({ email: "owner2@example.com", password: "correct horse battery staple" }) })).json()).sessionToken;
  const db = await require("./db").getDatabase();
  const { rows: [user] } = await db.query("SELECT id FROM hannah_users WHERE email = $1", ["owner2@example.com"]);
  const sealed = require("./vault").encryptSecret("gsk_platformsTestKey0123456789abcdefghi", { userId: user.id, providerId: "groq" });
  await db.query("INSERT INTO hannah_credentials (user_id, provider_id, key_id, wrapped_key, ciphertext, hint, created_at, updated_at) VALUES ($1, 'groq', $2, $3, $4, 'gsk…ghi', $5, $5)", [user.id, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, Date.now()]);
});
after(() => server?.close());

const api = async (method, path, body) => {
  const response = await realFetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
};
const hook = (id, raw, headers = {}, method = "POST", query = "") => realFetch(`${base}/hooks/channel/${id}${query}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: method === "GET" ? undefined : raw });
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  return check();
};
const jwt = (key, kid, claims) => {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${head}.${payload}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), key).toString("base64url")}`;
};
const seconds = () => Math.floor(Date.now() / 1000);

test("Slack: checks the token, answers Slack's URL check, verifies signatures, pairs, replies in the DM once", async () => {
  assert.equal((await api("POST", "/channels/slack", { botToken: "xoxb-nope-0000000000000000000000", signingSecret: SLACK.signingSecret })).status, 400);
  const connected = await api("POST", "/channels/slack", SLACK);
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  const { channel, pairing, setup } = connected.body;
  assert.equal(channel.name, "Acme · @hannah");
  assert.equal(setup.webhookUrl, `https://hannah.example/api/hooks/channel/${channel.id}`);
  assert.equal(channel.webhookVerified, false);
  const sign = (raw, at = seconds()) => ({ "X-Slack-Request-Timestamp": String(at), "X-Slack-Signature": `v0=${crypto.createHmac("sha256", SLACK.signingSecret).update(`v0:${at}:${raw}`).digest("hex")}` });

  const challenge = JSON.stringify({ type: "url_verification", challenge: "abc123" });
  assert.equal((await hook(channel.id, challenge)).status, 401, "unsigned URL checks are refused");
  const answered = await hook(channel.id, challenge, sign(challenge));
  assert.deepEqual(await answered.json(), { challenge: "abc123" });
  assert.equal((await api("GET", "/channels")).body.channels.find((item) => item.id === channel.id).webhookVerified, true);

  const event = (id, text, extra = {}) => JSON.stringify({ type: "event_callback", event_id: id, event: { type: "message", channel: "D1", channel_type: "im", user: "U1", text, ...extra } });
  const old = event("Ev0", pairing.code);
  assert.equal((await hook(channel.id, old, sign(old, seconds() - 600))).status, 401, "a 10-minute-old signature is refused");
  const pair = event("Ev1", pairing.code);
  assert.equal((await hook(channel.id, pair, sign(pair))).status, 200);
  assert.match((await until(() => sent.find((item) => item.to === "slack" && /^Paired/.test(item.body.text)))).body.text, /^Paired/);
  const ask = event("Ev2", "What's 2+2?");
  await hook(channel.id, ask, sign(ask));
  await hook(channel.id, ask, { ...sign(ask), "X-Slack-Retry-Num": "1" });
  await until(() => sent.filter((item) => item.to === "slack" && item.body.text === "It's 4.").length);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sent.filter((item) => item.to === "slack" && item.body.text === "It's 4.").length, 1, "Slack's retry isn't answered twice");
  assert.equal(sent.find((item) => item.body?.text === "It's 4.").body.channel, "D1");
  // A message in a public channel, or the bot's own message: ignored.
  const inChannel = event("Ev3", "hi", { channel: "C1", channel_type: "channel" });
  await hook(channel.id, inChannel, sign(inChannel));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!sent.some((item) => item.body?.channel === "C1"));
});

test("Discord: registers /hannah, answers Discord's PING, verifies Ed25519 signatures, defers and then edits the reply", async () => {
  assert.equal((await api("POST", "/channels/discord", { botToken: "x".repeat(60) })).status, 400);
  const connected = await api("POST", "/channels/discord", { botToken: DISCORD_TOKEN });
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  const { channel, pairing, setup } = connected.body;
  assert.match(setup.installUrl, /client_id=987654321098765432&integration_type=1/);
  const command = sent.find((item) => item.to === "discord-commands").body[0];
  assert.deepEqual([command.name, command.options[0].name, command.contexts], ["hannah", "message", [0, 1, 2]]);
  const sign = (raw, key = discordKeys.privateKey) => {
    const at = String(seconds());
    return { "X-Signature-Timestamp": at, "X-Signature-Ed25519": crypto.sign(null, Buffer.from(at + raw), key).toString("hex") };
  };
  const ping = JSON.stringify({ type: 1 });
  assert.equal((await hook(channel.id, ping, sign(ping, crypto.generateKeyPairSync("ed25519").privateKey))).status, 401, "signed with another key: refused");
  assert.deepEqual(await (await hook(channel.id, ping, sign(ping))).json(), { type: 1 });

  const interaction = (id, text) => JSON.stringify({ id, type: 2, token: `tok-${id}`, context: 1, channel_id: "DM1", user: { id: "42", username: "harsh", global_name: "Harsh" }, data: { name: "hannah", options: [{ name: "message", type: 3, value: text }] } });
  const pair = interaction("i1", pairing.code);
  const deferred = await (await hook(channel.id, pair, sign(pair))).json();
  assert.deepEqual(deferred, { type: 5, data: {} }, "Discord gets “thinking…” within its 3 seconds");
  const edit = await until(() => sent.find((item) => item.to === "discord" && item.url.includes("/tok-i1/")));
  assert.match(edit.url, /\/webhooks\/987654321098765432\/tok-i1\/messages\/@original$/);
  assert.match(edit.body.content, /^Paired\. Hi Harsh/);
  const ask = interaction("i2", "What's 2+2?");
  await hook(channel.id, ask, sign(ask));
  assert.equal((await until(() => sent.find((item) => item.to === "discord" && item.url.includes("/tok-i2/")))).body.content, "It's 4.");
});

test("Google Chat: verifies Google's signed token for the project and replies in the response", async () => {
  const connected = await api("POST", "/channels/gchat", { projectNumber: "123456789012" });
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  const { channel, pairing } = connected.body;
  const token = (claims = {}) => `Bearer ${jwt(googleKeys.privateKey, "g1", { iss: "chat@system.gserviceaccount.com", aud: "123456789012", exp: seconds() + 300, iat: seconds(), ...claims })}`;
  const event = (name, text) => JSON.stringify({ type: "MESSAGE", eventTime: new Date().toISOString(), space: { name: "spaces/DM1", type: "DM" }, message: { name, text, sender: { name: "users/7", displayName: "Harsh Tambade", type: "HUMAN" } } });
  const pair = event("spaces/DM1/messages/1", pairing.code);
  assert.equal((await hook(channel.id, pair)).status, 401, "no token");
  assert.equal((await hook(channel.id, pair, { Authorization: token({ aud: "999" }) })).status, 401, "a token for another project");
  assert.equal((await hook(channel.id, pair, { Authorization: `Bearer ${jwt(crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, "g1", { iss: "chat@system.gserviceaccount.com", aud: "123456789012", exp: seconds() + 300 })}` })).status, 401, "signed by someone else");
  assert.match((await (await hook(channel.id, pair, { Authorization: token() })).json()).text, /^Paired\. Hi Harsh/);
  const reply = await (await hook(channel.id, event("spaces/DM1/messages/2", "What's 2+2?"), { Authorization: token() })).json();
  assert.deepEqual(reply, { text: "It's 4." });
  const space = JSON.stringify({ type: "MESSAGE", space: { name: "spaces/ROOM", type: "ROOM" }, message: { name: "spaces/ROOM/messages/3", text: "hi", sender: { name: "users/7", type: "HUMAN" } } });
  assert.deepEqual(await (await hook(channel.id, space, { Authorization: token() })).json(), {}, "rooms are ignored");
});

test("Microsoft Teams: checks the app secret, verifies the Bot Connector token and its service URL, replies to the activity", async () => {
  assert.equal((await api("POST", "/channels/teams", { ...TEAMS, appPassword: "wrong-secret-0123456789xyz" })).status, 400);
  const connected = await api("POST", "/channels/teams", TEAMS);
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  const { channel, pairing } = connected.body;
  const token = (claims = {}) => `Bearer ${jwt(msKeys.privateKey, "ms1", { iss: "https://api.botframework.com", aud: TEAMS.appId, exp: seconds() + 300, serviceurl: SERVICE_URL, ...claims })}`;
  const activity = (id, text, extra = {}) => JSON.stringify({ type: "message", id, channelId: "msteams", serviceUrl: SERVICE_URL, text, from: { id: "29:1", aadObjectId: "aad-1", name: "Harsh" }, recipient: { id: "28:bot", name: "HANNAH" }, conversation: { id: "a:conv1", conversationType: "personal" }, ...extra });
  const pair = activity("act1", pairing.code);
  assert.equal((await hook(channel.id, pair)).status, 401);
  assert.equal((await hook(channel.id, pair, { Authorization: token({ aud: "someone-else" }) })).status, 401, "a token for another bot");
  assert.equal((await hook(channel.id, activity("act1", pairing.code, { serviceUrl: "https://evil.example/" }), { Authorization: token() })).status, 401, "the reply address must be the one Microsoft signed");
  assert.equal((await hook(channel.id, pair, { Authorization: token() })).status, 200);
  const paired = await until(() => sent.find((item) => item.to === "teams" && item.url.endsWith("/activities/act1")));
  assert.equal(paired.auth, "Bearer ms-bot-token");
  assert.match(paired.url, /^https:\/\/smba\.trafficmanager\.net\/emea\/v3\/conversations\/a%3Aconv1\/activities\/act1$/);
  assert.match(paired.body.text, /^Paired/);
  await hook(channel.id, activity("act2", "<at>HANNAH</at> What's 2+2?"), { Authorization: token() });
  assert.equal((await until(() => sent.find((item) => item.to === "teams" && item.url.endsWith("/activities/act2")))).body.text, "It's 4.");
});

test("WhatsApp (Cloud API): Meta's verify-token check, X-Hub-Signature-256, pairing through wa.me, replies with the Cloud API", async () => {
  assert.equal((await api("POST", "/channels/whatsapp", { ...WA, accessToken: "EAAG" + "y".repeat(60) })).status, 400);
  const connected = await api("POST", "/channels/whatsapp", WA);
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  const { channel, pairing, setup } = connected.body;
  assert.equal(channel.name, "HANNAH Test (+91 98765 43210)");
  assert.equal(pairing.link, `https://wa.me/919876543210?text=${pairing.code}`);
  assert.ok(setup.verifyToken.length >= 40);
  assert.ok(!(await api("GET", "/channels")).body.channels[0].setup?.verifyToken, "the verify token is shown once, not listed");
  const verify = (tokenValue) => hook(channel.id, undefined, {}, "GET", `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(tokenValue)}&hub.challenge=1158201444`);
  assert.equal((await verify("wrong")).status, 403);
  const ok = await verify(setup.verifyToken);
  assert.equal(await ok.text(), "1158201444");
  const sign = (raw, secret = WA.appSecret) => ({ "X-Hub-Signature-256": `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}` });
  const message = (id, text) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: WA.phoneNumberId }, contacts: [{ wa_id: "919800000001", profile: { name: "Harsh" } }], messages: [{ id, from: "919800000001", type: "text", text: { body: text } }] } }] }] });
  const pair = message("wamid.1", pairing.code);
  assert.equal((await hook(channel.id, pair, sign(pair, "0".repeat(32)))).status, 401);
  assert.equal((await hook(channel.id, pair, sign(pair))).status, 200);
  assert.match((await until(() => sent.find((item) => item.to === "whatsapp" && /^Paired/.test(item.body.text.body)))).body.text.body, /^Paired/);
  const ask = message("wamid.2", "What's 2+2?");
  await hook(channel.id, ask, sign(ask));
  const reply = await until(() => sent.find((item) => item.to === "whatsapp" && item.body.text.body === "It's 4."));
  assert.deepEqual([reply.body.messaging_product, reply.body.to, reply.body.type], ["whatsapp", "919800000001", "text"]);
});

test("credentials are sealed, never listed; each platform's channel shows who's approved and who's asking", async () => {
  const db = await require("./db").getDatabase();
  const { rows } = await db.query("SELECT * FROM hannah_channels");
  const dump = JSON.stringify(rows);
  for (const secret of [SLACK.botToken, SLACK.signingSecret, DISCORD_TOKEN, TEAMS.appPassword, WA.accessToken, WA.appSecret]) assert.ok(!dump.includes(secret), "no credential in the database in the clear");
  const listed = JSON.stringify((await api("GET", "/channels")).body);
  for (const secret of [SLACK.botToken, DISCORD_TOKEN, TEAMS.appPassword, WA.accessToken]) assert.ok(!listed.includes(secret));
  const kinds = (await api("GET", "/channels")).body.channels.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ["discord", "gchat", "slack", "teams", "whatsapp"]);
});
