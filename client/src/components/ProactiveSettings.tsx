import { useState } from "react";
import { Zap } from "lucide-react";
import { ProactiveParticipationService } from "../services/ProactiveParticipationService";

export default function ProactiveSettings() {
  const [paused, setPaused] = useState(ProactiveParticipationService.settings.paused);
  const settings = ProactiveParticipationService.settings;

  return (
    <div className="bento-card glass-card-strong">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-100 bg-amber-50 text-amber-600">
          <Zap size={16} />
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Proactive participation</h3>
          <div className="text-[10px] text-slate-600">HANNAH may proactively surface relevant information</div>
        </div>
      </div>

      <label className="mt-4 flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={paused}
          onChange={(e) => { setPaused(e.target.checked); ProactiveParticipationService.pause(e.target.checked); }}
          className="rounded border-slate-200 bg-white text-brand-600 focus:ring-brand-500"
        />
        <div className="flex-1">
          <div className="flex items-baseline gap-1 text-sm font-medium text-ink">
            <span>Pause proactive messages</span>
            <span className="text-normal font-normal text-slate-500">·</span>
            <span>{paused ? "Paused" : "Active"}</span>
          </div>
          <div className="text-[10px] text-slate-500">
            When paused, HANNAH will not initiate unsolicited suggestions.
          </div>
        </div>
      </label>

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase text-slate-500">Quiet hours</span>
          <span className="text-[10px] text-slate-600 font-medium">
            {settings.quietHours.start}:00 – {settings.quietHours.end}:00
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase text-slate-500">Daily limit</span>
          <span className="text-[10px] text-slate-600 font-medium">{settings.dailyLimit} messages</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase text-slate-500">Weekly limit</span>
          <span className="text-[10px] text-slate-600 font-medium">{settings.weeklyLimit} messages</span>
        </div>
      </div>
    </div>
  );
}
