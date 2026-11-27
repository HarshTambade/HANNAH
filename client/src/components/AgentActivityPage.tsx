/**
 * Agent Activity — the work your teammates are doing, and the decisions it waits on.
 *
 * Approvals, tasks, multi-teammate plans, verification, hand-offs, proactive
 * suggestions, meeting notes and usage, all from the server's records through
 * `services/Workforce.ts`. Nothing here is computed in the browser: every
 * status is what the server stored, and every button does a server action.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, Check, ChevronDown, ChevronRight, ClipboardList, Laptop, Lightbulb, Pause, Play, Plus, RefreshCw, ShieldAlert, Users, Video, X } from "lucide-react";
import workforce, {
  shortDate, shortTime,
  type Approval, type Bot, type Meeting, type NotificationChannel, type NotificationItem, type NotificationSettings, type PolicyRule, type ProactiveOffer, type Task, type TaskDetail, type WorkforceUsage,
} from "../services/Workforce";
import { ACCOUNT_EVENT, isAccountSession } from "../services/api";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const danger = "inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const textarea = "w-full min-h-20 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";

const riskTones: Record<string, string> = {
  low: "border-slate-200 bg-slate-100 text-slate-700",
  medium: "border-amber-200 bg-amber-50 text-amber-900",
  high: "border-rose-200 bg-rose-50 text-rose-800",
  critical: "border-rose-300 bg-rose-100 text-rose-900",
};
const taskTones: Record<string, string> = {
  queued: "border-slate-200 bg-slate-100 text-slate-700",
  running: "border-blue-200 bg-blue-50 text-blue-800",
  "waiting-approval": "border-amber-200 bg-amber-50 text-amber-900",
  paused: "border-amber-200 bg-amber-50 text-amber-900",
  blocked: "border-rose-200 bg-rose-50 text-rose-800",
  failed: "border-rose-200 bg-rose-50 text-rose-800",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  cancelled: "border-slate-200 bg-slate-100 text-slate-500",
};
const statusLabel: Record<string, string> = { "waiting-approval": "waiting for approval" };
const FILTERS = ["open", "waiting-approval", "blocked", "completed", "all"] as const;
type Filter = (typeof FILTERS)[number];
const OPEN = new Set(["queued", "running", "waiting-approval", "paused", "blocked", "failed"]);

const Pill = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>;
const Notice = ({ tone = "slate", children }: { tone?: "slate" | "rose" | "amber" | "emerald"; children: ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`mt-2 rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={tone === "rose" ? "alert" : "status"}>{children}</p>;
};
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const when = (at: number | null | undefined) => (at ? `${shortDate(at)} ${shortTime(at)}` : "—");

type TaskResult = {
  summary?: string; findings?: string[]; unparsed?: boolean; model?: string; provider?: string;
  artifacts?: Array<{ id: string; name: string; type?: string; size?: number }>;
  nextSteps?: Array<{ action: string; title: string; reason?: string; risk?: string; refused?: boolean; hardware?: boolean; local?: boolean; params?: Record<string, unknown>; actionId?: string; actionStatus?: string; localJobId?: string; localStatus?: string }>;
  localRuns?: Array<{ jobId: string; kind: string; ok: boolean; device: string; error: string | null; artifact: { id: string; name: string } | null; at: number }>;
  verification?: { verdict: string; reviewerName: string; notes?: string; checks?: string[]; at: number };
  steps?: number; outcome?: string;
};

// ------------------------------------------------------------------ approvals

function ApprovalCard({ approval, botName, taskTitle, onDecided }: {
  approval: Approval; botName: string; taskTitle: string; onDecided: (note: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const payload = approval.payload || {};
  const inputs = payload.inputs === null || payload.inputs === undefined ? "" : JSON.stringify(payload.inputs, null, 2);
  // A saved rule can only make sense below high risk: high-risk actions always ask, whatever a rule says.
  const canRemember = approval.risk === "low" || approval.risk === "medium";

  const decide = async (decision: "allow" | "deny", remember = false) => {
    setBusy(true); setError("");
    try {
      const result = await workforce.approvalDecide(approval.id, decision, reason.trim() || undefined);
      if (remember) {
        const current = await workforce.policies();
        const rules: PolicyRule[] = [...current.rules.filter((rule) => rule.action !== approval.action), { action: approval.action, effect: "allow", note: `Saved from an approval on ${shortDate(Date.now())}` }];
        await workforce.policiesSet(rules);
      }
      await onDecided(decision === "allow"
        ? `Allowed "${approval.title}".${result.resume ? " The task is queued to continue." : ""}${remember ? ` ${approval.action} won't ask again for teammates allowed to act on their own.` : ""}`
        : `Denied "${approval.title}". Nothing was done.`);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  return (
    <li className={card} data-testid={`approval-${approval.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{approval.title}</p>
          <p className="text-xs text-slate-500"><code>{approval.action}</code> · {botName} · {taskTitle}</p>
        </div>
        <Pill tone={riskTones[approval.risk] || riskTones.medium}>{approval.risk} risk</Pill>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className={heading}>Target</dt><dd className="break-words text-slate-800">{approval.target || "—"}</dd></div>
        <div><dt className={heading}>Expected outcome</dt><dd className="text-slate-800">{payload.expected || "—"}</dd></div>
        <div><dt className={heading}>Reversible</dt><dd className="text-slate-800">{payload.reversible === true ? "Yes" : payload.reversible === false ? "No" : "Not stated"}</dd></div>
        <div><dt className={heading}>Data shared</dt><dd className="text-slate-800">{payload.dataShared?.length ? payload.dataShared.join(", ") : "None"}</dd></div>
        <div><dt className={heading}>Requested</dt><dd className="text-slate-800">{when(approval.requestedAt)}</dd></div>
        <div><dt className={heading}>Expires</dt><dd className="text-slate-800">{when(approval.expiresAt)}</dd></div>
      </dl>
      {inputs && (
        <details className="mt-2 text-sm"><summary className="cursor-pointer text-slate-600">Inputs</summary><pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-slate-50 p-2 text-xs text-slate-800">{inputs}</pre></details>
      )}
      <label className="mt-3 block"><span className={heading}>Note (optional)</span><input className={input} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why you decided this" /></label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void decide("allow")} data-testid={`approval-allow-${approval.id}`}><Check size={14} /> Allow once</button>
        <button type="button" className={danger} disabled={busy} onClick={() => void decide("deny")} data-testid={`approval-deny-${approval.id}`}><X size={14} /> Deny</button>
        {canRemember && <button type="button" className={button} disabled={busy} onClick={() => void decide("allow", true)} title={`Adds a rule that allows ${approval.action}. An organization rule can still deny it.`}>Allow and don't ask for {approval.action}</button>}
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
    </li>
  );
}

// ------------------------------------------------------------------ new work

function NewTaskForm({ bots, onCreated }: { bots: Bot[]; onCreated: (note: string, taskId: string) => Promise<void> }) {
  const [botId, setBotId] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [priority, setPriority] = useState("normal");
  const [runNow, setRunNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!botId && bots[0]) setBotId(bots[0].id); }, [bots, botId]);

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const { task } = await workforce.taskCreate({ botId, title: title.trim(), objective: objective.trim(), deliverable, acceptance, priority });
      let note = `Queued "${task.title}".`;
      if (runNow) {
        const ran = await workforce.taskRun(task.id);
        note = `"${task.title}" is ${statusLabel[ran.task.status] || ran.task.status}.${ran.note ? ` ${ran.note}` : ""}`;
      }
      setTitle(""); setObjective(""); setDeliverable(""); setAcceptance("");
      await onCreated(note, task.id);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  if (!bots.length) return <p className="text-sm text-slate-500">Create and activate a teammate in <a className="font-semibold underline" href="/bots">AI Workforce</a> first.</p>;
  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} data-testid="task-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className={heading}>Teammate</span>
          <select className={input} value={botId} onChange={(event) => setBotId(event.target.value)}>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} — {bot.role}{bot.status !== "active" ? ` (${bot.status})` : ""}</option>)}
          </select>
        </label>
        <label className="block"><span className={heading}>Priority</span>
          <select className={input} value={priority} onChange={(event) => setPriority(event.target.value)}>
            {["low", "normal", "high", "urgent"].map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </label>
        <label className="block sm:col-span-2"><span className={heading}>Title</span><input className={input} value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} /></label>
        <label className="block sm:col-span-2"><span className={heading}>What to do</span><textarea className={textarea} value={objective} onChange={(event) => setObjective(event.target.value)} required rows={3} /></label>
        <label className="block"><span className={heading}>Deliverable (optional)</span><input className={input} value={deliverable} onChange={(event) => setDeliverable(event.target.value)} placeholder="e.g. report.md" /></label>
        <label className="block"><span className={heading}>Done when (optional)</span><input className={input} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={runNow} onChange={(event) => setRunNow(event.target.checked)} /> Run it now (otherwise the server's worker picks it up)</label>
        <button type="submit" className={primary} disabled={busy || !title.trim() || !objective.trim() || !botId} data-testid="task-create"><Plus size={14} /> {busy ? "Working…" : "Give this task"}</button>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
    </form>
  );
}

type PlanStep = { botId: string; title: string; objective: string; afterPrevious: boolean };

function PlanForm({ bots, onCreated }: { bots: Bot[]; onCreated: (note: string) => Promise<void> }) {
  const blank = (): PlanStep => ({ botId: bots[0]?.id || "", title: "", objective: "", afterPrevious: false });
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (!steps.length && bots.length) setSteps([blank(), blank()]); }, [bots]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (index: number, patch: Partial<PlanStep>) => setSteps((list) => list.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const plan = await workforce.taskPlan({
        title: title.trim(), objective: objective.trim(),
        steps: steps.map((step, index) => ({ botId: step.botId, title: step.title.trim(), objective: step.objective.trim() || objective.trim(), dependsOn: step.afterPrevious && index > 0 ? [index - 1] : [] })),
      });
      setTitle(""); setObjective(""); setSteps([blank(), blank()]);
      await onCreated(`Plan "${plan.task.title}" created with ${plan.children.length} steps. Steps without a prerequisite can run in parallel.`);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  if (bots.length < 1) return null;
  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} data-testid="plan-form">
      <div className="grid gap-3">
        <label className="block"><span className={heading}>Plan title</span><input className={input} value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} /></label>
        <label className="block"><span className={heading}>Overall objective</span><textarea className={textarea} value={objective} onChange={(event) => setObjective(event.target.value)} required rows={2} /></label>
      </div>
      <ol className="mt-3 space-y-2">
        {steps.map((step, index) => (
          <li key={index} className="rounded-xl border border-slate-200 p-3">
            <div className="flex items-center justify-between gap-2"><span className={heading}>Step {index + 1}</span>
              {steps.length > 1 && <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100" onClick={() => setSteps((list) => list.filter((_, i) => i !== index))} aria-label={`Remove step ${index + 1}`}><X size={14} /></button>}
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <select className={input} value={step.botId} onChange={(event) => update(index, { botId: event.target.value })} aria-label={`Step ${index + 1} teammate`}>
                {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} — {bot.role}</option>)}
              </select>
              <input className={input} value={step.title} onChange={(event) => update(index, { title: event.target.value })} placeholder="Step title" aria-label={`Step ${index + 1} title`} />
              <textarea className={`${textarea} sm:col-span-2`} rows={2} value={step.objective} onChange={(event) => update(index, { objective: event.target.value })} placeholder="What this teammate does (defaults to the overall objective)" aria-label={`Step ${index + 1} objective`} />
            </div>
            {index > 0 && <label className="mt-2 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={step.afterPrevious} onChange={(event) => update(index, { afterPrevious: event.target.checked })} /> Starts after step {index} completes</label>}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap justify-between gap-2">
        <button type="button" className={button} disabled={steps.length >= 8} onClick={() => setSteps((list) => [...list, blank()])}><Plus size={14} /> Add step</button>
        <button type="submit" className={primary} disabled={busy || !title.trim() || !objective.trim() || !steps.length} data-testid="plan-create"><Users size={14} /> {busy ? "Creating…" : "Create plan"}</button>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
    </form>
  );
}

// ------------------------------------------------------------------ tasks

function TaskResultView({ result, taskId, onChanged }: { result: TaskResult; taskId: string; onChanged: (note: string, taskId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(-1);
  const [error, setError] = useState("");
  const send = async (index: number, how: "hardware" | "local") => {
    setBusy(index); setError("");
    try {
      if (how === "hardware") {
        const sent = await workforce.taskHardwareAction(taskId, index);
        await onChanged(sent.text, taskId);
      } else {
        const sent = await workforce.taskLocalJob(taskId, { index });
        await onChanged(sent.note, taskId);
      }
    } catch (e) { setError(message(e)); }
    finally { setBusy(-1); }
  };
  return (
    <div className="mt-3 space-y-2 text-sm">
      {result.summary && <div><span className={heading}>Result</span><p className="whitespace-pre-wrap text-slate-800">{result.summary}</p></div>}
      {result.unparsed && <Notice tone="amber">The teammate didn't answer in the expected format, so this is its raw text.</Notice>}
      {!!result.findings?.length && <div><span className={heading}>Findings</span><ul className="list-disc pl-5 text-slate-800">{result.findings.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {!!result.artifacts?.length && (
        <div><span className={heading}>Deliverables</span>
          <ul className="text-slate-800">{result.artifacts.map((item) => <li key={item.id}><a className="font-medium underline" href="/artifacts">{item.name}</a>{item.size ? <span className="text-xs text-slate-500"> · {Math.max(1, Math.round(item.size / 1024))} KB</span> : null}</li>)}</ul>
        </div>
      )}
      {!!result.nextSteps?.length && (
        <div><span className={heading}>Suggested next steps (not done)</span>
          <ul className="space-y-1">{result.nextSteps.map((step, index) => (
            <li key={index} className="text-slate-800">{step.title} <code className="text-xs text-slate-500">{step.action}</code> {step.risk && <Pill tone={riskTones[step.risk] || riskTones.medium}>{step.refused ? "not available" : step.risk}</Pill>}{step.reason ? <span className="block text-xs text-slate-500">{step.reason}</span> : null}
              {step.hardware && (step.actionId
                ? <span className="mt-1 block text-xs text-slate-600">Sent to the Action Engine: {step.actionStatus === "waiting-approval" ? <>waiting for your approval in <a className="underline" href="/actions">Actions</a></> : step.actionStatus}.</span>
                : <button type="button" className={`${button} mt-1`} disabled={busy !== -1} onClick={() => void send(index, "hardware")} data-testid={`send-hardware-${index}`}>Send for approval (robots and devices)</button>)}
              {step.local && step.action === "local.terminal" && <span className="mt-1 block text-xs text-slate-700">Command: <code className="rounded bg-slate-100 px-1">{String(step.params?.command ?? "")}</code> in the shared folder “{String(step.params?.folder ?? "")}”{step.params?.path ? `/${String(step.params.path)}` : ""}</span>}
              {step.local && step.action === "local.control" && <span className="mt-1 block text-xs text-slate-700">Uses your apps: {String(step.params?.request ?? "")}{Array.isArray(step.params?.plan) ? ` (${(step.params.plan as unknown[]).map(String).join(" → ")})` : ""}</span>}
              {step.local && (step.localJobId
                ? <span className="mt-1 block text-xs text-slate-600">Sent to your computer: {step.localStatus === "pending" ? "waiting for the desktop app to ask you" : step.localStatus}.</span>
                : <button type="button" className={`${button} mt-1`} disabled={busy !== -1} onClick={() => void send(index, "local")} data-testid={`send-local-${index}`}><Laptop size={13} /> Send to my computer</button>)}
            </li>
          ))}</ul>
          <p className="mt-1 text-xs text-slate-500">Nothing here runs by itself. A robot or device step goes to the Action Engine, which asks for approval and runs the safety checks; a step for your computer waits for the desktop app, which asks you before it runs.</p>
          {error && <Notice tone="rose">{error}</Notice>}
        </div>
      )}
      {!!result.localRuns?.length && (
        <div><span className={heading}>On your computer</span>
          <ul className="text-xs text-slate-700">{result.localRuns.map((run) => <li key={run.jobId}>{run.kind} on {run.device}: {run.ok ? "done" : `not done — ${run.error}`}{run.artifact ? <> · <a className="underline" href="/artifacts">{run.artifact.name}</a></> : null} · {when(run.at)}</li>)}</ul>
        </div>
      )}
      {result.verification && (
        <Notice tone={result.verification.verdict === "pass" ? "emerald" : "rose"}>
          Verified by {result.verification.reviewerName}: {result.verification.verdict}{result.verification.notes ? ` — ${result.verification.notes}` : ""} ({when(result.verification.at)})
        </Notice>
      )}
      {result.provider && <p className="text-xs text-slate-500">Answered by {result.provider}{result.model ? ` · ${result.model}` : ""}</p>}
    </div>
  );
}

function TaskRow({ task, bots, botName, onChanged }: { task: Task; bots: Bot[]; botName: (id: string | null) => string; onChanged: (note: string, taskId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [verdictNotes, setVerdictNotes] = useState("");
  const [handoffTo, setHandoffTo] = useState("");
  const others = bots.filter((bot) => bot.id !== task.botId);

  const load = useCallback(async () => { setDetail(await workforce.task(task.id)); }, [task.id]);
  useEffect(() => { if (open) void load().catch((e) => setError(message(e))); }, [open, load, task.updatedAt]);

  const act = async (label: string, action: () => Promise<string>) => {
    setBusy(label); setError("");
    try { const note = await action(); await onChanged(note, task.id); if (open) await load(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  };
  const setStatus = (status: string, label: string) => act(label, async () => { await workforce.taskSetStatus(task.id, status); return `"${task.title}" is ${statusLabel[status] || status}.`; });
  const result = (task.result || null) as TaskResult | null;

  return (
    <li className="rounded-xl border border-slate-200 bg-white" data-testid={`task-${task.id}`}>
      <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={16} className="shrink-0 text-slate-400" /> : <ChevronRight size={16} className="shrink-0 text-slate-400" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-900">{task.depth > 0 ? "↳ " : ""}{task.title}</span>
          <span className="block truncate text-xs text-slate-500">{task.botId ? botName(task.botId) : "Plan"} · updated {when(task.updatedAt)}{task.priority !== "normal" ? ` · ${task.priority}` : ""}</span>
        </span>
        <Pill tone={taskTones[task.status] || taskTones.queued}>{statusLabel[task.status] || task.status}</Pill>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 pb-3">
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{task.objective}</p>
          {task.error && <Notice tone={task.status === "blocked" || task.status === "failed" ? "rose" : "amber"}>{task.error}</Notice>}
          {result && <TaskResultView result={result} taskId={task.id} onChanged={onChanged} />}
          <div className="mt-3 flex flex-wrap gap-2">
            {task.botId && ["queued", "paused", "blocked", "failed"].includes(task.status) && (
              <button type="button" className={primary} disabled={!!busy} onClick={() => void act("run", async () => { const ran = await workforce.taskRun(task.id); return `"${task.title}" is ${statusLabel[ran.task.status] || ran.task.status}.${ran.note ? ` ${ran.note}` : ""}`; })}><Play size={14} /> {busy === "run" ? "Running…" : "Run now"}</button>
            )}
            {["queued", "waiting-approval"].includes(task.status) && <button type="button" className={button} disabled={!!busy} onClick={() => void setStatus("paused", "pause")}><Pause size={14} /> Pause</button>}
            {task.status === "paused" && <button type="button" className={button} disabled={!!busy} onClick={() => void setStatus("queued", "resume")}><Play size={14} /> Resume</button>}
            {OPEN.has(task.status) && task.status !== "running" && <button type="button" className={danger} disabled={!!busy} onClick={() => void setStatus("cancelled", "cancel")}><X size={14} /> Cancel</button>}
          </div>
          {task.status === "completed" && task.botId && others.length > 0 && !result?.verification && (
            <div className="mt-3 rounded-xl border border-slate-200 p-3">
              <span className={heading}>Verify with another teammate</span>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr]">
                <select className={input} value={reviewer} onChange={(event) => setReviewer(event.target.value)} aria-label="Reviewer">
                  <option value="">Choose a reviewer…</option>
                  {others.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
                <input className={input} value={verdictNotes} onChange={(event) => setVerdictNotes(event.target.value)} placeholder="What you checked" aria-label="Verification notes" />
              </div>
              <div className="mt-2 flex gap-2">
                {(["pass", "fail"] as const).map((verdict) => (
                  <button key={verdict} type="button" className={verdict === "pass" ? button : danger} disabled={!!busy || !reviewer}
                    onClick={() => void act("verify", async () => { await workforce.taskVerify(task.id, { reviewerBotId: reviewer, verdict, notes: verdictNotes }); return `Recorded a ${verdict} for "${task.title}".`; })}>
                    Record {verdict}
                  </button>
                ))}
              </div>
            </div>
          )}
          {OPEN.has(task.status) && task.status !== "running" && task.botId && others.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select className={`${input} max-w-xs`} value={handoffTo} onChange={(event) => setHandoffTo(event.target.value)} aria-label="Hand off to">
                <option value="">Hand off to…</option>
                {others.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </select>
              <button type="button" className={button} disabled={!!busy || !handoffTo} onClick={() => void act("handoff", async () => { await workforce.taskHandoff(task.id, { botId: handoffTo }); return `Handed "${task.title}" to ${botName(handoffTo)}.`; })}>Hand off</button>
            </div>
          )}
          {detail && (detail.children.length > 0 || detail.handoffs.length > 0 || detail.events.length > 0) && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {detail.children.length > 0 && (
                <div className="sm:col-span-2"><span className={heading}>Steps</span>
                  <ul className="mt-1 space-y-1">{detail.children.map((child) => <li key={child.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{child.title} <span className="text-xs text-slate-500">· {botName(child.botId)}{child.dependsOn.length ? " · after a prerequisite" : ""}</span></span><Pill tone={taskTones[child.status] || taskTones.queued}>{statusLabel[child.status] || child.status}</Pill></li>)}</ul>
                </div>
              )}
              {detail.handoffs.length > 0 && (
                <div><span className={heading}>Hand-offs</span>
                  <ul className="mt-1 space-y-1 text-xs text-slate-600">{detail.handoffs.map((item) => <li key={item.id}>{item.fromBotId ? botName(item.fromBotId) : "You"} → {botName(item.toBotId)} · {item.status} · {when(item.createdAt)}</li>)}</ul>
                </div>
              )}
              {detail.events.length > 0 && (
                <div><span className={heading}>Activity</span>
                  <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-xs text-slate-600">{detail.events.slice(0, 30).map((event) => <li key={event.id}>{event.kind} · {when(event.createdAt)}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          {error && <Notice tone="rose">{error}</Notice>}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ meetings

function MeetingsSection({ bots, meetings, onChanged }: { bots: Bot[]; meetings: Meeting[]; onChanged: (note: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [botId, setBotId] = useState("");
  const [consent, setConsent] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const act = async (label: string, action: () => Promise<string>) => {
    setBusy(label); setError("");
    try { await onChanged(await action()); } catch (e) { setError(message(e)); } finally { setBusy(""); }
  };

  return (
    <div>
      <p className="text-sm text-slate-600">HANNAH can't join or record a live meeting here: no meeting-platform credentials are configured. Add a meeting, record that the participants agreed, paste its transcript, and a teammate writes the notes and action items for you to review.</p>
      <form className="mt-3 grid gap-2 sm:grid-cols-[2fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); void act("create", async () => { await workforce.meetingCreate({ title: title.trim(), botId: botId || undefined, provider: "manual", consent: { transcript: consent, record: false } }); setTitle(""); setConsent(false); return "Meeting added. Paste its transcript when it ends."; }); }}>
        <input className={input} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Meeting title" aria-label="Meeting title" required />
        <select className={input} value={botId} onChange={(event) => setBotId(event.target.value)} aria-label="Notes by">
          <option value="">Notes by HANNAH</option>
          {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
        </select>
        <button type="submit" className={primary} disabled={!!busy || !title.trim()}><Plus size={14} /> Add</button>
        <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-3"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> Everyone in this meeting agreed that its transcript may be processed</label>
      </form>
      <ul className="mt-3 space-y-2">
        {meetings.slice(0, 10).map((meeting) => (
          <li key={meeting.id} className="rounded-xl border border-slate-200 p-3" data-testid={`meeting-${meeting.id}`}>
            <div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-900">{meeting.title}</p><Pill tone={taskTones.queued}>{meeting.status}</Pill></div>
            {meeting.consent?.transcript !== true && <Notice tone="amber">No consent recorded, so a transcript can't be added for this meeting.</Notice>}
            {meeting.consent?.transcript === true && !meeting.notes && (
              <div className="mt-2">
                <textarea className={textarea} rows={3} placeholder="Paste the transcript" aria-label={`Transcript for ${meeting.title}`} value={transcripts[meeting.id] ?? ""} onChange={(event) => setTranscripts((value) => ({ ...value, [meeting.id]: event.target.value }))} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={button} disabled={!!busy || (transcripts[meeting.id] ?? "").trim().length < 40} onClick={() => void act("transcript", async () => { await workforce.meetingTranscript(meeting.id, transcripts[meeting.id]); return "Transcript saved."; })}>Save transcript</button>
                  <button type="button" className={primary} disabled={!!busy || !meeting.hasTranscript} onClick={() => void act("summarize", async () => { await workforce.meetingSummarize(meeting.id); return `Notes written for "${meeting.title}". Review them before sharing.`; })}>{busy === "summarize" ? "Writing…" : "Write notes"}</button>
                </div>
              </div>
            )}
            {meeting.notes && (
              <div className="mt-2 space-y-2 text-sm">
                {meeting.notes.summary && <p className="text-slate-800">{meeting.notes.summary}</p>}
                {!!meeting.notes.decisions?.length && <div><span className={heading}>Decisions</span><ul className="list-disc pl-5">{meeting.notes.decisions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                {!!meeting.notes.risks?.length && <div><span className={heading}>Risks</span><ul className="list-disc pl-5">{meeting.notes.risks.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                {!!meeting.actions.length && (
                  <div><span className={heading}>Action items</span>
                    <ul className="mt-1 space-y-1">{meeting.actions.map((action) => (
                      <li key={action.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1">{action.title}{action.owner ? <span className="text-xs text-slate-500"> · {action.owner}</span> : null}{action.due ? <span className="text-xs text-slate-500"> · due {action.due}</span> : null}</span>
                        {action.accepted ? <Pill tone={taskTones.completed}>task created</Pill> : (
                          <>
                            <select className={`${input} w-auto`} value={owners[action.id] ?? meeting.botId ?? ""} onChange={(event) => setOwners((value) => ({ ...value, [action.id]: event.target.value }))} aria-label={`Teammate for ${action.title}`}>
                              <option value="">Teammate…</option>
                              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                            </select>
                            <button type="button" className={button} disabled={!!busy || !(owners[action.id] ?? meeting.botId)} onClick={() => void act("accept", async () => { const made = await workforce.meetingAcceptAction(meeting.id, action.id, owners[action.id] ?? meeting.botId ?? undefined); return `Task created: "${made.task.title}".`; })}>Make a task</button>
                          </>
                        )}
                      </li>
                    ))}</ul>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
        {!meetings.length && <li className="text-sm text-slate-500">No meetings yet.</li>}
      </ul>
      {error && <Notice tone="rose">{error}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ notifications

const CATEGORY_LABEL: Record<string, string> = { approvals: "Approvals waiting for you", completions: "Finished tasks", failures: "Blocked or failed work" };
const DELIVERY_LABEL: Record<string, string> = { sent: "sent", failed: "failed", "held-quiet-hours": "held for quiet hours", muted: "muted by the teammate" };

function NotificationsSection({ bots, onChanged }: { bots: Bot[]; onChanged: (note: string) => Promise<void> }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [feed, setFeed] = useState<NotificationItem[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [view, recent] = await Promise.all([workforce.notificationSettings(), workforce.notifications()]);
    setSettings(view.settings); setChannels(view.channels); setFeed(recent.notifications.slice(0, 15));
  }, []);
  useEffect(() => { void load().catch((e) => setError(message(e))); const timer = setInterval(() => void load().catch(() => undefined), 15_000); return () => clearInterval(timer); }, [load]);
  const save = async (next: Partial<NotificationSettings>) => {
    setError("");
    const before = settings;
    // Show the change at once; the server's answer replaces it, or it's undone with the reason.
    if (before) setSettings({ ...before, ...next });
    try { const result = await workforce.notificationSettingsSet(next); setSettings(result.settings); await onChanged("Notification settings saved."); }
    catch (e) { setSettings(before); setError(message(e)); }
  };
  const channelName = (target: string) => { const id = target.replace(/^channel:/, ""); return channels.find((item) => item.id === id)?.name || (target === "webhooks" ? "webhooks" : target); };
  if (!settings) return <p className="text-sm text-slate-500">{error || "Loading…"}</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset className="space-y-1"><legend className={heading}>Tell me about</legend>
          {(Object.keys(CATEGORY_LABEL) as Array<keyof NotificationSettings["categories"]>).map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={settings.categories[key]} onChange={(event) => void save({ categories: { ...settings.categories, [key]: event.target.checked } })} /> {CATEGORY_LABEL[key]}</label>
          ))}
        </fieldset>
        <fieldset className="space-y-1"><legend className={heading}>Where</legend>
          <p className="text-sm text-slate-700">Always here, in Agent Activity.</p>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={settings.webhooks} onChange={(event) => void save({ webhooks: event.target.checked })} /> Account webhooks (Settings → Account)</label>
          <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={settings.quietHours} onChange={(event) => void save({ quietHours: event.target.checked })} /> Hold chat and webhook messages during quiet hours</label>
        </fieldset>
      </div>
      <div>
        <span className={heading}>Chat apps</span>
        {channels.length ? (
          <ul className="mt-1 space-y-2">{channels.map((channel) => (
            <li key={channel.id} className="rounded-xl border border-slate-200 p-3 text-sm" data-testid={`channel-${channel.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">{channel.name} <span className="text-xs font-normal text-slate-500">· {channel.kind}{channel.paired ? ` · paired with ${channel.pairedName || "you"}` : " · not paired yet"}</span></span>
                {channel.canNotify && channel.reachable && <button type="button" className={button} onClick={() => void workforce.notificationTest(channel.id).then(() => onChanged(`Test sent to ${channel.name}.`)).catch((e) => setError(message(e)))}>Send a test</button>}
              </div>
              {channel.canNotify ? (
                <label className="mt-2 flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" disabled={!channel.reachable} checked={settings.channelIds.includes(channel.id)} onChange={(event) => void save({ channelIds: event.target.checked ? [...settings.channelIds, channel.id] : settings.channelIds.filter((item) => item !== channel.id) })} /> Send notifications here{!channel.reachable ? " (write to the bot once from your paired chat first)" : ""}</label>
              ) : <p className="mt-2 text-xs text-slate-500">{channel.kind} can't take messages HANNAH starts, so it can't carry notifications.</p>}
              <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-700">Your messages here go to
                <select className={`${input} w-auto`} value={channel.teammateId || ""} onChange={(event) => void workforce.channelTeammate(channel.id, event.target.value || null).then((result) => onChanged(result.note)).then(load).catch((e) => setError(message(e)))} aria-label={`Teammate for ${channel.name}`}>
                  <option value="">HANNAH</option>
                  {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </label>
              {channel.teammateId && <p className="mt-1 text-xs text-slate-500">Reply “queue” to queue a task it proposes, “approve apv_…” or “deny apv_…” to answer an approval it sent, or “status”. Anyone else you approved there still talks to HANNAH, never to this teammate.</p>}
            </li>
          ))}</ul>
        ) : <p className="mt-1 text-sm text-slate-500">No chat apps yet. Connect Slack, Microsoft Teams, Telegram or WhatsApp in <a className="underline" href="/marketplace">Marketplace → Chat apps</a> and pair your own chat.</p>}
      </div>
      <div>
        <span className={heading}>Recent</span>
        <ul className="mt-1 space-y-1.5">{feed.map((item) => (
          <li key={item.id} className="text-sm text-slate-700">
            <span className="whitespace-pre-line">{item.text.split("\n")[0]}</span> <span className="text-xs text-slate-500">· {when(item.createdAt)}</span>
            {!!item.deliveries.length && <span className="block text-xs text-slate-500">{item.deliveries.map((delivery) => `${channelName(delivery.target)}: ${DELIVERY_LABEL[delivery.status] || delivery.status}${delivery.status === "failed" && delivery.detail?.reason ? ` (${String(delivery.detail.reason)})` : ""}`).join(" · ")}</span>}
          </li>
        ))}{!feed.length && <li className="text-sm text-slate-500">Nothing yet.</li>}</ul>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ page

const OFFER_TARGET: Record<string, string> = { tasks: "#tasks", approvals: "#approvals", meetings: "#meetings", routines: "/routines", memory: "/bots" };

export default function AgentActivityPage() {
  const [signedIn, setSignedIn] = useState(isAccountSession);
  const [bots, setBots] = useState<Bot[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [recent, setRecent] = useState<Approval[]>([]);
  const [offers, setOffers] = useState<ProactiveOffer[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [usage, setUsage] = useState<WorkforceUsage | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [mode, setMode] = useState<"task" | "plan">("task");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Tasks the person acted on stay listed for this visit, so a run that completes doesn't vanish from the "open" view.
  const [kept, setKept] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const sync = () => setSignedIn(isAccountSession());
    window.addEventListener(ACCOUNT_EVENT, sync);
    return () => window.removeEventListener(ACCOUNT_EVENT, sync);
  }, []);

  const refresh = useCallback(async () => {
    const [b, t, a, all, p, m, u] = await Promise.all([
      workforce.bots(), workforce.tasks(), workforce.approvals("pending"), workforce.approvals("all"),
      workforce.proactive().catch(() => null), workforce.meetings().catch(() => ({ meetings: [] as Meeting[] })), workforce.usage().catch(() => null),
    ]);
    setBots(b.bots); setTasks(t.tasks); setApprovals(a.approvals.filter((item) => item.status === "pending"));
    setRecent(all.approvals.filter((item) => item.status !== "pending").slice(0, 8));
    setOffers(p?.offers.filter((offer) => offer.status === "pending") ?? []); setMeetings(m.meetings); setUsage(u);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void refresh().catch((e) => setError(message(e)));
    const timer = setInterval(() => void refresh().catch(() => undefined), 8_000);
    return () => clearInterval(timer);
  }, [refresh, signedIn]);

  // Open the section a link pointed at (#approvals, #tasks, #meetings) once its data is on screen.
  useEffect(() => { if (loaded && window.location.hash.length > 1) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" }); }, [loaded]);

  const done = useCallback(async (text: string) => { setNote(text); setError(""); await refresh().catch((e) => setError(message(e))); }, [refresh]);
  const names = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const botName = useCallback((id: string | null) => (id ? names.get(id) || "A teammate that's no longer available" : "—"), [names]);
  const titles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const shown = tasks.filter((task) => filter === "all" || kept.has(task.id) || (filter === "open" ? OPEN.has(task.status) : task.status === filter));
  const taskChanged = useCallback(async (text: string, taskId: string) => { setKept((current) => new Set(current).add(taskId)); await done(text); }, [done]);
  const counts = tasks.reduce<Record<string, number>>((acc, task) => { acc[task.status] = (acc[task.status] || 0) + 1; return acc; }, {});
  const workers = bots.filter((bot) => bot.status !== "archived");

  if (!signedIn) {
    return (
      <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="activity-page">
        <h1 className="display-title text-[clamp(2rem,5vw,3rem)]">Agent Activity</h1>
        <Notice tone="amber">Agent Activity needs a signed-in HANNAH account. <a className="font-semibold underline" href="/settings">Open Settings → Account</a></Notice>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="activity-page">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2rem,5vw,3rem)]">Agent Activity</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">What your teammates are working on, what's waiting for you, and what they produced. Work runs on the server, so it carries on when this page is closed. Talk with a teammate from <a className="font-semibold text-slate-900 underline" href="/bots">AI Workforce</a>.</p>
        </div>
        <button type="button" className={button} onClick={() => void refresh().then(() => setNote("Refreshed.")).catch((e) => setError(message(e)))}><RefreshCw size={14} /> Refresh</button>
      </div>
      {note && <Notice tone="emerald">{note}</Notice>}
      {error && <Notice tone="rose">{error}</Notice>}

      <section id="approvals" className="mt-5" aria-label="Waiting for your approval">
        <div className="mb-2 flex items-center gap-2"><ShieldAlert size={16} className="text-amber-600" /><h2 className={heading}>Waiting for your approval ({approvals.length})</h2></div>
        {approvals.length ? (
          <ul className="grid gap-3 lg:grid-cols-2">{approvals.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} botName={botName(approval.botId)} taskTitle={approval.taskId ? titles.get(approval.taskId) || "a task" : "no task"} onDecided={done} />
          ))}</ul>
        ) : <p className="text-sm text-slate-500">Nothing is waiting for you. High-risk actions always stop here before they run.</p>}
        {recent.length > 0 && (
          <details className="mt-2 text-sm"><summary className="cursor-pointer text-slate-600">Recent decisions</summary>
            <ul className="mt-1 space-y-1">{recent.map((item) => <li key={item.id} className="text-xs text-slate-600">{item.status} · {item.title} · <code>{item.action}</code> · {when(item.decidedAt || item.requestedAt)}{item.reason ? ` · “${item.reason}”` : ""}</li>)}</ul>
          </details>
        )}
      </section>

      <section className={`${card} mt-6`} aria-label="Give work">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><ClipboardList size={16} /><h2 className="text-base font-semibold text-ink">Give work</h2></div>
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-sm" role="tablist" aria-label="Kind of work">
            {(["task", "plan"] as const).map((value) => (
              <button key={value} type="button" role="tab" aria-selected={mode === value} onClick={() => setMode(value)} className={`rounded-md px-3 py-1 ${mode === value ? "bg-slate-900 text-white" : "text-slate-600"}`}>{value === "task" ? "One teammate" : "Several teammates"}</button>
            ))}
          </div>
        </div>
        {mode === "task" ? <NewTaskForm bots={workers} onCreated={taskChanged} /> : <PlanForm bots={workers} onCreated={done} />}
      </section>

      <section id="tasks" className="mt-6" aria-label="Tasks">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className={heading}>Tasks</h2>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((value) => {
              const count = value === "all" ? tasks.length : value === "open" ? tasks.filter((task) => OPEN.has(task.status)).length : counts[value] || 0;
              return <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}>{statusLabel[value] || value} ({count})</button>;
            })}
          </div>
        </div>
        {shown.length ? <ul className="space-y-2">{shown.map((task) => <TaskRow key={task.id} task={task} bots={workers} botName={botName} onChanged={taskChanged} />)}</ul>
          : <p className="text-sm text-slate-500">{loaded ? "No tasks here." : "Loading…"}</p>}
      </section>

      <section className="mt-6" aria-label="Suggestions">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Lightbulb size={16} className="text-amber-500" /><h2 className={heading}>Suggestions ({offers.length})</h2></div>
          <button type="button" className={button} onClick={() => void workforce.proactiveScan(true).then(() => done("Checked your teammates' records for anything that needs attention.")).catch((e) => setError(message(e)))}>Check now</button>
        </div>
        <p className="mb-2 text-xs text-slate-500">Suggestions come from your own records (overdue work, waiting approvals, failing routines). They only offer; nothing is done until you choose.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {offers.map((offer) => (
            <li key={offer.id} className={card}>
              <p className="text-sm font-semibold text-slate-900">{offer.title}</p>
              <p className="mt-1 text-sm text-slate-600">{offer.body}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" className={primary} onClick={() => void workforce.proactiveAct(offer.id).then((r) => { const target = OFFER_TARGET[r.open.screen]; if (target?.startsWith("#")) { window.location.hash = target; document.getElementById(target.slice(1))?.scrollIntoView({ block: "start" }); void done("Opened."); } else if (target) window.location.assign(target); else void done("Accepted."); }).catch((e) => setError(message(e)))}>Open</button>
                <button type="button" className={button} onClick={() => void workforce.proactiveDismiss(offer.id).then(() => done("Dismissed.")).catch((e) => setError(message(e)))}>Dismiss</button>
              </div>
            </li>
          ))}
          {!offers.length && <li className="text-sm text-slate-500">No suggestions right now.</li>}
        </ul>
      </section>

      <section id="meetings" className={`${card} mt-6`} aria-label="Meetings">
        <div className="mb-2 flex items-center gap-2"><Video size={16} /><h2 className="text-base font-semibold text-ink">Meeting notes</h2></div>
        <MeetingsSection bots={workers} meetings={meetings} onChanged={done} />
      </section>

      <section id="notifications" className={`${card} mt-6`} aria-label="Notifications">
        <div className="mb-2 flex items-center gap-2"><Bell size={16} /><h2 className="text-base font-semibold text-ink">Notifications</h2></div>
        <NotificationsSection bots={workers} onChanged={done} />
      </section>

      {usage && (
        <section className="mt-6" aria-label="Usage">
          <h2 className={heading}>Usage in the last 24 hours</h2>
          <p className="mt-1 text-xs text-slate-500">Each teammate has its own daily limits (set them in its configuration), and your account has a ceiling no teammate can exceed. Clearing a conversation doesn't reset its count.</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead><tr className="text-xs text-slate-500"><th className="py-1 pr-3 font-medium">Teammate</th><th className="py-1 pr-3 font-medium">Tasks</th><th className="py-1 font-medium">Messages</th></tr></thead>
              <tbody>
                <tr className="border-t border-slate-100 font-semibold"><td className="py-1.5 pr-3">Whole account</td><td className="py-1.5 pr-3">{usage.account.tasks.used} / {usage.account.tasks.limit}</td><td className="py-1.5">{usage.account.messages.used} / {usage.account.messages.limit}</td></tr>
                {usage.bots.map((row) => (
                  <tr key={row.botId} className="border-t border-slate-100"><td className="py-1.5 pr-3">{row.name}</td><td className={`py-1.5 pr-3 ${row.tasks.used >= row.tasks.limit ? "text-rose-700" : ""}`}>{row.tasks.used} / {row.tasks.limit}</td><td className={`py-1.5 ${row.messages.used >= row.messages.limit ? "text-rose-700" : ""}`}>{row.messages.used} / {row.messages.limit}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
