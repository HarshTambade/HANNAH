import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Lock, Route } from "lucide-react";
import { costLabel, previewRoute, ROUTING_EVENT, type RouteChoice, type RoutePreview } from "../services/ModelRouting";

type Props = {
  /** Show only while the chat model is Auto in cloud mode. */
  enabled: boolean;
  draft: string;
  history: Array<{ role: string; content: string }>;
  providerId: string;
  groqApiKey?: string;
  disabled?: boolean;
  onPreview: (preview: RoutePreview | null) => void;
  onPin: (choice: RouteChoice) => void;
};

/**
 * Before you send, shows which model HANNAH's router would use for the
 * message, why, what it may cost (only from verified prices), its limits, and
 * alternatives you can pin. The preview calls no model.
 */
export default function RoutePreviewChip({ enabled, draft, history, providerId, groqApiKey, disabled, onPreview, onPin }: Props) {
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const historyRef = useRef(history);
  historyRef.current = history;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const text = draft.trim();

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(ROUTING_EVENT, refresh);
    window.addEventListener("hannah:settings", refresh);
    return () => {
      window.removeEventListener(ROUTING_EVENT, refresh);
      window.removeEventListener("hannah:settings", refresh);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !text) {
      setPreview(null);
      setError("");
      onPreviewRef.current(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const messages = [...historyRef.current.filter((item) => item.role === "user" || item.role === "assistant"), { role: "user", content: text }];
      previewRoute(messages, { providerId, groqApiKey, signal: controller.signal })
        .then((next) => {
          setPreview(next);
          setError("");
          onPreviewRef.current(next);
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setPreview(null);
          setError(reason instanceof Error ? reason.message : "HANNAH couldn't preview the route.");
          onPreviewRef.current(null);
        });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [enabled, text, providerId, groqApiKey, revision]);

  if (!enabled || (!preview && !error)) return null;

  if (error) {
    return (
      <p role="status" className="mx-auto mb-1.5 flex w-full min-w-0 max-w-[720px] items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{error}</span>
      </p>
    );
  }
  if (!preview) return null;

  return (
    <div className="mx-auto mb-1.5 w-full min-w-0 max-w-[720px]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Route: ${preview.modeLabel} uses ${preview.providerLabel} ${preview.model}. Show details`}
        className="flex max-w-full items-center gap-1.5 rounded-lg border border-slate-200 bg-white/80 px-2.5 py-1 text-xs text-slate-600 backdrop-blur transition hover:border-brand-200 hover:bg-white"
      >
        {preview.local ? <Lock size={12} className="shrink-0 text-emerald-600" /> : <Route size={12} className="shrink-0 text-brand-500" />}
        <span className="truncate"><span className="font-semibold text-ink">{preview.modeLabel}</span> → {preview.providerLabel} · {preview.model}</span>
        <span className="hidden shrink-0 text-slate-400 sm:inline">· {costLabel(preview.estimate)}</span>
        <ChevronDown size={12} className={`shrink-0 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1.5 max-h-64 overflow-y-auto break-words rounded-xl border border-slate-200 bg-white/90 p-3 text-xs text-slate-600 shadow-soft backdrop-blur">
          <p className="text-slate-700">{preview.reason}</p>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-slate-400">Quality tier</dt><dd>{preview.tier === "unrated" ? "Not profiled" : preview.tier}</dd>
            <dt className="text-slate-400">Cost</dt>
            <dd>
              {costLabel(preview.estimate)}
              {preview.estimate.note ? <span className="block text-slate-400">{preview.estimate.note}</span> : null}
              {preview.estimate.basis === "verified" ? <span className="block text-slate-400">Assumes {preview.estimate.assumption}{preview.estimate.source ? <> · <a className="underline" href={preview.estimate.source} target="_blank" rel="noreferrer">pricing page</a></> : null}</span> : null}
            </dd>
            <dt className="text-slate-400">Data</dt><dd>{preview.local ? "Stays on self-hosted hardware." : `Sent to ${preview.providerLabel}.`}</dd>
          </dl>
          {preview.limitations.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-amber-700">
              {preview.limitations.map((item) => <li key={item}>{item}</li>)}
            </ul>
          )}
          {preview.alternatives.length > 0 && (
            <div className="mt-2.5">
              <p className="mb-1 font-semibold text-slate-700">Alternatives</p>
              <ul className="space-y-1">
                {preview.alternatives.map((choice) => (
                  <li key={`${choice.providerId}/${choice.model}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{choice.providerLabel} · {choice.model} <span className="text-slate-400">· {choice.tier === "unrated" ? "not profiled" : choice.tier} · {costLabel(choice.estimate)}</span></span>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => { setOpen(false); onPin(choice); }}
                      className="shrink-0 rounded-md border border-slate-200 px-2 py-0.5 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                    >
                      Use this
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-slate-400">"Use this" pins the model for this chat. Choose Auto again to let HANNAH route.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
