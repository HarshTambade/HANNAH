import { useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, Cloud, Cpu, Download,
  Eye, EyeOff, FileCheck2, Fingerprint, HardDrive, KeyRound, LockKeyhole, MessageCircle,
  ShieldCheck, Sparkles, TriangleAlert, Wifi,
} from "lucide-react";
import { getOfflineModelStatus, prepareOfflineModel, type OfflineModelStatus } from "../services/AIService";
import type { InferenceMode } from "../types";

export type OnboardingPreferredMode = Extract<InferenceMode, "cloud" | "webllm" | "native" | "ollama">;

export type OnboardingResult = {
  apiToken: string;
  groqApiKey: string;
  preferredMode: OnboardingPreferredMode;
  profile: {
    name: string;
    voicePitch: "low" | "medium" | "high";
    memoryAnchor: string;
  };
};

type OnboardingProps = {
  onComplete: (result: OnboardingResult) => void;
  onSkip: () => void;
};

const TOTAL_STEPS = 4;

const privacyPoints = [
  {
    icon: HardDrive,
    title: "Local when you choose local",
    body: "On-device and Ollama inference keep your conversation on your hardware. Nothing is sent to a cloud provider in those modes.",
  },
  {
    icon: KeyRound,
    title: "Keys live in memory",
    body: "A Groq key you enter stays in this app session. It is forwarded only to Groq requests, never written to browser storage.",
  },
  {
    icon: Fingerprint,
    title: "No training on your chats",
    body: "Shanaya does not build a profile from your conversations. Optional error reports and feedback are metadata-minimal and scrubbed.",
  },
  {
    icon: ShieldCheck,
    title: "You stay in control",
    body: "Every tool action is a proposal. You approve or reject it before anything reaches your files, apps, or the web.",
  },
];

function isLocalDevelopment() {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
}

export default function Onboarding({ onComplete, onSkip }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<"cloud" | "local">("cloud");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [localChoice, setLocalChoice] = useState<"native" | "webllm" | "ollama" | null>(null);
  const [profileName, setProfileName] = useState("");
  const [voicePitch, setVoicePitch] = useState<"low" | "medium" | "high">("medium");
  const [memoryAnchor, setMemoryAnchor] = useState("");
  const [modelStatus, setModelStatus] = useState<OfflineModelStatus>("checking");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  const platform = Capacitor.getPlatform();
  const isNative = platform === "ios" || platform === "android";
  const modelUrl = import.meta.env.VITE_OFFLINE_MODEL_URL?.trim();
  const supportsWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const canDownloadModel = isNative && Boolean(modelUrl);

  useEffect(() => {
    let active = true;
    if (!isNative) {
      setModelStatus("unavailable");
      return;
    }
    void getOfflineModelStatus().then((status) => {
      if (!active) return;
      setModelStatus(status);
      if (status === "available") setLocalChoice((current) => current || "native");
    }).catch(() => {
      if (active) setModelStatus("unavailable");
    });
    return () => { active = false; };
  }, [isNative]);

  const contextualMode = useMemo<OnboardingPreferredMode>(() => {
    if (path === "cloud") return "cloud";
    if (localChoice === "native") return "native";
    if (localChoice === "webllm") return "webllm";
    return "ollama";
  }, [path, localChoice]);

  function validateCloudCredentials() {
    const token = apiToken.trim();
    const key = groqApiKey.trim();
    if (key && !/^gsk_[A-Za-z0-9_-]{20,}$/.test(key)) {
      return "That doesn’t look like a Groq key. Keys usually start with gsk_ and are at least 20 characters.";
    }
    if (token && (token.length < 32 || token.length > 512 || /\s/.test(token))) {
      return "The server access token must be 32–512 characters without spaces.";
    }
    if ((token || key) && !window.isSecureContext && !isLocalDevelopment()) {
      return "Connect over HTTPS before entering an access token or API key.";
    }
    const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim();
    if (configuredApiUrl) {
      try {
        const apiOrigin = new URL(configuredApiUrl, window.location.href);
        const localApi = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiOrigin.hostname);
        if (apiOrigin.protocol !== "https:" && !localApi) {
          return "This app’s API server must use HTTPS before credentials can be sent.";
        }
      } catch {
        return "The configured Shanaya API address is invalid.";
      }
    }
    return "";
  }

  async function downloadModel() {
    setError("");
    setDownloadProgress(0);
    try {
      await prepareOfflineModel((progress) => setDownloadProgress(progress));
      setModelStatus("available");
      setLocalChoice("native");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "The local model could not be downloaded.");
    } finally {
      setDownloadProgress(null);
    }
  }

  function nextFromSetup() {
    setError("");
    if (path === "cloud") {
      const validationError = validateCloudCredentials();
      if (validationError) {
        setError(validationError);
        return;
      }
      setStep(2);
      return;
    }
    if (!localChoice) {
      setError("Choose how Shanaya should run locally before continuing.");
      return;
    }
    if (localChoice === "native" && modelStatus !== "available") {
      setError("Download the offline model first, or choose browser-local AI or Ollama.");
      return;
    }
    setStep(2);
  }

  function finish() {
    const profile = {
      name: profileName.trim(),
      voicePitch,
      memoryAnchor: memoryAnchor.trim(),
    };
    try {
      window.localStorage.setItem("shanaya.profile.v1", JSON.stringify(profile));
    } catch {
      // Best effort.
    }
    if (path === "cloud") {
      onComplete({ apiToken: apiToken.trim(), groqApiKey: groqApiKey.trim(), preferredMode: "cloud", profile });
      return;
    }
    onComplete({ apiToken: "", groqApiKey: "", preferredMode: contextualMode, profile });
  }

  const primaryButton = "group inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-200 to-violet-300 px-5 text-[11px] font-bold text-[#090d1a] shadow-[0_10px_40px_rgba(111,119,255,0.18)] transition hover:-translate-y-0.5 hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100/70";

  return (
    <main className="onboarding-page relative h-[100dvh] overflow-y-auto bg-[#070a13] text-slate-100 selection:bg-cyan-300/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-44 top-20 h-[34rem] w-[34rem] rounded-full bg-indigo-600/[0.14] blur-[150px]" />
        <div className="absolute -right-44 top-[34rem] h-[34rem] w-[34rem] rounded-full bg-cyan-500/[0.08] blur-[160px]" />
        <div className="soft-grid absolute inset-0 opacity-40" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col px-4 py-5 sm:px-7 sm:py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-200/20 bg-cyan-200/[0.07] text-cyan-100">
              <Sparkles size={17} strokeWidth={1.7} />
            </span>
            <div>
              <p className="font-['Manrope'] text-[11px] font-extrabold tracking-[0.2em] text-white">SHANAYA</p>
              <p className="mt-0.5 text-[8px] uppercase tracking-[0.2em] text-slate-500">First-run setup</p>
            </div>
          </div>
          <button type="button" onClick={onSkip} className="rounded-lg px-2 py-2 text-[10px] font-medium text-slate-500 transition hover:text-slate-200">
            Set up later
          </button>
        </header>

        <div className="mt-8 flex items-center gap-2" aria-label={`Step ${step + 1} of ${TOTAL_STEPS}`}>
          {Array.from({ length: TOTAL_STEPS }).map((_, index) => (
            <span
              key={index}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${index <= step ? "bg-gradient-to-r from-cyan-200 to-violet-300" : "bg-white/[0.08]"}`}
            />
          ))}
          <span className="ml-2 shrink-0 font-mono text-[9px] text-slate-500">{step + 1}/{TOTAL_STEPS}</span>
        </div>

        <section className="flex flex-1 flex-col justify-center py-8 sm:py-10">
          {step === 0 && (
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200/15 bg-emerald-200/[0.045] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-emerald-100/80">
                <LockKeyhole size={11} /> Privacy first, by architecture
              </span>
              <h1 className="mt-5 font-['Manrope'] text-[clamp(2rem,5vw,3.4rem)] font-semibold leading-[1.02] tracking-[-0.055em] text-white">
                A companion that<br />
                <span className="bg-gradient-to-r from-cyan-100 via-violet-200 to-indigo-300 bg-clip-text text-transparent">keeps your confidence.</span>
              </h1>
              <p className="mt-5 max-w-xl text-[13px] leading-7 text-slate-400">
                Shanaya can run in the cloud, in your browser, or entirely on your device. You choose where your words go — and you can change that choice at any time.
              </p>

              <div className="mt-7 grid gap-2.5 sm:grid-cols-2">
                {privacyPoints.map(({ icon: Icon, title, body }) => (
                  <article key={title} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                    <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-cyan-100/10 bg-cyan-100/[0.055] text-cyan-100">
                      <Icon size={15} strokeWidth={1.7} />
                    </span>
                    <h2 className="mt-3 font-['Manrope'] text-[12px] font-semibold text-slate-100">{title}</h2>
                    <p className="mt-1.5 text-[10px] leading-5 text-slate-400">{body}</p>
                  </article>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-100/70">Choose where AI runs</p>
              <h1 className="mt-3 font-['Manrope'] text-2xl font-semibold tracking-[-0.04em] text-white sm:text-3xl">Cloud speed, or local privacy.</h1>
              <p className="mt-2 max-w-xl text-[11px] leading-6 text-slate-400">
                Both options work. Cloud is the fastest to start; local keeps every prompt on hardware you control.
              </p>

              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => { setPath("cloud"); setError(""); }}
                  aria-pressed={path === "cloud"}
                  className={`rounded-2xl border p-4 text-left transition ${path === "cloud" ? "border-violet-300/35 bg-violet-300/[0.08]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]"}`}
                >
                  <span className="flex items-center justify-between">
                    <Cloud size={18} className={path === "cloud" ? "text-violet-200" : "text-slate-500"} />
                    {path === "cloud" && <CheckCircle2 size={16} className="text-violet-200" />}
                  </span>
                  <span className="mt-3 block font-['Manrope'] text-[13px] font-semibold text-slate-100">Groq Cloud</span>
                  <span className="mt-1 block text-[10px] leading-5 text-slate-400">Bring a Groq key, or use the provider your server already configured.</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setPath("local"); setError(""); }}
                  aria-pressed={path === "local"}
                  className={`rounded-2xl border p-4 text-left transition ${path === "local" ? "border-cyan-300/35 bg-cyan-300/[0.07]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]"}`}
                >
                  <span className="flex items-center justify-between">
                    <Cpu size={18} className={path === "local" ? "text-cyan-200" : "text-slate-500"} />
                    {path === "local" && <CheckCircle2 size={16} className="text-cyan-200" />}
                  </span>
                  <span className="mt-3 block font-['Manrope'] text-[13px] font-semibold text-slate-100">Local / offline</span>
                  <span className="mt-1 block text-[10px] leading-5 text-slate-400">Download a GGUF model, use browser AI, or connect Ollama.</span>
                </button>
              </div>

              {path === "cloud" ? (
                <div className="mt-4 rounded-2xl border border-violet-300/10 bg-violet-300/[0.035] p-4">
                  <label htmlFor="onboarding-groq-key" className="mb-2 block text-[10px] font-semibold text-slate-200">
                    Groq API key <span className="font-normal text-slate-500">(optional if your server already has one)</span>
                  </label>
                  <div className="flex items-center rounded-xl border border-white/[0.1] bg-[#080b13] pr-2 transition focus-within:border-violet-300/40">
                    <input
                      id="onboarding-groq-key"
                      type={showKey ? "text" : "password"}
                      value={groqApiKey}
                      onChange={(event) => { setGroqApiKey(event.target.value); setError(""); }}
                      placeholder="gsk_…"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={512}
                      className="min-w-0 flex-1 bg-transparent px-3.5 py-3 text-xs text-slate-100 outline-none placeholder:text-slate-600"
                    />
                    <button type="button" onClick={() => setShowKey((visible) => !visible)} aria-label={showKey ? "Hide Groq key" : "Show Groq key"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-200">
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="mt-2 text-[9px] leading-5 text-slate-500">
                    Create a key at{" "}
                    <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-cyan-100/80 underline decoration-cyan-100/25 underline-offset-2 hover:text-cyan-50">console.groq.com/keys</a>.
                    The key stays in this app’s memory for the session.
                  </p>

                  <label htmlFor="onboarding-api-token" className="mb-2 mt-4 block text-[10px] font-semibold text-slate-200">
                    Shanaya server access token <span className="font-normal text-slate-500">(if your server requires one)</span>
                  </label>
                  <div className="flex items-center rounded-xl border border-white/[0.1] bg-[#080b13] pr-2 transition focus-within:border-violet-300/40">
                    <input
                      id="onboarding-api-token"
                      type={showToken ? "text" : "password"}
                      value={apiToken}
                      onChange={(event) => { setApiToken(event.target.value); setError(""); }}
                      placeholder="32–512 characters"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={512}
                      className="min-w-0 flex-1 bg-transparent px-3.5 py-3 text-xs text-slate-100 outline-none placeholder:text-slate-600"
                    />
                    <button type="button" onClick={() => setShowToken((visible) => !visible)} aria-label={showToken ? "Hide server token" : "Show server token"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-200">
                      {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-5 text-slate-500">
                    <ShieldCheck size={12} className="mt-0.5 shrink-0 text-emerald-300/80" />
                    The access token is sent only to your configured Shanaya API. Neither credential is saved in browser storage.
                  </p>
                  <p className="mt-2 text-[9px] leading-5 text-slate-500">
                    Your server operator sets this token as <code className="rounded bg-black/30 px-1 font-mono text-[10px] text-violet-100">SHANAYA_API_TOKEN</code> in <code className="rounded bg-black/30 px-1 font-mono text-[10px] text-violet-100">server/.env</code> (generate with <code className="rounded bg-black/30 px-1 font-mono text-[10px] text-violet-100">openssl rand -hex 32</code>).
                  </p>
                </div>
              ) : (
                <div className="mt-4 space-y-2.5">
                  {isNative && (
                    <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.035] p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-200/15 bg-cyan-200/[0.07] text-cyan-100">
                          {modelStatus === "available" ? <Check size={16} /> : <Download size={16} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-['Manrope'] text-[12px] font-semibold text-slate-100">
                            {localChoice === "native" || modelStatus === "available" ? "Offline model ready" : "Download a local GGUF model"}
                          </p>
                          <p className="mt-1 text-[10px] leading-5 text-slate-400">
                            {modelStatus === "available"
                              ? "The model is stored on this device and inference stays offline."
                              : canDownloadModel
                                ? "Download once while online. After that, Shanaya can reply without a connection."
                                : "This build has no VITE_OFFLINE_MODEL_URL configured. You can use browser-local AI or Ollama instead."}
                          </p>
                          {canDownloadModel && modelStatus !== "available" && (
                            <button
                              type="button"
                              onClick={() => { setLocalChoice("native"); void downloadModel(); }}
                              disabled={downloadProgress !== null}
                              className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-cyan-100/20 bg-cyan-100/[0.07] px-3.5 text-[10px] font-semibold text-cyan-100 transition hover:bg-cyan-100/[0.11] disabled:opacity-50"
                            >
                              {downloadProgress !== null ? (
                                <>Downloading · {Math.round(downloadProgress)}%</>
                              ) : (
                                <><Download size={13} /> Download model</>
                              )}
                            </button>
                          )}
                          {downloadProgress !== null && (
                            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                              <div className="h-full rounded-full bg-gradient-to-r from-cyan-200 to-violet-300 transition-all" style={{ width: `${Math.max(2, downloadProgress)}%` }} />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {!isNative && (
                    <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.035] p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-200/15 bg-cyan-200/[0.07] text-cyan-100">
                          <Wifi size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-['Manrope'] text-[12px] font-semibold text-slate-100">Browser-local AI</p>
                          <p className="mt-1 text-[10px] leading-5 text-slate-400">
                            {supportsWebGpu
                              ? "Runs a compact model with WebGPU. It downloads on first use, then stays in this browser’s cache."
                              : "This browser does not expose WebGPU. Use Ollama, or open Shanaya in a WebGPU-capable browser."}
                          </p>
                          <button
                            type="button"
                            onClick={() => { setLocalChoice("webllm"); setError(""); }}
                            disabled={!supportsWebGpu}
                            className={`mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border px-3.5 text-[10px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${localChoice === "webllm" ? "border-cyan-100/30 bg-cyan-100/[0.12] text-cyan-50" : "border-cyan-100/20 bg-cyan-100/[0.07] text-cyan-100 hover:bg-cyan-100/[0.11]"}`}
                          >
                            {localChoice === "webllm" ? <Check size={13} /> : <Cpu size={13} />}
                            {localChoice === "webllm" ? "Browser AI selected" : "Use browser-local AI"}
                          </button>
                          {modelUrl && (
                            <a href={modelUrl} target="_blank" rel="noreferrer" className="ml-3 inline-flex min-h-10 items-center gap-1.5 text-[9px] font-medium text-slate-400 underline decoration-white/20 underline-offset-4 transition hover:text-slate-200">
                              Download GGUF file <ChevronRight size={11} />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => { setLocalChoice("ollama"); setError(""); }}
                    className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition ${localChoice === "ollama" ? "border-violet-300/30 bg-violet-300/[0.07]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]"}`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-200/15 bg-violet-200/[0.06] text-violet-100">
                      {localChoice === "ollama" ? <Check size={16} /> : <HardDrive size={16} />}
                    </span>
                    <span>
                      <span className="block font-['Manrope'] text-[12px] font-semibold text-slate-100">Use local Ollama</span>
                      <span className="mt-1 block text-[10px] leading-5 text-slate-400">
                        Best if Ollama is already running on this machine. The server’s OLLAMA_BASE_URL is used.
                      </span>
                    </span>
                  </button>

                  <p className="px-1 text-[9px] leading-5 text-slate-500">
                    You can switch modes at any time in Settings after onboarding. Local modes never send prompts to a cloud model.
                  </p>
                </div>
              )}

              {error && (
                <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-rose-300/20 bg-rose-300/[0.06] px-3 py-2.5 text-[10px] leading-5 text-rose-200">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-amber-200/15 bg-amber-200/[0.045] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-amber-100/80">
                <ShieldCheck size={11} /> Human in the loop
              </span>
              <h1 className="mt-4 font-['Manrope'] text-2xl font-semibold tracking-[-0.045em] text-white sm:text-3xl">Nothing happens without you.</h1>
              <p className="mt-3 max-w-xl text-[12px] leading-6 text-slate-400">
                Shanaya can read files, search the web, run sandboxed code, or control a desktop — but only after you review the exact action. A proposal is never consent.
              </p>

              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {[
                  { icon: MessageCircle, title: "Review the exact request", body: "Every action arrives with its arguments, destination, and plain-language summary." },
                  { icon: CheckCircle2, title: "Approve or reject", body: "Approve runs one action. Reject stops it and tells Shanaya what happened." },
                  { icon: FileCheck2, title: "Proposals expire", body: "Unanswered requests time out after a few minutes, so stale consent is never reused." },
                  { icon: Fingerprint, title: "Hash-chained audit trail", body: "Approvals, rejections, and results are recorded in a tamper-evident local log." },
                ].map(({ icon: Icon, title, body }) => (
                  <article key={title} className="rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4">
                    <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-amber-100/10 bg-amber-100/[0.05] text-amber-100">
                      <Icon size={15} strokeWidth={1.7} />
                    </span>
                    <h2 className="mt-3 font-['Manrope'] text-[12px] font-semibold text-slate-100">{title}</h2>
                    <p className="mt-1.5 text-[10px] leading-5 text-slate-400">{body}</p>
                  </article>
                ))}
              </div>

              <div className="mt-5 rounded-2xl border border-amber-200/15 bg-amber-200/[0.035] p-4">
                <p className="flex items-center gap-2 text-[9px] font-bold uppercase tracking-[0.16em] text-amber-100/80">
                  <ShieldCheck size={12} /> Example confirmation
                </p>
                <p className="mt-2 text-[11px] leading-6 text-slate-300">
                  Shanaya wants to read <span className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-violet-100">notes/today.md</span> inside your workspace.
                </p>
                <div className="mt-3 flex gap-2">
                  <span className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.08] px-3 py-1.5 text-[9px] font-semibold text-emerald-200">Approve once</span>
                  <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[9px] font-semibold text-slate-400">Reject</span>
                </div>
              </div>

              <p className="mt-4 flex items-start gap-2 text-[9px] leading-5 text-slate-500">
                <LockKeyhole size={12} className="mt-0.5 shrink-0 text-emerald-300/80" />
                Your setup choice: <span className="text-slate-300">{contextualMode === "cloud" ? "Groq Cloud" : contextualMode === "native" ? "On-device GGUF" : contextualMode === "webllm" ? "Browser-local WebLLM" : "Local Ollama"}</span>.
                You can change it later in Settings.
              </p>
            </div>
          )}

          {step === 3 && (
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-violet-200/15 bg-violet-200/[0.045] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-violet-100/80">
                <Sparkles size={11} /> Character anchoring
              </span>
              <h1 className="mt-4 font-['Manrope'] text-2xl font-semibold tracking-[-0.045em] text-white sm:text-3xl">Make Shanaya yours.</h1>
              <p className="mt-3 max-w-xl text-[12px] leading-6 text-slate-400">
                These details are stored locally and used to personalize future conversations. They are never sent to a cloud provider unless you choose cloud inference.
              </p>

              <div className="mt-6 space-y-4">
                <label className="block">
                  <span className="mb-2 block text-[10px] font-semibold text-slate-200">Name Shanaya can use for you</span>
                  <input
                    type="text"
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                    placeholder="Your preferred name"
                    maxLength={40}
                    className="w-full rounded-xl border border-white/[0.1] bg-[#080b13] px-3.5 py-3 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-300/40"
                  />
                </label>

                <div>
                  <span className="mb-2 block text-[10px] font-semibold text-slate-200">Voice pitch preference</span>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(["low", "medium", "high"] as const).map((pitch) => (
                      <button
                        key={pitch}
                        type="button"
                        onClick={() => setVoicePitch(pitch)}
                        aria-pressed={voicePitch === pitch}
                        className={`rounded-2xl border p-3 text-left transition ${voicePitch === pitch ? "border-violet-300/35 bg-violet-300/[0.08]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]"}`}
                      >
                        <span className="block font-['Manrope'] text-[12px] font-semibold text-slate-100">{pitch[0].toUpperCase() + pitch.slice(1)}</span>
                        <span className="mt-1 block text-[9px] leading-4 text-slate-400">
                          {pitch === "low" ? "Warm and grounded." : pitch === "medium" ? "Balanced and natural." : "Bright and light."}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="block">
                  <span className="mb-2 block text-[10px] font-semibold text-slate-200">One memory anchor phrase</span>
                  <input
                    type="text"
                    value={memoryAnchor}
                    onChange={(event) => setMemoryAnchor(event.target.value)}
                    placeholder="A phrase Shanaya should remember"
                    maxLength={120}
                    className="w-full rounded-xl border border-white/[0.1] bg-[#080b13] px-3.5 py-3 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-300/40"
                  />
                  <p className="mt-1.5 text-[9px] leading-5 text-slate-500">Optional. You can update or delete it later in Settings.</p>
                </label>
              </div>
            </div>
          )}
        </section>

        <footer className="flex items-center justify-between gap-3 border-t border-white/[0.07] pt-4">
          <button
            type="button"
            onClick={() => { setError(""); setStep((current) => Math.max(0, current - 1)); }}
            disabled={step === 0}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[10px] font-semibold text-slate-400 transition hover:bg-white/[0.04] hover:text-white disabled:invisible"
          >
            <ArrowLeft size={13} /> Back
          </button>

          {step === 0 ? (
            <button type="button" onClick={() => setStep(1)} className={primaryButton}>
              Continue <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
            </button>
          ) : step === 1 ? (
            <button type="button" onClick={nextFromSetup} className={primaryButton}>
              Continue <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
            </button>
          ) : step === 2 ? (
            <button type="button" onClick={() => setStep(3)} className={primaryButton}>
              Continue <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
            </button>
          ) : (
            <button type="button" onClick={finish} className={primaryButton}>
              Enter Shanaya <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
            </button>
          )}
        </footer>
        <p className="mt-3 text-center text-[8px] tracking-[0.08em] text-slate-600">
          <ShieldCheck size={10} className="mr-1 inline-block align-[-1px]" />
          No account required. You can change inference mode or clear data at any time.
        </p>
      </div>
    </main>
  );
}
