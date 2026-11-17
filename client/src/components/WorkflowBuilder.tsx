import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bot, Check, Clock3, MonitorSmartphone, Pencil, Play, Plus, ShieldCheck, Sparkles, Square, Trash2, Wrench, X } from "lucide-react";
import { TaskSpineService } from "../services/TaskSpineService";
import {
  AUTOMATION_EVENT, AutomationService, describeSchedule, nextRunAt, workflowSchedule,
  type AutomationRun, type OutputChannel, type Schedule, type ToolAction,
} from "../services/AutomationService";
import {
  ALL_DAYS, WEEKDAYS, TEMPLATES, blankDraft, draftFromWorkflow, draftProblem, newStep, outputLabels, toolLabels, workflowFromDraft,
  type Draft, type DraftStep, type StepKind,
} from "../services/AutomationDraft";
import { notificationPermission, requestNotificationPermission } from "../services/ReminderService";
import { syncNow } from "../services/AccountSync";
import { TaskRecords } from "../services/TaskRecords";
import type { WorkflowSchema } from "../services/WorkflowSchema";

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fieldClass = "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-ink outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100";

const stepInfo: Record<StepKind, { label: string; hint: string; tone: string; Icon: typeof Clock3 }> = {
  "agent-task": { label: "Ask HANNAH", hint: "Your AI does a task. It gets the previous step's result.", tone: "border-violet-200 bg-violet-50 text-violet-900", Icon: Sparkles },
  "tool-action": { label: "Action", hint: "Changes your data, so it waits for your approval.", tone: "border-sky-200 bg-sky-50 text-sky-900", Icon: Wrench },
  output: { label: "Output", hint: "How you get the result.", tone: "border-emerald-200 bg-emerald-50 text-emerald-900", Icon: Bot },
};

const statusStyle: Record<AutomationRun["status"], string> = {
  running: "bg-sky-50 text-sky-800 border-sky-200",
  "waiting-approval": "bg-amber-50 text-amber-900 border-amber-200",
  done: "bg-emerald-50 text-emerald-800 border-emerald-200",
  denied: "bg-slate-100 text-slate-700 border-slate-200",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
  cancelled: "bg-slate-100 text-slate-700 border-slate-200",
};
const statusLabel: Record<AutomationRun["status"], string> = { running: "Running", "waiting-approval": "Needs approval", done: "Done", denied: "Denied", failed: "Failed", cancelled: "Cancelled" };
const triggerLabel: Record<AutomationRun["trigger"], string> = { manual: "Run by you", schedule: "On schedule", "catch-up": "Missed run, caught up" };
const stepStatusLabel: Record<string, string> = { pending: "Not run", running: "Running", "waiting-approval": "Waiting for approval", done: "Done", denied: "Denied", failed: "Failed", skipped: "Skipped" };

function formatTime(value: number | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function Section({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  return (
    <section className="bento-card" aria-label={label ?? title}>
      <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (schedule: Schedule) => void }) {
  const days = schedule.type === "daily" ? schedule.days : ALL_DAYS;
  const toggleDay = (day: number) => {
    if (schedule.type !== "daily") return;
    const next = days.includes(day) ? days.filter((item) => item !== day) : [...days, day].sort();
    onChange({ ...schedule, days: next });
  };
  const next = nextRunAt(schedule, Date.now());
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,10rem)]">
        <label className="text-xs font-semibold text-slate-700">Runs
          <select className={fieldClass} value={schedule.type} onChange={(event) => {
            const value = event.target.value;
            if (value === "manual") onChange({ type: "manual" });
            else if (value === "interval") onChange({ type: "interval", hours: schedule.type === "interval" ? schedule.hours : 2 });
            else onChange({ type: "daily", time: schedule.type === "daily" ? schedule.time : "08:00", days: schedule.type === "daily" ? schedule.days : WEEKDAYS });
          }}>
            <option value="daily">On days and a time</option>
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
            <input type="number" min={1} max={168} className={fieldClass} value={schedule.hours} onChange={(event) => onChange({ type: "interval", hours: Math.min(168, Math.max(1, Math.round(Number(event.target.value) || 1))) })} />
          </label>
        )}
      </div>
      {schedule.type === "daily" && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
          {DAY_LETTERS.map((letter, day) => (
            <button
              key={day}
              type="button"
              aria-pressed={days.includes(day)}
              aria-label={DAY_NAMES[day]}
              onClick={() => toggleDay(day)}
              className={`h-9 w-9 rounded-full border text-xs font-semibold transition ${days.includes(day) ? "border-violet-600 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-violet-300"}`}
            >{letter}</button>
          ))}
          <span className="mx-1 hidden h-5 w-px bg-slate-200 sm:block" aria-hidden="true" />
          <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => onChange({ ...schedule, days: ALL_DAYS })}>Every day</button>
          <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => onChange({ ...schedule, days: WEEKDAYS })}>Weekdays</button>
        </div>
      )}
      <p className="text-xs text-slate-600">
        {schedule.type === "manual" ? "Runs only when you press Run now." : next ? `${describeSchedule(schedule)}. Next: ${formatTime(next)}.` : "Pick at least one day."}
      </p>
    </div>
  );
}

function StepEditor({ step, index, count, onChange, onMove, onRemove }: {
  step: DraftStep; index: number; count: number;
  onChange: (step: DraftStep) => void; onMove: (delta: -1 | 1) => void; onRemove: () => void;
}) {
  const info = stepInfo[step.kind];
  const Icon = info.Icon;
  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-4" aria-label={`Step ${index + 1}: ${info.label}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${info.tone}`}><Icon size={16} /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{index + 1}. {info.label}</p>
            <p className="text-xs text-slate-600">{info.hint}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" className="btn-ghost !p-2" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move step ${index + 1} up`}><ArrowUp size={14} /></button>
          <button type="button" className="btn-ghost !p-2" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move step ${index + 1} down`}><ArrowDown size={14} /></button>
          <button type="button" className="btn-ghost !p-2 text-rose-700" onClick={onRemove} aria-label={`Remove step ${index + 1}`}><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="mt-3">
        {step.kind === "agent-task" && (
          <label className="block text-xs font-semibold text-slate-700">What should HANNAH do?
            <textarea rows={3} maxLength={1500} className={fieldClass} placeholder="For example: Plan my day in three short bullet points." value={step.task} onChange={(event) => onChange({ ...step, task: event.target.value })} />
          </label>
        )}
        {step.kind === "tool-action" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-700">Action
              <select className={fieldClass} value={step.action} onChange={(event) => onChange({ ...step, action: event.target.value as ToolAction })}>
                {Object.entries(toolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {step.action === "create-reminder" && (
              <label className="text-xs font-semibold text-slate-700">Remind me after (minutes)
                <input type="number" min={1} max={10080} className={fieldClass} value={step.minutes} onChange={(event) => onChange({ ...step, minutes: Math.min(10080, Math.max(1, Math.round(Number(event.target.value) || 1))) })} />
              </label>
            )}
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800 sm:col-span-2"><ShieldCheck size={13} /> The run pauses here until you approve or deny it.</p>
          </div>
        )}
        {step.kind === "output" && (
          <label className="block text-xs font-semibold text-slate-700 sm:max-w-sm">Deliver the result by
            <select className={fieldClass} value={step.channel} onChange={(event) => onChange({ ...step, channel: event.target.value as OutputChannel })}>
              {Object.entries(outputLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
      </div>
    </li>
  );
}

export default function WorkflowBuilder() {
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const [isExisting, setIsExisting] = useState(false);
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const editorRef = useRef<HTMLElement>(null);

  // Re-read saved automations, schedules and runs whenever any of them change.
  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1);
    window.addEventListener(AUTOMATION_EVENT, refresh);
    // Runs from your other signed-in devices, and which device is working on each.
    const syncRemote = () => { if (document.visibilityState === "visible") void AutomationService.syncFromAccount().then(refresh); };
    syncRemote();
    const remoteTimer = window.setInterval(syncRemote, 8000);
    return () => {
      window.removeEventListener(AUTOMATION_EVENT, refresh);
      window.clearInterval(remoteTimer);
    };
  }, []);
  /** Signed in: send a saved automation or schedule change to the account now, so other devices get it. */
  const shareWithDevices = () => { if (TaskRecords.enabled()) void syncNow(); };
  const saved = useMemo(() => AutomationService.workflows(), [version]);
  const runs = useMemo(() => AutomationService.runs(), [version]);
  const pending = runs.filter((run) => run.status === "waiting-approval");
  const dirty = draft !== null && JSON.stringify(draft) !== savedDraft;

  const open = (next: Draft, existing: boolean, message = "") => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    setDraft(next);
    setSavedDraft(existing ? JSON.stringify(next) : "");
    setIsExisting(existing);
    setProblem("");
    setNotice(message);
    window.setTimeout(() => editorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 30);
  };

  const close = () => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    setDraft(null);
    setProblem("");
  };

  const update = (change: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...change } : current));
  const updateStep = (index: number, step: DraftStep) => setDraft((current) => (current ? { ...current, steps: current.steps.map((item, at) => (at === index ? step : item)) } : current));
  const moveStep = (index: number, delta: -1 | 1) => setDraft((current) => {
    if (!current) return current;
    const steps = [...current.steps];
    const target = index + delta;
    if (target < 0 || target >= steps.length) return current;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    return { ...current, steps };
  });
  const removeStep = (index: number) => setDraft((current) => (current ? { ...current, steps: current.steps.filter((_, at) => at !== index) } : current));
  const addStep = (kind: StepKind) => setDraft((current) => (current ? { ...current, steps: [...current.steps, newStep(kind)] } : current));

  function save(): WorkflowSchema | null {
    if (!draft) return null;
    const issue = draftProblem(draft);
    if (issue) { setProblem(issue); return null; }
    const workflow = workflowFromDraft(draft);
    const isNew = !saved.some((item) => item.id === workflow.id);
    TaskSpineService.createWorkflow(workflow);
    const schedule = workflowSchedule(workflow);
    // A new scheduled automation starts on its schedule; "Run on schedule" turns it off.
    if (isNew && schedule.type !== "manual" && notificationPermission() === "default") void requestNotificationPermission();
    const state = isNew && schedule.type !== "manual" ? AutomationService.setEnabled(workflow, true) : AutomationService.reschedule(workflow);
    window.dispatchEvent(new Event(AUTOMATION_EVENT));
    shareWithDevices();
    setProblem("");
    setDraft(null);
    setNotice(schedule.type === "manual"
      ? `Saved “${workflow.name}”. It runs when you press Run now.`
      : state.enabled ? `Saved “${workflow.name}”. Next run: ${formatTime(state.nextRunAt)}.` : `Saved “${workflow.name}”. Its schedule is off; turn on “Run on schedule” to start it.`);
    return workflow;
  }

  async function runNow(workflow: WorkflowSchema) {
    setBusy(workflow.id);
    try {
      const run = await AutomationService.run(workflow, "manual");
      setNotice(run.status === "done" ? `“${workflow.name}” finished.` : run.status === "waiting-approval" ? `“${workflow.name}” is waiting for your approval above.` : `“${workflow.name}” stopped: ${run.error}`);
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
    shareWithDevices();
  }

  async function continueHere(run: AutomationRun) {
    setBusy(run.id);
    try {
      const result = await AutomationService.continueRun(run.id);
      setNotice(result.status === "done" ? `“${run.name}” finished.` : result.status === "waiting-approval" ? `“${run.name}” is waiting for your approval above.` : `“${run.name}” stopped: ${result.error}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancelElsewhere(run: AutomationRun) {
    if (!window.confirm(`Cancel “${run.name}” on ${run.runningOn ?? "your other device"}? It stops before its next step.`)) return;
    setBusy(run.id);
    try {
      await AutomationService.cancelElsewhere(run.id);
      setNotice(`Cancelled. ${run.runningOn ?? "The other device"} stops before its next step.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function remove(workflow: WorkflowSchema) {
    TaskSpineService.remove(workflow.id);
    AutomationService.forget(workflow.id);
    if (draft?.id === workflow.id) setDraft(null);
    setConfirmDelete(null);
    setNotice(`Deleted “${workflow.name}”. Its run history stays below.`);
  }

  function edit(workflow: WorkflowSchema) {
    const { draft: next, unconnected } = draftFromWorkflow(workflow);
    open(next, true, unconnected
      ? `${unconnected} step${unconnected === 1 ? " wasn't" : "s weren't"} connected in this automation and never ran, so ${unconnected === 1 ? "it isn't" : "they aren't"} shown. Save to keep it this way.`
      : "");
  }

  return (
    <main className="relative z-10 mx-auto flex max-w-5xl flex-col gap-4 px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Automations</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Routines that run on a schedule while HANNAH is open in a tab or the desktop app. If one was due while HANNAH was closed, it runs once when you come back{TaskRecords.enabled() ? ", or on whichever of your signed-in devices is open; each run is saved to your account, so you can approve, continue or cancel it from any of them" : ""}. Actions always wait for your approval.</p>
        </div>
        {!draft && <button type="button" className="btn-primary" onClick={() => open(blankDraft(), false)}><Plus size={15} /> New automation</button>}
      </header>

      {pending.length > 0 && (
        <section aria-label="Waiting for your approval" className="space-y-2">
          {pending.map((run) => {
            const step = run.steps.find((item) => item.status === "waiting-approval");
            return (
              <div key={run.id} className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-950"><ShieldCheck size={15} /> {run.name} wants to: {step?.label}</p>
                  {step?.output && <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[13px] leading-5 text-amber-950/80">{step.output}</p>}
                  {run.runningOn && <p className="mt-1 flex items-center gap-1 text-xs text-amber-900"><MonitorSmartphone size={12} /> Running on {run.runningOn}. Your answer is sent there.</p>}
                  {!run.runningOn && run.durable && run.lastDevice && !AutomationService.isLive(run.id) && <p className="mt-1 flex items-center gap-1 text-xs text-amber-900"><MonitorSmartphone size={12} /> Started on {run.lastDevice}. Answering here continues it on this device.</p>}
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

      {notice && <p role="status" className="rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-950">{notice}</p>}

      {draft && (
        <section ref={editorRef} aria-label={isExisting ? "Edit automation" : "New automation"} className="scroll-mt-24 rounded-[1.75rem] border border-violet-200 bg-white/95 p-4 shadow-soft-lg sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-ink">{isExisting ? "Edit automation" : "New automation"}</h2>
            <button type="button" className="btn-ghost !p-2" onClick={close} aria-label="Close the editor"><X size={16} /></button>
          </div>

          <label className="mt-3 block text-xs font-semibold text-slate-700 sm:max-w-md">Name
            <input className={fieldClass} value={draft.name} maxLength={80} placeholder="For example: Morning plan" onChange={(event) => update({ name: event.target.value })} />
          </label>

          <div className="mt-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink"><span className="grid h-7 w-7 place-items-center rounded-lg border border-amber-200 bg-amber-50 text-amber-800"><Clock3 size={14} /></span> When it runs</p>
            <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
              <ScheduleEditor schedule={draft.schedule} onChange={(schedule) => update({ schedule })} />
            </div>
          </div>

          <div className="mt-5">
            <p className="text-sm font-semibold text-ink">Then, in order</p>
            <p className="text-xs text-slate-600">Each step gets the result of the one before it.</p>
            {draft.steps.length === 0 ? (
              <p className="mt-2 rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600">No steps yet. Add one below.</p>
            ) : (
              <ol className="mt-2 space-y-2" aria-label="Steps">
                {draft.steps.map((step, index) => (
                  <StepEditor key={step.id} step={step} index={index} count={draft.steps.length} onChange={(next) => updateStep(index, next)} onMove={(delta) => moveStep(index, delta)} onRemove={() => removeStep(index)} />
                ))}
              </ol>
            )}
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Add a step">
              {(Object.keys(stepInfo) as StepKind[]).map((kind) => {
                const { label, Icon, tone } = stepInfo[kind];
                return <button key={kind} type="button" onClick={() => addStep(kind)} className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition hover:shadow-sm ${tone}`}><Plus size={13} /><Icon size={14} /> {label}</button>;
              })}
            </div>
          </div>

          {problem && <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{problem}</p>}
          <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
            <button type="button" className="btn-ghost" onClick={close}>Cancel</button>
            <button type="button" className="btn-outline" disabled={busy !== null} onClick={() => { const workflow = save(); if (workflow) void runNow(workflow); }}><Play size={15} /> Save and run</button>
            <button type="button" className="btn-primary" onClick={() => save()}><Check size={15} /> Save</button>
          </div>
        </section>
      )}

      <Section title="Your automations">
        {saved.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Nothing saved yet. Start from a template below, or press New automation.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100" aria-label="Saved automations">
            {saved.map((workflow) => {
              const schedule = workflowSchedule(workflow);
              const state = AutomationService.state(workflow.id);
              const last = AutomationService.runs(workflow.id)[0];
              const steps = workflow.nodes.filter((node) => node.kind !== "trigger").length;
              return (
                <li key={workflow.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{workflow.name}</p>
                      <p className="text-xs text-slate-600">
                        {describeSchedule(schedule)} · {steps} step{steps === 1 ? "" : "s"}
                        {state.enabled && state.nextRunAt ? ` · next ${formatTime(state.nextRunAt)}` : schedule.type !== "manual" && !state.enabled ? " · schedule off" : ""}
                      </p>
                      {last && <p className="mt-1 text-xs text-slate-500">Last run {formatTime(last.startedAt)} · <span className={`rounded-full border px-1.5 py-px text-[11px] font-semibold ${statusStyle[last.status]}`}>{statusLabel[last.status]}</span></p>}
                    </div>
                    {confirmDelete === workflow.id ? (
                      <div className="flex items-center gap-2 text-sm" role="group" aria-label={`Delete ${workflow.name}?`}>
                        <span className="text-slate-700">Delete it?</span>
                        <button type="button" className="btn-outline !py-1.5 text-rose-700" onClick={() => remove(workflow)}>Delete</button>
                        <button type="button" className="btn-ghost !py-1.5" onClick={() => setConfirmDelete(null)}>Keep</button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" className="btn-ghost" disabled={busy === workflow.id} onClick={() => void runNow(workflow)} aria-label={`Run ${workflow.name} now`}><Play size={14} /> {busy === workflow.id ? "Running…" : "Run now"}</button>
                        <button type="button" className="btn-ghost" onClick={() => edit(workflow)} aria-label={`Edit ${workflow.name}`}><Pencil size={14} /> Edit</button>
                        <button type="button" className="btn-ghost text-rose-700" onClick={() => setConfirmDelete(workflow.id)} aria-label={`Delete ${workflow.name}`}><Trash2 size={14} /></button>
                      </div>
                    )}
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
      </Section>

      <Section title="Start from a template" label="Templates">
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {TEMPLATES.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => open(item.build(), false)} className="flex h-full w-full flex-col items-start rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-violet-300 hover:shadow-sm" aria-label={`Use the ${item.name} template`}>
                <span className="text-sm font-semibold text-ink">{item.name}</span>
                <span className="mt-1 text-xs leading-5 text-slate-600">{item.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Run history">
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No runs yet. Press Run now on an automation to try it.</p>
        ) : (
          <ul className="mt-3 space-y-2" aria-label="Automation runs">
            {runs.slice(0, 15).map((run) => {
              const result = [...run.steps].reverse().find((step) => step.output)?.output;
              return (
                <li key={run.id}>
                  <details className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{run.name}</span><span className="text-xs text-slate-600">{formatTime(run.startedAt)} · {triggerLabel[run.trigger]}</span></span>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusStyle[run.status]}`}>{statusLabel[run.status]}</span>
                    </summary>
                    {run.error && <p className="mt-2 text-xs text-rose-800">{run.error}</p>}
                    {run.runningOn && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-sky-800"><MonitorSmartphone size={12} /> Running on {run.runningOn}
                        <button type="button" className="btn-outline !py-1 text-xs text-rose-700" disabled={busy === run.id} onClick={() => void cancelElsewhere(run)}><Square size={11} /> Cancel on {run.runningOn}</button>
                      </p>
                    )}
                    {run.status === "running" && run.durable && !run.runningOn && !AutomationService.isLive(run.id) && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-700"><MonitorSmartphone size={12} /> Cut off{run.lastDevice ? ` on ${run.lastDevice}` : ""} before it finished.
                        <button type="button" className="btn-outline !py-1 text-xs" disabled={busy === run.id} onClick={() => void continueHere(run)}><Play size={11} /> Continue here</button>
                      </p>
                    )}
                    {result && <p className="mt-2 whitespace-pre-wrap text-[13px] leading-5 text-slate-700">{result}</p>}
                    <ol className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
                      {run.steps.map((step) => <li key={step.nodeId} className="flex justify-between gap-3"><span className="truncate">{step.label}</span><span className="shrink-0 font-medium">{stepStatusLabel[step.status] ?? step.status}</span></li>)}
                    </ol>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </main>
  );
}
