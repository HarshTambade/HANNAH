"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { signEnvelope, createAuthenticator } = require("./robotics/robot_os_auth");
const { createRobotOSBridgeRouter } = require("./robotics/robot_os_router");

test("signature verifies and replay is rejected", async () => {
  const auth = createAuthenticator({ secrets: { r1: "secret" }, now: () => 1000 });
  const env = { envelope_id: "e1", robot_id: "r1", ts_ms: 1000, kind: "heartbeat", payload: { status: "ok" } };
  env.signature = signEnvelope("secret", env);
  assert.equal((await auth.verify(env)).ok, true);
  const replay = await auth.verify(env);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "replayed");
});

test("bad signature and skew rejected", async () => {
  const auth = createAuthenticator({ secrets: { r1: "secret" }, now: () => 1000 });
  assert.equal((await auth.verify({ envelope_id: "e2", robot_id: "r1", ts_ms: 1000, kind: "heartbeat", payload: {}, signature: "bad" })).reason, "bad-signature");
  const skew = { envelope_id: "e3", robot_id: "r1", ts_ms: -100000, kind: "heartbeat", payload: {} };
  skew.signature = signEnvelope("secret", skew);
  assert.equal((await auth.verify(skew)).reason, "clock-skew");
});

async function withServer(router, fn) {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test("bridge router verifies signed envelopes", async () => {
  const auth = createAuthenticator({ secrets: { r1: "secret" }, now: () => 1000 });
  await withServer(createRobotOSBridgeRouter({ auth }), async (base) => {
    const env = { envelope_id: "e10", robot_id: "r1", ts_ms: 1000, kind: "event", payload: { type: "fault" } };
    env.signature = signEnvelope("secret", env);
    const good = await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(env) });
    assert.equal(good.status, 200);
    const bad = await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...env, signature: "bad" }) });
    assert.equal(bad.status, 401);
  });
});

test("bridge router disabled returns 404", async () => {
  await withServer(createRobotOSBridgeRouter({ enabled: false }), async (base) => {
    const r = await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 404);
  });
});
