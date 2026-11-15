import { GovernedCollectiveIntelligence } from "../services/GovernedCollectiveIntelligence";

export default function CollectiveDashboard() {
  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Collective intelligence</h3>
      <p className="mt-2 text-[10px] text-slate-400">Members: {GovernedCollectiveIntelligence.members.length}</p>
      <p className="mt-1 text-[10px] text-slate-400">Quarantined: {GovernedCollectiveIntelligence.quarantine.length}</p>
    </div>
  );
}