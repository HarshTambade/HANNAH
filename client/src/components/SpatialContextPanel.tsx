import { useEffect, useState } from "react";
import { AmbientPresenceService } from "../services/AmbientPresenceService";

export default function SpatialContextPanel() {
  const [context, setContext] = useState(AmbientPresenceService.context);
  useEffect(() => {
    const timer = window.setInterval(() => setContext({ ...AmbientPresenceService.context }), 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Spatial context</h3>
      <pre className="mt-2 text-[8px] text-slate-500">{JSON.stringify(context)}</pre>
    </div>
  );
}