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
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Oversight dashboard</h3>
      <p className="mt-2 text-[10px] text-slate-500">{trend.length} sessions tracked</p>
      <p className="mt-2 text-[10px] text-emerald-600">{OversightMetricsService.recommend()}</p>
    </div>
  );
}