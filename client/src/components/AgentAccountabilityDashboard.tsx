import { useState } from "react";
import { ConfigAuditLog } from "../services/ConfigAuditLog";
import { PersonaKernel } from "../services/PersonaKernel";
import { GuardianAgent } from "../services/GuardianAgent";
import MemoryPanel from "./MemoryPanel";

export default function AgentAccountabilityDashboard() {
  const [strictness, setStrictness] = useState(GuardianAgent.strictness);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-slate-200">Agent accountability</h2>
      <section className="rounded-2xl border border-white/[0.08] p-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">What the agent retains</h3>
        <MemoryPanel />
      </section>
      <section className="rounded-2xl border border-white/[0.08] p-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">What the agent represents</h3>
        <p className="mt-2 text-[10px] text-slate-200">{PersonaKernel.getPromptBlock()}</p>
      </section>
      <section className="rounded-2xl border border-white/[0.08] p-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Guardian strictness</h3>
        <select value={strictness} onChange={(e) => { const value = e.target.value as typeof strictness; setStrictness(value); GuardianAgent.setStrictness(value); ConfigAuditLog.record("guardian", { strictness: value }); }} className="mt-2 rounded-lg border border-white/[0.08] bg-transparent px-2 py-1 text-[10px] text-slate-200">
          <option value="permissive">permissive</option>
          <option value="balanced">balanced</option>
          <option value="strict">strict</option>
        </select>
      </section>
      <section className="rounded-2xl border border-white/[0.08] p-4">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Configuration audit log</h3>
        <p className="mt-2 text-[10px] text-slate-400">{ConfigAuditLog.list().length} changes recorded</p>
      </section>
    </div>
  );
}