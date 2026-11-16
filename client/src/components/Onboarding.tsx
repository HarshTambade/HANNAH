import { useState } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles, X, Zap } from "lucide-react";
import type { InferenceMode } from "../types";

type OnboardingProps = {
  onComplete: (result: {
    apiToken: string;
    groqApiKey: string;
    preferredMode: InferenceMode;
  }) => void;
  onSkip: () => void;
};

type OnboardingStep = "privacy" | "credentials" | "hitl" | "complete";

const STEPS: OnboardingStep[] = ["privacy", "credentials", "hitl", "complete"];

export default function Onboarding({ onComplete, onSkip }: OnboardingProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [apiToken, setApiToken] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [preferredMode, setPreferredMode] = useState<InferenceMode>("cloud");
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [acceptedHITL, setAcceptedHITL] = useState(false);

  const step = STEPS[stepIndex];
  const isComplete = stepIndex === STEPS.length - 1;

  const canProceed =
    step === "privacy" ? acceptedPrivacy :
    step === "credentials" ? apiToken.length >= 32 : true;

  const goNext = () => {
    if (stepIndex < STEPS.length - 1) setStepIndex(stepIndex + 1);
    else onComplete({ apiToken, groqApiKey, preferredMode });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-50/80 p-6 backdrop-blur-sm">
      <section className="w-full max-w-md rounded-[2rem] border border-slate-200 bg-white shadow-[0_24px_48px_-8px_rgba(0,0,0,0.10)] p-8">
        <header className="flex items-center justify-between mb-6">
          <h2 className="font-display font-bold text-xl text-ink tracking-tight">Welcome to Shanaya</h2>
          <button
            type="button"
            onClick={onSkip}
            aria-label="Skip onboarding"
            className="rounded-lg border border-slate-100 bg-white p-2 text-slate-500 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
          >
            <X size={16} />
          </button>
        </header>

        {/* Progress indicator */}
        <div className="flex gap-2 mb-8">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-col items-center gap-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                i < stepIndex ? "bg-brand-600 text-white" :
                i === stepIndex ? "bg-brand-50 text-brand-600 border border-brand-200" :
                "bg-slate-100 text-slate-400"
              }`}>
                {i + 1}
              </div>
              <span className={`text-[9px] uppercase tracking-wider ${
                i <= stepIndex ? "font-bold text-slate-600" : "text-slate-400"
              }`}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="mb-8">
          {step === "privacy" && (
            <>
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-violet-100 bg-violet-50 text-violet-600 mb-4">
                <LockKeyhole size={18} />
              </div>
              <h3 className="font-display font-bold text-lg text-ink mb-2">Your privacy comes first</h3>
              <p className="text-[11px] leading-relaxed text-slate-600 mb-4">
                Shanaya processes conversations locally whenever possible. Cloud inference only occurs when you explicitly choose a cloud provider. Your API keys stay in memory for this session and are never stored permanently.
              </p>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acceptedPrivacy}
                  onChange={(e) => setAcceptedPrivacy(e.target.checked)}
                  className="rounded border-slate-200 bg-white text-brand-600 focus:ring-brand-500"
                />
                <span className="text-sm font-medium text-slate-600">I understand Shanaya is a private, local-first AI companion</span>
              </label>
            </>
          )}
          {step === "credentials" && (
            <>
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-violet-100 bg-violet-50 text-violet-600 mb-4">
                <Zap size={18} />
              </div>
              <h3 className="font-display font-bold text-lg text-ink mb-2">Connect your AI provider</h3>
              <p className="text-[11px] leading-relaxed text-slate-600 mb-4">
                Shanaya uses Groq by default for cloud inference. Enter your access token to get started. Local inference (WebLLM/llama.cpp) works without any keys.
              </p>
              <div className="space-y-3">
                <label htmlFor="api-token" className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Shanaya API Access Token</label>
                <input
                  id="api-token"
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder="Enter your Shanaya API token"
                  autoComplete="off"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[11px] text-ink outline-none placeholder:text-slate-400 focus:border-brand-400/60"
                />
                <label htmlFor="groq-key" className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-3">Groq API Key (optional)</label>
                <input
                  id="groq-key"
                  type="password"
                  value={groqApiKey}
                  onChange={(e) => setGroqApiKey(e.target.value)}
                  placeholder="Enter your Groq API key"
                  autoComplete="off"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-[11px] text-ink outline-none placeholder:text-slate-400 focus:border-brand-400/60"
                />
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="radio"
                    value="cloud"
                    checked={preferredMode === "cloud"}
                    onChange={() => setPreferredMode("cloud")}
                    className="rounded border-slate-200 bg-white text-brand-600 focus:ring-brand-500"
                  />
                  <label className="text-[10px] text-slate-600 cursor-pointer">Cloud (Groq)</label>
                  <input
                    type="radio"
                    value="webllm"
                    checked={preferredMode === "webllm"}
                    onChange={() => setPreferredMode("webllm")}
                    className="rounded border-slate-200 bg-white text-brand-600 focus:ring-brand-500"
                  />
                  <label className="text-[10px] text-slate-600 cursor-pointer">Local (WebLLM)</label>
                </div>
              </div>
            </>
          )}
          {step === "hitl" && (
            <>
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-100 bg-amber-50 text-amber-600 mb-4">
                <ShieldCheck size={18} />
              </div>
              <h3 className="font-display font-bold text-lg text-ink mb-2">Human-in-the-Loop approval</h3>
              <p className="text-[11px] leading-relaxed text-slate-600 mb-4">
                Shanaya asks for your approval before performing irreversible actions (file deletion, message sending, shell commands). You can always review and undo actions within a 30-second window.
              </p>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acceptedHITL}
                  onChange={(e) => setAcceptedHITL(e.target.checked)}
                  className="rounded border-slate-200 bg-white text-brand-600 focus:ring-brand-500"
                />
                <span className="text-sm font-medium text-slate-600">I understand Shanaya will request approval for sensitive actions</span>
              </label>
            </>
          )}
          {step === "complete" && (
            <>
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-100 bg-emerald-50 text-emerald-600 mb-4">
                <Sparkles size={18} />
              </div>
              <h3 className="font-display font-bold text-lg text-ink mb-2">You're all set!</h3>
              <p className="text-[11px] leading-relaxed text-slate-600 mb-4">
                Shanaya is ready to assist you. Start chatting to begin your first session.
              </p>
            </>
          )}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between">
          {stepIndex > 0 && (
            <button
              type="button"
              onClick={() => setStepIndex(stepIndex - 1)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
              aria-label="Previous step"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={goNext}
            disabled={!canProceed}
            className={`rounded-lg px-4 py-2 text-[11px] font-bold transition disabled:opacity-40 disabled:cursor-not-allowed ${
              canProceed
                ? "bg-gradient-to-r from-brand-600 to-violet-600 text-white shadow-lg shadow-brand-950/30 hover:brightness-105"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {isComplete ? "Get Started" : "Next"} <ArrowRight size={14} />
          </button>
        </div>
      </section>
    </div>
  );
}
