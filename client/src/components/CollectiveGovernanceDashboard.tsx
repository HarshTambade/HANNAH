import { useEffect, useState } from "react";
import { TypedRails } from "../services/TypedRails";

export default function CollectiveGovernanceDashboard() {
  const [metrics, setMetrics] = useState(() => TypedRails.metrics());
  const [audit, setAudit] = useState(() => TypedRails.getAudit().slice(-10));

  useEffect(() => {
    const refresh = () => {
      setMetrics(TypedRails.metrics());
      setAudit(TypedRails.getAudit().slice(-10));
    };
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0b0f19]/70 p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Collective governance</h3>
      <div className="mt-3 space-y-2 text-[9px]">
        <div className="flex justify-between">
          <span className="text-slate-400">Rail decisions</span>
          <span className="text-slate-200">{metrics.total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Allowed</span>
          <span className="text-emerald-200">{metrics.allowed}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Blocked</span>
          <span className="text-rose-200">{metrics.blocked}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Approval required</span>
          <span className="text-amber-200">{metrics.approvalRequired}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Block rate</span>
          <span className="text-slate-200">{metrics.blockRate}%</span>
        </div>
      </div>
      <div className="mt-3 border-t border-white/[0.06] pt-2">
        <p className="text-[8px] text-slate-500 mb-1">Recent enforcement</p>
        <div className="space-y-1">
          {audit.map((entry) => (
            <div key={entry.at} className="flex justify-between text-[8px]">
              <span className="text-slate-400 truncate" title={entry.context.tool}>{entry.context.tool}</span>
              <span
                className={`text-[8px] ${entry.result.allowed ? "text-emerald-200" : "text-rose-200"}`}
              >
                {entry.result.allowed ? "allowed" : "blocked"} (tier {entry.result.tier})
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}