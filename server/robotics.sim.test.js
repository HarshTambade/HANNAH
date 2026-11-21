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
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000"; // the stand-in robot exchanges far faster than a real one
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
  assert.deepEqual(value.capabilities, ["report_robot_state", "read_sensor", ...(GAZEBO ? [] : ["report_surroundings"]), "stop_motion", "navigate_to", "return_to_dock", "inspect_area", ...(GAZEBO ? [] : ["set_supported_device_state", "capture_image"])]);
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

test("the fingerprint the runtime printed is the one HANNAH shows", { skip }, async () => {
  const printed = log.find((line) => line.event === "enrolled")?.fingerprint;
  assert.match(printed, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.equal((await robot()).fingerprint, printed);
});

test("the runtime's own health check passes against this server, makes no signed request and never prints the secret", { skip }, async () => {
  const before = (await call("GET", `/robots/events?robot=${robotId}&limit=5`)).body.events.length;
  // Not spawnSync: the server it checks runs in this process and has to be able to answer.
  const child = spawn("python3", runtimeArgs("doctor", ["--json"]), { cwd: RUNTIME, stdio: ["ignore", "pipe", "pipe"] });
  const checked = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { checked.stdout += chunk; });
  child.stderr.on("data", (chunk) => { checked.stderr += chunk; });
  [checked.status] = await once(child, "exit");
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const found = Object.fromEntries(JSON.parse(checked.stdout).map((item) => [item.id, item]));
  assert.deepEqual([found.credentials.ok, found.server.ok, found.clock.ok, found["server-address"].ok], [true, true, true, true]);
  assert.match(found.credentials.message, new RegExp(`Enrolled as ${robotId}\\. Fingerprint [0-9A-F]{4}( [0-9A-F]{4}){3}`));
  const secret = JSON.parse(fs.readFileSync(path.join(stateDir, "credentials.json"), "utf8")).secret;
  assert.equal(checked.stdout.includes(secret), false);
  // The robot is still connected afterwards: the check used none of its request numbers.
  await sleep(1500);
  assert.equal((await robot()).online, true);
  assert.equal((await call("GET", `/robots/events?robot=${robotId}&limit=5`)).body.events.length, before);
});

test("a mission is paused where the robot stands and resumed to its goal, after approval", { skip: skip || (GAZEBO ? "pause and resume are not implemented in the ROS 2 adapter path yet" : false) }, async () => {
  await idle();
  const home = await start("robots.return_to_dock", { robot: "Rover" });
  await until(() => mission(home.missionId), (value) => value.final, { what: "the trip to the dock" });
  await idle();
  const started = await start("robots.navigate_to", { robot: "Rover", place: "workbench", maxSpeed: 0.3 });
  await until(robot, (value) => value.state.velocity.linear > 0.2, { what: "the robot to move" });
  const paused = await call("POST", `/robots/missions/${started.missionId}/pause`);
  assert.equal(paused.body.record.status, "done", JSON.stringify(paused.body.record));
  assert.equal(paused.body.mission.status, "paused");
  const held = await until(robot, (value) => value.mode === "paused" && value.state.velocity.linear === 0, { what: "the robot to hold" });
  const where = held.state.pose;
  assert.ok(distance(where, { x: 3.1, y: 1.9 }) > 1, "it is not there yet");
  await sleep(800);
  assert.ok(distance((await robot()).state.pose, where) < 0.02, "it stays where it paused");
  // Resume is a movement: it asks.
  const resume = await call("POST", `/robots/missions/${started.missionId}/resume`);
  assert.equal(resume.status, 202);
  assert.equal(resume.body.record.status, "waiting-approval");
  const approved = await call("POST", `/actions/${resume.body.record.id}/decision`, { approve: true });
  assert.equal(approved.body.record.status, "done", JSON.stringify(approved.body.record));
  const done = await until(() => mission(started.missionId), (value) => value.final, { what: "the resumed mission to finish" });
  assert.equal(done.status, "succeeded", JSON.stringify(done));
  assert.equal(done.verification.confirmed, true);
});

test("what the robot senses is reported as measurements: an object that isn't on its map, and a sensor that stops", { skip: skip || (GAZEBO ? "the ROS 2 adapter doesn't report surroundings yet" : false) }, async () => {
  await idle();
  const before = (await act("robots.surroundings", { robot: "Rover" })).body.record.response;
  assert.equal(before.obstaclesKnown, true);
  assert.equal(before.sensor, "lidar");
  assert.equal(before.obstacles.some((item) => item.kind === "object not on the map"), false);
  // Something is put down a metre from the robot, in the most open direction its range sensor shows (to its map, nothing is there).
  const now = (await robot()).state;
  const ranges = now.sensors.lidar.ranges;
  const beam = ranges.indexOf(Math.max(...ranges));
  assert.ok(ranges[beam] > 2.5, "there is open floor to put it on");
  const direction = now.pose.yaw + (2 * Math.PI * beam) / ranges.length;
  const expectedBearing = ((360 * beam) / ranges.length + 180) % 360 - 180;
  inputs({ obstacles: [{ name: "crate", x: now.pose.x + Math.cos(direction) * 1.2 - 0.2, y: now.pose.y + Math.sin(direction) * 1.2 - 0.2, w: 0.4, h: 0.4 }] });
  // Wait on the robot's own report (the action endpoint is rate-limited), then ask through the action once.
  await until(robot, (value) => value.state.perception.obstacles.some((item) => item.kind === "object not on the map"), { what: "the range sensor to find the crate" });
  const seen = (await act("robots.surroundings", { robot: "Rover" })).body.record.response;
  const crate = seen.obstacles.find((item) => item.kind === "object not on the map");
  assert.ok(crate.distanceM > 0.7 && crate.distanceM < 1.3, JSON.stringify(crate));
  assert.ok(Math.abs(((crate.bearingDeg - expectedBearing + 540) % 360) - 180) <= 25, `bearing ${crate.bearingDeg}, expected about ${expectedBearing}`);
  assert.equal(crate.sensor, "lidar");
  assert.ok(crate.confidence > 0.5 && crate.confidence < 1);
  assert.ok(seen.changes.length >= 1, "it is recorded as a change from the map");
  assert.match(seen.note, /Nothing here was inferred by a language model/);
  inputs({ obstacles: [] });
  await until(robot, (value) => !value.state.perception.obstacles.some((item) => item.kind === "object not on the map") && value.state.perception.changes.length === 0, { what: "the map to be cleared once the crate is gone" });

  // The range sensor stops reporting: the robot says so, isn't moved, and says "unknown", not "clear".
  inputs({ obstacles: [], sensorFaults: ["lidar"] });
  await until(robot, (value) => value.state.perception.obstaclesKnown === false, { what: "the sensor fault to show" });
  const blind = (await act("robots.surroundings", { robot: "Rover" })).body.record.response;
  assert.equal(blind.route.blocked, null);
  assert.deepEqual(blind.sensorHealth.find((item) => item.id === "lidar"), { id: "lidar", ok: false, problem: "not reporting" });
  const refused = await act("robots.navigate_to", { robot: "Rover", place: "door" });
  assert.equal(refused.body.record.status, "denied");
  assert.match(refused.body.record.permission.reason, /Rover's lidar sensor isn't reporting, so it won't be moved/);
  assert.equal((await act("robots.read_sensor", { robot: "Rover", sensor: "lidar" })).body.record.response.reading.ok, false);
  inputs({ obstacles: [], sensorFaults: [] });
  await until(robot, (value) => value.state.sensors.lidar.ok === true, { what: "the sensor to return" });
  const climate = (await act("robots.read_sensor", { robot: "Rover", sensor: "environment" })).body.record.response.reading;
  assert.deepEqual([climate.ok, climate.source, typeof climate.temperatureC, typeof climate.humidityPercent], [true, "simulated", "number", "number"]);
  const battery = (await act("robots.battery", { robot: "Rover" })).body.record.response;
  assert.ok(battery.percent > 0 && battery.percent <= 100);
});

test("an inspection route as one plan: drive, record what the sensors detect and a reading at each place, return to the dock", { skip: skip || (GAZEBO ? "the ROS 2 adapter doesn't report perception yet" : false) }, async () => {
  await idle();
  const asked = await act("robots.run_plan", { robot: "Rover", template: "inspection_route", inputs: { places: ["workbench", "door"], sensor: "environment" } });
  assert.equal(asked.body.record.status, "waiting-approval", JSON.stringify(asked.body));
  const steps = asked.body.record.preview.lines.filter((line) => line.label.startsWith("Step")).map((line) => line.value.replace(/ \(.*$/, ""));
  assert.deepEqual(steps, ["drive to workbench", "record what the range sensor detects", "read the environment sensor", "drive to door", "record what the range sensor detects", "read the environment sensor", "return to the dock"]);
  const started = await call("POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  assert.equal(started.body.record.status, "done", JSON.stringify(started.body.record));
  const planId = started.body.record.response.planId;
  const done = await until(async () => (await call("GET", `/robots/plans/${planId}`)).body.plan, (value) => value.final, { ms: 60_000, what: "the route to finish" });
  assert.equal(done.status, "succeeded", JSON.stringify(done).slice(0, 1500));
  assert.match(done.steps[0].evidence, /from the goal .*standing still/);
  // Each observation is the robot's own report, taken where it stood after the drive before it.
  const [seenAtBench, readAtBench, seenAtDoor] = [done.steps[1], done.steps[2], done.steps[4]];
  const places = (await robot()).places;
  assert.ok(Math.hypot(seenAtBench.output.position.x - places.workbench.x, seenAtBench.output.position.y - places.workbench.y) < 0.4, JSON.stringify(seenAtBench.output.position));
  assert.ok(Math.hypot(seenAtDoor.output.position.x - places.door.x, seenAtDoor.output.position.y - places.door.y) < 0.4, JSON.stringify(seenAtDoor.output.position));
  assert.equal(seenAtBench.output.kind, "simulation");
  assert.ok(Array.isArray(seenAtBench.output.obstacles));
  assert.match(seenAtBench.evidence, /obstacles? detected/);
  assert.equal(typeof readAtBench.output.reading.temperatureC, "number");
  assert.equal(readAtBench.output.reading.source, "simulated");
  assert.equal((await robot()).mode, "docked");
  // The agent's read of the finished plan.
  const read = (await act("robots.plan", { robot: "Rover" })).body.record.response;
  assert.match(read.summary, /all 7 steps finished and verified/);
});

test("a picture: refused until a person switches camera use on, approved, detected regions reported with their source, kept for a limited time, every viewing logged", { skip: skip || (GAZEBO ? "the ROS 2 adapter has no camera yet" : false) }, async () => {
  await idle();
  const key = { Authorization: `Bearer ${(await call("POST", "/account/api-keys", { name: "camera agent" })).body.key}` };
  const asKey = async (method, route, body) => { const response = await fetch(`${base}/api${route}`, { method, headers: { ...key, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json().catch(() => null) }; };
  const before = await robot();
  // Registered with what is needed to trace a reading back to it.
  const camera = before.sensors.find((sensor) => sensor.id === "camera");
  assert.deepEqual([camera.type, camera.frame, camera.resolution, camera.messageType], ["rgbd-camera", "camera_link", "64x48, 70 degrees", "sensor_msgs/msg/Image, sensor_msgs/msg/CameraInfo"]);
  assert.deepEqual(before.camera, { enabled: false, retentionHours: 24, cameras: ["camera"] });
  assert.equal(before.state.sensors.camera.framesCaptured, 0, "the camera has not been read");

  // Off by default: refused with the reason, and never shown for approval. A key can't switch it on.
  const off = await act("robots.capture_image", { robot: "Rover" });
  assert.equal(off.body.record.status, "denied", JSON.stringify(off.body));
  assert.match(off.body.record.permission.reason, /Camera use is switched off for Rover\. A signed-in person can switch it on/);
  assert.ok((await asKey("PATCH", `/robots/${robotId}`, { camera: { enabled: true } })).status >= 401);
  const on = await call("PATCH", `/robots/${robotId}`, { camera: { enabled: true, retentionHours: 2 } });
  assert.deepEqual(on.body.robot.camera, { enabled: true, retentionHours: 2, cameras: ["camera"] });

  // Put something red in front of where it stands. Beam 0 of its scan points where the camera does.
  const now = (await robot()).state;
  assert.ok(now.sensors.lidar.ranges[0] > 2.2, `there is room ahead of the robot for the test object: ${now.sensors.lidar.ranges[0]} m`);
  const ahead = now.sim.truth.yaw;
  inputs({ obstacles: [{ name: "red crate", colour: "red", x: now.sim.truth.x + Math.cos(ahead) * 1.4 - 0.25, y: now.sim.truth.y + Math.sin(ahead) * 1.4 - 0.25, w: 0.5, h: 0.5 }] });
  await until(robot, (value) => value.state.sensors.lidar.ranges[0] < 1.4, { what: "the range sensor to see the crate" });

  const asked = await act("robots.capture_image", { robot: "Rover" });
  assert.equal(asked.body.record.status, "waiting-approval", JSON.stringify(asked.body));
  const lines = Object.fromEntries(asked.body.record.preview.lines.map((line) => [line.label, line.value]));
  assert.equal(asked.body.record.preview.title, "Take a picture: Rover takes one picture with its camera");
  assert.deepEqual([lines.Camera, lines["Kept for"], lines["Who can see it"]], ["camera (simulated)", "2 hours, then deleted", "Only this account. Every viewing is logged"]);
  assert.match(lines["What is detected"], /Not what an object is, and never who a person is/);
  const taken = await call("POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  assert.equal(taken.body.record.status, "done", JSON.stringify(taken.body.record));
  const picture = taken.body.record.response;
  assert.match(picture.imageId, /^im_[0-9a-f]{18}$/);
  assert.deepEqual([picture.sensor, picture.frame, picture.detector.model], ["camera", 1, "hannah-colour-regions"]);
  assert.match(picture.source, /simulated camera/);
  assert.match(taken.body.record.verification.evidence, /A 64×48 image from the camera \(frame 1, taken \d\d:\d\d:\d\d UTC, simulated camera\) arrived and is stored as im_[0-9a-f]+ until .* UTC\. The detector found \d+ coloured regions?\./);
  // Every detection carries what it came from.
  for (const item of picture.detections) assert.deepEqual([item.model, item.sensor, item.frame, item.capturedAt], ["hannah-colour-regions", "camera", 1, picture.capturedAt]);

  // The list has no image data. Opening the picture returns it and is written down, with who opened it.
  const listed = (await call("GET", `/robots/${robotId}/images`)).body;
  assert.equal(listed.images.length, 1);
  assert.equal(listed.images[0].dataUrl, undefined);
  assert.deepEqual([listed.images[0].kind, listed.images[0].width, listed.images[0].height, listed.images[0].missionId], ["simulation", 64, 48, picture.missionId]);
  assert.ok(Math.abs(listed.images[0].expiresAt - listed.images[0].at - 2 * 3_600_000) < 1000);
  const opened = (await call("GET", `/robots/${robotId}/images/${picture.imageId}`)).body.image;
  const png = Buffer.from(opened.dataUrl.replace("data:image/png;base64,", ""), "base64");
  assert.deepEqual([png.subarray(1, 4).toString(), png.readUInt32BE(16), png.readUInt32BE(20), png.length], ["PNG", 64, 48, opened.bytes]);
  assert.equal((await asKey("GET", `/robots/${robotId}/images/${picture.imageId}`)).status, 200);
  const log = (await call("GET", `/robots/events?robot=${robotId}&limit=30`)).body.events;
  assert.ok(log.some((event) => event.type === "camera-enabled"));
  assert.ok(log.some((event) => event.type === "camera-capture" && event.source === "robot"), "the robot itself recorded that its camera was used");
  assert.ok(log.some((event) => event.type === "image-stored"));
  assert.deepEqual(log.filter((event) => event.type === "image-viewed").map((event) => event.message).sort(), [`Picture ${picture.imageId} was opened by a developer key.`, `Picture ${picture.imageId} was opened by a signed-in person.`]);

  // The red crate: a red region, straight ahead, at the distance the simulated depth gives.
  const red = picture.detections.find((item) => item.colour === "red");
  assert.ok(red, `a red region ahead: ${JSON.stringify(picture.detections)}`);
  assert.equal(red.label, "red region");
  assert.ok(Math.abs(red.distanceM - 1.15) < 0.15, JSON.stringify(red));
  assert.ok(Math.abs(red.bearingDeg) < 6, JSON.stringify(red));
  assert.equal(red.distanceSource, "simulated depth (ray cast)");
  assert.match(red.position.source, /from the robot's own position estimate/);

  // What the camera last saw, for an agent: with its age, and never as "now" once it is old.
  const last = (await act("robots.camera", { robot: "Rover" })).body.record.response;
  assert.deepEqual([last.imageId, last.kind, last.cameraUse, last.stale], [picture.imageId, "simulation", "on", false]);
  assert.match(last.note, /cannot say what an object is\. The camera is simulated\./);

  // A camera that stops reporting: refused, by name.
  inputs({ obstacles: [], sensorFaults: ["camera"] });
  await until(robot, (value) => value.state.sensors.camera.ok === false, { what: "the camera fault" });
  const dark = await act("robots.capture_image", { robot: "Rover" });
  assert.match(dark.body.record.permission.reason, /Rover's camera isn't reporting/);
  inputs({ obstacles: [], sensorFaults: [] });
  await until(robot, (value) => value.state.sensors.camera.ok === true, { what: "the camera to return" });

  // After its time a picture is gone, and "what it last saw" says there is none.
  const db = await require("./db").getDatabase();
  const owner = (await db.query("SELECT user_id FROM hannah_robot_images WHERE id = $1", [picture.imageId])).rows[0].user_id;
  const later = require("./robotics/service").createRoboticsService({ now: () => Date.now() + 3 * 3_600_000 });
  assert.deepEqual((await later.listImages(db, owner, robotId)).images, []);
  assert.equal((await call("GET", `/robots/${robotId}/images/${picture.imageId}`)).status, 404);
  assert.equal((await act("robots.camera", { robot: "Rover" })).body.record.response.picture, null);

  // Switched off again: refused again.
  await call("PATCH", `/robots/${robotId}`, { camera: { enabled: false } });
  assert.equal((await act("robots.capture_image", { robot: "Rover" })).body.record.status, "denied");
  assert.equal((await robot()).state.sensors.camera.framesCaptured, 1, "one picture was asked for and one was taken");
});

test("revoking the robot ends its access; the runtime holds and reports it locally", { skip }, async () => {
  await idle();
  await call("POST", `/robots/${robotId}/revoke`);
  await until(async () => log, (lines) => lines.some((line) => line.event === "revoked"), { ms: 15_000, what: "the runtime to notice" });
  assert.equal(runtime.exitCode, null, "the runtime keeps running, holding position");
  assert.equal((await robot()).connection, "revoked");
});
