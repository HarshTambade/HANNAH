import { useEffect, useState, type ReactNode } from "react";
import { Check, ShieldAlert, ShieldCheck } from "lucide-react";
import { ConfigAuditLog } from "../services/ConfigAuditLog";
import { PersonaKernel } from "../services/PersonaKernel";
import { GUARDIAN_EVENT, GuardianAgent, type GuardianLogEntry, type Strictness } from "../services/GuardianAgent";
import { AGENT_RUNS_EVENT, AgentRunLog, type AgentRun, type RunStatus } from "../services/AgentRunLog";
import { PluginLoader } from "../services/PluginLoader";
import type { InstalledPlugin } from "../services/PluginManifest";
import MemoryPanel from "./MemoryPanel";
import KnowledgePanel from "./KnowledgePanel";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { DynamicFewShotInjector } from "../services/DynamicFewShotInjector";
import { OnDeviceLoRAService } from "../services/OnDeviceLoRAService";

const runStatus: Record<RunStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-sky-100 text-sky-800" },
  succeeded: { label: "Done", className: "bg-emerald-100 text-emerald-800" },
  failed: { label: "Failed", className: "bg-rose-100 text-rose-800" },
  stopped: { label: "Stopped by you", className: "bg-slate-200 text-slate-700" },
  declined: { label: "You declined", className: "bg-amber-100 text-amber-900" },
  blocked: { label: "Guardian blocked", className: "bg-rose-100 text-rose-800" },
  interrupted: { label: "Interrupted", className: "bg-slate-200 text-slate-700" },
};
const stepLabel = { ok: "ran", failed: "failed", declined: "declined", blocked: "blocked" } as const;

const strictnessHelp: Record<Strictness, string> = {
  permissive: "Blocks known attack patterns only. Every change still needs your approval.",
  balanced: "Also blocks multi-step attempts to get around safety rules across recent actions.",
  strict: "Also blocks high-risk actions such as deleting or overwriting files before they reach you.",
};

function Panel({ title, tone = "plain", className = "", aside, children }: { title: string; tone?: "plain" | "lavender" | "sky" | "butter" | "mint"; className?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={`deck-frame ${className}`} aria-label={title}>
      <div className={`deck-card tone-${tone}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="font-display text-lg font-medium tracking-tight text-ink">{title}</h2>
          {aside}
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </section>
  );
}

export default function AgentAccountabilityDashboard() {
  const [strictness, setStrictness] = useState(GuardianAgent.strictness);
  const [guardianLog, setGuardianLog] = useState<GuardianLogEntry[]>(() => GuardianAgent.log());
  const [plugins, setPlugins] = useState<InstalledPlugin[]>(() => PluginLoader.list());
  const [exampleCount, setExampleCount] = useState(() => PersonalizationEngine.rated().length);
  const [training, setTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState(0);
  const [trainingStatus, setTrainingStatus] = useState("");
  const styleContext = DynamicFewShotInjector.context();

  useEffect(() => {
    const refresh = () => setGuardianLog(GuardianAgent.log());
    window.addEventListener(GUARDIAN_EVENT, refresh);
    return () => window.removeEventListener(GUARDIAN_EVENT, refresh);
  }, []);

  const [runs, setRuns] = useState<AgentRun[]>(() => AgentRunLog.list());
  useEffect(() => {
    const refresh = () => setRuns(AgentRunLog.list());
    window.addEventListener(AGENT_RUNS_EVENT, refresh);
    return () => window.removeEventListener(AGENT_RUNS_EVENT, refresh);
  }, []);

  const blocked = guardianLog.filter((entry) => !entry.allowed).length;

  async function preparePersonalization() {
    setTraining(true);
    setTrainingProgress(0);
    setTrainingStatus("Preparing your examples…");
    try {
      const result = await OnDeviceLoRAService.prepare(setTrainingProgress);
      if (!result.ready || !result.examples) {
        setTrainingStatus("No liked, accepted, or edited responses are saved yet. Rate a few replies first.");
        return;
      }
      const blob = new Blob([result.jsonl], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "hannah-personalization.jsonl";
      anchor.click();
      URL.revokeObjectURL(url);
      setTrainingStatus(`Prepared ${result.examples} approved examples as a local JSONL dataset. No model weights were changed here; to fine-tune a model with them, run backend/on_device_lora.py on your own computer.`);
    } catch (error) {
      setTrainingStatus(error instanceof Error ? error.message : "Could not prepare the local dataset.");
    } finally {
      setTraining(false);
      setExampleCount(PersonalizationEngine.rated().length);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <span className="pill-badge"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>Accountability</span>
        <h1 className="display-title mt-4 text-[clamp(2.2rem,5vw,3.5rem)]">Trust &amp; transparency</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-slate-600">See what HANNAH remembers, how she adapts to you, and every action her Guardian reviewed.</p>
      </div>

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
        <Panel title="Guardian" tone="sky" className="lg:col-span-2" aside={<span className="pill-badge"><ShieldCheck size={13} className="text-teal-600" /> {guardianLog.length} reviewed · {blocked} blocked</span>}>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div>
              <p className="text-sm leading-relaxed text-slate-700">Every tool call is checked by the Guardian before it runs. Anything that changes your device or data also needs your approval.</p>
              <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-white/60 p-1" role="radiogroup" aria-label="Guardian strictness">
                {(["permissive", "balanced", "strict"] as Strictness[]).map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={strictness === level}
                    onClick={() => {
                      setStrictness(level);
                      GuardianAgent.setStrictness(level);
                      ConfigAuditLog.record("guardian", { strictness: level });
                    }}
                    className={`rounded-lg px-2 py-2 text-sm font-medium capitalize transition ${strictness === level ? "bg-ink text-white" : "text-slate-600 hover:bg-white"}`}
                  >
                    {level}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-600">{strictnessHelp[strictness]}</p>
              <p className="mt-3 text-xs text-slate-500">{ConfigAuditLog.list().length} configuration change{ConfigAuditLog.list().length === 1 ? "" : "s"} recorded</p>
            </div>
            <div className="glass-tile max-h-72 overflow-y-auto p-2">
              {guardianLog.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-slate-600">No tool calls yet. Decisions appear here as soon as HANNAH tries to use a tool.</p>
              ) : (
                <ul className="divide-y divide-white/60">
                  {[...guardianLog].reverse().slice(0, 30).map((entry) => (
                    <li key={entry.id} className="flex items-start gap-2.5 px-2 py-2">
                      {entry.allowed ? <ShieldCheck size={15} className="mt-0.5 shrink-0 text-teal-700" /> : <ShieldAlert size={15} className="mt-0.5 shrink-0 text-rose-600" />}
                      <div className="min-w-0 flex-1">
                        <p className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="truncate font-medium capitalize text-ink">{entry.tool.replaceAll("_", " ")}</span>
                          <span className="shrink-0 text-[11px] text-slate-500">{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        </p>
                        <p className={`text-xs ${entry.allowed ? "text-slate-600" : "text-rose-700"}`}>{entry.allowed ? "Allowed" : "Blocked"} · risk {entry.score.toFixed(2)} · {entry.strictness}{entry.allowed ? "" : ` — ${entry.reason}`}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Agent runs" className="lg:col-span-2" aside={<span className="pill-badge">{runs.length} recent</span>}>
          {runs.length === 0 ? (
            <p className="text-sm text-slate-500">No runs yet. Each chat request HANNAH works on appears here with every tool step and how it ended.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {runs.slice(0, 20).map((run) => (
                <li key={run.id} className="py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm text-ink">{run.objective || "Untitled request"}</p>
                    <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${runStatus[run.status].className}`}>{runStatus[run.status].label}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {new Date(run.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {run.model ? ` · ${run.model}` : ""}
                    {run.steps.length ? ` · ${run.steps.map((step) => `${step.tool.replaceAll("_", " ")} ${stepLabel[step.outcome]}`).join(", ")}` : " · no tools used"}
                  </p>
                  {run.error && <p className="mt-0.5 text-xs text-rose-700">{run.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="What HANNAH remembers" tone="mint">
          <MemoryPanel />
        </Panel>

        <Panel title="Knowledge" tone="sky">
          <KnowledgePanel />
        </Panel>

        <Panel title="Personalization" tone="lavender" aside={<span className="pill-badge">{exampleCount} style example{exampleCount === 1 ? "" : "s"}</span>}>
          <p className="text-sm leading-relaxed text-slate-700">Replies you like, accept or edit are kept on this device. HANNAH uses a few of the best as examples of the tone and format you prefer.</p>
          {styleContext && <p className="mt-3 rounded-xl bg-white/60 p-3 text-sm text-slate-700">{styleContext.summary}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" disabled={training} onClick={() => void preparePersonalization()} className="inline-flex min-h-10 items-center rounded-xl bg-ink px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50">{training ? "Preparing locally…" : "Export training examples"}</button>
            <button type="button" onClick={() => { PersonalizationEngine.clear(); setExampleCount(0); setTrainingStatus("Local style examples cleared."); }} className="min-h-10 rounded-xl bg-white/70 px-4 text-sm font-semibold text-slate-700 transition hover:bg-white">Clear style data</button>
          </div>
          {training && <div className="mt-4"><div className="mb-1 flex justify-between text-xs text-slate-600"><span>Idle preparation</span><span>{trainingProgress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-white/60"><div className="h-full rounded-full bg-[#2a78d6] transition-all" style={{ width: `${trainingProgress}%` }} /></div></div>}
          {trainingStatus && <p role="status" className="mt-3 text-xs leading-relaxed text-slate-600">{trainingStatus}</p>}
          <p className="mt-3 text-xs leading-relaxed text-slate-500">This creates a JSONL file of your approved examples. No model weights change in the browser.</p>
        </Panel>

        <Panel title="Persona" tone="butter">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{PersonaKernel.getPromptBlock()}</p>
        </Panel>

        <Panel title="Plugins" aside={<span className="pill-badge">{plugins.length} installed</span>}>
          {plugins.length === 0 ? (
            <p className="text-sm text-slate-500">No plugins installed. Visit the Marketplace to add one; each is reviewed by the Guardian first.</p>
          ) : (
            <ul className="space-y-2">
              {plugins.map((plugin) => (
                <li key={plugin.id} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{plugin.name}</p>
                    <p className="text-xs text-slate-500">v{plugin.version}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={plugin.enabled}
                      aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                      onClick={() => { PluginLoader.toggle(plugin.id, !plugin.enabled); setPlugins(PluginLoader.list()); }}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${plugin.enabled ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}
                    >
                      {plugin.enabled ? "Enabled" : "Disabled"}
                    </button>
                    <button type="button" onClick={() => { PluginLoader.uninstall(plugin.id); setPlugins(PluginLoader.list()); }} className="rounded-lg bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100">Uninstall</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
