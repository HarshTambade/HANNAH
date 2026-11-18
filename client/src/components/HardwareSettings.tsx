import { useState } from "react";
import { HardwareBridgeService } from "../services/HardwareBridgeService";

export default function HardwareSettings() {
  const [deviceId, setDeviceId] = useState("");
  const [status, setStatus] = useState("");
  const pair = async () => {
    try {
      const device = await HardwareBridgeService.pair(deviceId);
      setStatus(`Paired with ${device.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Hardware</h3>
      <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="wss://device.local:8765#pairing-code" aria-label="Device address and pairing code" className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-600 outline-none focus:border-brand-400/60" />
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => void pair()} className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-[8px] text-slate-600 hover:bg-slate-50">Pair</button>
        <button type="button" onClick={() => { HardwareBridgeService.unpair(); setStatus("Unpaired."); }} className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-[8px] text-slate-600 hover:bg-slate-50">Unpair</button>
      </div>
      {status && <p role="status" className="mt-2 text-[10px] text-slate-600">{status}</p>}
    </div>
  );
}