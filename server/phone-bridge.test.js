/**
 * The Phone Bridge end to end against the real server and database. The
 * "phone" here signs exactly as the app does: a WebCrypto ECDSA P-256 key and
 * a signature over id, time, method, path and the SHA-256 of the exact body.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "phone-bridge-test-token-0123456789-abcdefghij";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);

let server;
let baseUrl;

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await require("./db").resetDatabase();
});

async function signUp(email) {
  const response = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers.get("set-cookie").split(";")[0];
}

const computer = (cookie) => {
  const call = async (method, path, body) => {
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { get: (path) => call("GET", path), post: (path, body = {}) => call("POST", path, body), put: (path, body) => call("PUT", path, body), del: (path) => call("DELETE", path) };
};

/** A phone: its own key, signing like PhoneBridge.ts does. */
async function makePhone(cookie) {
  const keys = await crypto.webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const phone = { id: null, publicKey, clockOffset: 0 };
  phone.signed = async (method, path, body, { tamper, time } = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const at = time ?? Date.now() + phone.clockOffset;
    const message = `${phone.id}\n${at}\n${method}\n/api${path}\n${crypto.createHash("sha256").update(tamper ?? text).digest("hex")}`;
    const signature = Buffer.from(await crypto.webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(message))).toString("base64url");
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookie, "X-Hannah-Phone": phone.id, "X-Hannah-Time": String(at), "X-Hannah-Signature": signature }, body: body === undefined ? undefined : text });
    return { status: response.status, body: await response.json() };
  };
  phone.pair = async (code, capabilities = ["call", "sms", "contacts"], name = "Pixel 8") => {
    const response = await fetch(`${baseUrl}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ code, platform: "android", name, publicKey, capabilities }) });
    const body = await response.json();
    if (response.status === 201) phone.id = body.phone.id;
    return { status: response.status, body };
  };
  phone.fetch = () => phone.signed("POST", "/phone/me/commands", {});
  phone.report = (command, status, extra = {}) => phone.signed("POST", `/phone/me/commands/${command.id}/result`, { nonce: command.nonce, status, ...extra });
  return phone;
}

test("pairing: a one-time code from the same account, a fingerprint both sides show, and nothing for strangers", async () => {
  const cookie = await signUp("pair@example.com");
  const laptop = computer(cookie);
  const created = await laptop.post("/phone/pairing", { deviceName: "MacBook" });
  assert.equal(created.status, 201);
  assert.match(created.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // Someone else's phone, signed in to another account, can't use the code.
  const strangerPhone = await makePhone(await signUp("pair-stranger@example.com"));
  assert.equal((await strangerPhone.pair(created.body.code)).status, 400);

  const phone = await makePhone(cookie);
  assert.equal((await phone.pair("ABCD-EFGH")).status, 400, "a wrong code is refused");
  const paired = await phone.pair(created.body.code.toLowerCase().replace("-", " "));
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  assert.match(paired.body.phone.fingerprint, /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
  assert.equal(paired.body.phone.isDefault, true, "the first phone is the default");
  assert.equal(paired.body.phone.pairedBy, "MacBook");
  assert.equal((await (await makePhone(cookie)).pair(created.body.code)).status, 400, "a code works once");

  const status = await laptop.post("/phone/pairing/status", { code: created.body.code });
  assert.equal(status.body.paired, true);
  assert.equal(status.body.phone.fingerprint, paired.body.phone.fingerprint, "the computer shows the same fingerprint");
  const list = await laptop.get("/phone/devices");
  assert.equal(list.body.phones.length, 1);
  assert.equal(list.body.phones[0].online, true);
  assert.equal((await computer(await signUp("pair-other@example.com")).get("/phone/devices")).body.phones.length, 0, "other accounts see nothing");

  // A key with its private half, or not a P-256 key, is refused.
  const code2 = (await laptop.post("/phone/pairing")).body.code;
  const leaky = await fetch(`${baseUrl}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ code: code2, platform: "android", publicKey: { ...phone.publicKey, d: "secret" } }) });
  assert.equal(leaky.status, 400);
  assert.equal((await fetch(`${baseUrl}/api/phone/pair`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ code: code2, platform: "windows", publicKey: phone.publicKey }) })).status, 400, "only Android and iOS pair");
});

test("a call reaches only the signed-in, signing phone, once; it reports what really happened", async () => {
  const cookie = await signUp("call@example.com");
  const laptop = computer(cookie);
  const phone = await makePhone(cookie);
  await phone.pair((await laptop.post("/phone/pairing")).body.code, ["call", "sms"]);

  for (const [number, reason] of [["112", "emergency"], ["+1 911", "emergency"], ["*#06#", "bad-number"], ["call me", "bad-number"], ["12", "bad-number"]]) {
    const refused = await laptop.post("/phone/commands", { action: "call", number });
    assert.equal(refused.status, 400, number);
    assert.equal(refused.body.reason, reason, number);
  }
  assert.equal((await laptop.post("/phone/commands", { action: "lookup", query: "Aman" })).status, 403, "contacts weren't allowed on the phone");

  const call = await laptop.post("/phone/commands", { action: "call", number: "+91 98765-43210", name: "Aman", deviceName: "MacBook" });
  assert.equal(call.status, 201, JSON.stringify(call.body));
  assert.deepEqual(call.body.command.payload, { number: "+919876543210", name: "Aman" });
  assert.equal(call.body.command.status, "pending");

  // Unsigned, badly signed, old or tampered requests get nothing.
  assert.equal((await fetch(`${baseUrl}/api/phone/me/commands`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{}" })).status, 401);
  assert.equal((await phone.signed("POST", "/phone/me/commands", {}, { tamper: "{\"other\":1}" })).status, 401, "the signature covers the body");
  assert.equal((await phone.signed("POST", "/phone/me/commands", {}, { time: Date.now() - 5 * 60_000 })).status, 401, "old timestamps are refused");
  const otherAccountPhone = await makePhone(await signUp("call-other@example.com"));
  otherAccountPhone.id = phone.id;
  assert.equal((await otherAccountPhone.fetch()).status, 403, "another account can't use this phone's id");

  const fetched = await phone.fetch();
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.commands.length, 1);
  const [command] = fetched.body.commands;
  assert.equal(command.action, "call");
  assert.equal(command.requestedBy, "MacBook");
  assert.ok(command.nonce.length >= 20);
  assert.equal((await phone.fetch()).body.commands.length, 0, "handed out once");
  assert.equal((await laptop.get(`/phone/commands/${command.id}`)).body.command.status, "delivered");
  assert.equal((await laptop.post(`/phone/commands/${command.id}/cancel`)).status, 409, "once delivered, it's cancelled on the phone");

  assert.equal((await phone.report({ ...command, nonce: "wrong" }, "dialer-opened")).status, 400);
  assert.equal((await phone.report(command, "sent")).status, 400, "an SMS result isn't a call result");
  assert.equal((await phone.report(command, "dialer-opened")).status, 200);
  assert.equal((await phone.report(command, "dialer-opened")).status, 409, "a result is accepted once");
  const seen = (await laptop.get(`/phone/commands/${command.id}`)).body.command;
  assert.equal(seen.status, "dialer-opened");
  assert.ok(seen.finishedAt);
});

test("SMS: composer opened, then the person's send or cancel; offline phones and late requests get nothing", async () => {
  const cookie = await signUp("sms@example.com");
  const laptop = computer(cookie);
  const phone = await makePhone(cookie);
  await phone.pair((await laptop.post("/phone/pairing")).body.code, ["sms"]);
  assert.equal((await laptop.post("/phone/commands", { action: "call", number: "9876543210" })).status, 403, "calls weren't allowed");
  assert.equal((await laptop.post("/phone/commands", { action: "sms", number: "9876543210" })).status, 400, "a message is needed");

  const sms = await laptop.post("/phone/commands", { action: "sms", number: "9876543210", name: "Aman", body: "I'll reach in 20 minutes." });
  assert.equal(sms.status, 201);
  const [command] = (await phone.fetch()).body.commands;
  assert.equal(command.payload.body, "I'll reach in 20 minutes.");
  assert.equal((await phone.report(command, "composer-opened")).status, 200);
  assert.equal((await laptop.get(`/phone/commands/${command.id}`)).body.command.status, "composer-opened");
  assert.equal((await phone.report(command, "sent")).status, 200, "iOS reports the person's send");
  assert.equal((await phone.report(command, "cancelled")).status, 409);
  assert.equal((await laptop.get(`/phone/commands/${command.id}`)).body.command.status, "sent");

  // A request nobody picked up in time expires and is never handed out later.
  const late = await laptop.post("/phone/commands", { action: "sms", number: "9876543210", body: "hello" });
  const db = await require("./db").getDatabase();
  await db.query("UPDATE hannah_phone_commands SET expires_at = $1 WHERE id = $2", [Date.now() - 1, late.body.command.id]);
  assert.equal((await phone.fetch()).body.commands.length, 0);
  assert.equal((await laptop.get(`/phone/commands/${late.body.command.id}`)).body.command.status, "expired");

  // An offline phone: refused up front, nothing queued.
  await db.query("UPDATE hannah_paired_phones SET last_seen_at = $1 WHERE id = $2", [Date.now() - 5 * 60_000, phone.id]);
  const offline = await laptop.post("/phone/commands", { action: "sms", number: "9876543210", body: "hello" });
  assert.equal(offline.status, 409);
  assert.equal(offline.body.reason, "phone-offline");
  assert.equal((await laptop.get("/phone/devices")).body.phones[0].online, false);
  // A heartbeat brings it back, and the phone can change what it allows.
  const beat = await phone.signed("POST", "/phone/me/heartbeat", { capabilities: ["sms", "contacts", "launch-missiles"] });
  assert.deepEqual(beat.body.phone.capabilities, ["sms", "contacts"]);
  assert.equal(beat.body.phone.online, true);
});

test("contact lookup returns only the matches; revoking a phone cuts it off", async () => {
  const cookie = await signUp("lookup@example.com");
  const laptop = computer(cookie);
  const phone = await makePhone(cookie);
  await phone.pair((await laptop.post("/phone/pairing")).body.code);
  const lookup = await laptop.post("/phone/commands", { action: "lookup", query: "Aman" });
  assert.equal(lookup.status, 201);
  const [command] = (await phone.fetch()).body.commands;
  assert.deepEqual(command.payload, { query: "Aman" });
  await phone.report(command, "resolved", { matches: [{ name: "Aman Gupta", numbers: [{ label: "mobile", number: "+91 98765 43210" }, { label: "work", number: "022 4000 1000" }] }, { name: "Aman K", numbers: [] }] });
  const result = (await laptop.get(`/phone/commands/${command.id}`)).body.command;
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.result.matches, [{ name: "Aman Gupta", numbers: [{ label: "mobile", number: "+91 98765 43210" }, { label: "work", number: "022 4000 1000" }] }], "entries without numbers are dropped");

  const pending = await laptop.post("/phone/commands", { action: "call", number: "9876543210" });
  assert.equal((await laptop.del(`/phone/devices/${phone.id}`)).status, 200);
  assert.equal((await laptop.get(`/phone/commands/${pending.body.command.id}`)).body.command.status, "expired", "its waiting requests end");
  assert.equal((await phone.fetch()).status, 403, "a revoked phone gets nothing");
  assert.equal((await laptop.post("/phone/commands", { action: "call", number: "9876543210" })).status, 409, "no phone left to call from");
  assert.equal((await laptop.get("/phone/devices")).body.phones.length, 0);
});
