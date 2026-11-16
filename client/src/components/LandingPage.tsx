import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { apiBase, isGroqKey, verifyApiAccess } from "../services/api";
import { Account, databaseLabel, type AccountStatus } from "../services/Account";
import { SignInForm } from "./AccountPanel";
import {
  ArrowRight, AudioLines, Bot, Boxes, Brain, Cable, CalendarDays, Check, ChevronDown, Cpu, Download, Ear, Eye, EyeOff, HardDrive, KeyRound, LockKeyhole, Menu,
  MonitorSmartphone, PackageOpen, ShieldCheck, Sparkles, TerminalSquare, Waypoints, Workflow, X,
} from "lucide-react";
import AvatarScene from "./AvatarScene";
import { CAPABILITIES as capabilities, FAQS as faqs, ROADMAP as roadmap, type IconName } from "../content/landing";
import AppTour from "./AppTour";
import { APP_VERSION, PLATFORM_DOWNLOADS, RELEASE_NOTES_URL, RELEASES_URL, REPOSITORY_URL } from "../config/project";

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

/** Real links (crawlable, open in a new tab) that move inside the app on a plain click. */
function followInApp(event: MouseEvent<HTMLAnchorElement>, go: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  go();
}

const capabilityIcons: Record<IconName, typeof Cpu> = { AudioLines, Bot, Brain, Cable, CalendarDays, Cpu, Ear, HardDrive, MonitorSmartphone, PackageOpen, Sparkles, Waypoints, Workflow };

export default function LandingPage({ onStart, onIntegrations, onMarketplace, hasSession = false, onResume, openConnect = false, onConnectHandled }: LandingPageProps) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [showApiToken, setShowApiToken] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [accountInfo, setAccountInfo] = useState<AccountStatus | null>(null);
  const [accountMode, setAccountMode] = useState(false);

  useEffect(() => {
    if (!keyDialogOpen || accountInfo) return;
    let active = true;
    Account.status().then((status) => { if (active) setAccountInfo(status); }).catch(() => {});
    return () => { active = false; };
  }, [keyDialogOpen, accountInfo]);
  const accountsEnabled = Boolean(accountInfo?.accounts.enabled);

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
    const configuredApiUrl = apiBase();
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

  // In-page links scroll smoothly without adding "#section" to the address bar.
  const scrollToSection = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    setMobileNavigationOpen(false);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    target.focus({ preventScroll: true });
  };

  // A link to /#privacy (for example from the About page) still lands on that section.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && !id.startsWith("/")) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);

  const openKeyDialog = () => {
    if (hasSession && onResume) {
      onResume();
      return;
    }
    setKeyError("");
    setKeyDialogOpen(true);
  };

  const sections: Array<[string, string]> = [["Features", "features"], ["Privacy", "privacy"], ["Download", "download"], ["FAQ", "faq"]];

  return (
    <main className="landing-page relative h-[100dvh] overflow-x-hidden overflow-y-auto bg-slate-50 text-ink selection:bg-brand-200/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-40 -top-40 h-[42rem] w-[42rem] rounded-full bg-brand-100/50 blur-[140px]" />
        <div className="landing-grain absolute inset-0 opacity-[0.06]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 pt-[env(safe-area-inset-top)] backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-5 sm:px-8 lg:px-12">
          <a href="#home" onClick={(event) => scrollToSection(event, "home")} className="flex items-center gap-2.5" aria-label="HANNAH home">
            <span className="logo-ring !h-6 !w-6" aria-hidden="true" />
            <span className="text-[15px] font-semibold tracking-tight text-ink">HANNAH</span>
            <span className="hidden rounded-full border border-slate-200 bg-white px-2 py-0.5 font-mono text-[10px] text-slate-500 sm:inline">v{APP_VERSION}</span>
          </a>

          <nav className="hidden items-center gap-7 md:flex" aria-label="Main navigation">
            {sections.map(([label, id]) => (
              <a key={id} href={`#${id}`} onClick={(event) => scrollToSection(event, id)} className="text-[13px] text-slate-600 transition hover:text-ink">{label}</a>
            ))}
            <a href="/marketplace" onClick={(event) => followInApp(event, onMarketplace)} className="text-[13px] text-slate-600 transition hover:text-ink">Marketplace</a>
            <a href="/integrations" onClick={(event) => followInApp(event, onIntegrations)} className="text-[13px] text-slate-600 transition hover:text-ink">Integrations</a>
          </nav>

          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={mobileNavigationOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={mobileNavigationOpen}
              aria-controls="main-mobile-navigation"
              onClick={() => setMobileNavigationOpen((open) => !open)}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 md:hidden"
            >
              {mobileNavigationOpen ? <X size={17} /> : <Menu size={17} />}
            </button>
            <button
              type="button"
              onClick={openKeyDialog}
              className="group inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
            >
              {hasSession ? "Open HANNAH" : "Talk to HANNAH"} <ArrowRight size={13} className="transition group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
        {mobileNavigationOpen && (
          <nav id="main-mobile-navigation" aria-label="Mobile main navigation" className="border-t border-slate-200 bg-white/95 px-5 py-3 shadow-soft md:hidden">
            <div className="mx-auto flex max-w-7xl flex-col gap-1">
              {sections.map(([label, id]) => (
                <a key={id} href={`#${id}`} onClick={(event) => scrollToSection(event, id)} className="rounded-lg px-3 py-3 text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">{label}</a>
              ))}
              <a href="/marketplace" onClick={(event) => followInApp(event, () => { setMobileNavigationOpen(false); onMarketplace(); })} className="rounded-lg px-3 py-3 text-left text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">Marketplace</a>
              <a href="/integrations" onClick={(event) => followInApp(event, () => { setMobileNavigationOpen(false); onIntegrations(); })} className="rounded-lg px-3 py-3 text-left text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">Integrations</a>
            </div>
          </nav>
        )}
      </header>

      <div className="relative z-10">
        {/* Hero */}
        <section id="home" tabIndex={-1} className="mx-auto grid max-w-7xl items-center gap-10 px-5 pb-16 pt-10 outline-none sm:px-8 sm:pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:px-12 lg:pb-24">
          <div className="max-w-[40rem]">
            <a href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-brand-200 hover:text-ink">
              <span className="font-semibold text-brand-600">New in {APP_VERSION}</span>
              <span className="h-3 w-px bg-slate-200" aria-hidden="true" />
              Smart model routing, agent team, voice <ArrowRight size={12} />
            </a>
            <h1 className="display-title mt-6 text-[clamp(2.5rem,5.6vw,4.9rem)]">
              Your Personal AI.
              <span className="block text-brand-600">Your Intelligence.</span>
              <span className="block">Your World.</span>
            </h1>
            <p className="mt-6 max-w-[36rem] text-[16px] leading-[1.75] text-slate-600">
              HANNAH is an AI companion that talks with you, remembers what you ask it to, and gets real work done with a team of agents. You choose the models, where they run, and what HANNAH is allowed to do.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button type="button" onClick={openKeyDialog} className="btn-primary group min-h-[3.25rem] !gap-3 !rounded-2xl !px-6 text-sm">
                {hasSession ? "Open HANNAH" : "Talk to HANNAH"}
                <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
              </button>
              <a href="#download" onClick={(event) => scrollToSection(event, "download")} className="inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 text-sm font-semibold text-ink transition hover:border-brand-300">
                <Download size={15} /> Download the app
              </a>
            </div>
            <p className="mt-4 text-[13px] text-slate-500">Free to use with your own Groq key. No paid tiers.</p>
            <ul className="mt-9 grid gap-3 border-t border-slate-200 pt-6 text-[13px] text-slate-600 sm:grid-cols-3">
              <li className="flex items-center gap-2"><ShieldCheck size={15} className="shrink-0 text-emerald-600" aria-hidden="true" /> You approve every action</li>
              <li className="flex items-center gap-2"><LockKeyhole size={15} className="shrink-0 text-brand-600" aria-hidden="true" /> Private mode stays local</li>
              <li className="flex items-center gap-2"><MonitorSmartphone size={15} className="shrink-0 text-violet-600" aria-hidden="true" /> Web, desktop and Android</li>
            </ul>
          </div>

          <div className="relative mx-auto h-[min(60dvh,540px)] w-full max-w-[520px] lg:h-[min(70dvh,620px)] lg:min-h-[500px]">
            <div className="absolute inset-0 overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-[0_30px_90px_-40px_rgba(15,23,42,0.35)]">
              <div className="avatar-stage absolute inset-0" />
              <div className="absolute inset-0">
                <AvatarScene emotion="neutral" />
              </div>
              <p className="pointer-events-none absolute inset-x-4 bottom-4 rounded-xl border border-white/60 bg-white/85 px-3 py-2 text-center text-[12px] text-slate-600 backdrop-blur">
                Live 3D avatar: move your pointer, or tap her.
              </p>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="features" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
            <div className="max-w-2xl">
              <p className="section-kicker">Available now</p>
              <h2 className="section-title">One companion. Every kind of intelligence.</h2>
              <p className="section-desc">Everything on this list is in HANNAH {APP_VERSION} today.</p>
            </div>
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {capabilities.map((item) => {
                const { title, description } = item;
                const Icon = capabilityIcons[item.icon];
                return (
                <article key={title} className={`rounded-2xl border border-slate-200/80 bg-white p-6 shadow-soft ${"wide" in item ? "sm:col-span-2 lg:col-span-1" : ""}`}>
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon size={18} strokeWidth={1.8} aria-hidden="true" /></span>
                  <h3 className="mt-5 text-[15px] font-semibold text-ink">{title}</h3>
                  <p className="mt-2 text-[14px] leading-6 text-slate-600">{description}</p>
                </article>
                );
              })}
            <article className="rounded-2xl border border-violet-200/80 bg-violet-50/60 p-6 shadow-soft sm:col-span-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-violet-700 ring-1 ring-violet-200"><TerminalSquare size={18} strokeWidth={1.8} aria-hidden="true" /></span>
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-violet-800 ring-1 ring-violet-200">Desktop app</span>
              </div>
              <h3 className="mt-5 text-[15px] font-semibold text-ink">Files and terminal on desktop</h3>
              <p className="mt-2 max-w-3xl text-[14px] leading-6 text-slate-700">Share a project folder and HANNAH can read it, edit files in folders you mark read-write, and run commands such as your tests. You approve every write and every command in a system dialog, and the app enforces the folder limits itself, outside the AI model.</p>
            </article>
            </div>
          </div>
        </section>

        {/* Real screens */}
        <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
          <div className="max-w-2xl">
            <p className="section-kicker">The app</p>
            <h2 className="section-title">Designed to stay out of your way.</h2>
            <p className="section-desc">Take a look around. Pick a screen to see what it does.</p>
          </div>
          <AppTour version={APP_VERSION} />
        </section>

        {/* Privacy and control */}
        <section id="privacy" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none backdrop-blur-sm">
          <div className="mx-auto grid max-w-7xl gap-10 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:px-12">
            <div>
              <p className="section-kicker">Privacy and control</p>
              <h2 className="section-title">You stay in charge.</h2>
              <p className="section-desc">HANNAH enforces these rules in code, outside the AI model, so a clever prompt can't talk its way around them.</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2">
              {[
                ["Approval for every action", "HANNAH's Guardian checks each tool call, then waits for your yes before anything on your device or data changes."],
                ["Private mode means private", "The server refuses to send a Private-mode request to any hosted provider, even a model you picked by hand."],
                ["Your keys stay yours", "A visitor's Groq key lives only in that browser tab. Account keys are stored encrypted on the server."],
                ["Your data, your database", "History stays on your device. Accounts sync through a database you choose, and you can export or delete everything."],
              ].map(([title, text]) => (
                <li key={title} className="rounded-2xl border border-slate-200/80 bg-white p-5">
                  <p className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Check size={15} className="text-emerald-600" aria-hidden="true" /> {title}</p>
                  <p className="mt-2 text-[14px] leading-6 text-slate-600">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Roadmap */}
        <section className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
          <div className="max-w-2xl">
            <p className="section-kicker">Coming next</p>
            <h2 className="section-title">On the roadmap.</h2>
            <p className="section-desc">Planned and not in this release yet. Follow progress on GitHub.</p>
          </div>
          <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {roadmap.map(([title, text]) => (
              <li key={title} className="rounded-2xl border border-dashed border-slate-300 bg-white/50 p-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[14px] font-semibold text-ink">{title}</p>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Planned</span>
                </div>
                <p className="mt-2 text-[14px] leading-6 text-slate-600">{text}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Download */}
        <section id="download" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none backdrop-blur-sm">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24 lg:px-12">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-2xl">
                <p className="section-kicker">Download</p>
                <h2 className="section-title">HANNAH {APP_VERSION} for every device.</h2>
                <p className="section-desc">Installers come from the latest GitHub release, each with a SHA-256 checksum.</p>
              </div>
              <a href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-600 hover:text-brand-700">Release notes <ArrowRight size={13} /></a>
            </div>
            <div className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {PLATFORM_DOWNLOADS.map((platform) => (
                <article key={platform.id} aria-label={`HANNAH for ${platform.name}`} className="flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5">
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Boxes size={16} className="text-slate-500" aria-hidden="true" /> {platform.name}</h3>
                  <p className="mt-2 flex-1 text-[13px] leading-6 text-slate-600">{platform.note}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {platform.id === "web" && (
                      <button type="button" onClick={openKeyDialog} className="btn-primary !rounded-xl !px-4 !py-2 text-[13px]">Open the web app</button>
                    )}
                    {platform.files.map((file) => (
                      <a key={file.href} href={file.href} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-[13px] font-semibold text-ink transition hover:border-brand-300 hover:text-brand-700">
                        <Download size={14} aria-hidden="true" /> {file.label}
                      </a>
                    ))}
                    {platform.id === "ios" && !platform.files.length && (
                      <a href={`${REPOSITORY_URL}#mobile-desktop-and-pwa-builds`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3.5 py-2 text-[13px] font-semibold text-ink transition hover:border-brand-300">Build from source</a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" tabIndex={-1} className="mx-auto max-w-4xl px-5 py-20 outline-none sm:px-8 sm:py-24">
          <p className="section-kicker">Questions</p>
          <h2 className="section-title">Frequently asked.</h2>
          <div className="mt-8 divide-y divide-slate-200 rounded-2xl border border-slate-200/80 bg-white">
            {faqs.map(({ q, a }) => (
              <details key={q} className="group px-5 py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15px] font-semibold text-ink">
                  {q}
                  <ChevronDown size={16} className="shrink-0 text-slate-500 transition group-open:rotate-180" aria-hidden="true" />
                </summary>
                <p className="pb-5 text-[14px] leading-6 text-slate-600">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Closing call to action */}
        <section className="mx-auto max-w-7xl px-5 pb-20 sm:px-8 lg:px-12">
          <div className="flex flex-col items-start justify-between gap-6 rounded-[2rem] bg-ink px-7 py-10 text-white sm:px-10 lg:flex-row lg:items-center">
            <div>
              <h2 className="font-display text-[clamp(1.6rem,3vw,2.3rem)] font-medium tracking-tight">Say hello to HANNAH.</h2>
              <p className="mt-2 max-w-xl text-[15px] text-slate-300">Start in your browser in a minute with a free Groq key, or download the app.</p>
            </div>
            <button type="button" onClick={openKeyDialog} className="inline-flex min-h-[3rem] items-center gap-2 rounded-2xl bg-white px-6 text-sm font-semibold text-ink transition hover:bg-slate-100">
              {hasSession ? "Open HANNAH" : "Talk to HANNAH"} <ArrowRight size={15} />
            </button>
          </div>
        </section>

        <footer className="border-t border-slate-200 bg-white/70 pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto grid max-w-7xl gap-8 px-5 py-12 text-[13px] sm:grid-cols-2 sm:px-8 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:px-12">
            <div>
              <p className="flex items-center gap-2 font-semibold text-ink"><span className="logo-ring !h-5 !w-5" aria-hidden="true" /> HANNAH</p>
              <p className="mt-3 max-w-xs leading-6 text-slate-500">Your Personal AI. Your Intelligence. Your World.</p>
              <p className="mt-3 font-mono text-[12px] text-slate-500">Version {APP_VERSION}</p>
            </div>
            <div>
              <p className="font-semibold text-ink">Product</p>
              <ul className="mt-3 space-y-2 text-slate-600">
                <li><button type="button" onClick={openKeyDialog} className="hover:text-ink">Open the web app</button></li>
                <li><a href="#download" onClick={(event) => scrollToSection(event, "download")} className="hover:text-ink">Download</a></li>
                <li><a href="/marketplace" onClick={(event) => followInApp(event, onMarketplace)} className="hover:text-ink">Marketplace</a></li>
                <li><a href="/integrations" onClick={(event) => followInApp(event, onIntegrations)} className="hover:text-ink">API and integrations</a></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Resources</p>
              <ul className="mt-3 space-y-2 text-slate-600">
                <li><a href="/about/" className="hover:text-ink">About HANNAH</a></li>
                <li><a href={`${REPOSITORY_URL}#readme`} target="_blank" rel="noreferrer" className="hover:text-ink">Documentation</a></li>
                <li><a href={RELEASES_URL} target="_blank" rel="noreferrer" className="hover:text-ink">Releases</a></li>
                <li><a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className="hover:text-ink">Source code</a></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Legal</p>
              <ul className="mt-3 space-y-2 text-slate-600">
                <li><a href={`${REPOSITORY_URL}/blob/main/docs/PRIVACY_POLICY.md`} target="_blank" rel="noreferrer" className="hover:text-ink">Privacy policy</a></li>
                <li><a href={`${REPOSITORY_URL}/blob/main/docs/TERMS_OF_SERVICE.md`} target="_blank" rel="noreferrer" className="hover:text-ink">Terms of service</a></li>
                <li><a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className="hover:text-ink">License</a></li>
              </ul>
            </div>
          </div>
          <p className="mx-auto max-w-7xl px-5 pb-8 text-[12px] text-slate-500 sm:px-8 lg:px-12">© {new Date().getFullYear()} Harsh Tambade and HANNAH contributors. Source-available under the HANNAH Non-Commercial License.</p>
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
                <span className="pill-badge mt-6"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>{accountMode ? "Your account on this server" : "Free · No sign-up"}</span>
                <h2 id="connect-title" className="display-title mt-3 text-[2rem]">{accountMode ? "Welcome back." : "Connect with HANNAH."}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-700">{accountMode
                  ? `Sign in to use your saved keys, memories and reminders on any device. Stored on ${databaseLabel(accountInfo?.database.provider)}, run by this server's operator.`
                  : "Paste your own Groq API key and start talking. There's no account and nothing to pay."}</p>
              </div>

              {accountMode && accountInfo ? (
                <div className="px-6 pb-6 pt-5 sm:px-7">
                  <SignInForm signupAllowed={accountInfo.accounts.signup} vault={accountInfo.vault} onSignedIn={(key) => onStart({ apiToken: "", groqApiKey: key })} />
                  <button type="button" onClick={() => setAccountMode(false)} className="mt-4 w-full text-center text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-ink">Use a Groq key without an account</button>
                </div>
              ) : (
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
                {accountsEnabled && (
                  <button type="button" onClick={() => { setAccountMode(true); setKeyError(""); }} className="mt-4 w-full text-center text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-ink">Have an account? Sign in or create one</button>
                )}
              </form>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
