"use strict";

// SIMULATION tests: the real server and the real HANNAH Robotics Runtime
// (robotics/runtime, Python) driving HANNAH's built-in kinematic simulator,
// talking over HTTP through a proxy the test can cut.
//
// By default this is not Gazebo and not a physical robot.
//
// The same suite is the acceptance check for the Gazebo robot: with a ROS 2
// environment sourced and `ros2 launch hannah_sim sim.launch.py` running, set
//   HANNAH_ROBOT_PROFILE=<…>/hannah_sim/config/hannah_profile.json
// and the runtime uses its ROS 2 adapter against Gazebo Harmonic and Nav2
// instead. That mode has NOT been run yet (see robotics/README.md); the
// emergency-stop test is skipped in it because the Gazebo robot has no
// emergency-stop input in Block 1.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robot-sim-test-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "4000";
delete process.env.VERCEL;

const { signCommand, signRequest } = require("./robotics/service");

const RUNTIME = path.join(__dirname, "..", "robotics", "runtime");
const python = (() => {
  const found = spawnSync("python3", ["-c", "import sys; print(sys.version_info >= (3, 9))"], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() === "True";
})();
const skip = python ? false : "python3 (3.9 or newer) isn't installed, so the robot runtime can't run here";

const PROFILE = process.env.HANNAH_ROBOT_PROFILE || ""; // empty: HANNAH's built-in simulator
const GAZEBO = Boolean(PROFILE);
const SPEED = 8; // simulated seconds per real second (built-in simulator only; Gazebo runs in real time)
const PATIENCE = GAZEBO ? 6 : 1; // real time is slower than 8x
const runtimeArgs = (command, extra = []) => ["-m", "hannah_robot", command, "--state-dir", stateDir, ...(PROFILE ? ["--profile", PROFILE] : []), ...extra];
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-robot-sim-"));
const inputs = (value) => fs.writeFileSync(path.join(stateDir, "sim-inputs.json"), JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let server;
let base;
let proxy;
let link = { up: true, url: "" };
let runtime;
let robotId;
const log = [];
const asha = {};

const call = async (method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...asha, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const act = (action, params) => call("POST", "/actions", { action, params, request: "Move the robot to the destination.", agent: "Robot agent" });
const robot = async () => (await call("GET", `/robots/${robotId}`)).body.robot;
const mission = async (id) => (await call("GET", `/robots/missions/${id}`)).body.mission;
async function until(read, done, { ms = 20_000, every = 100, what = "the condition" } = {}) {
  const end = Date.now() + ms * PATIENCE;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last: ${JSON.stringify(value)?.slice(0, 600)}`);
    await sleep(every);
  }
}
/** Ask, approve, and return the started mission's id. */
async function start(action, params) {
  const asked = await act(action, params);
  assert.equal(asked.body.record.status, "waiting-approval", JSON.stringify(asked.body));
  const approved = await call("POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  return { asked: asked.body.record, record: approved.body.record, missionId: approved.body.record.response?.missionId };
}
const idle = () => until(robot, (value) => value.online && ["idle", "docked"].includes(value.mode) && value.state.velocity.linear === 0, { what: "the robot to be idle" });
const distance = (pose, place) => Math.hypot(pose.x - place.x, pose.y - place.y);

before(async () => {
  if (skip) return;
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  // The robot reaches the server through this proxy, so a test can take the network away.
  proxy = http.createServer((req, res) => {
    if (!link.up) return req.socket.destroy();
    const forward = http.request(`${base}${req.url}`, { method: req.method, headers: req.headers }, (answer) => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
    forward.on("error", () => res.destroy());
    return req.pipe(forward);
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  link.url = `http://127.0.0.1:${proxy.address().port}`;

  const registered = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "asha@sim.example", password: "correct horse battery staple" }) });
  assert.equal(registered.status, 200);
  asha.Cookie = registered.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");

  const created = await call("POST", "/robots", { name: "Rover", simulated: true });
  assert.equal(created.status, 201);
  robotId = created.body.robot.id;
  // Not spawnSync: the server it enrolls with lives in this process and has to answer.
  const enrolling = spawn("python3", runtimeArgs("enroll", ["--server", link.url, "--code", created.body.enrollment.code]), { cwd: RUNTIME, stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  enrolling.stdout.on("data", (chunk) => { said += chunk; });
  enrolling.stderr.on("data", (chunk) => { said += chunk; });
  const [code] = await once(enrolling, "exit");
  assert.equal(code, 0, said);
  log.push(...said.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { event: "text", message: line }; } }));
  runtime = spawn("python3", runtimeArgs("run", ["--sync-interval", "0.2", ...(GAZEBO ? [] : ["--sim-speed", String(SPEED)])]), { cwd: RUNTIME, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  runtime.stdout.on("data", (chunk) => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop(); for (const line of lines) { try { log.push(JSON.parse(line)); } catch { /* not a log line */ } } });
  runtime.stderr.on("data", (chunk) => log.push({ event: "stderr", message: String(chunk) }));
  await until(robot, (value) => value.online && (!GAZEBO || value.state?.localized), { ms: 60_000, what: GAZEBO ? "the robot to connect and Nav2 to localize it" : "the robot to connect" });
});

after(async () => {
  if (skip) return;
  if (runtime && runtime.exitCode === null) { runtime.kill("SIGTERM"); await Promise.race([once(runtime, "exit"), sleep(3000)]); }
  proxy?.closeAllConnections?.();
  proxy?.close();
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("the runtime and the server sign the same way", () => {
  // The same vectors are asserted in robotics/runtime/tests/test_protocol.py against the runtime's code.
  const secret = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(signRequest(secret, { robotId: "rb_000000000000000001", time: "1000", counter: "1", method: "POST", path: "/api/robots/device/sync", body: "{}" }), "6d8d5e3439d517657856d31eecc8ed48af1134fedd4727db3e23170c8dd7ea75");
  assert.equal(signCommand(secret, '{"v":1}'), "76799387e9ba3acc2de09d3ddfbba7a3feb7c0b8f2d776656356d4f5f67a1a15");
});

test("the runtime enrolls as a simulation and keeps its secret to itself", { skip }, async () => {
  const value = await robot();
  assert.equal(value.simulated, true);
  assert.equal(value.simulator, GAZEBO ? "gazebo-harmonic" : "hannah-kinematic");
  assert.equal(value.robotType, "differential-drive");
  assert.equal(value.adapter, GAZEBO ? "ros2" : "kinematic");
  assert.deepEqual(value.capabilities, ["report_robot_state", "read_sensor", "stop_motion", "navigate_to", "return_to_dock", "inspect_area", ...(GAZEBO ? [] : ["set_supported_device_state"])]);
  assert.deepEqual(Object.keys(value.places), ["dock", "workbench", "shelves", "door", "loading bay"]);
  assert.equal(value.limits.maxLinearSpeed, 0.5);
  assert.equal(value.limits.environment, "simulation");
  assert.equal(value.world.obstacles.length, 6);
  assert.equal(value.state.pose.source, GAZEBO ? "map localization (tf)" : "odometry");
  assert.equal(value.state.sim.kind, GAZEBO ? "gazebo-harmonic" : "hannah-kinematic");
  const credentials = path.join(stateDir, "credentials.json");
  assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
  const { secret } = JSON.parse(fs.readFileSync(credentials, "utf8"));
  assert.equal(log.some((line) => JSON.stringify(line).includes(secret)), false, "the secret is never logged");
  assert.ok(log.some((line) => line.event === "running" && line.simulation === (GAZEBO ? "gazebo-harmonic" : "hannah-kinematic")));
});

test("“Move the robot to the destination”: a goal is planned, driven and verified from the robot's state", { skip }, async () => {
  const before = await idle();
  const started = await start("robots.navigate_to", { robot: "Rover", place: "workbench" });
  assert.equal(started.asked.preview.title, "Start a mission: Rover drives to workbench (3.1, 1.9)");
  assert.ok(started.asked.preview.lines.some((line) => /SIMULATION \((hannah-kinematic|gazebo-harmonic)\)/.test(line.value)));
  assert.equal(started.record.status, "done", JSON.stringify(started.record));
  assert.match(started.record.verification.evidence, /accepted mission .* This confirms the start, not the result/);
  // While it drives: moving, a path planned around the obstacles, and not there yet.
  const moving = await until(robot, (value) => value.mode === "navigating" && value.state.velocity.linear > 0.2, { what: "the robot to move" });
  assert.equal(moving.state.mission.id, started.missionId);
  if (!GAZEBO) assert.ok(moving.state.nav.path.length >= 2);
  assert.ok(distance(moving.state.pose, { x: 3.1, y: 1.9 }) > 1);
  assert.equal((await mission(started.missionId)).status, "accepted");
  const done = await until(() => mission(started.missionId), (value) => value.final, { what: "the mission to finish" });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.verification.confirmed, true);
  assert.match(done.verification.evidence, GAZEBO
    ? /The robot's localization \(map localization \(tf\)\) reports \(\d\.\d+, \d\.\d+\), 0\.\d+ m from the goal \(3\.1, 1\.9\), standing still\./
    : /The robot's localization \(odometry\) reports \(\d\.\d+, \d\.\d+\), 0\.\d+ m from the goal \(3\.1, 1\.9\), standing still\. Simulator ground truth: 0\.\d+ m from the goal\./);
  assert.ok(done.result.travelled > 7.5, "it drove around the obstacles, not through them");
  const arrived = await idle();
  assert.ok(distance(arrived.state.pose, { x: 3.1, y: 1.9 }) <= 0.25);
  assert.deepEqual(arrived.state.faults, []);
  if (!GAZEBO) {
    assert.ok(distance(arrived.state.sim.truth, { x: 3.1, y: 1.9 }) <= 0.4, "the simulator's ground truth agrees");
    assert.ok(arrived.state.battery.percent < before.state.battery.percent, "driving used some battery");
  }
  // What an agent is told when it asks afterwards.
  const asked = await act("robots.mission", { robot: "Rover" });
  assert.match(asked.body.record.response.summary, /Drive to a place: finished and verified/);
  const samples = (await call("GET", `/robots/${robotId}/telemetry`)).body.samples;
  assert.ok(samples.length >= 1 && samples.every((sample) => Number.isFinite(sample.x)));
});

test("the robot's own checks refuse a goal the server couldn't know was bad", { skip }, async () => {
  await idle();
  // Inside the workspace and outside every keep-out zone, but on top of a shelf: only the robot's map knows.
  const started = await start("robots.navigate_to", { robot: "Rover", x: -2.0, y: 0.85 });
  assert.equal(started.record.status, "failed");
  assert.match(started.record.error, /Rover's own checks refused it\. Refused by the robot's own safety checks: the goal \(-2\.00, 0\.85\) is inside or touching the obstacle 'shelf_a'/);
  const view = await robot();
  assert.equal(view.state.velocity.linear, 0);
});

test("a mission can be cancelled part-way; the robot stops where it is", { skip }, async () => {
  await idle();
  const started = await start("robots.return_to_dock", { robot: "Rover" });
  assert.equal(started.record.status, "done");
  await until(robot, (value) => value.state.velocity.linear > 0.3, { what: "the robot to move" });
  await call("POST", `/robots/missions/${started.missionId}/cancel`);
  const done = await until(() => mission(started.missionId), (value) => value.final, { what: "the cancellation" });
  assert.equal(done.status, "cancelled");
  assert.match(done.error, /Cancelled by HANNAH; holding position/);
  const view = await idle();
  assert.ok(distance(view.state.pose, { x: -4.3, y: -3.3 }) > 1.5, "it didn't finish the trip");
});

test("stop needs no approval, cancels the mission and is confirmed by the robot's measured speed", { skip }, async () => {
  await idle();
  const started = await start("robots.navigate_to", { robot: "Rover", place: "door" });
  await until(robot, (value) => value.state.velocity.linear > 0.3, { what: "the robot to move" });
  const stopped = await call("POST", `/robots/${robotId}/stop`, { reason: "test" });
  assert.equal(stopped.body.record.status, "done", JSON.stringify(stopped.body.record));
  assert.match(stopped.body.record.verification.evidence, /measured speed is 0 m\/s/);
  assert.equal(stopped.body.mission.status, "succeeded");
  assert.equal((await until(() => mission(started.missionId), (value) => value.final)).status, "cancelled");
  assert.equal((await robot()).state.velocity.linear, 0);
});

test("a pressed emergency stop halts the robot at once, fails the mission and blocks new ones until released at the robot", { skip: skip || (GAZEBO ? "the Gazebo robot has no emergency-stop input in Block 1" : false) }, async () => {
  await idle();
  const started = await start("robots.navigate_to", { robot: "Rover", place: "shelves" });
  await until(robot, (value) => value.state.velocity.linear > 0.3, { what: "the robot to move" });
  inputs({ estop: true });
  const halted = await until(robot, (value) => value.state.estop.engaged, { what: "the emergency stop to show" });
  assert.equal(halted.state.velocity.linear, 0);
  assert.equal(halted.mode, "estopped");
  assert.equal(halted.state.motorsEnabled, false);
  const done = await until(() => mission(started.missionId), (value) => value.final);
  assert.equal(done.status, "failed");
  assert.match(done.error, /emergency stop was engaged/);
  const refused = await act("robots.navigate_to", { robot: "Rover", place: "shelves" });
  assert.equal(refused.body.record.status, "denied");
  assert.match(refused.body.record.permission.reason, /emergency stop is engaged\. It has to be released at the robot/);
  const events = (await call("GET", `/robots/events?robot=${robotId}`)).body.events;
  assert.ok(events.some((event) => event.type === "estop-engaged" && event.source === "robot"));
  inputs({ estop: false });
  const released = await until(robot, (value) => !value.state.estop.engaged, { what: "the release" });
  await sleep(600);
  assert.equal((await robot()).state.velocity.linear, 0, "releasing it moves nothing");
  assert.ok(distance(released.state.pose, { x: -1.8, y: 1.65 }) > 0.5);
});

test("when the network goes away the robot stops by itself, and says so when it comes back", { skip }, async () => {
  await idle();
  // Start from the far corner and drive slowly, so the trip outlasts the outage.
  const home = await start("robots.return_to_dock", { robot: "Rover" });
  assert.equal((await until(() => mission(home.missionId), (value) => value.final, { what: "the trip to the dock" })).status, "succeeded");
  if (!GAZEBO) assert.equal((await idle()).mode, "docked");
  const started = await start("robots.navigate_to", { robot: "Rover", place: "loading bay", maxSpeed: 0.1 });
  assert.equal(started.record.status, "done");
  await until(robot, (value) => value.state.velocity.linear > 0.05, { what: "the robot to move" });
  link.up = false;
  proxy.closeAllConnections?.();
  const offline = await until(robot, (value) => !value.online, { ms: 25_000, every: 500, what: "the server to see the robot offline" });
  assert.equal(offline.connection, "offline");
  assert.equal((await mission(started.missionId)).status, "accepted", "the server doesn't guess what happened");
  // The server can't reach it; a stop is recorded and not called delivered.
  const stop = await act("robots.stop_motion", { robot: "Rover" });
  assert.equal(stop.body.record.status, "unverified");
  assert.match(stop.body.record.verification.evidence, /offline, so the stop couldn't be delivered\. A robot that loses its link to HANNAH stops by itself within 5 seconds/);
  link.up = true;
  const back = await until(robot, (value) => value.online, { what: "the robot to reconnect" });
  assert.equal(back.state.velocity.linear, 0, "it was already standing still when it came back");
  const done = await until(() => mission(started.missionId), (value) => value.final);
  assert.equal(done.status, "cancelled");
  assert.match(done.error, /link to HANNAH was lost for more than 5 s; the robot stopped by itself/);
  assert.ok(distance(back.state.pose, { x: 3.6, y: -3.2 }) > 1, "it stopped on the way, not at the goal");
  // The robot's own account of it arrives with its next exchanges.
  await until(async () => (await call("GET", `/robots/events?robot=${robotId}`)).body.events.map((event) => event.type), (types) => types.includes("link-lost") && types.includes("link-restored"), { what: "the robot's link events" });
  await sleep(800);
  assert.equal((await robot()).state.velocity.linear, 0, "and it doesn't resume by itself");
});

test("revoking the robot ends its access; the runtime holds and reports it locally", { skip }, async () => {
  await idle();
  await call("POST", `/robots/${robotId}/revoke`);
  await until(async () => log, (lines) => lines.some((line) => line.event === "revoked"), { ms: 15_000, what: "the runtime to notice" });
  assert.equal(runtime.exitCode, null, "the runtime keeps running, holding position");
  assert.equal((await robot()).connection, "revoked");
});
