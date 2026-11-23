"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MIGRATIONS } = require("./db/migrations");
const { saveEnvelope, listEnvelopes } = require("./robotics/robot_os_envelopes");

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT user_id FROM hannah_robots/.test(sql)) return { rows: [{ user_id: "owner-1" }] };
      if (/INSERT INTO hannah_robot_os_envelopes/.test(sql)) return { rowCount: 1, rows: [] };
      if (/FROM hannah_robot_os_envelopes/.test(sql)) return { rows: [{ envelope_id: "e1", user_id: "owner-1", robot_id: "r1", kind: "event", ts_ms: 100, received_at: 200, signature: "sig", payload: '{"type":"fault"}' }] };
      return { rows };
    },
  };
}

test("migration 27 creates envelope table with unique id", () => {
  const m = MIGRATIONS.find((x) => x.version === 27);
  assert.ok(m, "migration 27 exists");
  assert.ok(m.statements.some((s) => s.includes("hannah_robot_os_envelopes")));
  assert.equal(new Set(MIGRATIONS.map((x) => x.version)).size, MIGRATIONS.length);
});

test("saveEnvelope stores signed envelope with owner from registry", async () => {
  const db = fakeDb();
  const res = await saveEnvelope(db, { envelope_id: "e1", robot_id: "r1", kind: "event", ts_ms: 100, signature: "sig", payload: { type: "fault" } }, { now: () => 200 });
  assert.equal(res.stored, true);
  assert.equal(res.owner, "owner-1");
  const insert = db.calls.find((c) => c.sql.startsWith("INSERT INTO"));
  assert.equal(insert.params[0], "e1");
  assert.equal(insert.params[1], "owner-1");
  assert.equal(insert.params[6], "sig");
});

test("saveEnvelope respects explicit owner map", async () => {
  const db = fakeDb();
  const res = await saveEnvelope(db, { envelope_id: "e2", robot_id: "r2", kind: "heartbeat", payload: {} }, { ownerMap: { r2: "u2" } });
  assert.equal(res.owner, "u2");
});

test("listEnvelopes is account scoped and parses payload", async () => {
  const db = fakeDb();
  const rows = await listEnvelopes(db, "owner-1", { robotId: "r1", kind: "event", limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.type, "fault");
  const select = db.calls.find((c) => c.sql.includes("FROM hannah_robot_os_envelopes"));
  assert.deepEqual(select.params, ["owner-1", "r1", "event", 5]);
});
