"use strict";

// Integration tests: what the server does with a picture a robot reports, on
// the real server and database with a scripted stand-in robot. The stand-in
// has no camera: the test hands it the bytes to report, including bytes that
// are not what they claim to be. The real runtime's camera path is tested in
// robotics.sim.test.js.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const zlib = require("node:zlib");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robotics-camera-token-0123456789-abcdefghijklmno";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "d".repeat(64);
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "2500";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");

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

/** A real PNG of one colour, built the way the runtime builds one. */
function png(width, height, [r, g, b] = [200, 40, 40]) {
  const chunk = (kind, data) => { const body = Buffer.concat([Buffer.from(kind), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const WITH_CAMERA = (extra = {}) => descriptor({ sensors: [...descriptor().sensors, { id: "camera", type: "rgb-camera", description: "Front camera", frame: "camera_link", rateHz: 15, resolution: "8x6", messageType: "sensor_msgs/msg/Image", calibration: "factory", secretNote: "x".repeat(400) }], capabilities: [...descriptor().capabilities, "capture_image"], ...extra });

async function enrolled(name, { simulated = true, described } = {}) {
  const created = await call(users.asha, "POST", "/robots", { name, simulated });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll(created.body.enrollment.code, described)).status, 201);
  robot.state = state({ sensors: { ...state().sensors, camera: { ok: true } } });
  assert.equal((await robot.sync()).status, 200);
  return robot;
}
/** The stand-in exchanges until stopped; for each capture it reports what `answer` returns. */
function running(robot, answer) {
  let on = true;
  const reports = [];
  const loop = (async () => {
    while (on) {
      const out = await robot.sync({ reports: reports.splice(0), send: { ...robot.state, at: Date.now() } });
      for (const command of out.commands || []) {
        if (robot.seen.has(command.missionId)) continue;
        robot.seen.set(command.missionId, command);
        reports.push({ missionId: command.missionId, status: "accepted" }, { missionId: command.missionId, status: "succeeded", ...answer(command) });
      }
      await sleep(30);
    }
  })();
  return { stop: async () => { on = false; await loop; } };
}
const picture = (bytes, extra = {}) => ({ result: { sensor: "camera", frame: 4, capturedAt: Date.now(), width: 8, height: 6, detections: [{ label: "red region", colour: "red", confidence: 0.9, model: "test", sensor: "camera", frame: 4 }], detector: { model: "test", version: "1" } }, attachment: { kind: "image", encoding: "png", data: bytes.toString("base64"), sensor: "camera", frame: 4, capturedAt: Date.now(), width: 8, height: 6, source: "stand-in", ...extra } });
async function capture(robotName) {
  const asked = await act(users.asha, "robots.capture_image", { robot: robotName });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  return (await call(users.asha, "POST", `/actions/${asked.body.record.id}/decision`, { approve: true })).body.record;
}

before(async () => {
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["asha", "bo"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@camera.example`, password: "correct horse battery staple" }) });
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  }
});
after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("a sensor is registered with its frame, rate, resolution, message type and calibration, and nothing else it sends", async () => {
  const robot = await enrolled("Scout", { described: WITH_CAMERA() });
  users.scout = robot;
  const view = (await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot;
  assert.deepEqual(view.sensors.find((sensor) => sensor.id === "camera"), { id: "camera", type: "rgb-camera", description: "Front camera", frame: "camera_link", resolution: "8x6", messageType: "sensor_msgs/msg/Image", calibration: "factory", rateHz: 15 });
  assert.deepEqual(view.camera, { enabled: false, retentionHours: 24, cameras: ["camera"] });
  // A robot with no camera can't have camera use switched on, and isn't offered a picture.
  const blind = await enrolled("Mole", { described: descriptor({ capabilities: [...descriptor().capabilities, "capture_image"] }) });
  assert.equal((await call(users.asha, "PATCH", `/robots/${blind.robotId}`, { camera: { enabled: true } })).status, 409);
  assert.match((await act(users.asha, "robots.capture_image", { robot: "Mole" })).body.record.permission.reason, /Mole has no camera registered/);
});

test("a picture is stored only when it is a real image of the size it claims, from that robot's camera, while camera use is on", async () => {
  const robot = users.scout;
  assert.match((await act(users.asha, "robots.capture_image", { robot: "Scout" })).body.record.permission.reason, /Camera use is switched off for Scout/);
  await call(users.asha, "PATCH", `/robots/${robot.robotId}`, { camera: { enabled: true, retentionHours: 5000 } });
  assert.equal((await call(users.asha, "GET", `/robots/${robot.robotId}`)).body.robot.camera.retentionHours, 720, "retention has a ceiling");
  assert.match((await act(users.asha, "robots.capture_image", { robot: "Scout", camera: "thermal" })).body.record.permission.reason, /no camera called “thermal” \(it has: camera\)/);
  const stored = async () => (await call(users.asha, "GET", `/robots/${robot.robotId}/images`)).body.images;

  // 1. A real 8×6 PNG: stored, verified, and the answer carries the detections but no image data.
  let live = running(robot, () => picture(png(8, 6)));
  const good = await capture("Scout");
  await live.stop();
  assert.equal(good.status, "done", JSON.stringify(good));
  assert.match(good.verification.evidence, /A 8×6 image from the camera \(frame 4, .* simulated camera\) arrived and is stored as im_/);
  assert.equal(good.response.detections[0].label, "red region");
  assert.equal(JSON.stringify(good).includes(png(8, 6).toString("base64")), false);
  assert.equal((await stored()).length, 1);

  // 2. What a robot might send instead: each is recorded as unverified and nothing is kept.
  for (const [why, answer] of [
    ["not an image", () => picture(Buffer.from("this is not a picture, it only says it is one........"))],
    ["an image of another size than claimed", () => picture(png(16, 12))],
    ["a camera this robot doesn't have", () => picture(png(8, 6), { sensor: "thermal" })],
    ["no image at all", () => ({ result: picture(png(8, 6)).result })],
    ["an image taken long before it was asked for", () => picture(png(8, 6), { capturedAt: Date.now() - 3_600_000 })],
  ]) {
    robot.seen.clear();
    live = running(robot, answer);
    const record = await capture("Scout");
    await live.stop();
    assert.equal(record.status, "unverified", `${why}: ${JSON.stringify(record).slice(0, 400)}`);
    assert.equal(record.response.imageId, undefined, why);
    assert.equal((await stored()).length, 1, why);
  }
  const old = (await call(users.asha, "GET", `/robots/missions?robot=${robot.robotId}&limit=1`)).body.missions[0];
  assert.match(old.verification.evidence, /before this picture was asked for\. It was not stored\./);

  // 3. Switched off while the command is on its way: the picture that comes back is not kept.
  robot.seen.clear();
  let switchedOff = false;
  live = running(robot, () => picture(png(8, 6)));
  const asked = await act(users.asha, "robots.capture_image", { robot: "Scout" });
  await live.stop();
  await call(users.asha, "PATCH", `/robots/${robot.robotId}`, { camera: { enabled: false } });
  switchedOff = true;
  const refused = (await call(users.asha, "POST", `/actions/${asked.body.record.id}/decision`, { approve: true })).body.record;
  assert.equal(switchedOff && refused.status, "failed");
  assert.match(refused.error, /Camera use is switched off for Scout/);
  assert.equal((await stored()).length, 1);

  // Another account sees no pictures of this robot, by list or by id.
  const mine = await stored();
  assert.equal((await call(users.bo, "GET", `/robots/${robot.robotId}/images`)).status, 404);
  assert.equal((await call(users.bo, "GET", `/robots/${robot.robotId}/images/${mine[0].id}`)).status, 404);
  // Removing the robot removes its pictures.
  await call(users.asha, "DELETE", `/robots/${robot.robotId}`);
  const db = await require("./db").getDatabase();
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_images WHERE robot_id = $1", [robot.robotId])).rows[0].n), 0);
});

test("a physical robot's camera asks every time, with a warning about who may be in the picture", async () => {
  const physical = WITH_CAMERA({ simulation: null, limits: { ...descriptor().limits, environment: "shared-with-people", estop: { hardware: true, description: "Button" } } });
  const robot = await enrolled("Porter", { simulated: false, described: physical });
  await call(users.asha, "PATCH", `/robots/${robot.robotId}`, { camera: { enabled: true } });
  await call(users.asha, "PUT", "/account/permissions", { levels: { robots: 5 } });
  await call(users.asha, "POST", "/account/permissions/grants", { service: "robots", actions: ["*"], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const asked = await act(users.asha, "robots.capture_image", { robot: "Porter" });
  assert.equal(asked.body.record.status, "waiting-approval", JSON.stringify(asked.body));
  assert.match(asked.body.record.permission.reason, /this takes a picture with a physical robot's camera/);
  assert.ok(asked.body.record.preview.warnings.some((line) => /Whoever is in front of the robot will be in the picture/.test(line)));
  assert.match(asked.body.record.preview.lines.find((line) => line.label === "Robot").value, /PHYSICAL ROBOT/);
});
