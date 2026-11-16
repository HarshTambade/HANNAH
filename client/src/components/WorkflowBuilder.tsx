import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bot, Check, Clock3, GitBranch, Pencil, Play, Plus, Save, ShieldCheck, Sparkles, Trash2, Wrench, X } from "lucide-react";
import { TaskSpineService } from "../services/TaskSpineService";
import type { WorkflowNodeKind, WorkflowSchema } from "../services/WorkflowSchema";
import {
  AUTOMATION_EVENT, AutomationService, describeSchedule, outputChannelOf, parseSchedule, toolActionOf, workflowSchedule,
  type AutomationRun, type OutputChannel, type Schedule, type ToolAction,
} from "../services/AutomationService";
import { notificationPermission, requestNotificationPermission } from "../services/ReminderService";

type NodeData = { label: string; kind: WorkflowNodeKind; config: Record<string, unknown> };
type FlowNode = Node<NodeData>;

const palette: Array<{ kind: WorkflowNodeKind; label: string; hint: string; color: string; Icon: typeof Clock3 }> = [
  { kind: "trigger", label: "Trigger", hint: "When it runs", color: "bg-amber-50 border-amber-200 text-amber-900", Icon: Clock3 },
  { kind: "agent-task", label: "Agent task", hint: "Ask HANNAH to do something", color: "bg-violet-50 border-violet-200 text-violet-900", Icon: Sparkles },
  { kind: "tool-action", label: "Action", hint: "Waits for your approval", color: "bg-sky-50 border-sky-200 text-sky-900", Icon: Wrench },
  { kind: "output", label: "Output", hint: "Notify or speak", color: "bg-emerald-50 border-emerald-200 text-emerald-900", Icon: Bot },
];

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const toolLabels: Record<ToolAction, string> = { "save-memory": "Save the result to memory", "create-reminder": "Create a reminder from the result" };
const outputLabels: Record<OutputChannel, string> = { notify: "Show a notification", speak: "Speak the result aloud", log: "Only keep it in run history" };

const defaultConfig: Record<WorkflowNodeKind, () => { label: string; config: Record<string, unknown> }> = {
  trigger: () => ({ label: "Every day at 08:00", config: { schedule: { type: "daily", time: "08:00", days: ALL_DAYS } } }),
  "agent-task": () => ({ label: "Summarize my day", config: { task: "Summarize my day" } }),
  "tool-action": () => ({ label: toolLabels["save-memory"], config: { action: "save-memory" } }),
  output: () => ({ label: outputLabels.notify, config: { channel: "notify" } }),
};

function starterFlow(): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: [
      { id: "trigger-1", type: "trigger", position: { x: 40, y: 80 }, data: { kind: "trigger", label: "Weekdays at 08:00", config: { schedule: { type: "daily", time: "08:00", days: WEEKDAYS } } } },
      { id: "agent-1", type: "agent-task", position: { x: 320, y: 80 }, data: { kind: "agent-task", label: "Plan my day in three bullet points", config: { task: "Plan my day in three short bullet points, with one focus for the morning." } } },
      { id: "output-1", type: "output", position: { x: 620, y: 80 }, data: { kind: "output", label: outputLabels.notify, config: { channel: "notify" } } },
    ],
    edges: [
      { id: "e-trigger-agent", source: "trigger-1", target: "agent-1", animated: true },
      { id: "e-agent-output", source: "agent-1", target: "output-1", animated: true },
    ],
  };
}

function VisualNode({ data, selected }: NodeProps<FlowNode>) {
  const item = palette.find((entry) => entry.kind === data.kind) ?? palette[1];
  const Icon = item.Icon;
  return (
    <div className={`min-w-48 max-w-60 rounded-2xl border bg-white/95 px-4 py-3 shadow-lg shadow-slate-900/5 ${selected ? "ring-2 ring-violet-400" : ""} ${item.color}`}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-violet-500" />
      <div className="flex items-center gap-2"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/80"><Icon size={15} /></span><div className="min-w-0"><div className="text-[9px] font-bold uppercase tracking-[.16em] opacity-80">{item.label}</div><div className="mt-1 text-xs font-semibold text-slate-800">{data.label}</div></div></div>
      {data.kind === "tool-action" && <div className="mt-2 flex items-center gap-1 text-[10px] font-medium text-amber-800"><ShieldCheck size={11} /> Asks before it acts</div>}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-violet-500" />
    </div>
  );
}

const nodeTypes = { trigger: VisualNode, "agent-task": VisualNode, "tool-action": VisualNode, output: VisualNode };

const fieldClass = "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-ink outline-none focus:border-violet-400";

function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (schedule: Schedule) => void }) {
  const mode = schedule.type === "daily" ? (schedule.days.join() === WEEKDAYS.join() ? "weekdays" : "daily") : schedule.type;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-xs font-semibold text-slate-700">Runs
        <select className={fieldClass} value={mode} onChange={(event) => {
          const value = event.target.value;
          const time = schedule.type === "daily" ? schedule.time : "08:00";
          if (value === "manual") onChange({ type: "manual" });
          else if (value === "interval") onChange({ type: "interval", hours: schedule.type === "interval" ? schedule.hours : 4 });
          else onChange({ type: "daily", time, days: value === "weekdays" ? WEEKDAYS : ALL_DAYS });
        }}>
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="interval">Every few hours</option>
          <option value="manual">Only when I run it</option>
        </select>
      </label>
      {schedule.type === "daily" && (
        <label className="text-xs font-semibold text-slate-700">At
          <input type="time" className={fieldClass} value={schedule.time} onChange={(event) => event.target.value && onChange({ ...schedule, time: event.target.value })} />
        </label>
      )}
      {schedule.type === "interval" && (
        <label className="text-xs font-semibold text-slate-700">Every (hours)
          <input type="number" min={1} max={168} className={fieldClass} value={schedule.hours} onChange={(event) => onChange({ type: "interval", hours: Math.min(168, Math.max(1, Number(event.target.value) || 1)) })} />
        </label>
      )}
    </div>
  );
}

const statusStyle: Record<AutomationRun["status"], string> = {
  running: "bg-sky-50 text-sky-800 border-sky-200",
  "waiting-approval": "bg-amber-50 text-amber-900 border-amber-200",
  done: "bg-emerald-50 text-emerald-800 border-emerald-200",
  denied: "bg-slate-100 text-slate-700 border-slate-200",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
};
const statusLabel: Record<AutomationRun["status"], string> = { running: "Running", "waiting-approval": "Needs approval", done: "Done", denied: "Denied", failed: "Failed" };

function formatTime(value: number | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function BuilderCanvas() {
  const starter = useMemo(starterFlow, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(starter.edges);
  const [name, setName] = useState("Morning plan");
  const [workflowId, setWorkflowId] = useState(() => `workflow-${crypto.randomUUID()}`);
  const [createdAt, setCreatedAt] = useState(() => new Date().toISOString());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reactFlow = useReactFlow();
  const selected = nodes.find((node) => node.id === selectedId);

  // Re-read saved workflows, schedules and runs whenever any of them change.
  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1);
    window.addEventListener(AUTOMATION_EVENT, refresh);
    return () => window.removeEventListener(AUTOMATION_EVENT, refresh);
  }, []);
  const saved = useMemo(() => AutomationService.workflows(), [version]);
  const runs = useMemo(() => AutomationService.runs(), [version]);
  const pending = runs.filter((run) => run.status === "waiting-approval");

  const onConnect = useCallback((connection: Connection) => setEdges((current) => addEdge({ ...connection, animated: true }, current)), [setEdges]);

  const add = useCallback((kind: WorkflowNodeKind, position?: { x: number; y: number }) => {
    const defaults = defaultConfig[kind]();
    const id = `${kind}-${crypto.randomUUID()}`;
    setNodes((current) => [...current, { id, type: kind, position: position || { x: 120 + current.length * 30, y: 220 + current.length * 20 }, data: { kind, ...defaults } }]);
    setSelectedId(id);
  }, [setNodes]);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/hannah-node") as WorkflowNodeKind;
    if (palette.some((entry) => entry.kind === kind)) add(kind, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [add, reactFlow]);

  const schema = useMemo<WorkflowSchema>(() => ({
    version: 1,
    id: workflowId,
    name: name.trim() || "Untitled workflow",
    nodes: nodes.map((node) => ({ id: node.id, kind: node.data.kind, label: node.data.label, config: node.data.config, position: node.position })),
    edges: edges.map(({ id, source, target, label }) => ({ id, source, target, ...(typeof label === "string" ? { label } : {}) })),
    createdAt, updatedAt: new Date().toISOString(),
  }), [createdAt, edges, name, nodes, workflowId]);

  const updateSelected = (patch: Partial<NodeData>) => {
    if (!selected) return;
    setNodes((current) => current.map((node) => node.id === selected.id ? { ...node, data: { ...node.data, ...patch, config: { ...node.data.config, ...(patch.config ?? {}) } } } : node));
  };

  function validate() {
    if (!name.trim()) return "Give this automation a name first.";
    if (nodes.filter((node) => node.data.kind === "trigger").length !== 1) return "Use exactly one trigger.";
    if (!nodes.some((node) => node.data.kind === "output")) return "Add an output so you see the result.";
    if (!edges.length) return "Connect the steps from left to right.";
    return "";
  }

  function save() {
    const problem = validate();
    if (problem) { setNotice(problem); return null; }
    TaskSpineService.createWorkflow(schema);
    const state = AutomationService.reschedule(schema);
    window.dispatchEvent(new Event(AUTOMATION_EVENT));
    const schedule = workflowSchedule(schema);
    setNotice(schedule.type === "manual"
      ? "Saved. This automation runs when you press Run now."
      : state.enabled ? `Saved. Next run: ${formatTime(state.nextRunAt)}.` : `Saved. Turn on "Run on schedule" below to run it ${describeSchedule(schedule).toLowerCase()}.`);
    return schema;
  }

  function load(workflow: WorkflowSchema) {
    setWorkflowId(workflow.id);
    setCreatedAt(workflow.createdAt);
    setName(workflow.name);
    setNodes(workflow.nodes.map((node) => ({ id: node.id, type: node.kind, position: node.position, data: { kind: node.kind, label: node.label, config: node.config } })));
    setEdges(workflow.edges.map((edge) => ({ ...edge, animated: true })));
    setSelectedId(null);
    setNotice(`Editing "${workflow.name}". Save to keep your changes.`);
    window.setTimeout(() => void reactFlow.fitView({ padding: 0.2 }), 50);
  }

  function startNew() {
    const fresh = starterFlow();
    setWorkflowId(`workflow-${crypto.randomUUID()}`);
    setCreatedAt(new Date().toISOString());
    setName("New automation");
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setSelectedId(null);
    setNotice("");
  }

  async function runNow(workflow: WorkflowSchema) {
    setBusy(workflow.id);
    try {
      const run = await AutomationService.run(workflow, "manual");
      setNotice(run.status === "done" ? `"${workflow.name}" finished.` : run.status === "waiting-approval" ? `"${workflow.name}" is waiting for your approval above.` : `"${workflow.name}" stopped: ${run.error}`);
    } finally {
      setBusy(null);
    }
  }

  async function decide(run: AutomationRun, approve: boolean) {
    setBusy(run.id);
    try {
      await AutomationService.decide(run.id, approve);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function toggleSchedule(workflow: WorkflowSchema, enabled: boolean) {
    if (enabled && notificationPermission() === "default") await requestNotificationPermission();
    AutomationService.setEnabled(workflow, enabled);
  }

  const selectedSchedule = selected?.data.kind === "trigger" ? parseSchedule(selected.data.config) : null;
  const selectedAsNode = selected ? { id: selected.id, kind: selected.data.kind, label: selected.data.label, config: selected.data.config, position: selected.position } : null;

  return (
    <main className="relative z-10 mx-auto flex max-w-6xl flex-col px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Automations</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Routines that run on a schedule while HANNAH is open in a tab or the desktop app. If one was due while HANNAH was closed, it runs once when you come back. Actions always wait for your approval.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-outline" onClick={startNew}><Plus size={15} /> New</button>
          <button type="button" className="btn-outline" onClick={() => setShowJson((value) => !value)}><GitBranch size={15} /> {showJson ? "Hide JSON" : "View JSON"}</button>
          <button type="button" className="btn-outline" disabled={busy !== null} onClick={() => { const workflow = save(); if (workflow) void runNow(workflow); }}><Play size={15} /> Save and run</button>
          <button type="button" className="btn-primary" onClick={() => save()}><Save size={15} /> Save</button>
        </div>
      </header>

      {pending.length > 0 && (
        <section aria-label="Waiting for your approval" className="mb-4 space-y-2">
          {pending.map((run) => {
            const step = run.steps.find((item) => item.status === "waiting-approval");
            return (
              <div key={run.id} className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-950"><ShieldCheck size={15} /> {run.name} wants to: {step?.label}</p>
                  {step?.output && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[13px] leading-5 text-amber-950/80">{step.output}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className="btn-outline" disabled={busy === run.id} onClick={() => void decide(run, false)}><X size={14} /> Deny</button>
                  <button type="button" className="btn-primary" disabled={busy === run.id} onClick={() => void decide(run, true)}><Check size={14} /> Approve</button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="text-xs font-semibold text-slate-700">Name <input value={name} onChange={(event) => setName(event.target.value)} className="ml-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-ink outline-none focus:border-violet-400" /></label>
        <p className="text-xs text-slate-600">Click a step to edit it. Connect steps left to right; each step receives the previous step's result.</p>
      </div>

      <div className="grid min-h-[60dvh] flex-1 gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="bento-card flex flex-col gap-2 p-4">
          <div className="bento-kicker">Add a step</div>
          {palette.map(({ kind, label, hint, color, Icon }) => <button type="button" key={kind} draggable onDragStart={(event) => event.dataTransfer.setData("application/hannah-node", kind)} onClick={() => add(kind)} className={`flex items-center gap-3 rounded-2xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${color}`}><Icon size={17} /><span><span className="block text-xs font-bold">{label}</span><span className="mt-0.5 block text-[11px] opacity-80">{hint}</span></span></button>)}
          <p className="mt-auto rounded-2xl border border-slate-100 bg-white/70 p-3 text-[11px] leading-relaxed text-slate-600">Agent tasks use your connected AI and count toward its usage. Runs and results stay on this device.</p>
        </aside>
        <section className="relative min-h-[460px] overflow-hidden rounded-[2rem] border border-white/70 bg-white/65 shadow-soft-lg backdrop-blur-xl" onDrop={onDrop} onDragOver={(event) => event.preventDefault()} aria-label="Workflow canvas">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} fitView deleteKeyCode={["Backspace", "Delete"]}><Background color="#d7def3" gap={22} /><MiniMap nodeColor={(node) => node.type === "trigger" ? "#fde68a" : node.type === "output" ? "#a7f3d0" : node.type === "tool-action" ? "#bae6fd" : "#ddd6fe"} /><Controls /></ReactFlow>
        </section>
      </div>

      {selected && selectedAsNode && (
        <section aria-label="Edit step" className="mt-3 rounded-2xl border border-violet-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">Edit {palette.find((item) => item.kind === selected.data.kind)?.label.toLowerCase()}</h2>
            <button type="button" className="btn-ghost text-rose-700" onClick={() => { setNodes((current) => current.filter((node) => node.id !== selected.id)); setEdges((current) => current.filter((edge) => edge.source !== selected.id && edge.target !== selected.id)); setSelectedId(null); }}><Trash2 size={14} /> Remove step</button>
          </div>
          <div className="mt-3">
            {selectedSchedule && <ScheduleEditor schedule={selectedSchedule} onChange={(schedule) => updateSelected({ label: describeSchedule(schedule), config: { schedule } })} />}
            {selected.data.kind === "agent-task" && (
              <label className="block text-xs font-semibold text-slate-700">What should HANNAH do?
                <textarea rows={3} maxLength={1500} className={fieldClass} value={String(selected.data.config.task ?? selected.data.label)} onChange={(event) => updateSelected({ label: event.target.value.split("\n")[0].slice(0, 60) || "Agent task", config: { task: event.target.value } })} />
              </label>
            )}
            {selected.data.kind === "tool-action" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-700">Action
                  <select className={fieldClass} value={toolActionOf(selectedAsNode)} onChange={(event) => { const action = event.target.value as ToolAction; updateSelected({ label: toolLabels[action], config: { action } }); }}>
                    {Object.entries(toolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                {toolActionOf(selectedAsNode) === "create-reminder" && (
                  <label className="text-xs font-semibold text-slate-700">Remind me after (minutes)
                    <input type="number" min={1} max={10080} className={fieldClass} value={Number(selected.data.config.minutes ?? 60)} onChange={(event) => updateSelected({ config: { minutes: Math.min(10080, Math.max(1, Number(event.target.value) || 1)) } })} />
                  </label>
                )}
              </div>
            )}
            {selected.data.kind === "output" && (
              <label className="block text-xs font-semibold text-slate-700 sm:max-w-sm">Deliver the result by
                <select className={fieldClass} value={outputChannelOf(selectedAsNode)} onChange={(event) => { const channel = event.target.value as OutputChannel; updateSelected({ label: outputLabels[channel], config: { channel } }); }}>
                  {Object.entries(outputLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            )}
          </div>
        </section>
      )}

      {notice && <p role="status" className="mt-3 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-950">{notice}</p>}
      {showJson && <pre className="mt-3 max-h-64 overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 text-xs text-slate-100">{JSON.stringify(schema, null, 2)}</pre>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="bento-card" aria-labelledby="saved-title">
          <h2 id="saved-title" className="font-display text-lg font-bold text-ink">Your automations</h2>
          {saved.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">Nothing saved yet. Build a routine above and press Save.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100">
              {saved.map((workflow) => {
                const schedule = workflowSchedule(workflow);
                const state = AutomationService.state(workflow.id);
                return (
                  <li key={workflow.id} className="py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{workflow.name}</p>
                        <p className="text-xs text-slate-600">{describeSchedule(schedule)}{state.enabled && state.nextRunAt ? ` · next ${formatTime(state.nextRunAt)}` : ""}</p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className="btn-ghost" disabled={busy === workflow.id} onClick={() => void runNow(workflow)} aria-label={`Run ${workflow.name} now`}><Play size={14} /> Run now</button>
                        <button type="button" className="btn-ghost" onClick={() => load(workflow)} aria-label={`Edit ${workflow.name}`}><Pencil size={14} /> Edit</button>
                        <button type="button" className="btn-ghost text-rose-700" onClick={() => { TaskSpineService.remove(workflow.id); AutomationService.forget(workflow.id); }} aria-label={`Delete ${workflow.name}`}><Trash2 size={14} /></button>
                      </div>
                    </div>
                    {schedule.type !== "manual" && (
                      <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
                        <input type="checkbox" className="h-4 w-4 accent-violet-600" checked={state.enabled} onChange={(event) => void toggleSchedule(workflow, event.target.checked)} />
                        Run on schedule
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="bento-card" aria-labelledby="runs-title">
          <h2 id="runs-title" className="font-display text-lg font-bold text-ink">Run history</h2>
          {runs.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No runs yet. Press Run now on an automation to try it.</p>
          ) : (
            <ul className="mt-3 space-y-2" aria-label="Automation runs">
              {runs.slice(0, 12).map((run) => {
                const result = [...run.steps].reverse().find((step) => step.output)?.output;
                return (
                  <li key={run.id}>
                    <details className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{run.name}</span><span className="text-xs text-slate-600">{formatTime(run.startedAt)} · {run.trigger === "catch-up" ? "missed run, caught up" : run.trigger}</span></span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusStyle[run.status]}`}>{statusLabel[run.status]}</span>
                      </summary>
                      {run.error && <p className="mt-2 text-xs text-rose-800">{run.error}</p>}
                      {result && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-slate-700">{result}</p>}
                      <ol className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
                        {run.steps.map((step) => <li key={step.nodeId} className="flex justify-between gap-3"><span className="truncate">{step.label}</span><span className="shrink-0 font-medium">{step.status.replace("-", " ")}</span></li>)}
                      </ol>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

export default function WorkflowBuilder() {
  return <ReactFlowProvider><BuilderCanvas /></ReactFlowProvider>;
}
