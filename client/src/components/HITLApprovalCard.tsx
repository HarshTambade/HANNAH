import { useState, useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";
import { SideEffectLedger, type SideEffectEntry } from "../services/SideEffectLedger";

type HITLApprovalCardProps = {
  onDismiss?: () => void;
};

function describe(action: string) {
  return action.replace(/^(safety_guard|desktop):/, "").replaceAll("_", " ");
}

/**
 * Every sensitive tool already asks for confirmation before it runs. This card
 * is the receipt: it lists actions the user approved in the last few seconds
 * so nothing happens out of sight. It never claims to be able to undo them.
 */
export default function HITLApprovalCard({ onDismiss }: HITLApprovalCardProps = {}) {
  const [recent, setRecent] = useState<SideEffectEntry[]>([]);

  useEffect(() => {
    const refresh = () => setRecent(SideEffectLedger.pendingUndoable());
    refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (recent.length === 0) return null;

  const dismiss = () => {
    recent.forEach((entry) => SideEffectLedger.markExecuted(entry.id));
    setRecent([]);
    onDismiss?.();
  };

  return (
    <div className="mx-1 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 sm:mx-9" role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-600">
          <ShieldCheck size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-emerald-800">You approved {recent.length === 1 ? "this action" : `${recent.length} actions`}</p>
          <ul className="mt-1 space-y-0.5">
            {recent.map((entry) => (
              <li key={entry.id} className="truncate text-xs text-emerald-700">
                <span className="font-medium capitalize">{describe(entry.action)}</span>
                {entry.target && entry.target !== entry.action && <span className="text-emerald-600"> · {entry.target}</span>}
                <span className="text-emerald-500"> · {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        </div>
        <button type="button" onClick={dismiss} aria-label="Dismiss approved actions" className="rounded-lg p-1.5 text-emerald-600 transition hover:bg-emerald-100">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
