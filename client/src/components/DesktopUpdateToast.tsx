import { useEffect, useState } from "react";

export default function DesktopUpdateToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener("shanaya:update-available", handler);
    return () => window.removeEventListener("shanaya:update-available", handler);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-2xl border border-white/10 bg-[#0b0e17]/95 px-4 py-3 text-sm text-slate-100 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl">
      An update is available and will install on restart.
    </div>
  );
}
