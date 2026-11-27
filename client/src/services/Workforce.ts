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
  webhook?: { url: string; provider: string; event: string; secretSet: boolean } | null;
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
  transcriptChars: number; actions: MeetingAction[]; notes: MeetingNotes | null; startsAt: number | null; endsAt: number | null;
  createdAt: number; updatedAt: number;
}

export interface MeetingNotes { summary?: string; decisions?: string[]; risks?: string[]; followUps?: string[]; model?: string; provider?: string }
export interface MeetingAction { id: string; title: string; owner?: string; due?: string; details?: string; accepted?: boolean; taskId?: string }

export interface MeetingsCapabilities { liveJoin: boolean; liveRecord: boolean; transcriptImport: boolean }

export interface Approval {
  id: string; botId: string | null; taskId: string | null; teamId: string | null; action: string; title: string;
  target: string; risk: "low" | "medium" | "high" | "critical"; status: string;
  payload: {
    inputs?: unknown; expected?: string; reversible?: boolean | null; dataShared?: string[];
    agent?: { id: string; name: string } | null; taskId?: string | null; requestedAt?: number; detail?: Record<string, unknown>;
  };
  decision: string | null; reason: string; requestedAt: number; decidedAt: number | null; expiresAt: number | null; decidedBy: string | null;
}

export interface PolicyRule { action: string; effect: "allow" | "ask" | "deny"; note?: string }

export interface TaskDetail {
  task: Task; children: Task[];
  handoffs: Array<{ id: string; fromBotId: string | null; toBotId: string | null; note: string; status: string; createdAt: number }>;
  events: Array<{ id: string; kind: string; severity: string; botId: string | null; detail: Record<string, unknown> | null; createdAt: number }>;
}

export interface TaskProposal { title: string; objective: string; deliverable: string; acceptance: string; status: "proposed" | "accepted" | "dismissed"; taskId?: string }

export interface ConversationMessage {
  id: string; botId: string; taskId: string | null; replyTo: string | null;
  role: "person" | "teammate" | "system"; kind: "message" | "proposal" | "instruction" | "notice";
  content: string; reactions: string[]; createdAt: number; updatedAt: number;
  data: {
    model?: string; provider?: string; unparsed?: boolean; cutShort?: boolean; outcome?: string;
    proposal?: TaskProposal; remembered?: Array<{ id: string; kind: string; content: string }>; memoryRefused?: string[];
    context?: { memoryIds: string[]; attachmentIds: string[]; openTaskIds: string[] };
    attachments?: Array<{ id: string; name: string; type: string; size: number }>;
    taskTitle?: string; receivedWhile?: string; applied?: string;
  };
}

export interface ConversationThread {
  bot: { id: string; name: string; role: string; status: string };
  messages: ConversationMessage[]; openTasks: Task[];
  usage: { messages: { used: number; limit: number } };
  model: { available: boolean; provider?: string; model?: string; reason?: string };
  reactions: string[];
}

export interface HardwareSnapshot {
  access: { robots: boolean; devices: boolean }; available: boolean; reason?: string; readAt: number;
  robots: Array<{ id: string; name: string; simulated: boolean; connection: string; mode: string; battery: number | null; lastSeenAt: number | null; places: string[] }>;
  missions: Array<{ id: string; robotId: string; title: string; capability: string; status: string }>;
  devices: Array<{ id: string; name: string; location: string; connection: string; readings: Record<string, { value: unknown; unit: string | null; ageS: number; live: boolean }> }>;
  hubs: Array<{ id: string; name: string; connection: string; lastSeenAt: number | null }>;
}
export interface HardwareView { access: { robots: boolean; devices: boolean }; snapshot: HardwareSnapshot | null; actions: Array<{ id: string; title: string; kind: string; inputs: string[] }>; note?: string }

export interface LocalJob {
  id: string; taskId: string; botId: string | null; computerId: string; kind: "browser" | "coding" | "open" | "notify";
  input: Record<string, unknown>; status: string; device: string | null; result: unknown; error: string | null; createdAt: number; updatedAt: number; expiresAt: number;
}
export interface LocalPermissions { mode: "ask" | "tasks" | "workspaces" | "never"; kinds: string[]; folders: string[] }

export interface NotificationSettings { categories: { approvals: boolean; completions: boolean; failures: boolean }; channelIds: string[]; webhooks: boolean; quietHours: boolean }
export interface NotificationChannel { id: string; kind: string; name: string; paired: boolean; pairedName: string | null; canNotify: boolean; reachable: boolean; teammateId: string | null }
export interface Delivery { id: string; eventId: string | null; eventKind: string; target: string; status: string; detail: Record<string, unknown> | null; createdAt: number }
export interface NotificationItem { id: string; kind: string; category: string; text: string; botId: string | null; taskId: string | null; createdAt: number; detail: Record<string, unknown> | null; deliveries: Delivery[] }

export interface UsageCount { used: number; limit: number }
export interface WorkforceUsage {
  window: string; since: number; account: { tasks: UsageCount; messages: UsageCount };
  bots: Array<{ botId: string; name: string; tasks: UsageCount; messages: UsageCount }>;
  defaults: { tasksPerDay: number; messagesPerDay: number };
}

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
  computerScreenshot: async (sessionId: string, live = false): Promise<Blob> => {
    const response = await apiFetch(apiUrl(`/api/workforce/sessions/${sessionId}/screenshot${live ? "?live=1" : ""}`));
    if (!response.ok) throw new Error("No screenshot has been taken yet.");
    return response.blob();
  },
  computerHandoff: (sessionId: string, body: { reason?: string; instructions?: string }) => post<{ ok: boolean; status: string; reason: string; instructions: string }>(`/sessions/${sessionId}/handoff`, body),
  computerResume: (sessionId: string) => post(`/sessions/${sessionId}/resume`, {}),
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
  routineCreate: (input: Record<string, unknown>) => post<{ routine: Routine; secret?: string; note?: string }>("/routines", input),
  routineWebhookSecret: (id: string) => post<{ webhook: NonNullable<Routine["webhook"]>; secret: string; note: string }>(`/routines/${id}/webhook-secret`, {}),
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
  memoryRecall: (query: string, botId?: string) => post<{ matches: MemoryRecord[]; method: string }>("/memory/recall", { query, ...(botId ? { botId } : {}) }),

  // -- tasks
  tasks: (params?: Record<string, string>) => get<{ tasks: Task[]; counts: Record<string, number> }>("/tasks", params),
  task: (id: string) => get<TaskDetail>(`/tasks/${id}`),
  taskPlan: (body: Record<string, unknown>) => post<{ task: Task; children: Task[] }>("/tasks/plan", body),
  taskCreate: (body: Record<string, unknown>) => post<{ task: Task }>("/tasks", body),
  taskDelegate: (id: string, body: Record<string, unknown>) => post(`/tasks/${id}/delegate`, body),
  taskHandoff: (id: string, body: Record<string, unknown>) => post(`/tasks/${id}/handoff`, body),
  taskVerify: (id: string, body?: Record<string, unknown>) => post(`/tasks/${id}/verify`, body || {}),
  taskRun: (id: string) => post<{ task: Task; outcome: unknown; note: string | null }>(`/tasks/${id}/run`, {}),
  taskSetStatus: (id: string, status: string, result?: string) => post<{ task: Task }>(`/tasks/${id}/status`, { status, ...(result ? { result } : {}) }),

  // -- approvals and policy
  approvals: (status = "pending") => get<{ approvals: Approval[]; serverTime: number }>("/approvals", { status }),
  approvalDecide: (id: string, decision: "allow" | "deny", reason?: string) => post<{ approval: Approval; resume: boolean }>(`/approvals/${id}/decide`, { decision, reason }),
  policies: () => get<{ rules: PolicyRule[]; organization: Array<{ teamId: string; rules: PolicyRule[] }>; risks: Record<string, string> }>("/policies"),
  policiesSet: (rules: PolicyRule[]) => put<{ rules: PolicyRule[] }>("/policies", { rules }),

  // -- conversations and usage
  conversation: (botId: string) => get<ConversationThread>(`/bots/${botId}/messages`),
  conversationSend: (botId: string, body: { content: string; replyTo?: string; taskId?: string; attachments?: string[] }) => post<{ messages: ConversationMessage[]; outcome?: string }>(`/bots/${botId}/messages`, body),
  conversationProposal: (botId: string, messageId: string, decision: "accept" | "dismiss", edits?: { title?: string; objective?: string }) => post<{ message: ConversationMessage; task: Task | null }>(`/bots/${botId}/messages/${messageId}/proposal`, { decision, ...(edits || {}) }),
  conversationReact: (botId: string, messageId: string, emoji: string) => post<{ message: ConversationMessage }>(`/bots/${botId}/messages/${messageId}/reactions`, { emoji }),
  conversationClear: (botId: string) => remove<{ ok: boolean; deleted: number }>(`/bots/${botId}/messages`),
  usage: () => get<WorkforceUsage>("/usage"),

  // -- hardware, desktop jobs and notifications
  botHardware: (botId: string) => get<HardwareView>(`/bots/${botId}/hardware`),
  taskHardwareAction: (taskId: string, index: number) => post<{ record: { id: string; status: string; action: string }; text: string }>(`/tasks/${taskId}/hardware-actions`, { index }),
  taskLocalJob: (taskId: string, body: { index?: number; computerId?: string; kind?: string; input?: Record<string, unknown> }) => post<{ job: LocalJob; note: string }>(`/tasks/${taskId}/local-jobs`, body),
  taskLocalJobs: (taskId: string) => get<{ jobs: LocalJob[] }>(`/tasks/${taskId}/local-jobs`),
  localJobCancel: (jobId: string) => post(`/local-jobs/${jobId}/cancel`, {}),
  localPermissions: (computerId: string, body: LocalPermissions) => put<{ computerId: string; permissions: LocalPermissions; kinds: Record<string, string> }>(`/computers/${computerId}/local-permissions`, body),
  notificationSettings: () => get<{ settings: NotificationSettings; channels: NotificationChannel[]; categories: string[]; webhookEvents: string[] }>("/notifications/settings"),
  notificationSettingsSet: (settings: Partial<NotificationSettings>) => put<{ settings: NotificationSettings }>("/notifications/settings", settings),
  notifications: (since?: number) => get<{ notifications: NotificationItem[]; deliveries: Delivery[]; serverTime: number }>("/notifications", since ? { since: String(since) } : undefined),
  notificationTest: (channelId: string) => post<{ ok: boolean }>("/notifications/test", { channelId }),
  channelTeammate: (channelId: string, botId: string | null) => put<{ channel: NotificationChannel; note: string }>(`/channels/${channelId}/teammate`, { botId }),

  // -- proactive
  proactive: () => get<{ settings: ProactiveSettings; categories: string[]; offers: ProactiveOffer[] }>("/proactive"),
  proactiveSettingsSet: (settings: Partial<ProactiveSettings>) => put("/proactive/settings", settings),
  proactiveScan: (force?: boolean) => post("/proactive/scan", { force: force === true }),
  proactiveOffers: (status?: string) => get("/proactive/offers", { status: status || "pending" }),
  proactiveDismiss: (id: string) => post(`/proactive/offers/${id}/dismiss`, {}),
  proactiveAct: (id: string) => post<{ ok: boolean; open: { screen: string; ids: string[] } }>(`/proactive/offers/${id}/act`, {}),

  // -- meetings
  meetings: () => get<{ meetings: Meeting[] }>("/meetings"),
  meetingsCapabilities: () => get<{ capabilities: MeetingsCapabilities }>("/meetings/capabilities"),
  meetingCreate: (input: Record<string, unknown>) => post<{ meeting: Meeting }>("/meetings", input),
  meetingTranscript: (id: string, transcript: string) => post(`/meetings/${id}/transcript`, { transcript }),
  meetingSummarize: (id: string) => post(`/meetings/${id}/summarize`, {}),
  meetingAcceptAction: (id: string, actionId: string, botId?: string) => post<{ ok: boolean; task: { id: string; title: string; status: string; botId: string } }>(`/meetings/${id}/actions/${actionId}/accept`, botId ? { botId } : {}),
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
