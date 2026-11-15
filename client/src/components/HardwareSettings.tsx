import { useState } from "react";
import { HardwareBridgeService } from "../services/HardwareBridgeService";

export default function HardwareSettings() {
  const [deviceId, setDeviceId] = useState("");
  return (
    <div className="rounded-2xl border border-white/[0.08] p-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-300">Hardware</h3>
      <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="device id" className="mt-2 w-full rounded-lg border border-white/[0.08] bg-transparent px-2 py-1 text-[10px] text-slate-200" />
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => HardwareBridgeService.pair(deviceId)} className="rounded-lg border border-white/[0.08] px-3 py-1 text-[8px] text-slate-200">Pair</button>
        <button type="button" onClick={() => HardwareBridgeService.unpair()} className="rounded-lg border border-white/[0.08] px-3 py-1 text-[8px] text-slate-200">Unpair</button>
      </div>
    </div>
  );
}