import { useState } from "react";
import { ConfigAuditLog } from "../services/ConfigAuditLog";
import { PersonaKernel } from "../services/PersonaKernel";
import { GuardianAgent } from "../services/GuardianAgent";
import MemoryPanel from "./MemoryPanel";

export default function AgentAccountabilityDashboard() {
  const [strictness, setStrictness] = useState(GuardianAgent.strictness);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-slate-500">Agent accountability</h2>
      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">What the agent retains</h3>
        <MemoryPanel />
      </section>
      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">What the agent represents</h3>
        <p className="mt-2 text-[10px] text-slate-600">{PersonaKernel.getPromptBlock()}</p>
      </section>
      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Guardian strictness</h3>
        <select value={strictness} onChange={(e) => { const value = e.target.value as typeof strictness; setStrictness(value); GuardianAgent.setStrictness(value); ConfigAuditLog.record("guardian", { strictness: value }); }} className="mt-2 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600">
          <option value="permissive">permissive</option>
          <option value="balanced">balanced</option>
          <option value="strict">strict</option>
        </select>
      </section>
      <section className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Configuration audit log</h3>
        <p className="mt-2 text-[10px] text-slate-500">{ConfigAuditLog.list().length} changes recorded</p>
      </section>
    </div>
  );
}