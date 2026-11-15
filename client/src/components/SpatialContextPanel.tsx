import { useEffect, useState } from "react";
import { AmbientPresenceService } from "../services/AmbientPresenceService";

export default function SpatialContextPanel() {
  const [context, setContext] = useState(AmbientPresenceService.context);
  useEffect(() => {
    const timer = window.setInterval(() => setContext({ ...AmbientPresenceService.context }), 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Spatial context</h3>
      <pre className="mt-2 text-[8px] text-slate-400">{JSON.stringify(context)}</pre>
    </div>
  );
}