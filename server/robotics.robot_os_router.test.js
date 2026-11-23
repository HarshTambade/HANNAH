"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { createRobotOSBridgeRouter } = require("./robotics/robot_os_router");

async function withServer(router, fn) {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("robot os bridge router accepts valid envelope", async () => {
  let seen = null;
  await withServer(createRobotOSBridgeRouter({ onEnvelope: async (e) => { seen = e; } }), async (base) => {
    const r = await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope_id: "e1", robot_id: "r1", ts_ms: 1, kind: "heartbeat", payload: {} }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(seen.envelope_id, "e1");
  });
});

test("robot os bridge router rejects invalid envelope", async () => {
  await withServer(createRobotOSBridgeRouter(), async (base) => {
    const r = await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "bad" }) });
    assert.equal(r.status, 400);
  });
});

test("bridge returns pending commands on heartbeat and records acks", async () => {
  const acks = [];
  await withServer(createRobotOSBridgeRouter({
    pendingCommands: async (robotId) => [{ id: "rosc_1", robotId, capability: "update.stage" }],
    onCommandAck: async (env) => { acks.push(env.payload); },
  }), async (base) => {
    const hb = await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope_id: "e20", robot_id: "r1", ts_ms: 1, kind: "heartbeat", payload: {} }) });
    const body = await hb.json();
    assert.equal(body.commands.length, 1);
    assert.equal(body.commands[0].capability, "update.stage");
    await fetch(`${base}/robotos/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope_id: "e21", robot_id: "r1", ts_ms: 1, kind: "command_ack", payload: { commandId: "rosc_1", ok: true } }) });
    assert.equal(acks.length, 1);
    assert.equal(acks[0].commandId, "rosc_1");
  });
});
