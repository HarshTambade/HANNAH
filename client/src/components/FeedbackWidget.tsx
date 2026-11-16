import { useState } from "react";
import { MessageSquare, Send, Star, X } from "lucide-react";
import type { InferenceMode } from "../types";
import { submitFeedback, type FeedbackCategory } from "../services/feedback";

type FeedbackWidgetProps = {
  inferenceMode?: InferenceMode;
};

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "idea", label: "Idea" },
  { value: "privacy", label: "Privacy" },
  { value: "other", label: "Other" },
];

export default function FeedbackWidget({ inferenceMode = "cloud" }: FeedbackWidgetProps) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [category, setCategory] = useState<FeedbackCategory>("other");
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!comment.trim() && rating === 0) return;
    setStatus("sending");
    setError("");
    try {
      const message = rating > 0
        ? `Rating: ${rating}/5\n\n${comment.trim()}`
        : comment.trim();
      await submitFeedback({ message, category, inferenceMode });
      setStatus("sent");
      setComment("");
      setRating(0);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Feedback could not be sent.");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open feedback"
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-soft transition hover:scale-105 hover:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
      >
        <MessageSquare size={18} />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Feedback">
          <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 text-slate-800 shadow-soft-lg sm:p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold tracking-tight text-ink">How is your experience?</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close feedback" className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-50 hover:text-ink">
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div className="flex items-center gap-1" role="radiogroup" aria-label="Star rating">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHover(value)}
                    onMouseLeave={() => setHover(0)}
                    aria-label={`${value} star${value > 1 ? "s" : ""}`}
                    className="rounded-md p-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
                  >
                    <Star
                      size={22}
                      className={value <= (hover || rating) ? "fill-amber-400 text-amber-400" : "text-slate-300"}
                    />
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setCategory(item.value)}
                    className={`rounded-full border px-3 py-1 text-xs transition ${
                      category === item.value
                        ? "border-brand-200 bg-brand-50 text-brand-600"
                        : "border-slate-200 bg-white text-slate-600 hover:border-brand-300"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={4}
                placeholder="Tell us what happened, what you expected, or what you would love to see next."
                className="w-full resize-none rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-ink placeholder:text-slate-400 focus:border-brand-300 focus:outline-none"
              />

              {status === "error" ? <p className="text-xs text-rose-600">{error}</p> : null}
              {status === "sent" ? <p className="text-xs text-emerald-600">Thank you. Your feedback was sent.</p> : null}

              <button
                type="submit"
                disabled={status === "sending"}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-4 py-2.5 text-sm font-bold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send size={15} /> {status === "sending" ? "Sending…" : "Send feedback"}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
