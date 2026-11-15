import { useState } from "react";
import { ProactiveParticipationService } from "../services/ProactiveParticipationService";

export default function ProactiveSettings() {
  const [paused, setPaused] = useState(ProactiveParticipationService.settings.paused);
  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Proactive participation</h3>
      <label className="mt-2 flex items-center gap-2 text-[10px] text-slate-200">
        <input type="checkbox" checked={paused} onChange={(e) => { setPaused(e.target.checked); ProactiveParticipationService.pause(e.target.checked); }} />
        Pause proactive messages
      </label>
    </div>
  );
}