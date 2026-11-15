import { useEffect, useState } from "react";
import { OversightMetricsService } from "../services/OversightMetricsService";

export default function OversightDashboard() {
  const [trend, setTrend] = useState(OversightMetricsService.trend());

  useEffect(() => {
    const refresh = () => setTrend(OversightMetricsService.trend());
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Oversight dashboard</h3>
      <p className="mt-2 text-[10px] text-slate-400">{trend.length} sessions tracked</p>
      <p className="mt-2 text-[10px] text-emerald-200">{OversightMetricsService.recommend()}</p>
    </div>
  );
}