"use strict";

// Integration tests: the real server and database, with a stand-in robot that
// speaks the robot protocol and reports whatever the test scripts. Nothing
// here is a simulation or a physical robot; see robotics.sim.test.js for the
// simulated robot.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robotics-test-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "d".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000"; // the stand-in robot exchanges far faster than a real one
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "1500";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");
const { createRoboticsService } = require("./robotics/service");

let server;
let base;
let db;
const users = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
};
const act = (who, action, params, extra = {}) => call(who, "POST", "/actions", { action, params, request: "test request", agent: "Robot agent", ...extra });
const decide = (who, id, approve) => call(who, "POST", `/actions/${id}/decision`, { approve });
const levels = (who, robots) => call(who, "PUT", "/account/permissions", { levels: { robots } });
const missionsOf = async (who, robotId) => (await call(who, "GET", `/robots/missions?robot=${robotId}&limit=50`)).body.missions;

/** Create a robot record and enroll a stand-in robot for it. */
async function enrolled(who, name, { simulated = true, described } = {}) {
  const created = await call(who, "POST", "/robots", { name, simulated });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  const answer = await robot.enroll(created.body.enrollment.code, described || descriptor(simulated ? {} : { simulation: null, limits: { ...descriptor().limits, environment: "shared-with-people", estop: { hardware: true, description: "red button" } } }));
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal((await robot.sync()).status, 200);
  return robot;
}

/**
 * Let the stand-in robot run: it syncs until stopped and answers each new
 * command with the reports `behave` returns for it.
 */
function running(robot, behave = () => []) {
  let on = true;
  const reports = [];
  const received = [];
  const loop = (async () => {
    while (on) {
      const out = await robot.sync({ reports: reports.splice(0), send: { ...robot.state, at: Date.now() } });
      for (const command of out.commands || []) {
        const key = `${command.type}:${command.missionId}`;
        if (robot.seen.has(key)) continue;
        robot.seen.set(key, command);
        received.push(command);
        reports.push(...((await behave(command, robot)) || []));
      }
      await sleep(30);
    }
    if (reports.length) await robot.sync({ reports: reports.splice(0) });
  })();
  return { received, report: (...items) => reports.push(...items), stop: async () => { on = false; await loop; } };
}
const accept = (command) => (command.type === "mission" ? [{ missionId: command.missionId, status: "accepted", at: Date.now() }] : []);

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["asha", "bo"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@robots.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@robots.example`])).rows[0].id;
  }
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.ashaKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("registration: a signed-in person creates a robot; a one-time code enrolls exactly one runtime of the declared kind", async () => {
  assert.equal((await call(null, "GET", "/robots")).status, 401);
  assert.equal((await call(null, "POST", "/robots", { name: "Ghost", simulated: true })).status, 401);
  // A developer key (an agent) can look but can't enroll a robot.
  const byKey = await call(users.ashaKey, "POST", "/robots", { name: "Sneaky", simulated: true });
  assert.equal(byKey.status, 403);
  assert.equal(byKey.body.reason, "session-required");
  assert.equal((await call(users.asha, "POST", "/robots", { name: "Rover" })).status, 400, "simulated or physical must be said");

  const created = await call(users.asha, "POST", "/robots", { name: "Rover", simulated: true });
  assert.equal(created.status, 201);
  assert.match(created.body.enrollment.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.match(created.body.command, /python3 -m hannah_robot enroll --server http:\/\/127\.0\.0\.1:\d+ --code /);
  assert.equal(created.body.robot.connection, "awaiting-enrollment");
  assert.equal((await call(users.asha, "POST", "/robots", { name: "rover", simulated: true })).status, 409, "names are unique per account");
  // The code is stored as a hash, never as itself.
  const stored = (await db.query("SELECT enroll_hash, ciphertext FROM hannah_robots WHERE id = $1", [created.body.robot.id])).rows[0];
  assert.match(stored.enroll_hash, /^[0-9a-f]{64}$/);
  assert.equal(stored.ciphertext, null);

  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll("AAAAA-BBBBB")).status, 403);
  // A runtime that drives real hardware can't take a record created for a simulation.
  const mismatch = await robot.enroll(created.body.enrollment.code, descriptor({ simulation: null }));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.reason, "kind-mismatch");
  assert.equal((await robot.enroll(created.body.enrollment.code, { ...descriptor(), robotType: "hoverboard" })).status, 400);

  const done = await robot.enroll(created.body.enrollment.code);
  assert.equal(done.status, 201);
  assert.match(done.body.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(done.body.capabilities, descriptor().capabilities);
  // Used once.
  assert.equal((await createRobotClient({ base }).enroll(created.body.enrollment.code)).status, 403);
  // The secret is sealed in the database, and no API returns it.
  const sealed = (await db.query("SELECT ciphertext, wrapped_key, enroll_hash FROM hannah_robots WHERE id = $1", [done.body.robotId])).rows[0];
  assert.ok(sealed.ciphertext && sealed.wrapped_key && !sealed.ciphertext.includes(done.body.secret));
  assert.equal(sealed.enroll_hash, null);
  const view = await call(users.asha, "GET", `/robots/${done.body.robotId}`);
  assert.equal(JSON.stringify(view.body).includes(done.body.secret), false);
  assert.equal(view.body.robot.connection, "never-connected");
  assert.equal(view.body.robot.simulated, true);
  assert.equal(view.body.robot.simulator, "stand-in");
  assert.equal(view.body.robot.manufacturer, "HANNAH test bench");
  assert.equal(view.body.robot.robotType, "differential-drive");
  assert.equal(view.body.robot.category, "mobile-base");
  assert.deepEqual(view.body.robot.sensors.map((sensor) => sensor.id), ["lidar", "odometry", "battery"]);
  assert.equal(view.body.robot.limits.maxLinearSpeed, 0.5);
  assert.ok(view.body.events.some((event) => event.type === "enrolled"));
  assert.ok(view.body.events.some((event) => event.type === "enrollment-refused"));
  // Someone else's account doesn't see it and can't touch it.
  assert.deepEqual((await call(users.bo, "GET", "/robots")).body.robots, []);
  assert.equal((await call(users.bo, "GET", `/robots/${done.body.robotId}`)).status, 404);
  assert.equal((await call(users.bo, "POST", `/robots/${done.body.robotId}/revoke`)).status, 404);
  users.rover = robot;
});

test("device authentication: only the enrolled robot's signed, fresh, unrepeated request is accepted", async () => {
  const robot = users.rover;
  const body = JSON.stringify({ state: state() });
  const status = async (headers, text = body) => { const response = await robot.rawSync(text, headers); return { status: response.status, reason: (await response.json()).reason }; };
  assert.deepEqual(await status({}), { status: 401, reason: "bad-signature" });
  assert.deepEqual(await status({ ...robot.sign(body), "X-Hannah-Signature": "0".repeat(64) }), { status: 401, reason: "bad-signature" });
  // Signed with another key.
  assert.deepEqual(await status(robot.sign(body, { secret: Buffer.alloc(32, 1).toString("base64url") })), { status: 401, reason: "bad-signature" });
  // A valid signature for a different body.
  assert.deepEqual(await status(robot.sign(body), JSON.stringify({ state: state({ mode: "navigating" }) })), { status: 401, reason: "bad-signature" });
  // An account session is not a robot.
  assert.equal((await fetch(`${base}/api/robots/device/sync`, { method: "POST", headers: { ...users.asha, "Content-Type": "application/json" }, body })).status, 401);

  const good = robot.sign(body);
  assert.equal((await status(good)).status, 200);
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot.connection, "online");
  // The same request again is a replay.
  assert.deepEqual(await status(good), { status: 401, reason: "replayed" });
  assert.deepEqual(await status(robot.sign(body, { counter: 1 })), { status: 401, reason: "replayed" });
  // A request signed two minutes ago.
  assert.deepEqual(await status(robot.sign(body, { time: Date.now() - 120_000 })), { status: 401, reason: "clock-skew" });
  assert.equal((await robot.sync()).status, 200);
});

test("capability registration: a robot gets only capabilities the contract allows for it, and HANNAH can't ask for the others", async () => {
  const robot = await enrolled(users.asha, "Scout", { described: descriptor({ capabilities: ["report_robot_state", "stop_motion", "set_motor_pwm", "grasp_object", "capture_image"] }) });
  const view = (await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot;
  assert.deepEqual(view.capabilities, ["report_robot_state", "stop_motion"]);
  assert.deepEqual(view.refusedCapabilities.map((item) => item.id), ["set_motor_pwm", "grasp_object", "capture_image"]);
  const drive = await act(users.asha, "robots.navigate_to", { robot: "Scout", x: 1, y: 1 });
  assert.equal(drive.body.record.status, "denied");
  assert.match(drive.body.record.permission.reason, /Scout doesn't offer “Drive to a place”/);
  assert.equal((await act(users.asha, "robots.set_motor_pwm", { robot: "Scout", left: 255 })).status, 404, "there is no such action");
  const contract = await call(users.asha, "GET", "/robots/contract");
  assert.equal(contract.body.capabilities.length, 19);
  assert.equal(contract.body.capabilities.find((item) => item.id === "grasp_object").status, "contract-only");
  assert.equal((await call(users.asha, "DELETE", `/robots/${robot.robotId}`)).status, 200);
});

test("invalid commands are refused before anyone is asked, with the reason, and nothing is sent", async () => {
  const robot = users.rover;
  await robot.sync();
  for (const [params, expected] of [
    [{ robot: "Rover", x: 40, y: 0 }, /outside the robot's allowed workspace/],
    [{ robot: "Rover", x: 4.5, y: -3.5 }, /keep-out zone “stairs”/],
    [{ robot: "Rover", x: 1, y: 1, maxSpeed: 3 }, /above Rover's limit of 0.5 m\/s/],
    [{ robot: "Rover", place: "the moon" }, /no place called “the moon”/],
    [{ robot: "Rover" }, /give a place name, or x and y/],
  ]) {
    const answer = await act(users.asha, "robots.navigate_to", params);
    assert.equal(answer.body.record.status, "denied", JSON.stringify(answer.body));
    assert.match(answer.body.record.permission.reason, expected);
    assert.equal(answer.body.record.permission.code, "forbidden");
  }
  assert.equal((await act(users.asha, "robots.navigate_to", { robot: "Nobody", x: 1, y: 1 })).status, 404);
  assert.deepEqual(await missionsOf(users.asha, robot.robotId), []);
  // Another account can't command it, by name or by id.
  assert.equal((await act(users.bo, "robots.navigate_to", { robot: robot.robotId, x: 1, y: 1 })).status, 404);
  assert.equal((await robot.sync()).commands.length, 0);
});

test("permission: movement waits for the person; a key can't approve; declining sends nothing; read-only refuses", async () => {
  const robot = users.rover;
  await robot.sync();
  const asked = await act(users.ashaKey, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  assert.equal(asked.status, 202);
  assert.equal(asked.body.record.status, "waiting-approval");
  assert.equal(asked.body.record.preview.title, "Start a mission: Rover drives to workbench (3, 2)");
  assert.ok(asked.body.record.preview.lines.some((line) => line.label === "Robot" && /SIMULATION \(stand-in\)/.test(line.value)));
  assert.deepEqual(asked.body.record.resource, { type: "robot", id: robot.robotId });
  assert.equal((await decide(users.ashaKey, asked.body.record.id, true)).status, 403, "an agent can't approve its own request");
  assert.equal((await decide(users.bo, asked.body.record.id, true)).status, 404);
  const declined = await decide(users.asha, asked.body.record.id, false);
  assert.equal(declined.body.record.status, "declined");
  assert.deepEqual(await missionsOf(users.asha, robot.robotId), []);
  assert.equal((await robot.sync()).commands.length, 0);

  await levels(users.asha, 1);
  const refused = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  assert.equal(refused.body.record.status, "denied");
  assert.match(refused.body.record.permission.reason, /Robots is set to Read only/);
  // Reading still works, and so does stopping.
  assert.equal((await act(users.asha, "robots.state", { robot: "Rover" })).body.record.status, "done");
  await levels(users.asha, 2);
  assert.equal((await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" })).body.record.status, "suggested");
  await levels(users.asha, 3);
  assert.deepEqual(await missionsOf(users.asha, robot.robotId), []);
});

test("a mission: approved, signed, accepted by the robot, then verified from the robot's reported state", async () => {
  const robot = users.rover;
  robot.state = state();
  const live = running(robot, accept);
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench", maxSpeed: 0.3 });
  assert.equal(asked.body.record.status, "waiting-approval");
  assert.equal(live.received.length, 0, "nothing is sent while approval waits");
  const approved = await decide(users.asha, asked.body.record.id, true);
  assert.equal(approved.body.record.status, "done", JSON.stringify(approved.body.record));
  assert.match(approved.body.record.verification.evidence, /Rover accepted mission ms_[0-9a-f]+ and is carrying it out\. This confirms the start, not the result/);
  const command = live.received[0];
  assert.equal(command.type, "mission");
  assert.equal(command.capability, "navigate_to");
  assert.equal(command.robotId, robot.robotId);
  assert.deepEqual(command.params, { x: 3, y: 2, place: "workbench", tolerance: 0.25, maxSpeed: 0.3 });
  assert.deepEqual(command.limits, { maxLinearSpeed: 0.5, maxAngularSpeed: 1.5 });
  assert.match(command.nonce, /^[0-9a-f]{32}$/);
  assert.ok(command.expiresAt - command.issuedAt === 20_000 && command.timeoutS === 180);
  const missionId = approved.body.record.response.missionId;
  let mission = (await call(users.asha, "GET", `/robots/missions/${missionId}`)).body.mission;
  assert.equal(mission.status, "accepted");
  assert.equal(mission.actionId, asked.body.record.id);
  assert.match(mission.summary, /Rover accepted it and is carrying it out.*It is not finished/);
  // A second movement can't start while this one runs.
  const second = await act(users.asha, "robots.return_to_dock", { robot: "Rover" });
  assert.equal(second.body.record.status, "denied");
  assert.match(second.body.record.permission.reason, /already on a mission \(navigate_to\)/);

  // On the way: moving, not there yet.
  robot.state = state({ mode: "navigating", pose: { x: 1.5, y: 0.2, yaw: 0.6, source: "odometry" }, velocity: { linear: 0.3, angular: 0.1 } });
  live.report({ missionId, status: "progress", progress: { distanceRemaining: 2.3 } });
  await sleep(150);
  mission = (await call(users.asha, "GET", `/robots/missions/${missionId}`)).body.mission;
  assert.equal(mission.status, "accepted");
  assert.equal(mission.progress.distanceRemaining, 2.3);
  // Arrived and standing still: the server checks the reported pose against the goal.
  robot.state = state({ mode: "idle", pose: { x: 2.93, y: 1.96, yaw: 0.6, source: "odometry" }, sim: { truth: { x: 2.95, y: 1.97 } } });
  await sleep(80);
  live.report({ missionId, status: "succeeded", result: { final: { x: 2.93, y: 1.96 }, travelled: 5.1 } });
  await sleep(200);
  await live.stop();
  mission = (await call(users.asha, "GET", `/robots/missions/${missionId}`)).body.mission;
  assert.equal(mission.status, "succeeded");
  assert.equal(mission.verification.confirmed, true);
  assert.match(mission.verification.evidence, /reports \(2\.93, 1\.96\), 0\.08 m from the goal \(3, 2\), standing still\. Simulator ground truth: 0\.06 m/);
  // The agent's follow-up question gets the verified result.
  const followUp = await act(users.ashaKey, "robots.mission", { mission: missionId });
  assert.match(followUp.body.record.response.summary, /finished and verified/);
  // A later report can't change a finished mission.
  await robot.sync({ reports: [{ missionId, status: "failed", reason: "late" }] });
  assert.equal((await call(users.asha, "GET", `/robots/missions/${missionId}`)).body.mission.status, "succeeded");
});

test("task verification: a success the robot's own state doesn't support is not called a success", async () => {
  const robot = users.rover;
  await levels(users.asha, 4);
  const grant = await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["robots.navigate_to"], resource: { type: "robot", match: robot.robotId }, note: "Rover may drive in the lab" });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const cases = [
    [state({ pose: { x: 1, y: 1, source: "odometry" } }), /2\.24 m from the goal \(3, 2\): further than the 0\.25 m allowed/],
    [state({ pose: { x: 3, y: 2, source: "odometry" }, velocity: { linear: 0.25, angular: 0 } }), /still moving at 0\.25 m\/s/],
    [state({ pose: { x: 3, y: 2, source: "odometry" }, sim: { truth: { x: 1.2, y: 0.4 } } }), /simulator's ground truth is 2\.41 m from the goal: the robot's position estimate has drifted/],
    [state({ pose: null }), /sent no position to check it against/],
  ];
  for (const [finalState, expected] of cases) {
    robot.state = state();
    const live = running(robot, accept);
    // Covered by the standing permission for this robot: no approval.
    const started = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
    assert.equal(started.body.record.status, "done", JSON.stringify(started.body.record));
    assert.equal(started.body.record.permission.code, "grant");
    const missionId = started.body.record.response.missionId;
    robot.state = finalState;
    await sleep(80);
    live.report({ missionId, status: "succeeded", result: {} });
    await sleep(200);
    await live.stop();
    const mission = (await call(users.asha, "GET", `/robots/missions/${missionId}`)).body.mission;
    assert.equal(mission.status, "unverified");
    assert.match(mission.verification.evidence, expected);
    assert.match(mission.summary, /reported success, but its state doesn't confirm it/);
  }
  // The grant names this robot only.
  const other = await enrolled(users.asha, "Tug");
  assert.equal((await act(users.asha, "robots.navigate_to", { robot: "Tug", place: "workbench" })).body.record.status, "waiting-approval");
  assert.equal((await call(users.asha, "DELETE", `/robots/${other.robotId}`)).status, 200);
  await call(users.asha, "DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
  await levels(users.asha, 3);
});

test("the robot's own checks have the last word: a command it refuses is a failure with its reason", async () => {
  const robot = users.rover;
  robot.state = state();
  const live = running(robot, (command) => [{ missionId: command.missionId, status: "rejected", reason: "Goal is inside a keep-out zone in the robot's local map." }]);
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "door" });
  const approved = await decide(users.asha, asked.body.record.id, true);
  await live.stop();
  assert.equal(approved.body.record.status, "failed");
  assert.match(approved.body.record.error, /Rover's own checks refused it\. Goal is inside a keep-out zone in the robot's local map\./);
  const [mission] = await missionsOf(users.asha, robot.robotId);
  assert.equal(mission.status, "rejected");
  assert.ok((await call(users.asha, "GET", `/robots/events?robot=${robot.robotId}`)).body.events.some((event) => event.type === "command-rejected" && event.source === "robot"));
});

test("safety state: an emergency stop, a fault or a dead battery refuses movement, also when it happens while approval waits", async () => {
  const robot = users.rover;
  robot.state = state({ estop: { engaged: true, source: "simulated-hardware" }, mode: "estopped" });
  await robot.sync();
  const stopped = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  assert.equal(stopped.body.record.status, "denied");
  assert.match(stopped.body.record.permission.reason, /emergency stop is engaged\. It has to be released at the robot/);
  robot.state = state({ faults: [{ code: "collision", message: "Bumper pressed" }], mode: "fault" });
  await robot.sync();
  assert.match((await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" })).body.record.permission.reason, /reports a fault: Bumper pressed/);
  robot.state = state({ battery: { percent: 6, charging: false } });
  await robot.sync();
  assert.match((await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" })).body.record.permission.reason, /battery is at 6%, below its 15% minimum/);

  // Fine when asked; the emergency stop is pressed before the person approves.
  robot.state = state();
  await robot.sync();
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  assert.equal(asked.body.record.status, "waiting-approval");
  robot.state = state({ estop: { engaged: true, source: "simulated-hardware" }, mode: "estopped" });
  const before = (await missionsOf(users.asha, robot.robotId)).length;
  const live = running(robot, accept);
  const approved = await decide(users.asha, asked.body.record.id, true);
  await live.stop();
  assert.equal(approved.body.record.status, "failed");
  assert.match(approved.body.record.error, /Not sent\. Rover's emergency stop is engaged/);
  assert.equal(live.received.length, 0);
  assert.equal((await missionsOf(users.asha, robot.robotId)).length, before);
  // The state the app shows says the same.
  const shown = await act(users.asha, "robots.state", { robot: "Rover" });
  assert.equal(shown.body.record.response.emergencyStop.engaged, true);
  assert.equal(shown.body.record.response.online, true);
});

test("command timeout: a command the robot doesn't accept in time expires and is never delivered later", async () => {
  const robot = await enrolled(users.asha, "Slowpoke", { described: descriptor({ limits: { ...descriptor().limits, commandTtlS: 2 } }) });
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Slowpoke", place: "workbench" });
  // The robot is connected but doesn't pick the command up.
  const approved = await decide(users.asha, asked.body.record.id, true);
  assert.equal(approved.body.record.status, "unverified");
  assert.match(approved.body.record.verification.evidence, /Slowpoke hasn't acknowledged mission .* the command expires and nothing runs/);
  await sleep(700);
  const [mission] = await missionsOf(users.asha, robot.robotId);
  assert.equal(mission.status, "expired");
  assert.match(mission.summary, /never started\. The robot didn't accept the command before it expired\. Nothing was run\./);
  assert.equal((await robot.sync()).commands.length, 0, "an expired command is not delivered");
  // A robot that reports on it anyway changes nothing.
  await robot.sync({ reports: [{ missionId: mission.id, status: "accepted" }, { missionId: mission.id, status: "succeeded", result: {} }] });
  assert.equal((await missionsOf(users.asha, robot.robotId))[0].status, "expired");

  // A mission the robot accepted and then ran out of time on.
  robot.state = state();
  const live = running(robot, accept);
  const again = await act(users.asha, "robots.navigate_to", { robot: "Slowpoke", place: "door" });
  const started = await decide(users.asha, again.body.record.id, true);
  assert.equal(started.body.record.status, "done");
  live.report({ missionId: started.body.record.response.missionId, status: "timed-out", reason: "No path to the goal within 180 seconds; stopped." });
  await sleep(200);
  await live.stop();
  const timedOut = (await call(users.asha, "GET", `/robots/missions/${started.body.record.response.missionId}`)).body.mission;
  assert.equal(timedOut.status, "timed-out");
  assert.match(timedOut.summary, /ran out of time\. No path to the goal/);

  // An accepted mission whose robot goes silent past its deadline: outcome unknown, said plainly.
  const live2 = running(robot, accept);
  const third = await act(users.asha, "robots.navigate_to", { robot: "Slowpoke", place: "dock" });
  const running3 = await decide(users.asha, third.body.record.id, true);
  await live2.stop();
  const later = createRoboticsService({ now: () => Date.now() + 15 * 60_000 });
  const lost = await later.getMission(db, users.ashaId, running3.body.record.response.missionId);
  assert.equal(lost.status, "lost");
  assert.match(lost.error, /stopped reporting\. Its outcome is unknown/);
  assert.equal((await later.getRobot(db, users.ashaId, robot.robotId)).connection, "offline");
  assert.equal((await call(users.asha, "DELETE", `/robots/${robot.robotId}`)).status, 200);
});

test("task cancellation: before delivery it never reaches the robot; afterwards the robot is told and confirms", async () => {
  const robot = users.rover;
  robot.state = state();
  await robot.sync();
  // Not yet delivered.
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  await decide(users.asha, asked.body.record.id, true);
  let [mission] = await missionsOf(users.asha, robot.robotId);
  assert.equal(mission.status, "queued");
  const dropped = await call(users.ashaKey, "POST", `/robots/missions/${mission.id}/cancel`);
  assert.equal(dropped.body.mission.status, "cancelled");
  assert.match(dropped.body.mission.error, /before it was sent to the robot/);
  assert.equal((await robot.sync()).commands.length, 0);

  // Running: the cancel is a signed command, and the mission is cancelled when the robot says so.
  const live = running(robot, (command) => (command.type === "cancel" ? [{ missionId: command.missionId, status: "cancelled", reason: "Cancelled by HANNAH; holding position." }] : accept(command)));
  const second = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  const started = await decide(users.asha, second.body.record.id, true);
  const missionId = started.body.record.response.missionId;
  const cancelling = await call(users.asha, "POST", `/robots/missions/${missionId}/cancel`);
  assert.equal(cancelling.body.mission.status, "accepted", "not cancelled until the robot confirms");
  assert.ok(cancelling.body.mission.cancelRequestedAt);
  await sleep(250);
  await live.stop();
  assert.deepEqual(live.received.map((command) => command.type), ["mission", "cancel"]);
  mission = (await call(users.asha, "GET", `/robots/missions/${missionId}`)).body.mission;
  assert.equal(mission.status, "cancelled");
  assert.match(mission.summary, /cancelled\. Cancelled by HANNAH; holding position\./);
});

test("stopping never needs approval: at read-only, during the emergency stop, by a key; and it is verified by measured speed", async () => {
  const robot = users.rover;
  robot.state = state();
  const stopper = (speed) => (command, self) => {
    if (command.type === "cancel") return [{ missionId: command.missionId, status: "cancelled", reason: "Stopped." }];
    if (command.capability !== "stop_motion") { self.state = state({ mode: "navigating", velocity: { linear: 0.4, angular: 0 } }); return accept(command); }
    self.state = state({ mode: "holding", velocity: { linear: speed, angular: 0 } });
    return [{ missionId: command.missionId, status: "accepted" }, { missionId: command.missionId, status: "succeeded", result: { stopped: true } }];
  };
  let live = running(robot, stopper(0));
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  const started = await decide(users.asha, asked.body.record.id, true);
  assert.equal(started.body.record.status, "done");
  // Read-only level, and an agent's key: the stop still runs at once.
  await levels(users.asha, 1);
  const stop = await act(users.ashaKey, "robots.stop_motion", { robot: "Rover", reason: "person in the aisle" });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.record.status, "done", JSON.stringify(stop.body.record));
  assert.equal(stop.body.record.permission.code, "deescalates");
  assert.match(stop.body.record.verification.evidence, /measured speed is 0 m\/s and it reports holding/);
  await sleep(150);
  assert.equal((await call(users.asha, "GET", `/robots/missions/${started.body.record.response.missionId}`)).body.mission.status, "cancelled");
  await live.stop();
  await levels(users.asha, 3);

  // The robot says it stopped while its measured speed says otherwise.
  robot.seen.clear();
  live = running(robot, stopper(0.3));
  const doubtful = await call(users.asha, "POST", `/robots/${robot.robotId}/stop`, { reason: "test" });
  await live.stop();
  assert.equal(doubtful.body.record.status, "unverified");
  assert.match(doubtful.body.mission.verification.evidence, /reported it stopped, but its measured speed is 0\.3 m\/s/);

  // The account's emergency stop reaches the robot, and stopping still works while it is on.
  live = running(robot, stopper(0));
  const emergency = await call(users.asha, "POST", "/actions/stop");
  assert.equal(emergency.body.stoppedRobots, 1);
  await sleep(250);
  assert.ok(live.received.some((command) => command.capability === "stop_motion"));
  assert.equal((await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" })).body.record.permission.code, "stopped");
  assert.equal((await act(users.asha, "robots.stop_motion", { robot: "Rover" })).body.record.status, "done");
  await live.stop();
  await call(users.asha, "POST", "/actions/resume");
});

test("robot disconnection: an offline robot is shown as offline, its state as stale, and it is never told to move", async () => {
  const robot = users.rover;
  robot.state = state({ pose: { x: 2, y: 1, source: "odometry" } });
  await robot.sync();
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot.connection, "online");
  // No report for a minute.
  await db.query("UPDATE hannah_robots SET last_seen_at = $1 WHERE id = $2", [Date.now() - 60_000, robot.robotId]);
  const view = (await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot;
  assert.equal(view.connection, "offline");
  assert.equal(view.mode, "offline");
  const read = await act(users.asha, "robots.state", { robot: "Rover" });
  assert.equal(read.body.record.response.stale, true);
  assert.match(read.body.record.response.note, /Not current: Rover is offline; this is its last report/);
  assert.match(read.body.record.verification.evidence, /last report, which is old/);
  assert.equal(read.body.record.response.pose.x, 2);
  const drive = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
  assert.equal(drive.body.record.status, "denied");
  assert.match(drive.body.record.permission.reason, /last reported 60 seconds ago; it is offline/);
  // A stop for an offline robot is recorded and not called delivered.
  const stop = await act(users.asha, "robots.stop_motion", { robot: "Rover" });
  assert.equal(stop.body.record.status, "unverified");
  assert.match(stop.body.record.verification.evidence, /offline, so the stop couldn't be delivered\. A robot that loses its link to HANNAH stops by itself within 5 seconds; HANNAH can't see whether it has/);
  // Back again: the stale stop has expired or is delivered once; the robot is online.
  assert.equal((await robot.sync()).status, 200);
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot.connection, "online");
  const sensor = await act(users.asha, "robots.read_sensor", { robot: "Rover", sensor: "lidar" });
  assert.deepEqual(sensor.body.record.response.reading, { ok: true, minRange: 1.2 });
  assert.equal((await act(users.asha, "robots.read_sensor", { robot: "Rover", sensor: "thermal" })).body.record.status, "failed");
});

test("a person can tighten a robot's limits, switch capabilities off, and the robot hears the tighter limit", async () => {
  const robot = users.rover;
  robot.seen.clear();
  robot.state = state();
  assert.equal((await call(users.ashaKey, "PATCH", `/robots/${robot.robotId}`, { limits: { maxLinearSpeed: 0.2 } })).status, 403);
  const changed = await call(users.asha, "PATCH", `/robots/${robot.robotId}`, { limits: { maxLinearSpeed: 0.2, maxAngularSpeed: 9, motionRequiresApproval: true }, disabled: ["inspect_area", "stop_motion"] });
  assert.equal(changed.body.robot.limits.maxLinearSpeed, 0.2);
  assert.equal(changed.body.robot.limits.maxAngularSpeed, 1.5, "a looser number than the robot's own changes nothing");
  assert.deepEqual(changed.body.robot.disabled, ["inspect_area"], "stopping can't be switched off");
  const patrol = await act(users.asha, "robots.inspect_area", { robot: "Rover", waypoints: [{ place: "door" }] });
  assert.match(patrol.body.record.permission.reason, /“Visit points and report” is switched off for Rover/);
  const fast = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "door", maxSpeed: 0.4 });
  assert.match(fast.body.record.permission.reason, /above Rover's limit of 0\.2 m\/s/);
  const live = running(robot, accept);
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "door" });
  assert.match(asked.body.record.permission.reason, /you set Rover to ask before every movement/);
  const started = await decide(users.asha, asked.body.record.id, true);
  assert.equal(started.body.record.status, "done");
  const sent = live.received.find((command) => command.capability === "navigate_to");
  assert.equal(sent.params.maxSpeed, 0.2);
  assert.equal(sent.limits.maxLinearSpeed, 0.2);
  await call(users.asha, "POST", `/robots/missions/${started.body.record.response.missionId}/cancel`);
  await live.stop();
  await call(users.asha, "PATCH", `/robots/${robot.robotId}`, { limits: {}, disabled: [] });
});

test("a physical robot doesn't move just because it enrolled; once commissioned, its movement always asks", async () => {
  const robot = await enrolled(users.asha, "Forklift", { simulated: false });
  const view = (await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot;
  assert.equal(view.simulated, false);
  assert.equal(view.simulator, null);
  assert.deepEqual([view.commissioning.required, view.commissioning.status, view.commissioning.done], [true, "required", 0]);
  await call(users.asha, "POST", `/robots/${robot.robotId}/destinations`, { fromPlace: "workbench" });
  const early = await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "workbench" });
  assert.equal(early.body.record.status, "denied");
  assert.match(early.body.record.permission.reason, /Forklift hasn't been commissioned: 0 of 7 checks are done\. Finish them under Robots → Commissioning before it may move\./);
  // The commissioning steps themselves are tested in robotics.stage2.test.js; here it is marked as done.
  const steps = Object.fromEntries(["identity", "inventory", "limits", "estop", "diagnostics", "trial", "approval"].map((id) => [id, { at: Date.now(), note: "test" }]));
  await db.query("UPDATE hannah_robots SET commissioning = $1 WHERE id = $2", [JSON.stringify({ startedAt: Date.now(), steps }), robot.robotId]);
  await levels(users.asha, 5);
  const grant = await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["*"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(grant.status, 201);
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Forklift", place: "workbench" });
  assert.equal(asked.body.record.status, "waiting-approval");
  assert.equal(asked.body.record.permission.code, "flagged");
  assert.match(asked.body.record.permission.reason, /this is a physical robot and it will move/);
  assert.ok(asked.body.record.preview.lines.some((line) => /PHYSICAL ROBOT/.test(line.value)));
  assert.match(asked.body.record.preview.warnings.join(" "), /software request to the robot\. Keep the robot's own emergency stop within reach/);
  assert.equal(asked.body.record.preview.lines.find((line) => line.label === "Risk").value, "high");
  await decide(users.asha, asked.body.record.id, false);
  await call(users.asha, "DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
  await levels(users.asha, 3);
  assert.equal((await call(users.asha, "DELETE", `/robots/${robot.robotId}`)).status, 200);
});

test("revoking ends a robot's access at once; a new code gives it a new secret", async () => {
  const robot = await enrolled(users.asha, "Temp");
  const oldSecret = robot.secret;
  assert.equal((await call(users.ashaKey, "POST", `/robots/${robot.robotId}/revoke`)).status, 403);
  const revoked = await call(users.asha, "POST", `/robots/${robot.robotId}/revoke`);
  assert.equal(revoked.body.robot.connection, "revoked");
  const refused = await robot.sync();
  assert.equal(refused.status, 401);
  assert.equal(refused.body.reason, "revoked");
  assert.match((await act(users.asha, "robots.navigate_to", { robot: "Temp", place: "workbench" })).body.record.permission.reason, /credentials were revoked/);
  // Enrolling again issues a different secret; the old one stays dead.
  const code = await call(users.asha, "POST", `/robots/${robot.robotId}/enrollment`);
  assert.equal(code.status, 201);
  const again = createRobotClient({ base });
  assert.equal((await again.enroll(code.body.enrollment.code)).status, 201);
  assert.notEqual(again.secret, oldSecret);
  assert.equal(again.robotId, robot.robotId);
  assert.equal((await again.sync()).status, 200);
  robot.counter = 50;
  assert.equal((await robot.sync()).status, 401, "the old secret no longer signs anything");
  assert.equal((await call(users.asha, "DELETE", `/robots/${robot.robotId}`)).status, 200);
  assert.equal((await again.sync()).status, 401);
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}`)).status, 404);
});

test("robots appear in the permission screen, the action catalog and the integrations list, with what isn't supported", async () => {
  const permissions = (await call(users.asha, "GET", "/account/permissions")).body;
  const service = permissions.services.find((item) => item.id === "robots");
  assert.equal(service.label, "Robots");
  assert.equal(service.level, 3);
  assert.ok(service.actions.some((action) => action.id === "robots.navigate_to"));
  const catalog = (await call(users.asha, "GET", "/actions/catalog")).body.actions.filter((action) => action.service === "robots");
  assert.deepEqual(catalog.map((action) => action.id).sort(), ["robots.assign", "robots.battery", "robots.cancel_mission", "robots.destinations", "robots.diagnostics", "robots.fleet", "robots.inspect_area", "robots.list", "robots.mission", "robots.navigate_to", "robots.pause_mission", "robots.read_sensor", "robots.resume_mission", "robots.return_to_dock", "robots.set_supported_device_state", "robots.state", "robots.stop_motion", "robots.surroundings"]);
  const list = await act(users.ashaKey, "robots.list", {});
  assert.deepEqual(list.body.record.response.robots.map((robot) => [robot.name, robot.kind]), [["Rover", "simulation"]]);
  assert.deepEqual(list.body.record.response.robots[0].places, ["dock", "workbench", "door"]);
  const hub = (await call(users.asha, "GET", "/account/integrations")).body.integrations.find((item) => item.id === "robots");
  assert.equal(hub.connected, true);
  assert.ok(hub.unsupported.some((line) => /Gazebo and Nav2: the integration is written and has not been run/.test(line)));
  assert.ok(hub.unsupported.some((line) => /An emergency stop: HANNAH's stop is a software request/.test(line)));
  // The audit history has the robot actions, with who asked.
  const history = (await call(users.asha, "GET", "/actions?service=robots&limit=100")).body.actions;
  assert.ok(history.some((record) => record.action === "robots.stop_motion" && record.source === "api-key"));
  assert.ok(history.some((record) => record.action === "robots.navigate_to" && record.status === "declined"));
});

test("guessing enrollment codes is limited per network address", async () => {
  const robot = createRobotClient({ base });
  let status = 0;
  for (let attempt = 0; attempt < 44 && status !== 429; attempt += 1) status = (await robot.enroll("ZZZZZ-ZZZZZ")).status;
  assert.equal(status, 429);
});
