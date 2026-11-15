import { useState, type FormEvent } from "react";
import {
  ArrowRight, AudioLines, Cable, Eye, EyeOff, Globe2, Heart, LockKeyhole, Menu, MessageCircle, PackageOpen, ShieldCheck, Sparkles, X,
} from "lucide-react";
import AvatarScene from "./AvatarScene";

type LandingPageProps = {
  onStart: (credentials: { apiToken: string; groqApiKey: string }) => void;
  onIntegrations: () => void;
  onMarketplace: () => void;
  onSetup?: () => void;
};

const statCards = [
  { value: "3", label: "Voice languages", icon: "globe" },
  { value: "6", label: "Inference options", icon: "cpu" },
  { value: "Local", label: "Inference available", icon: "local" },
];

const features = [
  {
    icon: MessageCircle,
    color: "brand",
    title: "A conversation with presence",
    description: "Talk through an idea, untangle a long day, or follow your curiosity. Shanaya meets you with thoughtful, natural replies.",
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
    description: "Zero-trust policy enforcement, guardian review, and a user-facing accountability dashboard keep every action inspectable.",
  },
];

export default function LandingPage({ onStart, onIntegrations, onMarketplace, onSetup }: LandingPageProps) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [showApiToken, setShowApiToken] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyError, setKeyError] = useState("");

  const beginConversation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = apiToken.trim();
    const key = groqApiKey.trim();
    const localDevelopment = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
    if (token.length < 32 || token.length > 512 || /\s/.test(token)) {
      setKeyError("Enter the API access token provided by your Shanaya server operator (32–512 characters, without spaces).");
      return;
    }
    if ((token || key) && !window.isSecureContext && !localDevelopment) {
      setKeyError("For your safety, connect over HTTPS before sending an access token or API key.");
      return;
    }
    const configuredApiUrl = import.meta.env.VITE_API_BASE_URL?.trim();
    if (configuredApiUrl) {
      try {
        const apiOrigin = new URL(configuredApiUrl, window.location.href);
        const localApi = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(apiOrigin.hostname);
        if (apiOrigin.protocol !== "https:" && !localApi) {
          setKeyError("Configure your API server to use HTTPS before sending an access token or API key.");
          return;
        }
      } catch {
        setKeyError("The configured API server address is invalid.");
        return;
      }
    }
    onStart({ apiToken: token, groqApiKey: key });
  };

  const openKeyDialog = () => {
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
          <a href="#home" className="flex items-center gap-3" aria-label="Shanaya home">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600">
              <Sparkles size={17} strokeWidth={1.7} />
            </span>
            <span>
              <span className="block font-display text-[12px] font-extrabold tracking-[0.2em] text-ink">SHANAYA</span>
              <span className="mt-0.5 block text-[8px] font-medium uppercase tracking-[0.2em] text-slate-500">AI companion</span>
            </span>
          </a>

          <nav className="hidden items-center gap-8 md:flex" aria-label="Main navigation">
            <a href="#experience" className="text-xs text-slate-500 transition hover:text-ink">The experience</a>
            <a href="#how-it-works" className="text-xs text-slate-500 transition hover:text-ink">How it works</a>
            <a href="#modes" className="text-xs text-slate-500 transition hover:text-ink">Hybrid AI</a>
            <a href="#privacy" className="text-xs text-slate-500 transition hover:text-ink">Your privacy</a>
            <button type="button" onClick={onMarketplace} className="text-xs text-slate-500 transition hover:text-ink">Marketplace</button>
            <button type="button" onClick={onIntegrations} className="text-xs text-slate-500 transition hover:text-ink">Integrations</button>
            {onSetup && <button type="button" onClick={onSetup} className="text-xs text-slate-500 transition hover:text-ink">First-time setup</button>}
            <a href="/about/" className="text-xs text-slate-500 transition hover:text-ink">About</a>
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
            className="group inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-[11px] font-bold text-ink transition hover:border-brand-300 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200/50"
          >
            Talk to Shanaya <ArrowRight size={13} className="transition group-hover:translate-x-0.5" />
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
              {onSetup && <button type="button" onClick={() => { setMobileNavigationOpen(false); onSetup(); }} className="rounded-lg px-3 py-2.5 text-left text-xs text-slate-600 transition hover:bg-brand-50 hover:text-brand-700">First-time setup</button>}
              <a href="/about/" onClick={() => setMobileNavigationOpen(false)} className="rounded-lg px-3 py-2.5 text-xs text-slate-600 transition hover:bg-brand-50 hover:text-brand-700">About</a>
            </div>
          </nav>
        )}
      </header>

      <div className="relative z-10">
        <section id="home" className="mx-auto grid max-w-7xl items-center gap-8 px-5 pb-16 pt-10 sm:px-8 sm:pt-16 lg:grid-cols-[0.95fr_1.05fr] lg:gap-6 lg:px-12 lg:pb-24 lg:pt-8">
          <div className="relative z-10 max-w-[42rem] py-4 lg:py-0">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand-100 bg-brand-50 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-brand-600">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Shanaya v1.0.3
            </div>

            <h1 className="font-display text-[clamp(2.6rem,6vw,5.6rem)] font-extrabold leading-[1.02] tracking-[-0.06em] text-ink">
              An AI companion
              <span className="mt-1 block text-[clamp(2.6rem,6vw,5.6rem)] font-extrabold leading-[1.02] tracking-[-0.06em] text-transparent bg-gradient-to-r from-brand-600 via-amber-500 to-emerald-500">
                that truly understands.
              </span>
            </h1>
            <p className="mt-6 max-w-[34rem] text-[14px] leading-[1.8] text-slate-600 sm:text-[15px]">
              Meet Shanaya: a private, governed AI companion for real conversation, voice, and the little things you feel like sharing.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={openKeyDialog}
                className="group inline-flex min-h-[3.5rem] items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 text-[12px] font-bold text-white shadow-[0_10px_40px_rgba(14,165,233,0.25)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_48px_rgba(14,165,233,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300/70"
              >
                Talk to Shanaya
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/20"><ArrowRight size={14} /></span>
              </button>
              <a href="#experience" className="inline-flex min-h-[3.5rem] items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-[11px] font-bold text-ink transition hover:border-brand-300 hover:text-brand-600">
                Discover the experience <ArrowRight size={13} />
              </a>
            </div>

            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
              <button type="button" onClick={onIntegrations} className="inline-flex items-center gap-2 text-left text-[10px] font-bold text-slate-500 transition hover:text-brand-600">
                <Cable size={13} /> Connect Shanaya to another app with the API or MCP
              </button>
              <button type="button" onClick={onMarketplace} className="inline-flex items-center gap-2 text-left text-[10px] font-bold text-slate-500 transition hover:text-violet-600">
                <PackageOpen size={13} /> Browse agents and skills
              </button>
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-slate-200 pt-6 text-[10px] text-slate-400">
              <span className="inline-flex items-center gap-2"><ShieldCheck size={13} className="text-emerald-400" /> Zero-trust governance</span>
              <span className="inline-flex items-center gap-2"><Globe2 size={13} className="text-brand-400" /> English · हिन्दी · मराठी</span>
              <span className="inline-flex items-center gap-2"><LockKeyhole size={13} className="text-violet-400" /> E2E-encrypted sync</span>
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
                <span className="rounded-full border border-white/60 bg-white/85 px-3 py-1.5 font-mono text-[8px] tracking-[0.18em] text-brand-700 backdrop-blur">SHANAYA · LIVE</span>
                <span className="flex items-center gap-1.5 rounded-full border border-white/60 bg-white/85 px-2.5 py-1.5 text-[8px] text-slate-600 backdrop-blur"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981]" /> Ready</span>
              </div>
              <div className="pointer-events-none absolute inset-x-4 bottom-4 flex items-center justify-between gap-2 rounded-xl border border-white/50 bg-white/85 px-3 py-2 text-[9px] text-slate-600 backdrop-blur sm:inset-x-5 sm:bottom-5">
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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {statCards.map(({ value, label, icon: IconName }) => {
              const Icon = IconName === "cpu" ? ShieldCheck : IconName === "globe" ? Globe2 : Heart;
              return (
                <div key={label} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-soft">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600 mb-4">
                    <Icon size={17} strokeWidth={1.7} />
                  </div>
                  <div className="metric-value">{value}</div>
                  <div className="metric-sub">{label}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Feature grid */}
        <section id="how-it-works" className="border-y border-slate-100 bg-white/60 backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
            <div className="max-w-2xl mb-12">
              <p className="section-kicker">How it works</p>
              <h2 className="section-title">Your space. Your conversation.</h2>
              <p className="section-desc">You decide when to begin and whether to type or use your voice.</p>
              <button type="button" onClick={openKeyDialog} className="group mt-6 inline-flex items-center gap-2 text-[11px] font-bold text-brand-600 transition hover:text-brand-700">
                Talk to Shanaya <ArrowRight size={14} className="transition group-hover:translate-x-1" />
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
                    <span className="absolute right-4 top-4 font-mono text-[9px] text-slate-200">0{index + 1}</span>
                    <div className={`mb-5 flex h-10 w-10 items-center justify-center rounded-xl ${resolved.bg} ${resolved.icon}`}>
                      <Icon size={17} strokeWidth={1.7} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${resolved.dot}`} />
                      <span className="text-[10px] font-semibold text-ink">{title}</span>
                    </div>
                    <p className="mt-2.5 text-[11px] leading-6 text-slate-600">{description}</p>
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
              <h2 className="section-title">Choose where Shanaya thinks.</h2>
              <p className="section-desc">Use a hosted model, a browser model, or a model on your own device or server.</p>
            </div>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                { title: "Cloud providers", detail: "Choose a provider configured by your server operator. Cloud requests need an internet connection." },
                { title: "Browser and local server", detail: "Run WebLLM in a WebGPU browser or connect to an Ollama endpoint you control." },
                { title: "On-device models", detail: "Prepare a llama.cpp model in the iOS or Android app, then use it offline." },
              ].map((mode) => (
                <article key={mode.title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-soft">
                  <h3 className="font-display text-sm font-bold text-ink">{mode.title}</h3>
                  <p className="mt-2 text-[11px] leading-6 text-slate-600">{mode.detail}</p>
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
              <p className="mt-3 text-[11px] leading-6 text-slate-600 sm:text-xs">
                Your Groq key stays in memory for this visit. Shanaya sends it to the configured API server in a request header for cloud turns; it is not saved in browser storage.
              </p>
            </div>
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="inline-flex min-h-[3rem] items-center justify-center gap-2 rounded-xl border border-white/10 bg-white px-4 text-[10px] font-bold text-slate-600 transition hover:border-brand-300 hover:text-ink">
              Get a Groq API key <ArrowRight size={13} />
            </a>
          </div>
        </section>

        <footer className="border-t border-slate-200">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-10 text-[9px] text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
            <span>© {new Date().getFullYear()} Shanaya · A thoughtful AI companion.</span>
            <div className="flex flex-wrap items-center gap-6"><button type="button" onClick={onMarketplace} className="transition hover:text-ink">Marketplace</button><button type="button" onClick={onIntegrations} className="transition hover:text-ink">API &amp; Integrations</button><a href="/about/" className="transition hover:text-ink">About</a><a href="https://github.com/HarshTambade/Shanaya---Your-AI-companion-" target="_blank" rel="noreferrer" className="transition hover:text-ink">Source &amp; project details</a></div>
          </div>
        </footer>
      </div>

      {keyDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-ink/45 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget) setKeyDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="connect-title" className="relative my-auto w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-slate-950/20">
            <div className="pointer-events-none absolute -right-24 -top-32 h-64 w-64 rounded-full bg-brand-100/80 blur-[96px]" />
            <div className="relative p-6 sm:p-8">
              <button type="button" aria-label="Close" onClick={() => setKeyDialogOpen(false)} className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-ink"><X size={15} /></button>
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-brand-100 bg-brand-50 text-brand-600"><Sparkles size={17} /></span>
              <p className="mt-7 text-[9px] font-bold uppercase tracking-[0.2em] text-brand-700">Your first step</p>
              <h2 id="connect-title" className="mt-2 font-display text-2xl font-bold tracking-[-0.04em] text-ink">Connect with Shanaya.</h2>
              <p className="mt-4 text-[11px] leading-6 text-slate-600">Enter the access token from your Shanaya server operator. They set it as <code className="rounded bg-slate-100 px-1 font-mono text-[10px] text-brand-700">SHANAYA_API_TOKEN</code> in <code className="rounded bg-slate-100 px-1 font-mono text-[10px] text-brand-700">server/.env</code> (generate with <code className="rounded bg-slate-100 px-1 font-mono text-[10px] text-brand-700">openssl rand -hex 32</code>). It stays in this page's memory for the session.</p>

              <form className="mt-7" onSubmit={beginConversation}>
                <label htmlFor="shanaya-api-token" className="mb-2 block text-[10px] font-bold text-slate-700">Shanaya API access token</label>
                <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 pr-3 transition focus-within:border-brand-400/60">
                  <input
                    id="shanaya-api-token"
                    type={showApiToken ? "text" : "password"}
                    value={apiToken}
                    onChange={(event) => { setApiToken(event.target.value); setKeyError(""); }}
                    placeholder="Paste the token from your server operator"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={512}
                    required
                    className="min-w-0 flex-1 bg-transparent px-3 py-3 text-xs text-ink outline-none placeholder:text-slate-400"
                  />
                  <button type="button" onClick={() => setShowApiToken((visible) => !visible)} aria-label={showApiToken ? "Hide Shanaya access token" : "Show Shanaya access token"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-200 hover:text-ink">
                    {showApiToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <label htmlFor="groq-key" className="mb-2 block mt-6 text-[10px] font-bold text-slate-700">Optional Groq API key</label>
                <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 pr-3 transition focus-within:border-brand-400/60">
                  <input
                    id="groq-key"
                    type={showApiKey ? "text" : "password"}
                    value={groqApiKey}
                    onChange={(event) => { setGroqApiKey(event.target.value); setKeyError(""); }}
                    placeholder="Paste your gsk_ key"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={512}
                    className="min-w-0 flex-1 bg-transparent px-3 py-3 text-xs text-ink outline-none placeholder:text-slate-400"
                  />
                  <button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "Hide API key" : "Show API key"} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-200 hover:text-ink">
                    {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {keyError && <p role="alert" className="mt-2 text-[10px] text-rose-400">{keyError}</p>}
                <p className="mt-4 flex items-start gap-2 text-[9px] leading-5 text-slate-500"><ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" /> The access token and optional Groq key stay in this page's memory.</p>
                <button type="submit" className="group mt-7 flex min-h-[3.25rem] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 text-[11px] font-bold text-white transition hover:brightness-105">
                  Continue to Shanaya <ArrowRight size={14} className="transition group-hover:translate-x-0.5" />
                </button>
                <p className="mt-5 text-center text-[9px] text-slate-500">Need a Groq key? <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-brand-700 underline decoration-brand-200/30 underline-offset-2 hover:text-brand-800">Create one at Groq</a></p>
              </form>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
