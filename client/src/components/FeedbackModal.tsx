import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Bug, CheckCircle2, Lightbulb, Loader2, LockKeyhole, MessageCircle,
  MessageSquarePlus, Send, ShieldCheck, X,
} from "lucide-react";
import type { InferenceMode } from "../types";
import { coarseInferenceMode, detectPlatform, getAppVersion } from "../services/appInfo";
import { submitFeedback, type FeedbackCategory } from "../services/feedback";

type FeedbackModalProps = {
  open: boolean;
  onClose: () => void;
  inferenceMode: InferenceMode;
};

const categories: Array<{ id: FeedbackCategory; label: string; icon: typeof Bug }> = [
  { id: "bug", label: "Something broke", icon: Bug },
  { id: "idea", label: "An idea", icon: Lightbulb },
  { id: "privacy", label: "Privacy concern", icon: LockKeyhole },
  { id: "other", label: "Other", icon: MessageCircle },
];

export default function FeedbackModal({ open, onClose, inferenceMode }: FeedbackModalProps) {
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusRef = useRef(status);
  const onCloseRef = useRef(onClose);
  statusRef.current = status;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // Reset only when the dialog is (re)opened; changing status to "sent" must
    // not re-run this effect or the success screen would immediately clear.
    setStatus("idle");
    setError("");
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 40);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && statusRef.current !== "sending") onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!open) return null;

  const platform = detectPlatform();
  const version = getAppVersion();
  const mode = coarseInferenceMode(inferenceMode);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim() || status === "sending") return;
    setStatus("sending");
    setError("");
    try {
      await submitFeedback({ message, category, inferenceMode });
      setStatus("sent");
      setMessage("");
    } catch (submissionError) {
      setStatus("error");
      setError(submissionError instanceof Error ? submissionError.message : "Feedback could not be sent.");
    }
  }

  const close = () => {
    if (status !== "sending") onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-[#03050b]/80 p-4 backdrop-blur-md"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="relative my-auto w-full max-w-lg overflow-hidden rounded-3xl border border-white/[0.1] bg-[#0d111d] shadow-[0_30px_100px_rgba(0,0,0,0.7)]"
      >
        <div className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-violet-500/15 blur-[90px]" />
        <div className="relative p-5 sm:p-7">
          <button
            type="button"
            aria-label="Close feedback"
            onClick={close}
            disabled={status === "sending"}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] text-slate-400 transition hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={15} />
          </button>

          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-violet-200/15 bg-violet-200/[0.07] text-violet-100">
            <MessageSquarePlus size={18} />
          </span>
          <p className="mt-5 text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100/70">Help Shanaya grow</p>
          <h2 id="feedback-title" className="mt-2 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-white">Send a note.</h2>
          <p className="mt-2 text-[11px] leading-6 text-slate-400">
            Report a rough edge, ask for a feature, or tell us how the conversation felt.
          </p>

          {status === "sent" ? (
            <div className="mt-6 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.06] p-5 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-emerald-300/25 bg-emerald-300/10 text-emerald-200">
                <CheckCircle2 size={22} />
              </span>
              <h3 className="mt-4 font-['Manrope'] text-base font-semibold text-white">Your note is on its way.</h3>
              <p className="mt-2 text-[11px] leading-6 text-slate-400">
                Thank you. Feedback is reviewed by the Shanaya team and is never attached to your conversation.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 px-5 text-[11px] font-bold text-[#090d1a] transition hover:brightness-105"
              >
                Close <Send size={13} />
              </button>
            </div>
          ) : (
            <form className="mt-5" onSubmit={handleSubmit}>
              <fieldset>
                <legend className="mb-2 block text-[10px] font-semibold text-slate-200">What kind of note is this?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {categories.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCategory(id)}
                      aria-pressed={category === id}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[10px] font-medium transition ${category === id ? "border-violet-300/35 bg-violet-300/[0.1] text-violet-100" : "border-white/[0.07] bg-white/[0.02] text-slate-400 hover:border-white/[0.14] hover:text-slate-200"}`}
                    >
                      <Icon size={14} /> {label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label htmlFor="feedback-message" className="mb-2 mt-4 block text-[10px] font-semibold text-slate-200">Your message</label>
              <textarea
                ref={textareaRef}
                id="feedback-message"
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value.slice(0, 4000));
                  if (status === "error") setStatus("idle");
                  setError("");
                }}
                rows={5}
                maxLength={4000}
                required
                placeholder="What happened, or what would make Shanaya better?"
                className="w-full resize-none rounded-2xl border border-white/[0.09] bg-[#080b13] px-3.5 py-3 text-xs leading-6 text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-violet-300/40"
              />
              <div className="mt-1.5 flex items-center justify-between text-[9px] text-slate-500">
                <span>Please don’t include passwords, API keys, or private chat text.</span>
                <span className="font-mono">{message.length}/4000</span>
              </div>

              <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-500">Attached automatically</p>
                <p className="mt-1.5 text-[10px] leading-5 text-slate-400">
                  App v{version} · {platform} · {mode} inference{inferenceMode !== "cloud" ? ` (${inferenceMode})` : ""}
                </p>
                <p className="mt-1 flex items-start gap-1.5 text-[9px] leading-5 text-slate-500">
                  <ShieldCheck size={12} className="mt-0.5 shrink-0 text-emerald-300/80" />
                  No IP address, account, device identifier, or chat history is attached.
                </p>
              </div>

              {error && (
                <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300/20 bg-rose-300/[0.06] px-3 py-2.5 text-[10px] leading-5 text-rose-200">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}

              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={status === "sending"}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-[10px] font-semibold text-slate-400 transition hover:bg-white/[0.04] hover:text-white disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!message.trim() || status === "sending"}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 px-5 text-[11px] font-bold text-[#090d1a] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {status === "sending" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {status === "sending" ? "Sending…" : "Send feedback"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
