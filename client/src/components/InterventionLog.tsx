import { useState, useEffect } from "react";
import { Activity, TrendingUp, TrendingDown } from "lucide-react";
import { InterventionTimingEngine, type InterventionProposal } from "../services/InterventionTimingEngine";

export default function InterventionLog() {
  const [log, setLog] = useState<InterventionProposal[]>(() => InterventionTimingEngine.getLog());
  const [metrics, setMetrics] = useState(() => InterventionTimingEngine.getMetrics());

  useEffect(() => {
    const refresh = () => {
      setLog(InterventionTimingEngine.getLog());
      setMetrics(InterventionTimingEngine.getMetrics());
    };
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const decisionIcon = (decision: string) => {
    if (decision === "intervene") return <TrendingUp size={12} className="text-emerald-600" />;
    return <TrendingDown size={12} className="text-slate-400" />;
  };

  return (
    <div className="bento-card glass-card-strong">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Intervention log</h3>
          <div className="text-[10px] text-slate-500 mt-1">
            {metrics.total} proposed · {metrics.interveneRate}% intervened · θ = {metrics.theta}
          </div>
        </div>
        <Activity size={16} className="text-slate-400" />
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
        {log.length === 0 ? (
          <div className="text-[10px] text-slate-500 text-center py-4">No interventions recorded yet.</div>
        ) : (
          log.slice(-10).reverse().map((entry) => (
            <div key={entry.id} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium text-ink truncate">{entry.content.slice(0, 40)}</span>
                <div className="flex items-center gap-1">
                  {decisionIcon(entry.decision)}
                  <span className={`text-[9px] font-bold ${entry.decision === "intervene" ? "text-emerald-600" : "text-slate-400"}`}>
                    {entry.decision}
                  </span>
                </div>
              </div>
              <div className="text-[9px] text-slate-500 mt-1">
                benefit: {entry.benefit.toFixed(2)} · cost: {entry.cost.toFixed(2)} · {entry.type}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[9px] font-bold uppercase text-slate-500">Avg Benefit</div>
          <div className="font-display font-bold text-sm text-ink">{metrics.avgBenefit}</div>
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase text-slate-500">Avg Cost</div>
          <div className="font-display font-bold text-sm text-ink">{metrics.avgCost}</div>
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase text-slate-500">Threshold</div>
          <div className="font-display font-bold text-sm text-ink">{metrics.theta}</div>
        </div>
      </div>
    </div>
  );
}
