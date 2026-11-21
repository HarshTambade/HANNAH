"use strict";

// Integration test of the robot SDK (robotics/sdk/js) against the real server,
// with a scripted stand-in robot. It shows what a program holding a developer
// key can and can't do: it can ask, read, stop and watch; it can't approve.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "robotics-sdk-token-0123456789-abcdefghijklmnopqr";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.HANNAH_ROBOT_ACK_WAIT_MS = "1500";
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");

let server;
let base;
let sdk;
let HannahRobots;
let HannahRobotsError;
let person;
let robot;
let live;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asPerson = async (method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...person, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
/** The stand-in exchanges continuously and accepts each mission; it "arrives" when told to. */
function running(target) {
  let on = true;
  const reports = [];
  const received = [];
  const loop = (async () => {
    while (on) {
      const out = await target.sync({ reports: reports.splice(0), send: { ...target.state, at: Date.now() } });
      for (const command of out.commands || []) {
        const key = `${command.type}:${command.missionId}`;
        if (target.seen.has(key)) continue;
        target.seen.set(key, command);
        received.push(command);
        if (command.type === "mission") reports.push({ missionId: command.missionId, status: "accepted" });
        if (command.type === "mission" && command.capability === "stop_motion") reports.push({ missionId: command.missionId, status: "succeeded" });
        if (command.type === "cancel") reports.push({ missionId: command.missionId, status: "cancelled", reason: "Cancelled on request." });
      }
      await sleep(30);
    }
  })();
  return { received, arrive: (command) => { target.state = state({ pose: { x: command.params.x, y: command.params.y, yaw: 0, frame: "map", source: "odometry" } }); reports.push({ missionId: command.missionId, status: "succeeded" }); }, stop: async () => { on = false; await loop; } };
}

before(async () => {
  ({ HannahRobots, HannahRobotsError } = await import(pathToFileURL(path.join(__dirname, "..", "robotics", "sdk", "js", "index.js")).href));
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const registered = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "dev@sdk.example", password: "correct horse battery staple" }) });
  person = { Cookie: registered.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  const key = (await asPerson("POST", "/account/api-keys", { name: "program" })).body.key;
  sdk = new HannahRobots({ baseUrl: `${base}/`, apiKey: key, agent: "Test program" });
  const created = await asPerson("POST", "/robots", { name: "Rover", simulated: true });
  robot = createRobotClient({ base });
  await robot.enroll(created.body.enrollment.code, descriptor());
  await robot.sync();
  live = running(robot);
});
after(async () => {
  await live?.stop();
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("a program reads the registry and a robot's state, with what is simulated and what is old marked", async () => {
  const robots = await sdk.list();
  assert.deepEqual(robots.map((item) => [item.name, item.simulated, item.online]), [["Rover", true, true]]);
  const now = await sdk.state("Rover");
  assert.deepEqual([now.online, now.stale, now.robot.kind], [true, false, "simulation"]);
  assert.equal((await sdk.battery("Rover")).percent, 80);
  assert.equal((await sdk.fleet())[0].available, true);
  assert.deepEqual((await sdk.templates(robot.robotId)).filter((item) => item.available).map((item) => item.id), ["go_and_return", "status_report"]);
  assert.equal((await sdk.analytics(1)).fleet.robots, 1);
  assert.ok((await sdk.contract()).capabilities.some((item) => item.id === "navigate_to"));
  // A read that can't be answered throws with the reason; it never returns an empty value.
  await assert.rejects(sdk.sensor("Rover", "sonar"), (error) => error instanceof HannahRobotsError && /no sensor|doesn't have|sonar/i.test(error.message));
  await assert.rejects(sdk.state("Nobody"), (error) => error instanceof HannahRobotsError && /You have no robot called “Nobody” \(you have: Rover\)/.test(error.message) && [404, 409].includes(error.status ?? 409));
  await assert.rejects(new HannahRobots({ baseUrl: base, apiKey: "hk_wrong" }).list(), (error) => error instanceof HannahRobotsError && error.status === 401);
  assert.throws(() => new HannahRobots({}), /baseUrl is required/);
});

test("a program can ask for a movement but not approve it; once a person has, it watches the mission to its verified end", async () => {
  const asked = await sdk.navigate("Rover", { place: "workbench" });
  assert.equal(asked.status, "waiting-approval");
  assert.match(asked.preview.title, /Start a mission: Rover drives to workbench/);
  // The key can't decide it.
  await assert.rejects(sdk.request("POST", `/actions/${asked.id}/decision`, { approve: true }), (error) => error.status === 403);
  assert.equal((await sdk.waitForDecision(asked.id, { seconds: 1, everyMs: 200 })).status, "waiting-approval");
  assert.equal(live.received.length, 0, "nothing reached the robot");
  // A person approves in the app.
  assert.equal((await asPerson("POST", `/actions/${asked.id}/decision`, { approve: true })).body.record.status, "done");
  const decided = await sdk.waitForDecision(asked.id, { seconds: 5, everyMs: 100 });
  assert.equal(decided.status, "done");
  const missionId = decided.response.missionId;
  assert.equal((await sdk.waitForMission(missionId, { seconds: 1, everyMs: 200 })).status, "accepted", "accepted is a start, not an arrival");
  live.arrive(live.received.find((command) => command.missionId === missionId));
  const done = await sdk.waitForMission(missionId, { seconds: 5, everyMs: 100 });
  assert.deepEqual([done.status, done.final, done.verification.confirmed], ["succeeded", true, true]);
  assert.equal((await sdk.missions({ robot: robot.robotId, limit: 1 }))[0].id, missionId);
});

test("a refused request comes back as a record with the reason, and stopping needs nobody", async () => {
  const refused = await sdk.navigate("Rover", { x: 40, y: 40 });
  assert.equal(refused.status, "denied");
  assert.match(refused.permission.reason, /outside the robot's allowed workspace/);
  assert.equal((await sdk.grasp("Rover", "cup")).status, "denied", "a robot without an arm");
  const stopped = await sdk.stop("Rover", "test");
  assert.equal(stopped.permission.code, "deescalates");
  assert.ok(["done", "unverified"].includes(stopped.status), stopped.status);
  // A plan is asked for the same way and waits for a person the same way.
  const plan = await sdk.runPlan("Rover", { template: "status_report" });
  assert.equal(plan.status, "waiting-approval");
  assert.deepEqual(plan.preview.lines.filter((line) => line.label.startsWith("Step")).map((line) => line.value.replace(/ \(.*/, "")), ["record the robot's state", "record the battery level"]);
  await asPerson("POST", `/actions/${plan.id}/decision`, { approve: true });
  const started = await sdk.waitForDecision(plan.id, { seconds: 5, everyMs: 100 });
  const finished = await sdk.waitForPlan(started.response.planId, { seconds: 5, everyMs: 100 });
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.steps[1].output.percent, 80);
  assert.equal((await sdk.cancelPlan("Rover").catch((error) => error.status)), 404, "there is no unfinished plan to cancel");
});
