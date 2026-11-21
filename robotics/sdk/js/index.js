/**
 * A small client for HANNAH's robot API. No dependencies; Node 18+ or a browser.
 *
 * Everything here goes through the same doors as the app: a call that moves a
 * robot is an Action Engine action, so it meets the account's permission
 * level, the Robotics Safety Gateway and, when one is needed, a person's
 * approval. A developer key cannot approve. Such a call returns the action's
 * record: check `record.status` ("done", "waiting-approval", "denied",
 * "failed", "unverified") rather than assuming the robot moved. "done" for a
 * movement means the robot accepted the mission, not that it arrived: wait
 * for the mission and read its own status.
 *
 *   import { HannahRobots } from "./index.js";
 *   const robots = new HannahRobots({ baseUrl: "https://your-hannah", apiKey: process.env.HANNAH_KEY });
 *   const record = await robots.navigate("Rover", { place: "workbench" });
 *   if (record.status === "waiting-approval") { ... someone approves it in the app ... }
 *   const mission = await robots.waitForMission(record.response.missionId, { seconds: 120 });
 *   if (mission.status !== "succeeded") throw new Error(mission.summary);
 */
export class HannahRobotsError extends Error {
  constructor(message, { status, reason, body } = {}) {
    super(message);
    this.name = "HannahRobotsError";
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
}

const FINAL_ACTION = new Set(["done", "denied", "failed", "unverified", "declined", "expired", "cancelled"]);
const id = (value) => encodeURIComponent(String(value));
const query = (params) => { const text = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "").map(([key, value]) => [key, String(value)])).toString(); return text ? `?${text}` : ""; };

export class HannahRobots {
  constructor({ baseUrl, apiKey, fetch: fetchImpl, timeoutMs = 30_000, agent = "SDK" } = {}) {
    if (!baseUrl) throw new HannahRobotsError("baseUrl is required, for example https://your-hannah");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.agent = agent;
    if (typeof this.fetch !== "function") throw new HannahRobotsError("No fetch available; pass one in the options.");
  }

  async request(method, path, body) {
    const response = await this.fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    // 202 is "recorded, waiting for a person's approval": an answer, not an error.
    if (!response.ok) throw new HannahRobotsError(data?.error || `HANNAH answered ${response.status}`, { status: response.status, reason: data?.reason, body: data });
    return data;
  }

  /** Run an Action Engine action. Returns its record; never throws for "denied" or "waiting-approval". */
  async act(action, params = {}, { request = "Asked through the robot SDK" } = {}) {
    return (await this.request("POST", "/actions", { action, params, request, agent: this.agent })).record;
  }
  /** An action that only reads: returns what it read, or throws with the reason it couldn't. */
  async read(action, params = {}) {
    const record = await this.act(action, params);
    if (record.status !== "done") throw new HannahRobotsError(record.error || record.permission?.reason || record.outcome || `The read ended as ${record.status}.`, { reason: record.status, body: record });
    return record.response;
  }

  // ---- registry (reads) ----
  async list() { return (await this.request("GET", "/robots")).robots; }
  async get(robotId) { return this.request("GET", `/robots/${id(robotId)}`); }
  async contract() { return this.request("GET", "/robots/contract"); }
  async fleet() { return (await this.request("GET", "/robots/fleet")).robots; }
  async analytics(days = 7) { return (await this.request("GET", `/robots/analytics${query({ days })}`)).analytics; }
  async events(robotId, limit = 50) { return (await this.request("GET", `/robots/events${query({ robot: robotId, limit })}`)).events; }
  async destinations(robotId) { return this.request("GET", `/robots/${id(robotId)}/destinations`); }
  async diagnostics(robotId) { return (await this.request("GET", `/robots/${id(robotId)}/diagnostics`)).diagnostics; }
  async templates(robotId) { return (await this.request("GET", `/robots/${id(robotId)}/templates`)).templates; }
  async images(robotId) { return this.request("GET", `/robots/${id(robotId)}/images`); }
  /** Opens a picture. The server logs that this key opened it. */
  async image(robotId, imageId) { return (await this.request("GET", `/robots/${id(robotId)}/images/${id(imageId)}`)).image; }

  // ---- reads through the Action Engine: by robot name or id, with staleness marked ----
  state(robot) { return this.read("robots.state", { robot }); }
  battery(robot) { return this.read("robots.battery", { robot }); }
  surroundings(robot) { return this.read("robots.surroundings", { robot }); }
  sensor(robot, sensor) { return this.read("robots.read_sensor", { robot, sensor }); }
  armState(robot) { return this.read("robots.arm_state", { robot }); }
  lastPicture(robot) { return this.read("robots.camera", { robot }); }

  // ---- anything that moves a robot or uses its camera: returns the action's record ----
  navigate(robot, goal = {}) { return this.act("robots.navigate_to", { robot, ...goal }); }
  returnToDock(robot) { return this.act("robots.return_to_dock", { robot }); }
  inspect(robot, waypoints) { return this.act("robots.inspect_area", { robot, waypoints }); }
  assign(task, params = {}) { return this.act("robots.assign", { task, ...params }); }
  moveArm(robot, target = {}) { return this.act("robots.move_robot_arm", { robot, ...target }); }
  grasp(robot, object) { return this.act("robots.grasp_object", { robot, object }); }
  release(robot) { return this.act("robots.release_object", { robot }); }
  capturePicture(robot, camera) { return this.act("robots.capture_image", { robot, ...(camera ? { camera } : {}) }); }
  runPlan(robot, plan = {}) { return this.act("robots.run_plan", { robot, ...plan }); }
  resume(robot, missionId) { return this.act("robots.resume_mission", { robot, ...(missionId ? { mission: missionId } : {}) }); }

  // ---- never need approval ----
  stop(robot, reason = "") { return this.act("robots.stop_motion", { robot, reason }); }
  pause(robot, missionId) { return this.act("robots.pause_mission", { robot, ...(missionId ? { mission: missionId } : {}) }); }
  cancelMission(robot, missionId) { return this.act("robots.cancel_mission", { robot, ...(missionId ? { mission: missionId } : {}) }); }
  cancelPlan(robot, planId) { return this.act("robots.cancel_plan", { robot, ...(planId ? { plan: planId } : {}) }); }

  // ---- missions and plans ----
  async missions({ robot, active, limit } = {}) { return (await this.request("GET", `/robots/missions${query({ robot, active: active ? 1 : undefined, limit })}`)).missions; }
  async mission(missionId) { return (await this.request("GET", `/robots/missions/${id(missionId)}`)).mission; }
  async plans({ robot, active, limit } = {}) { return (await this.request("GET", `/robots/plans${query({ robot, active: active ? 1 : undefined, limit })}`)).plans; }
  async plan(planId) { return (await this.request("GET", `/robots/plans/${id(planId)}`)).plan; }
  /** The action's record as it is now: use it to see whether a person has approved. */
  async action(actionId) { return (await this.request("GET", `/actions/${id(actionId)}`)).record; }

  async #watch(read, seconds, everyMs) {
    const end = Date.now() + Math.max(1, seconds) * 1000;
    for (;;) {
      const value = await read();
      if (value.final || Date.now() >= end) return value;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
  /** Watch a mission until it ends or the time is up. Returns it as it is then: check `final` and `status`. */
  waitForMission(missionId, { seconds = 60, everyMs = 1000 } = {}) { return this.#watch(() => this.mission(missionId), seconds, everyMs); }
  waitForPlan(planId, { seconds = 120, everyMs = 1500 } = {}) { return this.#watch(() => this.plan(planId), seconds, everyMs); }
  /** Watch an action until a person has decided it (or it ended some other way). */
  waitForDecision(actionId, { seconds = 120, everyMs = 1500 } = {}) { return this.#watch(async () => { const record = await this.action(actionId); return { ...record, final: FINAL_ACTION.has(record.status) }; }, seconds, everyMs); }
}

export default HannahRobots;
