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
 */
import { getSessionGroqKey } from "./api";
import { DeviceTasks } from "./DeviceTasks";
import { MemoryService } from "./MemoryService";
import { notifyMemoryChanged } from "./MemoryStore";
import { ReminderService, notificationPermission } from "./ReminderService";
import { TaskSpineService } from "./TaskSpineService";
import type { WorkflowNode, WorkflowSchema } from "./WorkflowSchema";

export type Schedule =
  | { type: "manual" }
  | { type: "daily"; time: string; days: number[] }
  | { type: "interval"; hours: number };

export type ToolAction = "save-memory" | "create-reminder";
export type OutputChannel = "notify" | "speak" | "log";

export type StepStatus = "pending" | "running" | "waiting-approval" | "done" | "denied" | "failed" | "skipped";
export type RunStep = { nodeId: string; kind: WorkflowNode["kind"]; label: string; status: StepStatus; output?: string; error?: string; remoteApprovalId?: string };
export type RunStatus = "running" | "waiting-approval" | "done" | "denied" | "failed";
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
};

export type AutomationState = { workflowId: string; enabled: boolean; nextRunAt: number | null; lastRunAt?: number };

export const AUTOMATION_EVENT = "hannah:automations";
const STATE_KEY = "hannah.automations.v1";
const RUNS_KEY = "hannah.automation-runs.v1";
const MAX_RUNS = 50;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const MAX_CONTEXT = 3_000;

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
    const next: AutomationState = { ...this.state(workflow.id), enabled: enabled && schedule.type !== "manual", nextRunAt: enabled ? nextRunAt(schedule, now) : null };
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
    const run: AutomationRun = { id: crypto.randomUUID(), workflowId: workflow.id, name: workflow.name, trigger, status: "running", startedAt: deps.now(), steps: [] };
    try {
      run.steps = planSteps(workflow).map((node) => ({ nodeId: node.id, kind: node.kind, label: node.label, status: "pending" }));
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.finishedAt = deps.now();
      saveRun(run);
      return run;
    }
    saveRun(run);
    deps.remote?.report(run);
    return advance(run, workflow, deps);
  },

  /**
   * Approve or deny the action a run is waiting on, then continue or stop.
   * `fromOtherDevice` is set when the answer came from another signed-in device.
   */
  async decide(runId: string, approve: boolean, deps: AutomationDeps = defaultDeps, fromOtherDevice = false) {
    const run = readRuns().find((item) => item.id === runId);
    if (!run || run.status !== "waiting-approval") throw new Error("That run isn't waiting for approval.");
    const workflow = findWorkflow(run.workflowId);
    const index = run.steps.findIndex((step) => step.status === "waiting-approval");
    const node = workflow?.nodes.find((item) => item.id === run.steps[index]?.nodeId);
    if (!workflow || !node) {
      run.status = "failed";
      run.error = "The workflow was deleted or changed, so this run can't continue.";
      run.finishedAt = deps.now();
      saveRun(run);
      return run;
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
      return run;
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
      return run;
    }
    run.status = "running";
    saveRun(run);
    return advance(run, workflow, deps);
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
      writeJson(STATE_KEY, [{ ...state, lastRunAt: now, nextRunAt: nextRunAt(schedule, now) }, ...readStates().filter((item) => item.workflowId !== state.workflowId)]);
      started.push(await this.run(workflow, missedBy > 5 * 60_000 ? "catch-up" : "schedule", deps));
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
