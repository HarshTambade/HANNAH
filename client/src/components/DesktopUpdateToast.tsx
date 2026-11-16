import { useEffect, useState } from "react";

export default function DesktopUpdateToast() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener("hannah:update-available", handler);
    return () => window.removeEventListener("hannah:update-available", handler);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-ink shadow-soft-lg backdrop-blur-sm">
      An update is available and will install on restart.
    </div>
  );
}
