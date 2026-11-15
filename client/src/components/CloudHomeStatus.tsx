import { useEffect, useState } from "react";
import { AgentNativeHomeService } from "../services/AgentNativeHomeService";

export default function CloudHomeStatus() {
  const [home, setHome] = useState(() => AgentNativeHomeService.home);

  useEffect(() => {
    const timer = window.setInterval(() => setHome({ ...AgentNativeHomeService.home }), 3000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="text-[8px] text-slate-400">
      Home: {home.region} · uptime {Math.round((Date.now() - home.uptime) / 1000)}s · connections {home.connections.length}
    </div>
  );
}