import { useEffect, useState } from "react";
import { SyncService } from "../services/SyncService";

export default function SyncStatus() {
  const [status, setStatus] = useState(() => SyncService.getStatus());

  useEffect(() => {
    const refresh = () => setStatus(SyncService.getStatus());
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="text-[8px] text-slate-500">
      {status.encrypted ? "E2E encrypted" : "Not encrypted"} · pending {status.pendingOps} · last sync {status.lastSyncAt ?? "never"}
    </div>
  );
}