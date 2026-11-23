"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateBridgeEnvelope } = require("./robotics/robot_os_bridge");

test("validateBridgeEnvelope accepts valid heartbeat", () => {
  const res = validateBridgeEnvelope({
    envelope_id: "env1", robot_id: "r1", ts_ms: 1, kind: "heartbeat", payload: { status: "ok" }
  });
  assert.equal(res.ok, true);
});

test("validateBridgeEnvelope rejects invalid kind and missing fields", () => {
  const res = validateBridgeEnvelope({ envelope_id: "env1", robot_id: "r1", ts_ms: 1, kind: "bad", payload: {} });
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes("invalid kind"));
});
