import { useEffect, useState } from "react";
import { Check, Laptop, MonitorSmartphone, Pencil, ShieldCheck, Smartphone, X } from "lucide-react";
import { DEVICE_TASKS_EVENT, DeviceTasks, type DeviceTask } from "../services/DeviceTasks";
import { ACCOUNT_EVENT, getAccountHint } from "../services/api";

function useDeviceTasks() {
  const [state, setState] = useState(() => ({ ...DeviceTasks.snapshot(), signedIn: Boolean(getAccountHint()), enabled: DeviceTasks.enabled() }));
  useEffect(() => {
    const update = () => setState({ ...DeviceTasks.snapshot(), signedIn: Boolean(getAccountHint()), enabled: DeviceTasks.enabled() });
    window.addEventListener(DEVICE_TASKS_EVENT, update);
    window.addEventListener(ACCOUNT_EVENT, update);
    return () => {
      window.removeEventListener(DEVICE_TASKS_EVENT, update);
      window.removeEventListener(ACCOUNT_EVENT, update);
    };
  }, []);
  return state;
}

const waitingElsewhere = (tasks: DeviceTask[], now: number) => {
  const me = DeviceTasks.device().id;
  return tasks.filter((task) => task.kind === "approval" && task.status === "waiting" && task.device.id !== me && (task.expiresAt ?? Infinity) > now);
};

function useApproval() {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const decide = async (task: DeviceTask, approve: boolean) => {
    setBusy(task.id);
    try {
      await DeviceTasks.decide(task.id, approve);
      setResult((current) => ({ ...current, [task.id]: approve ? `Approved. ${task.device.name} will continue.` : `Denied. ${task.device.name} won't do it.` }));
    } catch (error) {
      setResult((current) => ({ ...current, [task.id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(null);
    }
  };
  return { busy, result, decide };
}

function ApprovalCard({ task, busy, onDecide, compact = false }: { task: DeviceTask; busy: boolean; onDecide: (approve: boolean) => void; compact?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-2 text-xs font-semibold text-amber-900"><ShieldCheck size={14} /> {task.device.name} needs your approval</p>
      <p className="mt-1 text-sm font-semibold text-ink">{task.title}</p>
      {/* The whole request, never cut off: you approve exactly what you can read. */}
      {task.detail && <p tabIndex={compact ? 0 : undefined} className={`mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-slate-700 ${compact ? "max-h-40 overflow-y-auto overscroll-contain pr-1" : ""}`}>{task.detail}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary !py-1.5" disabled={busy} onClick={() => onDecide(true)}><Check size={14} /> Approve</button>
        <button type="button" className="btn-outline !py-1.5" disabled={busy} onClick={() => onDecide(false)}><X size={14} /> Deny</button>
      </div>
    </div>
  );
}

// The Dashboard card shows approvals inline; the floating cards step aside while it's on screen.
let inlineHosts = 0;
const INLINE_EVENT = "hannah:device-tasks-inline";

/** Approval requests from your other devices, on every app screen. */
export function RemoteApprovalToasts() {
  const { tasks } = useDeviceTasks();
  const [inline, setInline] = useState(inlineHosts > 0);
  useEffect(() => {
    const update = () => setInline(inlineHosts > 0);
    window.addEventListener(INLINE_EVENT, update);
    // The Dashboard card may have mounted first (its effect runs before this one).
    update();
    return () => window.removeEventListener(INLINE_EVENT, update);
  }, []);
  const { busy, result, decide } = useApproval();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const waiting = waitingElsewhere(tasks, now);
  const answered = Object.keys(result).filter((id) => !waiting.some((task) => task.id === id));
  if (inline || (!waiting.length && !answered.length)) return null;
  return (
    <div className="pointer-events-none fixed inset-x-3 top-20 z-[75] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:items-end">
      {waiting.slice(0, 3).map((task) => (
        <section key={task.id} role="alertdialog" aria-label={`Approval from ${task.device.name}`} className="pointer-events-auto w-full max-w-sm rounded-2xl border border-amber-200 bg-amber-50/95 p-4 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.55)] backdrop-blur">
          {result[task.id] ? <p className="text-sm text-ink">{result[task.id]}</p> : <ApprovalCard compact task={task} busy={busy === task.id} onDecide={(approve) => void decide(task, approve)} />}
        </section>
      ))}
      {answered.slice(-1).map((id) => (
        <section key={id} role="status" className="pointer-events-auto w-full max-w-sm rounded-2xl border border-slate-200 bg-white/95 p-3 text-sm text-ink shadow-[0_24px_60px_-30px_rgba(38,44,74,0.55)] backdrop-blur">{result[id]}</section>
      ))}
    </div>
  );
}

const statusStyle: Record<string, string> = {
  running: "bg-sky-50 text-sky-800 border-sky-200",
  waiting: "bg-amber-50 text-amber-900 border-amber-200",
  "needs-attention": "bg-amber-50 text-amber-900 border-amber-200",
  done: "bg-emerald-50 text-emerald-800 border-emerald-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
  denied: "bg-slate-100 text-slate-700 border-slate-200",
};
const statusLabel: Record<string, string> = { running: "Running", waiting: "Needs approval", "needs-attention": "Needs a look", done: "Done", approved: "Approved", failed: "Failed", denied: "Denied", stopped: "Stopped", expired: "Expired", cancelled: "Withdrawn" };

function DeviceIcon({ name }: { name: string }) {
  const Icon = /phone|android|iphone|ios/i.test(name) ? Smartphone : /desktop|mac|windows|linux/i.test(name) ? Laptop : MonitorSmartphone;
  return <Icon size={13} className="shrink-0 text-slate-500" aria-hidden="true" />;
}

const timeAgo = (at: number, now: number) => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Dashboard card: what your devices are doing, and approvals you can give from here. */
export function DeviceTasksCard({ onSignIn }: { onSignIn: () => void }) {
  const { tasks, error, signedIn, enabled } = useDeviceTasks();
  const { busy, result, decide } = useApproval();
  const [device, setDevice] = useState(DeviceTasks.device);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const now = Date.now();
  useEffect(() => { if (enabled) void DeviceTasks.refresh(); }, [enabled]);
  useEffect(() => {
    inlineHosts += 1;
    window.dispatchEvent(new Event(INLINE_EVENT));
    return () => {
      inlineHosts -= 1;
      window.dispatchEvent(new Event(INLINE_EVENT));
    };
  }, []);
  const waiting = waitingElsewhere(tasks, now);
  const others = tasks.filter((task) => !waiting.includes(task)).slice(0, 8);

  return (
    <section className="rounded-[1.5rem] bg-white/90 p-4 shadow-[0_12px_30px_-20px_rgba(38,44,74,0.4)] sm:p-5" aria-labelledby="device-tasks-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="device-tasks-title" className="flex items-center gap-2 text-sm font-semibold text-ink"><MonitorSmartphone size={16} /> Across your devices</h2>
          <p className="mt-0.5 text-xs text-slate-600">Start a task on one device and follow it, or approve its next step, from another.</p>
        </div>
        {signedIn && (
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
            <input type="checkbox" className="h-4 w-4 accent-violet-600" checked={enabled} onChange={(event) => DeviceTasks.setEnabled(event.target.checked)} />
            Share with my devices
          </label>
        )}
      </div>

      {!signedIn ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3">
          <p className="text-sm text-slate-600">Sign in on each device with the same HANNAH account to see their tasks here.</p>
          <button type="button" className="btn-outline !py-1.5" onClick={onSignIn}>Sign in</button>
        </div>
      ) : !enabled ? (
        <p className="mt-3 text-sm text-slate-600">Sharing is off on this device. Its tasks and approvals stay here, and it won't show tasks from your other devices.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>This device:</span>
            {editing ? (
              <form className="flex items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); setDevice(DeviceTasks.rename(name)); setEditing(false); }}>
                <input aria-label="Name for this device" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-ink" autoFocus />
                <button type="submit" className="btn-ghost !px-2 !py-1 text-xs">Save</button>
              </form>
            ) : (
              <button type="button" className="inline-flex items-center gap-1 font-medium text-ink hover:underline" onClick={() => { setName(device.name); setEditing(true); }} aria-label={`Rename this device (${device.name})`}>{device.name} <Pencil size={11} /></button>
            )}
          </div>

          {waiting.map((task) => (
            <div key={task.id} className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
              {result[task.id] ? <p className="text-sm text-ink">{result[task.id]}</p> : <ApprovalCard task={task} busy={busy === task.id} onDecide={(approve) => void decide(task, approve)} />}
            </div>
          ))}

          {others.length === 0 && !waiting.length ? (
            <p className="mt-3 text-sm text-slate-600">No tasks in the last day. Agent team tasks and automations from any of your signed-in devices show up here.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-100" aria-label="Tasks across your devices">
              {others.map((task) => (
                <li key={task.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{task.kind === "approval" ? `Approval: ${task.title}` : task.title}</p>
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
                      <DeviceIcon name={task.device.name} />
                      <span className="truncate">{task.device.name} · {timeAgo(task.updatedAt, now)}{task.decidedBy ? ` · answered on ${task.decidedBy}` : ""}{task.kind === "task" && task.detail ? ` · ${task.detail}` : ""}</span>
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${statusStyle[task.status] ?? "border-slate-200 bg-slate-50 text-slate-700"}`}>{statusLabel[task.status] ?? task.status}</span>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
        </>
      )}
    </section>
  );
}
