import { useRegisterSW } from "virtual:pwa-register/react";

export default function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl: string, registration: any) {
      if (registration) {
        setInterval(() => registration.update(), 60 * 60 * 1000);
      }
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-5 left-5 z-40 max-w-sm rounded-2xl border border-slate-200 bg-white p-4 text-slate-800 shadow-soft-lg backdrop-blur-xl">
      <p className="text-sm font-bold text-ink">New version available</p>
      <p className="mt-1 text-xs text-slate-500">Reload to update Shanaya to the latest version.</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => updateServiceWorker(true)}
          className="rounded-lg bg-gradient-to-r from-brand-600 to-violet-600 px-3 py-1.5 text-xs font-bold text-white shadow-soft"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
