import { useEffect, useRef, useState } from "react";
import { Check, Flag, Loader2, ShieldAlert, X } from "lucide-react";
import type { InferenceMode } from "../types";
import {
  CONTENT_REPORT_REASONS,
  reportAIContent,
  wasContentReported,
  type ContentReportReason,
} from "../services/contentReport";

type ReportButtonProps = {
  messageId: string;
  inferenceMode: InferenceMode;
  className?: string;
};

export default function ReportButton({ messageId, inferenceMode, className = "" }: ReportButtonProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "reported">(() => (
    wasContentReported(messageId) ? "reported" : "idle"
  ));
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  if (status === "reported") {
    return (
      <span className={`inline-flex items-center gap-1 text-[9px] font-medium text-emerald-600 ${className}`}>
        <Check size={10} /> Reported
      </span>
    );
  }

  const submit = async (reason: ContentReportReason) => {
    setStatus("sending");
    setError("");
    try {
      await reportAIContent({ messageId, reason, inferenceMode });
      setStatus("reported");
      setOpen(false);
    } catch (reportError) {
      setStatus("idle");
      setError(reportError instanceof Error ? reportError.message : "The report could not be sent.");
    }
  };

  return (
    <div ref={containerRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Report AI content"
        aria-expanded={open}
        title="Report AI content"
        className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[9px] font-medium text-slate-600 transition hover:bg-slate-50 hover:text-ink"
      >
        <Flag size={10} /> Report
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Report AI content"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-60 max-w-[calc(100vw-3rem)] rounded-xl border border-slate-200 bg-white p-3 text-left shadow-soft-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-1.5 text-[10px] font-bold text-ink">
                <ShieldAlert size={12} className="text-amber-200" /> Report this reply
              </p>
              <p className="mt-1 text-[9px] leading-4 text-slate-500">
                Only the message ID and reason are sent. The reply text is not attached.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close report menu"
              className="rounded-md p-0.5 text-slate-500 transition hover:bg-slate-50 hover:text-ink"
            >
              <X size={11} />
            </button>
          </div>

          <div className="mt-2.5 space-y-1">
            {CONTENT_REPORT_REASONS.map((reason) => (
              <button
                key={reason.id}
                type="button"
                disabled={status === "sending"}
                onClick={() => void submit(reason.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left text-[9px] text-slate-600 transition hover:border-brand-300 hover:bg-slate-50 disabled:opacity-50"
              >
                <span>
                  <span className="block font-medium text-ink">{reason.label}</span>
                  <span className="mt-0.5 block text-[8px] leading-3 text-slate-500">{reason.detail}</span>
                </span>
                {status === "sending" && <Loader2 size={10} className="shrink-0 animate-spin text-violet-300" />}
              </button>
            ))}
          </div>

          {error && <p role="alert" className="mt-2 text-[9px] leading-4 text-rose-700">{error}</p>}
        </div>
      )}
    </div>
  );
}
