import { useState } from "react";
import { CastOrchestrator } from "../services/CastOrchestrator";

export default function CastToggle() {
  const [mode, setMode] = useState(CastOrchestrator.mode);
  return (
    <button type="button" onClick={() => { const next = mode === "solo" ? "cast" : "solo"; setMode(next); CastOrchestrator.setMode(next); }} className="rounded-lg border border-white/[0.08] px-3 py-1 text-[8px] text-slate-200">
      {mode === "solo" ? "Solo" : "Cast"}
    </button>
  );
}