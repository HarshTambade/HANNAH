import { useState } from "react";
import { ConfigAuditLog } from "../services/ConfigAuditLog";
import { PersonaKernel } from "../services/PersonaKernel";
import { GuardianAgent } from "../services/GuardianAgent";
import MemoryPanel from "./MemoryPanel";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { DynamicFewShotInjector } from "../services/DynamicFewShotInjector";
import { OnDeviceLoRAService } from "../services/OnDeviceLoRAService";

export default function AgentAccountabilityDashboard() {
  const [strictness, setStrictness] = useState(GuardianAgent.strictness);
  const [exampleCount, setExampleCount] = useState(() => PersonalizationEngine.rated().length);
  const [training, setTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState(0);
  const [trainingStatus, setTrainingStatus] = useState("");
  const styleContext = DynamicFewShotInjector.context();

  async function preparePersonalization() {
    setTraining(true);
    setTrainingProgress(0);
    setTrainingStatus("Waiting for an idle window before preparing local examples…");
    try {
      const result = await OnDeviceLoRAService.prepare(setTrainingProgress);
      if (!result.ready) {
        setTrainingStatus("No idle window was available. Keep Shanaya open and try again after a quiet period.");
        return;
      }
      if (!result.examples) {
        setTrainingStatus("No liked, accepted, or edited responses are saved yet. Rate a few replies first.");
        return;
      }
      const blob = new Blob([result.jsonl], { type: "application/jsonl" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "shanaya-personalization.jsonl";
      anchor.click();
      URL.revokeObjectURL(url);
      setTrainingStatus(`Prepared ${result.examples} approved examples as a local JSONL dataset. No model weights were changed; use the backend LoRA scaffold to train a source checkpoint.`);
    } catch (error) {
      setTrainingStatus(error instanceof Error ? error.message : "Could not prepare the local dataset.");
    } finally {
      setTraining(false);
      setExampleCount(PersonalizationEngine.rated().length);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="bento-kicker">Agent accountability</h2>
      <div className="bento-title">Trust & transparency</div>
      <div className="bento-desc mb-6">
        Inspect what Shanaya retains, represents, and initiates. Every change is audited.
      </div>

      <section className="bento-card glass-card-strong">
        <div className="mb-3">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">What the agent retains</h3>
        </div>
        <MemoryPanel />
      </section>

      <section className="bento-card glass-card-strong">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Personalization & local training</h3><p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-600">Liked, accepted, and edited responses are kept on this device. Shanaya uses a few high-rated examples to adapt tone and formatting.</p></div>
          <span className="rounded-full border border-violet-100 bg-violet-50 px-3 py-1 text-[10px] font-semibold text-violet-700">{exampleCount} style examples</span>
        </div>
        {styleContext && <p className="mt-3 rounded-xl border border-slate-100 bg-white/60 p-3 text-[11px] text-slate-600">{styleContext.summary}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" disabled={training} onClick={() => void preparePersonalization()} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 text-xs font-bold text-white shadow-soft transition hover:brightness-105 disabled:opacity-50">{training ? "Preparing locally…" : "Train My Shanaya"}</button><button type="button" onClick={() => { PersonalizationEngine.clear(); setExampleCount(0); setTrainingStatus("Local style examples cleared."); }} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-600">Clear style data</button></div>
        {training && <div className="mt-4"><div className="mb-1 flex justify-between text-[10px] text-slate-500"><span>Idle preparation progress</span><span>{trainingProgress}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-violet-400 transition-all" style={{ width: `${trainingProgress}%` }} /></div></div>}
        {trainingStatus && <p role="status" className="mt-3 text-[10px] leading-relaxed text-slate-500">{trainingStatus}</p>}
        <p className="mt-3 text-[9px] leading-relaxed text-slate-400">The browser prepares approved examples only. GGUF files are inference artifacts; the included Python scaffold trains a compatible source checkpoint and exports a LoRA adapter.</p>
      </section>

      <section className="bento-card glass-card-strong">
        <div className="mb-3">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">What the agent represents</h3>
          <div className="rounded-xl border border-slate-100 bg-white/50 p-3 mt-2 text-[10px] leading-relaxed text-slate-600">
            {PersonaKernel.getPromptBlock()}
          </div>
        </div>
      </section>

      <section className="bento-card glass-card-strong">
        <div className="mb-3">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Guardian strictness</h3>
          <select
            value={strictness}
            onChange={(e) => {
              const value = e.target.value as typeof strictness;
              setStrictness(value);
              GuardianAgent.setStrictness(value);
              ConfigAuditLog.record("guardian", { strictness: value });
            }}
            className="mt-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 outline-none focus:border-brand-400/60"
          >
            <option value="permissive">Permissive</option>
            <option value="balanced">Balanced</option>
            <option value="strict">Strict</option>
          </select>
        </div>
      </section>

      <section className="bento-card glass-card-strong">
        <div className="mb-3">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Configuration audit log</h3>
          <div className="mt-2 text-[10px] text-slate-600">
            {ConfigAuditLog.list().length} changes recorded
          </div>
        </div>
      </section>
    </div>
  );
}
