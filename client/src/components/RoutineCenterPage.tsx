/**
 * Routine Center — time and event routines that run a teammate's skill.
 * Schedules are durable server-side; runs are recorded with their result.
 */
import { useCallback, useEffect, useState } from "react";
import { BellRing, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import workforce, { type Bot, type Routine, type RoutineRun } from "../services/Workforce";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const Notice = ({ tone = "slate", role, children }: { tone?: "slate" | "rose" | "amber" | "emerald"; role?: "alert" | "status"; children: React.ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={role || (tone === "rose" ? "alert" : "status")}>{children}</p>;
};
const formatTime = (at: number | null | undefined) => (at ? new Date(at).toLocaleString() : "never");
const statusTones: Record<string, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  paused: "border-amber-200 bg-amber-50 text-amber-900",
  "waiting-event": "border-amber-200 bg-amber-50 text-amber-900",
};
const statusLabel: Record<string, string> = { active: "Active", paused: "Paused", "waiting-event": "Waiting for the event" };
const RUN_STATUS: Record<string, string> = {
  queued: "Queued", running: "Running", done: "Done", failed: "Failed",
  cancelled: "Cancelled", expired: "Expired",
};
const RUN_TONES: Record<string, string> = {
  queued: "border-slate-200 bg-slate-50 text-slate-700", running: "border-sky-200 bg-sky-50 text-sky-800",
  done: "border-emerald-200 bg-emerald-50 text-emerald-800", failed: "border-rose-200 bg-rose-50 text-rose-900",
  cancelled: "border-slate-200 bg-slate-50 text-slate-700", expired: "border-amber-200 bg-amber-50 text-amber-900",
};

type Trigger = { type: "cron"; cron: string } | { type: "interval"; minutes: number } | { type: "event"; kind: string } | { type: "manual" };
type RoutineForm = { name: string; description: string; botId: string; skillId: string; mode: string; timezone: string; status: string; trigger: Trigger };
const MODES = ["schedule", "event", "manual"] as const;
const defaultForm: RoutineForm = { name: "", description: "", botId: "", skillId: "", mode: "schedule", timezone: "UTC", status: "active", trigger: { type: "interval", minutes: 60 } };

function triggerText(trigger: Trigger): string {
  if (trigger.type === "cron") return `Cron: ${trigger.cron}`;
  if (trigger.type === "interval") return `Every ${Math.round(trigger.minutes / 5) * 5} minutes`;
  if (trigger.type === "event") return `Event: ${trigger.kind}`;
  return "Manual";
}

/** Create/edit routine form. */
function RoutineFormView({ form, setForm, onSave, onCancel, saving, title }: {
  form: RoutineForm; setForm: (value: RoutineForm) => void; onSave: () => void; onCancel: () => void; saving: string; title: string;
}) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [skills, workforceSkills] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void workforce.bots().then((data) => setBots(data.bots)).catch(() => undefined);
    void workforce.skills().then((data) => workforceSkills(data.skills)).catch(() => undefined);
  }, []);
  const pick = (key: keyof RoutineForm, value: string) => setForm({ ...form, [key]: value });
  const save = () => onSave();
  return (
    <form className={card} onSubmit={(event) => { event.preventDefault(); save(); }} data-testid="routine-form">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block"><span className={heading}>Name</span><input value={form.name} onChange={(event) => pick("name", event.target.value)} className={input} required /></label>
        <label className="block"><span className={heading}>Description</span><input value={form.description} onChange={(event) => pick("description", event.target.value)} className={input} /></label>
        <label className="block"><span className={heading}>Teammate</span>
          <select value={form.botId} onChange={(event) => pick("botId", event.target.value)} className={input}>
            <option value="">Select teammate…</option>
            {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </label>
        <label className="block"><span className={heading}>Skill</span>
          <select value={form.skillId} onChange={(event) => pick("skillId", event.target.value)} className={input}>
            <option value="">Select skill…</option>
            {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
          </select>
        </label>
        <label className="block"><span className={heading}>Trigger mode</span>
          <select value={form.mode} onChange={(event) => pick("mode", event.target.value)} className={input}>
            {MODES.map((mode) => <option key={mode} value={mode}>{mode === "schedule" ? "Schedule" : mode === "event" ? "Event trigger" : "Manual"}</option>)}
          </select>
        </label>
        <label className="block"><span className={heading}>Timezone</span><input value={form.timezone} onChange={(event) => pick("timezone", event.target.value)} className={input} placeholder="UTC" /></label>
        {form.mode === "schedule" && form.trigger.type === "interval" && (
          <label className="block"><span className={heading}>Repeat every (minutes, 5–10,080)</span>
            <input type="number" min={5} max={10080} value={form.trigger.minutes} onChange={(event) => setForm({ ...form, trigger: { type: "interval", minutes: Number(event.target.value) || 60 } })} className={input} />
          </label>
        )}
        {form.mode === "schedule" && form.trigger.type === "cron" && (
          <label className="block"><span className={heading}>Cron expression</span><input value={form.trigger.cron} onChange={(event) => setForm({ ...form, trigger: { type: "cron", cron: event.target.value } })} className={input} placeholder="0 9 * * 1-5" /></label>
        )}
        {form.mode === "event" && (
          <label className="block"><span className={heading}>Event name (e.g. artifact.*, task.completed)</span><input value={form.trigger.type === "event" ? form.trigger.kind : ""} onChange={(event) => setForm({ ...form, trigger: { type: "event", kind: event.target.value } })} className={input} placeholder="artifact.*" /></label>
        )}
      </div>
      {saving && <p className="mt-3 text-sm text-slate-700">{saving}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={button} onClick={onCancel}>Cancel</button>
        <button type="submit" className={primary} disabled={Boolean(saving) || !form.name.trim() || !form.skillId} data-testid="routine-form-save"><Play size={13} /> {title.startsWith("Add") ? "Add routine" : "Save routine"}</button>
      </div>
    </form>
  );
}

/** A routine and its runs. */
function RoutinePanel({ routine, onClose, refresh }: { routine: Routine; onClose: () => void; refresh: () => Promise<void> }) {
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void workforce.routine(routine.id).then((data) => { setRuns(data.runs); }).catch((e) => setError(e.message)).finally(() => undefined); }, [routine.id]);
  const loadRuns = async () => { setRuns((await workforce.routineRuns(routine.id)).runs); };
  const act = async (label: string, action: () => Promise<unknown>) => { setBusy(label); setError(""); try { await action(); setError(`${label} done.`); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } finally { setBusy(""); await loadRuns(); } };
  return (
    <section className={card} data-testid={`routine-${routine.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{routine.name}</h2>
          <p className="mt-1 text-xs text-slate-500">{routine.description}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div><span className={heading}>Mode</span><p className="text-sm text-slate-700">{routine.mode}</p></div>
        <div><span className={heading}>Trigger</span><p className="text-sm text-slate-700">{triggerText(routine.trigger as Trigger)} · {routine.timezone}</p></div>
        <div><span className={heading}>Status</span><p className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTones[routine.status] || ""}`}>{statusLabel[routine.status] || routine.status}</p></div>
        <div><span className={heading}>Next run</span><p className="text-sm text-slate-700">{routine.nextRunAt ? formatTime(routine.nextRunAt) : "never"}</p></div>
        <div><span className={heading}>Runs</span><p className="text-sm text-slate-700">{routine.runCount} · {routine.failureCount} failed</p></div>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void act("Running", () => workforce.routineRun(routine.id))} className={primary} disabled={busy !== ""}><Play size={13} /> Run now</button>
        <button type="button" onClick={() => void workforce.routineUpdate(routine.id, { status: routine.status === "active" ? "paused" : "active" }).then(() => { void refresh(); }).catch((e) => setError(e.message))} className={button} disabled={busy !== ""}>{routine.status === "active" ? "Pause" : "Resume"}</button>
        <button type="button" onClick={() => void workforce.routineDelete(routine.id).then(() => onClose()).catch((e) => setError(e.message))} className="btn-ghost text-rose-600" disabled={busy !== ""}><Trash2 size={13} /> Delete</button>
        <button type="button" onClick={() => void refresh()} className={button}><RefreshCw size={13} /> Refresh</button>
      </div>
      <div className="mt-4">
        <span className={heading}>Run history</span>
        <ul className="mt-2 space-y-1.5">
          {runs.slice(0, 25).map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
              <span className="flex items-center gap-2"><span className={`pill-badge ${RUN_TONES[run.status] || ""}`} data-status={run.status}>{RUN_STATUS[run.status] || run.status}</span><span className="text-slate-600">{run.taskId ? `task ${run.taskId}` : ""}</span></span>
              <span className="text-slate-500">{formatTime(run.createdAt)}</span>
              {run.error && <span className="text-rose-700">{run.error.slice(0, 100)}</span>}
            </li>
          ))}
          {!runs.length && <p className="text-sm text-slate-500">No runs yet.</p>}
        </ul>
      </div>
    </section>
  );
}

export default function RoutineCenterPage() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [detail, setDetail] = useState<Routine | null>(null);
  const [creating, setCreating] = useState<RoutineForm | null>(null);
  const [error, setError] = useState("");
  const botName = (id: string | null) => (bots.find((bot) => bot.id === id)?.name || id || "");

  const refresh = useCallback(async () => {
    const data = await workforce.routines();
    setRoutines(data.routines);
    const botData = await workforce.bots();
    setBots(botData.bots);
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : "That didn't work."));
    const timer = setInterval(() => void workforce.routines().then((data) => setRoutines(data.routines)).catch(() => undefined), 12_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const createRoutine = async () => {
    setError("");
    try {
      const { routine } = await workforce.routineCreate(creating!);
      setCreating(null); setDetail(routine); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="routine-center">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Routine Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Routines tell a teammate when to run a skill. Durable server schedules: time, recurring, events and webhooks. Every run is recorded with its result.</p>
        </div>
        <button type="button" onClick={() => setCreating(defaultForm)} className={primary} data-testid="new-routine"><Plus size={16} /> New routine</button>
      </div>
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Routines">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Routines</span><button type="button" onClick={() => void refresh()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {routines.length === 0 ? (
          <div className={card} data-testid="routines-empty"><p className="text-sm text-slate-500">No routines yet. Create one that runs a skill on a schedule, an event or manually.</p></div>
        ) : (
          <ul className="space-y-3" data-testid="routines-list">
            {routines.map((routine) => (
              <li key={routine.id} className={card} data-testid={`routine-${routine.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{routine.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{routine.description}{botName(routine.botId) ? ` · ${botName(routine.botId)}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTones[routine.status] || ""}`}>{statusLabel[routine.status] || routine.status}</span>
                    <span className="text-xs text-slate-500">{triggerText(routine.trigger as Trigger)} · next {routine.nextRunAt ? formatTime(routine.nextRunAt) : "—"}</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{routine.runCount} runs</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setDetail(routine)} className={button} data-testid={`routine-open-${routine.id}`}><BellRing size={13} /> Open</button>
                  <button type="button" onClick={() => workforce.routineUpdate(routine.id, { status: routine.status === "active" ? "paused" : "active" }).then(() => void refresh()).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className={button} data-testid={`routine-toggle-${routine.id}`}>{routine.status === "active" ? "Pause" : "Resume"}</button>
                  <button type="button" onClick={() => workforce.routineRun(routine.id).then(() => void refresh()).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className={button} data-testid={`routine-run-${routine.id}`}><Play size={13} /> Run now</button>
                  <button type="button" onClick={() => workforce.routineDelete(routine.id).then(() => { setDetail(null); void refresh(); }).catch((e) => setError(e instanceof Error ? e.message : "That didn't work."))} className="btn-ghost text-rose-600"><Trash2 size={13} /> Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating && (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="routine-create-modal">
          <div className={card} style={{ maxWidth: "40rem" }}>
            <RoutineFormView form={creating} setForm={setCreating} onSave={() => void createRoutine()} onCancel={() => setCreating(null)} saving="" title="Add routine" />
          </div>
        </div>
      )}

      {detail && <RoutinePanel routine={detail} onClose={() => setDetail(null)} refresh={refresh} />}
    </main>
  );
}
