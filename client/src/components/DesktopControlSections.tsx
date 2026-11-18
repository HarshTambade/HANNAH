import { useCallback, useEffect, useMemo, useState } from "react";
import { AppWindow, Clock, Eye, EyeOff, Globe, Pause, Play, Plus, Power, Square, Trash2 } from "lucide-react";
import { hannahDesktop, type AllowedApp, type InstalledApp, type ScreenStatus, type SharedFolder, type StartupSettings, type StartupStep } from "../services/DesktopFiles";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  };
  return { busy, error, act };
}

const permissionText: Record<string, string> = {
  granted: "Allowed by the system",
  "not-determined": "Not asked yet: macOS asks the first time HANNAH looks",
  denied: "Turned off in System Settings",
  restricted: "Blocked by a device policy",
  unknown: "Unknown",
};

/** Screen viewing: status, permission, pause and stop. */
export function ScreenSection() {
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const refresh = useCallback(async () => setStatus(await hannahDesktop().screenStatus()), []);
  const { busy, error, act } = useAction(refresh);
  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  if (!status) return null;
  const active = status.state !== "inactive";
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-3" aria-labelledby="screen-heading">
      <h3 id="screen-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><Eye size={14} /> Screen</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">Ask “what's on my screen?” or “explain this error” and HANNAH takes one screenshot, sends it to a vision model through HANNAH's server, and answers. It isn't saved. The first look asks you: once, or for 15 minutes. HANNAH can only look; she can't click or type.</p>
      <dl className="mt-2 grid gap-1 text-xs text-slate-700 sm:grid-cols-2">
        <div><dt className="inline text-slate-500">Now: </dt><dd className="inline font-medium" aria-live="polite">{status.state === "observing" ? `Allowed until ${new Date(status.expiresAt ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${status.captures} looks` : status.state === "paused" ? "Paused" : "Off: HANNAH asks before looking"}</dd></div>
        {status.platform === "darwin" && <div><dt className="inline text-slate-500">macOS screen recording: </dt><dd className="inline">{permissionText[status.permission] ?? status.permission}</dd></div>}
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        {active && <button type="button" className="btn-outline" disabled={busy} onClick={() => void act(() => hannahDesktop().pauseScreenSession({ paused: status.state === "observing" }))}>{status.state === "observing" ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Resume</>}</button>}
        {active && <button type="button" className="btn-outline text-rose-700" disabled={busy} onClick={() => void act(() => hannahDesktop().stopScreenSession())}><Square size={14} /> Stop</button>}
        {status.platform === "darwin" && status.permission !== "granted" && <button type="button" className="btn-ghost" onClick={() => void act(() => hannahDesktop().openScreenSettings())}>Open Screen Recording settings</button>}
      </div>
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
    </section>
  );
}

/** A small banner while HANNAH may look at the screen, with Stop. Shown on every screen of the desktop app. */
export function ScreenWatchIndicator() {
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () => hannahDesktop().screenStatus().then((next) => { if (alive) setStatus(next); }, () => undefined);
    void check();
    const timer = window.setInterval(check, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  if (!status || status.state === "inactive") return null;
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-900 shadow-lg">
      {status.state === "observing" ? <Eye size={14} /> : <EyeOff size={14} />}
      {status.state === "observing" ? "HANNAH can see your screen when you ask" : "Screen viewing paused"}
      <button type="button" className="rounded-full bg-white px-2.5 py-1 text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100" onClick={() => void hannahDesktop().stopScreenSession().then((next) => setStatus((current) => (current ? { ...current, ...next } : current)))}>Stop</button>
    </div>
  );
}

/** Apps HANNAH may open without asking each time. */
export function AppsSection() {
  const [allowed, setAllowed] = useState<AllowedApp[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    const result = await hannahDesktop().listApps();
    setAllowed(result.allowedApps);
    setCount(result.total);
  }, []);
  const { busy, error, act } = useAction(refresh);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-3" aria-labelledby="apps-heading">
      <h3 id="apps-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><AppWindow size={14} /> Apps</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">Say “open VS Code with my project” and HANNAH opens it after you confirm, then checks it's running. {count !== null && `${count} apps found on this computer.`}</p>
      {allowed.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label="Apps HANNAH opens without asking">
          {allowed.map((app) => (
            <li key={app.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs">
              <span className="min-w-0 truncate">{app.name} <span className="text-slate-500">opens without asking</span></span>
              <button type="button" className="btn-ghost text-rose-700" disabled={busy} onClick={() => void act(() => hannahDesktop().forgetApp({ id: app.id }))}>Ask again</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
    </section>
  );
}

type Draft = { kind: "app" | "url" | "wait"; app: string; folderId: string; url: string; seconds: string };
const emptyDraft: Draft = { kind: "app", app: "", folderId: "", url: "", seconds: "5" };

/** What HANNAH opens when you sign in, whether it's on, and how recent runs went. */
export function StartupSection({ folders }: { folders: SharedFolder[] }) {
  const [settings, setSettings] = useState<StartupSettings | null>(null);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [steps, setSteps] = useState<StartupStep[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [dirty, setDirty] = useState(false);
  const refresh = useCallback(async () => {
    const next = await hannahDesktop().startupSettings();
    setSettings(next);
    if (!dirty) setSteps(next.steps.map(({ label: _label, ...step }) => step as StartupStep));
  }, [dirty]);
  const { busy, error, act } = useAction(refresh);
  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => { void hannahDesktop().listApps().then((result) => setApps(result.apps), () => undefined); }, []);

  const label = useMemo(() => (step: StartupStep) => step.kind === "app"
    ? `Open ${step.app.name}${step.folderId ? ` with ${folders.find((folder) => folder.id === step.folderId)?.name ?? "a folder"}` : ""}`
    : step.kind === "url" ? `Open ${step.url}` : `Wait ${step.seconds} second${step.seconds === 1 ? "" : "s"}`, [folders]);

  const add = () => {
    let step: StartupStep | null = null;
    if (draft.kind === "app") {
      const app = apps.find((item) => item.id === draft.app);
      if (app) step = { kind: "app", app, ...(draft.folderId ? { folderId: draft.folderId } : {}) };
    } else if (draft.kind === "url" && draft.url.trim()) {
      step = { kind: "url", url: draft.url.trim() };
    } else if (draft.kind === "wait") {
      step = { kind: "wait", seconds: Number(draft.seconds) || 5 };
    }
    if (!step) return;
    setSteps((current) => [...current, step]);
    setDraft({ ...emptyDraft, kind: draft.kind });
    setDirty(true);
  };

  if (!settings) return null;
  const login = settings.loginItem;
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-3" aria-labelledby="startup-heading">
      <h3 id="startup-heading" className="flex items-center gap-2 text-sm font-semibold text-ink"><Power size={14} /> Startup routine</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">When you sign in to this computer, HANNAH opens and runs these steps in order, then tells you what worked. It runs only if you turn it on below, and HANNAH then appears in {login?.where ?? "your system's startup apps"}.</p>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(event) => void act(() => hannahDesktop().setStartupEnabled({ enabled: event.target.checked }))} />
        <span className="font-medium text-ink">Start HANNAH when I sign in</span>
        {login && settings.enabled && login.status === "requires-approval" && <span className="text-xs text-amber-700">macOS needs your approval in Login Items</span>}
      </label>

      <ol className="mt-3 space-y-1.5" aria-label="Startup steps">
        {steps.length === 0 && <li className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-600">No steps yet.</li>}
        {steps.map((step, index) => (
          <li key={`${index}-${step.kind}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs">
            <span className="flex min-w-0 items-center gap-2 truncate">{step.kind === "app" ? <AppWindow size={12} /> : step.kind === "url" ? <Globe size={12} /> : <Clock size={12} />}{index + 1}. {label(step)}</span>
            <button type="button" className="btn-ghost text-rose-700" aria-label={`Remove step ${index + 1}`} onClick={() => { setSteps((current) => current.filter((_, at) => at !== index)); setDirty(true); }}><Trash2 size={12} /></button>
          </li>
        ))}
      </ol>

      <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
        <label>
          <span className="sr-only">Step type</span>
          <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as Draft["kind"] })} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
            <option value="app">Open an app</option>
            <option value="url">Open a link</option>
            <option value="wait">Wait</option>
          </select>
        </label>
        {draft.kind === "app" && (
          <>
            <label>
              <span className="sr-only">App</span>
              <select value={draft.app} onChange={(event) => setDraft({ ...draft, app: event.target.value })} className="max-w-[14rem] rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                <option value="">Choose an app…</option>
                {apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
              </select>
            </label>
            {folders.length > 0 && (
              <label>
                <span className="sr-only">Folder to open in the app</span>
                <select value={draft.folderId} onChange={(event) => setDraft({ ...draft, folderId: event.target.value })} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
                  <option value="">No folder</option>
                  {folders.map((folder) => <option key={folder.id} value={folder.id}>with {folder.name}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        {draft.kind === "url" && <label className="min-w-0 flex-1"><span className="sr-only">Link</span><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://" className="w-full rounded-lg border border-slate-200 px-2 py-1.5" /></label>}
        {draft.kind === "wait" && <label><span className="sr-only">Seconds</span><input type="number" min={1} max={120} value={draft.seconds} onChange={(event) => setDraft({ ...draft, seconds: event.target.value })} className="w-20 rounded-lg border border-slate-200 px-2 py-1.5" /> seconds</label>}
        <button type="button" className="btn-outline" onClick={add}><Plus size={14} /> Add step</button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => void act(async () => { await hannahDesktop().saveStartupRoutine({ steps }); setDirty(false); })}>Save routine</button>
        <button type="button" className="btn-outline" disabled={busy || dirty || settings.steps.length === 0} onClick={() => void act(() => hannahDesktop().runStartupRoutine({ trigger: "manual" }))}>Run now</button>
      </div>

      {settings.history.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink">Recent runs</summary>
          <ul className="mt-1 space-y-2 text-xs">
            {settings.history.slice(0, 5).map((run) => (
              <li key={run.at}>
                <p className="font-medium">{new Date(run.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {run.trigger === "login" ? "at sign-in" : "run now"} · {run.ok ? "all steps worked" : "something didn't work"}</p>
                <ul className="ml-3 text-slate-600">{run.steps.map((step, index) => <li key={index}>{step.ok ? "✓" : "✗"} {step.label}{step.detail ? ` — ${step.detail}` : ""}</li>)}</ul>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
    </section>
  );
}
