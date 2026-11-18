/** Small helpers for the workflow editor: icons, layout, graph checks, undo history. */
import {
  AlarmClock, AppWindow, ArrowLeftRight, BadgeCheck, Bell, Bot, BrainCircuit, Braces, CalendarClock, CalendarPlus, Database, FileText, FileUp, Filter, GitBranch, Github, Globe, Group,
  Hourglass, ListEnd, ListTree, Mail, MailOpen, Merge, MessageSquare, MessagesSquare, MousePointerClick, NotebookPen, PenLine, Radio, Repeat, ScanText, Search, ShieldCheck, Sparkles,
  BellRing, Contact, MessageSquareText, PhoneCall, Smartphone,
  Split, SquareTerminal, TableProperties, Tags, Unplug, Webhook, Workflow, type LucideIcon,
} from "lucide-react";
import type { NodeCategory, NodeRun, WorkflowConnection, WorkflowDefinition, WorkflowNode } from "../../services/WorkflowApi";

const ICONS: Record<string, LucideIcon> = {
  AlarmClock, AppWindow, ArrowLeftRight, BadgeCheck, Bell, Bot, BrainCircuit, Braces, CalendarClock, CalendarPlus, Database, FileText, FileUp, Filter, GitBranch, Github, Globe, Group,
  Hourglass, ListEnd, ListTree, Mail, MailOpen, Merge, MessageSquare, MessagesSquare, MousePointerClick, NotebookPen, PenLine, Radio, Repeat, ScanText, Search, ShieldCheck, Sparkles,
  Split, TableProperties, Tags, TerminalSquare: SquareTerminal, Unplug, Webhook,
  BellRing, Contact, MessageSquareText, PhoneCall, Smartphone,
};

export const iconFor = (name: string): LucideIcon => ICONS[name] ?? Workflow;

export const CATEGORY_STYLE: Record<NodeCategory, { label: string; tone: string; ring: string; dot: string }> = {
  trigger: { label: "Triggers", tone: "bg-amber-50 text-amber-900 border-amber-200", ring: "border-amber-300", dot: "bg-amber-500" },
  action: { label: "Actions", tone: "bg-sky-50 text-sky-900 border-sky-200", ring: "border-sky-300", dot: "bg-sky-500" },
  logic: { label: "Logic", tone: "bg-violet-50 text-violet-900 border-violet-200", ring: "border-violet-300", dot: "bg-violet-500" },
  data: { label: "Data", tone: "bg-emerald-50 text-emerald-900 border-emerald-200", ring: "border-emerald-300", dot: "bg-emerald-500" },
  ai: { label: "AI", tone: "bg-rose-50 text-rose-900 border-rose-200", ring: "border-rose-300", dot: "bg-rose-500" },
};

/** Can `source` reach `target` by following connections? Used to refuse cycles. */
export function reaches(connections: WorkflowConnection[], from: string, to: string) {
  const outgoing = new Map<string, string[]>();
  for (const connection of connections) outgoing.set(connection.source, [...(outgoing.get(connection.source) ?? []), connection.target]);
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }
  return false;
}

/** Left-to-right layered layout: each node one column right of its deepest parent. */
export function autoLayout(definition: WorkflowDefinition): WorkflowNode[] {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const connection of definition.connections) incoming.set(connection.target, [...(incoming.get(connection.target) ?? []), connection.source]);
  const visit = (id: string, trail = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (trail.has(id)) return 0;
    trail.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length ? Math.max(...parents.map((parent) => visit(parent, trail))) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  definition.nodes.forEach((node) => visit(node.id));
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of definition.nodes) columns.set(depth.get(node.id) ?? 0, [...(columns.get(depth.get(node.id) ?? 0) ?? []), node]);
  const positioned = new Map<string, { x: number; y: number }>();
  for (const [column, nodes] of columns) {
    nodes.sort((a, b) => a.position.y - b.position.y);
    nodes.forEach((node, row) => positioned.set(node.id, { x: 80 + column * 300, y: 80 + row * 150 - ((nodes.length - 1) * 150) / 2 + 160 }));
  }
  return definition.nodes.map((node) => ({ ...node, position: positioned.get(node.id) ?? node.position }));
}

/** A name not used by another node: "HTTP request", "HTTP request 2", … */
export function uniqueName(base: string, nodes: WorkflowNode[]) {
  const taken = new Set(nodes.map((node) => node.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base} ${index}`.toLowerCase())) return `${base} ${index}`;
}

export const newNodeId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Undo/redo over snapshots of the definition. */
export class History {
  private past: string[] = [];
  private future: string[] = [];
  push(definition: WorkflowDefinition) {
    const snapshot = JSON.stringify(definition);
    if (this.past[this.past.length - 1] === snapshot) return;
    this.past.push(snapshot);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(current: WorkflowDefinition): WorkflowDefinition | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(previous);
  }
  redo(current: WorkflowDefinition): WorkflowDefinition | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(next);
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

/** Field paths of a sample value, for the "insert a field" helper: body.vendor, items.0.qty … */
export function fieldPaths(value: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 4 || out.length > 60) return out;
  if (Array.isArray(value)) {
    if (prefix) out.push(prefix);
    if (value.length) fieldPaths(value[0], `${prefix}[0]`, depth + 1, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const path = /^[A-Za-z_$][\w$]*$/.test(key) ? (prefix ? `${prefix}.${key}` : key) : `${prefix}["${key}"]`;
      if (item && typeof item === "object") fieldPaths(item, path, depth + 1, out);
      else out.push(path);
    }
  }
  return out;
}

export const STATUS_STYLE: Record<string, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "bg-slate-100 text-slate-700 border-slate-200" },
  running: { label: "Running", tone: "bg-sky-50 text-sky-800 border-sky-200" },
  waiting: { label: "Waiting", tone: "bg-amber-50 text-amber-900 border-amber-200" },
  paused: { label: "Paused", tone: "bg-slate-100 text-slate-700 border-slate-300" },
  "waiting-approval": { label: "Needs approval", tone: "bg-amber-50 text-amber-900 border-amber-200" },
  completed: { label: "Completed", tone: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  failed: { label: "Failed", tone: "bg-rose-50 text-rose-800 border-rose-200" },
  cancelled: { label: "Cancelled", tone: "bg-slate-100 text-slate-700 border-slate-200" },
  "timed-out": { label: "Timed out", tone: "bg-rose-50 text-rose-800 border-rose-200" },
  done: { label: "Done", tone: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  skipped: { label: "Skipped", tone: "bg-slate-50 text-slate-500 border-slate-200" },
  retrying: { label: "Retrying", tone: "bg-amber-50 text-amber-900 border-amber-200" },
  "failed-continued": { label: "Failed, continued", tone: "bg-amber-50 text-amber-900 border-amber-200" },
  denied: { label: "Denied", tone: "bg-slate-100 text-slate-700 border-slate-200" },
};

export function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function when(at: number | null | undefined) {
  if (!at) return "—";
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Steps that finished with nothing at all (no items on any output) while steps
 * after them were skipped: the reason a "completed" run did less than
 * expected. A branch not taken (If sent its items elsewhere) isn't listed.
 */
export function emptyStops(definition: WorkflowDefinition, nodes: NodeRun[]) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  return nodes.filter((node) => {
    if (node.status !== "done" || !node.output) return false;
    if (Object.values(node.output).some((port) => port.count > 0)) return false;
    return definition.connections.some((connection) => connection.source === node.nodeId && byId.get(connection.target)?.status === "skipped");
  }).map((node) => ({ nodeId: node.nodeId, name: node.name, skipped: nodes.filter((other) => other.status === "skipped" && reaches(definition.connections, node.nodeId, other.nodeId)).length }));
}

/**
 * What a live run is doing now, for the run page: the step running (or
 * retrying, with its attempt and last error) and for how long. Null when
 * nothing is running.
 */
export function liveProgress(detail: { execution: { status: string }; nodes: NodeRun[] }, now = Date.now()) {
  if (!["queued", "running"].includes(detail.execution.status)) return null;
  const active = detail.nodes.find((node) => node.status === "retrying") ?? detail.nodes.find((node) => node.status === "running");
  if (!active) return { step: null as string | null, retrying: false, attempt: 0, sinceMs: null as number | null, lastError: null as string | null };
  return { step: active.name, retrying: active.status === "retrying", attempt: active.attempts, sinceMs: active.startedAt ? Math.max(0, now - active.startedAt) : null, lastError: active.status === "retrying" ? active.error : null };
}
