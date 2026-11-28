/**
 * The client side of a robot's black box (server/robotics/blackbox*.js).
 *
 * Everything here is the server's record. A timeline item says where it came
 * from (the robot's black box, Robot OS, the robot's regular reports, or
 * HANNAH's own records) and whether its time is on a synchronised clock. An
 * incident report keeps what the records confirm apart from what is only
 * suspected, and every line cites the records it rests on. A replay is
 * always playback: what was recorded, never the robot now.
 */
import { AccountError, accountRequest } from "./Account";
import { apiFetch, apiUrl, usesBearerSession } from "./api";

export type ClockInfo = { synced: boolean; uncertaintyMs: number | null; note: string };
export type TimelineEvent = {
  id: string; robotId: string; robotEventId?: string; deviceId: string | null; at: number; receivedAt: number; clock: ClockInfo;
  source: string; type: string; missionId: string | null; severity: "debug" | "info" | "warning" | "error" | "critical"; summary: string;
  details: Record<string, unknown>; dataRefs: Array<{ segment: string; stream: string; fromMs: number | null; toMs: number | null }>;
  sensitivity: "normal" | "sensitive"; simulated: boolean | null; origin: "robot-blackbox" | "robot-os" | "robot-sync" | "server";
};
export type Timeline = { robot: { id: string; name: string; kind: "simulation" | "physical" }; from: number; to: number; events: TimelineEvent[]; truncated: boolean; clock: { unsynchronised: number; widestUncertaintyMs: number; note: string } };
export type BlackBoxSettings = { enabled: boolean; retentionDays: number; sensitiveRetentionDays: number; acceptSegments: boolean; acceptSensitive: boolean; segmentRetentionDays: number; maxSegmentMB: number };
export type BlackBoxSettingsView = { robotId: string; settings: BlackBoxSettings; storage: { kind: string; durable: boolean }; policy: { acceptSegments: boolean; acceptSensitive: boolean; segmentsRefused?: string } };
export type Segment = { id: string; stream: string; topics: string[]; fromAt: number | null; toAt: number | null; records: number; bytes: number; sha256: string; sensitivity: "normal" | "sensitive"; simulated: boolean; verified: boolean; uploadedAt: number; expiresAt: number; downloadable: boolean };
export type IncidentLine = { id: string; text: string; evidence: string[]; at: number };
export type SuspectedCause = { id: string; cause: string; status: "suspected"; rule: string; evidence: string[]; check: string };
export type IncidentReport = {
  found: boolean; reason?: string; question: string; robot: { id: string; name: string; kind: "simulation" | "physical" }; label?: string; method: string; generatedAt: number;
  anchor?: { id: string; at: number; type: string; kind: string; summary: string; missionId: string | null };
  window?: { from: number; to: number };
  sequence?: Array<{ id: string; at: number; source: string; type: string; severity: string; summary: string; origin: string; missionId: string | null; deviceId: string | null; clock: ClockInfo }>;
  confirmed?: IncidentLine[]; suspected?: SuspectedCause[]; history?: { count: number; evidence: string[]; text: string };
  recovery?: { note: string; steps: string[] }; gaps?: string[]; clock?: { notes: string[] }; evidenceIds: string[];
};
export type Narrative = { ok: boolean; label?: string; text: string | null; rejectedText?: string | null; problems: string[] };
export type Replay = {
  playback: true; live: false; label: string; robot: { id: string; name: string; kind: "simulation" | "physical" };
  mission: { id: string; capability: string; params: Record<string, unknown>; status: string; error: string | null; createdAt: number; finishedAt: number | null };
  from: number; to: number; frames: Array<{ at: number; pose: { x: number; y: number; yaw: number | null }; speed?: number | null; mode?: string | null; estop?: boolean; from: "telemetry" | "recording" }>;
  events: TimelineEvent[]; note: string;
};
export type TimelineFilter = { from?: number; to?: number; mission?: string; source?: string; severity?: string; q?: string; limit?: number };

const id = (value: string) => encodeURIComponent(value);
const json = (value: unknown) => JSON.stringify(value);
const query = (filter: TimelineFilter) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== "" && value !== null) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};

export const BlackBox = {
  settings: (robotId: string) => accountRequest<BlackBoxSettingsView>(`/api/robots/${id(robotId)}/blackbox/settings`),
  updateSettings: (robotId: string, change: Partial<BlackBoxSettings>) => accountRequest<BlackBoxSettingsView>(`/api/robots/${id(robotId)}/blackbox/settings`, { method: "PUT", body: json(change) }),
  timeline: (robotId: string, filter: TimelineFilter = {}) => accountRequest<Timeline>(`/api/robots/${id(robotId)}/blackbox/events${query(filter)}`),
  segments: async (robotId: string) => (await accountRequest<{ segments: Segment[] }>(`/api/robots/${id(robotId)}/blackbox/segments`)).segments,
  incident: async (robotId: string, mission?: string) => (await accountRequest<{ report: IncidentReport }>(`/api/robots/${id(robotId)}/blackbox/incident${mission ? `?mission=${id(mission)}` : ""}`)).report,
  narrative: (robotId: string, mission?: string) => accountRequest<{ report: IncidentReport; narrative: Narrative }>(`/api/robots/${id(robotId)}/blackbox/incident/narrative`, { method: "POST", body: json(mission ? { mission } : {}), signal: AbortSignal.timeout(90_000) }),
  scenario: (robotId: string, mission?: string) => accountRequest<{ scenario: Record<string, unknown> }>(`/api/robots/${id(robotId)}/blackbox/incident/scenario`, { method: "POST", body: json(mission ? { mission } : {}) }),
  replay: async (robotId: string, mission: string) => (await accountRequest<{ replay: Replay }>(`/api/robots/${id(robotId)}/blackbox/missions/${id(mission)}/replay`)).replay,
  exportData: (robotId: string) => accountRequest<Record<string, unknown>>(`/api/robots/${id(robotId)}/blackbox/export`),
  remove: (robotId: string, range: { from?: number; to?: number } = {}) => accountRequest<{ events: number; segments: number; note: string }>(`/api/robots/${id(robotId)}/blackbox${query(range)}`, { method: "DELETE" }),
  /** A recording file (gzip HBX), as the server stored it. A sensitive one needs a signed-in session. */
  async downloadSegment(robotId: string, segmentId: string): Promise<Blob> {
    const response = await apiFetch(apiUrl(`/api/robots/${id(robotId)}/blackbox/segments/${id(segmentId)}`), { credentials: usesBearerSession() ? "omit" : "same-origin", headers: usesBearerSession() ? { "X-HANNAH-Session": "bearer" } : {}, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; reason?: string };
      throw new AccountError(body.error || `The server returned HTTP ${response.status}.`, response.status, body.reason);
    }
    return response.blob();
  },
};
