import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle, ArrowLeft, Check, CircleSlash, Copy, Download, FlaskConical, History as HistoryIcon, LayoutGrid, Loader2, Play, Power, Redo2, Save, Search, Trash2, Undo2, Upload, X,
} from "lucide-react";
import {
  WorkflowApi, defaultsFor, localTimeZone, outputsFor, portLabel, PERMISSION_LABELS,
  type Catalog, type Credential, type ExecutionDetail as Detail, type NodeDefinition, type Permission, type Validation, type WebhookInfo, type WebhookSecret,
  type WorkflowConnection, type WorkflowDefinition, type WorkflowDetail, type WorkflowNode,
} from "../../services/WorkflowApi";
import { AccountError } from "../../services/Account";
import ParamField from "./ParamField";
import ExecutionDetail, { FINAL, StatusPill } from "./ExecutionDetail";
import { CATEGORY_STYLE, History, autoLayout, fieldPaths, iconFor, newNodeId, reaches, uniqueName } from "./support";

type RunState = Record<string, { status: string; count: number; error: string | null }>;
type CardData = { node: WorkflowNode; definition?: NodeDefinition; errors: string[]; run?: RunState[string] };
type CardNode = Node<CardData, "hannah">;

// ---------- canvas node ----------

const NodeCard = memo(function NodeCard({ data, selected }: NodeProps<CardNode>) {
  const { node, definition, errors, run } = data;
  if (!definition) {
    return <div className="rounded-2xl border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">Unknown step “{node.type}”</div>;
  }
  const Icon = iconFor(definition.icon);
  const style = CATEGORY_STYLE[definition.category];
  const outputs = outputsFor(definition, node.params);
  const status = run?.status;
  return (
    <div className={`relative w-[220px] rounded-2xl border bg-white shadow-sm transition ${selected ? "ring-2 ring-violet-400" : ""} ${errors.length ? "border-rose-300" : status === "failed" ? "border-rose-400" : status === "done" ? "border-emerald-300" : style.ring} ${node.disabled ? "opacity-50" : ""}`}>
      {definition.inputs.map((input, index) => (
        <Handle key={input} id={input} type="target" position={Position.Left} style={{ top: definition.inputs.length > 1 ? `${30 + index * 34}%` : "50%" }} className="!h-3 !w-3 !border-2 !border-white !bg-slate-400" title={input === "main" ? "Input" : input} />
      ))}
      <div className="flex items-start gap-2.5 p-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${style.tone}`}><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{node.name}</p>
          <p className="truncate text-[11px] text-slate-500">{definition.label}{definition.status !== "available" && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-semibold uppercase text-slate-600">{definition.status}</span>}</p>
        </div>
      </div>
      {(errors.length > 0 || status) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3 py-1.5 text-[11px]">
          {errors.length > 0 && <span className="inline-flex items-center gap-1 font-medium text-rose-700" title={errors.join("\n")}><AlertTriangle size={11} /> {errors.length} problem{errors.length === 1 ? "" : "s"}</span>}
          {status && <StatusPill status={status} />}
          {status === "done" && <span className="text-slate-500">{run!.count} item{run!.count === 1 ? "" : "s"}</span>}
        </div>
      )}
      {outputs.map((output, index) => {
        const label = portLabel(definition, node.params, output);
        const top = outputs.length > 1 ? `${((index + 1) / (outputs.length + 1)) * 100}%` : "50%";
        return (
          <div key={output}>
            <Handle id={output} type="source" position={Position.Right} style={{ top }} className={`!h-3 !w-3 !border-2 !border-white ${output === "false" || output === "denied" || output === "invalid" ? "!bg-rose-400" : output === "true" || output === "approved" || output === "valid" ? "!bg-emerald-500" : "!bg-violet-500"}`} title={label || "Output"} />
            {label && <span className="pointer-events-none absolute -right-1 translate-x-full -translate-y-1/2 whitespace-nowrap rounded bg-white/90 px-1 text-[10px] font-semibold text-slate-600" style={{ top }}>{label}</span>}
          </div>
        );
      })}
    </div>
  );
});
const nodeTypes = { hannah: NodeCard };

// ---------- library ----------

function NodeLibrary({ catalog, onAdd, onClose }: { catalog: Catalog; onAdd: (definition: NodeDefinition) => void; onClose?: () => void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = catalog.nodes.filter((node) => (category === "all" || node.category === category) && words.every((word) => `${node.label} ${node.description} ${node.type}`.toLowerCase().includes(word)));
  const onDragStart = (event: DragEvent, type: string) => {
    event.dataTransfer.setData("application/hannah-node", type);
    event.dataTransfer.effectAllowed = "move";
  };
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label="Step library">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 p-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5">
          <Search size={14} className="text-slate-400" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search steps" aria-label="Search steps" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>
        {onClose && <button type="button" className="btn-ghost !p-1.5" aria-label="Close the step library" onClick={onClose}><X size={14} /></button>}
      </div>
      <div className="flex flex-wrap gap-1 border-b border-slate-100 px-3 py-2" role="group" aria-label="Categories">
        {["all", "trigger", "action", "logic", "data", "ai"].map((key) => (
          <button key={key} type="button" aria-pressed={category === key} onClick={() => setCategory(key)} className={`rounded-lg px-2 py-0.5 text-[11px] font-semibold ${category === key ? "bg-ink text-white" : "bg-slate-100 text-slate-600"}`}>{key === "all" ? "All" : CATEGORY_STYLE[key as keyof typeof CATEGORY_STYLE].label}</button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {shown.map((node) => {
          const Icon = iconFor(node.icon);
          const disabled = node.status === "upcoming";
          return (
            <li key={node.type}>
              <button type="button" disabled={disabled} draggable={!disabled} onDragStart={(event) => onDragStart(event, node.type)} onClick={() => onAdd(node)} title={node.description}
                className="flex w-full items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-2.5 text-left transition hover:border-violet-300 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-60">
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${CATEGORY_STYLE[node.category].tone}`}><Icon size={14} /></span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">{node.label}{node.status !== "available" && <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold uppercase text-slate-600">{node.status === "upcoming" ? "soon" : node.status}</span>}</span>
                  <span className="line-clamp-2 text-[11px] leading-snug text-slate-500">{node.description}</span>
                  {node.credential && <span className="mt-0.5 block text-[10px] font-medium text-slate-500">Needs a credential: {node.credential.types.map((type) => catalog.credentialTypes[type]?.label ?? type).join(" or ")}</span>}
                </span>
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="text-sm text-slate-500">No step matches.</li>}
      </ul>
    </aside>
  );
}

// ---------- configuration panel ----------

function visible(param: NodeDefinition["params"][number], params: Record<string, unknown>) {
  if (!param.showIf) return true;
  return Object.entries(param.showIf).every(([key, expected]) => (Array.isArray(expected) ? expected.includes(String(params[key])) : params[key] === expected));
}

function ConfigPanel({ node, definition, catalog, credentials, problems, fields, lastRun, webhook, onChange, onRename, onDelete, onDuplicate, onTest, testing, testResult, onClose }: {
  node: WorkflowNode; definition: NodeDefinition; catalog: Catalog; credentials: Credential[]; problems: Validation["errors"]; fields: string[];
  lastRun?: Detail["nodes"][number]; webhook?: WebhookInfo;
  onChange: (node: WorkflowNode) => void; onRename: (name: string) => void; onDelete: () => void; onDuplicate: () => void; onTest: () => void; testing: boolean;
  testResult: { status: string; error: string | null; output: Record<string, { count: number; items: unknown[] }> | null; waiting: { kind: string; message: string | null } | null } | null; onClose: () => void;
}) {
  const [tab, setTab] = useState<"settings" | "run">("settings");
  const params = { ...defaultsFor(definition), ...node.params };
  const errorFor = (field: string) => problems.find((problem) => problem.field === field)?.message;
  const general = problems.filter((problem) => !problem.field || !definition.params.some((param) => param.name === problem.field));
  const Icon = iconFor(definition.icon);
  const usable = definition.credential ? credentials.filter((credential) => definition.credential!.types.includes(credential.type)) : [];
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label={`Configure ${node.name}`}>
      <div className="flex items-start gap-2.5 border-b border-slate-100 p-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${CATEGORY_STYLE[definition.category].tone}`}><Icon size={16} /></span>
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="node-name">Step name</label>
          <input id="node-name" value={node.name} onChange={(event) => onRename(event.target.value)} className="w-full rounded-lg border border-transparent bg-transparent px-1 text-sm font-semibold text-ink outline-none hover:border-slate-200 focus:border-violet-300" />
          <p className="px-1 text-[11px] leading-snug text-slate-500">{definition.description}</p>
        </div>
        <button type="button" className="btn-ghost !p-1.5" aria-label="Close step settings" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="flex gap-1 border-b border-slate-100 px-3 pt-2" role="tablist">
        {(["settings", "run"] as const).map((key) => <button key={key} role="tab" aria-selected={tab === key} type="button" onClick={() => setTab(key)} className={`rounded-t-lg px-3 py-1.5 text-xs font-semibold ${tab === key ? "bg-white text-ink shadow-[0_-1px_0_#e2e8f0_inset]" : "text-slate-500"}`}>{key === "settings" ? "Settings" : "Test and last run"}</button>)}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {tab === "settings" ? (
          <>
            {general.length > 0 && <ul className="space-y-1 rounded-xl bg-rose-50 p-2.5 text-xs text-rose-800" role="alert">{general.map((problem, index) => <li key={index}>{problem.message}</li>)}</ul>}
            {definition.status === "upcoming" && <p className="rounded-xl bg-slate-100 p-2.5 text-xs text-slate-700">This step isn't available yet, so a workflow containing it can't run.</p>}
            {webhook && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                <p className="font-semibold">Webhook URL {webhook.enabled ? "(live)" : "(active once the workflow is activated)"}</p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px]"><span className="min-w-0 flex-1 truncate rounded bg-white px-1.5 py-1">{webhook.url}</span><button type="button" className="btn-ghost !p-1" aria-label="Copy webhook URL" onClick={() => void navigator.clipboard?.writeText(webhook.url)}><Copy size={12} /></button></p>
                <p className="mt-1">{webhook.auth === "hmac" ? "Sign each request: X-Hannah-Timestamp and X-Hannah-Signature: sha256=HMAC(secret, timestamp.body)." : "Send the secret in the X-Hannah-Token header."} The secret was shown when you published; rotate it in the toolbar's webhook menu if you lost it.</p>
              </div>
            )}
            {definition.params.filter((param) => visible(param, params)).map((param) => (
              <ParamField key={param.name} param={param} value={params[param.name]} catalog={catalog} fields={fields} error={errorFor(param.name)} onChange={(value) => onChange({ ...node, params: { ...node.params, [param.name]: value } })} />
            ))}
            {definition.credential && (
              <div>
                <label htmlFor="node-credential" className="text-xs font-semibold text-slate-700">Credential{definition.credential.required && <span className="text-rose-600"> *</span>}</label>
                <select id="node-credential" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" value={node.credentialId ?? ""} onChange={(event) => onChange({ ...node, credentialId: event.target.value || undefined })}>
                  <option value="">{definition.credential.required ? "Choose a credential" : "None"}</option>
                  {usable.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} ({credential.typeLabel}, {credential.hint})</option>)}
                </select>
                {!usable.length && <p className="mt-1 text-[11px] text-slate-500">No {definition.credential.types.map((type) => catalog.credentialTypes[type]?.label ?? type).join(" or ")} saved yet. Add one under Workflows → Credentials; values are encrypted on the server and never shown again.</p>}
                {errorFor("credential") && <p className="mt-1 text-[11px] font-medium text-rose-700">{errorFor("credential")}</p>}
              </div>
            )}
            {definition.category !== "trigger" && (
              <details className="rounded-xl border border-slate-200 bg-white p-2.5">
                <summary className="cursor-pointer text-xs font-semibold text-slate-700">Retries, time limit and errors</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="text-[11px] font-semibold text-slate-600">Retries<input type="number" min={0} max={5} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1 text-sm" value={node.settings?.retries ?? 0} onChange={(event) => onChange({ ...node, settings: { ...node.settings, retries: Math.max(0, Math.min(5, Number(event.target.value) || 0)) } })} /></label>
                  <label className="text-[11px] font-semibold text-slate-600">First retry after (s)<input type="number" min={1} max={60} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1 text-sm" value={Math.round((node.settings?.retryDelayMs ?? 2000) / 1000)} onChange={(event) => onChange({ ...node, settings: { ...node.settings, retryDelayMs: Math.max(1, Math.min(60, Number(event.target.value) || 2)) * 1000 } })} /></label>
                  <label className="text-[11px] font-semibold text-slate-600">Time limit (s)<input type="number" min={1} max={300} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1 text-sm" value={Math.round((node.settings?.timeoutMs ?? 60000) / 1000)} onChange={(event) => onChange({ ...node, settings: { ...node.settings, timeoutMs: Math.max(1, Math.min(300, Number(event.target.value) || 60)) * 1000 } })} /></label>
                  <label className="flex items-center gap-1.5 self-end text-[11px] font-semibold text-slate-600"><input type="checkbox" checked={Boolean(node.settings?.continueOnFail)} onChange={(event) => onChange({ ...node, settings: { ...node.settings, continueOnFail: event.target.checked } })} /> Continue if it fails</label>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">Retries wait longer each time (exponential backoff). With “continue”, the error becomes this step's output and the run is marked as completed with errors.</p>
              </details>
            )}
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={Boolean(node.disabled)} onChange={(event) => onChange({ ...node, disabled: event.target.checked || undefined })} /> Skip this step (pass items through unchanged)</label>
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
              <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={onDuplicate}><Copy size={13} /> Duplicate</button>
              <button type="button" className="btn-ghost !py-1.5 text-xs text-rose-700" onClick={onDelete}><Trash2 size={13} /> Delete</button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 bg-white p-2.5">
              <p className="text-xs text-slate-600">Run only this step, with the items it received in the last run (or an empty item). Nothing upstream runs.</p>
              <button type="button" disabled={testing || definition.status === "upcoming"} onClick={onTest} className="btn-outline mt-2 !py-1.5 text-xs disabled:opacity-40">{testing ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />} Test this step</button>
              {testResult && (
                <div className="mt-2 space-y-1.5 text-xs">
                  <p className="flex items-center gap-2"><StatusPill status={testResult.status} />{testResult.waiting && <span className="text-amber-900">{testResult.waiting.message ?? "It would wait here."}</span>}</p>
                  {testResult.error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-800">{testResult.error}</p>}
                  {testResult.output && Object.entries(testResult.output).map(([port, data]) => <div key={port}><p className="font-semibold text-slate-600">{port}: {data.count} item{data.count === 1 ? "" : "s"}</p><pre className="max-h-48 overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[11px] text-slate-100">{JSON.stringify(data.items, null, 2)}</pre></div>)}
                </div>
              )}
            </div>
            {lastRun ? (
              <div className="space-y-2 text-xs">
                <p className="flex items-center gap-2 font-semibold text-slate-700">Last run <StatusPill status={lastRun.status} /> {lastRun.attempts > 1 && <span className="text-amber-800">{lastRun.attempts} attempts</span>}</p>
                {lastRun.error && <p role="alert" className="rounded-lg bg-rose-50 p-2 text-rose-800">{lastRun.error}</p>}
                {lastRun.input && <div><p className="font-semibold text-slate-600">Input ({lastRun.input.count})</p><pre className="max-h-48 overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[11px] text-slate-100">{JSON.stringify(lastRun.input.items, null, 2)}</pre></div>}
                {lastRun.output && Object.entries(lastRun.output).map(([port, data]) => <div key={port}><p className="font-semibold text-slate-600">Output{port !== "main" ? ` · ${port}` : ""} ({data.count})</p><pre className="max-h-48 overflow-auto rounded-lg bg-slate-950 p-2 font-mono text-[11px] text-slate-100">{JSON.stringify(data.items, null, 2)}</pre></div>)}
              </div>
            ) : <p className="text-xs text-slate-500">Run the workflow to see what this step received and produced.</p>}
          </>
        )}
      </div>
    </aside>
  );
}

// ---------- dialogs ----------

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3"><h2 className="font-display text-lg font-semibold text-ink">{title}</h2><button type="button" className="btn-ghost !p-1.5" aria-label="Close" onClick={onClose}><X size={14} /></button></div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function SecretsDialog({ secrets, webhooks, onClose }: { secrets: WebhookSecret[]; webhooks: WebhookInfo[]; onClose: () => void }) {
  return (
    <Dialog title="Save your webhook secret" onClose={onClose}>
      <p className="text-sm text-slate-600">This is the only time the secret is shown. Store it in the service that will call the webhook. HANNAH keeps only a hash (and, for HMAC, an encrypted copy it can't show).</p>
      <ul className="mt-3 space-y-3">
        {secrets.map((secret) => {
          const hook = webhooks.find((item) => item.nodeId === secret.nodeId);
          return (
            <li key={secret.triggerId} className="space-y-1.5 rounded-2xl border border-slate-200 p-3 text-xs">
              {hook && <p className="flex items-center gap-1.5 font-mono"><span className="min-w-0 flex-1 truncate">{hook.url}</span><button type="button" className="btn-ghost !p-1" aria-label="Copy URL" onClick={() => void navigator.clipboard?.writeText(hook.url)}><Copy size={12} /></button></p>}
              <p className="flex items-center gap-1.5 font-mono"><span className="min-w-0 flex-1 break-all rounded bg-slate-100 p-1.5" aria-label="Webhook secret">{secret.secret}</span><button type="button" className="btn-ghost !p-1" aria-label="Copy secret" onClick={() => void navigator.clipboard?.writeText(secret.secret)}><Copy size={12} /></button></p>
              <pre className="overflow-x-auto rounded-lg bg-slate-950 p-2 text-[10px] text-slate-100">{`curl -X POST ${hook?.url ?? "<url>"} \\\n  -H "Content-Type: application/json" \\\n  -H "X-Hannah-Token: ${secret.secret}" \\\n  -d '{"text": "hello"}'`}</pre>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn-primary mt-4" onClick={onClose}><Check size={14} /> I've saved it</button>
    </Dialog>
  );
}

function TestDataDialog({ initial, triggerName, onRun, onClose }: { initial: string; triggerName: string; onRun: (data: unknown, text: string) => void; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState("");
  return (
    <Dialog title="Test run with sample data" onClose={onClose}>
      <p className="text-sm text-slate-600">“{triggerName}” is started by another service, so give the data it would send. For a webhook it's an object with <code className="rounded bg-slate-100 px-1 text-xs">body</code>, <code className="rounded bg-slate-100 px-1 text-xs">query</code> and <code className="rounded bg-slate-100 px-1 text-xs">headers</code>; the steps read it as <code className="rounded bg-slate-100 px-1 text-xs">{"{{ $json.body.… }}"}</code>.</p>
      <label htmlFor="test-data" className="mt-3 block text-xs font-semibold text-slate-700">Sample data (JSON)</label>
      <textarea id="test-data" rows={8} spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setError(""); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-3 font-mono text-xs" />
      {error && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}
      <p className="mt-2 text-[11px] text-slate-500">Remembered on this device for this workflow. A test run uses the draft and is marked as a test in the run history.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" onClick={() => { try { onRun(JSON.parse(text || "{}"), text); } catch { setError("That isn't valid JSON."); } }}><Play size={14} /> Run</button>
      </div>
    </Dialog>
  );
}

function ActivateDialog({ permissions, onApprove, onClose, busy }: { permissions: Permission[]; onApprove: () => void; onClose: () => void; busy: boolean }) {
  return (
    <Dialog title="Activate this workflow?" onClose={onClose}>
      <p className="text-sm text-slate-600">Once active, it runs on its triggers without asking, on HANNAH's server. It may:</p>
      <ul className="mt-3 space-y-2">
        {permissions.map((entry) => (
          <li key={entry.permission} className={`rounded-xl border p-2.5 text-sm ${entry.permission === "send-email-without-asking" ? "border-amber-300 bg-amber-50" : "border-slate-200"}`}>
            <p className="font-medium text-ink">{PERMISSION_LABELS[entry.permission] ?? entry.permission}</p>
            <p className="text-xs text-slate-500">Steps: {entry.nodes.join(", ")}</p>
          </li>
        ))}
        {!permissions.length && <li className="text-sm text-slate-500">Nothing beyond moving data between its own steps.</li>}
      </ul>
      <p className="mt-3 text-xs text-slate-500">Changing what it may do later pauses it until you approve again. Every activation is recorded in your account's security activity.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>Not now</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={onApprove}><Power size={14} /> Activate</button>
      </div>
    </Dialog>
  );
}

// ---------- editor ----------

type Props = { workflowId: string; catalog: Catalog; onBack: () => void; onOpenExecution: (id: string) => void };

function EditorInner({ workflowId, catalog, onBack, onOpenExecution }: Props) {
  const flow = useReactFlow();
  const byType = useMemo(() => new Map(catalog.nodes.map((node) => [node.type, node])), [catalog]);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState("");
  const [draftVersion, setDraftVersion] = useState(0);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [validation, setValidation] = useState<Validation>({ errors: [], warnings: [] });
  const [selected, setSelected] = useState<string[]>([]);
  const [panelNode, setPanelNode] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Detail | null>(null);
  const [showLibrary, setShowLibrary] = useState(true);
  const [secrets, setSecrets] = useState<WebhookSecret[] | null>(null);
  const [activating, setActivating] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [askTestData, setAskTestData] = useState(false);
  const testFileInput = useRef<HTMLInputElement>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Parameters<typeof ConfigPanel>[0]["testResult"]>(null);
  const history = useRef(new History());
  const clipboard = useRef<{ nodes: WorkflowNode[]; connections: WorkflowConnection[] } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [, forceRender] = useState(0);

  const load = useCallback(async () => {
    const [next, creds] = await Promise.all([WorkflowApi.get(workflowId), WorkflowApi.credentials().catch(() => ({ credentials: [] as Credential[], vault: false }))]);
    setDetail(next);
    setDefinition(next.definition);
    setName(next.workflow.name);
    setDraftVersion(next.workflow.draftVersion);
    setSavedSnapshot(JSON.stringify({ name: next.workflow.name, definition: next.definition }));
    setValidation(next.validation);
    setCredentials(creds.credentials);
  }, [workflowId]);

  useEffect(() => {
    load().catch((error) => setNotice({ tone: "error", text: error instanceof Error ? error.message : "The workflow couldn't be loaded." }));
  }, [load]);

  const dirty = definition ? JSON.stringify({ name, definition }) !== savedSnapshot : false;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Validate the draft on the server after edits settle.
  useEffect(() => {
    if (!definition) return;
    const timer = window.setTimeout(() => {
      WorkflowApi.validate(workflowId, definition).then((result) => setValidation(result.validation)).catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [definition, workflowId]);

  const change = useCallback((next: WorkflowDefinition, record = true) => {
    setDefinition((current) => {
      if (record && current) history.current.push(current);
      return next;
    });
    forceRender((value) => value + 1);
  }, []);

  const runState: RunState = useMemo(() => Object.fromEntries((run?.nodes ?? []).map((node) => [node.nodeId, { status: node.status, count: node.output ? Object.values(node.output).reduce((sum, port) => sum + port.count, 0) : 0, error: node.error }])), [run]);
  const problemsByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const problem of validation.errors) if (problem.nodeId) map.set(problem.nodeId, [...(map.get(problem.nodeId) ?? []), problem.message]);
    return map;
  }, [validation]);

  const rfNodes: CardNode[] = useMemo(() => (definition?.nodes ?? []).map((node) => ({
    id: node.id, type: "hannah", position: node.position, selected: selected.includes(node.id),
    data: { node, definition: byType.get(node.type), errors: problemsByNode.get(node.id) ?? [], run: runState[node.id] },
  })), [definition, selected, byType, problemsByNode, runState]);

  const rfEdges: Edge[] = useMemo(() => (definition?.connections ?? []).map((connection) => {
    const upstream = run?.nodes.find((node) => node.nodeId === connection.source);
    const count = upstream?.output?.[connection.sourceOutput]?.count;
    return {
      id: connection.id, source: connection.source, target: connection.target, sourceHandle: connection.sourceOutput, targetHandle: connection.targetInput,
      animated: run ? !FINAL.has(run.execution.status) && runState[connection.source]?.status === "done" && !runState[connection.target] : false,
      label: count !== undefined ? `${count} item${count === 1 ? "" : "s"}` : undefined,
      style: { strokeWidth: 2, stroke: count === 0 ? "#cbd5e1" : count ? "#10b981" : "#94a3b8" },
      labelStyle: { fontSize: 10, fontWeight: 600 },
    };
  }), [definition, run, runState]);

  const onNodesChange = useCallback((changes: NodeChange<CardNode>[]) => {
    setDefinition((current) => {
      if (!current) return current;
      let nodes = current.nodes;
      for (const item of changes) {
        if (item.type === "position" && item.position) nodes = nodes.map((node) => (node.id === item.id ? { ...node, position: item.position! } : node));
      }
      return nodes === current.nodes ? current : { ...current, nodes };
    });
    const selection = changes.filter((item) => item.type === "select");
    if (selection.length) setSelected((current) => {
      let next = [...current];
      for (const item of selection) if (item.type === "select") next = item.selected ? [...new Set([...next, item.id])] : next.filter((id) => id !== item.id);
      return next;
    });
  }, []);

  const removeNodes = useCallback((ids: string[]) => {
    if (!definition || !ids.length) return;
    change({ ...definition, nodes: definition.nodes.filter((node) => !ids.includes(node.id)), connections: definition.connections.filter((connection) => !ids.includes(connection.source) && !ids.includes(connection.target)) });
    setSelected([]);
    if (panelNode && ids.includes(panelNode)) setPanelNode(null);
  }, [definition, change, panelNode]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const removed = changes.filter((item) => item.type === "remove").map((item) => item.id);
    if (removed.length && definition) change({ ...definition, connections: definition.connections.filter((connection) => !removed.includes(connection.id)) });
  }, [definition, change]);

  const isValidConnection = useCallback((connection: Connection | Edge) => {
    if (!definition || !connection.source || !connection.target || connection.source === connection.target) return false;
    const target = definition.nodes.find((node) => node.id === connection.target);
    const targetDefinition = target && byType.get(target.type);
    if (!targetDefinition || !targetDefinition.inputs.length) return false;
    if (definition.connections.some((item) => item.source === connection.source && item.target === connection.target && item.sourceOutput === (connection.sourceHandle ?? "main") && item.targetInput === (connection.targetHandle ?? "main"))) return false;
    return !reaches(definition.connections, connection.target, connection.source);
  }, [definition, byType]);

  const onConnect = useCallback((connection: Connection) => {
    if (!definition || !isValidConnection(connection)) return;
    change({ ...definition, connections: [...definition.connections, { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, source: connection.source!, target: connection.target!, sourceOutput: connection.sourceHandle ?? "main", targetInput: connection.targetHandle ?? "main" }] });
  }, [definition, change, isValidConnection]);

  const addNode = useCallback((nodeDefinition: NodeDefinition, position?: { x: number; y: number }) => {
    if (!definition || nodeDefinition.status === "upcoming") return;
    const anchor = (selected.length === 1 && definition.nodes.find((node) => node.id === selected[0])) || null;
    const id = newNodeId();
    const node: WorkflowNode = {
      id, name: uniqueName(nodeDefinition.label, definition.nodes), type: nodeDefinition.type, params: defaultsFor(nodeDefinition),
      position: position ?? (anchor ? { x: anchor.position.x + 300, y: anchor.position.y } : flow.screenToFlowPosition({ x: (wrapper.current?.clientWidth ?? 800) / 2 + (wrapper.current?.getBoundingClientRect().left ?? 0), y: (wrapper.current?.clientHeight ?? 500) / 2 + (wrapper.current?.getBoundingClientRect().top ?? 0) })),
    };
    const anchorDefinition = anchor && byType.get(anchor.type);
    const autoConnect = !position && anchor && anchorDefinition && nodeDefinition.inputs.length && !definition.connections.some((connection) => connection.source === anchor.id);
    change({
      ...definition, nodes: [...definition.nodes, node],
      connections: autoConnect ? [...definition.connections, { id: `c${Date.now().toString(36)}`, source: anchor!.id, target: id, sourceOutput: outputsFor(anchorDefinition!, anchor!.params)[0] ?? "main", targetInput: nodeDefinition.inputs[0] }] : definition.connections,
    });
    setSelected([id]);
    setPanelNode(id);
    setTestResult(null);
  }, [definition, selected, byType, change, flow]);

  const onDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/hannah-node");
    const nodeDefinition = byType.get(type);
    if (nodeDefinition) addNode(nodeDefinition, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [byType, addNode, flow]);

  const copySelection = useCallback(() => {
    if (!definition || !selected.length) return;
    const nodes = definition.nodes.filter((node) => selected.includes(node.id));
    clipboard.current = { nodes: structuredClone(nodes), connections: definition.connections.filter((connection) => selected.includes(connection.source) && selected.includes(connection.target)) };
    setNotice({ tone: "info", text: `Copied ${nodes.length} step${nodes.length === 1 ? "" : "s"}.` });
  }, [definition, selected]);

  const paste = useCallback((source = clipboard.current) => {
    if (!definition || !source?.nodes.length) return;
    const ids = new Map(source.nodes.map((node) => [node.id, newNodeId()]));
    let names = definition.nodes;
    const nodes = source.nodes.map((node) => {
      const copy = { ...structuredClone(node), id: ids.get(node.id)!, name: uniqueName(node.name, names), position: { x: node.position.x + 40, y: node.position.y + 60 } };
      names = [...names, copy];
      return copy;
    });
    change({ ...definition, nodes: [...definition.nodes, ...nodes], connections: [...definition.connections, ...source.connections.map((connection) => ({ ...connection, id: `c${Math.random().toString(36).slice(2, 9)}`, source: ids.get(connection.source)!, target: ids.get(connection.target)! }))] });
    setSelected(nodes.map((node) => node.id));
  }, [definition, change]);

  const undo = useCallback(() => { if (!definition) return; const previous = history.current.undo(definition); if (previous) { setDefinition(previous); forceRender((value) => value + 1); } }, [definition]);
  const redo = useCallback(() => { if (!definition) return; const next = history.current.redo(definition); if (next) { setDefinition(next); forceRender((value) => value + 1); } }, [definition]);

  const save = useCallback(async () => {
    if (!definition) return false;
    setBusy("save");
    try {
      const result = await WorkflowApi.save(workflowId, { baseVersion: draftVersion, name, definition });
      setDraftVersion(result.workflow.draftVersion);
      setSavedSnapshot(JSON.stringify({ name, definition }));
      setValidation(result.validation);
      setNotice({ tone: "ok", text: "Saved." });
      return true;
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof AccountError && error.status === 409 ? "This workflow changed in another window. Copy what you need, then reload." : error instanceof Error ? error.message : "Couldn't save." });
      return false;
    } finally {
      setBusy("");
    }
  }, [definition, draftVersion, name, workflowId]);

  const testDataKey = `hannah.workflowTestData.${workflowId}`;
  const startTrigger = definition?.nodes.find((node) => node.type === "trigger.manual" && !node.disabled) ?? definition?.nodes.find((node) => byType.get(node.type)?.category === "trigger" && !node.disabled);
  const testRun = useCallback(async (triggerData?: unknown) => {
    // New email uses your newest matching message; File uploaded asks for a file; the rest take sample data.
    if (startTrigger?.type === "trigger.file") { testFileInput.current?.click(); return; }
    if (startTrigger && !["trigger.manual", "trigger.email"].includes(startTrigger.type) && triggerData === undefined) { setAskTestData(true); return; }
    if (!(await save())) return;
    setBusy("run");
    try {
      const { executionId } = await WorkflowApi.run(workflowId, { draft: true, ...(triggerData !== undefined ? { triggerData, triggerNodeId: startTrigger?.id } : {}) });
      setRun(null);
      setRunId(executionId);
      setShowRun(true);
      setNotice({ tone: "info", text: "Test run started. Each step shows its result on the canvas." });
    } catch (error) {
      const body = error instanceof AccountError ? (error.body as { validation?: Validation } | undefined) : undefined;
      if (body?.validation) setValidation(body.validation);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The run couldn't start." });
    } finally {
      setBusy("");
    }
  }, [save, workflowId, startTrigger]);

  const testWithFile = useCallback(async (file: File) => {
    if (!(await save())) return;
    setBusy("run");
    try {
      const { executionId } = await WorkflowApi.uploadFile(workflowId, file, { test: true });
      setRun(null);
      setRunId(executionId);
      setShowRun(true);
      setNotice({ tone: "info", text: `Test run started with “${file.name}”.` });
    } catch (error) {
      const body = error instanceof AccountError ? (error.body as { validation?: Validation } | undefined) : undefined;
      if (body?.validation) setValidation(body.validation);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The file couldn't be uploaded." });
    } finally {
      setBusy("");
    }
  }, [save, workflowId]);

  const publish = useCallback(async () => {
    if (!(await save())) return;
    setBusy("publish");
    try {
      const result = await WorkflowApi.publish(workflowId);
      const refreshed = await WorkflowApi.get(workflowId);
      setDetail(refreshed);
      if (result.webhookSecrets.length) setSecrets(result.webhookSecrets);
      setNotice({ tone: result.needsActivation ? "info" : "ok", text: result.needsActivation ? `Published version ${result.version}. What it may do changed, so it's paused: review and activate it again.` : `Published version ${result.version}${result.active ? "; the active workflow now uses it" : ""}.` });
    } catch (error) {
      const body = error instanceof AccountError ? (error.body as { validation?: Validation } | undefined) : undefined;
      if (body?.validation) setValidation(body.validation);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Couldn't publish." });
    } finally {
      setBusy("");
    }
  }, [save, workflowId]);

  const activate = useCallback(async () => {
    if (!detail?.publishedPermissions) return;
    setBusy("activate");
    try {
      const result = await WorkflowApi.activate(workflowId, detail.publishedPermissions);
      setActivating(false);
      const refreshed = await WorkflowApi.get(workflowId);
      setDetail(refreshed);
      if (result.webhookSecrets.length) setSecrets(result.webhookSecrets);
      setNotice({ tone: "ok", text: "Active: it now runs on its triggers." });
    } catch (error) {
      setActivating(false);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Couldn't activate." });
    } finally {
      setBusy("");
    }
  }, [detail, workflowId]);

  const deactivate = useCallback(async () => {
    setBusy("activate");
    try {
      await WorkflowApi.deactivate(workflowId);
      setDetail(await WorkflowApi.get(workflowId));
      setNotice({ tone: "ok", text: "Paused. Its triggers won't start it until you activate it again." });
    } finally {
      setBusy("");
    }
  }, [workflowId]);

  const exportFile = useCallback(async () => {
    const file = await WorkflowApi.exportFile(workflowId);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${name.replace(/[^\w-]+/g, "-").toLowerCase() || "workflow"}.hannah-workflow.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, [workflowId, name]);

  const importInto = useCallback(async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = (parsed.definition ?? parsed) as WorkflowDefinition;
      if (!definition || !Array.isArray(incoming.nodes)) throw new Error("That file isn't a HANNAH workflow.");
      paste({ nodes: incoming.nodes.map((node) => ({ ...node, credentialId: undefined })), connections: incoming.connections ?? [] });
      setNotice({ tone: "ok", text: `Added ${incoming.nodes.length} steps from the file. Choose credentials for steps that need them.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "That file couldn't be read." });
    }
  }, [definition, paste]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    else if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
    else if (mod && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) { event.preventDefault(); redo(); }
    else if (mod && event.key.toLowerCase() === "c") copySelection();
    else if (mod && event.key.toLowerCase() === "v") paste();
    else if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); copySelection(); paste(); }
    else if (event.key === "Delete" || event.key === "Backspace") removeNodes(selected);
  };

  // Field suggestions for the open step, from the last run's data upstream of it.
  const fields = useMemo(() => {
    if (!definition || !panelNode || !run) return [] as string[];
    const parents = new Set(definition.connections.filter((connection) => connection.target === panelNode).map((connection) => connection.source));
    const ancestors = new Set<string>();
    const queue = [...parents];
    while (queue.length) { const id = queue.shift()!; if (ancestors.has(id)) continue; ancestors.add(id); queue.push(...definition.connections.filter((connection) => connection.target === id).map((connection) => connection.source)); }
    const out: string[] = [];
    for (const nodeRun of run.nodes) {
      if (!ancestors.has(nodeRun.nodeId) || !nodeRun.output) continue;
      const sample = Object.values(nodeRun.output).find((port) => port.count)?.items[0];
      for (const path of fieldPaths(sample)) out.push(parents.has(nodeRun.nodeId) ? `{{ $json.${path} }}` : `{{ $node["${nodeRun.name}"].json.${path} }}`);
    }
    return [...new Set(out)].slice(0, 60);
  }, [definition, panelNode, run]);

  const panel = definition?.nodes.find((node) => node.id === panelNode);
  const panelDefinition = panel && byType.get(panel.type);
  const status = detail ? (detail.workflow.active ? "Active" : detail.workflow.publishedVersion ? "Published, paused" : "Draft") : "";
  const onLoadedRun = useCallback((next: Detail) => setRun(next), []);

  if (!definition || !detail) return <div className="p-6 text-sm text-slate-500" role="status">{notice?.text ?? "Loading the workflow…"}</div>;

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[520px] flex-col overflow-hidden rounded-[1.75rem] border border-slate-200 bg-slate-50" onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <button type="button" className="btn-ghost !p-2" aria-label="Back to workflows" onClick={() => { if (!dirty || window.confirm("Leave without saving your changes?")) onBack(); }}><ArrowLeft size={16} /></button>
        <label className="sr-only" htmlFor="workflow-name">Workflow name</label>
        <input id="workflow-name" value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 max-w-[16rem] flex-1 rounded-lg border border-transparent px-2 py-1 font-display text-base font-semibold text-ink outline-none hover:border-slate-200 focus:border-violet-300" />
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${detail.workflow.active ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-100 text-slate-600"}`}>{status}{detail.workflow.publishedVersion ? ` · v${detail.workflow.publishedVersion}` : ""}</span>
        {dirty && <span className="text-[11px] font-medium text-amber-800">Unsaved changes</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button type="button" className="btn-ghost !p-2" aria-label="Undo" title="Undo (Ctrl/⌘ Z)" disabled={!history.current.canUndo} onClick={undo}><Undo2 size={15} /></button>
          <button type="button" className="btn-ghost !p-2" aria-label="Redo" title="Redo (Ctrl/⌘ Shift Z)" disabled={!history.current.canRedo} onClick={redo}><Redo2 size={15} /></button>
          <button type="button" className="btn-ghost !p-2" aria-label="Tidy up the layout" title="Tidy up" onClick={() => { change({ ...definition, nodes: autoLayout(definition) }); window.setTimeout(() => flow.fitView({ padding: 0.2, duration: 300 }), 50); }}><LayoutGrid size={15} /></button>
          <label className="btn-ghost !p-2 cursor-pointer" title="Add steps from a file"><Upload size={15} /><input type="file" accept=".json,application/json" className="sr-only" aria-label="Import steps from a file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importInto(file); }} /></label>
          <button type="button" className="btn-ghost !p-2" aria-label="Export this workflow" title="Export" onClick={() => void exportFile()}><Download size={15} /></button>
          <button type="button" className={`btn-ghost !py-1.5 text-xs ${validation.errors.length ? "text-rose-700" : "text-emerald-700"}`} onClick={() => { const first = validation.errors[0]; if (first?.nodeId) { setSelected([first.nodeId]); setPanelNode(first.nodeId); } setNotice(validation.errors.length ? { tone: "error", text: validation.errors.map((problem) => `${definition.nodes.find((node) => node.id === problem.nodeId)?.name ?? "Workflow"}: ${problem.message}`).join(" · ") } : { tone: "ok", text: validation.warnings.length ? `Valid, with notes: ${validation.warnings.map((warning) => warning.message).join(" · ")}` : "Valid: ready to run." }); }}>
            {validation.errors.length ? <><AlertTriangle size={13} /> {validation.errors.length} problem{validation.errors.length === 1 ? "" : "s"}</> : <><Check size={13} /> Valid</>}
          </button>
          <button type="button" className="btn-outline !py-1.5 text-xs" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save</button>
          <button type="button" className="btn-outline !py-1.5 text-xs" disabled={Boolean(busy) || validation.errors.length > 0} onClick={() => void testRun()}>{busy === "run" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Test run</button>
          <button type="button" className="btn-outline !py-1.5 text-xs" disabled={Boolean(busy) || validation.errors.length > 0} onClick={() => void publish()}>{busy === "publish" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Publish</button>
          {detail.workflow.active
            ? <button type="button" className="btn-outline !py-1.5 text-xs" disabled={Boolean(busy)} onClick={() => void deactivate()}><CircleSlash size={13} /> Pause</button>
            : <button type="button" className="btn-primary !py-1.5 text-xs" disabled={Boolean(busy) || !detail.workflow.publishedVersion} title={detail.workflow.publishedVersion ? "" : "Publish first"} onClick={() => setActivating(true)}><Power size={13} /> Activate</button>}
        </div>
      </header>
      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 border-b px-4 py-2 text-xs ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : notice.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-sky-200 bg-sky-50 text-sky-900"}`}>
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" className="shrink-0" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={12} /></button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {showLibrary && <div className="hidden w-72 shrink-0 border-r border-slate-200 bg-white md:block"><NodeLibrary catalog={catalog} onAdd={(node) => addNode(node)} /></div>}
        <div ref={wrapper} className="relative min-w-0 flex-1" onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}>
          <ReactFlow<CardNode, Edge>
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection}
            onNodeDragStart={() => history.current.push(definition)} onNodeClick={(_, node) => { setPanelNode(node.id); setTestResult(null); }} onPaneClick={() => setPanelNode(null)}
            deleteKeyCode={null} selectionOnDrag panOnDrag={[1, 2]} panOnScroll multiSelectionKeyCode="Shift" fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }} minZoom={0.2} maxZoom={1.8} proOptions={{ hideAttribution: true }}
            aria-label="Workflow canvas"
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
          <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5">
            <button type="button" className="btn-outline pointer-events-auto !py-1.5 text-xs" onClick={() => setShowLibrary((value) => !value)} aria-pressed={showLibrary}>{showLibrary ? "Hide steps" : "Add a step"}</button>
            {runId && <button type="button" className="btn-outline pointer-events-auto !py-1.5 text-xs" onClick={() => setShowRun((value) => !value)}><HistoryIcon size={13} /> {showRun ? "Hide run" : "Show run"}</button>}
            {selected.length > 1 && <span className="pointer-events-auto rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-600 shadow-sm">{selected.length} selected · ⌘/Ctrl C, V, D, Delete</span>}
          </div>
          {!definition.nodes.length && <p className="absolute inset-x-0 top-1/3 text-center text-sm text-slate-500">Add a trigger from the step library to start.</p>}
          {showLibrary && <div className="absolute inset-y-0 left-0 w-[85%] max-w-xs border-r border-slate-200 bg-white md:hidden"><NodeLibrary catalog={catalog} onAdd={(node) => { addNode(node); setShowLibrary(false); }} onClose={() => setShowLibrary(false)} /></div>}
        </div>
        {panel && panelDefinition && (
          <div className="absolute inset-x-0 bottom-0 z-20 max-h-[70%] border-t border-slate-200 bg-white md:static md:max-h-none md:w-[380px] md:shrink-0 md:border-l md:border-t-0">
            <ConfigPanel
              node={panel} definition={panelDefinition} catalog={catalog} credentials={credentials} fields={fields}
              problems={validation.errors.filter((problem) => problem.nodeId === panel.id)}
              lastRun={run?.nodes.find((node) => node.nodeId === panel.id)} webhook={detail.webhooks.find((hook) => hook.nodeId === panel.id)}
              onChange={(next) => change({ ...definition, nodes: definition.nodes.map((node) => (node.id === next.id ? next : node)) })}
              onRename={(value) => change({ ...definition, nodes: definition.nodes.map((node) => (node.id === panel.id ? { ...node, name: value } : node)) }, false)}
              onDelete={() => removeNodes([panel.id])}
              onDuplicate={() => { setSelected([panel.id]); clipboard.current = { nodes: [structuredClone(panel)], connections: [] }; paste(); }}
              testing={testing} testResult={testResult}
              onTest={async () => {
                setTesting(true);
                try {
                  const upstream = definition.connections.find((connection) => connection.target === panel.id);
                  const items = upstream ? run?.nodes.find((node) => node.nodeId === upstream.source)?.output?.[upstream.sourceOutput]?.items : undefined;
                  setTestResult(await WorkflowApi.testNode(workflowId, panel.id, items, definition));
                } catch (error) {
                  setTestResult({ status: "failed", error: error instanceof Error ? error.message : "The test failed.", output: null, waiting: null });
                } finally {
                  setTesting(false);
                }
              }}
              onClose={() => setPanelNode(null)}
            />
          </div>
        )}
        {showRun && runId && !panel && (
          <div className="absolute inset-x-0 bottom-0 z-20 max-h-[70%] overflow-y-auto border-t border-slate-200 bg-white p-4 md:static md:max-h-none md:w-[420px] md:shrink-0 md:border-l md:border-t-0">
            <ExecutionDetail executionId={runId} onLoaded={onLoadedRun} onOpenExecution={(id) => { setRunId(id); onOpenExecution(id); }} onClose={() => setShowRun(false)} />
          </div>
        )}
      </div>
      {activating && detail.publishedPermissions && <ActivateDialog permissions={detail.publishedPermissions} busy={busy === "activate"} onApprove={() => void activate()} onClose={() => setActivating(false)} />}
      {askTestData && startTrigger && (
        <TestDataDialog
          triggerName={startTrigger.name}
          initial={(() => { try { return localStorage.getItem(testDataKey) ?? ""; } catch { return ""; } })() || JSON.stringify(startTrigger.type === "trigger.webhook" ? { body: { text: "INVOICE from Acme Supplies, total 1250.50, due 2026-12-01" }, query: {}, headers: { "content-type": "application/json" } } : startTrigger.type === "trigger.schedule" ? { scheduledFor: new Date().toISOString() } : { event: "custom", data: {} }, null, 2)}
          onRun={(data, text) => { try { localStorage.setItem(testDataKey, text); } catch { /* not remembered */ } setAskTestData(false); void testRun(data); }}
          onClose={() => setAskTestData(false)}
        />
      )}
      <input ref={testFileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose a file for the test run" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void testWithFile(file); }} />
      {secrets && <SecretsDialog secrets={secrets} webhooks={detail.webhooks} onClose={() => setSecrets(null)} />}
    </div>
  );
}

export default function WorkflowEditor(props: Props) {
  return <ReactFlowProvider><EditorInner {...props} /></ReactFlowProvider>;
}

export { localTimeZone };
