export type RobotsOptions = { baseUrl: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number; agent?: string };
export type Point = { x: number; y: number; yaw?: number };
export type Goal = { place?: string; x?: number; y?: number; yaw?: number; maxSpeed?: number };
export type ActionStatus = "done" | "waiting-approval" | "denied" | "failed" | "unverified" | "declined" | "expired" | "cancelled" | "suggested" | "running";
/** What the Action Engine recorded for a request. "done" for a movement means the robot accepted it, not that it arrived. */
export type ActionRecord<Response = Record<string, unknown>> = {
  id: string; action: string; status: ActionStatus; outcome?: string; error: string | null;
  permission: { outcome: "allow" | "ask" | "deny"; code?: string; reason: string };
  preview?: { title: string; lines: Array<{ label: string; value: string }>; body?: string; warnings?: string[] };
  response: Response | null; verification: { confirmed: boolean; evidence: string } | null; final?: boolean;
};
export type MissionStatus = "queued" | "sent" | "accepted" | "paused" | "succeeded" | "unverified" | "failed" | "cancelled" | "rejected" | "expired" | "timed-out" | "lost";
export type Mission = { id: string; robotId: string; robotName: string | null; capability: string; title: string; params: Record<string, unknown>; status: MissionStatus; final: boolean; summary: string; planId: string | null; actionId: string | null; createdAt: number; acceptedAt: number | null; finishedAt: number | null; progress: Record<string, unknown> | null; result: Record<string, unknown> | null; verification: { confirmed: boolean; evidence: string } | null; error: string | null };
export type PlanStepInput = { do: string } & Record<string, unknown>;
export type PlanInput = { template?: "go_and_return" | "inspection_route" | "pick_and_place" | "status_report"; inputs?: Record<string, unknown>; steps?: PlanStepInput[]; title?: string; priority?: number; startWithinMinutes?: number };
export type PlanStep = { n: number; capability: string; text: string; kind: "mission" | "observation"; status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped"; missionId: string | null; output: Record<string, unknown> | null; evidence: string | null; error: string | null };
export type Plan = { id: string; robotId: string; robotName: string | null; title: string; template: string | null; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired"; final: boolean; cursor: number; steps: PlanStep[]; summary: string; error: string | null };
export type Robot = { id: string; name: string; status: "pending" | "enrolled" | "revoked"; simulated: boolean; simulator: string | null; connection: string; online: boolean; mode: string; capabilities: string[]; places: Record<string, Point>; sensors: Array<{ id: string; type: string; description: string; frame?: string; rateHz?: number }>; state: Record<string, unknown> | null; stateAgeS: number | null; camera: { enabled: boolean; retentionHours: number; cameras: string[] } } & Record<string, unknown>;
export type Reading = { robot: string; online: boolean; stale: boolean; ageS: number | null } & Record<string, unknown>;

export class HannahRobotsError extends Error {
  status?: number;
  reason?: string;
  body?: unknown;
}

export class HannahRobots {
  constructor(options: RobotsOptions);
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  act<Response = Record<string, unknown>>(action: string, params?: Record<string, unknown>, options?: { request?: string }): Promise<ActionRecord<Response>>;
  read<Response = Record<string, unknown>>(action: string, params?: Record<string, unknown>): Promise<Response>;

  list(): Promise<Robot[]>;
  get(robotId: string): Promise<{ robot: Robot; missions: Mission[]; events: unknown[] }>;
  contract(): Promise<{ capabilities: Array<Record<string, unknown>> } & Record<string, unknown>>;
  fleet(): Promise<Array<Record<string, unknown>>>;
  analytics(days?: number): Promise<Record<string, unknown>>;
  events(robotId?: string, limit?: number): Promise<Array<{ id: string; robotId: string; at: number; type: string; severity: string; message: string; source: "robot" | "server" }>>;
  destinations(robotId: string): Promise<Record<string, unknown>>;
  diagnostics(robotId: string): Promise<Record<string, unknown>>;
  templates(robotId: string): Promise<Array<{ id: string; title: string; available: boolean; reason: string | null; inputs: Record<string, string> }>>;
  images(robotId: string): Promise<{ camera: Robot["camera"]; images: Array<Record<string, unknown>> }>;
  image(robotId: string, imageId: string): Promise<Record<string, unknown> & { dataUrl: string }>;

  state(robot: string): Promise<Reading>;
  battery(robot: string): Promise<Reading>;
  surroundings(robot: string): Promise<Reading>;
  sensor(robot: string, sensor: string): Promise<Reading>;
  armState(robot: string): Promise<Reading>;
  lastPicture(robot: string): Promise<Record<string, unknown>>;

  navigate(robot: string, goal?: Goal): Promise<ActionRecord<{ missionId: string; status: MissionStatus }>>;
  returnToDock(robot: string): Promise<ActionRecord<{ missionId: string; status: MissionStatus }>>;
  inspect(robot: string, waypoints: Goal[]): Promise<ActionRecord<{ missionId: string; status: MissionStatus }>>;
  assign(task: "navigate_to" | "return_to_dock" | "inspect_area", params?: Record<string, unknown>): Promise<ActionRecord<{ missionId: string }>>;
  moveArm(robot: string, target?: { place?: string; x?: number; y?: number }): Promise<ActionRecord<{ missionId: string }>>;
  grasp(robot: string, object: string): Promise<ActionRecord<{ missionId: string }>>;
  release(robot: string): Promise<ActionRecord<{ missionId: string }>>;
  capturePicture(robot: string, camera?: string): Promise<ActionRecord<{ imageId: string; detections: Array<Record<string, unknown>> }>>;
  runPlan(robot: string, plan?: PlanInput): Promise<ActionRecord<{ planId: string; status: Plan["status"] }>>;
  resume(robot: string, missionId?: string): Promise<ActionRecord<{ missionId: string }>>;

  stop(robot: string, reason?: string): Promise<ActionRecord<{ missionId: string; status: MissionStatus }>>;
  pause(robot: string, missionId?: string): Promise<ActionRecord<{ missionId: string }>>;
  cancelMission(robot: string, missionId?: string): Promise<ActionRecord<{ missionId: string }>>;
  cancelPlan(robot: string, planId?: string): Promise<ActionRecord<{ planId: string }>>;

  missions(filter?: { robot?: string; active?: boolean; limit?: number }): Promise<Mission[]>;
  mission(missionId: string): Promise<Mission>;
  plans(filter?: { robot?: string; active?: boolean; limit?: number }): Promise<Plan[]>;
  plan(planId: string): Promise<Plan>;
  action(actionId: string): Promise<ActionRecord>;
  waitForMission(missionId: string, options?: { seconds?: number; everyMs?: number }): Promise<Mission>;
  waitForPlan(planId: string, options?: { seconds?: number; everyMs?: number }): Promise<Plan>;
  waitForDecision(actionId: string, options?: { seconds?: number; everyMs?: number }): Promise<ActionRecord>;
}

export default HannahRobots;
