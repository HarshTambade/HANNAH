import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { Bot, FileUp, KeyRound, Loader2, Plus, Power, RefreshCw, Sparkles, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { WorkflowApi, type Catalog, type Credential, type Execution, type WorkflowSummary } from "../../services/WorkflowApi";
import ExecutionDetail, { StatusPill } from "./ExecutionDetail";
import { WORKFLOW_TEMPLATES } from "./templates";
import { duration, when } from "./support";

const WorkflowEditor = lazy(() => import("./WorkflowEditor"));

type Tab = "workflows" | "runs" | "credentials";
const TRIGGER_LABELS: Record<string, string> = { "trigger.manual": "Manual", "trigger.schedule": "Schedule", "trigger.webhook": "Webhook", "trigger.event": "Event", "trigger.email": "New email", "trigger.file": "File upload" };

function Card({ title, children, label, aside }: { title: string; children: React.ReactNode; label?: string; aside?: React.ReactNode }) {
  return (
    <section className="bento-card" aria-label={label ?? title}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-lg font-bold text-ink">{title}</h2>{aside}</div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function WorkflowList({ onOpen, onRuns }: { onOpen: (id: string) => void; onRuns: (workflowId: string) => void }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(() => WorkflowApi.list().then((result) => { setWorkflows(result.workflows); setError(""); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Couldn't load workflows.")), []);
  useEffect(() => { void load(); }, [load]);

  const create = async (name: string, build?: () => import("../../services/WorkflowApi").WorkflowDefinition) => {
    setBusy(name);
    try {
      const { workflow } = await WorkflowApi.create(name, build?.());
      onOpen(workflow.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't create it.");
    } finally {
      setBusy("");
    }
  };

  const fromText = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("describe");
    setNotes("");
    try {
      const result = await WorkflowApi.fromText(description);
      setNotes(result.notes);
      onOpen(result.workflow.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "HANNAH couldn't draft that.");
    } finally {
      setBusy("");
    }
  };

  const importFile = async (file: File) => {
    try {
      const result = await WorkflowApi.importFile(JSON.parse(await file.text()));
      onOpen(result.workflow.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That file couldn't be imported.");
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Describe an automation" label="Describe an automation">
        <form onSubmit={fromText} className="flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor="workflow-description">Describe what it should do</label>
          <input id="workflow-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Every morning, summarize my new emails and notify me" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400" />
          <button type="submit" disabled={description.trim().length < 8 || Boolean(busy)} className="btn-primary !py-2 text-sm disabled:opacity-40">{busy === "describe" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Draft it</button>
        </form>
        <p className="mt-2 text-xs text-slate-500">HANNAH drafts the steps with your AI key; it opens in the editor as a draft and never runs until you test, publish and activate it.</p>
        {notes && <p className="mt-2 rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-900">{notes}</p>}
      </Card>

      <Card title="Your workflows" label="Your workflows" aside={
        <div className="flex flex-wrap gap-1.5">
          <label className="btn-ghost cursor-pointer !py-1.5 text-xs"><FileUp size={13} /> Import<input type="file" accept=".json,application/json" className="sr-only" aria-label="Import a workflow file" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} /></label>
          <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => void load()} aria-label="Refresh workflows"><RefreshCw size={13} /></button>
          <button type="button" className="btn-primary !py-1.5 text-xs" disabled={Boolean(busy)} onClick={() => void create("Untitled workflow")}><Plus size={13} /> New workflow</button>
        </div>
      }>
        {error && <p role="alert" className="mb-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
        {workflows === null ? <p className="text-sm text-slate-500" role="status">Loading…</p> : workflows.length === 0 ? (
          <p className="text-sm text-slate-600">No workflows yet. Start from a template below, describe one, or press New workflow.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Workflows">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${workflow.active ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-slate-50 text-slate-500"}`}>{workflow.active ? <Power size={15} /> : <WorkflowIcon size={15} />}</span>
                <button type="button" onClick={() => onOpen(workflow.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-semibold text-ink">{workflow.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {workflow.active ? "Active" : workflow.publishedVersion ? "Paused" : "Draft"}
                    {workflow.triggers?.length ? ` · ${workflow.triggers.map((type) => TRIGGER_LABELS[type] ?? type).join(", ")}` : ""}
                    {` · ${workflow.nodes ?? 0} steps`}
                    {workflow.nextRunAt ? ` · next ${when(workflow.nextRunAt)}` : ""}
                    {workflow.active && workflow.mailbox?.checkedAt && !workflow.mailbox.lastError ? ` · mailbox checked ${when(workflow.mailbox.checkedAt)}` : ""}
                  </span>
                  {workflow.active && workflow.mailbox?.lastError && <span role="alert" className="mt-0.5 block text-xs text-rose-700">Mailbox check failed: {workflow.mailbox.lastError}</span>}
                </button>
                {workflow.active && workflow.triggers?.includes("trigger.file") && (
                  <label className="btn-ghost cursor-pointer !px-2 !py-1 text-xs">
                    {busy === `upload:${workflow.id}` ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />} Upload file
                    <input type="file" className="sr-only" aria-label={`Upload a file to ${workflow.name}`} onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      setBusy(`upload:${workflow.id}`);
                      try {
                        await WorkflowApi.uploadFile(workflow.id, file);
                        setError("");
                        onRuns(workflow.id);
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : "The file couldn't be uploaded.");
                      } finally {
                        setBusy("");
                      }
                    }} />
                  </label>
                )}
                {workflow.lastRun && <button type="button" className="flex items-center gap-1.5 text-xs text-slate-500" onClick={() => onRuns(workflow.id)}><StatusPill status={workflow.lastRun.status} /> {when(workflow.lastRun.at)}</button>}
                <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Delete ${workflow.name}`} onClick={async () => { if (window.confirm(`Delete “${workflow.name}”? Its run history goes too.`)) { await WorkflowApi.remove(workflow.id); void load(); } }}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Start from a template" label="Workflow templates">
        <ul className="grid gap-3 md:grid-cols-2">
          {WORKFLOW_TEMPLATES.map((template) => (
            <li key={template.id}>
              <button type="button" disabled={Boolean(busy)} onClick={() => void create(template.name, template.build)} className="flex h-full w-full flex-col items-start rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-violet-300 hover:shadow-sm">
                <span className="text-sm font-semibold text-ink">{template.name}</span>
                <span className="mt-1 text-xs text-slate-600">{template.summary}</span>
                <span className="mt-2 text-[11px] text-slate-500">Needs: {template.needs.join("; ")}.</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function RunsCenter({ workflowId, openId, onOpen }: { workflowId?: string; openId: string | null; onOpen: (id: string | null) => void }) {
  const [runs, setRuns] = useState<Execution[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => WorkflowApi.executions({ workflowId, status, limit: 100 }).then((result) => { setRuns(result.executions); setError(""); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Couldn't load runs.")), [workflowId, status]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => window.clearInterval(timer);
  }, [load]);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card title="Runs" label="Workflow runs" aside={
        <label className="text-xs text-slate-600">Status{" "}
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs" aria-label="Filter by status">
            <option value="">All</option>
            {["running", "queued", "waiting-approval", "waiting", "completed", "failed", "cancelled", "timed-out"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      }>
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        {runs === null ? <p className="text-sm text-slate-500">Loading…</p> : runs.length === 0 ? <p className="text-sm text-slate-600">No runs yet.</p> : (
          <div className="overflow-x-auto" role="region" aria-label="Runs table" tabIndex={0}>
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500"><tr><th className="py-1.5 pr-2 font-semibold">Workflow</th><th className="pr-2 font-semibold">Trigger</th><th className="pr-2 font-semibold">Started</th><th className="pr-2 font-semibold">Duration</th><th className="pr-2 font-semibold">Steps</th><th className="font-semibold">Status</th></tr></thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className={`cursor-pointer border-t border-slate-100 hover:bg-violet-50/50 ${openId === run.id ? "bg-violet-50" : ""}`} onClick={() => onOpen(run.id)}>
                    <td className="py-2 pr-2"><button type="button" className="text-left font-medium text-ink underline-offset-2 hover:underline" onClick={() => onOpen(run.id)}>{run.workflowName}</button><span className="block font-mono text-[10px] text-slate-400">{run.id}</span></td>
                    <td className="pr-2 text-slate-600">{run.mode}{run.attempts > 1 ? ` · ${run.attempts} tries` : ""}</td>
                    <td className="pr-2 text-slate-600">{when(run.startedAt ?? run.createdAt)}</td>
                    <td className="pr-2 tabular-nums text-slate-600">{run.finishedAt && run.startedAt ? duration(run.finishedAt - run.startedAt) : "—"}</td>
                    <td className="pr-2 text-slate-600">{run.nodes ? `${run.nodes.done}✓ ${run.nodes.failed ? `${run.nodes.failed}✗ ` : ""}${run.nodes.skipped ? `${run.nodes.skipped} skipped` : ""}` : "—"}</td>
                    <td><StatusPill status={run.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="bento-card min-h-[12rem]">
        {openId ? <ExecutionDetail key={openId} executionId={openId} onOpenExecution={(id) => { onOpen(id); void load(); }} onClose={() => onOpen(null)} /> : <p className="text-sm text-slate-500">Choose a run to see every step's input, output, timing and errors.</p>}
      </div>
    </div>
  );
}

function CredentialsManager({ catalog }: { catalog: Catalog }) {
  const [list, setList] = useState<Credential[] | null>(null);
  const [vault, setVault] = useState(true);
  const [type, setType] = useState(Object.keys(catalog.credentialTypes)[0]);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(() => WorkflowApi.credentials().then((result) => { setList(result.credentials); setVault(result.vault); }).catch(() => setList([])), []);
  useEffect(() => { void load(); }, [load]);
  const spec = catalog.credentialTypes[type];
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const data: Record<string, unknown> = {};
      for (const field of spec.fields) data[field.name] = field.type === "keyValue" ? (values[field.name] ?? "").split("\n").map((line) => { const [key, ...rest] = line.split(":"); return { name: key.trim(), value: rest.join(":").trim() }; }).filter((entry) => entry.name) : values[field.name] ?? "";
      await WorkflowApi.createCredential(name, type, data);
      setName("");
      setValues({});
      setMessage({ tone: "ok", text: "Saved and encrypted. Its value won't be shown again." });
      void load();
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Couldn't save it." });
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Credentials" label="Saved credentials">
        <p className="text-xs text-slate-500">Encrypted on the server with the vault key. Steps use them when they run; nothing shows their values, not the editor, the runs or an export.</p>
        {list === null ? <p className="mt-3 text-sm text-slate-500">Loading…</p> : list.length === 0 ? <p className="mt-3 text-sm text-slate-600">None saved yet.</p> : (
          <ul className="mt-3 divide-y divide-slate-100" aria-label="Credentials">
            {list.map((credential) => (
              <li key={credential.id} className="flex items-center gap-3 py-2.5 text-sm">
                <KeyRound size={14} className="text-slate-400" />
                <span className="min-w-0 flex-1"><span className="font-medium text-ink">{credential.name}</span><span className="block text-xs text-slate-500">{credential.typeLabel} · {credential.hint}</span></span>
                <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Delete ${credential.name}`} onClick={async () => { if (window.confirm(`Delete “${credential.name}”? Steps using it will fail validation until you choose another.`)) { await WorkflowApi.deleteCredential(credential.id); void load(); } }}><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Add a credential" label="Add a credential">
        {!vault && <p role="alert" className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">This server has no vault key, so it can't store credentials. The operator can connect Supabase through Vercel, or set HANNAH_VAULT_KEY.</p>}
        <form onSubmit={save} className="space-y-3">
          <label className="block text-xs font-semibold text-slate-700">Type
            <select value={type} onChange={(event) => { setType(event.target.value); setValues({}); }} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm">
              {Object.entries(catalog.credentialTypes).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
            </select>
          </label>
          <label className="block text-xs font-semibold text-slate-700">Name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My GitHub token" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />
          </label>
          {spec.fields.map((field) => (
            <label key={field.name} className="block text-xs font-semibold text-slate-700">{field.label}
              {field.type === "keyValue"
                ? <textarea rows={3} value={values[field.name] ?? ""} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} placeholder="Header-Name: value (one per line)" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs" />
                : <input type={field.secret ? "password" : "text"} autoComplete="off" value={values[field.name] ?? ""} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} placeholder={field.placeholder} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" />}
            </label>
          ))}
          <button type="submit" disabled={!vault || !name.trim()} className="btn-primary !py-2 text-sm disabled:opacity-40"><KeyRound size={14} /> Save encrypted</button>
          {message && <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs ${message.tone === "error" ? "text-rose-700" : "text-emerald-700"}`}>{message.text}</p>}
        </form>
      </Card>
    </div>
  );
}

/** Server workflows: list, editor, runs and credentials. */
export default function WorkflowsHome({ deviceRoutines }: { deviceRoutines: React.ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [tab, setTab] = useState<Tab | "device">("workflows");
  const [editing, setEditing] = useState<string | null>(null);
  const [runsFor, setRunsFor] = useState<string | undefined>(undefined);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { WorkflowApi.catalog().then(setCatalog).catch((cause) => setError(cause instanceof Error ? cause.message : "Couldn't load the step catalog.")); }, []);

  if (editing && catalog) {
    return (
      <div className="mx-auto max-w-[1600px] px-2 pb-4 pt-3 sm:px-4">
        <Suspense fallback={<p className="p-6 text-sm text-slate-500" role="status">Loading the editor…</p>}>
          <WorkflowEditor workflowId={editing} catalog={catalog} onBack={() => setEditing(null)} onOpenExecution={() => {}} />
        </Suspense>
      </div>
    );
  }

  const tabs: Array<[Tab | "device", string]> = [["workflows", "Workflows"], ["runs", "Runs"], ["credentials", "Credentials"], ["device", "On this device"]];
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 pb-12 pt-5 sm:px-6 sm:pt-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display-title flex items-center gap-2 text-[clamp(1.6rem,3vw,2.3rem)]"><Bot size={26} className="text-violet-600" /> Automations</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">Visual workflows that run on HANNAH's server: on a schedule, from a webhook or a HANNAH event, with AI steps, conditions, integrations, approvals, retries and a full record of every run.</p>
        </div>
      </header>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Automation sections">
        {tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); if (key !== "runs") setRunsFor(undefined); }} className={`rounded-xl px-3 py-1.5 text-sm font-semibold ${tab === key ? "bg-ink text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}>{label}</button>)}
      </div>
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      {tab === "workflows" && <WorkflowList onOpen={setEditing} onRuns={(id) => { setRunsFor(id); setTab("runs"); }} />}
      {tab === "runs" && <RunsCenter workflowId={runsFor} openId={openRun} onOpen={setOpenRun} />}
      {tab === "credentials" && catalog && <CredentialsManager catalog={catalog} />}
      {tab === "device" && deviceRoutines}
    </div>
  );
}
