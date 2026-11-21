"use strict";

/**
 * A stand-in robot for the server's tests: it speaks HANNAH's robot protocol
 * (enroll, signed sync, signed commands) and does exactly what the test tells
 * it to. It is not a simulator and moves nothing; the test sets the state it
 * reports. The real runtime is robotics/runtime (Python), tested against the
 * same server in robotics.sim.test.js.
 */
const crypto = require("node:crypto");
const { signCommand, signRequest } = require("../robotics/service");

const WORKSPACE = [[-5, -4], [5, -4], [5, 4], [-5, 4]];

function descriptor(overrides = {}) {
  return {
    manufacturer: "HANNAH test bench", model: "DD-1", robotType: "differential-drive", os: "test", compute: "none", rosDistro: "", protocols: ["hannah-robot-v1"],
    softwareVersion: "0.0.1", firmwareVersion: "n/a", runtimeVersion: "test", adapter: "stand-in", hostname: "bench",
    sensors: [{ id: "lidar", type: "2d-lidar" }, { id: "odometry", type: "wheel-odometry" }, { id: "battery", type: "battery" }],
    actuators: [{ id: "drive", type: "differential-drive" }], devices: ["beacon"],
    capabilities: ["report_robot_state", "read_sensor", "stop_motion", "navigate_to", "return_to_dock", "inspect_area", "set_supported_device_state"],
    places: { dock: { x: -4, y: -3, yaw: 0 }, workbench: { x: 3, y: 2 }, door: { x: 4.5, y: 0 } }, dock: { x: -4, y: -3, yaw: 0 },
    world: { name: "bench", bounds: { minX: -5, minY: -4, maxX: 5, maxY: 4 }, obstacles: [{ x: 0, y: 0, w: 1, h: 1 }] },
    limits: { maxLinearSpeed: 0.5, maxAngularSpeed: 1.5, maxLinearAccel: 1, minBatteryPercent: 15, linkTimeoutS: 5, commandTtlS: 20, robotRadius: 0.2, environment: "simulation", workspace: { frame: "map", polygon: WORKSPACE }, keepOut: [{ name: "stairs", polygon: [[3.5, -4], [5, -4], [5, -2.5], [3.5, -2.5]] }], estop: { hardware: false, description: "stand-in" } },
    simulation: { kind: "stand-in", note: "A scripted test robot." },
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    at: Date.now(), mode: "idle", pose: { x: 0, y: -2, yaw: 0, frame: "map", source: "odometry" }, velocity: { linear: 0, angular: 0 },
    battery: { percent: 80, charging: false }, estop: { engaged: false, source: "simulated-hardware" }, motorsEnabled: true, localized: true, faults: [],
    sensors: { lidar: { ok: true, minRange: 1.2 }, odometry: { ok: true }, battery: { percent: 80 } }, devices: { beacon: "off" }, mission: null,
    ...overrides,
  };
}

function createRobotClient({ base, fetchImpl = fetch }) {
  const robot = { robotId: null, secret: null, counter: 0, seen: new Map(), lastSeq: 0, state: state() };
  const post = async (path, body, headers = {}) => {
    const text = JSON.stringify(body);
    const response = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(typeof headers === "function" ? headers(text) : headers) }, body: text });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    return { status: response.status, body: data };
  };
  robot.enroll = async (code, described = descriptor()) => {
    const answer = await post("/api/robots/enroll", { code, descriptor: described });
    if (answer.status === 201) { robot.robotId = answer.body.robotId; robot.secret = answer.body.secret; robot.counter = 0; }
    return answer;
  };
  /** Headers for a signed request. Any part can be overridden to forge a bad one. */
  robot.sign = (text, { time = Date.now(), counter = (robot.counter += 1), secret = robot.secret, robotId = robot.robotId, path = "/api/robots/device/sync" } = {}) => ({
    "X-Hannah-Robot": robotId, "X-Hannah-Time": String(time), "X-Hannah-Counter": String(counter),
    "X-Hannah-Signature": signRequest(secret, { robotId, time: String(time), counter: String(counter), method: "POST", path, body: text }),
  });
  /** One sync. Returns the verified commands; throws if the server sent one with a bad signature. */
  robot.sync = async ({ reports = [], events = [], send = robot.state, forge, described } = {}) => {
    const body = { runtime: { version: "test", adapter: "stand-in" }, state: send, reports, events, ...(described ? { descriptor: described } : {}) };
    const answer = await post("/api/robots/device/sync", body, (text) => robot.sign(text, forge));
    if (answer.status !== 200) return answer;
    const commands = answer.body.commands.map((item) => {
      if (signCommand(robot.secret, item.payload) !== item.sig) throw new Error("The server sent a command with a bad signature.");
      return JSON.parse(item.payload);
    });
    return { ...answer, commands };
  };
  robot.rawSync = (text, headers) => fetchImpl(`${base}/api/robots/device/sync`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: text });
  return robot;
}

module.exports = { WORKSPACE, createRobotClient, descriptor, state, randomId: () => crypto.randomBytes(4).toString("hex") };
