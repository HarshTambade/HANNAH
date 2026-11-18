"use strict";

/** "Remember on this browser": a visitor's Groq key in an HttpOnly cookie. */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "remembered-key-test-token-0123456789-abcdefgh";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const KEY = "gsk_rememberedKeyTest0123456789abcdefghij";
let server;
let base;
before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server?.close());

const cookieFrom = (response) => (response.headers.get("set-cookie") || "").split(";")[0];

test("a remembered key is an HttpOnly, SameSite=Strict cookie for /api, and counts as sent with each request", async () => {
  // Without a key, a model route is closed.
  assert.equal((await fetch(`${base}/providers`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/session/key`)).json(), { remembered: false });

  const remembered = await fetch(`${base}/session/key`, { method: "POST", headers: { "X-Groq-API-Key": KEY } });
  assert.equal(remembered.status, 200);
  assert.deepEqual(await remembered.json(), { remembered: true, hint: "gsk_…ghij" });
  const header = remembered.headers.get("set-cookie");
  assert.match(header, /^hannah_groq=gsk_/);
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/api", "Max-Age=2592000"]) assert.ok(header.includes(part), `${part} in ${header}`);

  // The browser sends the cookie back; the key itself is never returned.
  const cookie = cookieFrom(remembered);
  const status = await (await fetch(`${base}/session/key`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(status, { remembered: true, hint: "gsk_…ghij" });
  assert.equal((await fetch(`${base}/providers`, { headers: { Cookie: cookie } })).status, 200, "the remembered key opens the model routes");

  // The operator token isn't mixed with a remembered visitor key.
  const operator = await fetch(`${base}/session/key`, { headers: { Cookie: cookie, Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}` } });
  assert.deepEqual(await operator.json(), { remembered: false });

  // Forgetting clears the cookie.
  const forgot = await fetch(`${base}/session/key`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.match(forgot.headers.get("set-cookie"), /^hannah_groq=;.*Max-Age=0/);
});

test("only a Groq-shaped key is remembered, and a tampered cookie is ignored", async () => {
  assert.equal((await fetch(`${base}/session/key`, { method: "POST" })).status, 400);
  assert.equal((await fetch(`${base}/session/key`, { method: "POST", headers: { "X-Groq-API-Key": "sk-not-groq" } })).status, 400);
  assert.equal((await fetch(`${base}/providers`, { headers: { Cookie: "hannah_groq=not-a-key" } })).status, 401);
});
