"use strict";

// Unit tests: the capability contract and the Safety Gateway, with no server, database or robot.
const assert = require("node:assert/strict");
const test = require("node:test");
const contract = require("./robotics/contract");
const safety = require("./robotics/safety");
const { normalizeDescriptor, signCommand, signRequest, requestMessage } = require("./robotics/service");
const { descriptor, state, WORKSPACE } = require("./test-fixtures/robot-client");

function robot(overrides = {}) {
  const described = normalizeDescriptor(descriptor());
  return {
    id: "rb_000000000000000001", name: "Rover", status: "enrolled", simulated: true, simulator: "stand-in", capabilities: described.capabilities, disabled: [], alwaysAsk: [],
    safety: { reported: described.reported }, places: described.profile.places, dock: described.profile.dock, devices: { beacon: true }, sensors: described.profile.sensors,
    state: state(), lastSeenAt: Date.now(), ...overrides,
  };
}
const codes = (verdict) => verdict.violations.map((item) => item.code);

test("every capability carries the whole contract", () => {
  const wanted = ["navigate_to", "stop_motion", "cancel_mission", "pause_mission", "resume_mission", "return_to_dock", "follow_target", "inspect_area", "capture_image", "read_sensor", "report_robot_state", "report_battery_state", "report_surroundings", "set_supported_device_state", "move_robot_arm", "grasp_object", "release_object", "inspect_machine", "execute_approved_workflow"];
  assert.deepEqual(contract.CAPABILITIES.map((item) => item.id).sort(), [...wanted].sort());
  for (const item of contract.CAPABILITIES) {
    assert.ok(item.description && item.title, item.id);
    assert.ok(item.robotTypes.length && item.robotTypes.every((type) => contract.ROBOT_TYPES[type]), `${item.id} robot types`);
    assert.equal(item.input.type, "object", `${item.id} input schema`);
    assert.equal(item.output.type, "object", `${item.id} output schema`);
    assert.ok(item.preconditions.every((id) => contract.PRECONDITIONS[id]), `${item.id} preconditions`);
    assert.equal(item.permissions.service, "robots");
    assert.ok(contract.RISK[item.risk], `${item.id} risk`);
    assert.ok(item.timeoutS.default > 0 && item.timeoutS.max >= item.timeoutS.default, `${item.id} timeout`);
    assert.equal(typeof item.cancel.supported, "boolean");
    assert.ok(item.cancel.behaviour && item.verification.method && item.verification.description, `${item.id} cancel and verification`);
    assert.ok(Array.isArray(item.constraints));
    assert.ok(item.failures.length >= 2 && item.failures.every((failure) => failure.when && failure.response), `${item.id} failure responses`);
  }
  // Nothing HANNAH offers is in the critical class, and every class says what it requires.
  assert.equal(contract.CAPABILITIES.some((item) => item.risk === "critical"), false);
  assert.deepEqual(Object.keys(contract.APPROVAL), Object.keys(contract.RISK));
  // What moves an arm or works near machinery is high risk and has no runtime.
  for (const id of ["follow_target", "inspect_machine"]) assert.deepEqual([contract.capability(id).risk, contract.capability(id).status], ["high", "contract-only"], id);
  // Arms and grippers are high risk, have a runtime (the built-in arm simulator), and belong to arms only.
  for (const id of ["move_robot_arm", "grasp_object", "release_object"]) {
    assert.deepEqual([contract.capability(id).risk, contract.capability(id).status], ["high", "implemented"], id);
    assert.deepEqual(contract.capability(id).robotTypes, ["manipulator-arm", "mobile-manipulator"]);
  }
});

test("no capability takes a raw actuator value", () => {
  const forbidden = /pwm|duty|torque|current|voltage|wheel|motor|effort|raw|cmd_vel|velocity/i;
  for (const item of contract.CAPABILITIES) {
    assert.doesNotMatch(item.id, forbidden);
    for (const name of Object.keys(item.input.properties)) assert.doesNotMatch(name, forbidden, `${item.id}.${name}`);
  }
});

test("a robot registers only what the contract has, for its type, with a runtime behind it", () => {
  const result = contract.registerCapabilities("differential-drive", ["navigate_to", "stop_motion", "navigate_to", "set_motor_pwm", "follow_target", "capture_image", { id: "read_sensor" }, "move_robot_arm"]);
  assert.deepEqual(result.accepted, ["navigate_to", "stop_motion", "read_sensor"]);
  assert.match(result.refused[3].reason, /Not a capability of a Differential-drive mobile robot/);
  assert.deepEqual(contract.registerCapabilities("manipulator-arm", ["move_robot_arm", "grasp_object", "release_object", "navigate_to"]).accepted, ["move_robot_arm", "grasp_object", "release_object"]);
  // Cancel, pause, resume and the battery report are HANNAH's own for every robot: a robot neither registers nor is refused them.
  assert.deepEqual(contract.registerCapabilities("differential-drive", ["cancel_mission", "pause_mission", "resume_mission", "report_battery_state", "report_surroundings"]), { accepted: ["report_surroundings"], refused: [] });
  assert.deepEqual(result.refused.map((item) => item.id), ["set_motor_pwm", "follow_target", "capture_image", "move_robot_arm"]);
  assert.match(result.refused[0].reason, /Not in HANNAH's capability contract/);
  assert.match(result.refused[1].reason, /no runtime implements it yet/);
  // A sensor station doesn't drive.
  assert.deepEqual(contract.registerCapabilities("sensor-station", ["navigate_to", "read_sensor"]).accepted, ["read_sensor"]);
  assert.throws(() => normalizeDescriptor({ ...descriptor(), robotType: "hoverboard" }), /Unknown robot type/);
});

test("input is checked against the capability's schema", () => {
  const input = contract.capability("navigate_to").input;
  assert.deepEqual(contract.validate(input, { x: 1, y: 2 }), []);
  assert.match(contract.validate(input, { x: "1", y: 2 })[0], /x must be a number/);
  assert.match(contract.validate(input, { x: 1, y: 2, wheelSpeed: 3 })[0], /wheelSpeed isn't part of this capability/);
  assert.match(contract.validate(input, { x: 1, y: 2, maxSpeed: 50 })[0], /at most 5/);
  assert.match(contract.validate(input, { x: Number.NaN, y: 2 })[0], /must be a number/);
  assert.match(contract.validate(contract.capability("inspect_area").input, { waypoints: [] })[0], /at least 1/);
  assert.match(contract.validate(contract.capability("set_supported_device_state").input, { device: "beacon", state: "blink" })[0], /one of: on, off/);
});

test("the gateway passes a valid goal and fills in what will be sent", () => {
  const verdict = safety.check({ robot: robot(), capabilityId: "navigate_to", params: { place: "Workbench" } });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  assert.deepEqual(verdict.params, { x: 3, y: 2, place: "workbench", tolerance: 0.25, maxSpeed: 0.5 });
  assert.equal(verdict.risk, "moderate");
  assert.deepEqual(verdict.flags, []);
});

test("the gateway refuses invalid commands, each with its reason", () => {
  const check = (params, capabilityId = "navigate_to", change = {}) => safety.check({ robot: robot(change), capabilityId, params });
  assert.deepEqual(codes(check({ x: 9, y: 0 })), ["outside-workspace"]);
  assert.deepEqual(codes(check({ x: 4.5, y: -3.5 })), ["keep-out"]);
  assert.match(check({ x: 4.5, y: -3.5 }).violations[0].message, /keep-out zone “stairs”/);
  assert.deepEqual(codes(check({ x: 1, y: 1, maxSpeed: 2 })), ["over-speed"]);
  assert.deepEqual(codes(check({ place: "moon" })), ["invalid-input"]);
  assert.match(check({ place: "moon" }).violations[0].message, /no place called “moon” \(it has: dock, workbench, door\)/);
  assert.deepEqual(codes(check({ place: "dock", x: 1, y: 1 })), ["invalid-input"]);
  assert.deepEqual(codes(check({})), ["invalid-input"]);
  assert.deepEqual(codes(check({ x: 1, y: 1, pwm: 255 })), ["invalid-input"]);
  assert.deepEqual(codes(check({ device: "brakes", state: "off" }, "set_supported_device_state")), ["unknown-device"]);
  assert.deepEqual(codes(check({ sensor: "thermal" }, "read_sensor")), ["unknown-sensor"]);
  assert.deepEqual(codes(check({ x: 1, y: 1 }, "grasp_object")).slice(0, 1), ["unsupported"]);
  assert.deepEqual(codes(check({ x: 1, y: 1 }, "open_the_pod_bay_doors")), ["unknown-capability"]);
  assert.deepEqual(codes(check({ x: 1, y: 1 }, "navigate_to", { disabled: ["navigate_to"] })), ["disabled"]);
  assert.deepEqual(codes(check({ x: 1, y: 1 }, "navigate_to", { status: "revoked" })), ["revoked"]);
  // A robot that reported no speed limit or no workspace isn't moved at all.
  assert.deepEqual(codes(check({ x: 1, y: 1 }, "navigate_to", { safety: { reported: { workspace: { frame: "map", polygon: WORKSPACE } } } })), ["no-speed-limit"]);
  assert.deepEqual(codes(check({ x: 1, y: 1 }, "navigate_to", { safety: { reported: { maxLinearSpeed: 0.5 } } })), ["no-workspace"]);
  // One bad point in a patrol refuses the whole patrol.
  assert.deepEqual(codes(check({ waypoints: [{ place: "workbench" }, { x: 40, y: 0 }] }, "inspect_area")), ["outside-workspace"]);
});

test("the gateway refuses when the robot isn't in a state to move", () => {
  const check = (change, capabilityId = "navigate_to", extra = {}) => codes(safety.check({ robot: robot(change), capabilityId, params: capabilityId === "navigate_to" ? { x: 1, y: 1 } : {}, ...extra }));
  assert.deepEqual(check({ lastSeenAt: Date.now() - 60_000 }), ["precondition:online"]);
  assert.deepEqual(check({ lastSeenAt: null, state: null }), ["precondition:online"]);
  assert.deepEqual(check({ state: state({ estop: { engaged: true } }) }), ["precondition:estop-released"]);
  assert.deepEqual(check({ state: state({ motorsEnabled: false }) }), ["precondition:motors-enabled"]);
  assert.deepEqual(check({ state: state({ faults: [{ code: "bumper", message: "Bumper pressed" }] }) }), ["precondition:no-fault"]);
  assert.deepEqual(check({ state: state({ localized: false }) }), ["precondition:localized"]);
  assert.deepEqual(check({ state: state({ battery: { percent: 9 } }) }), ["precondition:battery-ok"]);
  // A low battery doesn't stop the robot from going home to charge.
  assert.deepEqual(check({ state: state({ battery: { percent: 9 } }) }, "return_to_dock"), []);
  assert.deepEqual(check({}, "navigate_to", { active: { capability: "navigate_to" } }), ["precondition:no-active-motion"]);
  // Stopping needs none of it: not online, not healthy, nothing.
  assert.deepEqual(check({ lastSeenAt: Date.now() - 60_000, state: state({ estop: { engaged: true }, faults: [{ code: "x" }] }) }, "stop_motion"), []);
});

test("a person can tighten a robot's limits and never loosen them", () => {
  const limits = safety.effectiveLimits({ reported: { maxLinearSpeed: 0.5, minBatteryPercent: 15, workspace: { polygon: WORKSPACE } }, owner: { maxLinearSpeed: 2, minBatteryPercent: 5 } });
  assert.equal(limits.maxLinearSpeed, 0.5);
  assert.equal(limits.minBatteryPercent, 15);
  const tighter = safety.effectiveLimits({ reported: { maxLinearSpeed: 0.5, minBatteryPercent: 15 }, owner: { maxLinearSpeed: 0.2, minBatteryPercent: 40 } });
  assert.equal(tighter.maxLinearSpeed, 0.2);
  assert.equal(tighter.minBatteryPercent, 40);
  // A smaller workspace from the owner applies together with the robot's own.
  const fenced = robot({ safety: { reported: normalizeDescriptor(descriptor()).reported, owner: safety.normalizeLimits({ workspace: { polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]] } }) } });
  assert.deepEqual(codes(safety.check({ robot: fenced, capabilityId: "navigate_to", params: { x: 3, y: 2 } })), ["outside-workspace"]);
  assert.equal(safety.check({ robot: fenced, capabilityId: "navigate_to", params: { x: 0.5, y: 0.5 } }).ok, true);
  // Nonsense limits are dropped, not stored.
  assert.deepEqual(safety.normalizeLimits({ maxLinearSpeed: -3, workspace: { polygon: [[0, 0], [1, 1]] }, environment: "moon" }), {});
});

test("a physical robot's movement is flagged for approval and says what HANNAH's stop is not", () => {
  const physical = robot({ simulated: false, safety: { reported: { ...normalizeDescriptor(descriptor()).reported, environment: "shared-with-people", estop: { hardware: true, description: "red mushroom button" } } } });
  const verdict = safety.check({ robot: physical, capabilityId: "navigate_to", params: { x: 1, y: 1 } });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.risk, "high");
  assert.deepEqual(verdict.flags, ["this is a physical robot and it will move"]);
  assert.match(verdict.warnings.join(" "), /software request.*emergency stop within reach/);
  // Reading and stopping a physical robot are not flagged.
  assert.deepEqual(safety.check({ robot: physical, capabilityId: "stop_motion", params: {} }).flags, []);
  // A simulated robot can be set to ask every time, too.
  const asking = robot({ safety: { reported: normalizeDescriptor(descriptor()).reported, owner: { motionRequiresApproval: true } } });
  assert.match(safety.check({ robot: asking, capabilityId: "navigate_to", params: { x: 1, y: 1 } }).flags[0], /ask before every movement/);
});

test("request and command signatures depend on every signed part", () => {
  const secret = Buffer.alloc(32, 7).toString("base64url");
  const parts = { robotId: "rb_000000000000000001", time: "1000", counter: "1", method: "POST", path: "/api/robots/device/sync", body: "{}" };
  const signature = signRequest(secret, parts);
  assert.match(signature, /^[0-9a-f]{64}$/);
  for (const change of [{ robotId: "rb_000000000000000002" }, { time: "1001" }, { counter: "2" }, { method: "GET" }, { path: "/api/robots/device/other" }, { body: "{ }" }]) assert.notEqual(signRequest(secret, { ...parts, ...change }), signature);
  assert.notEqual(signRequest(Buffer.alloc(32, 8).toString("base64url"), parts), signature);
  // The key that signs requests can't sign commands.
  assert.notEqual(signCommand(secret, requestMessage(parts)), signature);
});
