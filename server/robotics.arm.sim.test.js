"use strict";

// SIMULATION tests: the real server and the real HANNAH Robotics Runtime
// driving HANNAH's built-in planar arm simulator. Not MoveIt 2, not Gazebo,
// not a physical arm.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robot-arm-sim-token-0123456789-abcdefghijklmnopq";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "9".repeat(64);
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "4000";
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
delete process.env.VERCEL;

const RUNTIME = path.join(__dirname, "..", "robotics", "runtime");
const PROFILE = path.join(__dirname, "..", "robotics", "profiles", "sim-arm.json");
const python = (() => { const found = spawnSync("python3", ["-c", "import sys; print(sys.version_info >= (3, 9))"], { encoding: "utf8" }); return found.status === 0 && found.stdout.trim() === "True"; })();
const skip = python ? false : "python3 (3.9 or newer) isn't installed, so the robot runtime can't run here";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-arm-sim-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let base;
let runtime;
let robotId;
const asha = {};

const call = async (method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...asha, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const act = (action, params) => call("POST", "/actions", { action, params, request: "Put the red block in the bin.", agent: "Manipulation agent" });
const robot = async () => (await call("GET", `/robots/${robotId}`)).body.robot;
const mission = async (id) => (await call("GET", `/robots/missions/${id}`)).body.mission;
async function until(read, done, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(value)?.slice(0, 500)}`);
    await sleep(100);
  }
}
/** Ask, approve, and wait for the mission to end. */
async function carryOut(action, params) {
  const asked = await act(action, params);
  assert.equal(asked.body.record.status, "waiting-approval", JSON.stringify(asked.body));
  const approved = await call("POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  const missionId = approved.body.record.response?.missionId;
  return { asked: asked.body.record, record: approved.body.record, mission: missionId ? await until(() => mission(missionId), (value) => value.final, `${action} to finish`) : null };
}

before(async () => {
  if (skip) return;
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const registered = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "asha@arm.example", password: "correct horse battery staple" }) });
  asha.Cookie = registered.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  const created = await call("POST", "/robots", { name: "Arm", simulated: true });
  robotId = created.body.robot.id;
  const enrolling = spawn("python3", ["-m", "hannah_robot", "enroll", "--server", base, "--code", created.body.enrollment.code, "--state-dir", stateDir, "--profile", PROFILE], { cwd: RUNTIME, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  enrolling.stdout.on("data", (chunk) => { said += chunk; });
  enrolling.stderr.on("data", (chunk) => { said += chunk; });
  const [code] = await once(enrolling, "exit");
  assert.equal(code, 0, said);
  runtime = spawn("python3", ["-m", "hannah_robot", "run", "--state-dir", stateDir, "--profile", PROFILE, "--sim-speed", "4", "--sync-interval", "0.2"], { cwd: RUNTIME, stdio: ["ignore", "ignore", "ignore"] });
  await until(robot, (value) => value.online && value.state?.scene, "the arm to connect");
});
after(async () => {
  if (skip) return;
  if (runtime && runtime.exitCode === null) { runtime.kill("SIGTERM"); await Promise.race([once(runtime, "exit"), sleep(3000)]); }
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("the arm enrolls as a simulated arm with arm capabilities only", { skip }, async () => {
  const value = await robot();
  assert.deepEqual([value.robotType, value.category, value.simulator, value.adapter], ["manipulator-arm", "manipulator", "hannah-arm-kinematic", "arm-kinematic"]);
  assert.deepEqual(value.capabilities, ["report_robot_state", "read_sensor", "stop_motion", "move_robot_arm", "grasp_object", "release_object"]);
  assert.deepEqual(Object.keys(value.places), ["home", "inspection", "bin"]);
  assert.equal(value.limits.maxJointSpeed, 1.2);
  assert.equal(value.state.pose.source, "joint encoders (forward kinematics)");
  assert.deepEqual(value.state.scene.objects.map((item) => item.id), ["red block", "blue block"]);
  assert.equal(value.state.scene.source, "the simulator's own scene (not a camera)");
  // It is not a vehicle, and the fleet doesn't hand it driving tasks.
  assert.match((await act("robots.navigate_to", { robot: "Arm", x: 0.3, y: 0.3 })).body.record.permission.reason, /Arm doesn't offer “Drive to a place”/);
  assert.equal((await act("robots.assign", { task: "navigate_to", x: 0.3, y: 0.3 })).status, 409);
});

test("pick and place: each step is approved, moved by the arm's planner, and verified from joint and gripper feedback", { skip }, async () => {
  // Even at the widest permission level with a standing permission for everything, an arm asks every time.
  await call("PUT", "/account/permissions", { levels: { robots: 5 } });
  const grant = await call("POST", "/account/permissions/grants", { service: "robots", actions: ["*"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(grant.status, 201);
  const reach = await carryOut("robots.move_robot_arm", { robot: "Arm", x: 0.55, y: 0.3 });
  assert.equal(reach.asked.permission.code, "always-asks");
  assert.equal(reach.asked.preview.title, "Start a mission: Arm moves its arm to (0.55, 0.3)");
  assert.equal(reach.asked.preview.lines.find((line) => line.label === "Risk").value, "high");
  assert.match(reach.asked.preview.body, /The arm's own planner chooses the joint motion; HANNAH sends the target, never joint values\./);
  assert.equal(reach.mission.status, "succeeded", JSON.stringify(reach.mission));
  assert.match(reach.mission.verification.evidence, /The tool position from the measured joint angles \(joint encoders \(forward kinematics\)\) is \(0\.55, 0\.3\), 0 cm from the target \(0\.55, 0\.3\), joints still\./);

  const grasp = await carryOut("robots.grasp_object", { robot: "Arm", object: "red block" });
  assert.equal(grasp.asked.preview.title, "Start a mission: Arm closes its gripper on the red block");
  assert.equal(grasp.mission.status, "succeeded", JSON.stringify(grasp.mission));
  assert.equal(grasp.mission.verification.evidence, "The gripper reports it is holding red block.");

  const carry = await carryOut("robots.move_robot_arm", { robot: "Arm", place: "bin" });
  assert.equal(carry.asked.preview.title, "Start a mission: Arm moves its arm to bin (0.25, -0.5)");
  assert.equal(carry.mission.status, "succeeded", JSON.stringify(carry.mission));
  const holding = await robot();
  assert.deepEqual(holding.state.gripper, { open: false, holding: "red block" });
  assert.equal(holding.state.faults.length, 0, "it went round the fixture, not through it");

  const drop = await carryOut("robots.release_object", { robot: "Arm" });
  assert.equal(drop.mission.status, "succeeded", JSON.stringify(drop.mission));
  assert.equal(drop.mission.verification.evidence, "The gripper reports open and holding nothing.");
  const done = await until(robot, (value) => !value.state.gripper.holding, "the gripper to open");
  const block = done.state.scene.objects.find((item) => item.id === "red block");
  assert.ok(Math.hypot(block.x - 0.25, block.y + 0.5) < 0.01, `the red block is in the bin: ${JSON.stringify(block)}`);
  const said = await act("robots.state", { robot: "Arm" });
  assert.deepEqual(said.body.record.response.gripper, { open: true, holding: null });
  await call("DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
  await call("PUT", "/account/permissions", { levels: { robots: 3 } });
});

test("what can't be done is refused with the reason, by the server where it can know and by the arm where only it can", { skip }, async () => {
  for (const [action, params, expected] of [
    ["robots.move_robot_arm", { robot: "Arm", x: 3, y: 0 }, /outside the robot's allowed workspace/],
    ["robots.move_robot_arm", { robot: "Arm", x: -0.15, y: 0.2 }, /keep-out zone “operator side”/],
    ["robots.move_robot_arm", { robot: "Arm", place: "shelf" }, /no place called “shelf” \(it has: home, inspection, bin\)/],
    ["robots.grasp_object", { robot: "Arm", object: "green block" }, /doesn't report an object called “green block” \(it reports: red block, blue block\)/],
    ["robots.release_object", { robot: "Arm" }, /gripper isn't holding anything/],
  ]) {
    const refused = await act(action, params);
    assert.equal(refused.body.record.status, "denied", JSON.stringify(refused.body));
    assert.match(refused.body.record.permission.reason, expected);
  }
  // Inside the workspace, but on the fixture: only the arm's own map knows.
  const fixture = await carryOut("robots.move_robot_arm", { robot: "Arm", x: 0.55, y: -0.26 });
  assert.equal(fixture.record.status, "failed");
  assert.match(fixture.record.error, /Arm's own checks refused it\. .*obstacle 'fixture'/);
  // A grasp where the object isn't: the gripper closes on nothing, and that is a failure.
  const miss = await carryOut("robots.grasp_object", { robot: "Arm", object: "blue block" });
  assert.equal(miss.record.status, "failed", JSON.stringify(miss.record));
  assert.match(miss.record.error, /Grasp an object: failed\. The gripper closed on nothing: the object isn't between its fingers\./);
  assert.equal((await robot()).state.gripper.holding, null);
  await carryOut("robots.release_object", { robot: "Arm" }).catch(() => null);
});

test("stop freezes a moving arm without approval and is confirmed from the joints", { skip }, async () => {
  await until(robot, (value) => value.mode === "idle", "the arm to be idle");
  const asked = await act("robots.move_robot_arm", { robot: "Arm", place: "inspection" });
  const started = await call("POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  assert.equal(started.body.record.status, "done", JSON.stringify(started.body.record));
  const moving = await until(robot, (value) => value.state.velocity.angular > 0.05 || value.mode === "idle", "the arm to move");
  const stopped = await call("POST", `/robots/${robotId}/stop`, { reason: "test" });
  assert.ok(["done", "unverified"].includes(stopped.body.record.status), JSON.stringify(stopped.body.record));
  const still = await until(robot, (value) => value.state.velocity.angular === 0 && value.mode === "idle", "the arm to be still");
  assert.equal(still.state.velocity.angular, 0);
  const ended = await mission(started.body.record.response.missionId);
  // Stopped part-way, or it had already arrived: either is reported as what happened.
  assert.ok(moving.mode === "idle" ? ended.status === "succeeded" : ["cancelled", "succeeded"].includes(ended.status), ended.status);
});
