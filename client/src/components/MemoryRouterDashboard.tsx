import { useEffect, useState } from "react";
import { MemoryRouter } from "../services/MemoryRouter";

export default function MemoryRouterDashboard() {
  const [metrics, setMetrics] = useState(() => MemoryRouter.metrics());
  const [log, setLog] = useState(() => MemoryRouter.getRoutingLog().slice(-10));

  useEffect(() => {
    const refresh = () => {
      setMetrics(MemoryRouter.metrics());
      setLog(MemoryRouter.getRoutingLog().slice(-10));
    };
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Memory router</h3>
      <div className="mt-3 space-y-2 text-[9px]">
        <div className="flex justify-between">
          <span className="text-slate-500">Queries routed</span>
          <span className="text-ink">{metrics.total}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Factual (vector)</span>
          <span className="text-cyan-600">{metrics.factualPct}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Associative (graph)</span>
          <span className="text-violet-600">{metrics.associativePct}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Complex (hybrid)</span>
          <span className="text-emerald-600">{metrics.complexPct}%</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Avg latency</span>
          <span className="text-ink">{metrics.avgLatencyMs}ms</span>
        </div>
      </div>
      <div className="mt-3 border-t border-white/[0.06] pt-2">
        <p className="text-[8px] text-slate-400 mb-1">Recent routing decisions</p>
        <div className="space-y-1">
          {log.map((entry) => (
            <div key={entry.at} className="flex justify-between text-[8px]">
              <span className="text-slate-500 truncate" title={entry.query}>{entry.query.slice(0, 30)}</span>
              <span className="text-ink">{entry.path} ({entry.latencyMs}ms)</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}