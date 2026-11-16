import { useEffect, useState } from "react";
import { ShieldCheck, Workflow, X } from "lucide-react";
import { AUTOMATION_OUTPUT_EVENT, type AutomationOutput } from "../services/AutomationService";

type Toast = AutomationOutput & { id: number };

/** Results and approval requests from automations, shown on every app screen. */
export function AutomationToasts({ onOpen }: { onOpen: () => void }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let next = 0;
    const onOutput = (event: Event) => {
      const detail = (event as CustomEvent<AutomationOutput>).detail;
      if (!detail) return;
      // Tells the automation runner the result was shown here.
      event.preventDefault();
      next += 1;
      const id = next;
      setToasts((current) => [...current.slice(-2), { ...detail, id }]);
    };
    window.addEventListener(AUTOMATION_OUTPUT_EVENT, onOutput);
    return () => window.removeEventListener(AUTOMATION_OUTPUT_EVENT, onOutput);
  }, []);
  if (!toasts.length) return null;
  const dismiss = (id: number) => setToasts((current) => current.filter((item) => item.id !== id));
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-20 z-[70] flex flex-col items-center gap-2 sm:inset-x-auto sm:bottom-4 sm:right-5 sm:items-end">
      {toasts.map((toast) => (
        <section
          key={toast.id}
          role={toast.kind === "approval" ? "alert" : "status"}
          aria-label="Automation"
          className={`pointer-events-auto w-full max-w-sm rounded-2xl border p-4 shadow-[0_24px_60px_-30px_rgba(38,44,74,0.55)] backdrop-blur ${toast.kind === "approval" ? "border-amber-200 bg-amber-50/95" : "border-violet-200 bg-white/95"}`}
        >
          <div className="flex items-start justify-between gap-3">
            <p className={`flex min-w-0 items-center gap-2 text-xs font-semibold ${toast.kind === "approval" ? "text-amber-900" : "text-violet-900"}`}>
              {toast.kind === "approval" ? <ShieldCheck size={14} /> : <Workflow size={14} />}
              <span className="truncate">{toast.title}</span>
            </p>
            <button type="button" className="-m-1 rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-ink" onClick={() => dismiss(toast.id)} aria-label="Dismiss"><X size={14} /></button>
          </div>
          <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-sm leading-5 text-ink">{toast.body}</p>
          <div className="mt-3">
            <button type="button" className={toast.kind === "approval" ? "btn-primary !py-1.5" : "btn-outline !py-1.5"} onClick={() => { dismiss(toast.id); onOpen(); }}>
              {toast.kind === "approval" ? "Review in Automations" : "Open Automations"}
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
