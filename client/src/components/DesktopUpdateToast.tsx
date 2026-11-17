import { useEffect, useState } from "react";

type UpdateDetail = { version?: string; channel?: string; releaseNotesUrl?: string };

/** The desktop app downloaded an update: say which version and where its notes are. */
export default function DesktopUpdateToast() {
  const [update, setUpdate] = useState<UpdateDetail | null>(null);

  useEffect(() => {
    const handler = (event: Event) => setUpdate((event as CustomEvent<UpdateDetail>).detail ?? {});
    window.addEventListener("hannah:update-available", handler);
    return () => window.removeEventListener("hannah:update-available", handler);
  }, []);

  if (!update) return null;

  return (
    <div role="status" className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-ink shadow-soft-lg backdrop-blur-sm">
      <span>HANNAH {update.version ?? ""}{update.channel === "beta" ? " (beta)" : ""} is downloaded and installs when you quit.</span>
      {update.releaseNotesUrl && <a href={update.releaseNotesUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-700 underline">What's new</a>}
      <button type="button" onClick={() => setUpdate(null)} className="text-slate-500 hover:text-ink" aria-label="Dismiss">×</button>
    </div>
  );
}
