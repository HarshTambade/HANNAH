"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MIGRATIONS } = require("./db/migrations");
const { commandMessage, signCommand, createRobotOSCommandService } = require("./robotics/robot_os_commands");

function fakeDb() {
  const calls = [];
  const pending = [{ id: "rosc_1", robot_id: "r1", capability: "update.stage", params: '{"version":"0.2.0"}', issued_at: 1000, expires_at: 9000, nonce: "n1", signature: "sig", status: "pending" }];
  let getRow = null;
  return {
    calls,
    setGet(row) { getRow = row; },
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO")) return { rowCount: 1 };
      if (/FROM hannah_robot_os_commands\s+WHERE robot_id/.test(sql)) return { rows: pending };
      if (sql.startsWith("UPDATE hannah_robot_os_commands")) return { rowCount: 1 };
      if (sql.includes("FROM hannah_robot_os_commands WHERE id")) return { rows: getRow ? [getRow] : [] };
      return { rows: [] };
    },
  };
}

test("migration 28 creates signed command table", () => {
  const m = MIGRATIONS.find((x) => x.version === 28);
  assert.ok(m);
  assert.ok(m.statements.some((s) => s.includes("hannah_robot_os_commands")));
});

test("command signature is deterministic and covers params", () => {
  const cmd = { id: "c1", robotId: "r1", capability: "update.stage", issuedAt: 1, expiresAt: 2, nonce: "n", params: { version: "0.2.0" } };
  const a = signCommand("secret", cmd);
  assert.equal(a, signCommand("secret", cmd));
  assert.notEqual(a, signCommand("secret", { ...cmd, params: { version: "0.3.0" } }));
  assert.ok(commandMessage(cmd).includes("r1"));
});

test("issue signs and stores a command", async () => {
  const db = fakeDb();
  const svc = createRobotOSCommandService({ secrets: { r1: "secret" }, now: () => 1000, ttlMs: 5000 });
  const cmd = await svc.issue(db, { userId: "u1", robotId: "r1", capability: "update.stage", params: { version: "0.2.0" } });
  assert.equal(cmd.expiresAt, 6000);
  assert.equal(cmd.signature, signCommand("secret", cmd));
  const insert = db.calls.find((c) => c.sql.startsWith("INSERT INTO"));
  assert.equal(insert.params[1], "u1");
  assert.equal(insert.params[8], cmd.signature);
});

test("pending commands are returned and ack updates status", async () => {
  const db = fakeDb();
  const svc = createRobotOSCommandService({ now: () => 2000 });
  const pending = await svc.pending(db, "r1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].capability, "update.stage");
  assert.equal(await svc.ack(db, { robotId: "r1", commandId: "rosc_1", ok: true }), true);
  const update = db.calls.find((c) => c.sql.startsWith("UPDATE"));
  assert.equal(update.params[0], "acked");
});

test("get is account scoped", async () => {
  const db = fakeDb();
  db.setGet({ id: "rosc_1", robot_id: "r1", capability: "update.stage", status: "acked", ack_reason: "", expires_at: 9000 });
  const svc = createRobotOSCommandService({ now: () => 2000 });
  const got = await svc.get(db, "u1", "rosc_1");
  assert.equal(got.status, "acked");
  const select = db.calls.find((c) => c.sql.includes("WHERE id = $1 AND user_id = $2"));
  assert.deepEqual(select.params, ["rosc_1", "u1"]);
});
