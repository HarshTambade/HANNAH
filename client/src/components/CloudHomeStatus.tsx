import { useEffect, useState } from "react";
import { AgentNativeHomeService } from "../services/AgentNativeHomeService";

export default function CloudHomeStatus() {
  const [home, setHome] = useState(() => AgentNativeHomeService.home);

  useEffect(() => {
    const timer = window.setInterval(() => setHome(AgentNativeHomeService.home), 3000);
    return () => window.clearInterval(timer);
  }, []);

  if (!home) {
    return <div className="text-[8px] text-slate-500">No HANNAH server checked yet.</div>;
  }

  return (
    <div className="text-[8px] text-slate-500">
      Server: {home.region} ({home.provider}) · {home.status}
      {home.health?.error ? ` · ${home.health.error}` : home.health ? ` · AI ${home.health.ready ? "ready" : "not set up"} · accounts ${home.health.accounts ? "on" : "off"} · ${home.health.latencyMs} ms` : ""}
      {" "}· connections {home.connections.length}
    </div>
  );
}