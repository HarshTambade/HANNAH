import { useState, useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import { SideEffectLedger, type SideEffectEntry } from "../services/SideEffectLedger";

type HITLApprovalCardProps = {
  onDismiss?: () => void;
};

export default function HITLApprovalCard({ onDismiss }: HITLApprovalCardProps = {}) {
  const [pending, setPending] = useState<SideEffectEntry[]>([]);

  useEffect(() => {
    const refresh = () => setPending(SideEffectLedger.pendingUndoable());
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (pending.length === 0) return null;

  return (
    <div
      className="mx-6 mb-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 shadow-soft-lg animate-slideInFade"
      role="alert"
      aria-live="polite"
      aria-labelledby="hitl-title"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-200 bg-amber-100 text-amber-600 shrink-0">
          <ShieldAlert size={14} />
        </div>
        <div className="flex-1">
          <h3 id="hitl-title" className="text-xs font-bold uppercase tracking-[0.15em] text-amber-700 mb-1">
            Shanaya requests approval
          </h3>
          <div className="space-y-2">
            {pending.map((entry) => (
              <div key={entry.id} className="text-[11px] leading-5 text-amber-600">
                <div className="flex items-baseline gap-1 text-amber-700 font-medium">
                  <span>{entry.action}</span>
                  <span className="text-normal font-normal text-amber-500">·</span>
                  <span className="font-mono text-xs">{entry.target}</span>
                </div>
                <div className="text-[9px] text-amber-500">
                  Undoable until{" "}
                  <span className="font-medium">
                    {new Date(entry.undoableUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-end gap-2">
            <button
              type="button"
              onClick={() => {
                pending.forEach((entry) => SideEffectLedger.undo(entry.id));
                setPending([]);
                onDismiss?.();
              }}
              className="px-4 py-1.5 rounded-lg border border-amber-200 bg-white text-amber-700 font-medium text-xs hover:bg-amber-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              aria-label="Reject all pending actions"
            >
              Reject All
            </button>
            <button
              type="button"
              onClick={() => {
                pending.forEach((entry) => SideEffectLedger.markExecuted(entry.id));
                setPending([]);
                onDismiss?.();
              }}
              className="px-4 py-1.5 rounded-lg bg-amber-600 text-white font-medium text-xs hover:bg-amber-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              aria-label="Approve all pending actions"
            >
              Approve All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
