"use strict";

// The robot black box on the real server and database, with the stand-in robot
// (test-fixtures/robot-client.js): signed uploads, the merged timeline, search,
// clock uncertainty, access control, recordings in file storage, retention,
// export and deletion, incident reports, replay and regression scenarios.
// Nothing here is a physical robot; the stand-in robot is registered as a simulation.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "blackbox-test-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
process.env.HANNAH_RATE_LIMIT_ROBOT_BLACKBOX_PER_10S = "100000";
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "1500";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
process.env.HANNAH_BLACKBOX_STORE = "memory";
delete process.env.VERCEL;

const { createRobotClient, state } = require("./test-fixtures/robot-client");
const { readSegment } = require("./robotics/blackbox_format");
const { createBlackBoxService } = require("./robotics/blackbox");
const { createMemoryStore, createFileStore } = require("./robotics/blackbox_store");
const { createRoboticsService } = require("./robotics/service");
const { investigate, narrate, validateNarrative } = require("./robotics/incident");

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
  return { status: response.status, body: data, headers: response.headers };
};
const act = (who, action, params) => call(who, "POST", "/actions", { action, params, request: "test request", agent: "Robot agent" });
const decide = (who, id, approve) => call(who, "POST", `/actions/${id}/decision`, { approve });
const bbId = () => `bbe_${crypto.randomBytes(10).toString("hex")}`;

/** A signed black box upload from the stand-in robot. */
async function upload(robot, body, forge = {}) {
  const text = JSON.stringify(body);
  const response = await fetch(`${base}/api/robots/device/blackbox`, { method: "POST", headers: { "Content-Type": "application/json", ...robot.sign(text, { path: "/api/robots/device/blackbox", ...forge }) }, body: text });
  return { status: response.status, body: await response.json() };
}

/** An HBX v1 segment, written the way the robot's recorder writes one. */
function segment({ id = `seg_${crypto.randomBytes(8).toString("hex")}`, robotId, simulated = true, sensitivity = "normal", records, stream = "nav-72h" }) {
  const line = (value) => `${JSON.stringify(value)}\n`;
  let text = line({ format: "hannah-blackbox", version: 1, segment: id, robotId, stream, openedAt: records[0]?.t || Date.now(), simulated, sensitivity });
  records.forEach((record, index) => { text += line({ seq: index + 1, kind: "telemetry", ...record }); });
  const footer = { footer: true, records: records.length, closedAt: Date.now(), sha256: crypto.createHash("sha256").update(text).digest("hex") };
  return { id, stream, sensitivity, content: zlib.gzipSync(Buffer.from(text + line(footer))).toString("base64") };
}

async function enrolled(who, name) {
  const created = await call(who, "POST", "/robots", { name, simulated: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll(created.body.enrollment.code)).status, 201);
  assert.equal((await robot.sync()).status, 200);
  return robot;
}

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["asha", "bo"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@blackbox.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@blackbox.example`])).rows[0].id;
  }
  const key = await call(users.asha, "POST", "/account/api-keys", { name: "agent" });
  users.ashaKey = { Authorization: `Bearer ${key.body.key}` };
  users.scout = await enrolled(users.asha, "Scout");
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("the format: a segment written by the robot's Python recorder is read and verified, and a changed one is refused", () => {
  for (const name of ["events-segment-v1.hbx.gz", "nav-segment-v1.hbx.gz"]) {
    const { header, records, info } = readSegment(fs.readFileSync(path.join(__dirname, "test-fixtures", "blackbox", name)));
    assert.equal(header.format, "hannah-blackbox");
    assert.equal(header.simulated, true);
    assert.ok(info.verified && info.closed);
    assert.ok(records.length > 0);
  }
  const events = readSegment(fs.readFileSync(path.join(__dirname, "test-fixtures", "blackbox", "events-segment-v1.hbx.gz"))).records;
  assert.ok(events.some((item) => item.data.type === "estop-engaged"));
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "test-fixtures", "blackbox", "nav-segment-v1.hbx.gz"))).toString("utf8").replace('"topic":"nav/pose"', '"topic":"nav/posf"');
  assert.throws(() => readSegment(Buffer.from(raw)), /checksum/);
});

test("upload: only the enrolled robot's signed, fresh request is stored; each event once; nonsense refused with the reason", async () => {
  const robot = users.scout;
  const id = bbId();
  const event = { id, at: Date.now() - 1000, source: "sensor", type: "battery-warning", severity: "warning", summary: "The battery is at 20%.", details: { image: "AAAA", where: "aisle 3" }, refs: [{ segment: "seg_abcdef", stream: "nav-72h", fromMs: 1, toMs: 2 }] };
  const first = await upload(robot, { clock: { synced: false }, events: [event] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.accepted, [id]);
  assert.equal(first.body.policy.acceptSegments, false, "recordings are off until the owner allows them");
  assert.ok(Number.isFinite(first.body.serverTime));
  const again = await upload(robot, { events: [event] });
  assert.deepEqual(again.body.duplicates, [id], "an upload sent twice is stored once");
  // Forged, replayed, unsigned.
  assert.equal((await upload(robot, { events: [{ ...event, id: bbId() }] }, { secret: Buffer.alloc(32, 9).toString("base64url") })).status, 401);
  assert.equal((await upload(robot, { events: [] }, { counter: 1 })).status, 401);
  assert.equal((await fetch(`${base}/api/robots/device/blackbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  const odd = await upload(robot, { events: [{ id: "x" }, { id: bbId() }, { id: bbId(), at: Date.now() + 3 * 86_400_000 }, { id: bbId(), at: Date.now() - 400 * 86_400_000 }] });
  assert.deepEqual(odd.body.refused.map((item) => item.reason), ["bad-id", "no-time", "time-in-the-future", "older-than-retention"]);
  const stored = (await db.query("SELECT * FROM hannah_robot_blackbox_events WHERE robot_event_id = $1", [id])).rows;
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0].simulated), 1, "the server's registry decides simulation, not the robot's claim");
  assert.deepEqual(JSON.parse(stored[0].details), { imageOmitted: true, where: "aisle 3" }, "no raw payload reaches a row");
});

test("access: the owner and the owner's key can read; another account can't even see the robot; settings and deletion need a signed-in person", async () => {
  const robot = users.scout;
  assert.equal((await call(null, "GET", `/robots/${robot.robotId}/blackbox/events`)).status, 401);
  assert.equal((await call(users.bo, "GET", `/robots/${robot.robotId}/blackbox/events`)).status, 404);
  assert.equal((await call(users.bo, "GET", `/robots/${robot.robotId}/blackbox/incident`)).status, 404);
  assert.equal((await call(users.ashaKey, "GET", `/robots/${robot.robotId}/blackbox/events`)).status, 200);
  assert.equal((await call(users.ashaKey, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { acceptSegments: true })).status, 403);
  assert.equal((await call(users.ashaKey, "DELETE", `/robots/${robot.robotId}/blackbox`)).status, 403);
  assert.equal((await call(users.bo, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { acceptSegments: true })).status, 404);
  const bad = await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { retentionDays: 0 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /retentionDays must be a whole number from 1 to 365/);
  // A sensitive event's details are for a signed-in person only.
  const id = bbId();
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { acceptSegments: true, acceptSensitive: true });
  await upload(robot, { events: [{ id, at: Date.now(), source: "sensor", type: "camera-capture", severity: "info", summary: "A picture was taken.", sensitivity: "sensitive", details: { frame: 12 } }] });
  const byKey = (await call(users.ashaKey, "GET", `/robots/${robot.robotId}/blackbox/events?type=camera-capture`)).body.events[0];
  assert.match(byKey.details.withheld, /signed-in person/);
  const byPerson = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?type=camera-capture`)).body.events[0];
  assert.deepEqual(byPerson.details, { frame: 12 });
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { acceptSegments: false, acceptSensitive: false });
});

test("the timeline: black box events, missions and agent requests in one order, searchable, with clock uncertainty shown", async () => {
  const robot = users.scout;
  robot.state = state({ pose: { x: 0, y: -2, yaw: 0, source: "odometry" } });
  const asked = await act(users.asha, "robots.navigate_to", { robot: "Scout", place: "workbench" });
  assert.equal(asked.body.record.status, "waiting-approval");
  const approving = decide(users.asha, asked.body.record.id, true);
  let command;
  for (let n = 0; n < 40 && !command; n += 1) {
    const out = await robot.sync();
    command = (out.commands || []).find((item) => item.type === "mission");
    if (command) await robot.sync({ reports: [{ missionId: command.missionId, status: "accepted", at: Date.now() }] });
    else await sleep(50);
  }
  assert.ok(command, "the mission reached the robot");
  assert.equal((await approving).body.record.status, "done");
  const missionId = command.missionId;
  // The robot drives a little, then its emergency stop engages and the mission fails.
  for (const [x, v] of [[0.6, 0.3], [1.2, 0.3]]) { robot.state = state({ mode: "navigating", pose: { x, y: -1.5, yaw: 0.5, source: "odometry" }, velocity: { linear: v, angular: 0 } }); await robot.sync(); await sleep(3100); }
  const sent = Date.now();
  const stopAt = Date.now();
  const estop = bbId();
  const failed = bbId();
  const answer = await upload(robot, {
    clock: { synced: true, offsetMs: 0, uncertaintyMs: 40 },
    events: [
      { id: estop, at: stopAt, source: "safety", type: "estop-engaged", severity: "error", summary: "The emergency stop was engaged.", mission: missionId, clock: { synced: true, offMs: 0, uncMs: 40 } },
      { id: failed, at: stopAt + 50, source: "mission", type: "mission-failed", severity: "error", summary: `Mission ${missionId} failed: The emergency stop was engaged.`, mission: missionId, details: { status: "failed", capability: "navigate_to", params: command.params, reason: "The emergency stop was engaged." } },
    ],
  });
  assert.deepEqual(answer.body.accepted, [estop, failed]);
  robot.state = state({ mode: "estopped", estop: { engaged: true, source: "simulated-hardware" }, pose: { x: 1.25, y: -1.5, yaw: 0.5, source: "odometry" } });
  await robot.sync({ reports: [{ missionId, status: "failed", reason: "The emergency stop was engaged.", at: stopAt + 50 }], events: [{ type: "estop-engaged", severity: "error", message: "The emergency stop was engaged.", at: stopAt }] });
  users.stop = { missionId, stopAt, sent };

  const view = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?from=${stopAt - 60_000}`)).body;
  const types = view.events.map((item) => item.type);
  for (const type of ["action-requested", "approval-approved", "mission-issued", "mission-accepted", "estop-engaged", "mission-failed"]) assert.ok(types.includes(type), `${type} in ${types}`);
  assert.equal(view.events.filter((item) => item.type === "estop-engaged").length, 1, "the robot's own copy and the black box's are one item");
  const stop = view.events.find((item) => item.robotEventId === estop);
  users.stop.estop = stop.id;
  assert.equal(stop.origin, "robot-blackbox");
  assert.equal(stop.clock.synced, true);
  assert.equal(stop.clock.uncertaintyMs, 40);
  assert.match(stop.clock.note, /within 40 ms/);
  const requested = view.events.find((item) => item.type === "action-requested");
  assert.match(requested.summary, /asked for robots\.navigate_to/);
  assert.equal(requested.source, "ai");
  assert.ok(view.events.every((item, index, all) => index === 0 || all[index - 1].at <= item.at), "oldest first");
  // Search and filters.
  const safety = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?source=safety&from=${stopAt - 60_000}`)).body.events;
  assert.deepEqual([...new Set(safety.map((item) => item.source))], ["safety"]);
  const words = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?q=EMERGENCY&from=${stopAt - 60_000}`)).body.events;
  assert.ok(words.length >= 2 && words.every((item) => /emergency/i.test(item.summary)));
  const errors = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?severity=error&from=${stopAt - 60_000}`)).body.events;
  assert.ok(errors.every((item) => ["error", "critical"].includes(item.severity)));
  const ofMission = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?mission=${missionId}&from=${stopAt - 60_000}`)).body.events;
  assert.ok(ofMission.length >= 4 && ofMission.every((item) => item.missionId === missionId));
  const onlyRobot = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?server=0&from=${stopAt - 60_000}`)).body.events;
  assert.ok(onlyRobot.every((item) => item.origin === "robot-blackbox"));
  // An unsynchronised robot time is said to be uncertain.
  await upload(robot, { clock: { synced: false }, events: [{ id: bbId(), at: Date.now(), source: "os", type: "boot", severity: "info", summary: "Runtime started." }] });
  const later = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?type=boot`)).body;
  assert.equal(later.events[0].clock.synced, false);
  assert.match(later.events[0].clock.note, /not synchronised/);
  assert.match(later.clock.note, /order against HANNAH's own records may be off/);
});

test("why did it stop: confirmed facts cite records, suspected causes are labelled, nothing is invented, and an agent gets the same report", async () => {
  const robot = users.scout;
  const { missionId, estop } = users.stop;
  const { report } = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/incident`)).body;
  assert.equal(report.found, true);
  assert.equal(report.robot.kind, "simulation");
  assert.match(report.label, /Simulation/);
  assert.equal(report.anchor.missionId, missionId);
  assert.match(report.method, /Deterministic rules/);
  const ids = new Set([...report.sequence.map((item) => item.id), ...report.confirmed.flatMap((item) => item.evidence).filter((id) => id.startsWith("tel_"))]);
  for (const line of report.confirmed) for (const id of line.evidence) assert.ok(ids.has(id), `${id} is a real record`);
  assert.ok(report.confirmed.some((line) => line.evidence.includes(estop)));
  const cause = report.suspected.find((item) => item.evidence.includes(estop));
  assert.equal(cause.status, "suspected");
  assert.match(cause.cause, /simulated emergency-stop input/);
  assert.match(cause.check, /not who or what engaged it/);
  assert.ok(report.suspected.every((item) => item.status === "suspected"));
  assert.ok(report.recovery.steps.some((step) => /Release the emergency stop on the robot itself/.test(step)));
  assert.match(report.recovery.note, /HANNAH carries out none of them/);
  assert.ok(report.evidenceIds.every((id) => ids.has(id) || report.history.evidence.includes(id)));
  // The same for a given mission, and through the Action Engine for an agent.
  const byMission = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/incident?mission=${missionId}`)).body.report;
  assert.equal(byMission.anchor.missionId, missionId);
  const agent = await act(users.ashaKey, "robots.why_stopped", { robot: "Scout" });
  assert.equal(agent.body.record.status, "done", JSON.stringify(agent.body.record));
  assert.equal(agent.body.record.response.anchor.id, report.anchor.id);
  assert.match(agent.body.record.response.howToAnswer, /suspected/);
  const searched = await act(users.ashaKey, "robots.timeline", { robot: "Scout", source: "safety", minutes: 30 });
  assert.ok(searched.body.record.response.events.some((item) => item.type === "estop-engaged"));
  // No model on this server: the narrative says so and the report stands.
  const narrative = (await call(users.asha, "POST", `/robots/${robot.robotId}/blackbox/incident/narrative`, {})).body;
  assert.equal(narrative.report.anchor.id, report.anchor.id);
  assert.equal(narrative.narrative.ok, false);
  assert.equal(narrative.narrative.text, null);
});

test("replay: a mission comes back as playback, always labelled, and becomes a regression scenario for the simulator", async () => {
  const robot = users.scout;
  const { missionId } = users.stop;
  const { replay } = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/missions/${missionId}/replay`)).body;
  assert.equal(replay.playback, true);
  assert.equal(replay.live, false);
  assert.match(replay.label, /^PLAYBACK/);
  assert.equal(replay.robot.kind, "simulation");
  assert.ok(replay.frames.length >= 2, JSON.stringify(replay.sources));
  assert.ok(replay.frames.every((frame, index, all) => index === 0 || all[index - 1].at <= frame.at));
  assert.ok(replay.events.some((item) => item.type === "estop-engaged"));
  const made = (await call(users.asha, "POST", `/robots/${robot.robotId}/blackbox/incident/scenario`, { mission: missionId })).body;
  const step = made.scenario.steps.at(-1);
  assert.deepEqual(step.navigate, { x: 3, y: 2 });
  assert.equal(step.expect, "failed");
  assert.equal(step.reason, "The emergency stop was engaged\\.");
  assert.ok(step.during.some((item) => item.estop === true && item.recordedEvent === users.stop.estop));
  assert.equal(made.scenario.source.recordedOn, "simulation");
  assert.match(made.scenario.source.note, /not a test on the robot/);
  // Not every mission can be one.
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/missions/ms_nothing/replay`)).status, 404);
});

test("recordings: stored in file storage only when allowed, checked against the robot and its kind, downloadable, sensitive ones guarded", async () => {
  const robot = users.scout;
  const now = Date.now();
  const nav = segment({ robotId: robot.robotId, records: [{ t: now - 2000, topic: "nav/pose", data: { x: 1, y: 2 } }, { t: now - 1000, topic: "nav/pose", data: { x: 1.2, y: 2.1 } }] });
  assert.equal((await upload(robot, { events: [], segment: nav })).body.segment.reason, "not-allowed");
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { acceptSegments: true });
  const stored = await upload(robot, { events: [], segment: nav });
  assert.deepEqual(stored.body.segment, { stored: true, verified: true });
  assert.equal((await upload(robot, { events: [], segment: nav })).body.segment.stored, "duplicate");
  const row = (await db.query("SELECT * FROM hannah_robot_blackbox_segments WHERE id = $1", [nav.id])).rows[0];
  assert.ok(row && !("content" in row) && row.storage_key.endsWith(`${nav.id}.hbx.gz`), "the row holds where the bytes are, not the bytes");
  assert.equal((await upload(robot, { events: [], segment: segment({ robotId: "rb_000000000000000001", records: [{ t: now, topic: "nav/pose", data: {} }] }) })).body.segment.reason, "wrong-robot");
  assert.equal((await upload(robot, { events: [], segment: segment({ robotId: robot.robotId, simulated: false, records: [{ t: now, topic: "nav/pose", data: {} }] }) })).body.segment.reason, "kind-mismatch", "a simulation's recording is never stored as a physical one, nor the reverse");
  const tampered = { ...nav, id: "seg_tampered01", content: zlib.gzipSync(Buffer.from(zlib.gunzipSync(Buffer.from(nav.content, "base64")).toString().replace(nav.id, "seg_tampered01"))).toString("base64") };
  assert.equal((await upload(robot, { events: [], segment: tampered })).body.segment.reason, "bad-segment");
  const camera = segment({ robotId: robot.robotId, sensitivity: "sensitive", stream: "sensors-24h-sensitive", records: [{ t: now, topic: "sensors/camera", data: { width: 64 } }] });
  assert.equal((await upload(robot, { events: [], segment: camera })).body.segment.reason, "sensitive-not-allowed");
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { acceptSensitive: true });
  assert.equal((await upload(robot, { events: [], segment: camera })).body.segment.stored, true);
  const list = (await call(users.ashaKey, "GET", `/robots/${robot.robotId}/blackbox/segments`)).body.segments;
  assert.deepEqual(list.map((item) => [item.id, item.downloadable]).sort(), [[camera.id, false], [nav.id, true]].sort());
  const file = await fetch(`${base}/api/robots/${robot.robotId}/blackbox/segments/${nav.id}`, { headers: users.ashaKey });
  assert.equal(file.status, 200);
  assert.equal(readSegment(Buffer.from(await file.arrayBuffer())).records.length, 2);
  assert.equal((await call(users.ashaKey, "GET", `/robots/${robot.robotId}/blackbox/segments/${camera.id}`)).status, 403);
  assert.equal((await fetch(`${base}/api/robots/${robot.robotId}/blackbox/segments/${camera.id}`, { headers: users.asha })).status, 200);
  assert.equal((await call(users.bo, "GET", `/robots/${robot.robotId}/blackbox/segments/${nav.id}`)).status, 404);
});

test("export, deletion and retention: everything comes out as one file, a range can be deleted, shortened retention applies at once", async () => {
  const robot = users.scout;
  const exported = await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /attachment; filename="blackbox-rb_/);
  assert.equal(exported.body.format, "hannah-blackbox-export");
  assert.equal(exported.body.robot.kind, "simulation");
  assert.ok(exported.body.events.some((item) => item.id && item.type === "estop-engaged"));
  assert.ok(exported.body.segments.some((item) => item.download));
  // Older events go when retention is shortened.
  const old = bbId();
  await upload(robot, { events: [{ id: old, at: Date.now() - 3 * 86_400_000, source: "os", type: "boot", severity: "info", summary: "Old start." }] });
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_blackbox_events WHERE robot_event_id = $1", [old])).rows[0].n * 1, 1);
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { retentionDays: 2 });
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_blackbox_events WHERE robot_event_id = $1", [old])).rows[0].n * 1, 0);
  // Deleting a range removes events and recordings in it, files included, and says what is kept elsewhere.
  const { stopAt } = users.stop;
  const removed = (await call(users.asha, "DELETE", `/robots/${robot.robotId}/blackbox?from=${stopAt - 5000}&to=${stopAt + 5000}`)).body;
  assert.ok(removed.events >= 2);
  assert.match(removed.note, /Mission history/);
  const left = (await call(users.asha, "GET", `/robots/${robot.robotId}/blackbox/events?server=0&from=${stopAt - 5000}&to=${stopAt + 5000}`)).body.events;
  assert.deepEqual(left, []);
  const everything = (await call(users.asha, "DELETE", `/robots/${robot.robotId}/blackbox`)).body;
  assert.ok(removed.segments + everything.segments >= 2);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_blackbox_segments WHERE robot_id = $1", [robot.robotId])).rows[0].n * 1, 0);
  assert.ok((await call(users.asha, "GET", `/robots/events?robot=${robot.robotId}`)).body.events.some((item) => item.type === "blackbox-deleted"), "the deletion itself is on record");
});

test("switched off: the robot is told, nothing is stored; removing the robot removes its black box", async () => {
  const robot = await enrolled(users.asha, "Temp");
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { enabled: false });
  const off = await upload(robot, { events: [{ id: bbId(), at: Date.now(), source: "os", type: "boot", severity: "info", summary: "x" }] });
  assert.equal(off.body.refused[0].reason, "recording-off");
  assert.equal(off.body.policy.enabled, false);
  await call(users.asha, "PUT", `/robots/${robot.robotId}/blackbox/settings`, { enabled: true });
  await upload(robot, { events: [{ id: bbId(), at: Date.now(), source: "os", type: "boot", severity: "info", summary: "x" }] });
  assert.equal((await call(users.asha, "DELETE", `/robots/${robot.robotId}`)).status, 200);
  for (const table of ["hannah_robot_blackbox_events", "hannah_robot_blackbox_settings"]) assert.equal((await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE robot_id = $1`, [robot.robotId])).rows[0].n * 1, 0);
});

test("retention sweep on a moving clock removes expired events and recordings with their files; Robot OS envelopes reach the timeline", async () => {
  let clock = Date.now();
  const store = createMemoryStore();
  const robotics = createRoboticsService({ now: () => clock });
  const blackbox = createBlackBoxService({ robotics, store, now: () => clock });
  const robot = await enrolled(users.asha, "Sweeper");
  const row = (await db.query("SELECT * FROM hannah_robots WHERE id = $1", [robot.robotId])).rows[0];
  await blackbox.updateSettings(db, users.ashaId, robot.robotId, { acceptSegments: true, segmentRetentionDays: 1, retentionDays: 3 });
  const seg = segment({ robotId: robot.robotId, records: [{ t: clock, topic: "nav/pose", data: { x: 0 } }] });
  const answer = await blackbox.ingest(db, row, { events: [{ id: bbId(), at: clock, source: "os", type: "boot", severity: "info", summary: "Started." }], segment: seg });
  assert.equal(answer.segment.stored, true);
  assert.equal(store.items.size, 1);
  clock += 2 * 86_400_000;
  assert.deepEqual(await blackbox.sweep(db), { events: 0, segments: 1 });
  assert.equal(store.items.size, 0, "the file goes with its row");
  clock += 2 * 86_400_000;
  assert.equal((await blackbox.sweep(db)).events, 1);
  // A Robot OS black box event arrives as a bridge envelope and lands on the same timeline.
  clock = Date.now();
  await blackbox.ingestEnvelope(db, users.ashaId, { robot_id: robot.robotId, kind: "event", payload: { blackbox: { id: bbId(), at: clock, source: "motor", type: "controller-fault-needs-operator", severity: "error", summary: "motor-controller: controller fault needs operator", device: "left" } } });
  const view = await blackbox.timeline(db, users.ashaId, robot.robotId, { server: false });
  assert.deepEqual(view.events.map((item) => [item.origin, item.deviceId]), [["robot-os", "left"]]);
  assert.equal(await blackbox.ingestEnvelope(db, users.boId, { robot_id: robot.robotId, kind: "event", payload: { blackbox: { id: bbId(), at: clock } } }), null, "another account's envelope can't write to this robot");
  // A serverless host without persistent storage refuses recordings rather than lose them.
  process.env.VERCEL = "1";
  try { assert.equal(createFileStore({ root: "/tmp/never" }).durable, false); } finally { delete process.env.VERCEL; }
});

test("the incident rules: with no cause recorded nothing is suspected; a lost link and a sensor loss are told apart; clocks too close to order are flagged", () => {
  const robot = { id: "rb_1", name: "R", simulated: false, limits: { minBatteryPercent: 15 } };
  const t = 1_800_000_000_000;
  const item = (id, at, type, extra = {}) => ({ id, at, type, source: "mission", severity: "error", summary: `${type} happened`, origin: "server", clock: { synced: true, uncertaintyMs: 0 }, ...extra });
  const bare = investigate({ robot, timeline: [item("m1", t, "mission-failed", { missionId: "ms_1", details: { status: "failed" } })], now: t });
  assert.equal(bare.found, true);
  assert.deepEqual(bare.suspected, []);
  assert.ok(bare.gaps.some((gap) => /No rule matched/.test(gap)));
  assert.match(bare.label, /Physical robot/);
  const link = investigate({ robot, timeline: [item("l1", t - 6000, "link-lost", { source: "link", origin: "robot-blackbox", clock: { synced: false, uncertaintyMs: null } }), item("m1", t, "mission-cancelled", { missionId: "ms_1", details: { status: "cancelled" } })], now: t });
  assert.match(link.suspected[0].cause, /lost contact with HANNAH/);
  assert.ok(link.clock.notes.some((note) => /wasn't synchronised/.test(note)));
  const sensor = investigate({ robot, timeline: [item("s1", t - 100, "sensor-lost", { source: "sensor", deviceId: "lidar", origin: "robot-blackbox", clock: { synced: true, uncertaintyMs: 300 } }), item("m1", t, "mission-failed", { missionId: "ms_1", details: { status: "failed" } })], telemetry: [{ at: t - 500, v: 0.2, battery: 9, mode: "navigating" }], now: t });
  assert.match(sensor.suspected[0].cause, /lidar sensor stopped reporting/);
  assert.ok(sensor.suspected.some((item2) => /battery was below/.test(item2.cause)));
  assert.ok(sensor.clock.notes.some((note) => /may have happened in the other order/.test(note)));
  assert.equal(investigate({ robot, timeline: [item("ok", t, "mission-succeeded")], now: t }).found, false);
  const history = investigate({ robot, timeline: [item("m2", t, "mission-failed", { details: { status: "failed" } })], history: [item("m0", t - 5 * 86_400_000, "mission-failed"), item("m00", t - 9 * 86_400_000, "mission-failed")], now: t });
  assert.equal(history.history.count, 2);
});

test("the model-written narrative is accepted only when every sentence cites the report's own records", async () => {
  const robot = { id: "rb_1", name: "R", simulated: true, limits: {} };
  const t = 1_800_000_000_000;
  const report = investigate({ robot, timeline: [{ id: "e1", at: t - 1000, type: "estop-engaged", source: "safety", severity: "error", summary: "The emergency stop was engaged.", origin: "robot-blackbox", clock: { synced: true, uncertaintyMs: 10 } }, { id: "m1", at: t, type: "mission-failed", source: "mission", severity: "error", summary: "Mission failed.", origin: "server", missionId: "ms_1", clock: { synced: true, uncertaintyMs: 0 }, details: { status: "failed" } }], now: t });
  assert.equal(validateNarrative("The robot's emergency stop engaged [e1]. The mission then failed [m1].", report).ok, true);
  assert.equal(validateNarrative("The robot stopped [e1]. Someone kicked it.", report).ok, false);
  assert.match(validateNarrative("The motor overheated [x9].", report).problems[0], /x9, which isn't in the report/);
  assert.equal(validateNarrative("The emergency stop was definitely the cause [e1].", report).ok, false, "a suspected cause can't be stated as certain");
  let prompt = "";
  const good = await narrate(report, async (input) => { prompt = input.prompt; return { text: "The emergency stop engaged, which is the suspected cause [e1]. The mission failed one second later [m1].", model: "test-model" }; });
  assert.equal(good.ok, true);
  assert.match(good.label, /Model-written summary.*not a verified finding/);
  assert.match(prompt, /\[e1\]/);
  const bad = await narrate(report, async () => ({ text: "A wheel broke." }));
  assert.equal(bad.ok, false);
  assert.equal(bad.text, null);
  assert.equal(bad.rejectedText, "A wheel broke.");
});
