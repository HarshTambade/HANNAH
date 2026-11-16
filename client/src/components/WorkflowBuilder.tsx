import { useCallback, useMemo, useState, type DragEvent } from "react";
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowLeft, Bot, Clock3, GitBranch, Save, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { TaskSpineService } from "../services/TaskSpineService";
import type { WorkflowNodeKind, WorkflowSchema } from "../services/WorkflowSchema";

type NodeData = { label: string; kind: WorkflowNodeKind; config: Record<string, unknown> };
type FlowNode = Node<NodeData>;

const palette: Array<{ kind: WorkflowNodeKind; label: string; hint: string; color: string; Icon: typeof Clock3 }> = [
  { kind: "trigger", label: "Trigger", hint: "Schedule or event", color: "bg-amber-50 border-amber-200 text-amber-800", Icon: Clock3 },
  { kind: "agent-task", label: "Agent task", hint: "Summarize, draft…", color: "bg-violet-50 border-violet-200 text-violet-800", Icon: Sparkles },
  { kind: "tool-action", label: "Tool action", hint: "Requires approval", color: "bg-sky-50 border-sky-200 text-sky-800", Icon: Wrench },
  { kind: "output", label: "Output", hint: "Speak or notify", color: "bg-emerald-50 border-emerald-200 text-emerald-800", Icon: Bot },
];

const initialNodes: FlowNode[] = [
  { id: "trigger-1", type: "trigger", position: { x: 60, y: 80 }, data: { kind: "trigger", label: "Every day · 8:00 AM", config: { schedule: "0 8 * * *" } } },
  { id: "agent-1", type: "agent-task", position: { x: 340, y: 80 }, data: { kind: "agent-task", label: "Summarize today's agenda", config: { task: "Summarize today's agenda" } } },
  { id: "output-1", type: "output", position: { x: 640, y: 80 }, data: { kind: "output", label: "Speak the summary", config: { channel: "voice" } } },
];
const initialEdges: Edge[] = [
  { id: "e-trigger-agent", source: "trigger-1", target: "agent-1", animated: true },
  { id: "e-agent-output", source: "agent-1", target: "output-1", animated: true },
];

function flowNode(kind: WorkflowNodeKind, label: string, position = { x: 100, y: 100 }): FlowNode {
  const id = `${kind}-${crypto.randomUUID()}`;
  return { id, type: kind, position, data: { kind, label, config: { label } } };
}

function VisualNode({ data, selected }: NodeProps<FlowNode>) {
  const item = palette.find((entry) => entry.kind === data.kind) ?? palette[1];
  const Icon = item.Icon;
  return (
    <div className={`min-w-48 rounded-2xl border bg-white/95 px-4 py-3 shadow-lg shadow-slate-900/5 ${selected ? "ring-2 ring-violet-300" : ""} ${item.color}`}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-violet-400" />
      <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-xl bg-white/80"><Icon size={15} /></span><div><div className="text-[9px] font-bold uppercase tracking-[.16em] opacity-70">{item.label}</div><div className="mt-1 max-w-48 text-xs font-semibold text-slate-800">{data.label}</div></div></div>
      {data.kind === "tool-action" && <div className="mt-2 flex items-center gap-1 text-[9px] text-amber-700"><ShieldCheck size={11} /> Approval required</div>}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-violet-400" />
    </div>
  );
}

const nodeTypes = { trigger: VisualNode, "agent-task": VisualNode, "tool-action": VisualNode, output: VisualNode };

function BuilderCanvas({ onBack }: { onBack: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [name, setName] = useState("Morning brief");
  const [workflowId] = useState(() => `workflow-${crypto.randomUUID()}`);
  const [createdAt] = useState(() => new Date().toISOString());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [notice, setNotice] = useState("");
  const reactFlow = useReactFlow();
  const selected = nodes.find((node) => node.id === selectedId);
  const onConnect = useCallback((connection: Connection) => setEdges((current) => addEdge({ ...connection, animated: true }, current)), [setEdges]);

  const add = useCallback((kind: WorkflowNodeKind, label?: string, position?: { x: number; y: number }) => {
    const item = palette.find((entry) => entry.kind === kind)!;
    setNodes((current) => [...current, flowNode(kind, label || item.label, position || { x: 120 + current.length * 25, y: 100 + current.length * 35 })]);
  }, [setNodes]);

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/hannah-node") as WorkflowNodeKind;
    if (palette.some((entry) => entry.kind === kind)) add(kind, undefined, reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [add, reactFlow]);

  const schema = useMemo<WorkflowSchema>(() => ({
    version: 1,
    id: workflowId,
    name: name.trim() || "Untitled workflow",
    nodes: nodes.map((node) => ({ id: node.id, kind: node.data.kind, label: node.data.label, config: node.data.config, position: node.position })),
    edges: edges.map(({ id, source, target, label }) => ({ id, source, target, ...(typeof label === "string" ? { label } : {}) })),
    createdAt, updatedAt: new Date().toISOString(),
  }), [createdAt, edges, name, nodes, workflowId]);

  function save() {
    if (!name.trim()) { setNotice("Give this workflow a name first."); return; }
    if (!nodes.some((node) => node.data.kind === "trigger") || !nodes.some((node) => node.data.kind === "output")) { setNotice("Add at least one trigger and one output."); return; }
    if (!edges.length) { setNotice("Connect the workflow nodes before saving."); return; }
    TaskSpineService.createWorkflow(schema);
    setNotice("Saved to Task Spine as a pending workflow. A background runner is not configured in this build.");
  }

  return (
    <main className="relative z-10 mx-auto flex min-h-[100dvh] max-w-[1500px] flex-col px-4 py-5 sm:px-7 lg:px-10">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><button className="btn-ghost" onClick={onBack} aria-label="Back to dashboard"><ArrowLeft size={16} /></button><div><p className="bento-kicker">Visual workflow</p><h1 className="font-display text-2xl font-bold text-ink">Automations</h1></div></div>
        <div className="flex items-center gap-2"><button className="btn-outline" onClick={() => setShowJson((value) => !value)}><GitBranch size={15} /> {showJson ? "Hide JSON" : "View JSON"}</button><button className="btn-primary" onClick={save}><Save size={15} /> Save workflow</button></div>
      </header>
      <div className="mb-3 flex flex-wrap items-center gap-3"><label className="text-xs font-semibold text-slate-500">Workflow name <input value={name} onChange={(event) => setName(event.target.value)} className="ml-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm text-ink outline-none focus:border-violet-300" /></label><p className="text-[11px] text-slate-500">Connect nodes left to right. Actions that affect your device still require approval.</p></div>
      <div className="grid min-h-[66dvh] flex-1 gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="bento-card flex flex-col gap-2 p-4"><div className="bento-kicker">Node palette</div>{palette.map(({ kind, label, hint, color, Icon }) => <button key={kind} draggable onDragStart={(event) => event.dataTransfer.setData("application/hannah-node", kind)} onClick={() => add(kind)} className={`flex items-center gap-3 rounded-2xl border p-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${color}`}><Icon size={17} /><span><span className="block text-xs font-bold">{label}</span><span className="mt-0.5 block text-[10px] opacity-70">{hint}</span></span></button>)}<div className="mt-auto rounded-2xl border border-slate-100 bg-white/60 p-3 text-[10px] leading-relaxed text-slate-500">Tool actions use the same confirmation policy as chat. Saving stores a versioned JSON graph in the local Task Spine.</div></aside>
        <section className="relative min-h-[520px] overflow-hidden rounded-[2rem] border border-white/70 bg-white/65 shadow-soft-lg backdrop-blur-xl" onDrop={onDrop} onDragOver={(event) => event.preventDefault()} aria-label="Workflow canvas">
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_event, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(null)} fitView deleteKeyCode={['Backspace', 'Delete']}><Background color="#d7def3" gap={22} /><MiniMap nodeColor={(node) => node.type === "trigger" ? "#fde68a" : node.type === "output" ? "#a7f3d0" : node.type === "tool-action" ? "#bae6fd" : "#ddd6fe"} /><Controls /></ReactFlow>
        </section>
      </div>
      {selected && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-violet-100 bg-white/70 p-3 text-xs"><label className="font-semibold text-slate-600">Selected node <input value={selected.data.label} onChange={(event) => setNodes((current) => current.map((node) => node.id === selected.id ? { ...node, data: { ...node.data, label: event.target.value, config: { ...node.data.config, label: event.target.value } } } : node))} className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5 font-normal outline-none focus:border-violet-300" /></label><button className="text-rose-600" onClick={() => { setNodes((current) => current.filter((node) => node.id !== selected.id)); setEdges((current) => current.filter((edge) => edge.source !== selected.id && edge.target !== selected.id)); setSelectedId(null); }}>Delete node</button></div>}
      {notice && <p role="status" className="mt-3 rounded-2xl border border-violet-100 bg-violet-50 px-4 py-3 text-xs text-violet-900">{notice}</p>}
      {showJson && <pre className="mt-3 max-h-64 overflow-auto rounded-2xl border border-slate-200 bg-slate-950 p-4 text-[10px] text-cyan-100">{JSON.stringify(schema, null, 2)}</pre>}
    </main>
  );
}

export default function WorkflowBuilder({ onBack }: { onBack: () => void }) {
  return <div className="min-h-[100dvh] bg-mesh-indigo"><div className="fixed inset-0 bg-mesh-pastel opacity-50" /><ReactFlowProvider><BuilderCanvas onBack={onBack} /></ReactFlowProvider></div>;
}
