/**
 * The client side of predictive maintenance (server/maintenance) and
 * self-diagnostics (server/diagnostics). Everything shown comes from the
 * server's records of what robots, Robot OS and hubs reported; this file
 * never makes up a reading, and its helpers say "not measured" when a value
 * is missing.
 */
import { accountRequest } from "./Account";

export type FindingLabel = "measured-anomaly" | "suspected-cause" | "confirmed-fault";
export type MaintenanceFinding = {
  id: string; assetId: string; assetKind: string; component: string; metric: string | null; label: FindingLabel; detector: string;
  status: "open" | "acknowledged" | "resolved" | "dismissed" | "cleared"; priority: "high" | "medium" | "low"; confidence: number; simulated: boolean; title: string;
  firstSeenAt: number; lastSeenAt: number; occurrences: number; feedback: "true-positive" | "false-positive" | "unsure" | null; feedbackNote: string | null;
  confirmation: { by: "controller" | "person"; code?: string; note?: string; at: number } | null;
  description?: string; evidence?: Array<{ detector: string; statement: string }>; measurements?: { unit: string; recent?: { n: number; mean?: number | null; min?: number | null; max?: number | null }; recentPeak?: number | null; baseline?: { n?: number; median?: number | null; mean?: number | null } | null } | null;
  timeline?: { firstSeenAt?: number; lastSeenAt?: number; points?: Array<{ at: number; value: number }> }; possibleCauses?: string[]; causesStatus?: string; inspection?: string[];
  failureDate: null; failureDateNote?: string; confidenceMeans: string; simulationNote?: string;
};
export type PrecisionFigure = { truePositives: number; falsePositives: number; unsure: number; judged: number; precision: number | null };
export type Precision = { overall: PrecisionFigure; byDetector: Record<string, PrecisionFigure>; awaitingVerdict: number; basis: string };
export type MaintenanceTask = { id: string; assetId: string; component: string | null; findingId: string | null; kind: string; title: string; note: string; status: "open" | "done" | "cancelled"; dueAt: number | null; reminderId: string | null; createdAt: number; doneAt: number | null; doneNote: string | null; overdue: boolean };
export type Coverage = { assetId: string; component: string; metric: string; unit: string; buckets: number; recentBuckets: number; baselineBuckets: number; baselineReady: boolean; source: string; lastAt: number; sinceReason?: string };
export type HistoryEntry = { id: string; at: number; kind: string; note: string; component: string | null; taskId: string | null };
export type MaintenanceReport = { at: number; findings: MaintenanceFinding[]; precision: Precision; tasks: MaintenanceTask[]; coverage: Coverage[]; history: HistoryEntry[]; summary: string; basis: string };

export type CheckStatus = "ok" | "degraded" | "failed" | "unknown" | "not-configured";
export type DiagnosticCheck = { id: string; subsystem: string; component: string; target: string; targetName?: string; status: CheckStatus; measured: Record<string, unknown> | null; evidence: string[]; simulated?: boolean };
export type LifecycleStep = { step: string; n: number; status: string; detail: unknown; at: number };
export type Recovery = { id: string; incidentId: string | null; action: string; policy: string; status: string; targetId: string; requestedBy: string; actionRecordId: string | null; params: Record<string, unknown>; result: Record<string, unknown> | null; verification: { confirmed?: boolean; evidence?: string } | null; createdAt: number; updatedAt: number };
export type Incident = {
  id: string; scope: string; server: boolean; targetId: string; subsystem: string; component: string; problem: string; severity: "error" | "warning" | "info"; status: string; title: string;
  occurrences: number; openedAt: number; updatedAt: number; resolvedAt: number | null; evidence: string[]; measured: Record<string, unknown> | null; logs: Array<{ at: number; source: string; message: string }>;
  dependencies: string[]; causes: string[]; causesStatus: string; diagnosis: string; manual: string | null; suggestions: Array<{ action: string; title: string; policy: string; params: Record<string, unknown>; reversible: boolean }>;
  simulated: boolean; targetName: string; lifecycle: LifecycleStep[]; recoveries: Recovery[];
};
export type Diagnosis = { checkedAt: number; summary: string; subsystems: Record<string, { status: string; checks: DiagnosticCheck[] }>; incidents: Incident[]; basis: string; you?: { admin: boolean; kind: string } };

const q = (value: string) => encodeURIComponent(value);
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const RobotOps = {
  maintenance: (assetId?: string, refresh = true) => accountRequest<MaintenanceReport>(`/api/maintenance?${assetId ? `asset=${q(assetId)}&` : ""}refresh=${refresh ? 1 : 0}`, { signal: AbortSignal.timeout(30_000) }),
  feedback: (findingId: string, verdict: "true-positive" | "false-positive" | "unsure", note = "") => accountRequest<{ finding: MaintenanceFinding; precision: Precision }>(`/api/maintenance/findings/${q(findingId)}/feedback`, post({ verdict, note })),
  confirm: (findingId: string, note: string) => accountRequest<{ finding: MaintenanceFinding }>(`/api/maintenance/findings/${q(findingId)}/confirm`, post({ note })),
  createTask: (task: { assetId: string; kind: string; title?: string; note?: string; dueAt?: number | null; component?: string | null; findingId?: string | null; remind?: boolean }) => accountRequest<{ task: MaintenanceTask }>("/api/maintenance/tasks", post(task)),
  completeTask: (taskId: string, note = "") => accountRequest<{ task: MaintenanceTask }>(`/api/maintenance/tasks/${q(taskId)}/complete`, post({ note })),
  diagnose: (auto = true) => accountRequest<Diagnosis>(`/api/diagnostics${auto ? "" : "?auto=0"}`, { signal: AbortSignal.timeout(30_000) }),
  recover: (action: string, params: Record<string, unknown>, incidentId?: string) => accountRequest<{ recovery: Recovery & { approval?: { id: string; status: string } } }>("/api/diagnostics/recover", { ...post({ action, params, incidentId }), signal: AbortSignal.timeout(30_000) }),
};

// ---------- pure helpers (tested) ----------

export const LABEL_TEXT: Record<FindingLabel, string> = {
  "measured-anomaly": "Measured anomaly",
  "suspected-cause": "Suspected cause (not confirmed)",
  "confirmed-fault": "Confirmed fault",
};
export const POLICY_TEXT: Record<string, string> = {
  automatic: "Runs automatically (low risk, reversible)",
  approval: "Needs your approval",
  admin: "Server administrator only",
  prohibited: "Never run by HANNAH: a person acts at the hardware",
};

/** A measured value with its unit, or "not measured". Never a made-up number. */
export function measuredText(value: unknown, unit = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "not measured";
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return unit ? `${rounded} ${unit}` : String(rounded);
}

/** Precision as people's verdicts give it: "no verdicts yet" rather than 100% or 0%. */
export function precisionText(figure: PrecisionFigure | null | undefined): string {
  if (!figure || !figure.judged || figure.precision === null) return "no verdicts yet";
  return `${Math.round(figure.precision * 100)}% of ${figure.judged} judged finding${figure.judged === 1 ? "" : "s"} were real`;
}

/** Order for the list: confirmed faults, then suspected causes, then measured anomalies; high priority first within each. */
export function sortFindings(findings: MaintenanceFinding[]): MaintenanceFinding[] {
  const label = { "confirmed-fault": 0, "suspected-cause": 1, "measured-anomaly": 2 } as const;
  const priority = { high: 0, medium: 1, low: 2 } as const;
  return [...findings].sort((a, b) => label[a.label] - label[b.label] || priority[a.priority] - priority[b.priority] || b.lastSeenAt - a.lastSeenAt);
}

/** How a check's status reads, with unknown never shown as healthy. */
export function checkStatusText(status: string): string {
  return ({ ok: "OK", degraded: "Degraded", failed: "Failed", unknown: "Not measured", "not-configured": "Not set up", "nothing-to-check": "Nothing to check" } as Record<string, string>)[status] || status;
}

/** What a person can do about an incident's first suggestion, given who they are. */
export function recoveryChoice(incident: Pick<Incident, "suggestions" | "status" | "manual">, admin: boolean): { kind: "run" | "ask" | "admin" | "manual" | "none"; label: string } {
  const suggestion = incident.suggestions[0];
  if (!suggestion) return { kind: "none", label: incident.manual || "No recovery action fits; a person has to look." };
  if (suggestion.policy === "prohibited") return { kind: "manual", label: incident.manual || POLICY_TEXT.prohibited };
  if (incident.status === "waiting-approval") return { kind: "none", label: "Waiting for approval in Actions." };
  if (suggestion.policy === "admin") return admin ? { kind: "run", label: suggestion.title } : { kind: "admin", label: "Only a server administrator can run this." };
  if (suggestion.policy === "approval") return { kind: "ask", label: `Ask to ${suggestion.title.toLowerCase()}` };
  return { kind: "run", label: suggestion.title };
}
