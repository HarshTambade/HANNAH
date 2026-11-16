import { useState, useEffect } from "react";
import { Brain, Activity, Pause, Play, RotateCcw } from "lucide-react";
import { EdgeTuneService } from "../services/EdgeTuneService";

export default function PersonalizationHealthWidget() {
  const [health, setHealth] = useState(() => EdgeTuneService.getHealth());

  useEffect(() => {
    const refresh = () => setHealth(EdgeTuneService.getHealth());
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const handleRun = async () => {
    await EdgeTuneService.runCycle();
    setHealth(EdgeTuneService.getHealth());
  };

  const handlePause = () => {
    EdgeTuneService.pause();
    setHealth(EdgeTuneService.getHealth());
  };

  const handleResume = () => {
    EdgeTuneService.resume();
    setHealth(EdgeTuneService.getHealth());
  };

  const handleReset = () => {
    EdgeTuneService.reset();
    setHealth(EdgeTuneService.getHealth());
  };

  return (
    <div className="bento-card glass-card-strong">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Personalization health</h3>
          <div className="text-[10px] text-slate-500 mt-1">
            EdgeTune adapter status
          </div>
        </div>
        <Brain size={16} className="text-slate-400" />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl border border-slate-100 bg-white px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-slate-500">Version</div>
          <div className="font-display font-bold text-lg text-ink">v{health.currentVersion}</div>
        </div>
        <div className="rounded-xl border border-slate-100 bg-white px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-slate-500">Data Points</div>
          <div className="font-display font-bold text-lg text-ink">{health.totalDataPoints}</div>
        </div>
        <div className="rounded-xl border border-slate-100 bg-white px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-slate-500">Gain</div>
          <div className="font-display font-bold text-lg text-ink">{(health.estimatedGain * 100).toFixed(0)}%</div>
        </div>
        <div className="rounded-xl border border-slate-100 bg-white px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-slate-500">Adapters</div>
          <div className="font-display font-bold text-lg text-ink">{health.activeAdapters}</div>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500">Status</span>
          <span className={`font-bold ${health.paused ? "text-amber-600" : "text-emerald-600"}`}>
            {health.paused ? "Paused" : "Running"}
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500">Battery Impact</span>
          <span className="font-bold text-slate-600">{health.batteryImpact}</span>
        </div>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-slate-500">Thermal Impact</span>
          <span className="font-bold text-slate-600">{health.thermalImpact}</span>
        </div>
        {health.lastRunAt && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-500">Last Run</span>
            <span className="font-bold text-slate-600">{new Date(health.lastRunAt).toLocaleTimeString()}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRun}
          className="flex-1 rounded-lg bg-brand-100 px-3 py-1.5 text-[10px] font-medium text-brand-600 transition hover:bg-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          aria-label="Run personalization cycle"
        >
          <Activity size={12} className="inline mr-1" /> Run
        </button>
        {health.paused ? (
          <button
            type="button"
            onClick={handleResume}
            className="flex-1 rounded-lg bg-emerald-100 px-3 py-1.5 text-[10px] font-medium text-emerald-600 transition hover:bg-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            aria-label="Resume personalization"
          >
            <Play size={12} className="inline mr-1" /> Resume
          </button>
        ) : (
          <button
            type="button"
            onClick={handlePause}
            className="flex-1 rounded-lg bg-amber-100 px-3 py-1.5 text-[10px] font-medium text-amber-600 transition hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            aria-label="Pause personalization"
          >
            <Pause size={12} className="inline mr-1" /> Pause
          </button>
        )}
        <button
          type="button"
          onClick={handleReset}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-medium text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          aria-label="Reset personalization"
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}
