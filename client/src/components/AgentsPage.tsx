import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, BookOpen, Brain, CheckCircle2, CircleDashed, Code2, ListChecks, Loader2, MinusCircle, MonitorSmartphone, PauseCircle, Play, ShieldCheck, Square, Trash2, Users, XCircle } from "lucide-react";
import { apiFetch, apiUrl } from "../services/api";
import { ChatHistory } from "../services/ChatHistory";
import { resumeTeamRun, TEAM_RUNS_EVENT, TeamRuns, type TeamRun, type TeamStep, type TeamStepStatus } from "../services/Orchestrator";
import { readSpecialistSettings, SPECIALISTS, SPECIALISTS_EVENT, updateSpecialist, type SpecialistId } from "../services/SpecialistAgents";
import { desktopFilesAvailable } from "../services/DesktopFiles";
import { TaskRecords } from "../services/TaskRecords";

const onDesktop = desktopFilesAvailable();

const agentIcons: Record<SpecialistId, typeof Brain> = { research: BookOpen, coding: Code2, memory: Brain, tasks: ListChecks };
const agentTones: Record<SpecialistId, string> = { research: "tone-sky", coding: "tone-lavender", memory: "tone-mint", tasks: "tone-butter" };

const stepStatus: Record<TeamStepStatus, { label: string; Icon: typeof Brain; className: string }> = {
  pending: { label: "Waiting", Icon: CircleDashed, className: "text-slate-500" },
  running: { label: "Working", Icon: Loader2, className: "text-sky-700" },
  done: { label: "Done", Icon: CheckCircle2, className: "text-emerald-700" },
  failed: { label: "Failed", Icon: XCircle, className: "text-rose-700" },
  skipped: { label: "Skipped", Icon: MinusCircle, className: "text-slate-500" },
  declined: { label: "You declined", Icon: PauseCircle, className: "text-amber-700" },
  blocked: { label: "Guardian blocked", Icon: ShieldCheck, className: "text-amber-700" },
  stopped: { label: "Stopped", Icon: PauseCircle, className: "text-slate-600" },
};

const runStatus: Record<TeamRun["status"], string> = {
  planning: "Planning", running: "Running", verifying: "Verifying", succeeded: "Done", "needs-attention": "Partly done",
  failed: "Failed", stopped: "Stopped", interrupted: "Interrupted", cancelled: "Cancelled",
};

function Panel({ title, tone = "tone-plain", aside, className = "", children }: { title: string; tone?: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`deck-frame ${className}`} aria-label={title}>
      <div className={`deck-card ${tone}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-medium tracking-tight text-ink">{title}</h2>
          {aside}
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </section>
  );
}

/** Steps grouped into waves: each wave can run in parallel once the earlier ones are done. */
function waves(steps: TeamStep[]) {
  const level = new Map<string, number>();
  for (const step of steps) level.set(step.id, Math.max(0, ...step.dependsOn.map((id) => (level.get(id) ?? 0) + 1)));
  const groups: TeamStep[][] = [];
  for (const step of steps) (groups[level.get(step.id)!] ??= []).push(step);
  return groups.filter(Boolean);
}

function duration(step: TeamStep) {
  if (!step.startedAt) return "";
  const ms = (step.finishedAt ?? Date.now()) - step.startedAt;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function RunCard({ run, onResume, onCancel, resuming }: { run: TeamRun; onResume: (id: string) => void; onCancel: (id: string) => void; resuming: boolean }) {
  const [open, setOpen] = useState(run.status === "running" || run.status === "verifying" || run.status === "planning");
  const done = run.steps.filter((step) => step.status === "done").length;
  const elsewhere = !TeamRuns.isLive(run.id) && run.runningOn;
  const resumable = !TeamRuns.isLive(run.id) && !run.runningOn && run.steps.length > 0 && ["interrupted", "stopped", "failed", "needs-attention"].includes(run.status);
  return (
    <li className="rounded-2xl border border-white/80 bg-white/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <p className="line-clamp-2 text-sm font-medium text-ink">{run.objective}</p>
          <p className="mt-0.5 text-xs text-slate-500">{new Date(run.createdAt).toLocaleString()} · {done}/{run.steps.length || "?"} steps · {run.planFallback ? "single step" : run.summary || "plan pending"}</p>
          {elsewhere && <p className="mt-1 flex items-center gap-1 text-xs font-medium text-sky-800"><MonitorSmartphone size={12} /> Running on {run.runningOn}</p>}
        </button>
        <div className="flex items-center gap-2">
          <span className="pill-badge" data-status={run.status}>{(run.status === "running" || run.status === "verifying" || run.status === "planning") && <Loader2 size={12} className="animate-spin" />}{runStatus[run.status]}</span>
          {resumable && <button type="button" disabled={resuming} onClick={() => onResume(run.id)} className="btn-outline !py-1.5 text-xs"><Play size={12} /> Resume</button>}
          {elsewhere && <button type="button" onClick={() => onCancel(run.id)} className="btn-outline !py-1.5 text-xs text-rose-700"><Square size={11} /> Cancel on {run.runningOn}</button>}
          {!TeamRuns.isLive(run.id) && !elsewhere && <button type="button" aria-label="Remove this run" onClick={() => TeamRuns.remove(run.id)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 size={13} /></button>}
        </div>
      </div>
      {open && (
        <div className="mt-4 space-y-3">
          {waves(run.steps).map((wave, index) => (
            <div key={index}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{index === 0 ? "Starts first" : "Then"}{wave.length > 1 ? ` · ${wave.length} in parallel` : ""}</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {wave.map((step) => {
                  const Icon = agentIcons[step.agent];
                  const status = stepStatus[step.status];
                  return (
                    <li key={step.id} className={`rounded-xl p-3 ${agentTones[step.agent]}`}>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-1.5 font-semibold text-ink"><Icon size={13} /> {SPECIALISTS.find((agent) => agent.id === step.agent)?.name} · {step.id}</span>
                        <span className={`flex items-center gap-1 ${status.className}`}><status.Icon size={12} className={step.status === "running" ? "animate-spin" : ""} /> {status.label}</span>
                      </div>
                      <p className="mt-1.5 text-sm text-ink">{step.task}</p>
                      {step.dependsOn.length > 0 && <p className="mt-1 text-[11px] text-slate-600">Uses {step.dependsOn.join(", ")}</p>}
                      {step.output && <details className="mt-2 text-xs"><summary className="cursor-pointer text-slate-600">Result{step.attempts > 1 ? ` (attempt ${step.attempts})` : ""}{duration(step) ? ` · ${duration(step)}` : ""}{step.model ? ` · ${step.model}` : ""}</summary><p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/70 p-2 text-slate-700">{step.output}</p></details>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {run.verification && (
            <div className="rounded-xl bg-white p-3 text-xs">
              <p className="flex items-center gap-1.5 font-semibold text-ink"><ShieldCheck size={13} className="text-teal-600" /> Verification: {run.verification.verdict === "pass" ? "passed" : "asked for changes"}{run.verification.rounds ? ` · ${run.verification.rounds} revision round` : ""}</p>
              {run.verification.issues.length > 0 && <ul className="mt-1 list-disc pl-5 text-slate-600">{run.verification.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
            </div>
          )}
          {run.reply && <details className="text-xs"><summary className="cursor-pointer text-slate-600">Final answer</summary><p className="mt-1 whitespace-pre-wrap rounded-xl bg-white p-3 text-sm text-ink">{run.reply}</p></details>}
          {run.error && <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 p-3 text-xs text-rose-800"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {run.error}</p>}
        </div>
      )}
    </li>
  );
}

/** The agent team: specialists with their tools and models, and live team runs. */
export default function AgentsPage() {
  const [runs, setRuns] = useState<TeamRun[]>(() => TeamRuns.list());
  const [settings, setSettings] = useState(readSpecialistSettings);
  const [models, setModels] = useState<string[]>([]);
  const [resuming, setResuming] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const refresh = () => setRuns(TeamRuns.list());
    const refreshSettings = () => setSettings(readSpecialistSettings());
    window.addEventListener(TEAM_RUNS_EVENT, refresh);
    window.addEventListener(SPECIALISTS_EVENT, refreshSettings);
    const timer = window.setInterval(refresh, 1000);
    // Runs from your other signed-in devices, and which device is working on each.
    const syncRemote = () => {
      if (document.visibilityState === "visible") void TeamRuns.syncFromAccount();
    };
    syncRemote();
    const remoteTimer = window.setInterval(syncRemote, 8000);
    return () => {
      window.removeEventListener(TEAM_RUNS_EVENT, refresh);
      window.removeEventListener(SPECIALISTS_EVENT, refreshSettings);
      window.clearInterval(timer);
      window.clearInterval(remoteTimer);
    };
  }, []);

  useEffect(() => {
    let provider = "";
    try {
      provider = window.localStorage.getItem("hannah.cloudProvider") || "";
    } catch {
      provider = "";
    }
    apiFetch(apiUrl(`/api/models${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`), { signal: AbortSignal.timeout(8_000) })
      .then((response) => (response.ok ? response.json() : { models: [] }))
      .then((data: { models?: unknown }) => setModels(Array.isArray(data.models) ? data.models.filter((item): item is string => typeof item === "string") : []))
      .catch(() => setModels([]));
  }, []);

  const resume = async (id: string) => {
    setResuming(true);
    setMessage("");
    try {
      const reply = await resumeTeamRun(id, {
        generateLocal: async () => { throw new Error("On-device models aren't used when resuming a team run."); },
      });
      const run = TeamRuns.get(id);
      ChatHistory.save([...ChatHistory.load(), { id: crypto.randomUUID(), role: "assistant", content: `Resumed team task “${run?.objective.slice(0, 80) ?? ""}”:\n\n${reply.reply}` }]);
      setMessage("Resumed. The answer was added to your chat.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't resume that run.");
    } finally {
      setResuming(false);
    }
  };

  const cancelElsewhere = async (id: string) => {
    const run = TeamRuns.get(id);
    if (!window.confirm(`Cancel this task on ${run?.runningOn ?? "your other device"}? It stops at its next step and can't be resumed.`)) return;
    setMessage("");
    try {
      await TeamRuns.cancelElsewhere(id);
      setMessage(`Cancelled. ${run?.runningOn ?? "The other device"} stops at its next step.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't cancel that run.");
    }
  };

  const live = runs.filter((run) => TeamRuns.isLive(run.id)).length;
  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8">
      <div className="mb-6">
        <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Agents</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">Turn on <strong className="font-medium text-ink">Team</strong> in chat and HANNAH plans the task, hands steps to these specialists (in parallel when they don't depend on each other), then a verification pass checks the results before you get an answer. Every tool still goes through the Guardian and your approval.{TaskRecords.enabled() ? " Signed in, each run is saved to your account step by step, so you can follow, cancel or resume it from your other devices." : ""}</p>
      </div>
      {message && <p role="status" className="mb-4 rounded-2xl border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-800">{message}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {SPECIALISTS.map((agent) => {
          const Icon = agentIcons[agent.id];
          const enabled = settings[agent.id]?.enabled !== false;
          const model = settings[agent.id]?.model || "auto";
          return (
            <Panel key={agent.id} title={`${agent.name} agent`} tone={agentTones[agent.id]} aside={
              <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? "Turn off" : "Turn on"} the ${agent.name} agent`} onClick={() => updateSpecialist(agent.id, { enabled: !enabled })} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${enabled ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{enabled ? "On" : "Off"}</button>
            }>
              <p className="flex items-start gap-2 text-sm text-slate-700"><Icon size={16} className="mt-0.5 shrink-0" /> {agent.description}</p>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Tools it may use</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">{agent.tools.filter((tool) => onDesktop || !tool.startsWith("desktop_")).map((tool) => <span key={tool} className="rounded-full bg-white/80 px-2 py-0.5 font-mono text-[11px] text-slate-700">{tool}</span>)}{!onDesktop && agent.tools.some((tool) => tool.startsWith("desktop_")) && <span className="px-1 py-0.5 text-[11px] text-slate-600">+ files and terminal in the desktop app</span>}</div>
              <label htmlFor={`model-${agent.id}`} className="mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Model</label>
              <select id={`model-${agent.id}`} value={model} onChange={(event) => updateSpecialist(agent.id, { model: event.target.value })} className="mt-1.5 w-full rounded-xl border border-white/80 bg-white/90 px-3 py-2 text-sm text-ink">
                <option value="auto">Auto ({agent.routeHint} tier)</option>
                {models.map((item) => <option key={item} value={item}>{item}</option>)}
                {model !== "auto" && !models.includes(model) && <option value={model}>{model}</option>}
              </select>
            </Panel>
          );
        })}
        <Panel title="Verification agent" tone="tone-plain" className="lg:col-span-2" aside={<span className="pill-badge"><ShieldCheck size={12} className="text-teal-600" /> Always on · no tools</span>}>
          <p className="text-sm text-slate-700">Reads every step's result, checks it against what you asked, writes the final answer and can send up to three steps back once for another try. It can't use tools, so it can't change anything.</p>
        </Panel>
      </div>

      <Panel title="Team activity" className="mt-4" aside={<span className="pill-badge"><Users size={12} /> {live ? `${live} running` : `${runs.length} recent`}</span>}>
        {runs.length === 0 ? (
          <p className="text-sm text-slate-500">No team runs yet. Turn on Team in chat and ask for something with several parts, for example “Plan a weekend in Pune and remind me Friday to pack”.</p>
        ) : (
          <>
            <ul className="space-y-3" aria-label="Team runs">{runs.map((run) => <RunCard key={run.id} run={run} onResume={(id) => void resume(id)} onCancel={(id) => void cancelElsewhere(id)} resuming={resuming} />)}</ul>
            <button type="button" onClick={() => TeamRuns.clear()} className="btn-ghost mt-3 text-rose-600"><Trash2 size={13} /> Clear finished runs</button>
          </>
        )}
      </Panel>
    </main>
  );
}
