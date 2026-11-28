"use strict";

// Integration tests for the Safety and Autonomy Manager and teleoperation:
// the real server and database, with a stand-in robot that speaks the robot
// protocol (test-fixtures/robot-client.js) and confirms modes and manual
// control the way the runtime does. Nothing here is a simulation or a
// physical robot; robotics/runtime's own tests run the real runtime.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robot-autonomy-test-token-0123456789-abcdefghij";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
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
const missionCount = async (robotId) => Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_missions WHERE robot_id = $1 AND capability <> 'stop_motion'", [robotId])).rows[0].n);

async function enrolled(who, name, { simulated = true } = {}) {
  const created = await call(who, "POST", "/robots", { name, simulated });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  const answer = await robot.enroll(created.body.enrollment.code, descriptor(simulated ? {} : { simulation: null, limits: { ...descriptor().limits, environment: "enclosed-no-people", estop: { hardware: true, description: "red button" } } }));
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  robot.state = state();
  assert.equal((await robot.sync()).status, 200);
  return robot;
}

/**
 * The stand-in robot as the runtime behaves: takes each mode (reporting the
 * mode, its number and the manual-control session), applies each manual
 * command (reporting it), accepts missions. Returns what it heard.
 */
function operate(robot, { refuseModes = false } = {}) {
  let on = true;
  const heard = [];
  const reports = [];
  let interval = null;
  const loop = (async () => {
    while (on) {
      const out = await robot.sync({ reports: reports.splice(0), send: { ...robot.state, at: Date.now() } });
      interval = out.body?.intervalMs ?? interval;
      for (const command of out.commands || []) {
        heard.push(command);
        if (command.type === "mode") {
          if (refuseModes) robot.state.operatingMode = { mode: "mission", seq: 0, ...(robot.state.operatingMode || {}), refusedSeq: command.modeSeq, refusedReason: "refused by the test robot" };
          else robot.state.operatingMode = { mode: command.mode, seq: command.modeSeq, session: command.teleop?.session || null };
        } else if (command.type === "teleop") robot.state.teleop = { session: command.session, seq: command.seq, linear: command.linear, angular: command.angular, appliedAt: Date.now() };
        else if (command.type === "mission" && !robot.seen.has(command.missionId)) { robot.seen.set(command.missionId, command); reports.push({ missionId: command.missionId, status: command.capability === "stop_motion" ? "succeeded" : "accepted", at: Date.now() }); }
        else if (command.type === "cancel" && !robot.seen.has(`cancel:${command.missionId}`)) { robot.seen.set(`cancel:${command.missionId}`, command); reports.push({ missionId: command.missionId, status: "cancelled", reason: "Cancelled by HANNAH; holding position.", at: Date.now() }); }
      }
      await sleep(25);
    }
  })();
  return { heard, interval: () => interval, stop: async () => { on = false; await loop; } };
}
async function until(read, done, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 500)}`);
    await sleep(40);
  }
}
const autonomyOf = async (who, robotId) => (await call(who, "GET", `/robots/${robotId}/autonomy`)).body.autonomy;
const setMode = (who, robotId, mode, reason) => call(who, "POST", `/robots/${robotId}/mode`, { mode, reason });

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["asha", "bo"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@autonomy.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@autonomy.example`])).rows[0].id;
  }
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.ashaKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("migration 34 is applied: modes, policies, the safety audit and teleoperation sessions exist", async () => {
  const { MIGRATIONS } = require("./db/migrations");
  const migration = MIGRATIONS.find((item) => item.version === 34);
  assert.ok(migration);
  assert.match(migration.name, /operating modes/);
  assert.equal(new Set(MIGRATIONS.map((item) => item.version)).size, MIGRATIONS.length);
  assert.ok((await db.query("SELECT version FROM hannah_migrations WHERE version = 34")).rows[0]);
  for (const table of ["hannah_robot_autonomy_policies", "hannah_robot_safety_audit", "hannah_robot_teleop_sessions"]) await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  await db.query("SELECT operating_mode, mode_seq, mode_changed_at FROM hannah_robots LIMIT 1");
});

test("operating modes: the transition table is enforced, the robot confirms each mode, and a command the mode doesn't allow is refused at its step", async () => {
  const robot = await enrolled(users.asha, "Rover");
  const id = robot.robotId;
  const live = operate(robot);
  try {
    let view = await autonomyOf(users.asha, id);
    assert.equal(view.mode, "mission", "a simulated robot starts in Mission Autonomy");
    assert.equal(view.confirmed, true);
    assert.match(view.disclaimer, /not a certified safety function/);
    assert.deepEqual(view.modes.find((mode) => mode.id === "safety_stop").next, ["manual", "maintenance"]);

    // A developer key can put a robot in Safety Stop, nothing else.
    assert.equal((await setMode(users.ashaKey, id, "manual")).status, 403);
    // Not straight from Mission Autonomy to Maintenance.
    const skip = await setMode(users.asha, id, "maintenance");
    assert.equal(skip.status, 409);
    assert.equal(skip.body.reason, "transition-not-allowed");

    assert.equal((await setMode(users.asha, id, "manual", "testing")).status, 200);
    view = await until(() => autonomyOf(users.asha, id), (item) => item.confirmed, "the robot to confirm Manual");
    assert.equal(view.reported.mode, "manual");
    const modeCommand = live.heard.find((command) => command.type === "mode" && command.mode === "manual");
    assert.ok(modeCommand && modeCommand.modeSeq > 0, "the mode reached the robot as a signed command");

    // In Manual, no mission passes: refused at the operating-mode step, never shown for approval, nothing queued.
    const before = await missionCount(id);
    const refused = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
    assert.equal(refused.body.record.status, "denied");
    assert.match(refused.body.record.permission.reason, /Manual mode/);
    assert.equal(await missionCount(id), before);
    // Reading and stopping still work.
    assert.equal((await act(users.asha, "robots.state", { robot: "Rover" })).body.record.status, "done");

    // Manual → Mission Autonomy isn't in the table; Manual → Supervised is, once the robot is still and confirmed.
    assert.equal((await setMode(users.asha, id, "mission")).body.reason, "transition-not-allowed");
    robot.state = { ...robot.state, velocity: { linear: 0.3, angular: 0 } };
    await sleep(120);
    const moving = await setMode(users.asha, id, "supervised");
    assert.equal(moving.status, 409);
    assert.equal(moving.body.reason, "moving");
    robot.state = { ...robot.state, velocity: { linear: 0, angular: 0 } };
    await sleep(120);
    assert.equal((await setMode(users.asha, id, "supervised")).status, 200);
    await until(() => autonomyOf(users.asha, id), (item) => item.confirmed && item.reported?.mode === "supervised", "Supervised to be confirmed");
    // Supervised: every movement asks, even with a standing permission; a plan is refused.
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 4 } });
    const grant = await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["robots.navigate_to", "robots.run_plan"], note: "lab" });
    const asked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
    assert.equal(asked.body.record.status, "waiting-approval");
    assert.match(asked.body.record.permission.reason, /Supervised Autonomy: every movement is approved by a person/);
    await call(users.asha, "POST", `/actions/${asked.body.record.id}/decision`, { approve: false });
    const plan = await call(users.asha, "POST", `/robots/${id}/plans`, { steps: [{ do: "navigate_to", place: "workbench" }, { do: "navigate_to", place: "door" }] });
    assert.equal(plan.body.record.status, "denied");
    assert.match(plan.body.record.permission.reason, /plans of several steps run only in Mission Autonomy/);
    await call(users.asha, "DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 3 } });

    // Safety Stop through the existing stop: every mission ends and a signed stop goes to the robot.
    const stopped = await setMode(users.ashaKey, id, "safety_stop", "test");
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.ok((await db.query("SELECT id FROM hannah_robot_missions WHERE robot_id = $1 AND capability = 'stop_motion'", [id])).rows.length >= 1);
    const blocked = await act(users.asha, "robots.navigate_to", { robot: "Rover", place: "workbench" });
    assert.match(blocked.body.record.permission.reason, /Safety Stop/);
    // Out of it only with the emergency stop released, and only to Manual or Maintenance.
    robot.state = { ...robot.state, estop: { engaged: true } };
    await sleep(120);
    assert.equal((await setMode(users.asha, id, "manual")).body.reason, "estop-engaged");
    assert.equal((await setMode(users.asha, id, "supervised")).body.reason, "transition-not-allowed");
    robot.state = { ...robot.state, estop: { engaged: false } };
    await sleep(120);
    assert.equal((await setMode(users.asha, id, "maintenance")).status, 200);
    // Maintenance: no missions, a device may be switched.
    assert.match((await act(users.asha, "robots.return_to_dock", { robot: "Rover" })).body.record.permission.reason, /Maintenance mode/);

    // Every change is in the safety audit, with who made it.
    const audit = (await call(users.asha, "GET", `/robots/safety-audit?robot=${id}`)).body.audit;
    const modes = audit.filter((entry) => entry.kind === "mode").map((entry) => entry.summary);
    assert.ok(modes.some((line) => /Mission Autonomy → Manual: testing/.test(line)));
    assert.ok(modes.some((line) => /→ Safety Stop/.test(line)));
    assert.ok(audit.every((entry) => entry.actor));
    await setMode(users.asha, id, "manual");
    await until(() => autonomyOf(users.asha, id), (item) => item.confirmed, "Manual");
    await setMode(users.asha, id, "supervised");
    await until(() => autonomyOf(users.asha, id), (item) => item.confirmed, "Supervised");
    await setMode(users.asha, id, "mission");
    await until(() => autonomyOf(users.asha, id), (item) => item.confirmed, "Mission");
  } finally { await live.stop(); }
});

test("a mode the robot refuses is shown as refused and isn't taken as in force by the robot", async () => {
  const robot = await enrolled(users.asha, "Stubborn");
  const live = operate(robot, { refuseModes: true });
  try {
    assert.equal((await setMode(users.asha, robot.robotId, "manual")).status, 200);
    const view = await until(() => autonomyOf(users.asha, robot.robotId), (item) => item.reported?.refusedSeq, "the refusal");
    assert.equal(view.confirmed, false);
    const sent = live.heard.filter((command) => command.type === "mode").length;
    await sleep(200);
    assert.equal(live.heard.filter((command) => command.type === "mode").length, sent, "a refused mode isn't repeated");
  } finally { await live.stop(); await call(users.asha, "DELETE", `/robots/${robot.robotId}`); }
});

test("safety profiles: checked against the robot's own limits, applied by the chain and sent to the robot, every change audited", async () => {
  const robot = await enrolled(users.asha, "Scout");
  const id = robot.robotId;
  const live = operate(robot);
  try {
    assert.equal((await call(users.ashaKey, "PUT", `/robots/${id}/safety-profile`, { profile: { maxLinearSpeed: 0.2 } })).status, 403, "a developer key can't change safety configuration");
    const loose = await call(users.asha, "PUT", `/robots/${id}/safety-profile`, { profile: { maxLinearSpeed: 2, commsTimeoutS: 60 } });
    assert.equal(loose.status, 400);
    assert.equal(loose.body.reason, "bad-profile");
    assert.equal(loose.body.problems.length, 2);
    const saved = await call(users.asha, "PUT", `/robots/${id}/safety-profile`, { profile: { maxLinearSpeed: 0.3, commsTimeoutS: 3, operatingArea: { name: "bench", polygon: [[-5, -4], [2, -4], [2, 4], [-5, 4]] }, restrictedDestinations: ["door"] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.autonomy.limits.maxLinearSpeed, 0.3);
    assert.equal(saved.body.autonomy.limits.linkTimeoutS, 3);
    // Outside the operating area, and a restricted destination: refused at the safety-policy step.
    const far = await act(users.asha, "robots.navigate_to", { robot: "Scout", x: 3, y: 0 });
    assert.equal(far.body.record.status, "denied");
    assert.match(far.body.record.permission.reason, /outside Scout's bench/);
    const door = await act(users.asha, "robots.navigate_to", { robot: "Scout", place: "door" });
    assert.match(door.body.record.permission.reason, /restricted destination/);
    // Inside: asks as usual, and the robot hears the tighter limits and the area.
    const ok = await act(users.asha, "robots.navigate_to", { robot: "Scout", place: "workbench", maxSpeed: 0.25 });
    assert.equal(ok.body.record.status, "denied", "workbench (3, 2) is outside the bench area");
    const inside = await act(users.asha, "robots.navigate_to", { robot: "Scout", x: 1, y: 1 });
    assert.equal(inside.body.record.status, "waiting-approval");
    const approved = await call(users.asha, "POST", `/actions/${inside.body.record.id}/decision`, { approve: true });
    assert.equal(approved.body.record.status, "done", JSON.stringify(approved.body.record));
    const sent = live.heard.find((command) => command.type === "mission" && command.capability === "navigate_to");
    assert.equal(sent.limits.maxLinearSpeed, 0.3);
    assert.equal(sent.limits.linkTimeoutS, 3);
    assert.equal(sent.mode, "mission");
    assert.equal(sent.origin, "agent");
    assert.deepEqual(sent.areas.keepIn[0].name, "bench");
    const audit = (await call(users.asha, "GET", `/robots/safety-audit?robot=${id}`)).body.audit.filter((entry) => entry.kind === "profile");
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].detail.after.restrictedDestinations, ["door"]);
    assert.equal(audit[0].actor, "asha@autonomy.example");
  } finally { await live.stop(); await call(users.asha, "DELETE", `/robots/${id}`); }
});

test("autonomy policies: read only, suggest only, approve every operation and approved missions; a team's applies to its members; every change audited", async () => {
  const robot = await enrolled(users.asha, "Mule");
  const id = robot.robotId;
  const live = operate(robot);
  try {
    assert.equal((await call(users.asha, "GET", "/robots/autonomy-policy")).body.policy.effective.policy, "approved_low_risk");
    assert.equal((await call(users.ashaKey, "PUT", "/robots/autonomy-policy", { policy: "approve_every" })).status, 403);
    assert.equal((await call(users.asha, "PUT", "/robots/autonomy-policy", { policy: "everything_allowed" })).status, 400);

    await call(users.asha, "PUT", "/robots/autonomy-policy", { policy: "read_only" });
    const read = await act(users.asha, "robots.navigate_to", { robot: "Mule", place: "workbench" });
    assert.equal(read.body.record.status, "denied");
    assert.match(read.body.record.permission.reason, /Read only/);
    assert.equal((await act(users.asha, "robots.state", { robot: "Mule" })).body.record.status, "done");

    await call(users.asha, "PUT", "/robots/autonomy-policy", { policy: "suggest_only" });
    const suggested = await act(users.asha, "robots.navigate_to", { robot: "Mule", place: "workbench" });
    assert.equal(suggested.body.record.status, "suggested");
    assert.equal(await missionCount(id), 0);

    // Approve every operation: a standing permission no longer covers it.
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 4 } });
    const grant = await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["robots.navigate_to"], note: "lab" });
    await call(users.asha, "PUT", "/robots/autonomy-policy", { policy: "approve_every" });
    assert.equal((await act(users.asha, "robots.navigate_to", { robot: "Mule", place: "workbench" })).body.record.status, "waiting-approval");
    // Approved missions: the grant covers navigate_to:workbench and nothing else.
    await call(users.asha, "PUT", "/robots/autonomy-policy", { policy: "approved_missions", missions: ["navigate_to:workbench"] });
    const unlisted = await act(users.asha, "robots.navigate_to", { robot: "Mule", x: 1, y: 1 });
    assert.equal(unlisted.body.record.status, "waiting-approval");
    assert.match(unlisted.body.record.permission.reason, /only for approved missions/);
    await call(users.asha, "POST", `/actions/${unlisted.body.record.id}/decision`, { approve: false });
    const listed = await act(users.asha, "robots.navigate_to", { robot: "Mule", place: "workbench" });
    assert.equal(listed.body.record.status, "done", JSON.stringify(listed.body.record));
    await call(users.asha, "DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 3 } });
    await call(users.asha, "PUT", "/robots/autonomy-policy", { policy: "approved_low_risk" });

    // A team: Bo owns it, Asha is a member. Bo's team policy makes Asha's stricter; Asha can't change it.
    const team = await call(users.bo, "POST", "/workforce/teams", { name: "Lab" });
    assert.equal(team.status, 201, JSON.stringify(team.body));
    const teamId = team.body.team?.id || team.body.id;
    assert.equal((await call(users.bo, "POST", `/workforce/teams/${teamId}/members`, { email: "asha@autonomy.example", role: "member" })).status, 201);
    assert.equal((await call(users.asha, "PUT", `/robots/teams/${teamId}/autonomy-policy`, { policy: "approved_low_risk" })).status, 403);
    assert.equal((await call(users.bo, "PUT", `/robots/teams/${teamId}/autonomy-policy`, { policy: "read_only" })).status, 200);
    const mine = (await call(users.asha, "GET", "/robots/autonomy-policy")).body.policy;
    assert.equal(mine.effective.policy, "read_only");
    assert.ok(mine.effective.sources.some((source) => source.scope === "team" && source.name === "Lab"));
    assert.match((await act(users.asha, "robots.navigate_to", { robot: "Mule", place: "workbench" })).body.record.permission.reason, /Read only/);
    // Stopping is never blocked by a policy.
    assert.equal((await call(users.asha, "POST", `/robots/${id}/stop`, {})).body.record.permission.outcome, "allow");
    await call(users.bo, "PUT", `/robots/teams/${teamId}/autonomy-policy`, { policy: "approved_low_risk" });
    const audit = (await call(users.asha, "GET", "/robots/safety-audit")).body.audit.filter((entry) => entry.kind === "policy");
    assert.ok(audit.some((entry) => /Account autonomy policy set to “Read only”/.test(entry.summary)));
    assert.ok(audit.some((entry) => /Team “Lab” robot autonomy policy set to “Read only”/.test(entry.summary) && entry.actor === "bo@autonomy.example"));
    assert.ok(audit.every((entry) => entry.detail && "before" in entry.detail && "after" in entry.detail));
  } finally { await live.stop(); await call(users.asha, "DELETE", `/robots/${id}`); }
});

test("teleoperation: the handoff in order, exclusive control, newest-only short-lived commands, operator disconnect, autonomy restored only after validation", async () => {
  const robot = await enrolled(users.asha, "Rescue");
  const id = robot.robotId;
  const live = operate(robot);
  try {
    // An autonomous mission is running; the handoff will end it.
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 4 } });
    const grant = await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["robots.navigate_to"], note: "lab" });
    const running = await act(users.asha, "robots.navigate_to", { robot: "Rescue", place: "workbench" });
    assert.equal(running.body.record.status, "done", JSON.stringify(running.body.record));

    // 1. A developer key is not an operator. 2. The robot has to be confirmed.
    const byKey = await call(users.ashaKey, "POST", `/robots/${id}/teleop`, { confirm: { robotId: id } });
    assert.equal(byKey.status, 409);
    assert.equal(byKey.body.step, "operator-auth");
    const unconfirmed = await call(users.asha, "POST", `/robots/${id}/teleop`, { confirm: { robotId: "rb_wrong" } });
    assert.equal(unconfirmed.body.step, "robot-identification");
    // 3. Permission: an engaged emergency stop refuses the handoff.
    robot.state = { ...robot.state, estop: { engaged: true } };
    await sleep(120);
    const estopped = await call(users.asha, "POST", `/robots/${id}/teleop`, { confirm: { robotId: id } });
    assert.equal(estopped.body.step, "permission");
    assert.equal(estopped.body.reason, "precondition:estop-released");
    robot.state = { ...robot.state, estop: { engaged: false } };
    await sleep(120);

    const started = await call(users.asha, "POST", `/robots/${id}/teleop`, { confirm: { robotId: id } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { token } = started.body;
    const session = started.body.session;
    assert.ok(token && session.id);
    assert.equal(session.status, "activating");
    assert.deepEqual(session.steps.map((step) => step.id), ["operator-auth", "robot-identification", "permission", "mode-transition", "mission-handling", "manual-activation", "operator-visibility", "audit"]);
    assert.match(session.steps.find((step) => step.id === "mission-handling").detail, /Cancelled: mission/);
    assert.equal(session.video.available, false);
    // No command before the robot confirms.
    assert.equal((await call(users.asha, "POST", `/robots/${id}/teleop/${session.id}/command`, { token, seq: 1, linear: 0.1, angular: 0 })).body.reason, "robot-not-confirmed");
    const active = await until(async () => (await call(users.asha, "GET", `/robots/${id}/teleop`)).body.session, (item) => item.status === "active", "the robot to confirm manual control");
    assert.equal(active.steps.find((step) => step.id === "manual-activation").ok, true);
    assert.equal(live.interval(), 100, "the robot exchanges ten times a second while driven by hand");
    // Visible on the robot to everyone who can see it.
    assert.equal((await call(users.ashaKey, "GET", `/robots/${id}`)).body.robot.teleop.operator, "asha@autonomy.example");

    // Exclusive: a second operator can't take it; autonomous commands are refused while it is held.
    assert.equal((await call(users.asha, "POST", `/robots/${id}/teleop`, { confirm: { robotId: id } })).body.reason, "manual-control-held");
    const autonomous = await act(users.asha, "robots.navigate_to", { robot: "Rescue", place: "workbench" });
    assert.equal(autonomous.body.record.status, "denied");
    assert.match(autonomous.body.record.permission.reason, /holds manual control|Manual mode/);

    // Only the operator's own screen can drive; numbers only go up; speeds are clamped to the limits.
    assert.equal((await call(users.asha, "POST", `/robots/${id}/teleop/${session.id}/command`, { token: "not-the-token-at-all", seq: 1, linear: 0.1, angular: 0 })).body.reason, "not-operator");
    const first = await call(users.asha, "POST", `/robots/${id}/teleop/${session.id}/command`, { token, seq: 5, linear: 9, angular: -9 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.linear, 0.5);
    assert.equal(first.body.angular, -1.5);
    assert.equal(first.body.clamped, true);
    assert.equal((await call(users.asha, "POST", `/robots/${id}/teleop/${session.id}/command`, { token, seq: 4, linear: 0.1, angular: 0 })).body.reason, "stale-sequence");
    await call(users.asha, "POST", `/robots/${id}/teleop/${session.id}/command`, { token, seq: 6, linear: 0.2, angular: 0.1 });
    const applied = await until(() => robot.state.teleop, (item) => item?.seq === 6, "the robot to apply the newest command");
    assert.equal(applied.linear, 0.2);
    assert.ok(live.heard.filter((command) => command.type === "teleop").every((command) => command.expiresAt - command.issuedAt <= 400), "every manual command lives 400 ms at most");
    assert.ok(!live.heard.some((command) => command.type === "teleop" && command.seq === 4), "a stale command is never sent");
    const link = await until(async () => (await call(users.asha, "GET", `/robots/${id}/teleop`)).body.session.link, (item) => item.ackedSeq === 6, "the robot's acknowledgement");
    assert.ok(link.serverToRobotMs !== null && link.serverToRobotMs < 1000);
    assert.equal(link.robotOnline, true);

    // A command that is already stale when the robot next exchanges is not delivered at all.
    await live.stop();
    await call(users.asha, "POST", `/robots/${id}/teleop/${session.id}/command`, { token, seq: 7, linear: 0.3, angular: 0 });
    await sleep(500);
    const late = await robot.sync({ send: { ...robot.state, at: Date.now() } });
    assert.ok(!late.commands.some((command) => command.type === "teleop"), "a command older than its 400 ms is never sent");

    // The operator goes away: after ten seconds without input the session ends, and the robot is told.
    const later = createRoboticsService({ now: () => Date.now() + 11_000 });
    const gone = await later.teleop.view(db, users.ashaId, id);
    assert.equal(gone.session.status, "ended");
    assert.match(gone.session.endReason, /operator disconnected/);
    const told = await robot.sync({ send: { ...robot.state, at: Date.now() } });
    const release = told.commands.find((command) => command.type === "mode");
    assert.equal(release.mode, "manual");
    assert.equal(release.teleop, null, "the robot's session is withdrawn; it holds");
    robot.state.operatingMode = { mode: release.mode, seq: release.modeSeq, session: null };
    await robot.sync({ send: { ...robot.state, at: Date.now() } });

    // Autonomy comes back only when a person restores it, through the checks.
    const second = operate(robot);
    try {
      const outside = await call(users.asha, "PUT", `/robots/${id}/safety-profile`, { profile: { operatingArea: [[-5, -4], [0, -4], [0, 0], [-5, 0]] } });
      assert.equal(outside.status, 200);
      robot.state = { ...robot.state, pose: { x: 2, y: 2, yaw: 0, frame: "map", source: "odometry" } };
      await sleep(150);
      const refused = await setMode(users.asha, id, "supervised");
      assert.equal(refused.body.reason, "outside-operating-area");
      robot.state = { ...robot.state, pose: { x: -1, y: -2, yaw: 0, frame: "map", source: "odometry" } };
      await sleep(150);
      assert.equal((await setMode(users.asha, id, "supervised")).status, 200);
      await until(() => autonomyOf(users.asha, id), (item) => item.confirmed, "Supervised");
    } finally { await second.stop(); }
    const audit = (await call(users.asha, "GET", `/robots/safety-audit?robot=${id}`)).body.audit.filter((entry) => entry.kind === "teleop").map((entry) => entry.summary);
    assert.ok(audit.some((line) => /Manual control refused at “Robot identified”/.test(line)));
    assert.ok(audit.some((line) => /Manual control handed to asha@autonomy\.example; cancelled 1 task/.test(line)));
    assert.ok(audit.some((line) => /confirmed manual control/.test(line)));
    assert.ok(audit.some((line) => /Manual control ended: operator disconnected/.test(line)));
    await call(users.asha, "DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 3 } });
  } finally { await live.stop(); await call(users.asha, "DELETE", `/robots/${id}`); }
});

test("teleoperation: ending a session hands nothing back to autonomy, and anyone in the account may take control away", async () => {
  const robot = await enrolled(users.asha, "Tug");
  const id = robot.robotId;
  const live = operate(robot);
  try {
    const started = await call(users.asha, "POST", `/robots/${id}/teleop`, { confirm: { robotId: id } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    await until(async () => (await call(users.asha, "GET", `/robots/${id}/teleop`)).body.session, (item) => item.status === "active", "active");
    const ended = await call(users.ashaKey, "POST", `/robots/${id}/teleop/${started.body.session.id}/end`, { reason: "taken away" });
    assert.equal(ended.status, 200);
    assert.equal(ended.body.session.status, "ended");
    assert.equal((await autonomyOf(users.asha, id)).mode, "manual", "the robot stays in Manual, holding");
    assert.equal((await call(users.asha, "POST", `/robots/${id}/teleop/${started.body.session.id}/command`, { token: started.body.token, seq: 1, linear: 0.1, angular: 0 })).body.reason, "session-ended");
    // A Safety Stop also ends a session.
    const again = await call(users.asha, "POST", `/robots/${id}/teleop`, { confirm: { robotId: id } });
    assert.equal(again.status, 201);
    await setMode(users.ashaKey, id, "safety_stop");
    assert.equal((await call(users.asha, "GET", `/robots/${id}/teleop`)).body.session.endReason, "safety-stop");
  } finally { await live.stop(); await call(users.asha, "DELETE", `/robots/${id}`); }
});

// ---------- every path that can move a robot goes through the chain ----------

/**
 * Every Action Engine action that sends something to a robot, and how it is
 * covered. A new robot action that isn't listed here fails this test: whoever
 * adds one has to say how it passes the chain.
 */
const COVERAGE = {
  "robots.navigate_to": "mission", "robots.return_to_dock": "mission", "robots.inspect_area": "mission", "robots.set_supported_device_state": "mission",
  "robots.move_robot_arm": "mission", "robots.grasp_object": "mission", "robots.release_object": "mission", "robots.capture_image": "mission",
  "robots.assign": "via mission", "robots.reassign": "via mission", "robots.run_plan": "plan", "robots.resume_mission": "resume",
  "robots.stop_motion": "stop", "robots.safety_stop": "stop", "robots.set_mode": "mode", "robots.cancel_mission": "deescalates", "robots.pause_mission": "deescalates", "robots.cancel_plan": "deescalates",
  "robotos.stage_update": "robot os (no motion)", "robotos.activate_update": "robot os (no motion)", "robotos.rollback_update": "robot os (no motion)",
};

test("entry points: every robot action is accounted for, and no file but the robot service queues a command", async () => {
  const catalog = (await call(users.asha, "GET", "/actions/catalog")).body.actions.filter((action) => action.service === "robots" && action.kind !== "read");
  assert.deepEqual(catalog.map((action) => action.id).sort(), Object.keys(COVERAGE).sort());
  // A source scan: the only place a mission row is written, and every dispatch carries the chain's verdict.
  const files = [];
  const walk = (folder) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { if (entry.name === "node_modules" || entry.name.startsWith(".")) continue; const full = path.join(folder, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(c|m)?js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(full); } };
  walk(__dirname);
  const writers = files.filter((file) => /INSERT INTO hannah_robot_missions/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(writers.map((file) => path.relative(__dirname, file)), [path.join("robotics", "service.js")]);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bdispatch\(db, userId, \{[^\n]*\}\)/g)) assert.match(match[0], /verdict/, `${path.relative(__dirname, file)}: ${match[0].slice(0, 120)}`);
    for (const match of text.matchAll(/robotics\.dispatch\([^\n]*\)/g)) assert.match(match[0], /verdict/, `${path.relative(__dirname, file)}: ${match[0].slice(0, 120)}`);
    for (const match of text.matchAll(/robotics\.resumeMission\([^\n]*\)/g)) assert.match(match[0], /verdict/, `${path.relative(__dirname, file)}: ${match[0].slice(0, 120)}`);
  }
  // Workflows and AI teammates reach robots only through the Action Engine.
  for (const file of ["workflows/runtime.js", "workforce/hardware.js"]) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.ok(!/robotics\.(dispatch|resumeMission|createPlan|stop)\(/.test(text), file);
    assert.ok(/engine\.run\(/.test(text), file);
  }
});

test("entry points: with the robot in Manual mode, every way of asking for movement is refused by the chain and nothing is queued", async () => {
  const robot = await enrolled(users.asha, "Gate");
  const id = robot.robotId;
  const other = await enrolled(users.asha, "Spare");
  const live = operate(robot);
  const spare = operate(other);
  try {
    // A mission that failed on Spare, so reassigning it is possible.
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 4 } });
    const grant = await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["robots.navigate_to"], note: "lab" });
    const failed = await act(users.asha, "robots.navigate_to", { robot: "Spare", place: "workbench" });
    assert.equal(failed.body.record.status, "done");
    await other.sync({ reports: [{ missionId: failed.body.record.response.missionId, status: "failed", reason: "blocked" }], send: { ...other.state, at: Date.now() } });
    await call(users.asha, "DELETE", `/account/permissions/grants/${grant.body.grant.id}`);
    await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 3 } });
    await setMode(users.asha, other.robotId, "manual");
    assert.equal((await setMode(users.asha, id, "manual")).status, 200);
    await until(() => autonomyOf(users.asha, id), (item) => item.confirmed, "Manual on Gate");
    const before = await missionCount(id) + await missionCount(other.robotId);
    const refusedAt = (record) => record.permission?.reason || record.error || "";
    const attempts = [
      ["chat", () => act(users.asha, "robots.navigate_to", { robot: "Gate", place: "workbench" }, { source: "chat" })],
      ["robots screen", () => act(users.asha, "robots.return_to_dock", { robot: "Gate" }, { source: "robots" })],
      ["developer key / MCP", () => act(users.ashaKey, "robots.inspect_area", { robot: "Gate", waypoints: [{ place: "workbench" }] })],
      ["workflow", () => act(users.asha, "robots.navigate_to", { robot: "Gate", x: 1, y: 1 }, { source: "workflow" })],
      ["AI teammate", () => act(users.asha, "robots.navigate_to", { robot: "Gate", x: 1, y: 1 }, { source: "workforce" })],
      ["device switch", () => act(users.asha, "robots.set_supported_device_state", { robot: "Gate", device: "beacon", state: "on" })],
      ["fleet assignment", () => act(users.asha, "robots.assign", { task: "navigate_to", place: "workbench", among: "Gate" })],
      ["reassignment", () => act(users.asha, "robots.reassign", { mission: failed.body.record.response.missionId, among: "Gate" })],
      ["plan", () => call(users.asha, "POST", `/robots/${id}/plans`, { steps: [{ do: "navigate_to", place: "workbench" }] })],
    ];
    for (const [label, attempt] of attempts) {
      const answer = await attempt();
      const record = answer.body?.record;
      if (record) {
        assert.ok(["denied", "failed"].includes(record.status), `${label}: ${record.status}`);
        assert.match(refusedAt(record), /Manual mode|No robot can take that|isn't|can't/i, label);
      } else assert.ok(answer.status >= 400, `${label}: ${answer.status} ${JSON.stringify(answer.body)}`);
    }
    assert.equal(await missionCount(id) + await missionCount(other.robotId), before, "nothing was queued for either robot");
    // Stopping works in every mode.
    const stopped = await call(users.asha, "POST", `/robots/${id}/stop`, {});
    assert.equal(stopped.body.record.permission.outcome, "allow");
  } finally { await live.stop(); await spare.stop(); await call(users.asha, "DELETE", `/robots/${id}`); await call(users.asha, "DELETE", `/robots/${other.robotId}`); }
});

test("entry points: the robot service itself refuses to queue or resume without a fresh chain verdict", async () => {
  const robot = await enrolled(users.asha, "Direct");
  const robotics = createRoboticsService();
  const view = await robotics.getRobot(db, users.ashaId, robot.robotId);
  await assert.rejects(robotics.dispatch(db, users.ashaId, { robot: view, capabilityId: "navigate_to", params: { x: 1, y: 1 } }), (error) => error.reason === "chain-required");
  const preflight = await robotics.assess(db, users.ashaId, view, "navigate_to", { x: 1, y: 1 });
  assert.equal(preflight.ok, true);
  await assert.rejects(robotics.dispatch(db, users.ashaId, { robot: view, capabilityId: "navigate_to", params: preflight.params, verdict: preflight }), (error) => error.reason === "chain-required", "a preflight answer can't send");
  const forged = { ...preflight, chain: { ...preflight.chain, stage: "execute" } };
  await assert.rejects(robotics.dispatch(db, users.ashaId, { robot: view, capabilityId: "navigate_to", params: preflight.params, verdict: forged }), (error) => error.reason === "chain-required", "a copied verdict can't send");
  // Execution stage without an approved request behind it: refused at user authorization.
  const unauthorized = await robotics.assess(db, users.ashaId, view, "navigate_to", { x: 1, y: 1 }, { stage: "execute", authorization: { kind: "action-record", recordId: "nope" } });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.chain.refusal.step, "user-authorization");
  await assert.rejects(robotics.resumeMission(db, users.ashaId, "ms_missing"), (error) => error.reason === "not-found");
  assert.equal(await missionCount(robot.robotId), 0);
  await call(users.asha, "DELETE", `/robots/${robot.robotId}`);
});
