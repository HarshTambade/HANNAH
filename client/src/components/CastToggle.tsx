import { useState } from "react";
import { CastOrchestrator } from "../services/CastOrchestrator";

export default function CastToggle() {
  const [mode, setMode] = useState(CastOrchestrator.mode);
  return (
    <button type="button" onClick={() => { const next = mode === "solo" ? "cast" : "solo"; setMode(next); CastOrchestrator.setMode(next); }} className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-[8px] text-slate-600 hover:bg-slate-50">
      {mode === "solo" ? "Solo" : "Cast"}
    </button>
  );
}