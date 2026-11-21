/**
 * The client side of HANNAH's robot registry (server/robotics).
 *
 * A robot never connects to this app. It runs HANNAH's robot runtime on its
 * own computer and talks to the server; this file reads the server's record of
 * it and asks for missions through the Action Engine, so every movement goes
 * through the same permission levels, approval and history as anything else
 * HANNAH does (services/Operator.ts).
 *
 * What is true of every answer here:
 *   - a robot's state says how old it is; an offline robot's state is marked
 *     stale, never shown as current;
 *   - starting a mission is confirmed when the robot accepts it; arriving is
 *     the mission's own result, verified from the robot's reported state;
 *   - "stop" is a software request to the robot's controller. It needs no
 *     approval and it is not an emergency stop.
 */
import { accountRequest } from "./Account";
import { isAccountSession } from "./api";
import type { HANNAHTool } from "./DeviceTools";
import { Operator, toolResult, type ActionRecord } from "./Operator";

export type Point = { x: number; y: number; yaw?: number };
export type RobotLimits = {
  maxLinearSpeed?: number; maxAngularSpeed?: number; maxLinearAccel?: number; maxJointSpeed?: number; minBatteryPercent?: number; linkTimeoutS?: number; commandTtlS: number; robotRadius?: number;
  workspaces: Array<{ frame: string; polygon: number[][] }>; keepOut: Array<{ name: string; polygon: number[][] }>;
  environment: string | null; estop: { hardware: boolean; description: string } | null; motionRequiresApproval: boolean;
};
export type RobotState = {
  at?: number; receivedAt?: number; mode: string;
  pose?: (Point & { frame?: string; source?: string }) | null; velocity?: { linear: number; angular: number } | null;
  battery?: { percent: number; charging?: boolean } | null; estop?: { engaged: boolean; source?: string } | null; motorsEnabled?: boolean; localized?: boolean; docked?: boolean;
  faults?: Array<{ code: string; message: string; at?: number }>;
  sensors?: Record<string, Record<string, unknown> & { ok?: boolean; ranges?: number[]; minRange?: number }>;
  devices?: Record<string, string>;
  mission?: { id: string; capability: string; phase?: string; distanceRemaining?: number | null; secondsLeft?: number } | null;
  nav?: { goal?: Point | null; path?: number[][]; status?: string };
  perception?: Perception;
  arm?: { points: number[][]; target: Point | null; status: string };
  gripper?: { open: boolean; holding: string | null };
  scene?: { source: string; objects: Array<{ id: string; x: number; y: number; held: boolean }> };
  map?: { coveragePercent?: number; discovered?: number[][] };
  link?: { ok: boolean; silentS: number; timeoutS: number };
  sim?: { kind: string; timeFactor?: number; truth?: Point; odometryError?: number };
};
export type Robot = {
  id: string; name: string; status: "pending" | "enrolled" | "revoked"; simulated: boolean; simulator: string | null;
  connection: "awaiting-enrollment" | "revoked" | "online" | "offline" | "never-connected"; online: boolean; lastSeenAt: number | null; mode: string;
  manufacturer?: string; model?: string; robotType?: string; category?: string; os?: string; compute?: string; rosDistro?: string; protocols?: string[];
  softwareVersion?: string; firmwareVersion?: string; runtimeVersion?: string; adapter?: string; hostname?: string;
  sensors: Array<{ id: string; type: string; description: string; frame?: string; rateHz?: number; resolution?: string; messageType?: string; calibration?: string; manufacturer?: string; model?: string }>; actuators: Array<{ id: string; type: string; description: string }>;
  camera: CameraSetting;
  devices: Record<string, boolean>; places: Record<string, Point>; dock?: Point | null;
  world?: { name: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } | null; obstacles: Array<{ x: number; y: number; w: number; h: number }> } | null;
  network?: { transport: string; syncIntervalMs: number }; refusedCapabilities?: Array<{ id: string; reason: string }>;
  fingerprint?: string; serialNumber?: string; configVersion: number; mapName: string; commissioning: Commissioning; reportedPlaces: Record<string, Point>; staleDestinations: Destination[];
  capabilities: string[]; disabled: string[]; alwaysAsk: string[]; limits: RobotLimits; safety: { reported?: Record<string, unknown>; owner?: Record<string, unknown> };
  state: RobotState | null; stateAgeS: number | null; createdAt: number; enrolledAt: number | null; revokedAt: number | null; enrollmentExpiresAt: number | null;
};
export type Destination = Point & { name: string; source: "robot" | "robot-profile" | "owner"; map: string; frame: string; id?: string };
export type Destinations = { map: string | null; destinations: Destination[]; reported: Array<Point & { name: string; usable: boolean }>; stale: Destination[]; rule: string };
export type CommissioningStep = { id: string; title: string; detail: string; done: boolean; confirmedAt: number | null; note: string; available: boolean; check: { ok: boolean; problems: string[]; facts: string[] } };
export type Commissioning = { required: boolean; status: "not-required" | "required" | "in-progress" | "trial" | "approved"; done: number; total: number; trialSpeed: number | null; resetReason?: string | null; next?: string | null; steps?: CommissioningStep[] };
export type Detected = { kind: string; x: number; y: number; widthM: number; distanceM: number; bearingDeg: number; returns: number; confidence: number; sensor: string };
export type Perception = { measuredAt: number; sensor: string; source: string; obstaclesKnown: boolean; obstacles: Detected[]; route: { blocked: boolean | null; reason: string }; changes: Array<{ x: number; y: number; w: number; h: number; cells: number }>; sensorHealth: Array<{ id: string; ok: boolean; problem?: string }> };
export type Diagnostics = { robot: string; kind: string; online: boolean; stale: boolean; summary: string; basis: string; findings: Array<{ severity: "info" | "warning" | "error"; title: string; evidence: string; recommendation?: string }> };
export type FleetRow = { id: string; name: string; kind: string; type: string | null; connection: string; mode: string; map: string | null; position: Point | null; batteryPercent: number | null; charging: boolean | null; mission: { id: string; what: string; status: string } | null; available: boolean; health: "ok" | "attention" | "unknown"; problems: string[]; destinations: string[] };
export type MaintenanceEntry = { id: string; at: number; kind: string; note: string };
export type MissionStatus = "paused" | "queued" | "sent" | "accepted" | "succeeded" | "unverified" | "failed" | "cancelled" | "rejected" | "expired" | "timed-out" | "lost";
export type Mission = {
  id: string; robotId: string; robotName: string | null; capability: string; title: string; params: Record<string, unknown>; status: MissionStatus; final: boolean; summary: string;
  actionId: string | null; createdAt: number; expiresAt: number; acceptedAt: number | null; finishedAt: number | null; cancelRequestedAt: number | null; pauseRequestedAt: number | null; resumeRequestedAt: number | null; pausedAt: number | null;
  progress: { phase?: string; distanceRemaining?: number | null; travelled?: number } | null; result: Record<string, unknown> | null;
  verification: { confirmed: boolean; evidence: string } | null; error: string | null;
};
export type Detection = { label: string; colour: string; box: { x: number; y: number; w: number; h: number }; pixels: number; confidence: number; model: string; modelVersion: string; sensor: string; frame: number; capturedAt: number; bearingDeg: number; distanceM?: number; distanceSource?: string; position?: { x: number; y: number; frame: string; source: string } };
export type RobotImage = { id: string; robotId: string; missionId: string | null; at: number; bytes: number; expiresAt: number; sensor: string; frame: number | null; capturedAt: number; width: number; height: number; source: string; depth: string | null; kind: "simulation" | "physical"; detector: { model: string; version: string; kind: string; detects: string; cannot: string } | null; detections: Detection[]; dataUrl?: string };
export type CameraSetting = { enabled: boolean; retentionHours: number; cameras: string[] };
export type PlanStep = { n: number; capability: string; title: string; text: string; kind: "mission" | "observation"; status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped"; params: Record<string, unknown>; missionId: string | null; startedAt: number | null; finishedAt: number | null; output: Record<string, unknown> | null; evidence: string | null; error: string | null };
export type Plan = { id: string; robotId: string; robotName: string | null; title: string; template: string | null; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired"; final: boolean; cursor: number; priority: number; error: string | null; startBy: number; createdAt: number; startedAt: number | null; finishedAt: number | null; steps: PlanStep[]; summary: string };
export type PlanTemplate = { id: string; title: string; description: string; inputs: Record<string, string>; needs: string[]; available: boolean; reason: string | null };
type Figures = {
  missions: { started: number; ended: number; open: number; byOutcome: Record<string, number>; succeededVerified: number; successRate: number | null };
  plans: { ended: number; succeeded: number };
  durationS: { samples: number; median: number | null; longest: number | null };
  commandLatencyMs: { samples: number; median: number | null; p95: number | null };
  stopLatencyMs: { samples: number; median: number | null; longest: number | null };
  utilization: number | null; problems: Record<string, number>;
};
export type RobotFigures = Figures & { id: string; name: string; kind: "simulation" | "physical"; reporting: { samples: number; shareOfLastTwoHours: number }; battery: { fromPercent: number; toPercent: number; overMinutes: number; changePerHour: number | null } | null };
export type Analytics = { window: { days: number; from: number; to: number }; fleet: Figures & { robots: number; simulated: number; physical: number; onlineNow: number }; robots: RobotFigures[]; notes: string[] };
export type RobotEvent = { id: string; robotId: string; at: number; type: string; severity: "info" | "warning" | "error"; message: string; source: "robot" | "server" };
export type Capability = {
  id: string; title: string; description: string; status: "implemented" | "contract-only"; kind: string; motion: boolean; risk: string; riskLabel: string; deescalates?: boolean;
  robotTypes: string[]; preconditionText: string[]; constraints: string[]; timeoutS: { default: number; max: number }; cancel: { supported: boolean; behaviour: string }; verification: { method: string; description: string };
};
export type Enrollment = { robot: Robot; enrollment: { code: string; expiresAt: number }; command: string };
export type TelemetrySample = { at: number; x: number; y: number; v: number | null; battery: number | null; mode: string; estop: boolean };

export const ROBOTICS_EVENT = "hannah:robotics";
const HINT = "hannah.robots.v1";
const json = (value: unknown) => JSON.stringify(value);
const id = (value: string) => encodeURIComponent(value);
let known: Array<{ id: string; name: string; simulated: boolean; type?: string }> = [];
try { known = JSON.parse(globalThis.localStorage?.getItem(HINT) || "[]"); } catch { known = []; }

function remember(robots: Robot[]) {
  const next = robots.filter((robot) => robot.status === "enrolled").map((robot) => ({ id: robot.id, name: robot.name, simulated: robot.simulated, type: robot.robotType }));
  const changed = json(next) !== json(known);
  known = next;
  try { globalThis.localStorage?.setItem(HINT, json(known)); } catch { /* storage is a convenience */ }
  if (changed && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(ROBOTICS_EVENT));
}

export const Robotics = {
  available: () => isAccountSession(),
  /** Robots this account had enrolled when the list was last read: decides whether robot tools and the Robot Agent are offered. Emptied on sign-out (refresh). */
  known: () => known,
  async list() {
    const answer = await accountRequest<{ robots: Robot[]; canEnroll: boolean; onlineWithinS: number }>("/api/robots");
    remember(answer.robots);
    return answer;
  },
  /** Refresh the list in the background (after sign-in, on app start). Never throws. */
  refresh: async () => {
    if (!isAccountSession()) { remember([]); return; }
    await Robotics.list().catch(() => null);
  },
  get: (robotId: string) => accountRequest<{ robot: Robot; missions: Mission[]; events: RobotEvent[] }>(`/api/robots/${id(robotId)}`),
  contract: () => accountRequest<{ capabilities: Capability[]; robotTypes: Record<string, { label: string; category: string }>; environments: Record<string, string> }>("/api/robots/contract"),
  create: (name: string, simulated: boolean) => accountRequest<Enrollment>("/api/robots", { method: "POST", body: json({ name, simulated }) }),
  update: (robotId: string, change: { name?: string; limits?: Record<string, unknown>; disabled?: string[]; alwaysAsk?: string[]; camera?: { enabled?: boolean; retentionHours?: number } }) => accountRequest<{ robot: Robot }>(`/api/robots/${id(robotId)}`, { method: "PATCH", body: json(change) }),
  newCode: (robotId: string) => accountRequest<Enrollment>(`/api/robots/${id(robotId)}/enrollment`, { method: "POST" }),
  revoke: (robotId: string) => accountRequest<{ robot: Robot }>(`/api/robots/${id(robotId)}/revoke`, { method: "POST" }),
  remove: async (robotId: string) => { const answer = await accountRequest<{ removed: boolean }>(`/api/robots/${id(robotId)}`, { method: "DELETE" }); await Robotics.refresh(); return answer; },
  /** Stop a robot now. Never needs approval. A software request, not an emergency stop. */
  stop: (robotId: string, reason = "Stop pressed in the app") => accountRequest<{ record: ActionRecord; mission: Mission | null }>(`/api/robots/${id(robotId)}/stop`, { method: "POST", body: json({ reason }), signal: AbortSignal.timeout(30_000) }),
  missions: async (robotId?: string, limit = 25) => (await accountRequest<{ missions: Mission[] }>(`/api/robots/missions?limit=${limit}${robotId ? `&robot=${id(robotId)}` : ""}`)).missions,
  mission: async (missionId: string) => (await accountRequest<{ mission: Mission }>(`/api/robots/missions/${id(missionId)}`)).mission,
  cancel: async (missionId: string) => (await accountRequest<{ mission: Mission }>(`/api/robots/missions/${id(missionId)}/cancel`, { method: "POST" })).mission,
  /** Pause never needs approval. Resume moves the robot again: its record may come back waiting for one. */
  pause: (missionId: string) => accountRequest<{ record: ActionRecord; mission: Mission }>(`/api/robots/missions/${id(missionId)}/pause`, { method: "POST", signal: AbortSignal.timeout(30_000) }),
  resume: (missionId: string) => accountRequest<{ record: ActionRecord; mission: Mission }>(`/api/robots/missions/${id(missionId)}/resume`, { method: "POST", signal: AbortSignal.timeout(30_000) }),
  commissioning: async (robotId: string) => (await accountRequest<{ commissioning: Commissioning }>(`/api/robots/${id(robotId)}/commissioning`)).commissioning,
  confirmStep: async (robotId: string, step: string, note: string) => (await accountRequest<{ commissioning: Commissioning }>(`/api/robots/${id(robotId)}/commissioning/${id(step)}`, { method: "POST", body: json({ attest: true, note }) })).commissioning,
  withdrawCommissioning: async (robotId: string, reason: string) => (await accountRequest<{ commissioning: Commissioning }>(`/api/robots/${id(robotId)}/commissioning/reset`, { method: "POST", body: json({ reason }) })).commissioning,
  destinations: (robotId: string) => accountRequest<Destinations>(`/api/robots/${id(robotId)}/destinations`),
  addDestination: (robotId: string, destination: { name?: string; x?: number; y?: number; yaw?: number; fromPlace?: string }) => accountRequest<Destinations>(`/api/robots/${id(robotId)}/destinations`, { method: "POST", body: json(destination) }),
  removeDestination: (robotId: string, destinationId: string) => accountRequest<Destinations>(`/api/robots/${id(robotId)}/destinations/${id(destinationId)}`, { method: "DELETE" }),
  diagnostics: async (robotId: string) => (await accountRequest<{ diagnostics: Diagnostics }>(`/api/robots/${id(robotId)}/diagnostics`)).diagnostics,
  maintenance: async (robotId: string) => (await accountRequest<{ maintenance: MaintenanceEntry[] }>(`/api/robots/${id(robotId)}/maintenance`)).maintenance,
  addMaintenance: async (robotId: string, kind: string, note: string) => (await accountRequest<{ maintenance: MaintenanceEntry[] }>(`/api/robots/${id(robotId)}/maintenance`, { method: "POST", body: json({ kind, note }) })).maintenance,
  fleet: async () => (await accountRequest<{ robots: FleetRow[] }>("/api/robots/fleet")).robots,
  /** Ask HANNAH to choose a robot for a task. Throws with the reasons when none can take it. */
  assign: (task: "navigate_to" | "return_to_dock" | "inspect_area", params: Record<string, unknown>) => Operator.run("robots.assign", { task, ...params }, { request: "Assigned on the Robots screen", agent: "You", intent: "robots" }),
  /** A robot's stored pictures, without the image data. */
  images: (robotId: string) => accountRequest<{ camera: CameraSetting; images: RobotImage[] }>(`/api/robots/${id(robotId)}/images`),
  /** Open one picture. The server writes down that it was opened. */
  image: async (robotId: string, imageId: string) => (await accountRequest<{ image: RobotImage }>(`/api/robots/${id(robotId)}/images/${id(imageId)}`)).image,
  deleteImage: (robotId: string, imageId: string) => accountRequest<{ camera: CameraSetting; images: RobotImage[] }>(`/api/robots/${id(robotId)}/images/${id(imageId)}`, { method: "DELETE" }),
  plans: async (robotId?: string, limit = 12) => (await accountRequest<{ plans: Plan[] }>(`/api/robots/plans?limit=${limit}${robotId ? `&robot=${id(robotId)}` : ""}`)).plans,
  plan: async (planId: string) => (await accountRequest<{ plan: Plan }>(`/api/robots/plans/${id(planId)}`)).plan,
  templates: async (robotId: string) => (await accountRequest<{ templates: PlanTemplate[] }>(`/api/robots/${id(robotId)}/templates`)).templates,
  /** Ask for a plan: a template with its inputs, or explicit steps. The record says whether it started, waits for approval, or was refused and why. */
  runPlan: (robotId: string, plan: { template?: string; inputs?: Record<string, unknown>; steps?: Array<Record<string, unknown>>; title?: string }) => Operator.run("robots.run_plan", { robot: robotId, ...plan }, { request: "Plan started on the Robots screen", agent: "You", intent: "robots" }),
  /** Cancel a plan. Never needs approval. */
  cancelPlan: (planId: string) => accountRequest<{ record: ActionRecord; plan: Plan }>(`/api/robots/plans/${id(planId)}/cancel`, { method: "POST", signal: AbortSignal.timeout(30_000) }),
  analytics: async (days = 7) => (await accountRequest<{ analytics: Analytics }>(`/api/robots/analytics?days=${days}`)).analytics,
  /** Watch a plan until it ends or the time is up. */
  async waitForPlan(planId: string, seconds: number, signal?: AbortSignal) {
    const end = Date.now() + Math.max(1, Math.min(120, seconds)) * 1000;
    for (;;) {
      const plan = await Robotics.plan(planId);
      if (plan.final || Date.now() >= end || signal?.aborted) return plan;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  },
  telemetry: async (robotId: string, minutes = 15) => (await accountRequest<{ samples: TelemetrySample[] }>(`/api/robots/${id(robotId)}/telemetry?minutes=${minutes}`)).samples,
  events: async (robotId?: string) => (await accountRequest<{ events: RobotEvent[] }>(`/api/robots/events${robotId ? `?robot=${id(robotId)}` : ""}`)).events,
  /** Ask for a mission. The record says whether it started, waits for approval, or was refused and why. */
  ask: (action: "robots.navigate_to" | "robots.return_to_dock" | "robots.inspect_area" | "robots.set_supported_device_state" | "robots.resume_mission" | "robots.move_robot_arm" | "robots.grasp_object" | "robots.release_object" | "robots.capture_image", params: Record<string, unknown>, request = "Asked on the Robots screen") =>
    Operator.run(action, params, { request, agent: "You", intent: "robots" }),
  /** Watch a mission until it ends or the time is up. Returns it as it is then. */
  async waitFor(missionId: string, seconds: number, signal?: AbortSignal) {
    const end = Date.now() + Math.max(1, Math.min(120, seconds)) * 1000;
    for (;;) {
      const mission = await Robotics.mission(missionId);
      if (mission.final || Date.now() >= end || signal?.aborted) return mission;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  },
};

// ---------- tools for the Robot Agent and for chat ----------

const str = (value: unknown) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value));
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined);
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
const robotProp = { type: "string", description: "The robot's name or id from robot_list. Leave out when the account has exactly one robot." };
const MOVES = " This moves a robot. The user sees the robot, whether it is a SIMULATION or PHYSICAL, the goal and the limits, and approves it first unless one of their standing permissions covers that robot. The Safety Gateway refuses goals outside the robot's workspace or when the robot isn't ready, and says why: report that reason word for word and do not try a different goal on your own. A status of “done” means the robot ACCEPTED the mission and started; it has not arrived. Then call robot_wait_for_mission and report that result.";

type Props = HANNAHTool["inputSchema"]["properties"];
const mission = (name: string, action: string, description: string, properties: Props, required: string[], params: (args: Record<string, unknown>) => Record<string, unknown>): HANNAHTool => ({
  name, description: `${description}${MOVES}`, inputSchema: { type: "object", properties: { robot: robotProp, ...properties }, required }, asksUser: true,
  execute: async (args) => {
    const record = await Operator.perform(action, compact({ robot: str(args.robot), ...params(args) }), { agent: "Robot agent" });
    const result = toolResult(record) as Record<string, unknown>;
    const missionId = (record.response as { missionId?: string } | null)?.missionId;
    return record.status === "done" || record.status === "unverified" ? { ...result, missionId, next: "The robot has only been told to start. Call robot_wait_for_mission with this missionId before you tell the user where the robot is." } : result;
  },
});
const read = (name: string, action: string, description: string, properties: Props, params: (args: Record<string, unknown>) => Record<string, unknown>): HANNAHTool => ({
  name, description, inputSchema: { type: "object", properties }, execute: async (args) => toolResult(await Operator.perform(action, compact(params(args)), { agent: "Robot agent" })),
});

function control(name: string, action: string, description: string): HANNAHTool {
  return {
    name, description: `${description} Report whether the robot confirmed it; if the robot is offline it could not be delivered, and you must say that.`,
    inputSchema: { type: "object", properties: { robot: robotProp, missionId: { type: "string", description: "Leave out for the robot's current mission." } } },
    execute: async (args) => toolResult(await Operator.perform(action, compact({ robot: str(args.robot), mission: str(args.missionId) }), { agent: "Robot agent" })),
  };
}

const tools: HANNAHTool[] = [
  // First on purpose: if a request ever carries more tools than the model may be given, the ones cut are at the end.
  {
    name: "robot_stop",
    description: "Stop a robot now: cancel its mission and hold position. Never needs approval. It is a software request to the robot's controller, NOT an emergency stop: if a person is in danger, tell the user to press the robot's own emergency stop. Report whether the stop was confirmed by the robot's measured speed; if the robot is offline the stop could not be delivered, and you must say that.",
    inputSchema: { type: "object", properties: { robot: robotProp, reason: { type: "string" } } },
    execute: async (args) => toolResult(await Operator.perform("robots.stop_motion", compact({ robot: str(args.robot), reason: str(args.reason) }), { agent: "Robot agent" })),
  },
  mission("robot_arm_move", "robots.move_robot_arm", "Move a robot arm's tool to one of its named poses (use the exact name from robot_list) or to x and y in metres in the arm's base frame. The arm's own planner chooses the joint motion inside its joint limits and clear of collisions; you never send joint values. High risk: the user approves every arm motion, always.",
    { pose: { type: "string", description: "A named pose from robot_list." }, x: { type: "number" }, y: { type: "number" } }, [],
    (args) => ({ place: str(args.pose), x: num(args.x), y: num(args.y) })),
  mission("robot_grasp", "robots.grasp_object", "Close a robot arm's gripper on a named object from the objects the robot itself reports (robot_state lists them). The tool must already be at the object: move the arm there first. The gripper's own feedback decides whether anything was grasped; a gripper that closed on nothing is a failure, and you report it as one. Never assume an object can be grasped because it was mentioned or seen.",
    { object: { type: "string", description: "An object id exactly as robot_state reports it." } }, ["object"], (args) => ({ object: str(args.object) })),
  mission("robot_release", "robots.release_object", "Open a robot arm's gripper and let go of what it holds, where the tool is now.", {}, [], () => ({})),
  control("robot_pause", "robots.pause_mission", "Pause a robot's running mission: it holds where it is and keeps the mission. Never needs approval."),
  control("robot_cancel", "robots.cancel_mission", "Cancel a robot's mission: it stops where it is and the mission ends. Never needs approval. Use this for “cancel the mission”; use robot_stop for “stop the robot”."),
  {
    name: "robot_cancel_plan",
    description: "Cancel a robot's plan of several steps: the step in hand is cancelled on the robot, which holds where it is, and the remaining steps are not run. A plan still waiting is dropped. Never needs approval. Report whether the robot confirmed it.",
    inputSchema: { type: "object", properties: { robot: robotProp, planId: { type: "string", description: "Leave out for the robot's current plan." } } },
    execute: async (args) => toolResult(await Operator.perform("robots.cancel_plan", compact({ robot: str(args.robot), plan: str(args.planId) }), { agent: "Robot agent" })),
  },
  read("robot_list", "robots.list", "List the robots enrolled in the user's account: each one's name, whether it is a SIMULATION or a PHYSICAL robot, whether it is connected, what it can do (its capabilities), and the named places it knows. Call this first; never assume a robot or a capability exists.", {}, () => ({})),
  read("robot_state", "robots.state", "A robot's latest reported state: position, speed, mode, battery, emergency stop, faults, current mission. The answer says how old it is; if the robot is offline it is the last report, and you must say so rather than present it as current.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  read("robot_read_sensor", "robots.read_sensor", "The latest reading of one of a robot's registered sensors (ids from robot_list, for example lidar, odometry, bumper, battery).", { robot: robotProp, sensor: { type: "string" } }, (args) => ({ robot: str(args.robot), sensor: str(args.sensor) })),
  mission("robot_navigate", "robots.navigate_to", "Send a mobile robot to one of its named places (preferred: use the exact name from robot_list) or to x and y in metres on its map. The robot's own planner finds the path and avoids obstacles; you never send wheel or motor commands.",
    { place: { type: "string", description: "A named place from robot_list." }, x: { type: "number" }, y: { type: "number" }, yaw: { type: "number", description: "Final heading in radians (optional)." }, maxSpeed: { type: "number", description: "A lower speed for this trip, m/s (optional). It can't exceed the robot's limit." } }, [],
    (args) => ({ place: str(args.place), x: num(args.x), y: num(args.y), yaw: num(args.yaw), maxSpeed: num(args.maxSpeed) })),
  mission("robot_return_to_dock", "robots.return_to_dock", "Send a mobile robot back to its dock.", {}, [], () => ({})),
  mission("robot_inspect", "robots.inspect_area", "Have a mobile robot visit up to 12 points in order (named places or x and y) and record what its range sensor sees at each.",
    { places: { type: "array", items: { type: "string" }, description: "Named places, in order." }, points: { type: "array", items: { type: "object" }, description: "Or points on the map, each an object with x and y in metres." } }, [],
    (args) => ({ waypoints: [...(Array.isArray(args.places) ? args.places.map((place) => ({ place: str(place) })) : []), ...(Array.isArray(args.points) ? (args.points as Array<Record<string, unknown>>).map((point) => compact({ x: num(point.x), y: num(point.y) })) : [])] })),
  mission("robot_set_device", "robots.set_supported_device_state", "Switch one of a robot's listed on/off devices (for example its beacon). Only devices from robot_list; never motors or brakes.",
    { device: { type: "string" }, state: { type: "string", enum: ["on", "off"] } }, ["device", "state"], (args) => ({ device: str(args.device), state: str(args.state) })),
  read("robot_destinations", "robots.destinations", "The named destinations a robot can be sent to, each with its map, coordinate frame, position and who defined it. A room name is a place only if it is on this list for that robot: never assume a name has coordinates.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  read("robot_battery", "robots.battery", "A robot's battery: charge, whether it is charging, and the minimum it needs to start a mission. From its battery sensor only; if there is no reading, say so.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  read("robot_surroundings", "robots.surroundings", "What a robot's range sensor detects around it right now: obstacles with distance, bearing, size and a confidence, whether its route is blocked, what it has seen that isn't on its map, and which sensors are not reporting. These are sensor measurements; report them as measurements with their confidence, and when the answer says “unknown” (a sensor is down) say unknown, never “clear”. It cannot tell you what an object is.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  read("robot_fleet", "robots.fleet", "Every robot at once: connection, health, battery, position, current mission and whether it can take a task now, with the reason when it can't. Use for “show me my robots” and before assigning work.", {}, () => ({})),
  read("robot_diagnostics", "robots.diagnostics", "What the evidence says about one robot's condition: sensors not reporting, faults, battery, link losses, refused commands, missions that didn't finish, software versions, the last maintenance entry. Each finding carries its evidence. Report the findings and their evidence; do not add causes or predictions that aren't there.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  mission("robot_assign", "robots.assign", "Give a movement task to whichever robot can best take it: HANNAH picks the nearest robot that is connected, ready, commissioned if physical, not busy and has that destination on its own map. Use when the user doesn't name a robot (“assign the available robot to…”, “send a robot to…”). The answer names the robot chosen and why, and why each other robot wasn't. If none can take it, the tool fails with each robot's reason: tell the user those reasons.",
    { task: { type: "string", enum: ["navigate_to", "return_to_dock", "inspect_area"] }, place: { type: "string", description: "A destination name." }, x: { type: "number" }, y: { type: "number" }, places: { type: "array", items: { type: "string" }, description: "For inspect_area: destinations to visit, in order." } }, ["task"],
    (args) => ({ task: str(args.task) || "navigate_to", place: str(args.place), x: num(args.x), y: num(args.y), waypoints: Array.isArray(args.places) && args.places.length ? args.places.map((place) => ({ place: str(place) })) : undefined, robot: undefined })),
  {
    name: "robot_capture_image",
    description: "Take ONE picture with a robot's camera and get the coloured regions a detector finds in it: each with a colour, a confidence, its frame and capture time and, when the camera has depth, a distance and a position. You do not see the picture; you get the detections. The detector finds regions of colour: it cannot say what an object is and never who a person is, so say “a red region 1.2 m ahead, confidence 0.8”, never “a fire extinguisher” or “a person”. Camera use must have been switched on for that robot by the user; if it is off the tool is refused and you tell the user they can switch it on under Robots → Camera. The user approves each picture unless a standing permission covers it; a physical robot's camera always asks. Say when the camera is simulated.",
    inputSchema: { type: "object", properties: { robot: robotProp, camera: { type: "string", description: "The camera's sensor id. Leave out when the robot has one camera." } } }, asksUser: true,
    execute: async (args) => toolResult(await Operator.perform("robots.capture_image", compact({ robot: str(args.robot), camera: str(args.camera) }), { agent: "Robot agent" })),
  },
  read("robot_camera", "robots.camera", "What a robot's camera saw in the most recent picture it took on request: the detections with their confidence, and how old the picture is. An old picture is what the camera saw then, not what is there now: say its age. It never says what an object is. If there is no stored picture, say so; do not describe a scene.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  read("robot_templates", "robots.templates", "The plan templates and whether this robot can run each one (go to a place and come back, an inspection route, pick and place, a status report), with each template's inputs. A template the robot lacks the hardware for is listed as unavailable with the reason: say that reason, don't try it.", { robot: robotProp }, (args) => ({ robot: str(args.robot) })),
  {
    name: "robot_run_plan",
    description: "Run several steps in order on ONE simulated robot under one approval, for requests like “go to the kitchen and come back”, “inspect the workbench and the door and read the temperature at each”, “put the red block in the bin”. Give a template with its inputs (see robot_templates), or explicit steps. Each step is { do, ...inputs } where do is one of: navigate_to (place, or x and y), return_to_dock, inspect_area, set_supported_device_state (device, state), move_robot_arm (place, or x and y), grasp_object (object), release_object, and the observations report_surroundings, read_sensor (sensor), report_battery_state, report_robot_state, which are recorded from the robot's own report when the step is reached. There are no conditions or loops. The user sees every step before approving. The Safety Gateway checks every step now and again when it is sent; the plan stops at the first step that doesn't finish and verify, and nothing is retried. A physical robot is refused: its movements are approved one at a time, so use the single-step tools for it. A status of “done” means the plan STARTED (or is waiting for a busy robot); then call robot_plan with the planId to watch it, and report each step's own result. Never say a plan finished unless its status is “succeeded”.",
    inputSchema: { type: "object", properties: { robot: robotProp, template: { type: "string", enum: ["go_and_return", "inspection_route", "pick_and_place", "status_report"] }, inputs: { type: "object", description: "The template's inputs: { place } | { places, sensor? } | { object, to }." }, steps: { type: "array", items: { type: "object" }, description: "Explicit steps instead of a template, each { do, ...inputs }." }, title: { type: "string" } } }, asksUser: true,
    execute: async (args) => {
      const record = await Operator.perform("robots.run_plan", compact({ robot: str(args.robot), template: str(args.template), inputs: args.inputs && typeof args.inputs === "object" ? args.inputs : undefined, steps: Array.isArray(args.steps) && args.steps.length ? args.steps : undefined, title: str(args.title) }), { agent: "Robot agent" });
      const result = toolResult(record) as Record<string, unknown>;
      const planId = (record.response as { planId?: string } | null)?.planId;
      return record.status === "done" || record.status === "unverified" ? { ...result, planId, next: "The plan has only started. Call robot_plan with this planId and seconds to watch it before you tell the user what happened." } : result;
    },
  },
  {
    name: "robot_plan",
    description: "A plan's status and every step's outcome: what was verified, what each observation recorded (with its time and whether it is from a simulation), which step failed and why, and which steps were not run. With seconds, watches the plan until it ends (up to 90 per call; call again if it is still running). Report failed, cancelled and expired exactly as they are; observations are the robot's own reports, so quote them as such.",
    inputSchema: { type: "object", properties: { planId: { type: "string", description: "Leave out for the robot's current or latest plan." }, robot: robotProp, seconds: { type: "number", description: "How long to watch, up to 90. Leave out to read it once." } } },
    execute: async (args) => {
      const seconds = num(args.seconds);
      if (str(args.planId) && seconds) {
        const plan = await Robotics.waitForPlan(str(args.planId), Math.min(90, seconds));
        return { planId: plan.id, robot: plan.robotName, status: plan.status, finished: plan.final, summary: plan.summary, steps: plan.steps.map((step) => compact({ n: step.n, does: step.text, status: step.status, evidence: step.evidence ?? undefined, recorded: step.kind === "observation" ? step.output ?? undefined : undefined, reason: step.error ?? undefined })), note: plan.final ? (plan.status === "succeeded" ? undefined : "The plan did NOT finish. Tell the user this status, the step it stopped at and the reason.") : "Still running. Call robot_plan again with seconds, or tell the user it is still under way." };
      }
      return toolResult(await Operator.perform("robots.plan", compact({ plan: str(args.planId), robot: str(args.robot) }), { agent: "Robot agent" }));
    },
  },
  read("robot_analytics", "robots.analytics", "Figures about the robots from stored records for the last days (7 by default, at most 30): missions started and how they ended, the share verified as succeeded, how long missions took, command latency, how busy each robot was, problems recorded, battery change over the last two hours. Each figure says how many records it came from and is empty (null) when there are none: say “no data”, never 0% or 100%. Say which robots are simulations.", { days: { type: "number" } }, (args) => ({ days: num(args.days) })),
  {
    name: "robot_resume",
    description: `Carry on with a paused mission from where the robot stands.${MOVES}`,
    inputSchema: { type: "object", properties: { robot: robotProp, missionId: { type: "string" } } }, asksUser: true,
    execute: async (args) => toolResult(await Operator.perform("robots.resume_mission", compact({ robot: str(args.robot), mission: str(args.missionId) }), { agent: "Robot agent" })),
  },
  {
    name: "robot_wait_for_mission",
    description: "Watch a mission until it finishes (up to 90 seconds per call; call again if it is still running) and return how it ended. “succeeded” means the robot's reported position was checked against the goal. “unverified” means the robot said it succeeded but its state doesn't confirm it. Report failed, cancelled, rejected, timed-out, expired and lost exactly as they are, with the reason given; never say the robot arrived unless the status is “succeeded”.",
    inputSchema: { type: "object", properties: { missionId: { type: "string" }, seconds: { type: "number", description: "How long to watch, up to 90. Default 60." } }, required: ["missionId"] },
    execute: async (args) => {
      const watched = await Robotics.waitFor(str(args.missionId), Math.min(90, num(args.seconds) ?? 60));
      return {
        missionId: watched.id, robot: watched.robotName, status: watched.status, finished: watched.final, summary: watched.summary,
        verified: watched.verification?.confirmed ?? false, evidence: watched.verification?.evidence, reason: watched.error || undefined, progress: watched.final ? undefined : watched.progress,
        note: watched.final ? (watched.status === "succeeded" ? undefined : "The mission did NOT succeed. Tell the user this status and reason.") : "Still running. Call robot_wait_for_mission again, or tell the user it is still on its way.",
      };
    },
  },
];

/** Robot tools exist only for an account that has a robot: nobody else's prompts carry them. */
export function getRobotTools(): HANNAHTool[] {
  return Robotics.known().length ? tools : [];
}
export const ROBOT_TOOL_NAMES = tools.map((tool) => tool.name);
