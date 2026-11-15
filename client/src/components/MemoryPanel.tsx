import { useEffect, useState } from "react";
import { MemoryService, type MemoryRecord } from "../services/MemoryService";

export default function MemoryPanel() {
  const [records, setRecords] = useState<MemoryRecord[]>(() => MemoryService.list());

  useEffect(() => {
    const refresh = () => setRecords(MemoryService.list());
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-soft">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Memory</h3>
        <button type="button" onClick={() => { MemoryService.resetPersona(); setRecords(MemoryService.list()); }} className="text-[8px] text-rose-600">Reset persona anchors</button>
      </div>
      <div className="mt-3 space-y-2">
        {records.map((record) => (
          <div key={record.id} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[8px] uppercase tracking-[0.14em] text-slate-500">{record.layer}</span>
              <button type="button" onClick={() => { MemoryService.remove(record.id); setRecords(MemoryService.list()); }} className="text-[8px] text-slate-500">Delete</button>
            </div>
            <p className="mt-1 text-[10px] text-slate-600">{record.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
}