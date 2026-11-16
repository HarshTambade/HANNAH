import { useEffect, useState, type FormEvent } from "react";
import { isGroqKey, verifyApiAccess } from "../services/api";
import {
  ArrowRight, AudioLines, Cable, Check, Eye, EyeOff, Globe2, Heart, KeyRound, LockKeyhole, Menu, MessageCircle, PackageOpen, ShieldCheck, Sparkles, X,
} from "lucide-react";
import AvatarScene from "./AvatarScene";

type LandingPageProps = {
  onStart: (credentials: { apiToken: string; groqApiKey: string }) => void;
  onIntegrations: () => void;
  onMarketplace: () => void;
  /** A verified token is already saved for this tab. */
  hasSession?: boolean;
  onResume?: () => void;
  /** Open the connect dialog on arrival (for example after a rejected token). */
  openConnect?: boolean;
  onConnectHandled?: () => void;
};

const statCards = [
  { value: "3", label: "Voice languages: English, Hindi and Marathi", icon: "globe" },
  { value: "6", label: "Ways to run the AI, from cloud to fully on-device", icon: "cpu" },
  { value: "Yours", label: "Chat history stays in your browser, not on our server", icon: "local" },
];

const features = [
  {
    icon: MessageCircle,
    color: "brand",
    title: "A conversation with presence",
    description: "Talk through an idea, untangle a long day, or follow your curiosity. HANNAH meets you with thoughtful, natural replies.",
  },
  {
    icon: AudioLines,
    color: "amber",
    title: "Speak the way you want",
    description: "Type or use voice in English, Hindi, and Marathi, depending on the speech support available on your device.",
  },
  {
    icon: Sparkles,
    color: "violet",
    title: "A character that feels alive",
    description: "A real-time 3D avatar brings movement and emotion to the conversation, right in your browser.",
  },
  {
    icon: ShieldCheck,
    color: "emerald",
    title: "Governed by design",
    description: "Every action is checked by HANNAH's Guardian and waits for your approval before anything on your device or data changes.",
  },
];

export default function LandingPage({ onStart, onIntegrations, onMarketplace, hasSession = false, onResume, openConnect = false, onConnectHandled }: LandingPageProps) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [showApiToken, setShowApiToken] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!openConnect) return;
    setKeyError("");
    setKeyDialogOpen(true);
    onConnectHandled?.();
  }, [openConnect, onConnectHandled]);

  useEffect(() => {
    if (!keyDialogOpen) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !verifying) setKeyDialogOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyDialogOpen, verifying]);

  const beginConversation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (verifying) return;
    const token = apiToken.trim();
    const key = groqApiKey.trim();
    const localDevelopment = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
    if (!token && !key) {
      setKeyError("Paste your Groq API key to start. It's free to create at console.groq.com/keys.");
      return;
    }
    if (key && !isGroqKey(key)) {
      setKeyError("That doesn't look like a Groq key. Groq keys start with gsk_ and have no spaces.");
      return;
    }
    if (token && (token.length < 32 || token.length > 512 || /\s/.test(token))) {
      setKeyError("An access token is 32–512 characters without spaces. Leave it empty if you're using your own Groq key.");
      return;
    }
    if (!window.isSecureContext && !localDevelopment) {
      setKeyError("For your safety, connect over HTTPS before sending an API key.");
      return;
    }
    const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim();
    if (configuredApiUrl) {
      try {
        const apiOrigin = new URL(configuredApiUrl, window.location.href);
        const localApi = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiOrigin.hostname);
        if (apiOrigin.protocol !== "https:" && !localApi) {
          setKeyError("Configure your API server to use HTTPS before sending an API key.");
          return;
        }
      } catch {
        setKeyError("The configured API server address is invalid.");
        return;
      }
    }
    setVerifying(true);
    setKeyError("");
    const access = await verifyApiAccess({ token, groqKey: key });
    setVerifying(false);
    if (!access.ok) {
      setKeyError(access.message);
      return;
    }
    onStart({ apiToken: token, groqApiKey: key });
  };

  const openKeyDialog = () => {
    if (hasSession && onResume) {
      onResume();
      return;
    }
    setKeyError("");
    setKeyDialogOpen(true);
  };

  return (
    <main className="landing-page relative h-[100dvh] overflow-x-hidden overflow-y-auto bg-slate-50 text-ink selection:bg-brand-200/30">
      {/* Hero gradient blob background */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="absolute -left-20 top-[-10%] h-[40rem] w-[40rem] rounded-full bg-brand-100/60 blur-[120px]" />
        <div className="absolute -right-20 top-[40%] h-[40rem] w-[40rem] rounded-full bg-amber-100/40 blur-[130px]" />
        <div className="absolute top-[20%] left-[10%] h-[30rem] w-[30rem] rounded-full bg-violet-100/50 blur-[110px]" />
        <div className="landing-grain absolute inset-0 opacity-[0.08]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-7xl h-[4.5rem] items-center justify-between px-5 sm:px-8 lg:px-12">
          <a href="#home" className="flex items-center gap-3" aria-label="HANNAH home">
            <span className="logo-ring !h-6 !w-6" aria-hidden="true" />
            <span>
              <span className="block text-[15px] font-medium text-ink">HANNAH</span>
              <span className="block text-[11px] text-slate-500">AI companion</span>
            </span>
          </a>

          <nav className="hidden items-center gap-8 md:flex" aria-label="Main navigation">
            <a href="#experience" className="text-xs text-slate-500 transition hover:text-ink">The experience</a>
            <a href="#how-it-works" className="text-xs text-slate-500 transition hover:text-ink">How it works</a>
            <a href="#modes" className="text-xs text-slate-500 transition hover:text-ink">Hybrid AI</a>
            <a href="#privacy" className="text-xs text-slate-500 transition hover:text-ink">Your privacy</a>
            <button type="button" onClick={onMarketplace} className="text-xs text-slate-500 transition hover:text-ink">Marketplace</button>
            <button type="button" onClick={onIntegrations} className="text-xs text-slate-500 transition hover:text-ink">Integrations</button>
          </nav>

          <button
            type="button"
            aria-label={mobileNavigationOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileNavigationOpen}
            aria-controls="main-mobile-navigation"
            onClick={() => setMobileNavigationOpen((open) => !open)}
            className="mr-2 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 md:hidden"
          >
            {mobileNavigationOpen ? <X size={17} /> : <Menu size={17} />}
          </button>

          <button
            type="button"
            onClick={openKeyDialog}
            className="group inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-bold text-ink transition hover:border-brand-300 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200/50"
          >
            Talk to HANNAH <ArrowRight size={13} className="transition group-hover:translate-x-0.5" />
          </button>
        </div>
        {mobileNavigationOpen && (
          <nav id="main-mobile-navigation" aria-label="Mobile main navigation" className="border-t border-slate-200 bg-white/95 px-5 py-3 shadow-soft md:hidden">
            <div className="mx-auto flex max-w-7xl flex-col gap-1">
              {[
                ["The experience", "#experience"],
                ["How it works", "#how-it-works"],
                ["Hybrid AI", "#modes"],
                ["Your privacy", "#privacy"],
              ].map(([label, href]) => (
                <a key={href} href={href} onClick={() => setMobileNavigationOpen(false)} className="rounded-lg px-3 py-2.5 text-xs text-slate-600 transition hover:bg-brand-50 hover:text-brand-700">{label}</a>
              ))}
              <button type="button" onClick={() => { setMobileNavigationOpen(false); onMarketplace(); }} className="rounded-lg px-3 py-2.5 text-left text-xs text-slate-600 transition hover:bg-brand-50 hover:text-brand-700">Marketplace</button>
              <button type="button" onClick={() => { setMobileNavigationOpen(false); onIntegrations(); }} className="rounded-lg px-3 py-2.5 text-left text-xs text-slate-600 transition hover:bg-brand-50 hover:text-brand-700">Integrations</button>
            </div>
          </nav>
        )}
      </header>

      <div className="relative z-10">
        <section id="home" className="mx-auto grid max-w-7xl items-center gap-8 px-5 pb-16 pt-10 sm:px-8 sm:pt-16 lg:grid-cols-[0.95fr_1.05fr] lg:gap-6 lg:px-12 lg:pb-24 lg:pt-8">
          <div className="relative z-10 max-w-[42rem] py-4 lg:py-0">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-brand-600">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              HANNAH v1.0.3
            </div>

            <h1 className="display-title text-[clamp(2.6rem,6vw,5.4rem)]">
              An AI companion
              <span className="mt-1 block text-[clamp(2.6rem,6vw,5.4rem)] bg-gradient-to-r from-brand-600 via-violet-600 to-amber-500 bg-clip-text pb-2 text-transparent">
                that truly understands.
              </span>
            </h1>
            <p className="mt-6 max-w-[34rem] text-[14px] leading-[1.8] text-slate-600 sm:text-[15px]">
              Meet HANNAH: a private, governed AI companion for real conversation, voice, and the little things you feel like sharing.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={openKeyDialog}
                className="btn-primary group min-h-[3.5rem] !gap-3 !rounded-2xl !px-6 text-sm transition hover:-translate-y-0.5"
              >
                Talk to HANNAH
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/20"><ArrowRight size={14} /></span>
              </button>
              <a href="#experience" className="inline-flex min-h-[3.5rem] items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-bold text-ink transition hover:border-brand-300 hover:text-brand-600">
                Discover the experience <ArrowRight size={13} />
              </a>
            </div>

            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
              <button type="button" onClick={onIntegrations} className="inline-flex items-center gap-2 text-left text-xs font-bold text-slate-500 transition hover:text-brand-600">
                <Cable size={13} /> Connect HANNAH to another app with the API or MCP
              </button>
              <button type="button" onClick={onMarketplace} className="inline-flex items-center gap-2 text-left text-xs font-bold text-slate-500 transition hover:text-violet-600">
                <PackageOpen size={13} /> Browse agents and skills
              </button>
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-slate-200 pt-6 text-xs text-slate-400">
              <span className="inline-flex items-center gap-2"><ShieldCheck size={13} className="text-emerald-400" /> Zero-trust governance</span>
              <span className="inline-flex items-center gap-2"><Globe2 size={13} className="text-brand-400" /> English · हिन्दी · मराठी</span>
              <span className="inline-flex items-center gap-2"><LockKeyhole size={13} className="text-violet-400" /> History stays on your device</span>
            </div>
          </div>

          <div className="relative mx-auto h-[min(62dvh,560px)] w-full max-w-[560px] lg:h-[min(70dvh,640px)] lg:min-h-[520px]">
            {/* Avatar stage */}
            <div className="absolute inset-x-[8%] bottom-[4%] top-[4%] rounded-[2.5rem] border border-slate-200 bg-white/80 shadow-[0_30px_100px_rgba(15,23,42,0.10)] backdrop-blur-sm" />
            <div className="absolute inset-x-[11%] bottom-[7%] top-[7%] overflow-hidden rounded-[2rem] border border-brand-100/60 shadow-[0_0_80px_rgba(14,165,233,0.10)]">
              <div className="avatar-stage absolute inset-0" />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/30 via-transparent to-white/70" />
              <div className="absolute inset-0">
                <AvatarScene emotion="neutral" />
              </div>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 py-4 sm:px-5">
                <span className="rounded-full border border-white/60 bg-white/85 px-3 py-1.5 font-mono text-[10px] tracking-[0.18em] text-brand-700 backdrop-blur">HANNAH · LIVE</span>
                <span className="flex items-center gap-1.5 rounded-full border border-white/60 bg-white/85 px-2.5 py-1.5 text-[10px] text-slate-600 backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981]" /> Ready</span>
              </div>
              <div className="pointer-events-none absolute inset-x-4 bottom-4 flex items-center justify-between gap-2 rounded-xl border border-white/50 bg-white/85 px-3 py-2 text-[11px] text-slate-600 backdrop-blur sm:inset-x-5 sm:bottom-5">
                <span>3 voice languages</span><span className="h-1 w-1 rounded-full bg-slate-400" /><span>Cloud and local AI</span>
              </div>
            </div>
          </div>
        </section>

        {/* Stat strip */}
        <section id="experience" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-10">
            <div>
              <p className="section-kicker">The experience</p>
              <h2 className="section-title">More than an answer on a screen.</h2>
              <p className="section-desc">A familiar place to think out loud, ask anything, or simply have someone thoughtful to talk to.</p>
            </div>
          </div>
          <div className="deck-frame">
            <div className="deck-card tone-sky grid gap-3 sm:grid-cols-3">
              {statCards.map(({ value, label, icon: IconName }) => {
                const Icon = IconName === "cpu" ? ShieldCheck : IconName === "globe" ? Globe2 : Heart;
                return (
                  <div key={label} className="glass-tile p-5">
                    <Icon size={20} strokeWidth={1.6} className="text-slate-700" />
                    <div className="metric-value mt-4">{value}</div>
                    <div className="metric-sub">{label}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Feature grid */}
        <section id="how-it-works" className="border-y border-slate-100 bg-white/60 backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
            <div className="max-w-2xl mb-12">
              <p className="section-kicker">How it works</p>
              <h2 className="section-title">Your space. Your conversation.</h2>
              <p className="section-desc">You decide when to begin and whether to type or use your voice.</p>
              <button type="button" onClick={openKeyDialog} className="group mt-6 inline-flex items-center gap-2 text-[13px] font-bold text-brand-600 transition hover:text-brand-700">
                Talk to HANNAH <ArrowRight size={14} className="transition group-hover:translate-x-1" />
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {features.map(({ icon: Icon, color, title, description }, index) => {
                const colorMap: Record<string, { bg: string; border: string; icon: string; dot: string }> = {
                  brand: { bg: "bg-brand-50", border: "border-brand-100", icon: "text-brand-600", dot: "bg-brand-500" },
                  amber: { bg: "bg-amber-50", border: "border-amber-100", icon: "text-amber-600", dot: "bg-amber-500" },
                  violet: { bg: "bg-violet-50", border: "border-violet-100", icon: "text-violet-600", dot: "bg-violet-500" },
                  emerald: { bg: "bg-emerald-50", border: "border-emerald-100", icon: "text-emerald-600", dot: "bg-emerald-500" },
                };
                const resolved = colorMap[color] ?? colorMap.brand;
                return (
                  <article key={title} className={`relative rounded-2xl border ${resolved.border} bg-white p-6 shadow-soft transition hover:-translate-y-1 hover:border-brand-200`}>
                    <span className="absolute right-4 top-4 font-mono text-[11px] text-slate-200">0{index + 1}</span>
                    <div className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl ${resolved.bg} ${resolved.icon}`}>
                      <Icon size={17} strokeWidth={1.7} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${resolved.dot}`} />
                      <span className="text-xs font-semibold text-ink">{title}</span>
                    </div>
                    <p className="mt-2.5 text-[13px] leading-6 text-slate-600">{description}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section id="modes" className="border-y border-slate-100 bg-white/65 backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
            <div className="max-w-2xl">
              <p className="section-kicker">Hybrid AI</p>
              <h2 className="section-title">Choose where HANNAH thinks.</h2>
              <p className="section-desc">Use a hosted model, a browser model, or a model on your own device or server.</p>
            </div>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                { title: "Cloud with your key", detail: "Use your own free Groq key, or any provider your server operator has configured. Needs an internet connection." },
                { title: "Browser and local server", detail: "Run WebLLM in a WebGPU browser or connect to an Ollama endpoint you control." },
                { title: "On-device models", detail: "Prepare a llama.cpp model in the iOS or Android app, then use it offline." },
              ].map((mode) => (
                <article key={mode.title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-soft">
                  <h3 className="font-display text-sm font-bold text-ink">{mode.title}</h3>
                  <p className="mt-2 text-[13px] leading-6 text-slate-600">{mode.detail}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Privacy card */}
        <section id="privacy" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-28 lg:px-12">
          <div className="grid gap-6 rounded-2xl border border-brand-100 bg-gradient-to-b from-brand-50 to-white p-6 sm:p-9 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-0 lg:p-11">
            <div className="max-w-2xl">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600">
                <LockKeyhole size={17} />
              </div>
              <h2 className="mt-5 font-display text-2xl font-bold tracking-[-0.04em] text-ink sm:text-3xl">Your key stays yours.</h2>
              <p className="mt-3 text-[13px] leading-6 text-slate-600 sm:text-xs">
                If you add your own Groq key, it is kept only for this browser tab and cleared when you close it. HANNAH sends it to its API server in a request header for cloud replies; it is never written to the server's disk.
              </p>
            </div>
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="inline-flex min-h-[3rem] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white px-4 text-xs font-bold text-slate-600 transition hover:border-brand-300 hover:text-ink">
              Get a Groq API key <ArrowRight size={13} />
            </a>
          </div>
        </section>

        <footer className="border-t border-slate-200">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-10 text-[11px] text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
            <span>© {new Date().getFullYear()} HANNAH · A thoughtful AI companion.</span>
            <div className="flex flex-wrap items-center gap-6"><button type="button" onClick={onMarketplace} className="transition hover:text-ink">Marketplace</button><button type="button" onClick={onIntegrations} className="transition hover:text-ink">API &amp; Integrations</button><a href="https://github.com/HarshTambade/Shanaya-Your-AI-companion" target="_blank" rel="noreferrer" className="transition hover:text-ink">Source &amp; project details</a></div>
          </div>
        </footer>
      </div>

      {keyDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget && !verifying) setKeyDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="connect-title" className="deck-frame relative my-auto w-full max-w-md">
            <div className="deck-card tone-plain !p-0">
              <div className="tone-sky relative px-6 pb-6 pt-5 sm:px-7">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium text-ink"><span className="logo-ring" aria-hidden="true" /> HANNAH</span>
                  <button type="button" aria-label="Close" onClick={() => setKeyDialogOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-slate-600 transition hover:bg-white hover:text-ink"><X size={15} /></button>
                </div>
                <span className="pill-badge mt-6"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>Free · No sign-up</span>
                <h2 id="connect-title" className="display-title mt-3 text-[2rem]">Connect with HANNAH.</h2>
                <p className="mt-2 text-sm leading-6 text-slate-700">Paste your own Groq API key and start talking. There's no account and nothing to pay.</p>
              </div>

              <form className="px-6 pb-6 pt-5 sm:px-7" onSubmit={beginConversation}>
                <label htmlFor="groq-key" className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700"><KeyRound size={13} /> Your Groq API key</label>
                <div className="flex items-center rounded-2xl border border-slate-200 bg-slate-50 pr-2 transition focus-within:border-sky-400 focus-within:bg-white">
                  <input
                    id="groq-key"
                    type={showApiKey ? "text" : "password"}
                    value={groqApiKey}
                    onChange={(event) => { setGroqApiKey(event.target.value); setKeyError(""); }}
                    placeholder="gsk_…"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={512}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent px-4 py-3 font-mono text-base text-ink outline-none placeholder:font-sans placeholder:text-slate-400 sm:text-sm"
                  />
                  <button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "Hide Groq API key" : "Show Groq API key"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 transition hover:bg-slate-200 hover:text-ink">
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-500">No key yet? <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="font-medium text-ink underline decoration-slate-300 underline-offset-2 hover:decoration-ink">Create one free at Groq</a>. It takes about a minute.</p>

                <details className="mt-5 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm" open={Boolean(apiToken)}>
                  <summary className="cursor-pointer select-none text-xs font-semibold text-slate-600">I have an access token</summary>
                  <p className="mt-2 text-xs leading-5 text-slate-500">Only needed if the person running this server gave you one, for example to use their models, voice or desktop features. Operators set it as <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">HANNAH_API_TOKEN</code>.</p>
                  <label htmlFor="hannah-api-token" className="sr-only">HANNAH API access token</label>
                  <div className="mt-3 flex items-center rounded-xl border border-slate-200 bg-slate-50 pr-2 transition focus-within:border-sky-400 focus-within:bg-white">
                    <input
                      id="hannah-api-token"
                      type={showApiToken ? "text" : "password"}
                      value={apiToken}
                      onChange={(event) => { setApiToken(event.target.value); setKeyError(""); }}
                      placeholder="Access token (optional)"
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={512}
                      className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-base text-ink outline-none placeholder:text-slate-400 sm:text-sm"
                    />
                    <button type="button" onClick={() => setShowApiToken((visible) => !visible)} aria-label={showApiToken ? "Hide HANNAH access token" : "Show HANNAH access token"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-200 hover:text-ink">
                      {showApiToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </details>

                {keyError && <p role="alert" className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{keyError}</p>}
                <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-teal-600" /> Kept only in this browser tab and cleared when you close it. Your key is sent to Groq through HANNAH's server and never stored.</p>
                <button type="submit" disabled={verifying} className="btn-primary group mt-5 min-h-[3.25rem] w-full !rounded-2xl text-sm disabled:cursor-wait">
                  {verifying ? "Checking your key…" : "Continue to HANNAH"} {!verifying && <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />}
                </button>
              </form>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
