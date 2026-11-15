import { useEffect, useState } from "react";
import { AgentNativeHomeService } from "../services/AgentNativeHomeService";

export default function CloudHomeStatus() {
  const [home, setHome] = useState(() => AgentNativeHomeService.home);

  useEffect(() => {
    const timer = window.setInterval(() => setHome(AgentNativeHomeService.home), 3000);
    return () => window.clearInterval(timer);
  }, []);

  if (!home) {
    return <div className="text-[8px] text-slate-500">Cloud home not provisioned.</div>;
  }

  return (
    <div className="text-[8px] text-slate-500">
      Home: {home.region} ({home.provider}) · {home.status} · uptime {home.uptimeSince ? Math.round((Date.now() - home.uptimeSince) / 1000) + "s" : "n/a"} · connections {home.connections.length}
    </div>
  );
}