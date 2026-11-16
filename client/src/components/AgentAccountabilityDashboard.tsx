import { useState } from "react";
import { ConfigAuditLog } from "../services/ConfigAuditLog";
import { PersonaKernel } from "../services/PersonaKernel";
import { GuardianAgent } from "../services/GuardianAgent";
import MemoryPanel from "./MemoryPanel";

export default function AgentAccountabilityDashboard() {
  const [strictness, setStrictness] = useState(GuardianAgent.strictness);

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
