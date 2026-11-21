"use strict";

// Fleet selection and diagnostics. The first tests are unit tests of pure
// functions; the rest are integration tests on the real server with scripted
// stand-in robots. No simulator and no physical robot is involved.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robotics-fleet-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "1200";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
delete process.env.VERCEL;

const fleet = require("./robotics/fleet");
const { createRobotClient, state } = require("./test-fixtures/robot-client");

const unit = (name, change = {}) => ({
  id: `rb_${name}`, name, status: "enrolled", simulated: true, online: true, lastSeenAt: Date.now(), connection: "online", mode: "idle", mapName: "bench", robotType: "differential-drive",
  capabilities: ["navigate_to", "return_to_dock", "inspect_area", "stop_motion"], disabled: [], limits: { minBatteryPercent: 15 }, commissioning: { required: false, status: "not-required" },
  places: { workbench: { x: 3, y: 2 }, dock: { x: -4, y: -3 } }, dock: { x: -4, y: -3 }, sensors: [{ id: "lidar", type: "2d-lidar" }], configVersion: 1,
  state: state({ pose: { x: 0, y: 0 } }), ...change,
});

test("unit: the nearest robot that can take the task is chosen, and every other robot comes back with its reason", () => {
  const robots = [
    unit("Far", { state: state({ pose: { x: -4, y: -3 } }) }),
    unit("Near", { state: state({ pose: { x: 2.5, y: 1.5 } }) }),
    unit("Offline", { online: false, connection: "offline" }),
    unit("Stopped", { state: state({ estop: { engaged: true } }) }),
    unit("Flat", { state: state({ battery: { percent: 9 } }) }),
    unit("Blind", { state: state({ sensors: { lidar: { ok: false }, odometry: { ok: true } } }) }),
    unit("Lost", { state: state({ localized: false }) }),
    unit("Elsewhere", { places: { kitchen: { x: 1, y: 1 } } }),
    unit("Arm", { capabilities: ["stop_motion"] }),
    unit("New", { simulated: false, commissioning: { required: true, status: "in-progress", done: 2, total: 7 } }),
    unit("Busy"),
  ];
  const result = fleet.choose({ robots, task: { capability: "navigate_to", place: "Workbench" }, active: [{ robotId: "rb_Busy", capability: "navigate_to", params: { x: -3, y: -3 }, status: "accepted" }] });
  assert.equal(result.chosen.name, "Near");
  assert.equal(result.chosen.why, "the nearest of 2 that can take it (0.71 m away)");
  assert.deepEqual(Object.fromEntries(result.considered.filter((entry) => !entry.eligible).map((entry) => [entry.name, entry.reason])), {
    Offline: "offline", Stopped: "emergency stop engaged", Flat: "battery 9%, below its 15% minimum", Blind: "lidar sensor not reporting", Lost: "not localized",
    Elsewhere: "has no destination called “Workbench”", Arm: "doesn't offer “Drive to a place”", New: "not commissioned", Busy: "busy: Drive to a place",
  });
  // A low battery doesn't stop a robot from being sent home.
  assert.equal(fleet.choose({ robots: [unit("Flat", { state: state({ battery: { percent: 9 } }) })], task: { capability: "return_to_dock" } }).chosen.name, "Flat");
  // Asked for by name, only that robot is considered.
  assert.equal(fleet.choose({ robots, task: { capability: "navigate_to", place: "workbench" }, only: "far" }).chosen.name, "Far");
  // Equal distance: the fuller battery, then the name.
  const pair = [unit("B", { state: state({ battery: { percent: 50 } }) }), unit("A", { state: state({ battery: { percent: 90 } }) })];
  assert.equal(fleet.choose({ robots: pair, task: { capability: "navigate_to", x: 1, y: 1 } }).chosen.name, "A");
  // Something that isn't a movement task isn't assigned at all.
  assert.match(fleet.choose({ robots, task: { capability: "grasp_object" } }).problem, /isn't a task a robot can be assigned/);
  assert.equal(fleet.choose({ robots: [], task: { capability: "navigate_to", x: 1, y: 1 } }).chosen, null);
});

test("unit: two robots on the same map aren't sent to the same spot; on different maps the same coordinates are different places", () => {
  const robots = [unit("One"), unit("Two")];
  const heading = [{ robotId: "rb_One", capability: "navigate_to", params: { x: 3, y: 2 }, status: "accepted" }];
  const clash = fleet.choose({ robots, task: { capability: "navigate_to", place: "workbench" }, active: heading });
  assert.equal(clash.chosen, null);
  assert.equal(clash.conflict, true);
  assert.equal(clash.considered.find((entry) => entry.name === "Two").reason, "One is already heading to that spot");
  // Far enough from where the other is going.
  assert.equal(fleet.choose({ robots, task: { capability: "navigate_to", x: 3, y: 0.5 }, active: heading }).chosen.name, "Two");
  const elsewhere = [unit("One"), unit("Two", { mapName: "warehouse" })];
  assert.equal(fleet.choose({ robots: elsewhere, task: { capability: "navigate_to", place: "workbench" }, active: heading }).chosen.name, "Two");
});

test("unit: a diagnosis is made of findings with their evidence, and says what it is based on", () => {
  const now = Date.now();
  const sick = unit("Sick", {
    state: state({ battery: { percent: 8, charging: false }, sensors: { lidar: { ok: false, problem: "not reporting" } }, faults: [{ code: "motor-driver", message: "Left motor driver over-temperature" }], sim: { odometryError: 0.62 } }),
    sensors: [{ id: "lidar", type: "2d-lidar" }, { id: "imu", type: "imu" }], runtimeVersion: "0.1.0", adapter: "kinematic", softwareVersion: "0.2.0", firmwareVersion: "none",
  });
  const report = fleet.diagnose(sick, {
    now, events: [...Array.from({ length: 3 }, () => ({ type: "link-lost", at: now - 3600_000 })), { type: "command-rejected", at: now - 60_000 }, { type: "link-lost", at: now - 3 * 86_400_000 }],
    missions: [{ final: true, status: "failed" }, { final: true, status: "timed-out" }, { final: true, status: "succeeded" }],
    maintenance: [{ at: now - 86_400_000, kind: "replacement", note: "Left drive wheel replaced." }],
  });
  assert.equal(report.summary, "needs attention now");
  const titles = Object.fromEntries(report.findings.map((item) => [item.title, item]));
  assert.match(titles["Active fault"].evidence, /motor-driver: Left motor driver over-temperature/);
  assert.match(titles["Sensor not reporting: lidar"].recommendation, /won't be moved until it reports again/);
  assert.match(titles["No reading from imu"].evidence, /registered imu \(imu\) and its report carries no reading/);
  assert.match(titles["Battery below the minimum for a mission"].evidence, /^8%; minimum to start 15%\.$/);
  assert.match(titles["Link to HANNAH lost"].evidence, /^3 times in the last 24 hours/);
  assert.match(titles["Missions not finishing"].evidence, /2 of the last 3 finished missions/);
  assert.match(titles["Position estimate has drifted"].evidence, /0\.62 m from where the robot believes it is/);
  assert.match(titles["Last maintenance entry"].evidence, /replacement: Left drive wheel replaced\./);
  assert.match(report.basis, /No model was asked to judge its condition/);
  assert.ok(report.findings.every((item) => item.evidence));
  const healthy = fleet.diagnose(unit("Fine", { runtimeVersion: "0.1.0" }), { now });
  assert.equal(healthy.summary, "no problem found in what it reports");
  assert.deepEqual(healthy.findings.map((item) => item.severity), ["info", "info"]);
  // Offline: said first, and the rest is marked as coming from the last report.
  const gone = fleet.diagnose(unit("Gone", { online: false, lastSeenAt: now - 90_000 }), { now });
  assert.deepEqual([gone.stale, gone.findings[0].title], [true, "Offline"]);
  assert.match(gone.findings[0].evidence, /Last report 90 s ago\. Everything below is from that report\./);
});

// ---------- integration ----------
let server;
let base;
const users = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const act = (who, action, params) => call(who, "POST", "/actions", { action, params, request: "test request", agent: "Fleet agent" });
async function enrolled(name, pose) {
  const created = await call(users.asha, "POST", "/robots", { name, simulated: true });
  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll(created.body.enrollment.code)).status, 201);
  robot.state = state({ pose: { ...pose, source: "odometry" } });
  assert.equal((await robot.sync()).status, 200);
  return robot;
}
/** Keep a stand-in robot connected, accepting whatever it is sent. */
function alive(robot) {
  let on = true;
  const reports = [];
  const received = [];
  const loop = (async () => {
    while (on) {
      const out = await robot.sync({ reports: reports.splice(0), send: { ...robot.state, at: Date.now() } });
      for (const command of out.commands || []) {
        if (robot.seen.has(command.missionId + command.type)) continue;
        robot.seen.set(command.missionId + command.type, command);
        received.push(command);
        reports.push({ missionId: command.missionId, status: command.type === "cancel" ? "cancelled" : "accepted" });
      }
      await sleep(80);
    }
  })();
  return { received, report: (...items) => reports.push(...items), stop: async () => { on = false; await loop; } };
}

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "asha@fleet.example", password: "correct horse battery staple" }) });
  users.asha = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.key = { Authorization: `Bearer ${key.body.key}` };
});
after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("unit: fleet figures come from records, say how many, and are empty rather than zero when there are none", () => {
  const now = 1_800_000_000_000;
  const hour = 3_600_000;
  const robots = [unit("Ada"), unit("Bo", { simulated: false, online: false })];
  const m = (robotId, capability, status, createdAgo, acceptAfter, runFor, final = true) => ({ robotId, capability, status, final, createdAt: now - createdAgo, acceptedAt: acceptAfter === null ? null : now - createdAgo + acceptAfter, finishedAt: runFor === null ? null : now - createdAgo + (acceptAfter || 0) + runFor });
  const missions = [
    m("rb_Ada", "navigate_to", "succeeded", 5 * hour, 900, 60_000),
    m("rb_Ada", "navigate_to", "succeeded", 4 * hour, 1100, 120_000),
    m("rb_Ada", "navigate_to", "failed", 3 * hour, 1300, 30_000),
    m("rb_Ada", "navigate_to", "expired", 2 * hour, null, 20_000),
    m("rb_Ada", "navigate_to", "accepted", hour / 2, 1000, null, false),
    m("rb_Ada", "stop_motion", "succeeded", 3 * hour, 400, 500),
  ];
  const figures = fleet.analytics({ robots, missions, plans: [{ robotId: "rb_Ada", status: "succeeded", final: true }, { robotId: "rb_Ada", status: "failed", final: true }, { robotId: "rb_Ada", status: "running", final: false }], events: [{ robotId: "rb_Ada", type: "fault", count: 2 }, { robotId: "rb_Ada", type: "enrolled", count: 1 }], telemetry: { rb_Ada: { samples: 1200, everyMs: 3000, first: { at: now - 2 * hour, battery: 90 }, last: { at: now, battery: 70 } } }, now, windowMs: 24 * hour });
  const ada = figures.robots[0];
  // The stop is a control, not a task: it isn't in the mission figures, and it has its own latency.
  assert.deepEqual(ada.missions, { started: 5, ended: 4, open: 1, byOutcome: { succeeded: 2, failed: 1, expired: 1 }, succeededVerified: 2, successRate: 0.5 });
  assert.deepEqual(ada.durationS, { samples: 2, median: 90, longest: 120 });
  assert.deepEqual(ada.commandLatencyMs, { samples: 4, median: 1050, p95: 1300 });
  assert.deepEqual(ada.stopLatencyMs, { samples: 1, median: 900, longest: 900 });
  assert.deepEqual(ada.plans, { ended: 2, succeeded: 1 });
  assert.deepEqual(ada.problems, { fault: 2 });
  // Busy: 60 s + 120 s + 30 s finished, plus the open one from its acceptance until now.
  assert.equal(ada.utilization, Number(((60_000 + 120_000 + 30_000 + (hour / 2 - 1000)) / (24 * hour)).toFixed(4)));
  assert.deepEqual(ada.battery, { fromPercent: 90, toPercent: 70, overMinutes: 120, changePerHour: -10 });
  assert.deepEqual(ada.reporting, { samples: 1200, shareOfLastTwoHours: 0.5 });
  // A robot with no records has no figures. Not zero, not a hundred per cent.
  const bo = figures.robots[1];
  assert.equal(bo.kind, "physical");
  assert.deepEqual([bo.missions.successRate, bo.durationS.median, bo.commandLatencyMs.median, bo.utilization, bo.battery], [null, null, null, null, null]);
  assert.deepEqual(bo.reporting, { samples: 0, shareOfLastTwoHours: 0 });
  assert.deepEqual([figures.fleet.robots, figures.fleet.simulated, figures.fleet.physical, figures.fleet.onlineNow, figures.fleet.missions.ended], [2, 1, 1, 1, 4]);
  assert.ok(figures.notes.some((note) => /Simulated robots are included and labelled/.test(note)));
  assert.deepEqual(fleet.analytics({ robots: [], now, windowMs: hour }).fleet.missions, { started: 0, ended: 0, open: 0, byOutcome: {}, succeededVerified: 0, successRate: null });
});

test("assigning a task chooses a robot, shows why, and still goes through approval; a busy robot isn't chosen and a clash is refused", async () => {
  assert.equal((await act(users.asha, "robots.assign", { task: "navigate_to", place: "workbench" })).status, 409, "no robots yet");
  const near = await enrolled("Near", { x: 2, y: 1.5 });
  const far = await enrolled("Far", { x: -4, y: -3 });
  const lives = [alive(near), alive(far)];
  const overview = (await act(users.key, "robots.fleet", {})).body.record.response;
  assert.deepEqual(overview.available, ["Near", "Far"]);
  assert.deepEqual(overview.robots.map((row) => [row.name, row.kind, row.health, row.map, row.position.x]), [["Near", "simulation", "ok", "bench", 2], ["Far", "simulation", "ok", "bench", -4]]);

  // An agent asks; HANNAH picks the nearer robot; a person approves that robot, by name.
  const asked = await act(users.key, "robots.assign", { task: "navigate_to", place: "workbench" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const record = asked.body.record;
  assert.equal(record.status, "waiting-approval");
  assert.equal(record.preview.title, "Start a mission: Near drives to workbench (3, 2)");
  assert.deepEqual(record.preview.lines.slice(0, 2), [{ label: "Chosen", value: "Near: the nearest of 2 that can take it (1.12 m away)" }, { label: "Not chosen", value: "Far (8.6 m away)" }]);
  assert.deepEqual(record.resource, { type: "robot", id: near.robotId });
  const started = await call(users.asha, "POST", `/actions/${record.id}/decision`, { approve: true });
  assert.equal(started.body.record.status, "done", JSON.stringify(started.body.record));
  assert.equal(started.body.record.response.chosen.name, "Near");
  assert.equal(lives[0].received[0].capability, "navigate_to");
  assert.equal(lives[1].received.length, 0);

  // Near is busy now: the next task goes to Far, unless it would send Far to the same spot.
  const clash = await act(users.asha, "robots.assign", { task: "navigate_to", place: "workbench" });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.reason, "conflict");
  assert.match(clash.body.error, /Near: busy: Drive to a place; Far: Near is already heading to that spot/);
  const next = await act(users.asha, "robots.assign", { task: "navigate_to", place: "door" });
  assert.equal(next.body.record.preview.lines[0].value, "Far: the only robot that can take it now");
  assert.match(next.body.record.preview.lines[1].value, /Near \(busy: Drive to a place\)/);
  await call(users.asha, "POST", `/actions/${next.body.record.id}/decision`, { approve: false });
  const busy = (await act(users.asha, "robots.fleet", {})).body.record.response;
  assert.deepEqual(busy.available, ["Far"]);
  assert.equal(busy.robots[0].mission.what, "Drive to a place");

  // A robot that drops out between the choice and the approval is not replaced behind the person's back.
  const held = await act(users.asha, "robots.assign", { task: "return_to_dock" });
  assert.equal(held.body.record.preview.lines[0].value, "Far: the only robot that can take it now");
  await lives[1].stop();
  far.state = state({ estop: { engaged: true }, mode: "estopped" });
  await far.sync();
  const refused = await call(users.asha, "POST", `/actions/${held.body.record.id}/decision`, { approve: true });
  assert.equal(refused.body.record.status, "failed");
  assert.match(refused.body.record.error, /Not sent\. Far's emergency stop is engaged/);
  const none = await act(users.asha, "robots.assign", { task: "navigate_to", place: "door" });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /No robot can take that now\. Near: busy: Drive to a place; Far: emergency stop engaged\./);
  assert.equal((await act(users.asha, "robots.assign", { task: "grasp_object" })).status, 400);
  await lives[0].stop();

  // Diagnostics for the stopped robot, from what it reported.
  const diagnosis = (await act(users.key, "robots.diagnostics", { robot: "Far" })).body.record.response;
  assert.equal(diagnosis.summary, "needs attention now");
  assert.ok(diagnosis.findings.some((item) => item.title === "Emergency stop engaged" && /released at the robot/.test(item.recommendation)));
  const viaRoute = (await call(users.asha, "GET", `/robots/${far.robotId}/diagnostics`)).body.diagnostics;
  assert.equal(viaRoute.findings.find((item) => item.title === "Software").severity, "info");
  assert.equal((await call(users.asha, "GET", "/robots/fleet")).body.robots.find((row) => row.name === "Far").health, "attention");
});

test("a task that didn't finish is handed to another robot only when asked, checked afresh and approved by name", async () => {
  const ann = await enrolled("Ann", { x: 2, y: -1 });
  const ben = await enrolled("Ben", { x: -3, y: 2 });
  const lives = [alive(ann), alive(ben)];
  test.after(() => Promise.all(lives.map((live) => live.stop())));
  const asked = await act(users.asha, "robots.assign", { task: "navigate_to", place: "door" });
  assert.equal(asked.body.record.preview.lines[0].value.split(":")[0], "Ann");
  const started = await call(users.asha, "POST", `/actions/${asked.body.record.id}/decision`, { approve: true });
  const missionId = started.body.record.response.missionId;
  // Still running: it can't be handed on.
  const early = await act(users.key, "robots.reassign", { mission: missionId });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /still under way/);
  // Ann reports that she couldn't get there. Nothing is given to Ben by itself.
  lives[0].report({ missionId, status: "failed", reason: "Blocked: no way round the pallet." });
  await sleep(400);
  assert.equal(lives[1].received.length, 0, "no automatic reassignment");
  // An agent asks for it. The other robot is chosen as for any new task, and a person approves that robot.
  const handed = await act(users.key, "robots.reassign", { robot: "Ann" });
  assert.equal(handed.status, 202, JSON.stringify(handed.body));
  const record = handed.body.record;
  assert.equal(record.status, "waiting-approval");
  assert.equal(record.preview.title, "Start a mission: Ben drives to door (4.5, 0)");
  assert.deepEqual(record.preview.lines[0], { label: "Instead of", value: "Ann, whose mission ended as failed: Blocked: no way round the pallet." });
  assert.match(record.preview.lines[1].value, /^Ben: /);
  assert.deepEqual(record.resource, { type: "robot", id: ben.robotId });
  // Ann herself is never the answer to "another robot".
  assert.equal((await act(users.asha, "robots.reassign", { mission: missionId, among: "Ann" })).status, 409);
  const done = await call(users.asha, "POST", `/actions/${record.id}/decision`, { approve: true });
  assert.equal(done.body.record.status, "done", JSON.stringify(done.body.record));
  assert.equal(done.body.record.response.reassignedFrom.mission, missionId);
  const sent = lives[1].received.find((command) => command.type === "mission");
  assert.deepEqual([sent.capability, sent.params.x, sent.params.y], ["navigate_to", 4.5, 0]);
  // Ben arrives; a mission that succeeded has nothing to hand on.
  ben.state = state({ pose: { x: 4.5, y: 0, yaw: 0, frame: "map", source: "odometry" } });
  lives[1].report({ missionId: sent.missionId, status: "succeeded" });
  await sleep(400);
  const finished = await act(users.asha, "robots.reassign", { mission: sent.missionId });
  assert.equal(finished.status, 409);
  assert.match(finished.body.error, /succeeded; there is nothing to hand on/);
  await Promise.all(lives.map((live) => live.stop()));
});
