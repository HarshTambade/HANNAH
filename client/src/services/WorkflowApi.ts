/**
 * Client for the server workflow engine (server/workflows). Workflows are
 * stored, validated and run on the server, so this file only talks to the
 * API; nothing here executes a workflow.
 */
import { accountRequest, AccountError } from "./Account";

export type NodeCategory = "trigger" | "action" | "logic" | "data" | "ai";
export type ParamSchema = {
  name: string;
  label: string;
  type: "string" | "text" | "number" | "boolean" | "select" | "json" | "keyValue" | "conditions" | "rules" | "fieldRules" | "list" | "days" | "code" | "model";
  default?: unknown;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  help?: string;
  placeholder?: string;
  expression?: boolean;
  showIf?: Record<string, string | string[]>;
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
};
export type NodeDefinition = {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  icon: string;
  status: "available" | "beta" | "upcoming";
  inputs: string[];
  outputs: string[] | "dynamic";
  dynamicOutputs: boolean;
  params: ParamSchema[];
  credential?: { types: string[]; required: boolean };
  permissions: string[];
  sensitive?: boolean;
};
export type CredentialTypeSpec = { label: string; fields: Array<{ name: string; label: string; secret?: boolean; placeholder?: string; type?: "keyValue" }> };
export type Catalog = { nodes: NodeDefinition[]; operators: Record<string, { label: string; unary: boolean }>; credentialTypes: Record<string, CredentialTypeSpec> };

export type WorkflowNode = {
  id: string;
  name: string;
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  credentialId?: string;
  disabled?: boolean;
  notes?: string;
  settings?: { retries?: number; retryDelayMs?: number; timeoutMs?: number; continueOnFail?: boolean };
};
export type WorkflowConnection = { id: string; source: string; target: string; sourceOutput: string; targetInput: string };
export type WorkflowDefinition = { format: "hannah-workflow"; version: 2; nodes: WorkflowNode[]; connections: WorkflowConnection[]; settings: { timezone: string; timeoutMs?: number } };
export type Problem = { nodeId?: string; field?: string; message: string };
export type Validation = { errors: Problem[]; warnings: Problem[] };
export type Permission = { permission: string; nodes: string[] };
export type WorkflowSummary = {
  id: string; name: string; description: string; active: boolean; draftVersion: number; publishedVersion: number | null; createdAt: number; updatedAt: number;
  nodes?: number; triggers?: string[]; lastRun?: { status: ExecutionStatus; at: number; error: string | null } | null; nextRunAt?: number | null;
  /** For a New email trigger: when the mailbox was last checked, and why the check failed. */
  mailbox?: { checkedAt: number | null; lastError: string | null } | null;
};
export type WebhookInfo = { nodeId: string; triggerId: string; url: string; enabled: boolean; auth: "token" | "hmac"; hmacReady: boolean };
export type WorkflowDetail = {
  workflow: WorkflowSummary; definition: WorkflowDefinition; published: WorkflowDefinition | null; validation: Validation;
  permissions: Permission[]; publishedPermissions: Permission[] | null; approvedCurrent: boolean; webhooks: WebhookInfo[]; unpublishedChanges: boolean;
};
export type WebhookSecret = { nodeId: string; triggerId: string; secret: string };
export type ExecutionStatus = "queued" | "running" | "waiting" | "waiting-approval" | "completed" | "failed" | "cancelled" | "timed-out";
export type Execution = {
  id: string; workflowId: string; workflowVersion: number | null; mode: "manual" | "test" | "schedule" | "webhook" | "event" | "retry"; status: ExecutionStatus;
  error: string | null; errorNode: string | null; attempts: number; waiting: { nodeId?: string; kind: "time" | "approval" | "webhook" | "device" | "phone" | "paused"; until?: number; message?: string; details?: unknown; retry?: boolean } | null;
  retryOf: string | null; cancelRequested: boolean; pauseRequested?: boolean; recoveries?: number; createdAt: number; startedAt: number | null; finishedAt: number | null; updatedAt: number;
  workflowName?: string; nodes?: { done: number; failed: number; skipped: number; total: number };
};
export type PortData = Record<string, { count: number; items: unknown[] }>;
export type NodeRun = { nodeId: string; name: string; status: string; attempts: number; startedAt: number | null; finishedAt: number | null; durationMs: number | null; input: { count: number; items: unknown[] } | null; output: PortData | null; error: string | null; logs?: string[] | null };
export type ExecutionDetail = { execution: Execution & { triggerData: unknown }; definition: WorkflowDefinition; nodes: NodeRun[]; resumeUrl: string | null };
export type Credential = { id: string; name: string; type: string; typeLabel: string; hint: string; createdAt: number; updatedAt: number };

const json = (body: unknown) => JSON.stringify(body);
const post = <T>(path: string, body: unknown = {}) => accountRequest<T>(path, { method: "POST", body: json(body) });

let catalogPromise: Promise<Catalog> | null = null;

export const WorkflowApi = {
  catalog() {
    catalogPromise ??= accountRequest<Catalog>("/api/workflows/catalog").catch((error) => { catalogPromise = null; throw error; });
    return catalogPromise;
  },
  /** Whether this server and session can use server workflows: "ready", or why not. */
  async availability(): Promise<"ready" | "sign-in" | "database-required" | "unreachable"> {
    try {
      await accountRequest("/api/workflows");
      return "ready";
    } catch (error) {
      if (error instanceof AccountError) {
        if (error.reason === "database-required") return "database-required";
        if (error.status === 401 || error.status === 403) return "sign-in";
      }
      return "unreachable";
    }
  },
  list: () => accountRequest<{ workflows: WorkflowSummary[] }>("/api/workflows"),
  create: (name: string, definition?: WorkflowDefinition) => post<{ workflow: WorkflowSummary; definition: WorkflowDefinition }>("/api/workflows", { name, definition }),
  fromText: (description: string) => post<{ workflow: WorkflowSummary; definition: WorkflowDefinition; validation: Validation; notes: string }>("/api/workflows/from-text", { description, timezone: localTimeZone() }),
  importFile: (file: unknown) => post<{ workflow: WorkflowSummary; definition: WorkflowDefinition; validation: Validation }>("/api/workflows/import", file),
  get: (id: string) => accountRequest<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}`),
  save: (id: string, body: { baseVersion: number; name?: string; description?: string; definition?: WorkflowDefinition }) => accountRequest<{ workflow: WorkflowSummary; validation: Validation; permissions: Permission[] }>(`/api/workflows/${encodeURIComponent(id)}`, { method: "PUT", body: json(body) }),
  remove: (id: string) => accountRequest<{ ok: true }>(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  validate: (id: string, definition?: WorkflowDefinition) => post<{ validation: Validation; permissions: Permission[] }>(`/api/workflows/${encodeURIComponent(id)}/validate`, { definition }),
  publish: (id: string) => post<{ version: number; active: boolean; needsActivation: boolean; permissions: Permission[]; webhookSecrets: WebhookSecret[] }>(`/api/workflows/${encodeURIComponent(id)}/publish`),
  activate: (id: string, approvedPermissions: Permission[]) => post<{ active: true; webhookSecrets: WebhookSecret[]; webhooks: WebhookInfo[] }>(`/api/workflows/${encodeURIComponent(id)}/activate`, { approvedPermissions }),
  deactivate: (id: string) => post<{ active: false }>(`/api/workflows/${encodeURIComponent(id)}/deactivate`),
  run: (id: string, options: { draft?: boolean; triggerData?: unknown; triggerNodeId?: string } = {}) => post<{ executionId: string }>(`/api/workflows/${encodeURIComponent(id)}/run`, options),
  /** Upload a file to a workflow that starts with "File uploaded"; test runs the draft. */
  uploadFile: (id: string, file: File, { test = false }: { test?: boolean } = {}) => accountRequest<{ executionId: string; file: { name: string; type: string; size: number; sha256: string } }>(
    `/api/workflows/${encodeURIComponent(id)}/files${test ? "?test=1" : ""}`,
    { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Type": file.type || "" }, signal: AbortSignal.timeout(60_000) },
  ),
  testNode: (id: string, nodeId: string, items?: unknown[], definition?: WorkflowDefinition) => post<{ status: string; error: string | null; output: PortData | null; waiting: { kind: string; message: string | null } | null }>(`/api/workflows/${encodeURIComponent(id)}/test-node`, { nodeId, items, definition }),
  versions: (id: string) => accountRequest<{ versions: Array<{ version: number; createdAt: number; published: boolean }> }>(`/api/workflows/${encodeURIComponent(id)}/versions`),
  restore: (id: string, version: number) => post<{ definition: WorkflowDefinition; draftVersion: number }>(`/api/workflows/${encodeURIComponent(id)}/versions/${version}/restore`),
  rotateWebhook: (id: string, nodeId: string) => post<WebhookSecret>(`/api/workflows/${encodeURIComponent(id)}/webhooks/${encodeURIComponent(nodeId)}/rotate`),
  exportFile: (id: string) => accountRequest<Record<string, unknown>>(`/api/workflows/${encodeURIComponent(id)}/export`),
  executions: (filter: { workflowId?: string; status?: string; limit?: number } = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    return accountRequest<{ executions: Execution[] }>(`/api/workflows/executions${query.size ? `?${query}` : ""}`);
  },
  execution: (id: string) => accountRequest<ExecutionDetail>(`/api/workflows/executions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) }),
  cancel: (id: string) => post<{ status: string }>(`/api/workflows/executions/${encodeURIComponent(id)}/cancel`),
  retry: (id: string, from: "failed" | "start" = "failed") => post<{ executionId: string }>(`/api/workflows/executions/${encodeURIComponent(id)}/retry`, { from }),
  pause: (id: string) => post<{ status: "paused" | "pausing" }>(`/api/workflows/executions/${encodeURIComponent(id)}/pause`),
  /** Continue a paused run from the step it stopped at. */
  resume: (id: string) => post<{ status: string }>(`/api/workflows/executions/${encodeURIComponent(id)}/resume`, {}),
  answer: (id: string, approved: boolean) => post<{ status: string }>(`/api/workflows/executions/${encodeURIComponent(id)}/resume`, { approved }),
  approvals: () => accountRequest<{ approvals: Execution[] }>("/api/workflows/approvals"),
  credentials: () => accountRequest<{ vault: boolean; credentials: Credential[] }>("/api/workflows/credentials"),
  createCredential: (name: string, type: string, data: Record<string, unknown>) => post<{ credential: Credential }>("/api/workflows/credentials", { name, type, data }),
  deleteCredential: (id: string) => accountRequest<{ ok: true }>(`/api/workflows/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }),
  notifications: (since = 0) => accountRequest<{ notifications: Array<{ id: string; title: string; body: string; source: string | null; createdAt: number; read: boolean }> }>(`/api/notifications?since=${since}`),
  markRead: (id: string) => post<{ ok: true }>(`/api/notifications/${encodeURIComponent(id)}/read`),
};

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Output port names for a node, given its parameters (Switch and Classify depend on them). */
export function outputsFor(definition: NodeDefinition, params: Record<string, unknown>): string[] {
  if (!definition.dynamicOutputs) return definition.outputs as string[];
  if (definition.type === "logic.switch") return [...((params.rules as unknown[]) ?? []).map((_, index) => `case${index}`), "otherwise"];
  if (definition.type === "ai.classify") return [...((params.categories as unknown[]) ?? []).map((_, index) => `category${index}`), "other"];
  return ["main"];
}

/** A readable label for an output port. */
export function portLabel(definition: NodeDefinition, params: Record<string, unknown>, port: string) {
  const index = /(?:case|category)(\d+)$/.exec(port);
  if (index && definition.type === "logic.switch") return String((params.rules as Array<{ right?: unknown }>)?.[Number(index[1])]?.right ?? port);
  if (index && definition.type === "ai.classify") return String((params.categories as unknown[])?.[Number(index[1])] ?? port);
  return port === "main" ? "" : port;
}

export function defaultsFor(definition: NodeDefinition): Record<string, unknown> {
  return Object.fromEntries(definition.params.map((param) => [param.name, structuredClone(param.default)]));
}

export const PERMISSION_LABELS: Record<string, string> = {
  network: "Call internet services over HTTP",
  actions: "Ask HANNAH's Action Engine for actions (each still needs your approval or a standing permission), and read your connected repositories",
  "receive-webhooks": "Receive requests from other services at a private URL",
  notify: "Send you notifications",
  "send-email": "Send or draft email from your connected account",
  "send-email-without-asking": "Send email without asking you each time",
  calendar: "Read and add calendar events",
  "post-messages": "Post messages to Slack or Discord",
  github: "Create issues and comments on GitHub",
  notion: "Add pages in Notion",
  database: "Run SQL on your database",
  "memory-write": "Save to your HANNAH memories",
  "memory-read": "Read your HANNAH memories (never sensitive ones)",
  reminders: "Create reminders",
  ai: "Use your AI provider keys (counts toward their usage)",
  "computer-use": "Control your computer",
  desktop: "Send tasks to your desktop app (opening apps and links, reading web pages, coding in shared folders, notifications); each one asks you there",
  "phone-read": "See your paired phones and whether they're online",
  "phone-contacts": "Look up names in your paired phone's contacts",
  "phone-call": "Open your phone's dialer with a number (you approve each run, then tap Call)",
  "phone-sms": "Open your phone's messaging app with a text (you approve each run, then tap Send)",
  "read-email": "Read your email",
  "chat-read": "Read Google Chat spaces you're in",
  "chat-send": "Post in Google Chat as you (you approve each run)",
  "run-code": "Run your JavaScript in an isolated sandbox (no network or files)",
};
