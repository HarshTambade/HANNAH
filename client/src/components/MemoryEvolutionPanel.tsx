import { useEffect, useState } from "react";
import { MemoryEvolutionEngine } from "../services/MemoryEvolutionEngine";
import { EmotionalStateModel } from "../services/EmotionalStateModel";

export default function MemoryEvolutionPanel() {
  const [userModel, setUserModel] = useState(() => MemoryEvolutionEngine.getUserModel());
  const [timeline, setTimeline] = useState(() => EmotionalStateModel.trajectory(7));

  useEffect(() => {
    const refresh = () => {
      setUserModel(MemoryEvolutionEngine.getUserModel());
      setTimeline(EmotionalStateModel.trajectory(7));
    };
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">User model</h3>
      <pre className="mt-2 whitespace-pre-wrap text-[10px] text-slate-600">{userModel || "No model yet."}</pre>
      <h3 className="mt-4 text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Emotional timeline (7d)</h3>
      <p className="mt-2 text-[10px] text-slate-500">{timeline.length} events</p>
    </div>
  );
}