"use strict";

// Unit tests: versions, update package manifests and their validation, staged
// rollout planning, parity reports, regression diffs, the sim-to-real
// lifecycle and the firmware gate. Nothing here runs a simulator or a robot.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const semver = require("./robotics/semver");
const updates = require("./robotics/update_packages");
const rollout = require("./robotics/rollout");
const simtoreal = require("./robotics/simtoreal");
const firmware = require("./robotics/firmware");
const { keyIdOf, sha256 } = require("./robotics/packages");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const keyId = keyIdOf(publicKey);
const trusted = [{ keyId, publicKey: pem, owner: "Acme Robotics" }];
const artifact = Buffer.from("navigation tuning v1.4\n");
const manifest = (change = {}) => ({
  schema: "hannah-update/1", id: "com.acme.nav-tuning", name: "Navigation tuning", kind: "configuration", version: "1.4.0", publisher: "Acme Robotics", releasedAt: "2026-11-20",
  targets: { hardware: [{ manufacturer: "Acme", model: "Rover 2" }], os: [{ name: "HANNAH Robot OS", range: ">=0.1.0 <1.0.0" }], ros: [], runtime: ">=0.1.0 <0.3.0" },
  dependencies: [], artifacts: [{ path: "nav.json", sha256: sha256(artifact), size: artifact.length }],
  changelog: "Lower top speed in narrow corridors.", install: { instructions: "Staged by Robot OS; the robot is held stopped.", requiresStop: true, reboot: false },
  recovery: { procedure: "Restore the configuration backup taken before installing.", rollback: "config-restore" },
  healthChecks: [{ id: "robot-ready", description: "Robot OS READY gate", timeoutS: 120 }],
  tests: { level: "simulation", passed: 5, total: 5, evidence: "robotops sim run" }, config: { limits: { maxLinearSpeed: 0.4 } },
  ...change,
});
const signed = (change) => updates.signManifest(manifest(change), privateKey, keyId);
const robot = (change = {}) => ({
  id: "rb_1", name: "Rover", status: "enrolled", simulated: false, manufacturer: "Acme", model: "Rover 2", robotType: "differential-drive", os: "HANNAH Robot OS 0.2.1", rosDistro: "", runtimeVersion: "0.1.0", softwareVersion: "2.0.0", firmwareVersion: "fw-3.1",
  serialNumber: "AC-0042", online: true, capabilities: ["navigate_to", "stop_motion"], commissioning: { status: "approved" },
  sensors: [{ id: "lidar", type: "2d-range", frame: "laser", rateHz: 5 }, { id: "odometry", type: "wheel-odometry", frame: "odom", rateHz: 50 }], actuators: [{ id: "base", type: "differential-drive", model: "ACME-MC-7" }],
  safety: { reported: { maxLinearSpeed: 0.5, maxAngularSpeed: 1.6, maxLinearAccel: 0.8, robotRadius: 0.18, linkTimeoutS: 5, commandTtlS: 20, workspace: { frame: "map" } } },
  state: { mode: "idle", battery: { percent: 80 }, estop: { engaged: true } },
  ...change,
});

test("versions and ranges", () => {
  assert.equal(semver.compare("1.2.3", "1.10.0"), -1);
  assert.equal(semver.compare("1.3.0-rc.1", "1.3.0"), -1);
  assert.ok(semver.satisfies("1.4.2", "^1.2.0"));
  assert.ok(!semver.satisfies("2.0.0", "^1.2.0"));
  assert.ok(semver.satisfies("0.3.9", "^0.3.1") && !semver.satisfies("0.4.0", "^0.3.1"));
  assert.ok(semver.satisfies("1.2.9", "~1.2.0") && !semver.satisfies("1.3.0", "~1.2.0"));
  assert.ok(semver.satisfies("0.2.0", ">=0.1.0 <0.3.0") && !semver.satisfies("0.3.0", ">=0.1.0 <0.3.0"));
  assert.ok(semver.satisfies("5.0.0", "<1.0.0 || >=5.0.0"));
  assert.ok(!semver.satisfies("1.3.0-rc.1", "^1.2.0"), "a prerelease isn't picked up by a plain range");
  assert.ok(semver.satisfies("1.3.0-rc.2", ">=1.3.0-rc.1"));
  assert.ok(semver.satisfies("9.9.9", "*"));
  assert.ok(!semver.satisfies("not-a-version", "*"));
  assert.equal(semver.validRange(">=abc"), false);
  assert.equal(semver.maxSatisfying(["1.0.0", "1.4.0", "2.0.0"], "^1.0.0"), "1.4.0");
});

test("a manifest needs every PART 10 field", () => {
  assert.deepEqual(updates.validateManifest(signed()), []);
  const problems = updates.validateManifest({ schema: "hannah-update/1" });
  for (const field of ["id", "name", "kind", "version", "publisher", "releasedAt", "targets", "dependencies", "artifacts", "changelog", "install", "recovery", "healthChecks", "tests", "signature"]) {
    assert.ok(problems.some((problem) => problem.startsWith(field)), `${field}: ${problems.join(" | ")}`);
  }
  assert.match(updates.validateManifest(signed({ version: "^1.0.0" })).join(" "), /exact version/);
  assert.match(updates.validateManifest(signed({ kind: "driver", targets: { ...manifest().targets, hardware: [{ robotType: "differential-drive" }] } })).join(" "), /exact manufacturer and model/);
  assert.match(updates.validateManifest(signed({ kind: "os-image", recovery: { procedure: "x", rollback: "none" } })).join(" "), /A\/B slot/);
  assert.match(updates.validateManifest(signed({ config: { limits: { maxLinearSpeed: 1e-7 } } })).join(" "), /0\.0001/);
  assert.match(updates.validateManifest(signed({ config: { limits: { warpDrive: 1 } } })).join(" "), /config\.limits may set/);
});

test("signature, publisher and pinned keys", () => {
  const good = updates.verifySignature(signed(), trusted);
  assert.deepEqual([good.signature.ok, good.publisher.ok], [true, true]);
  assert.equal(updates.verifySignature({ ...signed(), changelog: "changed" }, trusted).signature.ok, false);
  assert.match(updates.verifySignature(signed(), []).signature.detail, /isn't pinned/);
  assert.match(updates.verifySignature(signed(), [{ ...trusted[0], revokedAt: Date.UTC(2026, 10, 2) }]).signature.detail, /revoked on 2026-11-02/);
  const impostor = updates.verifySignature(signed({ publisher: "Someone Else" }), trusted);
  assert.deepEqual([impostor.signature.ok, impostor.publisher.ok], [true, false]);
  assert.deepEqual(updates.verifyArtifacts(signed(), { "nav.json": artifact }), { ok: true, problems: [] });
  assert.match(updates.verifyArtifacts(signed(), { "nav.json": Buffer.from("tampered") }).problems[0], /Changed since it was signed/);
});

test("compatibility uses what the robot reported", () => {
  assert.ok(updates.compatibility(signed(), robot()).ok);
  const wrong = updates.compatibility(signed(), robot({ model: "Rover 3", os: "Ubuntu 24.04", runtimeVersion: "0.3.1" }));
  assert.deepEqual(wrong.checks.filter((check) => !check.ok).map((check) => check.id), ["hardware", "os", "runtime"]);
  const ros = updates.compatibility(signed({ targets: { ...manifest().targets, ros: ["jazzy"] } }), robot({ rosDistro: "humble" }));
  assert.match(ros.checks.find((check) => check.id === "ros").detail, /needs ROS 2 jazzy/);
  const ubuntu = signed({ targets: { ...manifest().targets, os: [{ name: "Ubuntu", versions: ["24.04"] }] } });
  assert.ok(updates.compatibility(ubuntu, robot({ os: "Ubuntu 24.04.1 LTS" })).ok);
  assert.ok(!updates.compatibility(ubuntu, robot({ os: "Ubuntu 22.04" })).ok);
  assert.ok(!updates.compatibility(signed(), robot({ installed: { "com.acme.nav-tuning": "1.4.0" } })).ok, "the same version again is refused");
});

test("dependencies resolve in order, and missing ones or cycles are reported", () => {
  const base = { id: "com.acme.base", version: "1.1.0", dependencies: [] };
  const driver = { id: "com.acme.driver", version: "2.0.0", dependencies: [{ id: "com.acme.base", range: "^1.0.0" }] };
  const app = { id: "com.acme.app", version: "1.0.0", dependencies: [{ id: "com.acme.driver", range: ">=2.0.0" }, { id: "com.acme.base", range: "^1.0.0" }] };
  assert.deepEqual(updates.resolveDependencies(app, { available: [base, driver] }).order.map((item) => item.id), ["com.acme.base", "com.acme.driver"]);
  assert.equal(updates.resolveDependencies(app, { available: [driver], installed: { "com.acme.base": "1.0.5" } }).order[0].source, "installed");
  assert.match(updates.resolveDependencies(app, { available: [base] }).problems[0], /needs com\.acme\.driver >=2\.0\.0/);
  const a = { id: "com.x.a", version: "1.0.0", dependencies: [{ id: "com.x.b", range: "*" }] };
  const b = { id: "com.x.b", version: "1.0.0", dependencies: [{ id: "com.x.a", range: "*" }] };
  assert.match(updates.resolveDependencies(a, { available: [a, b] }).problems.join(" "), /cycle/);
});

test("validation covers signature, publisher, compatibility, deps, tests, config, backup, rollback and approval", () => {
  const report = updates.validate(signed(), { robot: robot(), trustedKeys: trusted });
  assert.deepEqual(report.checks.map((check) => check.id), ["manifest", "signature", "publisher", "integrity", "compatibility", "dependencies", "tests", "config", "backup", "rollback", "approval"]);
  assert.equal(report.ok, true, report.problems.join(" "));
  assert.equal(report.checks.find((check) => check.id === "approval").pending, true);
  const raise = updates.validate(signed({ config: { limits: { maxLinearSpeed: 0.9 } } }), { robot: robot(), trustedKeys: trusted });
  assert.equal(raise.ok, false);
  assert.match(raise.problems.join(" "), /raises maxLinearSpeed from 0\.5 to 0\.9.*commissioned again/);
  const failingTests = updates.validate(signed({ tests: { level: "unit", passed: 3, total: 5, evidence: "ci" } }), { robot: robot(), trustedKeys: trusted });
  assert.match(failingTests.problems.join(" "), /3 of 5 tests/);
  const image = updates.validate(signed({ kind: "os-image", config: undefined, recovery: { procedure: "boot loader falls back", rollback: "ab-slot" } }), { robot: robot(), trustedKeys: trusted });
  assert.match(image.problems.join(" "), /hasn't reported Robot OS update state/);
  assert.ok(updates.validate(signed({ kind: "os-image", config: undefined, recovery: { procedure: "boot loader falls back", rollback: "ab-slot" } }), { robot: { ...robot(), robotOS: true }, trustedKeys: trusted }).ok);
  const noRollback = updates.validate(signed({ config: undefined, kind: "application", recovery: { procedure: "reinstall by hand", rollback: "none" } }), { robot: robot(), trustedKeys: trusted });
  assert.match(noRollback.problems.join(" "), /can't be rolled back/);
});

test("rollout waves: never every robot at once by default", () => {
  const eligible = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const good = rollout.planWaves({ development: ["a"], test: ["b"], limited: ["c", "d"], wider: ["e", "f", "g", "h"] }, eligible);
  assert.deepEqual([good.ok, good.waves.map((wave) => wave.stage)], [true, ["development", "test", "limited", "wider"]]);
  assert.match(rollout.planWaves({ wider: eligible }, eligible).problems.join(" "), /first wave.*one robot/);
  assert.match(rollout.planWaves({ development: ["a"], wider: ["a", "b"] }, eligible).problems.join(" "), /more than one wave/);
  assert.match(rollout.planWaves({ development: ["a"], limited: ["b", "c", "d"], wider: ["e"] }, eligible).problems.join(" "), /at most a quarter/);
  assert.match(rollout.planWaves({ development: ["zz"] }, eligible).problems.join(" "), /isn't eligible/);
  assert.ok(rollout.planWaves({ wider: eligible }, eligible, { allowAllAtOnce: true }).ok, "only an explicit choice lifts it");
  assert.ok(rollout.planWaves({ development: ["a"] }, eligible).ok, "one robot is one robot");
});

test("rollout: a wave waits for the one before; health checks must all be reported passing", () => {
  const plan = rollout.planWaves({ development: ["a"], test: ["b"] }, ["a", "b"]);
  const record = { id: "ro", status: "planned", waves: plan.waves, targets: { a: rollout.newTarget("a", 0), b: rollout.newTarget("b", 1) } };
  assert.equal(rollout.canStart(record, 0).ok, true);
  assert.match(rollout.canStart(record, 1).reason, /isn't healthy yet/);
  const started = rollout.settle({ ...record, waves: record.waves.map((wave, index) => (index === 0 ? { ...wave, status: "installing" } : wave)), targets: { ...record.targets, a: rollout.move(record.targets.a, "staging", 1, "", { deadlineAt: 100 }) } }, 1);
  assert.equal(started.status, "in-progress");
  assert.deepEqual(rollout.overdue(started, 99), []);
  assert.deepEqual(rollout.overdue(started, 100).map((target) => target.robotId), ["a"], "silence past the deadline is a failure");
  const healthy = rollout.settle({ ...started, targets: { ...started.targets, a: rollout.move(started.targets.a, "healthy", 2) } }, 2);
  assert.equal(healthy.status, "paused");
  assert.equal(rollout.canStart(healthy, 1).ok, true);
  const failed = rollout.settle({ ...started, targets: { ...started.targets, a: rollout.move(started.targets.a, "failed", 2, "x") } }, 2);
  assert.equal(failed.status, "halted");
  assert.match(rollout.canStart(failed, 1).reason, /halted/);
  const checks = [{ id: "robot-ready", description: "READY" }, { id: "nav-smoke", description: "nav" }];
  assert.equal(rollout.judgeHealth(checks, [{ id: "robot-ready", ok: true }]).ok, false, "an unreported check isn't a pass");
  assert.equal(rollout.judgeHealth(checks, [{ id: "robot-ready", ok: true }, { id: "nav-smoke", ok: true }]).ok, true);
  assert.equal(rollout.judgeHealth(checks, [{ id: "robot-ready", ok: true }, { id: "nav-smoke", ok: "yes" }]).ok, false);
});

const sim = { profile: "sim-diffdrive", simulator: "hannah-kinematic", robot: { radius: 0.18 }, descriptor: { manufacturer: "HANNAH", model: "Simulated differential-drive base", robotType: "differential-drive", adapter: "kinematic", firmwareVersion: "none (simulated)", runtimeVersion: "0.1.0", softwareVersion: "0.1.0", rosDistro: "", os: "host operating system", capabilities: ["navigate_to", "stop_motion"], limits: { maxLinearSpeed: 0.5, maxAngularSpeed: 1.6, maxLinearAccel: 0.8, maxAngularAccel: 3, linkTimeoutS: 5, commandTtlS: 20 }, sensors: [{ id: "lidar", type: "2d-range", frame: "laser", rateHz: 5 }, { id: "odometry", type: "wheel-odometry", frame: "odom", rateHz: 50 }, { id: "camera", type: "rgbd-camera", frame: "camera_link" }] } };

test("parity report: blocking differences and unverified assumptions", () => {
  const same = simtoreal.parityReport(sim, {}, robot());
  assert.equal(same.ok, true, same.blocking.join("; "));
  assert.ok(same.assumptions.length >= simtoreal.SIM_ONLY.length);
  assert.ok(same.assumptions.some((item) => /firmware version/.test(item.text)), "firmware is always unverified");
  assert.ok(same.assumptions.some((item) => /camera/.test(item.text)), "a simulated sensor the robot lacks is listed");
  const faster = simtoreal.parityReport(sim, {}, robot({ safety: { reported: { ...robot().safety.reported, maxLinearSpeed: 1.2, robotRadius: 0.3 } } }));
  assert.equal(faster.ok, false);
  assert.match(faster.blocking.join(" "), /faster than anything that was simulated/);
  assert.match(faster.blocking.join(" "), /larger than the simulated one/);
  const slowerSim = simtoreal.parityReport(sim, { limits: { maxLinearSpeed: 0.3 } }, robot());
  assert.match(slowerSim.blocking.join(" "), /top linear speed/, "an override slower than the robot's limit leaves the robot's top speed untested");
  const noLidar = simtoreal.parityReport(sim, {}, robot({ sensors: [] }));
  assert.match(noLidar.blocking.join(" "), /Navigation in the simulation relied on this sensor/);
  const arm = simtoreal.parityReport(sim, {}, robot({ robotType: "arm" }));
  assert.match(arm.blocking.join(" "), /different kind of robot/);
  assert.notEqual(simtoreal.parityReport(sim, {}, robot()).hash, faster.hash);
  assert.equal(same.physical, false);
});

const summary = (change = {}) => ({ scenarios: 5, scenariosPassed: 5, missionCompletion: 0.9, navigationReliability: 1, timeouts: 0, errorsPerTrip: 0, faults: 0, closestApproachM: 0.23, maxOdometryErrorM: 0.02, simulatedSeconds: 150, maxLinearSpeed: 0.5, maxLinearAccel: 0.8, cpuMs: 1000, peakRssKb: 20000, ...change });
const runOf = (id, change, results = [{ name: "valid-navigation", passed: true, problems: [] }]) => ({ id, summary: summary(change), results, simulator: "hannah-kinematic" });

test("regression diff against a baseline", () => {
  assert.equal(simtoreal.regressionDiff(runOf("r1"), null).verdict, "no-baseline");
  assert.equal(simtoreal.regressionDiff(runOf("r2"), runOf("r1")).verdict, "pass");
  const worse = simtoreal.regressionDiff(runOf("r2", { missionCompletion: 0.7, faults: 1, simulatedSeconds: 200 }), runOf("r1"));
  assert.equal(worse.verdict, "regressed");
  assert.deepEqual(worse.items.filter((item) => item.status === "regressed").map((item) => item.key), ["missionCompletion", "faults", "simulatedSeconds"]);
  const resources = simtoreal.regressionDiff(runOf("r2", { cpuMs: 3000, maxLinearSpeed: 0.4 }), runOf("r1"));
  assert.equal(resources.verdict, "pass", "resource use and changed motion are warnings, not regressions");
  assert.equal(resources.warnings.length, 2);
  const brokeScenario = simtoreal.regressionDiff(runOf("r2", {}, [{ name: "valid-navigation", passed: false, problems: ["step 1: expected succeeded, got failed"] }]), runOf("r1"));
  assert.match(brokeScenario.regressions.join(" "), /passed in the baseline and fails now/);
  const better = simtoreal.regressionDiff(runOf("r2", { closestApproachM: 0.3 }), runOf("r1"));
  assert.equal(better.items.find((item) => item.key === "closestApproachM").status, "improved");
});

test("sim-to-real lifecycle: simulation passing never authorises anything physical", () => {
  const parity = simtoreal.parityReport(sim, {}, robot());
  const run = runOf("r1");
  const deployment = { change: { simProfile: "sim-diffdrive", capabilities: [] }, sim, parity, runIds: ["r1"], inspected: { runId: "r1", by: "asha" }, acknowledged: { ids: parity.assumptions.map((item) => item.id), by: "asha" }, approvals: [], observations: [], stage: "simulation" };
  const before = simtoreal.evaluate(deployment, { robot: robot(), run, baseline: run });
  assert.equal(before.steps.length, 14);
  assert.equal(before.readyForApproval, true, JSON.stringify(before.steps.filter((step) => !step.ok)));
  assert.equal(before.steps.find((step) => step.id === "approval").ok, false, "ready is not approved");
  assert.equal(before.next, "approval");
  const approved = { ...deployment, stage: "development", approvals: [{ stage: "development", by: "asha", at: 1000, runId: "r1", parityHash: parity.hash }] };
  const afterApproval = simtoreal.evaluate(approved, { robot: robot(), run, baseline: run });
  assert.equal(afterApproval.steps.find((step) => step.id === "approval").ok, true);
  assert.equal(afterApproval.next, "physical-test");
  const missions = [{ id: "m1", capability: "navigate_to", status: "succeeded", verification: { confirmed: true }, createdAt: 2000 }];
  assert.equal(simtoreal.evaluate(approved, { robot: robot(), run, baseline: run, missions }).next, "observe");
  assert.equal(simtoreal.evaluate(approved, { robot: robot(), run, baseline: run, missions: [{ ...missions[0], createdAt: 500 }] }).next, "physical-test", "a mission before the approval doesn't count");
  // A new run, or a changed robot, voids the approval.
  assert.equal(simtoreal.evaluate({ ...approved, runIds: ["r2"] }, { robot: robot(), run: runOf("r2"), baseline: run, missions }).steps.find((step) => step.id === "approval").ok, false);
  const uncommissioned = simtoreal.evaluate(deployment, { robot: robot({ commissioning: { status: "trial" } }), run, baseline: run });
  assert.equal(uncommissioned.readyForApproval, false);
  assert.match(uncommissioned.steps.find((step) => step.id === "commissioning").detail, /isn't commissioned/);
  const regressed = simtoreal.evaluate(deployment, { robot: robot(), run: runOf("r2", { faults: 2 }), baseline: run });
  assert.equal(regressed.steps.find((step) => step.id === "regression").ok, false);
  const openAssumption = simtoreal.evaluate({ ...deployment, acknowledged: { ids: [], by: "asha" } }, { robot: robot(), run, baseline: run });
  assert.match(openAssumption.steps.find((step) => step.id === "assumptions").detail, /not acknowledged/);
});

const fwManifest = (change = {}) => ({ ...manifest({ kind: "firmware", config: undefined, recovery: { procedure: "Hold BOOT, power on, flash the previous image over USB DFU with the vendor tool.", rollback: "none" } }), firmware: { controller: "Acme motor controller", hardwareIds: ["ACME-MC-7"], fromVersions: ["fw-3.1"], minBatteryPercent: 50, recoveryMethod: "bootloader-dfu" }, ...change });
const request = { manufacturer: "Acme", model: "Rover 2", serialNumber: "AC-0042", controllerHardwareId: "ACME-MC-7" };
const verified = { signature: { ok: true }, publisher: { ok: true } };

test("firmware: exact identity, firmware match, compatibility, power and recovery are all checked", () => {
  assert.deepEqual(firmware.firmwareProblems(fwManifest()), []);
  assert.match(firmware.firmwareProblems(manifest()).join(" "), /isn't a firmware package/);
  const good = firmware.checks({ request, manifest: fwManifest(), verified, robot: robot() });
  assert.deepEqual(good.filter((check) => !check.ok).map((check) => check.id), [], JSON.stringify(good));
  const ids = (checks) => checks.filter((check) => !check.ok).map((check) => check.id);
  assert.deepEqual(ids(firmware.checks({ request: { ...request, serialNumber: "AC-0043" }, manifest: fwManifest(), verified, robot: robot() })), ["identity"]);
  assert.deepEqual(ids(firmware.checks({ request: { ...request, controllerHardwareId: "ACME-MC-8" }, manifest: fwManifest(), verified, robot: robot() })), ["identity"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot({ firmwareVersion: "fw-2.0" }) })), ["firmware"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified: { signature: { ok: false } }, robot: robot() })), ["firmware"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot({ runtimeVersion: "0.9.0" }) })), ["compatibility"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot({ state: { mode: "idle", battery: { percent: 30 }, estop: { engaged: true } } }) })), ["power"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot({ state: { mode: "idle", battery: { percent: 30 }, power: { external: true }, estop: { engaged: true } } }) })), []);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot({ state: { mode: "navigating", battery: { percent: 90 }, estop: { engaged: false } } }) })), ["power"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot(), activeMissions: 1 })), ["power"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: fwManifest(), verified, robot: robot({ online: false }) })), ["power"]);
  assert.deepEqual(ids(firmware.checks({ request, manifest: { ...fwManifest(), recovery: { procedure: "pray", rollback: "none" } }, verified, robot: robot() })), ["recovery"]);
});

test("firmware: only a signed-in person who typed the robot's name and serial can authorise; no driver for a physical robot", async () => {
  const at = 1_000;
  assert.throws(() => firmware.authorize({ caller: { via: "api-key" }, robot: robot(), confirmName: "Rover", confirmSerial: "AC-0042", atRobot: true, now: at }), /signed-in person/);
  assert.throws(() => firmware.authorize({ caller: { via: "session" }, robot: robot(), confirmName: "Rover", confirmSerial: "AC-0042", atRobot: false, now: at }), /at the robot/);
  assert.throws(() => firmware.authorize({ caller: { via: "session" }, robot: robot(), confirmName: "rover", confirmSerial: "AC-0042", atRobot: true, now: at }), /exactly/);
  assert.equal(firmware.authorize({ caller: { via: "session", email: "asha@x" }, robot: robot(), confirmName: "Rover", confirmSerial: "AC-0042", atRobot: true, now: at }).by, "asha@x");
  assert.equal(firmware.flasherFor(robot()), null, "no real flasher exists");
  const simulated = robot({ simulated: true });
  const driver = firmware.flasherFor(simulated);
  assert.equal(driver.id, "simulated");
  const result = await driver.flash({ robot: simulated, manifest: fwManifest() });
  assert.deepEqual([result.ok, result.simulated, result.status], [true, true, "simulated-flashed"]);
  assert.match(result.detail, /Nothing was written to any hardware/);
  assert.equal((await driver.flash({ robot: robot(), manifest: fwManifest() })).ok, false);
});

test("no Action Engine action can flash firmware, approve a stage or start a rollout", () => {
  const catalog = [require("./actions/catalog/robots"), require("./actions/catalog/robot_os"), require("./actions/catalog/hardware"), require("./actions/catalog/device")];
  const text = catalog.map((mod) => Object.keys(mod).join(" ")).join(" ");
  assert.doesNotMatch(text, /firmware|rollout|deployment/i);
  const fs = require("node:fs");
  const sources = fs.readdirSync(`${__dirname}/actions/catalog`).map((file) => fs.readFileSync(`${__dirname}/actions/catalog/${file}`, "utf8")).join("\n");
  assert.doesNotMatch(sources, /robotops|authorizeFirmware|approveWave|approveStage/);
});

test("the signed fixture Robot OS checks in Python verifies here too", () => {
  const fixture = JSON.parse(require("node:fs").readFileSync(`${__dirname}/../robot-os/tests/fixtures/signed_update_package.json`, "utf8"));
  assert.deepEqual(updates.validateManifest(fixture.manifest), []);
  const verdict = updates.verifySignature(fixture.manifest, [{ keyId: fixture.keyId, publicKey: fixture.publicKey, owner: fixture.owner }]);
  assert.deepEqual([verdict.signature.ok, verdict.publisher.ok], [true, true]);
});

test("the package tool builds, signs and verifies a package", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-update-"));
  const tool = path.join(__dirname, "scripts", "robot-update.js");
  const run = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [tool, ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }) }; } catch (error) { return { code: error.status, out: `${error.stdout}${error.stderr}` }; } };
  try {
    fs.mkdirSync(path.join(dir, "pkg"));
    fs.writeFileSync(path.join(dir, "pkg", "nav.json"), artifact);
    const { signature: _s, artifacts: _a, ...unsigned } = manifest();
    fs.writeFileSync(path.join(dir, "pkg", updates.MANIFEST), JSON.stringify(unsigned));
    assert.equal(run("keygen", "acme").code, 0);
    assert.equal((fs.statSync(path.join(dir, "acme.private.pem")).mode & 0o777).toString(8), "600");
    const signedRun = run("sign", "pkg", "acme.private.pem");
    assert.equal(signedRun.code, 0, signedRun.out);
    const written = JSON.parse(fs.readFileSync(path.join(dir, "pkg", updates.MANIFEST), "utf8"));
    assert.deepEqual(written.artifacts, [{ path: "nav.json", sha256: sha256(artifact), size: artifact.length }]);
    assert.equal(run("verify", "pkg", "acme.public.pem", "Acme Robotics").code, 0);
    assert.equal(run("verify", "pkg", "acme.public.pem", "Someone Else").code, 1, "the publisher must be the key's owner");
    fs.writeFileSync(path.join(dir, "pkg", "nav.json"), "tampered");
    assert.match(run("verify", "pkg", "acme.public.pem", "Acme Robotics").out, /Changed since it was signed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
