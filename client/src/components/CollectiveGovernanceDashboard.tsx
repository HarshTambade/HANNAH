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
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Collective governance</h3>
      <div className="mt-3 space-y-2 text-[9px]">
        <div className="flex justify-between">
          <span className="text-slate-500">Rail decisions</span>
          <span className="text-ink">{metrics.total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Allowed</span>
          <span className="text-emerald-600">{metrics.allowed}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Blocked</span>
          <span className="text-rose-600">{metrics.blocked}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Approval required</span>
          <span className="text-amber-600">{metrics.approvalRequired}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Block rate</span>
          <span className="text-ink">{metrics.blockRate}%</span>
        </div>
      </div>
      <div className="mt-3 border-t border-white/[0.06] pt-2">
        <p className="text-[8px] text-slate-400 mb-1">Recent enforcement</p>
        <div className="space-y-1">
          {audit.map((entry) => (
            <div key={entry.at} className="flex justify-between text-[8px]">
              <span className="text-slate-500 truncate" title={entry.context.tool}>{entry.context.tool}</span>
              <span
                className={`text-[8px] ${entry.result.allowed ? "text-emerald-600" : "text-rose-600"}`}
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