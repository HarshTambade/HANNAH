/**
 * The automation editor's model: a trigger plus steps in order.
 *
 * Runs go step by step, each step receiving the previous step's result, so an
 * ordered list is exactly what the editor needs. It's stored as the same
 * WorkflowSchema as before (a trigger node and a chain of edges), so saved
 * automations, the runner and the run history don't change.
 */
import { describeSchedule, outputChannelOf, parseSchedule, planSteps, toolActionOf, type OutputChannel, type Schedule, type ToolAction } from "./AutomationService";
import type { WorkflowNode, WorkflowSchema } from "./WorkflowSchema";

export type StepKind = "agent-task" | "tool-action" | "output";
export type DraftStep =
  | { id: string; kind: "agent-task"; task: string }
  | { id: string; kind: "tool-action"; action: ToolAction; minutes: number }
  | { id: string; kind: "output"; channel: OutputChannel };
export type Draft = { id: string; name: string; createdAt: string; schedule: Schedule; steps: DraftStep[] };

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const toolLabels: Record<ToolAction, string> = { "save-memory": "Save the result to memory", "create-reminder": "Create a reminder from the result" };
export const outputLabels: Record<OutputChannel, string> = { notify: "Show a notification", speak: "Speak the result aloud", log: "Only keep it in run history" };

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function newStep(kind: StepKind): DraftStep {
  if (kind === "agent-task") return { id: newId("agent"), kind, task: "" };
  if (kind === "tool-action") return { id: newId("action"), kind, action: "save-memory", minutes: 60 };
  return { id: newId("output"), kind, channel: "notify" };
}

/** A short name for a step, used on the saved node and in run history. */
export function stepLabel(step: DraftStep) {
  if (step.kind === "agent-task") return step.task.trim().split("\n")[0].slice(0, 80) || "Ask HANNAH";
  if (step.kind === "tool-action") return toolLabels[step.action];
  return outputLabels[step.channel];
}

function stepFromNode(node: WorkflowNode): DraftStep | null {
  if (node.kind === "agent-task") return { id: node.id, kind: "agent-task", task: typeof node.config.task === "string" ? node.config.task : node.label };
  if (node.kind === "tool-action") {
    const minutes = typeof node.config.minutes === "number" && node.config.minutes > 0 ? node.config.minutes : 60;
    return { id: node.id, kind: "tool-action", action: toolActionOf(node), minutes };
  }
  if (node.kind === "output") return { id: node.id, kind: "output", channel: outputChannelOf(node) };
  return null;
}

/**
 * Open a saved automation in the editor. Steps come in the order they run;
 * steps an older canvas-built automation left unconnected never ran, and are
 * returned separately so the editor can say so.
 */
export function draftFromWorkflow(workflow: WorkflowSchema): { draft: Draft; unconnected: number } {
  const trigger = workflow.nodes.find((node) => node.kind === "trigger");
  let ordered: WorkflowNode[];
  try {
    ordered = planSteps(workflow);
  } catch {
    // A loop or no trigger: fall back to left-to-right order on the old canvas.
    ordered = [...workflow.nodes].sort((a, b) => (a.position?.x ?? 0) - (b.position?.x ?? 0));
  }
  const steps = ordered.map(stepFromNode).filter((step): step is DraftStep => Boolean(step));
  const unconnected = workflow.nodes.filter((node) => node.kind !== "trigger").length - steps.length;
  return {
    draft: { id: workflow.id, name: workflow.name, createdAt: workflow.createdAt, schedule: parseSchedule(trigger?.config), steps },
    unconnected: Math.max(0, unconnected),
  };
}

/** The stored form: a trigger, then the steps chained in order. */
export function workflowFromDraft(draft: Draft, now = new Date()): WorkflowSchema {
  const triggerId = draft.id.startsWith("workflow-") ? `trigger-${draft.id.slice("workflow-".length)}` : `trigger-${draft.id}`;
  const nodes: WorkflowNode[] = [
    { id: triggerId, kind: "trigger", label: describeSchedule(draft.schedule), config: { schedule: draft.schedule }, position: { x: 0, y: 0 } },
    ...draft.steps.map((step, index): WorkflowNode => ({
      id: step.id,
      kind: step.kind,
      label: stepLabel(step),
      config: step.kind === "agent-task" ? { task: step.task.trim() } : step.kind === "tool-action" ? { action: step.action, ...(step.action === "create-reminder" ? { minutes: step.minutes } : {}) } : { channel: step.channel },
      position: { x: (index + 1) * 280, y: 0 },
    })),
  ];
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id }));
  return { version: 1, id: draft.id, name: draft.name.trim() || "Untitled automation", nodes, edges, createdAt: draft.createdAt, updatedAt: now.toISOString() };
}

/** What stops this draft from being saved, or "" when it's ready. */
export function draftProblem(draft: Draft) {
  if (!draft.name.trim()) return "Give this automation a name.";
  if (!draft.steps.length) return "Add at least one step after the trigger.";
  const emptyTask = draft.steps.findIndex((step) => step.kind === "agent-task" && !step.task.trim());
  if (emptyTask >= 0) return `Step ${emptyTask + 1}: say what HANNAH should do.`;
  if (draft.schedule.type === "daily" && !draft.schedule.days.length) return "Pick at least one day for the schedule.";
  const firstAction = draft.steps.findIndex((step) => step.kind === "tool-action");
  if (firstAction === 0) return "An action uses the previous step's result, so put an “Ask HANNAH” step before it.";
  return "";
}

export function blankDraft(): Draft {
  return {
    id: newId("workflow"),
    name: "",
    createdAt: new Date().toISOString(),
    schedule: { type: "daily", time: "08:00", days: ALL_DAYS },
    steps: [newStep("agent-task"), newStep("output")],
  };
}

export type Template = { id: string; name: string; summary: string; build: () => Draft };

/** A step without its id, for each kind. */
type StepSpec = { [K in StepKind]: Omit<Extract<DraftStep, { kind: K }>, "id"> }[StepKind];

const template = (name: string, schedule: Schedule, steps: StepSpec[]): (() => Draft) => () => ({
  id: newId("workflow"),
  name,
  createdAt: new Date().toISOString(),
  schedule,
  steps: steps.map((step) => ({ ...step, id: newId(step.kind === "agent-task" ? "agent" : step.kind === "tool-action" ? "action" : "output") }) as DraftStep),
});

export const TEMPLATES: Template[] = [
  {
    id: "morning-plan",
    name: "Morning plan",
    summary: "Weekdays at 08:00 · a three-point plan for the day, as a notification.",
    build: template("Morning plan", { type: "daily", time: "08:00", days: WEEKDAYS }, [
      { kind: "agent-task", task: "Plan my day in three short bullet points, with one focus for the morning." },
      { kind: "output", channel: "notify" },
    ]),
  },
  {
    id: "evening-reflection",
    name: "Evening reflection",
    summary: "Every day at 21:00 · one thing worth remembering, saved to memory after you approve.",
    build: template("Evening reflection", { type: "daily", time: "21:00", days: ALL_DAYS }, [
      { kind: "agent-task", task: "Write one short sentence about something worth remembering from today, and one small thing to try tomorrow." },
      { kind: "tool-action", action: "save-memory", minutes: 60 },
      { kind: "output", channel: "notify" },
    ]),
  },
  {
    id: "stretch-break",
    name: "Stretch break",
    summary: "Every 2 hours · a one-minute stretch, spoken aloud.",
    build: template("Stretch break", { type: "interval", hours: 2 }, [
      { kind: "agent-task", task: "Suggest one one-minute stretch I can do at my desk, in two sentences." },
      { kind: "output", channel: "speak" },
    ]),
  },
  {
    id: "weekly-review",
    name: "Friday review",
    summary: "Fridays at 16:00 · a short weekly review and a reminder to plan next week.",
    build: template("Friday review", { type: "daily", time: "16:00", days: [5] }, [
      { kind: "agent-task", task: "Give me three questions to review my week, and one to plan next week." },
      { kind: "tool-action", action: "create-reminder", minutes: 30 },
      { kind: "output", channel: "notify" },
    ]),
  },
];
