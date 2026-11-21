import { beforeEach, describe, expect, it, vi } from "vitest";

// Agent integration and the Robotics client against a scripted server: which
// tools an agent gets, what each asks of the Action Engine, and what a model
// is told about a robot afterwards. No robot, simulator or server runs here.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: globalThis.localStorage, confirm: vi.fn(() => true) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("../services/DesktopBridge", () => ({ getDesktopBridge: () => null }));
vi.mock("../services/DeviceTasks", () => ({ DeviceTasks: { requestApproval: async () => null } }));
let signedIn = true;
vi.mock("../services/api", async (original) => ({ ...(await original<typeof import("../services/api")>()), isAccountSession: () => signedIn, usesBearerSession: () => false }));

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let respond: (call: Call) => unknown = () => ({});
vi.mock("../services/Account", () => ({
  accountRequest: async (path: string, init: RequestInit = {}) => {
    const call = { path, method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result;
  },
}));

const { Robotics, getRobotTools, ROBOT_TOOL_NAMES } = await import("../services/Robotics");
const { ApprovalCenter } = await import("../services/ApprovalCenter");
const { SPECIALISTS, activeSpecialists } = await import("../services/SpecialistAgents");
const { selectToolsForRequest } = await import("../services/AgentRouter");
const { getDeviceTools } = await import("../services/DeviceTools");
const { HITLDeniedError } = await import("../services/SafetyGuard");
const { screenForLocation, pathForScreen } = await import("../routes");

const robot = (extra: Record<string, unknown> = {}) => ({ id: "rb_1", name: "Rover", status: "enrolled", simulated: true, simulator: "hannah-kinematic", connection: "online", online: true, ...extra });
const record = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "act-1", action: "robots.navigate_to", service: "robots", kind: "write", status, executor: "server", request: "", intent: "", agent: "Robot agent", source: "chat", taskId: null, resource: { type: "robot", id: "rb_1" }, account: "Rover",
  preview: { title: "Start a mission: Rover drives to workbench (3.1, 1.9)", lines: [{ label: "Robot", value: "Rover — SIMULATION (hannah-kinematic)" }], warnings: [] },
  permission: { outcome: "ask", reason: "Robots is set to Approval before action." }, approval: null, response: null, verification: null, error: null,
  outcome: `outcome for ${status}`, final: status !== "waiting-approval", createdAt: 1, updatedAt: 1, executedAt: null, expiresAt: null, ...extra,
});
const mission = (status: string, extra: Record<string, unknown> = {}) => ({ id: "ms_1", robotId: "rb_1", robotName: "Rover", capability: "navigate_to", title: "Drive to a place", params: { x: 3.1, y: 1.9 }, status, final: !["queued", "sent", "accepted"].includes(status), summary: `Drive to a place: ${status}.`, verification: null, error: null, progress: null, ...extra });
const tool = (name: string) => getRobotTools().find((item) => item.name === name)!;
async function withRobots(robots: unknown[]) {
  respond = (call) => (call.path === "/api/robots" ? { robots, canEnroll: true, onlineWithinS: 12 } : {});
  await Robotics.list();
  calls.length = 0;
}
function host(answer: boolean) {
  const seen: string[] = [];
  const detach = ApprovalCenter.attachHost((requests) => { for (const request of requests) { seen.push(request.message); queueMicrotask(() => ApprovalCenter.respond(request.id, answer)); } });
  return { seen, detach };
}

beforeEach(async () => { signedIn = true; await withRobots([robot()]); });

describe("robot tools and the Robot Agent", () => {
  it("are offered only to an account that has an enrolled robot", async () => {
    expect(getRobotTools().map((item) => item.name)).toEqual(ROBOT_TOOL_NAMES);
    expect(getDeviceTools().some((item) => item.name === "robot_navigate")).toBe(true);
    expect(activeSpecialists().some((agent) => agent.id === "robot")).toBe(true);
    await withRobots([robot({ status: "pending" }), robot({ id: "rb_2", status: "revoked" })]);
    expect(getRobotTools()).toEqual([]);
    expect(getDeviceTools().some((item) => item.name.startsWith("robot_"))).toBe(false);
    expect(activeSpecialists().some((agent) => agent.id === "robot")).toBe(false);
    await withRobots([robot()]);
    // Signing out empties the list (the app refreshes it on every account change).
    signedIn = false;
    await Robotics.refresh();
    expect(getRobotTools()).toEqual([]);
  });

  it("three robot agents share the robot tools between them, and none has a tool that could bypass the engine", async () => {
    const agents = SPECIALISTS.filter((item) => item.id.startsWith("robot"));
    expect(agents.map((item) => item.id)).toEqual(["robot", "robot_fleet", "robot_arm", "robot_care"]);
    expect([...new Set(agents.flatMap((item) => item.tools))].sort()).toEqual([...ROBOT_TOOL_NAMES].sort());
    for (const agent of agents) {
      expect(agent.tools.some((name) => /desktop_|write_|run_command|external/.test(name))).toBe(false);
      expect(agent.tools.every((name) => name.startsWith("robot_"))).toBe(true);
    }
    const mission = agents[0];
    expect(mission.instructions).toMatch(/cannot override either/);
    expect(mission.instructions).toMatch(/not an emergency stop/);
    expect(mission.instructions).toMatch(/a room name the robot doesn't have is not a place/);
    // The care agent reads; it has nothing that moves a robot.
    const care = agents[3];
    expect(care.tools.some((name) => /navigate|dock|inspect|assign|resume|set_device|arm_move|grasp|release/.test(name))).toBe(false);
    expect(care.instructions).toMatch(/never what the object is/);
    for (const item of getRobotTools()) expect(JSON.stringify(item.inputSchema)).not.toMatch(/pwm|velocity|torque|wheel|motor/i);
    // The fleet agent needs more than one robot.
    expect(activeSpecialists().map((item) => item.id).filter((id) => id.startsWith("robot"))).toEqual(["robot", "robot_care"]);
    await withRobots([robot(), robot({ id: "rb_2", name: "Tug" })]);
    expect(activeSpecialists().some((item) => item.id === "robot_fleet")).toBe(true);
  });

  it("a request about a robot brings the tools it needs, always with a way to stop, and never more than the model may be given", () => {
    const pick = (request: string) => selectToolsForRequest(getDeviceTools(), request).map((item) => item.name);
    const always = ["robot_stop", "robot_cancel", "robot_pause", "robot_list", "robot_wait_for_mission"];
    const move = pick("Move the robot to the workbench");
    expect(move).toEqual(expect.arrayContaining([...always, "robot_navigate", "robot_destinations", "robot_state"]));
    expect(move).not.toContain("robot_diagnostics");
    expect(pick("Assign the available robot to inspect Zone B")).toEqual(expect.arrayContaining([...always, "robot_assign", "robot_fleet", "robot_inspect"]));
    expect(pick("Show me all connected robots and their health status")).toEqual(expect.arrayContaining(["robot_fleet", "robot_stop"]));
    // A question that also brings this device's own battery tools fills the limit; what is cut is never stop, pause or cancel.
    expect(pick("Check the robot battery")).toEqual(expect.arrayContaining(["robot_stop", "robot_pause", "robot_cancel", "robot_list", "robot_battery"]));
    expect(pick("Is there an obstacle near the robot?")).toEqual(expect.arrayContaining(["robot_surroundings", "robot_stop"]));
    expect(pick("Stop the current mission")).toEqual(expect.arrayContaining(["robot_stop", "robot_cancel"]));
    for (const request of ["Move the robot to the workbench", "Assign the available robot to inspect Zone B and check its battery and sensors", "robot fleet battery obstacle patrol beacon mission"]) expect(pick(request).length).toBeLessThanOrEqual(20);
    expect(pick("robot fleet battery obstacle patrol beacon mission")).toContain("robot_stop");
    expect(pick("What's the weather tomorrow?").some((name) => name.startsWith("robot_"))).toBe(false);
  });

  it("moving a robot is asked of the engine, approved on the card, and reported as started, not as arrived", async () => {
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval") } : { record: record("done", { response: { missionId: "ms_1", status: "accepted" }, verification: { confirmed: true, evidence: "Rover accepted mission ms_1 and is carrying it out." } }) });
    const screen = host(true);
    const result = await tool("robot_navigate").execute({ robot: "Rover", place: "workbench", maxSpeed: "0.3" }) as Record<string, unknown>;
    screen.detach();
    expect(calls[0]).toMatchObject({ path: "/api/actions", method: "POST", body: { action: "robots.navigate_to", params: { robot: "Rover", place: "workbench", maxSpeed: 0.3 }, agent: "Robot agent" } });
    expect(screen.seen[0]).toContain("Start a mission: Rover drives to workbench (3.1, 1.9)?");
    expect(screen.seen[0]).toContain("Robot: Rover — SIMULATION (hannah-kinematic)");
    expect(calls[1]).toMatchObject({ path: "/api/actions/act-1/decision", body: { approve: true } });
    expect(result).toMatchObject({ status: "done", missionId: "ms_1" });
    expect(result.next).toMatch(/only been told to start\. Call robot_wait_for_mission/);
  });

  it("a refusal, a decline and a wait for approval are each said as they are", async () => {
    respond = () => ({ record: record("denied", { outcome: "Not allowed: Start a mission. The goal (40, 0) is outside the robot's allowed workspace." }) });
    const refused = await tool("robot_navigate").execute({ x: 40, y: 0 }) as Record<string, unknown>;
    expect(refused).toMatchObject({ status: "denied", note: "It did NOT happen. Tell the user exactly this outcome." });
    expect(refused.missionId).toBeUndefined();

    respond = (call) => ({ record: record(call.path === "/api/actions" ? "waiting-approval" : "declined") });
    const screen = host(false);
    await expect(tool("robot_return_to_dock").execute({})).rejects.toBeInstanceOf(HITLDeniedError);
    screen.detach();

    // No screen to show the card on: it stays waiting, and the model is told it hasn't happened.
    respond = () => ({ record: record("waiting-approval") });
    expect(await tool("robot_inspect").execute({ places: ["door", "dock"] })).toMatchObject({ status: "waiting-approval", note: expect.stringMatching(/has NOT happened/) });
    expect(calls.at(-1)!.body).toMatchObject({ action: "robots.inspect_area", params: { waypoints: [{ place: "door" }, { place: "dock" }] } });
  });

  it("stopping is asked at once and its confirmation is passed on as given", async () => {
    respond = () => ({ record: record("unverified", { action: "robots.stop_motion", outcome: "Stop Rover: the service accepted it, but HANNAH couldn't confirm the result. Rover is offline, so the stop couldn't be delivered." }) });
    const result = await tool("robot_stop").execute({ robot: "Rover", reason: "someone walked in" }) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ action: "robots.stop_motion", params: { robot: "Rover", reason: "someone walked in" } });
    expect(result.status).toBe("unverified");
    expect(result.note).toMatch(/could not be confirmed\. Do not say it is done/);
    expect(tool("robot_stop").description).toMatch(/NOT an emergency stop/);
  });

  it("watching a mission reports only a verified arrival as an arrival", async () => {
    const sequence = [mission("accepted", { progress: { distanceRemaining: 2.1 } }), mission("succeeded", { verification: { confirmed: true, evidence: "The robot's localization (odometry) reports (3.05, 1.88), 0.05 m from the goal, standing still." } })];
    respond = () => ({ mission: sequence.shift() });
    vi.useFakeTimers();
    const watching = tool("robot_wait_for_mission").execute({ missionId: "ms_1", seconds: 30 });
    await vi.advanceTimersByTimeAsync(1500);
    const done = await watching as Record<string, unknown>;
    vi.useRealTimers();
    expect(done).toMatchObject({ status: "succeeded", finished: true, verified: true });
    expect(done.evidence).toMatch(/0\.05 m from the goal, standing still/);
    expect(done.note).toBeUndefined();

    respond = () => ({ mission: mission("unverified", { verification: { confirmed: false, evidence: "…2.24 m from the goal: further than the 0.25 m allowed." } }) });
    expect(await tool("robot_wait_for_mission").execute({ missionId: "ms_1" })).toMatchObject({ status: "unverified", verified: false, note: "The mission did NOT succeed. Tell the user this status and reason." });
    respond = () => ({ mission: mission("lost", { error: "The robot accepted the mission and then stopped reporting. Its outcome is unknown." }) });
    expect(await tool("robot_wait_for_mission").execute({ missionId: "ms_1" })).toMatchObject({ status: "lost", verified: false, reason: expect.stringMatching(/outcome is unknown/) });
  });

  it("arm tools ask the engine for a target, an object or a release, and the Manipulation agent exists only with an arm", async () => {
    expect(activeSpecialists().some((item) => item.id === "robot_arm")).toBe(false);
    await withRobots([robot({ id: "rb_arm", name: "Arm", robotType: "manipulator-arm", simulator: "hannah-arm-kinematic" })]);
    const agent = activeSpecialists().find((item) => item.id === "robot_arm")!;
    expect(agent.name).toBe("Manipulation");
    expect(agent.instructions).toMatch(/“closed on nothing” is a failure/);
    expect(agent.instructions).toMatch(/an object the user mentions that the robot doesn't report can't be grasped/);
    expect(agent.tools.some((name) => /navigate|dock|assign/.test(name))).toBe(false);
    respond = () => ({ record: record("waiting-approval", { action: "robots.move_robot_arm" }) });
    await tool("robot_arm_move").execute({ robot: "Arm", pose: "bin" });
    expect(calls.at(-1)!.body).toMatchObject({ action: "robots.move_robot_arm", params: { robot: "Arm", place: "bin" } });
    await tool("robot_arm_move").execute({ robot: "Arm", x: "0.55", y: 0.3 });
    expect(calls.at(-1)!.body).toMatchObject({ params: { robot: "Arm", x: 0.55, y: 0.3 } });
    await tool("robot_grasp").execute({ robot: "Arm", object: "red block" });
    expect(calls.at(-1)!.body).toMatchObject({ action: "robots.grasp_object", params: { robot: "Arm", object: "red block" } });
    const released = await tool("robot_release").execute({ robot: "Arm" }) as Record<string, unknown>;
    expect(calls.at(-1)!.body).toMatchObject({ action: "robots.release_object", params: { robot: "Arm" } });
    expect(released).toMatchObject({ status: "waiting-approval", note: expect.stringMatching(/has NOT happened/) });
    for (const name of ["robot_arm_move", "robot_grasp", "robot_release"]) expect(JSON.stringify(tool(name).inputSchema)).not.toMatch(/joint|torque|angle|velocity/i);
    const picked = selectToolsForRequest(getDeviceTools(), "Pick up the red block with the arm and put it in the bin").map((item) => item.name);
    expect(picked).toEqual(expect.arrayContaining(["robot_stop", "robot_arm_move", "robot_grasp", "robot_release", "robot_state", "robot_wait_for_mission"]));
    expect(picked.length).toBeLessThanOrEqual(20);
  });

  it("a plan of several steps is asked of the engine as one action, approved on the card, and reported as started; watching it reports each step as it ended", async () => {
    const preview = { title: "Run a plan on Rover: Go to workbench and come back", lines: [{ label: "Robot", value: "Rover — SIMULATION (hannah-kinematic)" }, { label: "Step 1", value: "drive to workbench (3, 2)" }, { label: "Step 2", value: "return to the dock" }], warnings: [] };
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval", { action: "robots.run_plan", preview }) } : { record: record("done", { action: "robots.run_plan", response: { planId: "pl_1", status: "running" }, verification: { confirmed: true, evidence: "Plan started." } }) });
    const screen = host(true);
    const started = await tool("robot_run_plan").execute({ robot: "Rover", template: "go_and_return", inputs: { place: "workbench" } }) as Record<string, unknown>;
    screen.detach();
    expect(calls[0]).toMatchObject({ path: "/api/actions", body: { action: "robots.run_plan", params: { robot: "Rover", template: "go_and_return", inputs: { place: "workbench" } } } });
    // The person approving sees every step.
    expect(screen.seen[0]).toContain("Step 1: drive to workbench (3, 2)");
    expect(screen.seen[0]).toContain("Step 2: return to the dock");
    expect(started).toMatchObject({ status: "done", planId: "pl_1" });
    expect(started.next).toMatch(/only started\. Call robot_plan/);

    const step = (n: number, status: string, extra: Record<string, unknown> = {}) => ({ n, capability: "navigate_to", title: "Drive", text: n === 1 ? "drive to workbench (3, 2)" : n === 2 ? "read the environment sensor" : "return to the dock", kind: n === 2 ? "observation" : "mission", status, params: {}, missionId: null, startedAt: null, finishedAt: null, output: null, evidence: null, error: null, ...extra });
    respond = () => ({ plan: { id: "pl_1", robotId: "rb_1", robotName: "Rover", title: "Round", template: null, status: "failed", final: true, cursor: 2, priority: 3, error: "No path.", startBy: 0, createdAt: 0, startedAt: 0, finishedAt: 1, summary: "Plan “Round”: stopped at step 3 of 3 (return to the dock). No path.", steps: [step(1, "succeeded", { evidence: "0.02 m from the goal, standing still." }), step(2, "succeeded", { evidence: "The environment sensor reported temperatureC 21.4.", output: { kind: "simulation", at: 5, reading: { temperatureC: 21.4 } } }), step(3, "failed", { error: "No path." })] } });
    const watched = await tool("robot_plan").execute({ planId: "pl_1", seconds: 5 }) as { status: string; finished: boolean; note: string; steps: Array<Record<string, unknown>> };
    expect(watched).toMatchObject({ status: "failed", finished: true });
    expect(watched.note).toMatch(/did NOT finish/);
    expect(watched.steps[1]).toMatchObject({ status: "succeeded", recorded: { kind: "simulation", reading: { temperatureC: 21.4 } } });
    expect(watched.steps[2]).toMatchObject({ status: "failed", reason: "No path." });
    expect(watched.steps[0].recorded).toBeUndefined();

    // Cancelling a plan is asked at once, like stopping.
    calls.length = 0;
    respond = () => ({ record: record("done", { action: "robots.cancel_plan", permission: { outcome: "allow", code: "deescalates", reason: "Stopping is always allowed." }, response: { planId: "pl_1", status: "cancelled" } }) });
    await tool("robot_cancel_plan").execute({ robot: "Rover" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/actions", body: { action: "robots.cancel_plan", params: { robot: "Rover" } } });
    // The tools for it arrive with a request that sounds like a plan, with stop still there and the limit kept.
    const pick = (request: string) => selectToolsForRequest(getDeviceTools(), request).map((item) => item.name);
    expect(pick("Send the robot to the workbench and then come back")).toEqual(expect.arrayContaining(["robot_run_plan", "robot_plan", "robot_templates", "robot_cancel_plan", "robot_stop"]));
    expect(pick("How has the robot fleet been doing? Show the success rate")).toEqual(expect.arrayContaining(["robot_analytics", "robot_stop"]));
    for (const request of ["Send the robot to the workbench and then come back", "robot plan inspection route fleet battery obstacle statistics arm gripper beacon"]) {
      expect(pick(request).length).toBeLessThanOrEqual(20);
      expect(pick(request)).toEqual(expect.arrayContaining(["robot_stop", "robot_cancel", "robot_pause"]));
    }
  });

  it("a picture is asked of the engine and approved; the agent gets detections, not the picture, and a refusal says how to switch the camera on", async () => {
    const preview = { title: "Take a picture: Rover takes one picture with its camera", lines: [{ label: "Robot", value: "Rover — SIMULATION (hannah-kinematic)" }, { label: "Kept for", value: "24 hours, then deleted" }, { label: "Who can see it", value: "Only this account. Every viewing is logged" }], warnings: [] };
    const detection = { label: "red region", colour: "red", confidence: 0.82, distanceM: 1.2, model: "hannah-colour-regions", sensor: "camera", frame: 3, capturedAt: 5 };
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval", { action: "robots.capture_image", preview }) } : { record: record("done", { action: "robots.capture_image", response: { imageId: "im_1", status: "succeeded", detections: [detection], note: "1 coloured region detected." }, verification: { confirmed: true, evidence: "A 64×48 image arrived." } }) });
    const screen = host(true);
    const taken = await tool("robot_capture_image").execute({ robot: "Rover" }) as Record<string, unknown>;
    screen.detach();
    expect(calls[0]).toMatchObject({ path: "/api/actions", body: { action: "robots.capture_image", params: { robot: "Rover" } } });
    expect(screen.seen[0]).toContain("Kept for: 24 hours, then deleted");
    expect(screen.seen[0]).toContain("Every viewing is logged");
    expect(taken).toMatchObject({ status: "done" });
    expect(JSON.stringify(taken)).toContain("red region");
    expect(JSON.stringify(taken)).not.toContain("data:image");
    // Camera use switched off: the refusal is passed on as given, with nothing sent for approval.
    calls.length = 0;
    respond = () => ({ record: record("denied", { action: "robots.capture_image", permission: { outcome: "deny", code: "forbidden", reason: "Camera use is switched off for Rover. A signed-in person can switch it on under Robots → Camera." }, outcome: "Not allowed: Camera use is switched off for Rover. A signed-in person can switch it on under Robots → Camera." }) });
    const refused = await tool("robot_capture_image").execute({ robot: "Rover" }).catch((error: Error) => ({ error: error.message })) as Record<string, unknown>;
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(refused)).toMatch(/Camera use is switched off for Rover/);
    // The tool descriptions keep the model from naming things it can't know.
    expect(tool("robot_capture_image").description).toMatch(/cannot say what an object is and never who a person is/);
    expect(tool("robot_camera").description).toMatch(/An old picture is what the camera saw then/);
    const pick = (request: string) => selectToolsForRequest(getDeviceTools(), request).map((item) => item.name);
    expect(pick("What can the robot see with its camera?")).toEqual(expect.arrayContaining(["robot_capture_image", "robot_camera", "robot_surroundings", "robot_stop"]));
    expect(pick("What can the robot see with its camera?").length).toBeLessThanOrEqual(20);
    // The read-only care agent can read what was seen but can't take a picture.
    const care = SPECIALISTS.find((agent) => agent.id === "robot_care")!;
    expect(care.tools).toContain("robot_camera");
    expect(care.tools).not.toContain("robot_capture_image");
    for (const agent of SPECIALISTS.filter((item) => item.id.startsWith("robot"))) expect(agent.tools.length).toBeLessThanOrEqual(20);
  });

  it("the Robots screen has its own address", () => {
    expect(pathForScreen("robotics")).toBe("/robotics");
    expect(screenForLocation({ pathname: "/robotics", hash: "" })).toBe("robotics");
    expect(screenForLocation({ pathname: "/robots", hash: "" })).toBe("robotics");
  });
});
