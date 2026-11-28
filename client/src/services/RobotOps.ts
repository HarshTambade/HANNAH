/**
 * The client side of robot operations (server/robotics/robotops*.js):
 * sim-to-real deployments, simulator runs, update packages, staged rollouts
 * and firmware operations.
 *
 * What is true of every answer here:
 *   - a simulator run is HANNAH's built-in simulator, never a physical robot,
 *     and is labelled so wherever it is shown;
 *   - approving a stage, a wave or a firmware flash is done only by a
 *     signed-in person; the server refuses it from a developer key or agent.
 */
import { accountRequest } from "./Account";

export type LifecycleStep = { id: string; title: string; person: boolean; ok: boolean; detail: string };
export type ParityItem = { area: string; field: string; sim: unknown; physical: unknown; status: "same" | "different" | "missing-on-robot" | "missing-in-sim" | "unknown"; blocking: boolean; note: string };
export type Assumption = { id: string; text: string; source: string };
export type DiffItem = { key: string; label: string; kind: string; before: number | null; now: number | null; change: number | null; status: "same" | "improved" | "regressed" | "worse" | "changed" | "not-comparable" };
export type RunSummary = Record<string, number | null>;
export type SimRun = {
  id: string; deploymentId: string | null; suite: string; profile: string; overrides: Record<string, unknown>; status: "running" | "passed" | "failed" | "error";
  summary: RunSummary | null; error: string | null; createdAt: number; finishedAt: number | null; simulator: string; physical: false;
  results?: Array<{ name: string; passed: boolean; problems: string[]; log: Array<{ to: string; expected: string; result: string; reason: string | null }> }>;
};
export type Deployment = {
  id: string; title: string; robotId: string; robotName: string; stage: "simulation" | "development" | "test" | "limited" | "wider"; status: "open" | "completed" | "rolled-back";
  change: { kind: string; description: string; simProfile: string; scenarios: string[]; overrides: Record<string, unknown>; capabilities: string[] };
  parity: { ok: boolean; items: ParityItem[]; blocking: string[]; assumptions: Assumption[]; hash: string } | null;
  acknowledged: { ids: string[]; by: string } | null; inspected: { runId: string; by: string } | null;
  approvals: Array<{ stage: string; by: string; at: number; statement: string; robotIds: string[] }>;
  observations: Array<{ stage: string; outcome: "ok" | "problem"; note: string; by: string; at: number }>;
  stages: Record<string, { robots: Array<{ robotId: string; status: string }> }>;
  rollbacks: Array<{ at: number; by: string; reason: string; actions: Array<{ robotId: string; how: string; detail?: string }> }>;
  latestRun: SimRun | null; baseline: { id: string; summary: RunSummary } | null;
  lifecycle: { steps: LifecycleStep[]; next: string; diff: { verdict: string; items: DiffItem[]; regressions: string[]; warnings: string[] }; readyForApproval: boolean; physicalValidated: boolean };
  robot: { id: string; name: string; simulated: boolean; online: boolean; commissioning: { status: string } } | null;
};
export type DeploymentSummary = Pick<Deployment, "id" | "title" | "robotId" | "robotName" | "stage" | "status"> & { change: { kind: string; simProfile: string } };
export type Check = { id: string; ok: boolean; detail: string; pending?: boolean };
export type PublisherKey = { keyId: string; owner: string; addedAt: number; revokedAt: number | null };
export type UpdatePackage = { id: string; packageId: string; version: string; kind: string; keyId: string; uploadedAt: number; manifest: { name: string; changelog: string; publisher: string; recovery: { rollback: string } } };
export type RobotValidation = { robotId: string; robotName: string; simulated: boolean; ok: boolean; problems: string[]; checks: Check[] };
export type RolloutTarget = { robotId: string; wave: number; status: string; reason: string; health: { ok: boolean; results: Array<{ id: string; ok: boolean; detail: string }> } | null; history: Array<{ at: number; status: string; reason?: string }> };
export type Rollout = {
  id: string; status: string; package: { id: string; version: string; kind: string; name: string }; autoRollback: boolean;
  waves: Array<{ stage: string; robotIds: string[]; status: string; approval: { by: string; at: number; statement: string } | null }>;
  targets: Record<string, RolloutTarget>;
};
export type FirmwareOp = {
  id: string; robotId: string; robotName: string; status: string; package: { id: string; version: string; controller: string };
  checks: Check[]; driver: { id: string; title: string; simulated: boolean } | null; blockedReason: string | null;
  result: { ok: boolean; status: string; simulated: boolean; detail: string } | null;
};

const json = (body: unknown) => JSON.stringify(body);
const id = encodeURIComponent;
const post = <T>(path: string, body: unknown = {}) => accountRequest<T>(path, { method: "POST", body: json(body) });

export const RobotOps = {
  simulator: () => accountRequest<{ available: { ok: boolean; reason?: string }; profiles: Array<{ name: string; model: string; scenarioRunner: boolean }>; scenarios: Array<{ name: string; description: string }>; environment: string }>("/api/robotops/simulator"),
  deployments: async (robotId?: string) => (await accountRequest<{ deployments: DeploymentSummary[] }>(`/api/robotops/deployments${robotId ? `?robot=${id(robotId)}` : ""}`)).deployments,
  deployment: async (deploymentId: string) => (await accountRequest<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}`)).deployment,
  createDeployment: async (input: { robotId: string; title: string; change: Partial<Deployment["change"]> }) => (await post<{ deployment: Deployment }>("/api/robotops/deployments", input)).deployment,
  simulate: async (deploymentId: string) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/simulate`)).deployment,
  refreshParity: async (deploymentId: string) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/parity`)).deployment,
  setBaseline: (runId: string) => post(`/api/robotops/sim-runs/${id(runId)}/baseline`),
  inspect: async (deploymentId: string, runId: string) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/inspect`, { runId, attest: true })).deployment,
  acknowledge: async (deploymentId: string, ids: string[]) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/assumptions`, { ids, attest: true })).deployment,
  approve: async (deploymentId: string, stage: string, robotIds: string[] = []) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/approve`, { stage, robotIds, attest: true })).deployment,
  observe: async (deploymentId: string, outcome: "ok" | "problem", note: string) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/observe`, { outcome, note })).deployment,
  rollback: async (deploymentId: string, reason: string) => (await post<{ deployment: Deployment }>(`/api/robotops/deployments/${id(deploymentId)}/rollback`, { reason })).deployment,
  keys: async () => (await accountRequest<{ keys: PublisherKey[] }>("/api/robotops/keys")).keys,
  addKey: (owner: string, publicKey: string) => post("/api/robotops/keys", { owner, publicKey }),
  revokeKey: (keyId: string) => post(`/api/robotops/keys/${id(keyId)}/revoke`),
  packages: async () => (await accountRequest<{ packages: UpdatePackage[] }>("/api/robotops/packages")).packages,
  uploadPackage: (manifest: unknown) => post("/api/robotops/packages", { manifest }),
  validatePackage: (packageId: string) => accountRequest<{ package: UpdatePackage; robots: RobotValidation[] }>(`/api/robotops/packages/${id(packageId)}`),
  rollouts: async () => (await accountRequest<{ rollouts: Rollout[] }>("/api/robotops/rollouts")).rollouts,
  createRollout: (packageId: string, picked: Record<string, string[]>) => post<{ rollout: Rollout }>("/api/robotops/rollouts", { packageId, picked }),
  approveWave: (rolloutId: string, index: number) => post<{ rollout: Rollout }>(`/api/robotops/rollouts/${id(rolloutId)}/waves/${index}/approve`, { attest: true }),
  rollbackRobot: (rolloutId: string, robotId: string, reason: string) => post<{ rollout: Rollout }>(`/api/robotops/rollouts/${id(rolloutId)}/robots/${id(robotId)}/rollback`, { reason }),
  firmwareOps: async () => (await accountRequest<{ operations: FirmwareOp[] }>("/api/robotops/firmware")).operations,
  authorizeFirmware: (opId: string, confirmName: string, confirmSerial: string) => post<{ operation: FirmwareOp }>(`/api/robotops/firmware/${id(opId)}/authorize`, { confirmName, confirmSerial, atRobot: true }),
};

/** Pure helpers, exported for tests. */
export const STAGE_TITLES: Record<string, string> = { simulation: "Simulation", development: "Development robot", test: "Test robot", limited: "Limited deployment", wider: "Wider deployment" };
export const WAVE_STAGES = ["development", "test", "limited", "selected", "wider"] as const;
const NEXT: Record<string, string | null> = { simulation: "development", development: "test", test: "limited", limited: "wider", wider: null };

export function nextStage(stage: string): string | null {
  return NEXT[stage] ?? null;
}

/** "3 of 14 steps" and the next open step's title. */
export function lifecycleProgress(steps: LifecycleStep[]) {
  const done = steps.filter((step) => step.ok).length;
  const next = steps.find((step) => !step.ok && step.id !== "expand") || null;
  return { done, total: steps.length, next: next ? next.title : "Every step holds" };
}

export function toneOf(status: string): string {
  if (["healthy", "passed", "pass", "same", "improved", "ok", "completed", "validated", "simulated-flashed"].includes(status)) return "text-emerald-700";
  if (["failed", "regressed", "halted", "rolled-back", "rollback-failed", "error", "blocked", "problem"].includes(status)) return "text-rose-700";
  if (["changed", "worse", "staging", "activating", "verifying", "rolling-back", "in-progress", "running", "pending"].includes(status)) return "text-amber-700";
  return "text-slate-700";
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return String(value);
}

/** Robots per wave from a "robot id → stage" choice. Robots without a stage are left out. */
export function pickedWaves(choice: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [robotId, stage] of Object.entries(choice)) {
    if (!stage || !(WAVE_STAGES as readonly string[]).includes(stage)) continue;
    (out[stage] ||= []).push(robotId);
  }
  return out;
}
