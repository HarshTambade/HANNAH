"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { robotOSActions } = require("./actions/catalog/robot_os");

function fakeServices() {
  const issued = [];
  let status = "acked";
  const commands = {
    issue: async (_db, input) => {
      const command = { id: `rosc_${issued.length + 1}`, ...input, signature: "sig" };
      issued.push(command);
      return command;
    },
    waitFor: async () => ({ status }),
    get: async () => ({ status, ackReason: status === "failed" ? "unsafe" : "" }),
  };
  const robotics = { resolveRobot: async () => ({ id: "rb_1", name: "Workshop robot", simulated: true }) };
  return { robotics, commands, issued, setStatus: (s) => { status = s; } };
}

test("both Robot OS admin actions always require approval", () => {
  const { robotics, commands } = fakeServices();
  const actions = robotOSActions({ robotics, robotOSCommands: commands });
  assert.deepEqual(actions.map((a) => a.id), ["robotos.stage_update", "robotos.activate_update", "robotos.rollback_update"]);
  for (const action of actions) {
    assert.equal(action.standing, false);
    assert.equal(action.kind, "write");
    assert.ok(action.description.length > 20);
  }
});

test("stage update queues a signed command and verifies the ack", async () => {
  const { robotics, commands, issued } = fakeServices();
  const [stage] = robotOSActions({ robotics, robotOSCommands: commands });
  const ctx = { db: {}, userId: "u1" };
  const params = stage.normalize({ robot: "Workshop robot", version: "0.2.0", artifact: "https://example.test/os.tar", sha256: "a".repeat(64), signature: "s", signer: "release" });
  const assessed = await stage.assess(params, ctx);
  assert.equal(assessed.account, "Workshop robot");
  const response = await stage.execute(params, ctx);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].capability, "update.stage");
  assert.equal(issued[0].params.version, "0.2.0");
  assert.equal(response.status, "acked");
  const verdict = await stage.verify(response, params, ctx);
  assert.equal(verdict.confirmed, true);
});

test("a refused rollback is reported as unconfirmed", async () => {
  const { robotics, commands, setStatus } = fakeServices();
  setStatus("failed");
  const [, , rollback] = robotOSActions({ robotics, robotOSCommands: commands });
  const ctx = { db: {}, userId: "u1" };
  const params = rollback.normalize({ robot: "Workshop robot", reason: "bad update" });
  await assert.rejects(() => rollback.execute(params, ctx), /refused this command/);
  const verdict = await rollback.verify({ commandId: "rosc_1", robot: { name: "Workshop robot" }, capability: "update.rollback" }, params, ctx);
  assert.equal(verdict.confirmed, false);
  assert.match(verdict.evidence, /unsafe/);
});
