"use strict";

// Integration tests: commissioning, destinations, pause and resume, the newer
// read actions and the flood guard, on the real server and database with a
// scripted stand-in robot. "Physical" here means a record created as physical
// and a stand-in that enrolls as physical: NO physical robot is involved.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robotics-stage2-token-0123456789-abcdefghijklmn";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "b".repeat(64);
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "1500";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
delete process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S; // the default limit is under test here
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");
const { fingerprintOf } = require("./robotics/service");

let server;
let base;
const users = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const act = (who, action, params) => call(who, "POST", "/actions", { action, params, request: "test request", agent: "Robot agent" });
const decide = (who, id, approve) => call(who, "POST", `/actions/${id}/decision`, { approve });
const mission = async (id) => (await call(users.asha, "GET", `/robots/missions/${id}`)).body.mission;
const PHYSICAL = { simulation: null, limits: { ...descriptor().limits, environment: "shared-with-people", estop: { hardware: true, description: "Red mushroom button on the rear panel" } } };

async function enrolled(name, { simulated = true, described } = {}) {
  const created = await call(users.asha, "POST", "/robots", { name, simulated });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  const answer = await robot.enroll(created.body.enrollment.code, described || descriptor(simulated ? {} : PHYSICAL));
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  robot.fingerprint = answer.body.fingerprint;
  assert.equal((await robot.sync()).status, 200);
  return robot;
}
/** The stand-in robot exchanging about fourteen times a second (under the flood limit) until stopped. */
function running(robot, behave = () => []) {
  let on = true;
  const reports = [];
  const received = [];
  const loop = (async () => {
    while (on) {
      const out = await robot.sync({ reports: reports.splice(0), send: { ...robot.state, at: Date.now() } });
      for (const command of out.commands || []) {
        const key = `${command.type}:${command.missionId}:${command.nonce || ""}`;
        if (robot.seen.has(key)) continue;
        robot.seen.set(key, command);
        received.push(command);
        reports.push(...((await behave(command, robot)) || []));
      }
      await sleep(70);
    }
    if (reports.length) await robot.sync({ reports: reports.splice(0) });
  })();
  return { received, report: (...items) => reports.push(...items), stop: async () => { on = false; await loop; } };
}
/** A cooperative robot: accepts missions and answers pause, resume and cancel. */
const cooperative = (command) => (command.type === "mission" ? [{ missionId: command.missionId, status: "accepted" }] : command.type === "pause" ? [{ missionId: command.missionId, status: "paused" }] : command.type === "resume" ? [{ missionId: command.missionId, status: "resumed" }] : [{ missionId: command.missionId, status: "cancelled", reason: "Cancelled by HANNAH; holding position." }]);
const confirm = (who, robot, step, body = { attest: true }) => call(who, "POST", `/robots/${robot.robotId}/commissioning/${step}`, body);

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "asha@stage2.example", password: "correct horse battery staple" }) });
  assert.equal(response.status, 200);
  users.asha = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.key = { Authorization: `Bearer ${key.body.key}` };
});
after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("commissioning: a physical robot moves only after a person has taken it through every check, and the server checks what it can see", async () => {
  // The same value is asserted in robotics/runtime/tests/test_stage2.py against the runtime's code.
  assert.equal(fingerprintOf(Buffer.alloc(32, 7).toString("base64url")), "F86E CC32 9E7A BDAB");
  const robot = await enrolled("Forklift", { simulated: false });
  users.forklift = robot;
  const view = async () => (await call(users.asha, "GET", `/robots/${robot.robotId}/commissioning`)).body.commissioning;
  let now = await view();
  assert.deepEqual([now.required, now.status, now.done, now.total, now.next], [true, "required", 0, 7, "identity"]);
  assert.deepEqual(now.steps.map((step) => step.id), ["identity", "inventory", "limits", "estop", "diagnostics", "trial", "approval"]);
  // Both sides show the same fingerprint, computed from the secret the robot holds.
  assert.equal(robot.fingerprint, fingerprintOf(robot.secret));
  assert.deepEqual(now.steps[0].check.facts, [`Fingerprint: ${robot.fingerprint}`]);
  await call(users.asha, "POST", `/robots/${robot.robotId}/destinations`, { fromPlace: "workbench" });

  // Who may confirm, and how.
  assert.equal((await confirm(users.key, robot, "identity")).status, 403, "an agent's key can't commission a robot");
  assert.equal((await confirm(users.asha, robot, "identity", {})).body.reason, "not-attested");
  assert.equal((await confirm(users.asha, robot, "estop")).body.reason, "out-of-order");
  assert.equal((await confirm(users.asha, robot, "wiring")).status, 404);
  for (const step of ["identity", "inventory", "limits"]) assert.equal((await confirm(users.asha, robot, step, { attest: true, note: "checked at the machine" })).status, 200, step);
  now = await view();
  assert.deepEqual([now.status, now.done, now.next], ["in-progress", 3, "estop"]);
  assert.equal(now.steps[1].note, "checked at the machine");
  assert.match((await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "workbench" })).body.record.permission.reason, /hasn't been commissioned: 3 of 7 checks are done/);

  // The emergency stop: a tick is not enough. HANNAH has to have seen it engage and release.
  const unseen = await confirm(users.asha, robot, "estop");
  assert.equal(unseen.status, 409);
  assert.match(unseen.body.error, /HANNAH hasn't seen it engage since commissioning started/);
  robot.state = state({ estop: { engaged: true, source: "hardware" }, mode: "estopped" });
  await robot.sync({ events: [{ type: "estop-engaged", severity: "error", message: "The emergency stop was engaged." }] });
  assert.match((await confirm(users.asha, robot, "estop")).body.error, /Release the emergency stop/);
  robot.state = state();
  await sleep(5);
  await robot.sync({ events: [{ type: "estop-released", severity: "info", message: "The emergency stop was released." }] });
  assert.equal((await confirm(users.asha, robot, "estop", { attest: true, note: "cuts drive power with the computer off" })).status, 200);

  // Diagnostics are read from the robot now.
  robot.state = state({ faults: [{ code: "motor-driver", message: "Left motor driver over-temperature" }], mode: "fault" });
  await robot.sync();
  assert.match((await confirm(users.asha, robot, "diagnostics")).body.error, /It reports a fault: Left motor driver over-temperature/);
  robot.state = state({ sensors: { lidar: { ok: false }, odometry: { ok: true }, battery: { percent: 80 } } });
  await robot.sync();
  assert.match((await confirm(users.asha, robot, "diagnostics")).body.error, /Not reporting: lidar/);
  robot.state = state();
  await robot.sync();
  assert.equal((await confirm(users.asha, robot, "diagnostics")).status, 200);
  now = await view();
  assert.deepEqual([now.status, now.trialSpeed, now.next], ["trial", 0.2, "trial"]);

  // Trial mode: movement is allowed, slowly, and still asks.
  assert.match((await confirm(users.asha, robot, "trial")).body.error, /Run one supervised trip first/);
  const live = running(robot, cooperative);
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "workbench" });
  assert.equal(asked.body.record.status, "waiting-approval");
  assert.match(asked.body.record.permission.reason, /commissioning trial: supervised, limited to 0\.2 m\/s; this is a physical robot and it will move/);
  assert.match(asked.body.record.preview.warnings.join(" "), /A person must be at the robot with its emergency stop in reach/);
  const started = await decide(users.asha, asked.body.record.id, true);
  assert.equal(started.body.record.status, "done", JSON.stringify(started.body.record));
  assert.equal(live.received.find((command) => command.type === "mission").params.maxSpeed, 0.2);
  robot.state = state({ pose: { x: 3, y: 2, source: "map localization" } });
  await sleep(150);
  live.report({ missionId: started.body.record.response.missionId, status: "succeeded", result: {} });
  await sleep(250);
  await live.stop();
  assert.equal((await mission(started.body.record.response.missionId)).status, "succeeded");
  assert.equal((await confirm(users.asha, robot, "trial")).status, 200);
  const approved = await confirm(users.asha, robot, "approval");
  assert.deepEqual([approved.body.commissioning.status, approved.body.commissioning.done], ["approved", 7]);
  assert.equal((await confirm(users.asha, robot, "approval")).body.reason, "already-approved");

  // Approved: full speed is available, and each movement still asks.
  const full = await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "workbench" });
  assert.equal(full.body.record.status, "waiting-approval");
  assert.equal(full.body.record.permission.reason, "Needs your approval: this is a physical robot and it will move.");
  assert.ok(full.body.record.preview.lines.some((line) => line.label === "Speed limit" && line.value === "0.5 m/s"));
  await decide(users.asha, full.body.record.id, false);
  const events = (await call(users.asha, "GET", `/robots/events?robot=${robot.robotId}&limit=100`)).body.events.map((event) => event.type);
  assert.ok(events.includes("commissioned") && events.filter((type) => type === "commissioning-step").length === 6);
});

test("commissioning is withdrawn when the robot reports different hardware or limits, and can be withdrawn by its owner", async () => {
  const robot = users.forklift;
  // The same robot comes back reporting a higher top speed.
  await robot.sync({ described: descriptor({ ...PHYSICAL, limits: { ...PHYSICAL.limits, maxLinearSpeed: 1.5 } }) });
  const refused = await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "workbench" });
  assert.equal(refused.body.record.status, "denied");
  assert.match(refused.body.record.permission.reason, /hasn't been commissioned: 0 of 7 checks are done \(The robot now reports different sensors, actuators, capabilities or limits than it was commissioned with\.\)/);
  const view = (await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot;
  assert.equal(view.commissioning.status, "required");
  assert.equal(view.fingerprint, robot.fingerprint, "its identity is unchanged");
  assert.equal(JSON.stringify(view).includes("commissioningRecord"), false);
  // An unchanged description changes nothing.
  for (const step of ["identity", "inventory", "limits"]) assert.equal((await confirm(users.asha, robot, step)).status, 200);
  await robot.sync({ described: descriptor({ ...PHYSICAL, limits: { ...PHYSICAL.limits, maxLinearSpeed: 1.5 } }) });
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}/commissioning`)).body.commissioning.done, 3);
  assert.equal((await call(users.key, "POST", `/robots/${robot.robotId}/commissioning/reset`, { reason: "moved to another hall" })).status, 403);
  const reset = await call(users.asha, "POST", `/robots/${robot.robotId}/commissioning/reset`, { reason: "moved to another hall" });
  assert.deepEqual([reset.body.commissioning.status, reset.body.commissioning.resetReason], ["required", "moved to another hall"]);
  // Reading and stopping never depended on commissioning.
  assert.equal((await act(users.asha, "robots.state", { robot: "Forklift" })).body.record.status, "done");
  assert.equal((await act(users.key, "robots.stop_motion", { robot: "Forklift" })).body.record.permission.code, "deescalates");
  // A simulated robot has nothing to commission.
  const sim = await enrolled("Rover");
  users.rover = sim;
  const none = (await call(users.asha, "GET", `/robots/${sim.robotId}/commissioning`)).body.commissioning;
  assert.deepEqual([none.required, none.status], [false, "not-required"]);
  assert.equal((await confirm(users.asha, sim, "identity")).body.reason, "not-required");
});

test("destinations: a name is a place only once it is defined or approved for the robot's map", async () => {
  const physical = users.forklift;
  const list = async (robot) => (await call(users.asha, "GET", `/robots/${robot.robotId}/destinations`)).body;
  let places = await list(physical);
  // The physical robot reported three places; only the one approved earlier is usable by name.
  assert.deepEqual(places.destinations.map((item) => [item.name, item.source, item.map, item.frame]), [["workbench", "robot-profile", "bench", "map"]]);
  assert.deepEqual(places.reported.map((item) => [item.name, item.usable]), [["dock", false], ["workbench", true], ["door", false]]);
  assert.match(places.rule, /A physical robot goes by name only to destinations you defined or approved/);
  const unknown = await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "door" });
  assert.match(unknown.body.record.permission.reason, /no place called “door” \(it has: workbench\)/);
  // A simulated robot may use the places its runtime reported.
  assert.deepEqual((await list(users.rover)).destinations.map((item) => [item.name, item.source]), [["dock", "robot"], ["workbench", "robot"], ["door", "robot"]]);

  // Defining one: checked against the robot's limits and its map.
  const add = (body, who = users.asha, robot = users.rover) => call(who, "POST", `/robots/${robot.robotId}/destinations`, body);
  assert.equal((await add({ name: "kitchen", x: 1, y: 1 }, users.key)).status, 403);
  assert.match((await add({ name: "moon", x: 40, y: 0 })).body.error, /outside the robot's allowed workspace/);
  assert.match((await add({ name: "stairs top", x: 4.5, y: -3.5 })).body.error, /keep-out zone “stairs”/);
  assert.match((await add({ name: "in the box", x: 0.5, y: 0.5 })).body.error, /inside or touching an obstacle on the robot's map/);
  assert.match((await add({ name: "nowhere", x: "left", y: 2 })).body.error, /needs x and y in metres/);
  assert.equal((await add({ x: 1, y: 1 })).status, 400);
  const added = await add({ name: "Kitchen", x: -2.5, y: 2.5, yaw: 1.57 });
  assert.equal(added.status, 201);
  const kitchen = added.body.destinations.find((item) => item.name === "Kitchen");
  assert.deepEqual([kitchen.x, kitchen.y, kitchen.yaw, kitchen.source, kitchen.map, kitchen.frame], [-2.5, 2.5, 1.57, "owner", "bench", "map"]);
  assert.equal((await add({ name: "kitchen", x: -2, y: 2 })).status, 409);
  // It is now a goal, by name, with the coordinates that were approved.
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "kitchen" });
  assert.equal(asked.body.record.preview.title, "Start a mission: Rover drives to Kitchen (-2.5, 2.5)");
  await decide(users.asha, asked.body.record.id, false);
  const read = await act(users.key, "robots.destinations", { robot: "Rover" });
  assert.equal(read.body.record.response.map, "bench");
  assert.ok(read.body.record.response.destinations.some((item) => item.name === "Kitchen" && item.frame === "map"));

  // The robot starts reporting another map: a destination made for the old one is not used.
  await users.rover.sync({ described: descriptor({ world: { ...descriptor().world, name: "warehouse" } }) });
  places = await list(users.rover);
  assert.deepEqual(places.stale.map((item) => [item.name, item.map]), [["Kitchen", "bench"]]);
  assert.equal(places.destinations.some((item) => item.name === "Kitchen"), false);
  assert.match((await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "Kitchen" })).body.record.permission.reason, /no place called “Kitchen”/);
  await users.rover.sync({ described: descriptor() });
  assert.equal((await list(users.rover)).destinations.some((item) => item.name === "Kitchen"), true);
  assert.equal((await call(users.asha, "DELETE", `/robots/${users.rover.robotId}/destinations/${kitchen.id}`)).status, 200);
  assert.equal((await call(users.asha, "DELETE", `/robots/${users.rover.robotId}/destinations/${kitchen.id}`)).status, 404);
  assert.ok((await call(users.asha, "GET", `/robots/${users.rover.robotId}`)).body.robot.configVersion > 1);
});

test("pause holds the mission without approval; resume moves the robot again, so it is checked and approved; cancel ends it", async () => {
  const robot = users.rover;
  robot.state = state();
  const live = running(robot, cooperative);
  assert.equal((await act(users.key, "robots.pause_mission", { robot: "Rover" })).status, 404, "nothing to pause");
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  const started = await decide(users.asha, asked.body.record.id, true);
  const missionId = started.body.record.response.missionId;
  const deadline = (await mission(missionId)).deadlineAt;

  // An agent's key may pause: it only reduces what is happening.
  const paused = await act(users.key, "robots.pause_mission", { robot: "Rover" });
  assert.equal(paused.body.record.status, "done", JSON.stringify(paused.body.record));
  assert.equal(paused.body.record.permission.code, "deescalates");
  assert.match(paused.body.record.verification.evidence, /paused\. Rover is holding where it is and keeps the mission/);
  assert.equal((await mission(missionId)).status, "paused");
  assert.deepEqual(live.received.map((command) => command.type), ["mission", "pause"]);
  // A paused mission is still the robot's mission.
  assert.match((await act(users.asha, "robots.return_to_dock", { robot: "Rover" })).body.record.permission.reason, /already on a mission/);
  await sleep(400);

  // Resume: the same permission as starting, the same checks against the robot as it is now.
  robot.state = state({ estop: { engaged: true, source: "simulated-hardware" }, mode: "estopped" });
  await sleep(200);
  const blocked = await act(users.asha, "robots.resume_mission", { robot: "Rover" });
  assert.equal(blocked.body.record.status, "denied");
  assert.match(blocked.body.record.permission.reason, /emergency stop is engaged/);
  robot.state = state();
  await sleep(200);
  const resume = await act(users.key, "robots.resume_mission", { mission: missionId });
  assert.equal(resume.body.record.status, "waiting-approval", "an agent can't resume on its own");
  assert.equal(resume.body.record.preview.title, "Resume: Rover carries on with “Drive to a place”");
  const resumed = await decide(users.asha, resume.body.record.id, true);
  assert.equal(resumed.body.record.status, "done", JSON.stringify(resumed.body.record));
  assert.match(resumed.body.record.verification.evidence, /reported that it resumed mission .* not that it arrived/);
  const command = live.received.find((item) => item.type === "resume");
  assert.match(command.nonce, /^[0-9a-f]{32}$/);
  assert.equal(command.expiresAt - command.issuedAt, 20_000);
  const after = await mission(missionId);
  assert.equal(after.status, "accepted");
  assert.ok(after.deadlineAt >= deadline + 600, "the time it stood paused doesn't count against its time limit");

  // Cancel, as an action: no approval, confirmed by the robot.
  const cancelled = await act(users.key, "robots.cancel_mission", { robot: "Rover" });
  assert.equal(cancelled.body.record.status, "done");
  assert.match(cancelled.body.record.verification.evidence, /cancelled\. Cancelled by HANNAH; holding position\./);
  assert.equal((await mission(missionId)).status, "cancelled");
  await live.stop();

  // A robot that refuses to resume: the mission stays paused, with the robot's reason.
  robot.seen.clear();
  const stubborn = running(robot, (item) => (item.type === "resume" ? [{ missionId: item.missionId, status: "resume-refused", reason: "Refused by the robot's own safety checks: the lidar sensor isn't reporting." }] : cooperative(item)));
  const again = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "door" });
  const second = (await decide(users.asha, again.body.record.id, true)).body.record.response.missionId;
  await call(users.asha, "POST", `/robots/missions/${second}/pause`);
  const viaRoute = await call(users.asha, "POST", `/robots/missions/${second}/resume`);
  assert.equal(viaRoute.status, 202);
  const refused = await decide(users.asha, viaRoute.body.record.id, true);
  assert.equal(refused.body.record.status, "failed");
  assert.match(refused.body.record.error, /Rover didn't resume\. Refused by the robot's own safety checks: the lidar sensor isn't reporting\./);
  assert.equal((await mission(second)).status, "paused");
  await call(users.asha, "POST", `/robots/missions/${second}/cancel`);
  await sleep(300);
  await stubborn.stop();
});

test("a robot is not moved blind, and what it senses is reported with where it came from", async () => {
  const robot = await enrolled("Scout", { described: descriptor({ capabilities: [...descriptor().capabilities, "report_surroundings"] }) });
  robot.state = state({ sensors: { lidar: { ok: false, problem: "not reporting" }, odometry: { ok: true }, battery: { percent: 80 } } });
  await robot.sync();
  const blind = await act(users.asha, "robots.navigate_to", { robot: "Scout", place: "workbench" });
  assert.equal(blind.body.record.status, "denied");
  assert.match(blind.body.record.permission.reason, /Scout's lidar sensor isn't reporting, so it won't be moved/);

  // Surroundings: only what the robot's sensors reported.
  assert.equal((await act(users.asha, "robots.surroundings", { robot: "Scout" })).body.record.status, "failed", "nothing reported yet");
  robot.state = state({ perception: { measuredAt: Date.now(), sensor: "lidar", source: "simulated range sensor", obstaclesKnown: true, obstacles: [{ kind: "object not on the map", x: 1.2, y: -2, distanceM: 1.2, bearingDeg: 0, confidence: 0.84, returns: 3, sensor: "lidar" }], route: { blocked: true, reason: "Something the range sensor sees is in the robot's path." }, changes: [], sensorHealth: [{ id: "lidar", ok: true }] } });
  await robot.sync();
  const seen = (await act(users.key, "robots.surroundings", { robot: "Scout" })).body.record;
  assert.equal(seen.status, "done");
  assert.deepEqual([seen.response.obstacles[0].kind, seen.response.obstacles[0].sensor, seen.response.obstacles[0].confidence], ["object not on the map", "lidar", 0.84]);
  assert.equal(seen.response.route.blocked, true);
  assert.equal(seen.response.kind, "simulation");
  assert.match(seen.response.note, /sensor measurements with their source\. Nothing here was inferred by a language model/);
  // A robot that doesn't offer it isn't asked.
  assert.match((await act(users.asha, "robots.surroundings", { robot: "Rover" })).body.record.error, /Rover doesn't offer “Report what is around the robot”/);

  // Battery: the sensor's reading, or a plain statement that there is none.
  const battery = (await act(users.key, "robots.battery", { robot: "Scout" })).body.record.response;
  assert.deepEqual([battery.percent, battery.charging, battery.minimumToStartPercent, battery.source], [80, false, 15, "the robot's battery sensor"]);
  robot.state = state({ battery: null });
  await robot.sync();
  assert.match((await act(users.key, "robots.battery", { robot: "Scout" })).body.record.error, /Scout hasn't reported a battery reading yet/);
  assert.equal((await call(users.asha, "DELETE", `/robots/${robot.robotId}`)).status, 200);
});

test("maintenance notes are kept per robot, written by a signed-in person", async () => {
  const id = users.rover.robotId;
  assert.equal((await call(users.key, "POST", `/robots/${id}/maintenance`, { kind: "inspection", note: "x" })).status, 403);
  assert.equal((await call(users.asha, "POST", `/robots/${id}/maintenance`, { kind: "inspection" })).status, 400);
  const added = await call(users.asha, "POST", `/robots/${id}/maintenance`, { kind: "replacement", note: "Left drive wheel replaced; tread was worn." });
  assert.equal(added.status, 201);
  const log = (await call(users.key, "GET", `/robots/${id}/maintenance`)).body.maintenance;
  assert.deepEqual([log[0].kind, log[0].note], ["replacement", "Left drive wheel replaced; tread was worn."]);
});

test("a flood of requests in one robot's name is refused before any work is done", async () => {
  const send = () => fetch(`${base}/api/robots/device/sync`, { method: "POST", headers: { "Content-Type": "application/json", "X-Hannah-Robot": "rb_ffffffffffffffffff" }, body: "{}" }).then((response) => response.status);
  const statuses = await Promise.all(Array.from({ length: 130 }, send));
  assert.equal(statuses.filter((status) => status === 401).length, 100);
  assert.equal(statuses.filter((status) => status === 429).length, 30);
  // Another robot is not affected.
  assert.equal((await users.rover.sync()).status, 200);
});
