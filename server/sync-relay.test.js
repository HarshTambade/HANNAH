"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const { createRelayServer } = require("./sync-relay");

let server;
let base;
const envelope = (n) => ({ v: 1, alg: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations: 1000, salt: "s", iv: "i", ciphertext: `c${n}` });
const post = (body) => fetch(`${base}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  server = createRelayServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("a device gets the other devices' envelopes, never its own", async () => {
  assert.equal((await post({ deviceId: "phone", envelope: envelope(1) })).status, 200);
  assert.equal((await post({ deviceId: "laptop", envelope: envelope(2) })).status, 200);
  const forPhone = await (await fetch(`${base}/sync/phone`)).json();
  assert.deepEqual(forPhone.envelopes.map((item) => item.ciphertext), ["c2"]);
  const forTablet = await (await fetch(`${base}/sync/tablet`)).json();
  assert.deepEqual(forTablet.envelopes.map((item) => item.ciphertext).sort(), ["c1", "c2"]);
});

test("it refuses what isn't an encrypted envelope from a named device", async () => {
  assert.equal((await post({ envelope: envelope(3) })).status, 400);
  assert.equal((await post({ deviceId: "phone", envelope: { text: "plain" } })).status, 400);
  assert.equal((await fetch(`${base}/sync`, { method: "POST", body: "not json" })).status, 400);
  assert.equal((await fetch(`${base}/sync/${encodeURIComponent("bad id!")}`)).status, 400);
});

test("it keeps only the newest 100 envelopes per device", async () => {
  for (let n = 0; n < 105; n += 1) await post({ deviceId: "busy", envelope: envelope(`b${n}`) });
  const seen = (await (await fetch(`${base}/sync/someone-else`)).json()).envelopes.filter((item) => item.ciphertext.startsWith("cb"));
  assert.equal(seen.length, 100);
  assert.equal(seen[0].ciphertext, "cb5");
});

test("browsers can call it (CORS preflight)", async () => {
  const response = await fetch(`${base}/sync`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
