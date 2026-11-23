/**
 * HANNAH AI Workforce — typed client for the server's `/api/workforce` API.
 *
 * The server module (`server/workforce/*`) owns every action; this file only
 * shapes the requests and responses for the UI. Responses are the server's
 * public records (see `publicBot`, `publicComputer`, `publicSecret`, … in the
 * server modules). Every call returns parsed JSON; failures throw with the
 * server's message.
 */
import { apiFetch, apiUrl } from "./api";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(apiUrl(path), init);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const anyData = data as { error?: unknown; message?: unknown } | null;
    const message = (typeof anyData?.error === "string" ? anyData.error : typeof anyData?.message === "string" ? anyData.message : "") || `That call failed (${response.status}).`;
    throw new Error(message);
  }
  return (data ?? {}) as T;
}

function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  return call<T>(`/api/workforce${path}${query}`);
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return call<T>(`/api/workforce${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function put<T>(path: string, body: unknown = {}): Promise<T> {
  return call<T>(`/api/workforce${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown = {}): Promise<T> {
  return call<T>(`/api/workforce${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function remove<T>(path: string): Promise<T> {
  return call<T>(`/api/workforce${path}`, { method: "DELETE" });
}

// ------------------------------------------------------------------ types

export interface BotTemplate {
  id: string; name: string; role: string; avatar: string; description: string;
  personality: string; instructions: string; responsibilities: string[]; skills: string[];
  apps: string[]; tools: string[]; autonomy: string;
}

export interface Bot {
  id: string; name: string; avatar: string | null; description: string; role: string;
  template: string | null; personality: string; instructions: string; responsibilities: string[];
  skills: string[]; apps: string[]; tools: string[]; memoryConfig: Record<string, unknown>;
  modelPrefs: Record<string, unknown>; computerAccess: Record<string, unknown>;
  fileAccess: Record<string, unknown>; permissions: Record<string, unknown>; autonomy: string;
  notifications: Record<string, unknown>; limits: Record<string, unknown>; status: string;
  visibility: string; publishedAt: number | null; version: number; createdAt: number;
  updatedAt: number; archivedAt: number | null; mine: boolean; teamId: string | null;
  teamName: string | null;
}

export interface BotVersion { version: number; note: string; authorId: string | null; createdAt: number }

export interface BotConfig {
  name: string; avatar?: string | null; description?: string; role: string; personality?: string;
  instructions?: string; responsibilities?: string[]; skills?: string[]; apps?: string[]; tools?: string[];
  memoryConfig?: Record<string, unknown>; modelPrefs?: Record<string, unknown>; computerAccess?: Record<string, unknown>;
  fileAccess?: Record<string, unknown>; permissions?: Record<string, unknown>; autonomy?: string;
  notifications?: Record<string, unknown>; limits?: Record<string, unknown>; visibility?: string; teamId?: string;
}

export interface Team {
  id: string; name: string; description: string; ownerId: string; role: string;
  botCount: number; memberCount: number; createdAt: number; updatedAt: number;
}

export interface TeamMember { userId: string; role: string; email: string; displayName: string; addedAt: number }

export interface Secret {
  id: string; name: string; application: string; kind: string; hint: string; scopes: string[];
  botIds: string[]; createdAt: number; updatedAt: number; lastUsedAt: number | null;
  revoked: boolean; revokedAt: number | null;
}

export interface Computer {
  id: string; name: string; kind: "cloud" | "local"; status: string; botId: string | null; teamId: string | null;
  image: string | null; risk: string; permissions: Record<string, unknown>; limits: Record<string, unknown>;
  retentionDays: number | null; createdAt: number; updatedAt: number; lastStartedAt: number | null;
  usage?: { bytes: number; files: number };
}

export interface ComputerSession {
  id: string; computerId: string; botId: string | null; taskId: string | null; status: string;
  url: string; tabs: string[]; checkpoint: Record<string, unknown>; activity: Array<Record<string, unknown>>;
  startedAt: number; updatedAt: number; endedAt: number | null;
}

export interface Routine {
  id: string; botId: string | null; teamId: string | null; name: string; description: string;
  skillId: string | null; mode: string; trigger: Record<string, unknown>; timezone: string; status: string;
  nextRunAt: number | null; lastRunAt: number | null; runCount: number; failureCount: number;
  notifications: Record<string, unknown>; createdAt: number; updatedAt: number;
}

export interface RoutineRun {
  id: string; routineId: string; status: string; trigger: string; plannedFor: number | null;
  startedAt: number | null; finishedAt: number | null; result: unknown; error: string | null;
  taskId: string | null; createdAt: number;
}

export interface Skill {
  id: string; teamId: string | null; name: string; description: string; whenToUse: string;
  inputs: string[]; apps: string[]; permissions: string[]; steps: string[]; decisionRules: string[];
  outputs: string[]; failureHandling: string; safety: string[]; status: string; source: string;
  version: number; tests: Array<Record<string, unknown>>; publishedAt: number | null; createdAt: number; updatedAt: number;
}

export interface SkillVersion { version: number; note: string; createdAt: number }

export interface Artifact {
  id: string; name: string; type: string; size: number; sha256: string; version: number;
  parentArtifactId: string | null; taskId: string | null; botId: string | null; teamId: string | null;
  source: string; createdAt: number; updatedAt: number; downloadUrl: string;
}

export interface MemoryRecord {
  id: string; botId: string | null; teamId: string | null; project: string; scope: string; kind: string;
  content: string; provenance: string; confidence: number | null; source: string; verifiedAt: number | null;
  expiresAt: number | null; sensitive: boolean; createdAt: number; updatedAt: number;
}

export interface Task {
  id: string; parentId: string | null; botId: string | null; teamId: string | null; title: string;
  objective: string; status: string; depth: number; dependsOn: string[]; inputs: unknown; deliverable: string;
  acceptance: string; deadline: number | null; priority: string; project: string; result: unknown;
  error: string | null; createdAt: number; updatedAt: number; startedAt: number | null; finishedAt: number | null;
}

export interface WorkforceEvent {
  id: string; at: number; kind: string; severity: string; userId: string; botId: string | null; taskId: string | null;
  detail: Record<string, unknown>; createdAt: number;
}

export interface ProactiveSettings {
  enabled: boolean; categories: string[]; quietHoursEnabled: boolean;
  quietHours: Array<{ from: string; to: string; days?: string[] }>; dataRetentionDays: number | null;
}

export interface ProactiveOffer {
  id: string; kind: string; title: string; body: string; source: string; status: string;
  action: Record<string, unknown> | null; createdAt: number; updatedAt: number;
}

export interface Meeting {
  id: string; provider: string; title: string; status: string; botId: string | null; teamId: string | null;
  consent: Record<string, unknown>; participants: Array<Record<string, unknown>>; hasTranscript: boolean;
  transcriptChars: number; actions: Array<Record<string, unknown>>; notes: string; startsAt: number; endsAt: number;
}

export interface MeetingsCapabilities { liveJoin: boolean; liveRecord: boolean; transcriptImport: boolean }

// ------------------------------------------------------------------ api

export const workforce = {
  overview: () => get<{ counts: Record<string, number>; events: WorkforceEvent[] }>("/overview"),
  events: (params?: Record<string, string>) => get<{ events: WorkforceEvent[] }>("/events", params),

  // -- bots
  templates: () => get<{ templates: BotTemplate[] }>("/templates"),
  bots: () => get<{ bots: Bot[] }>("/bots"),
  bot: (id: string) => get<{ bot: Bot }>(`/bots/${id}`),
  botCreate: (config: BotConfig) => post<{ bot: Bot }>("/bots", config),
  botUpdate: (id: string, config: BotConfig) => put<{ bot: Bot }>(`/bots/${id}`, config),
  botSetStatus: (id: string, status: string) => post<{ bot: Bot }>(`/bots/${id}/status`, { status }),
  botDuplicate: (id: string, body?: Record<string, unknown>) => post<{ bot: Bot }>(`/bots/${id}/duplicate`, body || {}),
  botDelete: (id: string) => remove(`/bots/${id}`),
  botExport: (id: string) => get(`/bots/${id}/export`),
  botVersions: (id: string) => get<{ versions: BotVersion[] }>(`/bots/${id}/versions`),
  botRestore: (id: string, version: number) => post(`/bots/${id}/versions/${version}/restore`, {}),
  botTest: (id: string, inputs?: Record<string, unknown>) => post(`/bots/${id}/test`, { inputs: inputs || {} }),

  // -- teams
  teams: () => get<{ teams: Team[] }>("/teams"),
  team: (id: string) => get<{ team: Team; members: TeamMember[]; bots: Bot[]; policy: unknown }>(`/teams/${id}`),
  teamCreate: (name: string, description?: string) => post<{ team: Team }>("/teams", { name, description }),
  teamUpdate: (id: string, name: string, description?: string) => patch<{ team: Team }>(`/teams/${id}`, { name, description }),
  teamDelete: (id: string) => remove(`/teams/${id}`),
  teamAddMember: (id: string, email: string, role: string) => post(`/teams/${id}/members`, { email, role }),
  teamRemoveMember: (id: string, userId: string) => remove(`/teams/${id}/members/${userId}`),
  teamSetPolicy: (id: string, rules: unknown[]) => put(`/teams/${id}/policy`, { rules }),
  teamPublishBot: (teamId: string, botId: string) => post(`/teams/${teamId}/bots/${botId}/publish`, {}),
  teamUnpublishBot: (teamId: string, botId: string) => post(`/teams/${teamId}/bots/${botId}/unpublish`, {}),
  teamActivity: (id: string) => get<{ events: WorkforceEvent[]; note?: string }>(`/teams/${id}/activity`),

  // -- secure vault
  vaultStatus: () => get<{ configured: boolean; note: string }>("/vault/status"),
  vaultSecrets: () => get<{ secrets: Secret[] }>("/secrets"),
  vaultAdd: (secret: { name: string; application: string; kind: string; value: string; scopes?: string[]; botIds?: string[] }) => post<{ secret: Secret }>("/secrets", secret),
  vaultEdit: (id: string, secret: { name: string; application: string; kind: string; value?: string; scopes?: string[]; botIds?: string[] }) => put(`/secrets/${id}`, secret),
  vaultRevoke: (id: string) => remove(`/secrets/${id}`),
  vaultUse: (id: string) => post(`/secrets/${id}/use`, {}),

  // -- persistent computers
  computers: () => get<{ computers: Computer[] }>("/computers"),
  computer: (id: string) => get<{ computer: Computer; usage?: { bytes: number; files: number }; sessions?: ComputerSession[]; files?: unknown[] }>(`/computers/${id}`),
  computerCreate: (input: Record<string, unknown>) => post<{ computer: Computer }>("/computers", input),
  computerDelete: (id: string) => remove(`/computers/${id}`),
  computerStart: (id: string) => post<{ computer: Computer }>(`/computers/${id}/start`, {}),
  computerStop: (id: string) => post<{ computer: Computer }>(`/computers/${id}/stop`, {}),
  computerFiles: (id: string, path?: string) => get<{ files: Array<{ name: string; path: string; type: string; size: number; modifiedAt: number }>; usage?: { bytes: number; files: number } }>(`/computers/${id}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  computerFileContent: (id: string, path: string) => get<{ content: string; size: number; path: string }>(`/computers/${id}/files/content?path=${encodeURIComponent(path)}`),
  computerWriteFile: (id: string, path: string, content: string, encoding?: "utf8" | "base64") => put<{ ok: boolean; path: string; size: number; sha256: string }>(`/computers/${id}/files`, { path, content, encoding }),
  computerCreateFolder: (id: string, path: string) => post(`/computers/${id}/folders`, { path }),
  computerDeleteFiles: (id: string, path: string, recursive?: boolean) => remove(`/computers/${id}/files?path=${encodeURIComponent(path)}${recursive ? "&recursive=true" : ""}`),
  computerSessions: (id: string) => get<{ sessions: ComputerSession[] }>(`/computers/${id}/sessions`),
  computerStartSession: (id: string, body?: Record<string, unknown>) => post<{ session: ComputerSession }>(`/computers/${id}/sessions`, body || {}),
  computerScreenshot: async (sessionId: string): Promise<Blob> => {
    const response = await apiFetch(apiUrl(`/api/workforce/sessions/${sessionId}/screenshot`));
    if (!response.ok) throw new Error("No screenshot has been taken yet.");
    return response.blob();
  },
  computerHandoff: (sessionId: string, body: { reason?: string; instructions?: string }) => post<{ ok: boolean; status: string; reason: string; instructions: string }>(`/api/workforce/sessions/${sessionId}/handoff`, body),
  computerResume: (sessionId: string) => post(`/api/workforce/sessions/${sessionId}/resume`, {}),
  computerBrowserAction: (id: string, action: Record<string, unknown>, sessionId?: string) => post(`/computers/${id}/browser`, { sessionId, action }),
  computerTerminal: (id: string, body: { botId?: string; command: string; args?: string[]; cwd?: string }) => post<{ result: Record<string, unknown> }>(`/computers/${id}/terminal`, body),

  // -- skills
  skills: () => get<{ skills: Skill[]; actions: string[]; statuses: string[] }>("/skills"),
  skill: (id: string) => get<{ skill: Skill; versions: SkillVersion[] }>(`/skills/${id}`),
  skillCreate: (definition: Record<string, unknown>) => post<{ skill: Skill }>("/skills", definition),
  skillUpdate: (id: string, definition: Record<string, unknown>) => put(`/skills/${id}`, definition),
  skillDelete: (id: string) => remove(`/skills/${id}`),
  skillTest: (id: string, inputs?: Record<string, unknown>) => post<{ test: { ready: boolean; issues: string[]; missing: string[]; actions: Array<Record<string, unknown>> } }>(`/skills/${id}/test`, { inputs: inputs || {} }),
  skillSetStatus: (id: string, status: string) => post(`/skills/${id}/status`, { status }),
  skillExport: (id: string) => get(`/skills/${id}/export`),
  skillMatch: (query: string) => get("/skills/match", { query }),
  teachStart: (body: { title: string; botId?: string; computerId?: string; consent?: Record<string, unknown> }) => post<{ session: { id: string; title: string; status: string; eventCount: number } }>("/teach", body),
  teachEvents: (id: string, events: Array<Record<string, unknown>>) => post(`/teach/${id}/events`, { events }),
  teachCompile: (id: string) => post(`/teach/${id}/compile`, {}),
  teachCancel: (id: string) => post(`/teach/${id}/cancel`, {}),

  // -- routines
  routines: () => get<{ routines: Routine[]; upcoming?: Array<{ id: string; name: string; at: number }>; modes: string[] }>("/routines"),
  routine: (id: string) => get<{ routine: Routine; runs: RoutineRun[] }>(`/routines/${id}`),
  routineCreate: (input: Record<string, unknown>) => post<{ routine: Routine }>("/routines", input),
  routineUpdate: (id: string, input: Record<string, unknown>) => patch<{ routine: Routine }>(`/routines/${id}`, input),
  routineDelete: (id: string) => remove(`/routines/${id}`),
  routineRun: (id: string) => post<{ run: RoutineRun }>(`/routines/${id}/run`, {}),
  routineRuns: (id: string) => get<{ runs: RoutineRun[] }>(`/routines/${id}/runs`),

  // -- artifacts
  artifacts: (params?: Record<string, string>) => get<{ artifacts: Artifact[]; maxBytes: number }>("/artifacts", params),
  artifact: (id: string) => get<{ artifact: Artifact; versions: Artifact[] }>(`/artifacts/${id}`),
  artifactDelete: (id: string) => remove(`/artifacts/${id}`),
  artifactContent: async (id: string): Promise<string> => {
    const response = await apiFetch(apiUrl(`/api/workforce/artifacts/${id}/content`));
    if (!response.ok) throw new Error("The stored file is missing.");
    return response.text();
  },
  artifactVersion: (id: string, body: { content: string; encoding?: string; source?: string }) => post(`/artifacts/${id}/versions`, body),
  artifactCreate: (input: { name: string; type?: string; content?: string; encoding?: string; taskId?: string; botId?: string; teamId?: string; source?: string }) => post<{ artifact: Artifact; versions: Artifact[] }>("/artifacts", input),

  // -- memory
  memories: (params?: Record<string, string>) => get<{ memories: MemoryRecord[]; scopes: string[]; kinds: string[] }>("/memory", params),
  memoryCreate: (input: Record<string, unknown>) => post<{ memory: MemoryRecord }>("/memory", input),
  memoryUpdate: (id: string, input: Record<string, unknown>) => put(`/memory/${id}`, input),
  memoryDelete: (id: string) => remove(`/memory/${id}`),
  memoryRecall: (query: string) => post("/memory/recall", { query }),

  // -- tasks
  tasks: (params?: Record<string, string>) => get<{ tasks: Task[] }>("/tasks", params),
  taskPlan: (body: Record<string, unknown>) => post<{ plan: Task[]; message?: string }>("/tasks/plan", body),
  taskCreate: (body: Record<string, unknown>) => post<{ task: Task }>("/tasks", body),
  taskDelegate: (id: string, body: Record<string, unknown>) => post(`/tasks/${id}/delegate`, body),
  taskHandoff: (id: string, body: Record<string, unknown>) => post(`/tasks/${id}/handoff`, body),
  taskVerify: (id: string, body?: Record<string, unknown>) => post(`/tasks/${id}/verify`, body || {}),
  taskRun: (id: string) => post(`/tasks/${id}/run`, {}),

  // -- approvals
  approvals: () => get("/approvals"),

  // -- proactive
  proactive: () => get<{ settings: ProactiveSettings; categories: string[]; offers: ProactiveOffer[] }>("/proactive"),
  proactiveSettingsSet: (settings: Partial<ProactiveSettings>) => put("/proactive/settings", settings),
  proactiveScan: (force?: boolean) => post("/proactive/scan", { force: force === true }),
  proactiveOffers: (status?: string) => get("/proactive/offers", { status: status || "pending" }),
  proactiveDismiss: (id: string) => post(`/proactive/offers/${id}/dismiss`, {}),
  proactiveAct: (id: string) => post(`/proactive/offers/${id}/act`, {}),

  // -- meetings
  meetings: () => get<{ meetings: Meeting[] }>("/meetings"),
  meetingsCapabilities: () => get<{ capabilities: MeetingsCapabilities }>("/meetings/capabilities"),
  meetingCreate: (input: Record<string, unknown>) => post<{ meeting: Meeting }>("/meetings", input),
  meetingTranscript: (id: string, transcript: string) => post(`/meetings/${id}/transcript`, { transcript }),
  meetingSummarize: (id: string) => post(`/meetings/${id}/summarize`, {}),
  meetingAcceptAction: (id: string, actionId: string) => post(`/meetings/${id}/actions/${actionId}/accept`, {}),
  meetingCancel: (id: string) => post(`/meetings/${id}/cancel`, {}),
};

export default workforce;

/** The short date, like "Nov 5". */
export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "2:04 PM" or "2:04". */
export function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
}
