"use strict";

// Integration tests: robot operations against the real server and database.
//   - simulator runs are real runs of HANNAH's built-in simulator (robotics/runtime, Python);
//   - robots are the stand-in robot from robotics.test.js: it reports what the test scripts
//     and moves nothing;
//   - the robot side of a rollout is the real Robot OS command dispatcher (robot-os/src),
//     run per command by test-fixtures/robot_os_dispatch.py, which verifies the signed package
//     with Ed25519 and runs its own READY gate and health checks.
// Nothing here is a physical robot, and nothing claims to be.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robotops-test-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "f".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
process.env.HANNAH_ROBOT_OS_BRIDGE = "1";
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");
const { signEnvelope } = require("./robotics/robot_os_auth");
const updates = require("./robotics/update_packages");
const { sha256 } = require("./robotics/packages");

let server;
let base;
let db;
const users = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-robotops-"));
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
};

const PHYSICAL = (change = {}) => descriptor({
  manufacturer: "Acme", model: "Rover 2", os: "HANNAH Robot OS 0.2.1", runtimeVersion: "0.1.0", softwareVersion: "2.0.0", firmwareVersion: "fw-3.1", serialNumber: "AC-0042", adapter: "acme-base",
  sensors: [{ id: "lidar", type: "2d-range", frame: "laser", rateHz: 5 }, { id: "odometry", type: "wheel-odometry", frame: "odom", rateHz: 50 }, { id: "battery", type: "battery" }],
  actuators: [{ id: "drive", type: "differential-drive", model: "ACME-MC-7" }],
  simulation: null,
  limits: { ...descriptor().limits, maxLinearSpeed: 0.5, maxAngularSpeed: 1.5, maxLinearAccel: 0.8, robotRadius: 0.18, environment: "shared-with-people", estop: { hardware: true, description: "red button" } },
  ...change,
});

async function enrolled(who, name, { simulated = false, described } = {}) {
  const created = await call(who, "POST", "/robots", { name, simulated });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  const answer = await robot.enroll(created.body.enrollment.code, described || (simulated ? descriptor({ manufacturer: "Acme", model: "Rover 2", serialNumber: "SIM-1", actuators: [{ id: "drive", type: "differential-drive", model: "ACME-MC-7" }], runtimeVersion: "0.1.0", firmwareVersion: "fw-3.1" }) : PHYSICAL()));
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal((await robot.sync()).status, 200);
  return robot;
}
const commissioned = async (robotId) => {
  const steps = Object.fromEntries(require("./robotics/commissioning").ORDER.map((id) => [id, { at: Date.now(), note: "test" }]));
  await db.query("UPDATE hannah_robots SET commissioning = $1 WHERE id = $2", [JSON.stringify({ startedAt: Date.now(), steps }), robotId]);
};

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["asha", "bo"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@robotops.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  }
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.ashaKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("simulator runs are real, stored, compared with a baseline and never physical", async () => {
  const info = await call(users.asha, "GET", "/robotops/simulator");
  assert.equal(info.status, 200);
  assert.equal(info.body.available.ok, true, JSON.stringify(info.body.available));
  assert.ok(info.body.profiles.some((profile) => profile.name === "sim-diffdrive" && profile.scenarioRunner));
  assert.ok(info.body.scenarios.some((scenario) => scenario.name === "valid-navigation"));
  assert.equal((await call(users.asha, "POST", "/robotops/sim-runs", { profile: "../../etc/passwd" })).status, 404);
  assert.equal((await call(users.asha, "POST", "/robotops/sim-runs", { profile: "sim-diffdrive", overrides: { limits: { warp: 9 } }, scenarios: ["valid-navigation"] })).status, 422);
  const first = await call(users.asha, "POST", "/robotops/sim-runs", { profile: "sim-diffdrive", scenarios: ["valid-navigation"] });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.run.status, first.body.run.physical, first.body.run.simulator], ["passed", false, "hannah-kinematic"]);
  assert.equal(first.body.run.summary.trips, 4);
  assert.equal(first.body.run.results[0].name, "valid-navigation");
  assert.equal((await call(users.bo, "GET", `/robotops/sim-runs/${first.body.run.id}`)).status, 404, "another account can't see it");
  const noBaseline = await call(users.asha, "GET", `/robotops/sim-runs/${first.body.run.id}`);
  assert.equal(noBaseline.body.diff.verdict, "no-baseline");
  assert.equal((await call(users.asha, "POST", `/robotops/sim-runs/${first.body.run.id}/baseline`)).status, 200);
  // Half the speed: the same trips take far longer. That is a regression the suite shows.
  const slow = await call(users.asha, "POST", "/robotops/sim-runs", { profile: "sim-diffdrive", scenarios: ["valid-navigation"], overrides: { limits: { maxLinearSpeed: 0.25 } } });
  assert.equal(slow.status, 201);
  const diff = (await call(users.asha, "GET", `/robotops/sim-runs/${slow.body.run.id}`)).body.diff;
  assert.equal(diff.verdict, "regressed");
  assert.ok(diff.items.find((item) => item.key === "simulatedSeconds").status === "regressed");
  assert.ok(diff.items.find((item) => item.key === "maxLinearSpeed").status === "changed");
});

test("sim-to-real: the 14-step lifecycle, a parity report, and a person's approval before anything physical", async () => {
  const atlas = await enrolled(users.asha, "Atlas");
  const sim = await enrolled(users.asha, "Simmy", { simulated: true });
  const change = { kind: "configuration", description: "Cap corridor speed", simProfile: "sim-diffdrive", scenarios: ["valid-navigation", "sensor-loss"], overrides: { limits: { maxLinearSpeed: 0.5 } }, capabilities: ["navigate_to"] };
  assert.equal((await call(users.ashaKey, "POST", "/robotops/deployments", { robotId: atlas.robotId, change })).status, 403, "an agent can't start one");
  assert.equal((await call(users.asha, "POST", "/robotops/deployments", { robotId: sim.robotId, change })).body.reason, "not-physical");
  const created = await call(users.asha, "POST", "/robotops/deployments", { robotId: atlas.robotId, title: "Corridor speed", change });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let deployment = created.body.deployment;
  const id = deployment.id;
  assert.equal(deployment.lifecycle.steps.length, 14);
  assert.equal(deployment.stage, "simulation");
  assert.equal(deployment.parity.ok, true, deployment.parity.blocking.join("; "));
  assert.equal(deployment.parity.physical, false);
  assert.ok(deployment.parity.items.some((item) => item.field === "firmware version" && item.status === "different"));
  assert.ok(deployment.lifecycle.steps.find((step) => step.id === "load-sim").ok);
  assert.ok(deployment.lifecycle.steps.find((step) => step.id === "requirements").ok, deployment.lifecycle.steps.find((step) => step.id === "requirements").detail);

  deployment = (await call(users.ashaKey, "POST", `/robotops/deployments/${id}/simulate`)).body.deployment;
  assert.equal(deployment.latestRun.status, "passed");
  assert.equal(deployment.lifecycle.steps.find((step) => step.id === "simulate").ok, true);
  assert.equal(deployment.lifecycle.steps.find((step) => step.id === "regression").ok, false, "no baseline yet");
  await call(users.asha, "POST", `/robotops/sim-runs/${deployment.latestRun.id}/baseline`);
  assert.equal((await call(users.ashaKey, "POST", `/robotops/deployments/${id}/inspect`, { runId: deployment.latestRun.id, attest: true })).status, 403);
  deployment = (await call(users.asha, "POST", `/robotops/deployments/${id}/inspect`, { runId: deployment.latestRun.id, attest: true })).body.deployment;
  const ids = deployment.parity.assumptions.map((item) => item.id);
  assert.equal((await call(users.asha, "POST", `/robotops/deployments/${id}/assumptions`, { ids: ids.slice(1), attest: true })).body.reason, "incomplete");
  deployment = (await call(users.asha, "POST", `/robotops/deployments/${id}/assumptions`, { ids, attest: true })).body.deployment;
  for (const step of ["select", "load-sim", "requirements", "simulate", "inspect", "regression", "compare", "assumptions", "hardware"]) assert.ok(deployment.lifecycle.steps.find((item) => item.id === step).ok, `${step}: ${deployment.lifecycle.steps.find((item) => item.id === step).detail}`);
  assert.equal(deployment.lifecycle.steps.find((step) => step.id === "commissioning").ok, false);
  // Passing the simulation authorises nothing: the robot isn't commissioned.
  const early = await call(users.asha, "POST", `/robotops/deployments/${id}/approve`, { stage: "development", attest: true });
  assert.deepEqual([early.status, early.body.reason], [409, "not-ready"]);
  await commissioned(atlas.robotId);
  assert.equal((await call(users.ashaKey, "POST", `/robotops/deployments/${id}/approve`, { stage: "development", attest: true })).status, 403, "a model or agent never approves");
  assert.equal((await call(users.asha, "POST", `/robotops/deployments/${id}/approve`, { stage: "development" })).body.reason, "not-attested");
  deployment = (await call(users.asha, "POST", `/robotops/deployments/${id}/approve`, { stage: "development", attest: true })).body.deployment;
  assert.equal(deployment.stage, "development");
  assert.equal(deployment.lifecycle.steps.find((step) => step.id === "approval").ok, true);
  assert.equal(deployment.lifecycle.next, "physical-test");
  assert.equal((await call(users.asha, "POST", `/robotops/deployments/${id}/observe`, { outcome: "ok", note: "looked fine" })).body.reason, "no-physical-test", "no observation without a verified mission");
  // The supervised test is a real mission record on the robot, made after the approval and verified.
  const at = Date.now();
  await db.query(`INSERT INTO hannah_robot_missions (user_id, id, robot_id, capability, params, status, action_id, requested_by, seq, nonce, issued_at, expires_at, deadline_at, created_at, updated_at, verification)
    VALUES ((SELECT user_id FROM hannah_robots WHERE id = $1), $2, $1, 'navigate_to', '{"x":1,"y":1,"maxSpeed":0.2}', 'succeeded', NULL, 'test', 999, 'n', $3, $4, $4, $3, $3, $5)`, [atlas.robotId, `ms_${crypto.randomBytes(4).toString("hex")}`, at + 5, at + 60_000, JSON.stringify({ confirmed: true, evidence: "at goal" })]);
  deployment = (await call(users.asha, "POST", `/robotops/deployments/${id}/observe`, { outcome: "ok", note: "Stopped 3 cm from the mark; slowed at the corridor." })).body.deployment;
  assert.equal(deployment.lifecycle.physicalValidated, true);
  // Expanding takes its own robots, each commissioned and matching the simulation.
  const bolt = await enrolled(users.asha, "Bolt");
  const notReady = await call(users.asha, "POST", `/robotops/deployments/${id}/approve`, { stage: "test", robotIds: [bolt.robotId], attest: true });
  assert.deepEqual([notReady.status, notReady.body.reason], [409, "robot-not-ready"]);
  assert.equal((await call(users.asha, "POST", `/robotops/deployments/${id}/approve`, { stage: "limited", robotIds: [bolt.robotId], attest: true })).body.reason, "wrong-stage");
  await commissioned(bolt.robotId);
  deployment = (await call(users.asha, "POST", `/robotops/deployments/${id}/approve`, { stage: "test", robotIds: [bolt.robotId], attest: true })).body.deployment;
  assert.equal(deployment.stage, "test");
  assert.equal(deployment.lifecycle.steps.find((step) => step.id === "expand").ok, true);
  const rolled = await call(users.asha, "POST", `/robotops/deployments/${id}/rollback`, { reason: "Bolt wobbles at the corridor entrance" });
  assert.equal(rolled.body.deployment.status, "rolled-back");
  assert.ok(rolled.body.deployment.rollbacks[0].actions.every((action) => action.how === "manual"), "HANNAH didn't apply this change, so it says the person must undo it");
  assert.ok(rolled.body.deployment.audit.some((entry) => entry.event === "stage-approved"));
  assert.equal((await call(users.bo, "GET", `/robotops/deployments/${id}`)).status, 404);
});

// ---------- update packages, staged rollout and the Robot OS side ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const artifact = Buffer.from("{\"maxLinearSpeed\":0.4}\n");
const manifest = (change = {}) => updates.signManifest({
  schema: "hannah-update/1", id: "com.acme.nav-tuning", name: "Navigation tuning", kind: "configuration", version: "1.4.0", publisher: "Acme Robotics", releasedAt: "2026-11-20",
  targets: { hardware: [{ manufacturer: "Acme", model: "Rover 2" }], os: [{ name: "HANNAH Robot OS", range: ">=0.1.0 <1.0.0" }], ros: [], runtime: ">=0.1.0 <0.3.0" },
  dependencies: [], artifacts: [{ path: "nav.json", sha256: sha256(artifact), size: artifact.length }], changelog: "Lower corridor speed.",
  install: { instructions: "Staged by Robot OS while the robot is held stopped.", requiresStop: true, reboot: false },
  recovery: { procedure: "Restore the configuration backup taken before installing.", rollback: "config-restore" },
  healthChecks: [{ id: "robot-ready", description: "Robot OS READY gate", timeoutS: 60 }, { id: "nav-smoke", description: "Navigation stack answers", timeoutS: 60 }],
  tests: { level: "simulation", passed: 5, total: 5, evidence: "robotops sim run" }, config: { limits: { maxLinearSpeed: 0.4 } }, ...change,
}, privateKey);
const FACTS = { manufacturer: "Acme", model: "Rover 2", robotType: "differential-drive", os: "HANNAH Robot OS 0.2.1", rosDistro: "", runtimeVersion: "0.1.0", softwareVersion: "2.0.0", firmwareVersion: "fw-3.1" };

/** One Robot OS exchange for a robot: heartbeat, run each command through the real dispatcher, send its acks. */
async function robotOSExchange(robot, { ready = true, healthChecks = { "nav-smoke": true } } = {}) {
  const envelope = (kind, payload) => {
    const env = { envelope_id: `env_${crypto.randomBytes(8).toString("hex")}`, robot_id: robot.robotId, ts_ms: Date.now(), kind, payload };
    return { ...env, signature: signEnvelope(robot.secret, env) };
  };
  const post = async (env) => (await fetch(`${base}/api/robotos/bridge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env) })).json();
  const answer = await post(envelope("heartbeat", { status: "ok" }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const acks = [];
  for (const command of answer.commands) {
    const run = spawnSync("python3", [path.join(__dirname, "test-fixtures", "robot_os_dispatch.py"), path.join(tmp, robot.robotId)], { input: JSON.stringify({ secret: robot.secret, robotId: robot.robotId, command, trustedKeys: [{ owner: "Acme Robotics", publicKey: publicPem }], facts: FACTS, ready, healthChecks }), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const ack = JSON.parse(run.stdout);
    acks.push({ capability: command.capability, ...ack });
    assert.equal((await post(envelope("command_ack", ack))).ok, true);
  }
  return acks;
}

test("update packages: pinned keys, signed manifests, validation per robot, staged rollout, health checks and automatic rollback", async () => {
  const keyBody = { owner: "Acme Robotics", publicKey: publicPem };
  assert.equal((await call(users.ashaKey, "POST", "/robotops/keys", keyBody)).status, 403, "an agent can't pin a key");
  assert.equal((await call(users.asha, "POST", "/robotops/keys", { owner: "x", publicKey: "nope" })).body.reason, "bad-key");
  assert.equal((await call(users.asha, "POST", "/robotops/keys", keyBody)).status, 201);
  const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
  assert.equal((await call(users.asha, "POST", "/robotops/packages", { manifest: updates.signManifest(manifest(), stranger) })).body.reason, "untrusted-package");
  assert.equal((await call(users.asha, "POST", "/robotops/packages", { manifest: { ...manifest(), changelog: "edited after signing" } })).body.reason, "untrusted-package");
  assert.equal((await call(users.asha, "POST", "/robotops/packages", { manifest: manifest({ publisher: "Evil Corp" }) })).body.reason, "untrusted-package");
  assert.equal((await call(users.bo, "POST", "/robotops/packages", { manifest: manifest() })).body.reason, "untrusted-package", "keys are pinned per account");
  const uploaded = await call(users.asha, "POST", "/robotops/packages", { manifest: manifest() });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal((await call(users.asha, "POST", "/robotops/packages", { manifest: manifest() })).body.reason, "duplicate-version");
  const pkg = uploaded.body.package;

  const one = await enrolled(users.asha, "Unit-1");
  const two = await enrolled(users.asha, "Unit-2");
  const old = await enrolled(users.asha, "Unit-old", { described: PHYSICAL({ runtimeVersion: "0.0.9", serialNumber: "AC-0001" }) });
  const validation = (await call(users.asha, "GET", `/robotops/packages/${pkg.id}`)).body.robots;
  const of = (robot) => validation.find((item) => item.robotId === robot.robotId);
  assert.equal(of(one).ok, true, of(one).problems.join(" "));
  assert.equal(of(old).ok, false);
  assert.match(of(old).problems.join(" "), /needs runtime >=0\.1\.0 <0\.3\.0/);
  assert.deepEqual(of(one).checks.map((check) => check.id), ["manifest", "signature", "publisher", "integrity", "compatibility", "dependencies", "tests", "config", "backup", "rollback", "approval"]);

  assert.equal((await call(users.asha, "POST", "/robotops/rollouts", { packageId: pkg.id, picked: { wider: [one.robotId, two.robotId] } })).body.reason, "bad-plan", "never every robot at once by default");
  assert.match((await call(users.asha, "POST", "/robotops/rollouts", { packageId: pkg.id, picked: { development: [old.robotId] } })).body.error, /isn't eligible/);
  const planned = await call(users.asha, "POST", "/robotops/rollouts", { packageId: pkg.id, picked: { development: [one.robotId], test: [two.robotId] } });
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  const rolloutId = planned.body.rollout.id;
  assert.equal((await call(users.asha, "POST", `/robotops/rollouts/${rolloutId}/waves/1/approve`, { attest: true })).body.reason, "wave-blocked");
  assert.equal((await call(users.ashaKey, "POST", `/robotops/rollouts/${rolloutId}/waves/0/approve`, { attest: true })).status, 403);
  let rollout = (await call(users.asha, "POST", `/robotops/rollouts/${rolloutId}/waves/0/approve`, { attest: true })).body.rollout;
  assert.equal(rollout.targets[one.robotId].status, "staging");
  assert.ok(rollout.targets[one.robotId].backup.id);
  assert.equal(rollout.targets[two.robotId].status, "planned", "the second wave hasn't started");

  // Robot side, first exchange: the real Robot OS dispatcher verifies the signed package and stages it.
  let acks = await robotOSExchange(one);
  assert.deepEqual(acks.map((ack) => [ack.capability, ack.ok]), [["update.stage", true]], JSON.stringify(acks));
  assert.equal(acks[0].backup.files, 1);
  acks = await robotOSExchange(one);
  assert.deepEqual(acks.map((ack) => [ack.capability, ack.ok]), [["update.activate", true]], JSON.stringify(acks));
  rollout = (await call(users.asha, "GET", `/robotops/rollouts/${rolloutId}`)).body.rollout;
  assert.equal(rollout.targets[one.robotId].status, "healthy", JSON.stringify(rollout.targets[one.robotId]));
  assert.deepEqual(rollout.targets[one.robotId].health.results.map((item) => item.ok), [true, true]);
  assert.equal(rollout.waves[0].status, "healthy");

  // Second wave: the robot's own health check fails, so it is rolled back automatically and the rollout halts.
  rollout = (await call(users.asha, "POST", `/robotops/rollouts/${rolloutId}/waves/1/approve`, { attest: true })).body.rollout;
  assert.equal(rollout.targets[two.robotId].status, "staging");
  await robotOSExchange(two, { healthChecks: { "nav-smoke": false } });
  acks = await robotOSExchange(two, { healthChecks: { "nav-smoke": false } });
  assert.deepEqual(acks.map((ack) => [ack.capability, ack.ok]), [["update.activate", false]]);
  rollout = (await call(users.asha, "GET", `/robotops/rollouts/${rolloutId}`)).body.rollout;
  assert.equal(rollout.targets[two.robotId].status, "rolling-back");
  acks = await robotOSExchange(two);
  assert.deepEqual(acks.map((ack) => [ack.capability, ack.ok]), [["update.rollback", true]], JSON.stringify(acks));
  assert.ok(acks[0].restored, "the configuration backup was validated and restored on the robot");
  rollout = (await call(users.asha, "GET", `/robotops/rollouts/${rolloutId}`)).body.rollout;
  assert.equal(rollout.targets[two.robotId].status, "rolled-back");
  assert.equal(rollout.status, "halted");
  assert.ok(rollout.audit.some((entry) => entry.event === "target-rolled-back"));
  const installed = (await db.query("SELECT robot_id, version FROM hannah_robotops_installed WHERE package_id = 'com.acme.nav-tuning'")).rows;
  assert.deepEqual(installed.map((row) => row.robot_id), [one.robotId], "only the healthy robot counts as updated");

  // Failed-update detection: a robot that says nothing past its deadline has failed, and is rolled back.
  const quiet = await call(users.asha, "POST", "/robotops/packages", { manifest: manifest({ version: "1.5.0" }) });
  const second = await call(users.asha, "POST", "/robotops/rollouts", { packageId: quiet.body.package.id, picked: { development: [two.robotId] } });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  await call(users.asha, "POST", `/robotops/rollouts/${second.body.rollout.id}/waves/0/approve`, { attest: true });
  const row = (await db.query("SELECT record FROM hannah_robotops_rollouts WHERE id = $1", [second.body.rollout.id])).rows[0];
  const record = JSON.parse(row.record);
  record.targets[two.robotId].deadlineAt = Date.now() - 1;
  await db.query("UPDATE hannah_robotops_rollouts SET record = $1 WHERE id = $2", [JSON.stringify(record), second.body.rollout.id]);
  const swept = (await call(users.asha, "GET", `/robotops/rollouts/${second.body.rollout.id}`)).body.rollout;
  assert.equal(swept.targets[two.robotId].status, "rolling-back");
  assert.match(swept.targets[two.robotId].history.find((item) => item.status === "failed").reason, /No confirmation from the robot/);
  assert.equal(swept.status, "halted");
});

test("firmware: a separate gate, a person's typed authorisation, and no real flasher", async () => {
  const fw = updates.signManifest({
    ...manifest(), kind: "firmware", id: "com.acme.mc7-firmware", version: "3.2.0", config: undefined, recovery: { procedure: "Hold BOOT, power on, flash fw-3.1 over USB DFU with the vendor tool.", rollback: "none" },
    firmware: { controller: "Acme MC-7 motor controller", hardwareIds: ["ACME-MC-7"], fromVersions: ["fw-3.1"], minBatteryPercent: 50, recoveryMethod: "bootloader-dfu" },
  }, privateKey);
  const uploaded = await call(users.asha, "POST", "/robotops/packages", { manifest: fw });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal((await call(users.asha, "POST", "/robotops/rollouts", { packageId: uploaded.body.package.id, picked: { development: ["x"] } })).body.reason, "firmware-separate");
  const robot = await enrolled(users.asha, "Flashy", { described: PHYSICAL({ serialNumber: "AC-7777" }) });
  const request = { manufacturer: "Acme", model: "Rover 2", serialNumber: "AC-7777", controllerHardwareId: "ACME-MC-7" };
  assert.equal((await call(users.ashaKey, "POST", "/robotops/firmware", { robotId: robot.robotId, packageId: uploaded.body.package.id, request })).status, 403);
  const op = (await call(users.asha, "POST", "/robotops/firmware", { robotId: robot.robotId, packageId: uploaded.body.package.id, request })).body.operation;
  assert.equal(op.checks.find((check) => check.id === "power").ok, false, "moving freely with the stop released isn't a state to flash in");
  const authorize = (who, body) => call(who, "POST", `/robotops/firmware/${op.id}/authorize`, body);
  const confirm = { confirmName: "Flashy", confirmSerial: "AC-7777", atRobot: true };
  assert.equal((await authorize(users.ashaKey, confirm)).status, 403);
  assert.equal((await authorize(users.asha, confirm)).body.reason, "checks-failed");
  await robot.sync({ send: state({ mode: "docked", estop: { engaged: true, source: "software" }, battery: { percent: 90, charging: true } }) });
  assert.equal((await authorize(users.asha, { ...confirm, confirmSerial: "AC-7778" })).body.reason, "confirmation-mismatch");
  const done = await authorize(users.asha, confirm);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.operation.status, "blocked");
  assert.equal(done.body.operation.result.status, "BLOCKED_EXTERNAL_DEPENDENCY");
  assert.ok(done.body.operation.checks.every((check) => check.ok));
  assert.equal(done.body.operation.authorization.statement.includes("AC-7777"), true);

  // A simulated robot goes through the same gate and the simulated flasher, which writes nothing.
  const simRobot = await enrolled(users.asha, "SimFlash", { simulated: true });
  await simRobot.sync({ send: state({ mode: "idle", estop: { engaged: true, source: "software" }, battery: { percent: 90 } }) });
  const simOp = (await call(users.asha, "POST", "/robotops/firmware", { robotId: simRobot.robotId, packageId: uploaded.body.package.id, request: { ...request, serialNumber: "SIM-1" } })).body.operation;
  const simDone = await call(users.asha, "POST", `/robotops/firmware/${simOp.id}/authorize`, { confirmName: "SimFlash", confirmSerial: "SIM-1", atRobot: true });
  assert.equal(simDone.status, 200, JSON.stringify(simDone.body));
  assert.deepEqual([simDone.body.operation.status, simDone.body.operation.result.simulated], ["simulated-flashed", true]);
  assert.match(simDone.body.operation.result.detail, /Nothing was written to any hardware/);
});
