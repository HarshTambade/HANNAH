/**
 * Automations that run.
 *
 * A saved workflow (see WorkflowSchema) runs on its trigger's schedule while
 * HANNAH is open in a browser tab or the desktop app. A run that was due while
 * HANNAH was closed happens once, the next time it opens. Steps run in order
 * along the workflow's connections:
 *
 *   trigger      when to run (manual, daily at a time, weekdays, every N hours)
 *   agent-task   asks HANNAH (the connected AI) to do the task; the previous
 *                step's result is passed along as context
 *   tool-action  something that changes your data (save a memory, create a
 *                reminder). The run pauses until you approve or deny it.
 *   output       shows a notification, speaks the result, or only records it
 *
 * Agent tasks use the AI chosen in chat (provider, model, your key) with no
 * tools. Runs and their step results are kept on this device (the latest 50).
 *
 * Signed in, automations and schedules sync to your account, and each run is a
 * durable task run there (TaskRecords): a scheduled slot has one id across
 * your devices, so whichever open device creates it first runs it and the
 * others skip it. Every change is a checkpoint, so a run paused for approval,
 * or cut off when its device closed, can be continued from another device;
 * and a run can be cancelled from any device.
 */
import { getSessionGroqKey } from "./api";
import { DeviceTasks } from "./DeviceTasks";
import { MemoryService } from "./MemoryService";
import { notifyMemoryChanged } from "./MemoryStore";
import { ReminderService, notificationPermission } from "./ReminderService";
import { TaskSpineService } from "./TaskSpineService";
import { TaskRecords, type LostReason, type RemoteRun, type RunStatus as RecordStatus } from "./TaskRecords";
import { thisDevice } from "./DeviceTasks";
import type { WorkflowNode, WorkflowSchema } from "./WorkflowSchema";

export type Schedule =
  | { type: "manual" }
  | { type: "daily"; time: string; days: number[] }
  | { type: "interval"; hours: number };

export type ToolAction = "save-memory" | "create-reminder";
export type OutputChannel = "notify" | "speak" | "log";

export type StepStatus = "pending" | "running" | "waiting-approval" | "done" | "denied" | "failed" | "skipped";
export type RunStep = { nodeId: string; kind: WorkflowNode["kind"]; label: string; status: StepStatus; output?: string; error?: string; remoteApprovalId?: string };
export type RunStatus = "running" | "waiting-approval" | "done" | "denied" | "failed" | "cancelled";
export type AutomationRun = {
  id: string;
  workflowId: string;
  name: string;
  trigger: "schedule" | "manual" | "catch-up";
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  steps: RunStep[];
  error?: string;
  /** Saved to your account, so it can be followed, continued or cancelled from your other devices. */
  durable?: boolean;
  /** The device working on it right now, when that's another of yours (from your account; not saved to it). */
  runningOn?: string;
  /** The device that last changed it (from your account). */
  lastDevice?: string;
  /** The workflow as it was when the run started, kept for runs that came from another device. */
  workflow?: WorkflowSchema;
};

export type AutomationState = { workflowId: string; enabled: boolean; nextRunAt: number | null; lastRunAt?: number; updatedAt?: number };

export const AUTOMATION_EVENT = "hannah:automations";
const STATE_KEY = "hannah.automations.v1";
const RUNS_KEY = "hannah.automation-runs.v1";
const MAX_RUNS = 50;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const MAX_CONTEXT = 3_000;
/** How long a durable run waits for its last checkpoint to be confirmed before the next step (offline: don't stall). */
const CHECKPOINT_WAIT_MS = 3_000;

// ---------- storage ----------

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the run still happens, it just isn't kept.
  }
  try {
    window.dispatchEvent(new Event(AUTOMATION_EVENT));
  } catch {
    // No window (tests without DOM).
  }
}

const readStates = () => readJson<AutomationState[]>(STATE_KEY, []).filter((item) => item && typeof item.workflowId === "string");
const readRuns = () => readJson<AutomationRun[]>(RUNS_KEY, []).filter((item) => item && typeof item.id === "string");

function saveRun(run: AutomationRun) {
  const runs = readRuns().filter((item) => item.id !== run.id);
  writeJson(RUNS_KEY, [run, ...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS));
  const live = liveRuns.get(run.id);
  if (live && run.durable) {
    const { runningOn: _elsewhere, workflow: _snapshot, lastDevice: _device, ...record } = run;
    void TaskRecords.checkpoint(run.id, { kind: "automation", title: run.name.slice(0, 140) || "Automation", status: recordStatus(run.status), record: { run: record, workflow: live.workflow } });
  }
}

/** Runs this device is working on (or holding while they wait for approval). */
const liveRuns = new Map<string, { workflow: WorkflowSchema; lost?: { message: string; reason: LostReason } }>();

/** The account's status for a run (the brief's task states). */
export function recordStatus(status: RunStatus): RecordStatus {
  if (status === "running") return "running";
  if (status === "waiting-approval") return "waiting-approval";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "completed";
}

/** One id per scheduled slot across your devices, so a slot runs once. */
export function slotRunId(workflowId: string, slot: number) {
  return `auto-${Math.floor(slot)}-${workflowId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50)}`;
}

const RUN_STATUSES = new Set<RunStatus>(["running", "waiting-approval", "done", "denied", "failed", "cancelled"]);
const STEP_STATUSES = new Set<StepStatus>(["pending", "running", "waiting-approval", "done", "denied", "failed", "skipped"]);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);

/** A run saved by one of your devices, checked before it's used here. */
export function runFromRecord(value: unknown, id: string): { run: AutomationRun; workflow: WorkflowSchema | null } | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as { run?: Partial<AutomationRun>; workflow?: WorkflowSchema }).run;
  if (!raw || raw.id !== id || typeof raw.workflowId !== "string" || typeof raw.name !== "string" || !RUN_STATUSES.has(raw.status as RunStatus) || !Array.isArray(raw.steps)) return null;
  const steps: RunStep[] = [];
  for (const item of raw.steps.slice(0, 30)) {
    const step = item as Partial<RunStep>;
    if (!step || typeof step.nodeId !== "string" || typeof step.label !== "string" || !STEP_STATUSES.has(step.status as StepStatus)) return null;
    const kind = step.kind === "trigger" || step.kind === "agent-task" || step.kind === "tool-action" || step.kind === "output" ? step.kind : null;
    if (!kind) return null;
    steps.push({ nodeId: step.nodeId.slice(0, 80), kind, label: step.label.slice(0, 200), status: step.status as StepStatus, ...(text(step.output, 20_000) !== undefined ? { output: text(step.output, 20_000) } : {}), ...(text(step.error, 2000) !== undefined ? { error: text(step.error, 2000) } : {}), ...(text(step.remoteApprovalId, 80) !== undefined ? { remoteApprovalId: text(step.remoteApprovalId, 80) } : {}) });
  }
  const snapshot = (value as { workflow?: WorkflowSchema }).workflow;
  const workflow = snapshot && typeof snapshot === "object" && typeof snapshot.id === "string" && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges) ? snapshot : null;
  return {
    run: {
      id,
      workflowId: raw.workflowId.slice(0, 80),
      name: raw.name.slice(0, 140),
      trigger: raw.trigger === "schedule" || raw.trigger === "catch-up" ? raw.trigger : "manual",
      status: raw.status as RunStatus,
      startedAt: Number(raw.startedAt) || Date.now(),
      ...(Number.isFinite(raw.finishedAt) ? { finishedAt: Number(raw.finishedAt) } : {}),
      steps,
      ...(text(raw.error, 2000) !== undefined ? { error: text(raw.error, 2000) } : {}),
      durable: true,
    },
    workflow,
  };
}

// ---------- schedules ----------

const clampHours = (value: number) => Math.min(168, Math.max(1, Math.round(value)));

/** Read a trigger's schedule, including the older cron-style "M H * * *" strings. Exported for tests. */
export function parseSchedule(config: Record<string, unknown> | undefined): Schedule {
  const raw = config?.schedule;
  if (raw && typeof raw === "object") {
    const value = raw as Partial<Schedule> & { time?: unknown; days?: unknown; hours?: unknown };
    if (value.type === "daily" && typeof value.time === "string" && /^\d{1,2}:\d{2}$/.test(value.time)) {
      const days = Array.isArray(value.days) ? value.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6) : ALL_DAYS;
      return { type: "daily", time: value.time.padStart(5, "0"), days: days.length ? [...new Set(days)].sort() : ALL_DAYS };
    }
    if (value.type === "interval" && typeof value.hours === "number" && Number.isFinite(value.hours)) return { type: "interval", hours: clampHours(value.hours) };
    return { type: "manual" };
  }
  if (typeof raw === "string") {
    const cron = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5)$/.exec(raw.trim());
    if (cron && Number(cron[1]) < 60 && Number(cron[2]) < 24) {
      return { type: "daily", time: `${cron[2].padStart(2, "0")}:${cron[1].padStart(2, "0")}`, days: cron[3] === "1-5" ? WEEKDAYS : ALL_DAYS };
    }
  }
  return { type: "manual" };
}

/** The first scheduled time strictly after `after`, or null for manual. Exported for tests. */
export function nextRunAt(schedule: Schedule, after: number): number | null {
  if (schedule.type === "manual") return null;
  if (schedule.type === "interval") return after + schedule.hours * 3_600_000;
  const [hours, minutes] = schedule.time.split(":").map(Number);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setHours(hours, minutes);
  for (let day = 0; day < 8; day += 1) {
    if (candidate.getTime() > after && schedule.days.includes(candidate.getDay())) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes, 0, 0);
  }
  return null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Plain words for a schedule, such as "Weekdays at 08:00". */
export function describeSchedule(schedule: Schedule) {
  if (schedule.type === "manual") return "Only when you run it";
  if (schedule.type === "interval") return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  const days = schedule.days.join(",") === ALL_DAYS.join(",") ? "Every day" : schedule.days.join(",") === WEEKDAYS.join(",") ? "Weekdays" : schedule.days.map((day) => DAY_NAMES[day]).join(", ");
  return `${days} at ${schedule.time}`;
}

export function workflowSchedule(workflow: WorkflowSchema): Schedule {
  return parseSchedule(workflow.nodes.find((node) => node.kind === "trigger")?.config);
}

// ---------- plan ----------

/**
 * The order steps run in: every node reachable from the trigger, each after all
 * of its reachable inputs. Throws on a loop or a missing trigger. Exported for tests.
 */
export function planSteps(workflow: WorkflowSchema): WorkflowNode[] {
  const trigger = workflow.nodes.find((node) => node.kind === "trigger");
  if (!trigger) throw new Error("This workflow has no trigger.");
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const reachable = new Set<string>([trigger.id]);
  const queue = [trigger.id];
  while (queue.length) {
    for (const next of outgoing.get(queue.shift()!) ?? []) if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
  }
  const indegree = new Map([...reachable].map((id) => [id, 0]));
  for (const edge of workflow.edges) if (reachable.has(edge.source) && reachable.has(edge.target)) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  const ready = [...reachable].filter((id) => indegree.get(id) === 0);
  const order: WorkflowNode[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      if (!reachable.has(next)) continue;
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== reachable.size) throw new Error("The workflow's connections form a loop. Remove one connection so it runs in one direction.");
  return order;
}

export const toolActionOf = (node: WorkflowNode): ToolAction => (node.config.action === "create-reminder" ? "create-reminder" : "save-memory");
export const outputChannelOf = (node: WorkflowNode): OutputChannel => (node.config.channel === "voice" || node.config.channel === "speak" ? "speak" : node.config.channel === "log" ? "log" : "notify");
const taskOf = (node: WorkflowNode) => (typeof node.config.task === "string" && node.config.task.trim() ? node.config.task : node.label).trim();

// ---------- execution ----------

export type AutomationDeps = {
  ask: (prompt: string) => Promise<string>;
  notify: (title: string, body: string) => void;
  speak: (text: string) => Promise<void>;
  saveMemory: (text: string, automation?: string) => void;
  createReminder: (text: string, dueAt: number) => void;
  now: () => number;
  /** Tasks across devices: report runs and let another signed-in device answer approvals. */
  remote?: {
    report: (run: AutomationRun) => void;
    ask: (id: string, title: string, detail: string) => Promise<string | null>;
    check: (id: string) => Promise<"approved" | "denied" | null>;
    answered: (id: string, approve: boolean) => void;
  };
};

function storedSetting(key: string) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

/**
 * The AI that agent tasks use: the same mode, provider and model chosen in
 * chat, so a routine answers like chat does and uses the same key. Exported for tests.
 */
export function automationModel(): { mode: "cloud" | "ollama"; providerId: string; model?: string } {
  const chatMode = storedSetting("hannah.chat.mode");
  if (chatMode === "webllm" || chatMode === "native") {
    throw new Error("Agent tasks need a cloud model or Ollama. Chat is set to an on-device model, which only runs while you chat. Pick a cloud model or Ollama in chat, then run this again.");
  }
  if (chatMode === "ollama") return { mode: "ollama", providerId: "ollama", model: storedSetting("hannah.ollamaModel") || undefined };
  const providerId = storedSetting("hannah.cloudProvider") || "groq";
  return { mode: "cloud", providerId, model: storedSetting(`hannah.cloudModel:${providerId}`) || undefined };
}

const ASK_TIMEOUT_MS = 120_000;

/** One agent turn with no tools: the task can't change anything without an approval step. */
async function askHannah(prompt: string) {
  const { mode, providerId, model } = automationModel();
  const { runAgentTurn } = await import("./AgentRuntime");
  const result = await runAgentTurn({
    mode,
    providerId,
    model,
    groqApiKey: getSessionGroqKey() || undefined,
    messages: [{ role: "user", content: prompt.slice(0, 4_000) }],
    allowedTools: [],
    maxIterations: 2,
    agentLabel: "Automation",
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    // Automations don't load an in-browser model in the background.
    generateLocal: async (_prompt, _mode, cause) => {
      throw cause instanceof Error ? cause : new Error("HANNAH's AI didn't answer. Try again in a moment.");
    },
  });
  if (result.outcome === "stopped") throw new Error("HANNAH didn't answer within 2 minutes, so the run stopped.");
  if (result.outcome) throw new Error(result.reply || "HANNAH didn't complete this task.");
  if (!result.reply.trim()) throw new Error("HANNAH returned an empty reply.");
  return result.reply;
}

export const AUTOMATION_OUTPUT_EVENT = "hannah:automation-output";
export type AutomationOutput = { title: string; body: string; kind: "result" | "approval" };

function showNotification(title: string, body: string) {
  const kind: AutomationOutput["kind"] = title.endsWith("needs your approval") ? "approval" : "result";
  // The in-app toast (AppShell) cancels the event when it shows it.
  const shownInApp = !window.dispatchEvent(new CustomEvent<AutomationOutput>(AUTOMATION_OUTPUT_EVENT, { detail: { title, body, kind }, cancelable: true }));
  if (shownInApp && document.visibilityState === "visible" && document.hasFocus()) return;
  if (notificationPermission() !== "granted") return;
  try {
    const notification = new Notification(title, { body: body.slice(0, 300), tag: `hannah-automation-${title}` });
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch {
    // Some WebViews expose Notification but can't construct it.
  }
}

async function speakText(text: string) {
  const { SpeechService } = await import("./SpeechService");
  await SpeechService.speak(text.slice(0, 1_500), "en-US");
}

export const defaultDeps: AutomationDeps = {
  ask: askHannah,
  notify: showNotification,
  speak: speakText,
  saveMemory: (text, automation) => {
    const result = MemoryService.remember(text, { source: { kind: "automation", ...(automation ? { detail: automation.slice(0, 120) } : {}) } });
    if (!result.ok) throw new Error(result.reason);
    notifyMemoryChanged();
  },
  createReminder: (text, dueAt) => { ReminderService.create(text, dueAt); },
  now: () => Date.now(),
  remote: {
    report: (run) => {
      const waiting = run.steps.find((step) => step.status === "waiting-approval");
      const done = run.steps.filter((step) => step.status === "done").length;
      DeviceTasks.report({
        id: run.id,
        title: `Automation: ${run.name}`,
        status: run.status === "done" ? "done" : run.status === "failed" ? "failed" : run.status === "denied" ? "stopped" : "running",
        detail: waiting ? `Waiting for your approval: ${waiting.label}` : run.error || `${done} of ${run.steps.length} steps done`,
      });
    },
    ask: async (id, title, detail) => (await DeviceTasks.requestApproval({ id, title, detail, expiresInMs: 30 * 60_000 }))?.id ?? null,
    check: async (id) => {
      const task = await DeviceTasks.status(id);
      return task?.status === "approved" || task?.status === "denied" ? task.status : null;
    },
    answered: (id, approve) => { void DeviceTasks.decide(id, approve).catch(() => undefined); },
  },
};

/** The text a step hands to the next one: the newest finished output before it. */
function previousOutput(run: AutomationRun, index: number) {
  for (let i = index - 1; i >= 0; i -= 1) if (run.steps[i].output) return run.steps[i].output!;
  return "";
}

/** Run (or continue) steps from the first unfinished one until done, a pause or a failure. */
async function advance(run: AutomationRun, workflow: WorkflowSchema, deps: AutomationDeps): Promise<AutomationRun> {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  for (let index = 0; index < run.steps.length; index += 1) {
    const step = run.steps[index];
    if (step.status !== "pending") continue;
    // Confirm the last checkpoint first, so a cancel or takeover from another device is known here.
    if (run.durable) await Promise.race([TaskRecords.settled(run.id), new Promise((resolve) => setTimeout(resolve, CHECKPOINT_WAIT_MS))]);
    // Cancelled, or taken over, from another of your devices: stop before the next step.
    const lost = liveRuns.get(run.id)?.lost;
    if (lost) {
      run.steps.slice(index).forEach((rest) => { if (rest.status === "pending") rest.status = "skipped"; });
      run.status = "cancelled";
      run.error = lost.message;
      run.finishedAt = deps.now();
      saveRun(run);
      deps.remote?.report(run);
      return run;
    }
    const node = nodes.get(step.nodeId);
    if (!node) { step.status = "skipped"; continue; }
    const context = previousOutput(run, index).slice(0, MAX_CONTEXT);
    try {
      if (node.kind === "trigger") {
        step.status = "done";
      } else if (node.kind === "agent-task") {
        step.status = "running";
        saveRun(run);
        const task = taskOf(node);
        step.output = await deps.ask(context ? `${task}\n\nResult of the previous step:\n${context}` : task);
        step.status = "done";
        // A checkpoint per finished step: another device can continue from here.
        saveRun(run);
      } else if (node.kind === "tool-action") {
        step.status = "waiting-approval";
        step.output = context;
        run.status = "waiting-approval";
        saveRun(run);
        const remoteId = await deps.remote?.ask(`auto-${run.id}-${index}`, `${run.name}: ${node.label}`, context || node.label).catch(() => null);
        if (remoteId) { step.remoteApprovalId = remoteId; saveRun(run); }
        deps.remote?.report(run);
        deps.notify(`${run.name} needs your approval`, `${node.label}. Open Automations${remoteId ? ", or answer on another signed-in device," : ""} to approve or deny it.`);
        return run;
      } else {
        const text = context || `${run.name} finished.`;
        const channel = outputChannelOf(node);
        if (channel === "notify") deps.notify(run.name, text);
        if (channel === "speak") await deps.speak(text);
        step.output = text;
        step.status = "done";
      }
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      run.steps.slice(index + 1).forEach((rest) => { rest.status = "skipped"; });
      run.status = "failed";
      run.error = step.error;
      run.finishedAt = deps.now();
      saveRun(run);
      deps.remote?.report(run);
      return run;
    }
  }
  run.status = "done";
  run.finishedAt = deps.now();
  saveRun(run);
  deps.remote?.report(run);
  return run;
}

function findWorkflow(workflowId: string) {
  return TaskSpineService.list().find((task) => task.kind === "workflow" && task.workflow?.id === workflowId)?.workflow;
}

export const AutomationService = {
  workflows(): WorkflowSchema[] {
    return TaskSpineService.list().filter((task) => task.kind === "workflow" && task.workflow).map((task) => task.workflow!);
  },
  states() {
    return readStates();
  },
  state(workflowId: string): AutomationState {
    return readStates().find((item) => item.workflowId === workflowId) ?? { workflowId, enabled: false, nextRunAt: null };
  },
  runs(workflowId?: string) {
    const runs = readRuns();
    return workflowId ? runs.filter((run) => run.workflowId === workflowId) : runs;
  },

  /** Turn a workflow's schedule on or off. Returns the new state. */
  setEnabled(workflow: WorkflowSchema, enabled: boolean, now = Date.now()) {
    const schedule = workflowSchedule(workflow);
    const next: AutomationState = { ...this.state(workflow.id), enabled: enabled && schedule.type !== "manual", nextRunAt: enabled ? nextRunAt(schedule, now) : null, updatedAt: now };
    writeJson(STATE_KEY, [next, ...readStates().filter((item) => item.workflowId !== workflow.id)]);
    return next;
  },

  /** Recompute the next run after a workflow was edited. */
  reschedule(workflow: WorkflowSchema, now = Date.now()) {
    const current = this.state(workflow.id);
    return current.enabled ? this.setEnabled(workflow, true, now) : current;
  },

  forget(workflowId: string) {
    writeJson(STATE_KEY, readStates().filter((item) => item.workflowId !== workflowId));
  },

  /** Start a run now. Resolves when it finishes, pauses for approval, or fails. */
  async run(workflow: WorkflowSchema, trigger: AutomationRun["trigger"] = "manual", deps: AutomationDeps = defaultDeps) {
    return (await this.start(workflow, trigger, deps))!;
  },

  /**
   * Start a run, as a durable task run in your account when signed in. With a
   * `slot` (a scheduled time), the run has one id across your devices: the
   * device that creates it first runs it, and this returns null on the others.
   */
  async start(workflow: WorkflowSchema, trigger: AutomationRun["trigger"], deps: AutomationDeps = defaultDeps, slot?: number): Promise<AutomationRun | null> {
    const durable = TaskRecords.enabled();
    const id = slot !== undefined && durable ? slotRunId(workflow.id, slot) : `auto-m-${crypto.randomUUID()}`.replace(/[^A-Za-z0-9_-]/g, "");
    const run: AutomationRun = { id, workflowId: workflow.id, name: workflow.name, trigger, status: "running", startedAt: deps.now(), steps: [], ...(durable ? { durable: true } : {}) };
    try {
      run.steps = planSteps(workflow).map((node) => ({ nodeId: node.id, kind: node.kind, label: node.label, status: "pending" }));
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.finishedAt = deps.now();
      saveRun(run);
      return run;
    }
    if (durable) {
      const { runningOn: _elsewhere, workflow: _snapshot, lastDevice: _device, ...record } = run;
      const created = await TaskRecords.create(id, { kind: "automation", title: run.name.slice(0, 140) || "Automation", status: "running", record: { run: record, workflow } });
      // Another device already runs this slot (or ran it): nothing to do here.
      if (created.outcome === "exists") return null;
      if (created.outcome === "created") {
        liveRuns.set(id, { workflow });
        TaskRecords.attach(id, (message, reason) => { const live = liveRuns.get(id); if (live) live.lost = { message, reason }; });
      } else {
        // Server unreachable: run on this device only, as when signed out.
        delete run.durable;
        liveRuns.set(id, { workflow });
      }
    } else {
      liveRuns.set(id, { workflow });
    }
    saveRun(run);
    deps.remote?.report(run);
    return this.finishTurn(await advance(run, workflow, deps));
  },

  /** After a turn of work: release the run unless it's waiting for an approval this device will act on. */
  finishTurn(run: AutomationRun) {
    if (run.status !== "waiting-approval") {
      liveRuns.delete(run.id);
      if (run.durable) TaskRecords.detach(run.id);
    }
    return run;
  },

  isLive(runId: string) {
    return liveRuns.has(runId);
  },

  /**
   * Take over a run from your account on this device: one that was cut off
   * when its device closed, or is waiting for an approval you'll give here.
   * Throws when another device is still working on it.
   */
  async takeOver(runId: string, deps: AutomationDeps = defaultDeps): Promise<{ run: AutomationRun; workflow: WorkflowSchema }> {
    const local = readRuns().find((item) => item.id === runId);
    const remote = await TaskRecords.claim(runId);
    if (!remote) throw new Error("This run is no longer in your account.");
    const parsed = runFromRecord(remote.record, runId);
    const run: AutomationRun = parsed?.run ?? local ?? (() => { throw new Error("This run can't be read."); })();
    const workflow = findWorkflow(run.workflowId) ?? parsed?.workflow ?? local?.workflow;
    if (!workflow) throw new Error("The automation this run belongs to isn't on this device yet. Sync your account, then try again.");
    run.durable = true;
    delete run.runningOn;
    for (const step of run.steps) if (step.status === "running") step.status = "pending";
    if (run.status === "running" || run.status === "waiting-approval") {
      liveRuns.set(run.id, { workflow });
      TaskRecords.attach(run.id, (message, reason) => { const live = liveRuns.get(run.id); if (live) live.lost = { message, reason }; });
    }
    saveRun(run);
    deps.remote?.report(run);
    return { run, workflow };
  },

  /** Continue a run that was cut off on another device (or this one, before a reload). */
  async continueRun(runId: string, deps: AutomationDeps = defaultDeps) {
    const { run, workflow } = await this.takeOver(runId, deps);
    if (run.status !== "running") return run;
    return this.finishTurn(await advance(run, workflow, deps));
  },

  /** Stop a run that another of your devices is working on. It stops before its next step. */
  async cancelElsewhere(runId: string) {
    const remote = await TaskRecords.cancel(runId);
    const runs = readRuns();
    const index = runs.findIndex((item) => item.id === runId);
    if (index >= 0) {
      const parsed = runFromRecord(remote.record, runId);
      runs[index] = { ...(parsed?.run ?? runs[index]), status: "cancelled", error: runs[index].error || `Cancelled from ${thisDevice().name}.`, finishedAt: Date.now(), lastDevice: remote.lastDevice };
      writeJson(RUNS_KEY, runs);
    }
  },

  /** Bring in runs from your other devices, and which device is working on each. */
  async syncFromAccount() {
    if (!TaskRecords.enabled()) return;
    await TaskRecords.retryPending();
    const remote = await TaskRecords.list().catch(() => null);
    if (!remote) return;
    const runs = readRuns();
    let changed = false;
    const apply = (item: RemoteRun, run: AutomationRun, workflow: WorkflowSchema | null): AutomationRun => {
      const elsewhere = item.lease && item.lease.deviceId !== thisDevice().id ? item.lease.deviceName : undefined;
      const next: AutomationRun = { ...run, durable: true, lastDevice: item.lastDevice };
      if (elsewhere) next.runningOn = elsewhere;
      else delete next.runningOn;
      if (item.status === "cancelled" && next.status !== "cancelled") {
        next.status = "cancelled";
        next.error = next.error || `Cancelled from ${item.lastDevice}.`;
        next.finishedAt = next.finishedAt ?? item.finishedAt ?? Date.now();
      }
      if (workflow && !findWorkflow(next.workflowId)) next.workflow = workflow;
      else delete next.workflow;
      return next;
    };
    for (const item of remote) {
      if (item.kind !== "automation") continue;
      if (liveRuns.has(item.id)) {
        // Held here (for example waiting for an approval): keep ours, unless another device took it over or finished it.
        const ours = item.lease?.deviceId === thisDevice().id;
        const takenOrFinished = (item.lease && !ours) || item.status === "completed" || item.status === "cancelled" || item.status === "failed";
        if (!takenOrFinished) continue;
        liveRuns.delete(item.id);
        TaskRecords.detach(item.id);
      }
      const parsed = runFromRecord(item.record, item.id);
      if (!parsed) continue;
      const index = runs.findIndex((run) => run.id === item.id);
      const known = TaskRecords.knownVersion(item.id);
      if (index < 0 || known === null || item.version > known) {
        const next = apply(item, parsed.run, parsed.workflow);
        if (index < 0) runs.push(next);
        else runs[index] = next;
        TaskRecords.rememberVersion(item.id, item.version);
        changed = true;
        continue;
      }
      const refreshed = apply(item, runs[index], parsed.workflow);
      if (refreshed.runningOn !== runs[index].runningOn || refreshed.status !== runs[index].status) {
        runs[index] = refreshed;
        changed = true;
      }
    }
    if (changed) writeJson(RUNS_KEY, runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS));
  },

  /**
   * Approve or deny the action a run is waiting on, then continue or stop.
   * `fromOtherDevice` is set when the answer came from another signed-in device.
   */
  async decide(runId: string, approve: boolean, deps: AutomationDeps = defaultDeps, fromOtherDevice = false): Promise<AutomationRun> {
    let run = readRuns().find((item) => item.id === runId);
    if (!run || run.status !== "waiting-approval") throw new Error("That run isn't waiting for approval.");
    let workflow = findWorkflow(run.workflowId);
    if (run.durable && !liveRuns.has(run.id) && TaskRecords.enabled()) {
      // A run from another device: take it over here, or, while that device still holds it, send the answer there.
      try {
        ({ run, workflow } = await this.takeOver(runId, deps));
      } catch (error) {
        const waiting = run.steps.find((step) => step.status === "waiting-approval");
        if (run.runningOn && waiting?.remoteApprovalId && deps.remote) {
          deps.remote.answered(waiting.remoteApprovalId, approve);
          return run;
        }
        throw error;
      }
    }
    const index = run.steps.findIndex((step) => step.status === "waiting-approval");
    const node = workflow?.nodes.find((item) => item.id === run.steps[index]?.nodeId);
    if (!workflow || !node) {
      run.status = "failed";
      run.error = "The workflow was deleted or changed, so this run can't continue.";
      run.finishedAt = deps.now();
      saveRun(run);
      return this.finishTurn(run);
    }
    const step = run.steps[index];
    if (step.remoteApprovalId && !fromOtherDevice) deps.remote?.answered(step.remoteApprovalId, approve);
    if (!approve) {
      step.status = "denied";
      run.steps.slice(index + 1).forEach((rest) => { rest.status = "skipped"; });
      run.status = "denied";
      run.finishedAt = deps.now();
      saveRun(run);
      deps.remote?.report(run);
      return this.finishTurn(run);
    }
    const text = (step.output || `${run.name}: ${node.label}`).trim();
    try {
      if (toolActionOf(node) === "create-reminder") {
        const minutes = typeof node.config.minutes === "number" && node.config.minutes > 0 ? node.config.minutes : 60;
        deps.createReminder(text.slice(0, 280), deps.now() + minutes * 60_000);
        step.output = `Reminder set for ${minutes} minutes from approval: ${text.slice(0, 120)}`;
      } else {
        deps.saveMemory(text, run.name);
        step.output = text;
      }
      step.status = "done";
    } catch (error) {
      step.status = "failed";
      step.error = error instanceof Error ? error.message : String(error);
      run.steps.slice(index + 1).forEach((rest) => { rest.status = "skipped"; });
      run.status = "failed";
      run.error = step.error;
      run.finishedAt = deps.now();
      saveRun(run);
      return this.finishTurn(run);
    }
    run.status = "running";
    saveRun(run);
    return this.finishTurn(await advance(run, workflow, deps));
  },

  /** Continue runs whose approval was answered on another device. */
  async syncRemoteApprovals(deps: AutomationDeps = defaultDeps) {
    const decided: AutomationRun[] = [];
    if (!deps.remote) return decided;
    for (const run of readRuns()) {
      const step = run.status === "waiting-approval" ? run.steps.find((item) => item.status === "waiting-approval" && item.remoteApprovalId) : undefined;
      if (!step?.remoteApprovalId) continue;
      const answer = await deps.remote.check(step.remoteApprovalId).catch(() => null);
      if (answer) decided.push(await this.decide(run.id, answer === "approved", deps, true));
    }
    return decided;
  },

  /**
   * Runs that were still "running" when HANNAH closed or reloaded can't
   * continue; mark them failed so they don't look stuck forever.
   */
  recoverInterrupted(now = Date.now()) {
    const runs = readRuns();
    let changed = false;
    for (const run of runs) {
      if (run.status !== "running" || now - run.startedAt < 10 * 60_000) continue;
      // Saved in your account: it can be continued from here or another device instead.
      if (run.durable && TaskRecords.enabled()) continue;
      for (const step of run.steps) {
        if (step.status === "running") { step.status = "failed"; step.error = "Interrupted."; }
        else if (step.status === "pending") step.status = "skipped";
      }
      run.status = "failed";
      run.error = "HANNAH was closed or reloaded before this run finished.";
      run.finishedAt = now;
      changed = true;
    }
    if (changed) writeJson(RUNS_KEY, runs);
  },

  /**
   * Start every enabled workflow whose time has come. A run missed while
   * HANNAH was closed happens once ("catch-up"), not once per missed slot.
   */
  async runDue(deps: AutomationDeps = defaultDeps) {
    const now = deps.now();
    const started: AutomationRun[] = [];
    for (const state of readStates()) {
      if (!state.enabled || state.nextRunAt === null || state.nextRunAt > now) continue;
      const workflow = findWorkflow(state.workflowId);
      if (!workflow) { this.forget(state.workflowId); continue; }
      const missedBy = now - state.nextRunAt;
      const schedule = workflowSchedule(workflow);
      writeJson(STATE_KEY, [{ ...state, lastRunAt: now, nextRunAt: nextRunAt(schedule, now), updatedAt: now }, ...readStates().filter((item) => item.workflowId !== state.workflowId)]);
      const run = await this.start(workflow, missedBy > 5 * 60_000 ? "catch-up" : "schedule", deps, state.nextRunAt);
      if (run) started.push(run);
    }
    return started;
  },
};

let runnerTimer: number | undefined;
let ticking = false;

/** Check for due automations every 30 seconds while HANNAH is open. */
export function startAutomationRunner() {
  if (runnerTimer !== undefined || typeof window === "undefined") return () => undefined;
  AutomationService.recoverInterrupted();
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      // With HANNAH open in two tabs, only one runs a due automation.
      const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
      if (locks?.request) {
        await locks.request("hannah-automations", { ifAvailable: true }, async (lock) => { if (lock) await AutomationService.runDue(); });
      } else {
        await AutomationService.runDue();
      }
      await AutomationService.syncFromAccount();
    } catch (error) {
      console.warn("[automations] check failed", error);
    } finally {
      ticking = false;
    }
  };
  void tick();
  runnerTimer = window.setInterval(() => void tick(), 30_000);
  // Answers given on another device: check every 5 seconds while a run waits for one.
  let checking = false;
  const remoteTimer = window.setInterval(() => {
    if (checking || !AutomationService.runs().some((run) => run.status === "waiting-approval" && run.steps.some((step) => step.remoteApprovalId))) return;
    checking = true;
    void AutomationService.syncRemoteApprovals().catch(() => undefined).finally(() => { checking = false; });
  }, 5_000);
  const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(runnerTimer);
    window.clearInterval(remoteTimer);
    runnerTimer = undefined;
    document.removeEventListener("visibilitychange", onVisible);
  };
}
