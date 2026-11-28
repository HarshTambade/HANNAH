"use strict";

// Unit tests: operating modes, the transition table, safety profiles, autonomy
// policies and the command-validation chain, as pure rules (no server).
const assert = require("node:assert/strict");
const test = require("node:test");
const autonomy = require("./robotics/autonomy");
const chain = require("./robotics/chain");

const WORKSPACE = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const hardware = { maxLinearSpeed: 0.5, maxAngularSpeed: 1.5, maxLinearAccel: 1, minBatteryPercent: 15, linkTimeoutS: 5, workspace: { frame: "map", polygon: WORKSPACE } };
const robot = (overrides = {}) => ({
  id: "rb_000000000000000001", name: "Rover", status: "enrolled", simulated: true, online: true, capabilities: ["navigate_to", "stop_motion"], operatingMode: "mission", safetyProfile: null,
  limits: { maxLinearSpeed: 0.5, environment: "simulation", estop: { hardware: false } }, state: { battery: { percent: 80 } }, ...overrides,
});
const evaluate = (input) => chain.evaluate({ identity: { userId: "u1", source: "chat" }, account: { level: 3, stopped: false }, capabilityId: "navigate_to", gateway: { violations: [], params: { x: 1, y: 1 }, risk: "moderate" }, policy: { policy: "approved_low_risk", missions: [] }, robot: robot(), ...input });

test("the transition table: every mode has its exits, nothing else is allowed, and Safety Stop is reachable from every mode", () => {
  for (const mode of autonomy.MODE_IDS) {
    assert.ok(autonomy.TRANSITIONS[mode], mode);
    if (mode !== "safety_stop") assert.equal(autonomy.transitionRefusal(mode, "safety_stop"), null, `${mode} → safety_stop`);
    for (const to of autonomy.MODE_IDS) {
      if (to === mode) { assert.equal(autonomy.transitionRefusal(mode, to).code, "mode-same"); continue; }
      const refusal = autonomy.transitionRefusal(mode, to);
      assert.equal(refusal === null, autonomy.TRANSITIONS[mode].includes(to), `${mode} → ${to}`);
    }
  }
  // Out of Safety Stop only to Manual or Maintenance; never straight back to autonomy.
  assert.equal(autonomy.transitionRefusal("safety_stop", "mission").code, "transition-not-allowed");
  assert.equal(autonomy.transitionRefusal("safety_stop", "supervised").code, "transition-not-allowed");
  assert.equal(autonomy.transitionRefusal("manual", "mission").code, "transition-not-allowed");
  assert.equal(autonomy.transitionRefusal("maintenance", "mission").code, "transition-not-allowed");
  assert.equal(autonomy.transitionRefusal("manual", "flying").code, "mode-unknown");
});

test("what each mode lets through, by kind of command and where it came from", () => {
  const allowed = (mode, kind, origin = "agent", plan = false) => autonomy.modeRefusal({ mode, commandClass: kind, origin, plan }) === null;
  for (const mode of autonomy.MODE_IDS) { assert.ok(allowed(mode, "stop"), `${mode} stop`); assert.ok(allowed(mode, "observe"), `${mode} observe`); }
  assert.ok(!allowed("safety_stop", "motion") && !allowed("safety_stop", "actuate") && !allowed("safety_stop", "teleop"));
  assert.ok(!allowed("manual", "motion", "person") && allowed("manual", "teleop") && !allowed("manual", "actuate"));
  assert.ok(allowed("assisted", "motion", "person") && !allowed("assisted", "motion", "agent") && !allowed("assisted", "motion", "workflow") && allowed("assisted", "teleop"));
  assert.ok(allowed("supervised", "motion", "workflow") && !allowed("supervised", "motion", "plan", true) && !allowed("supervised", "teleop"));
  assert.ok(allowed("mission", "motion", "plan", true) && !allowed("mission", "teleop"));
  assert.ok(!allowed("maintenance", "motion", "person") && allowed("maintenance", "teleop") && allowed("maintenance", "actuate"));
  assert.ok(autonomy.modeForcesApproval("supervised") && autonomy.modeForcesApproval("assisted") && !autonomy.modeForcesApproval("mission"));
  assert.equal(autonomy.defaultMode({ simulated: true }), "mission");
  assert.equal(autonomy.defaultMode({ simulated: false }), "supervised");
});

test("a safety profile can only tighten the robot's own limits; a looser value is refused, not clamped", () => {
  const good = autonomy.normalizeProfile({ maxLinearSpeed: 0.3, minBatteryPercent: 30, commsTimeoutS: 3, operatingArea: { name: "lab", polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }, geofences: [{ name: "stairs", polygon: [[1, 1], [2, 1], [2, 2]] }], restrictedDestinations: ["door"], allowedMissions: ["navigate_to", "stop_motion"], timeWindows: [{ days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", timeZone: "UTC" }], approval: { motion: "always" }, teleop: { maxLinearSpeed: 0.25, deadmanMs: 400 } }, hardware);
  assert.deepEqual(good.problems, []);
  assert.equal(good.profile.maxLinearSpeed, 0.3);
  assert.equal(good.profile.operatingArea.name, "lab");
  const loose = autonomy.normalizeProfile({ maxLinearSpeed: 0.9, minBatteryPercent: 5, commsTimeoutS: 30, maxLinearAccel: 3, teleop: { maxLinearSpeed: 2 } }, hardware);
  assert.equal(loose.problems.length, 5, loose.problems.join("\n"));
  assert.ok(loose.problems.every((problem) => /looser than the robot's own/.test(problem)));
  const outside = autonomy.normalizeProfile({ operatingArea: [[-9, -9], [9, -9], [9, 9]] }, hardware);
  assert.match(outside.problems[0], /outside the robot's own workspace/);
  assert.match(autonomy.normalizeProfile({ timeWindows: [{ from: "25:00", to: "18:00" }] }, hardware).problems[0], /HH:MM/);
  assert.match(autonomy.normalizeProfile({ allowedMissions: ["teleport"] }, hardware).problems[0], /Not a capability/);
});

test("the profile's rules for a command: operating area, geofences, destinations, missions, time windows, battery, hardware stop", () => {
  const profile = autonomy.normalizeProfile({ operatingArea: [[-2, -2], [2, -2], [2, 2], [-2, 2]], geofences: [{ name: "pit", polygon: [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]] }], restrictedDestinations: ["door"], allowedMissions: ["navigate_to"], minBatteryPercent: 50, requireHardwareEstop: true, timeWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "09:00", to: "17:00", timeZone: "UTC" }] }, hardware).profile;
  const noon = Date.UTC(2026, 10, 25, 12, 0);
  const codes = (input) => autonomy.profileViolations(profile, { capabilityId: "navigate_to", commandClass: "motion", robot: robot({ limits: { estop: { hardware: true } }, state: { battery: { percent: 80 } } }), now: noon, ...input }).map((item) => item.code);
  assert.deepEqual(codes({ sent: { x: 0, y: -1 } }), []);
  assert.deepEqual(codes({ sent: { x: 3, y: 0 } }), ["profile:outside-operating-area"]);
  assert.deepEqual(codes({ sent: { x: 1, y: 1 } }), ["profile:geofence"]);
  assert.deepEqual(codes({ params: { place: "door" }, sent: { x: 0, y: 0 } }), ["profile:destination-restricted"]);
  assert.deepEqual(codes({ capabilityId: "inspect_area", sent: { waypoints: [{ x: 0, y: 0 }] } }), ["profile:mission-not-allowed"]);
  assert.deepEqual(codes({ now: Date.UTC(2026, 10, 25, 20, 0), sent: { x: 0, y: 0 } }), ["profile:outside-time-window"]);
  assert.deepEqual(codes({ robot: robot({ limits: { estop: { hardware: false } }, state: { battery: { percent: 20 } } }), sent: { x: 0, y: 0 } }), ["profile:no-hardware-estop", "profile:battery"]);
  // A stop and a read are never refused by a profile.
  assert.deepEqual(autonomy.profileViolations(profile, { capabilityId: "stop_motion", commandClass: "stop", now: Date.UTC(2026, 10, 25, 23) }), []);
  // A window past midnight.
  assert.ok(autonomy.inTimeWindows([{ days: [3], from: "22:00", to: "06:00", timeZone: "UTC" }], Date.UTC(2026, 10, 26, 2)));
});

test("autonomy policies: the strictest that applies wins; there is no policy that turns the checks off", () => {
  assert.equal(autonomy.normalizePolicy({ policy: "unrestricted" }).error.startsWith("Choose a policy"), true);
  assert.ok(!Object.keys(autonomy.POLICIES).some((id) => /unrestricted|full|off|none/.test(id)));
  assert.match(autonomy.normalizePolicy({ policy: "approved_missions", missions: [] }).error, /at least one/);
  assert.match(autonomy.normalizePolicy({ policy: "approved_missions", missions: ["stop_motion"] }).error, /Not a movement mission/);
  const combined = autonomy.combinePolicies([{ scope: "account", policy: "approved_low_risk", missions: [] }, { scope: "team", policy: "approved_missions", missions: ["navigate_to:dock", "return_to_dock"] }, { scope: "team", policy: "approved_missions", missions: ["return_to_dock"] }]);
  assert.equal(combined.policy, "approved_missions");
  assert.deepEqual(combined.missions, ["return_to_dock"]);
  assert.equal(autonomy.combinePolicies([{ policy: "approved_low_risk", missions: [] }, { policy: "read_only", missions: [] }]).policy, "read_only");
  assert.equal(autonomy.combinePolicies([]).policy, "approved_low_risk");
  assert.ok(autonomy.missionListed(["navigate_to:Dock"], "navigate_to", { place: "dock" }));
  assert.ok(!autonomy.missionListed(["navigate_to:dock"], "navigate_to", { x: 1, y: 1 }));
  assert.ok(autonomy.missionListed(["navigate_to"], "navigate_to", { x: 1, y: 1 }));
});

test("the chain runs in the spec's order and refuses at the earliest failing step, with a typed reason", () => {
  assert.deepEqual(chain.STEPS, ["identity", "user-authorization", "robot-authorization", "capability", "robot-state", "operating-mode", "safety-policy", "approval", "execution"]);
  const ok = evaluate({});
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.steps.map((step) => step.ok), [true, true, true, true, true, true, true, true, null]);
  // Everything wrong at once: the refusal is the identity step, and every problem is still listed in step order.
  const bad = evaluate({
    identity: { userId: "", source: "chat" }, account: { level: 3, stopped: true },
    gateway: { violations: [{ code: "outside-workspace", message: "outside" }, { code: "precondition:online", message: "offline" }, { code: "unsupported", message: "no" }, { code: "revoked", message: "revoked" }], params: {} },
    robot: robot({ operatingMode: "manual" }),
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.refusal, { step: "identity", code: "no-identity", message: "Nobody is named as asking for this command." });
  assert.deepEqual(bad.violations.map((item) => item.step), ["identity", "user-authorization", "robot-authorization", "capability", "robot-state", "operating-mode", "safety-policy"]);
  // One at a time, each step's own reason.
  assert.equal(evaluate({ account: { level: 3, stopped: true } }).refusal.code, "account-stopped");
  assert.equal(evaluate({ policy: { policy: "read_only", missions: [] } }).refusal.step, "robot-authorization");
  assert.equal(evaluate({ gateway: { violations: [{ code: "invalid-input", message: "bad" }], params: {} } }).refusal.step, "capability");
  assert.equal(evaluate({ gateway: { violations: [{ code: "precondition:estop-released", message: "estop" }], params: {} } }).refusal.step, "robot-state");
  assert.equal(evaluate({ robot: robot({ operatingMode: "safety_stop" }) }).refusal.code, "mode-safety-stop");
  assert.equal(evaluate({ teleop: { id: "to_1", operator: "asha@example.com" } }).refusal.code, "manual-control-held");
  assert.equal(evaluate({ gateway: { violations: [{ code: "over-speed", message: "fast" }], params: {} } }).refusal.step, "safety-policy");
  // Approval: at execution, a command that needed a person and didn't get one is refused, whatever the engine decided.
  const needs = evaluate({ stage: "execute", robot: robot({ operatingMode: "supervised" }), authorization: { kind: "action", status: "executing", outcome: "allow", approved: false } });
  assert.deepEqual(needs.refusal && [needs.refusal.step, needs.refusal.code], ["approval", "approval-required"]);
  assert.equal(evaluate({ stage: "execute", robot: robot({ operatingMode: "supervised" }), authorization: { kind: "action", status: "executing", outcome: "ask", approved: true } }).ok, true);
  // At execution, nothing moves without an allowed or approved request behind it; HANNAH itself may only stop.
  assert.equal(evaluate({ stage: "execute", authorization: null }).refusal.code, "not-authorized");
  assert.equal(evaluate({ stage: "execute", authorization: { kind: "action", status: "denied", outcome: "deny", approved: false } }).refusal.code, "not-authorized");
  assert.equal(evaluate({ stage: "execute", authorization: { kind: "system" } }).refusal.code, "not-authorized");
  assert.equal(evaluate({ stage: "execute", capabilityId: "stop_motion", authorization: { kind: "system" }, robot: robot({ operatingMode: "safety_stop" }), account: { level: 1, stopped: true }, policy: { policy: "read_only", missions: [] } }).ok, true);
  // Suggest only: prepared, and never sent.
  const suggested = evaluate({ policy: { policy: "suggest_only", missions: [] } });
  assert.equal(suggested.ok, true);
  assert.match(chain.flagsFor(suggested)[0], /^suggest:/);
  assert.equal(evaluate({ stage: "execute", policy: { policy: "suggest_only", missions: [] }, authorization: { kind: "action", status: "executing", outcome: "allow", approved: true } }).refusal.code, "suggest-only");
});

test("only a fresh execution-stage verdict minted by the chain is accepted for sending", () => {
  const now = Date.now();
  const genuine = evaluate({ stage: "execute", authorization: { kind: "action", status: "executing", outcome: "allow", approved: false }, now });
  assert.equal(genuine.ok, true);
  assert.ok(chain.isGenuine(genuine, { robotId: "rb_000000000000000001", capabilityId: "navigate_to", now }));
  assert.ok(!chain.isGenuine({ ...genuine }, { robotId: "rb_000000000000000001", capabilityId: "navigate_to", now }), "a copy is not a verdict");
  assert.ok(!chain.isGenuine(genuine, { robotId: "rb_other", capabilityId: "navigate_to", now }));
  assert.ok(!chain.isGenuine(genuine, { robotId: "rb_000000000000000001", capabilityId: "return_to_dock", now }));
  assert.ok(!chain.isGenuine(genuine, { robotId: "rb_000000000000000001", capabilityId: "navigate_to", now: now + 60_000 }), "a stale verdict");
  assert.ok(!chain.isGenuine(evaluate({ now }), { robotId: "rb_000000000000000001", capabilityId: "navigate_to", now }), "a preflight verdict");
  assert.throws(() => { genuine.ok = false; }, TypeError);
});

test("manual-control limits: the lowest of the robot's own, the profile's, and Maintenance's cap", () => {
  const limits = autonomy.teleopLimits({ limits: { maxLinearSpeed: 0.5, maxAngularSpeed: 1.5 } }, { teleop: { maxLinearSpeed: 0.4, deadmanMs: 300 } }, "manual");
  assert.deepEqual(limits, { maxLinearSpeed: 0.4, maxAngularSpeed: 1.5, deadmanMs: 300, commandTtlMs: 400 });
  assert.equal(autonomy.teleopLimits({ limits: { maxLinearSpeed: 0.5, maxAngularSpeed: 1.5 } }, null, "maintenance").maxLinearSpeed, 0.2);
});
