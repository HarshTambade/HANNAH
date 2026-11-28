/**
 * The client side of the Safety and Autonomy Manager and teleoperation
 * (server/robotics/safety_manager.js, teleop.js).
 *
 * Every answer comes from the server's record of the robot. Modes and profiles
 * are software checks on the server and in the robot's runtime, not a certified
 * safety function, and nothing here replaces the robot's own emergency stop.
 *
 * Manual control: the screen sends the operator's input ten times a second
 * while the deadman (a held key, button or the on-screen pad) is down. Each
 * command carries a number that only goes up and lives 400 ms on the server;
 * the robot holds by itself when nothing fresh arrives. Letting go sends one
 * zero command and then nothing.
 */
import { accountRequest } from "./Account";

export type ModeId = "manual" | "assisted" | "supervised" | "mission" | "maintenance" | "safety_stop";
export type PolicyId = "read_only" | "suggest_only" | "approve_every" | "approved_missions" | "approved_low_risk";
export type Problem = { code: string; message: string };
export type Transition = { to: ModeId; label: string; allowed: boolean; reasons: Problem[] };
export type AuditEntry = { id: string; robotId: string | null; at: number; kind: string; actor: string; summary: string; detail: Record<string, unknown> | null };
export type PolicyRecord = { scope: string; scopeId: string; name: string; policy: PolicyId; missions: string[]; updatedBy: string; updatedAt: number };
export type PolicyView = {
  account: PolicyRecord | null; teams: Array<{ teamId: string; name: string; role: string; canSet: boolean; policy: PolicyRecord | null }>;
  effective: { policy: PolicyId; missions: string[]; sources: Array<{ scope: string; name?: string; policy: PolicyId }> };
  policies: Record<PolicyId, { label: string; rank: number; description: string }>; default: PolicyId; note: string;
};
export type SafetyProfile = {
  maxLinearSpeed?: number; maxAngularSpeed?: number; maxLinearAccel?: number; maxJointSpeed?: number; minBatteryPercent?: number; commsTimeoutS?: number;
  operatingArea?: { name: string; polygon: number[][] }; armWorkspace?: { name: string; polygon: number[][] }; geofences?: Array<{ name: string; polygon: number[][] }>;
  restrictedDestinations?: string[]; allowedDestinations?: string[]; allowedMissions?: string[];
  timeWindows?: Array<{ days: number[]; from: string; to: string; timeZone: string }>; allowedEnvironments?: string[]; requireHardwareEstop?: boolean;
  approval?: { motion: "always" | "policy"; capabilities: string[] }; teleop?: { maxLinearSpeed?: number; maxAngularSpeed?: number; deadmanMs?: number };
};
export type AutonomyView = {
  robotId: string; mode: ModeId; label: string; description: string; defaultMode: ModeId; modeChangedAt: number | null;
  reported: { mode: ModeId; seq: number | null; session: string | null; refusedSeq: number | null; refusedReason: string | null } | null; confirmed: boolean;
  modes: Array<{ id: ModeId; label: string; description: string; next: ModeId[] }>; transitions: Transition[];
  profile: SafetyProfile | null; hardwareLimits: Record<string, unknown>; limits: Record<string, unknown>; teleopLimits: TeleopLimits;
  policy: PolicyView; teleop: { id: string; operator: string; status: string } | null; audit: AuditEntry[]; capabilities: string[];
  estop: { engaged: boolean; hardware: boolean; note: string }; disclaimer: string;
};
export type TeleopLimits = { maxLinearSpeed?: number; maxAngularSpeed?: number; deadmanMs: number; commandTtlMs: number };
export type HandoffStep = { id: string; title: string; ok: boolean | null; detail?: string; at?: number };
export type TeleopSession = {
  id: string; robotId: string; operator: string; status: "activating" | "active" | "ended"; steps: HandoffStep[]; previousMode: string | null; limits: TeleopLimits;
  createdAt: number; activatedAt: number | null; endedAt: number | null; endReason: string | null;
  lastCommand: { seq: number; linear: number; angular: number; clamped: boolean; receivedAt: number; expiresAt: number } | null;
  link: { serverToRobotMs: number | null; deliveredSeq: number; ackedSeq: number; robotAckAgeMs: number | null; lastInputAgeMs: number | null; telemetryAgeS: number | null; robotOnline: boolean; robotApplied: { seq: number; linear: number; angular: number; holding: boolean; reason: string | null } | null };
  video: { available: boolean; reason: string };
};
export type TeleopView = { session: TeleopSession | null; robot: { id: string; name: string; simulated: boolean; operatingMode: ModeId; fingerprint: string | null }; steps: Array<{ id: string; title: string }>; limits: TeleopLimits };

const json = (value: unknown) => JSON.stringify(value);
const id = (value: string) => encodeURIComponent(value);

export const RobotSafety = {
  autonomy: async (robotId: string) => (await accountRequest<{ autonomy: AutonomyView }>(`/api/robots/${id(robotId)}/autonomy`)).autonomy,
  setMode: async (robotId: string, mode: ModeId, reason = "") => (await accountRequest<{ autonomy: AutonomyView }>(`/api/robots/${id(robotId)}/mode`, { method: "POST", body: json({ mode, reason }) })).autonomy,
  setProfile: async (robotId: string, profile: SafetyProfile) => (await accountRequest<{ autonomy: AutonomyView }>(`/api/robots/${id(robotId)}/safety-profile`, { method: "PUT", body: json({ profile }) })).autonomy,
  policy: async () => (await accountRequest<{ policy: PolicyView }>("/api/robots/autonomy-policy")).policy,
  setPolicy: async (policy: PolicyId, missions: string[] = []) => (await accountRequest<{ policy: PolicyView }>("/api/robots/autonomy-policy", { method: "PUT", body: json({ policy, missions }) })).policy,
  setTeamPolicy: async (teamId: string, policy: PolicyId, missions: string[] = []) => (await accountRequest<{ policy: PolicyView }>(`/api/robots/teams/${id(teamId)}/autonomy-policy`, { method: "PUT", body: json({ policy, missions }) })).policy,
  teleop: (robotId: string) => accountRequest<TeleopView>(`/api/robots/${id(robotId)}/teleop`),
  startTeleop: (robotId: string, confirm: { robotId: string; fingerprint?: string }) => accountRequest<TeleopView & { token: string }>(`/api/robots/${id(robotId)}/teleop`, { method: "POST", body: json({ confirm }) }),
  command: (robotId: string, sessionId: string, body: { token: string; seq: number; linear: number; angular: number }) =>
    accountRequest<{ accepted: boolean; seq: number; linear: number; angular: number; clamped: boolean; expiresAt: number; receivedAt: number }>(`/api/robots/${id(robotId)}/teleop/${id(sessionId)}/command`, { method: "POST", body: json(body), signal: AbortSignal.timeout(2000) }),
  endTeleop: (robotId: string, sessionId: string, reason = "ended by the operator") => accountRequest<TeleopView>(`/api/robots/${id(robotId)}/teleop/${id(sessionId)}/end`, { method: "POST", body: json({ reason }) }),
};

// ---------- input: keyboard, on-screen pad, gamepad ----------

export type Velocity = { linear: number; angular: number };
const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
const limitsOf = (limits: Pick<TeleopLimits, "maxLinearSpeed" | "maxAngularSpeed">) => ({ v: limits.maxLinearSpeed ?? 0, w: limits.maxAngularSpeed ?? 0 });

/** Arrow keys or WASD, at a fraction of the limits (the robot clamps again). Space is the deadman for the keyboard. */
export function velocityFromKeys(keys: ReadonlySet<string>, limits: Pick<TeleopLimits, "maxLinearSpeed" | "maxAngularSpeed">, fraction = 0.5): Velocity {
  const { v, w } = limitsOf(limits);
  const has = (...names: string[]) => names.some((name) => keys.has(name));
  const forward = (has("ArrowUp", "w", "W") ? 1 : 0) - (has("ArrowDown", "s", "S") ? 1 : 0);
  const turn = (has("ArrowLeft", "a", "A") ? 1 : 0) - (has("ArrowRight", "d", "D") ? 1 : 0);
  return { linear: round(forward * v * fraction), angular: round(turn * w * fraction) };
}

/** The on-screen pad: x and y from -1 to 1 (y up is forward, x right turns right). */
export function velocityFromPad(x: number, y: number, limits: Pick<TeleopLimits, "maxLinearSpeed" | "maxAngularSpeed">): Velocity {
  const { v, w } = limitsOf(limits);
  return { linear: round(clamp(y, 1) * v), angular: round(-clamp(x, 1) * w) };
}

/**
 * A gamepad (the Gamepad API's standard mapping): the left stick drives, and a
 * shoulder button (LB, index 4) or A (index 0) must be held as the deadman.
 * Inside the dead zone the stick counts as centred.
 */
export function velocityFromGamepad(axes: readonly number[], buttons: ReadonlyArray<{ pressed: boolean }>, limits: Pick<TeleopLimits, "maxLinearSpeed" | "maxAngularSpeed">, deadZone = 0.15): { velocity: Velocity; deadman: boolean } {
  const { v, w } = limitsOf(limits);
  const zone = (value: number | undefined) => (typeof value === "number" && Math.abs(value) > deadZone ? clamp(value, 1) : 0);
  const deadman = Boolean(buttons[4]?.pressed || buttons[0]?.pressed);
  return { deadman, velocity: deadman ? { linear: round(-zone(axes[1]) * v), angular: round(-zone(axes[0]) * w) } : { linear: 0, angular: 0 } };
}

function round(value: number) { return Math.round(value * 1000) / 1000 || 0; }

/**
 * What the screen sends: a command while the deadman is held, one zero command
 * when it is let go, then nothing (the robot's deadman holds it). Numbers only
 * go up. Pure, so it can be tested without a robot.
 */
export function createTeleopSender(send: (command: { seq: number } & Velocity) => Promise<unknown>, now: () => number = () => Date.now()) {
  let seq = Math.floor(now());
  let held = false;
  let inFlight = false;
  const stats = { sent: 0, failed: 0, lastRttMs: null as number | null, lastError: "" };
  return {
    stats,
    /** Call at the input rate. Returns the command it sent, or null. */
    async tick(deadman: boolean, velocity: Velocity) {
      if (!deadman && !held) return null;
      if (inFlight) return null; // never queue: a late command is worth less than none
      const command = { seq: (seq += 1), ...(deadman ? velocity : { linear: 0, angular: 0 }) };
      held = deadman;
      inFlight = true;
      const started = now();
      try { await send(command); stats.sent += 1; stats.lastRttMs = now() - started; stats.lastError = ""; } catch (error) { stats.failed += 1; stats.lastError = error instanceof Error ? error.message : "failed"; } finally { inFlight = false; }
      return command;
    },
  };
}
