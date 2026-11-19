import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import ConnectPanel from "./ConnectPanel";
import {
  ArrowRight, AudioLines, Bot, Boxes, Brain, Bug, Cable, CalendarDays, Check, ChevronDown, Code2, Cpu, Download, Ear, FileText, HardDrive, History, LifeBuoy, LockKeyhole, Menu,
  MonitorSmartphone, PackageOpen, ShieldCheck, Sparkles, TerminalSquare, Waypoints, Workflow, X,
} from "lucide-react";
import AvatarScene from "./AvatarScene";
import {
  AGENTS as agents, AUTOMATION as automation, CAPABILITIES as capabilities, FAQS as faqs, MODEL_PROVIDERS as providers, PLATFORM_MATRIX as matrix,
  ROADMAP as roadmap, ROUTING_MODES as routingModes, type IconName, type Status,
} from "../content/landing";
import AppTour from "./AppTour";
import { APP_VERSION, PLATFORM_DOWNLOADS, RELEASE_NOTES_URL, RELEASES_URL, REPOSITORY_URL } from "../config/project";
import { SITE_URL } from "../config/site";
import { ConnectorWall, FactsStrip, HeroPrompt, StartSteps, UseCases, useServerFacts, type TryIt } from "./LandingExtras";

type LandingPageProps = {
  onStart: (credentials: { apiToken: string; groqApiKey: string }) => void;
  onIntegrations: () => void;
  onMarketplace: () => void;
  /** Open the chat with this message in the message box (and that marketplace agent on), connecting first if needed. */
  onTry: TryIt;
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

const STATUS_LABEL: Record<Status, string> = { available: "Available", beta: "Beta", upcoming: "Coming" };
const STATUS_STYLE: Record<Status, string> = {
  available: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  beta: "bg-amber-50 text-amber-900 ring-amber-200",
  upcoming: "bg-slate-100 text-slate-600 ring-slate-200",
};

function StatusChip({ status }: { status: Status }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

function SectionHeading({ kicker, title, children, invert = false }: { kicker: string; title: string; children?: ReactNode; invert?: boolean }) {
  return (
    <div className="max-w-2xl">
      <p className={invert ? "text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300" : "section-kicker"}>{kicker}</p>
      <h2 className={invert ? "mt-3 font-display text-[clamp(1.9rem,3.6vw,2.9rem)] font-medium leading-[1.08] tracking-tight text-white" : "section-title"}>{title}</h2>
      {children && <p className={invert ? "mt-4 text-[16px] leading-7 text-slate-300" : "section-desc"}>{children}</p>}
    </div>
  );
}

/** The developer example: the same request the Integrations page documents. */
const API_EXAMPLE = `curl "${SITE_URL}/v1/chat/completions" \\
  -H "X-Groq-API-Key: $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"hannah-auto","hannah":{"routing":{"mode":"budget"}},
       "messages":[{"role":"user","content":"Hi"}]}'`;

/** The pillars are their own sections; the overview lists everything else. */
const PILLAR_TITLES = new Set(["Any model, your choice", "Picks the right model for you", "A team of specialist agents", "Memory you own", "Local and offline", "Visual workflow automation", "Build on it", "Skills marketplace"]);

export default function LandingPage({ onStart, onIntegrations, onMarketplace, onTry, hasSession = false, onResume, openConnect = false, onConnectHandled }: LandingPageProps) {
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  // Phones: once the hero's button has scrolled away, keep one within reach.
  const [pastHero, setPastHero] = useState(false);
  // What this server really offers a newcomer (free accounts without a key? which connectors?), asked from the server.
  const { keyless, connectors } = useServerFacts();
  const freeNote = keyless
    ? "Free: create an account with an email. No API key, no card, no paid tiers."
    : "Free to use with your own Groq key, or with models on your own hardware. No paid tiers.";
  useEffect(() => {
    if (!openConnect) return;
    setKeyDialogOpen(true);
    onConnectHandled?.();
  }, [openConnect, onConnectHandled]);

  useEffect(() => {
    if (!keyDialogOpen) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setKeyDialogOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyDialogOpen]);

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
  const sectionLink = (id: string) => ({ href: `#${id}`, onClick: (event: MouseEvent<HTMLAnchorElement>) => scrollToSection(event, id) });

  // A link to /#privacy (for example from the About page) still lands on that section, and the address bar drops the "#privacy".
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || id.startsWith("/")) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const openKeyDialog = () => {
    if (hasSession && onResume) {
      onResume();
      return;
    }
    setKeyDialogOpen(true);
  };

  const sections: Array<[string, string]> = [["Features", "features"], ["Models", "models"], ["Agents", "agents"], ["Automation", "automation"], ["Privacy", "privacy"], ["Download", "download"], ["FAQ", "faq"]];
  const others = capabilities.filter((item) => !PILLAR_TITLES.has(item.title));

  return (
    <main onScroll={(event) => setPastHero(event.currentTarget.scrollTop > 560)} className="landing-page relative h-[100dvh] overflow-x-hidden overflow-y-auto bg-slate-50 text-ink selection:bg-brand-200/30">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-40 -top-40 h-[42rem] w-[42rem] rounded-full bg-brand-100/50 blur-[140px]" />
        <div className="landing-grain absolute inset-0 opacity-[0.06]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/80 pt-[env(safe-area-inset-top)] backdrop-blur-2xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-5 sm:px-8 lg:px-12">
          <a {...sectionLink("home")} className="flex items-center gap-2.5">
            <span className="logo-ring !h-6 !w-6" aria-hidden="true" />
            <span className="text-[15px] font-semibold tracking-tight text-ink">HANNAH</span>
            <span className="hidden rounded-full border border-slate-200 bg-white px-2 py-0.5 font-mono text-[10px] text-slate-500 sm:inline">v{APP_VERSION}</span>
          <span className="sr-only"> home</span></a>

          <nav className="hidden items-center gap-5 lg:flex xl:gap-6" aria-label="Main navigation">
            {sections.map(([label, id]) => (
              <a key={id} {...sectionLink(id)} className="text-[13px] text-slate-600 transition hover:text-ink">{label}</a>
            ))}
            <span className="h-4 w-px bg-slate-200" aria-hidden="true" />
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
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 lg:hidden"
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
          <nav id="main-mobile-navigation" aria-label="Mobile main navigation" className="max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-slate-200 bg-white/95 px-5 py-3 shadow-soft lg:hidden">
            <div className="mx-auto grid max-w-7xl grid-cols-2 gap-1">
              {[...sections, ["Developers", "developers"] as [string, string], ["Support", "support"] as [string, string]].map(([label, id]) => (
                <a key={id} {...sectionLink(id)} className="rounded-lg px-3 py-3 text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">{label}</a>
              ))}
              <a href="/marketplace" onClick={(event) => followInApp(event, () => { setMobileNavigationOpen(false); onMarketplace(); })} className="rounded-lg px-3 py-3 text-left text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">Marketplace</a>
              <a href="/integrations" onClick={(event) => followInApp(event, () => { setMobileNavigationOpen(false); onIntegrations(); })} className="rounded-lg px-3 py-3 text-left text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">Integrations</a>
              <a href="/about/" className="rounded-lg px-3 py-3 text-sm text-slate-700 transition hover:bg-brand-50 hover:text-brand-700">About</a>
            </div>
          </nav>
        )}
      </header>

      <div className="relative z-10">
        {/* Hero */}
        <section id="home" tabIndex={-1} className="mx-auto grid max-w-7xl items-center gap-10 px-5 pb-14 pt-10 outline-none sm:px-8 sm:pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:px-12 lg:pb-20">
          <div className="min-w-0 max-w-[40rem]">
            <a {...sectionLink("try")} className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-brand-200 hover:text-ink">
              <span className="font-semibold text-brand-700">New</span>
              <span className="h-3 w-px shrink-0 bg-slate-200" aria-hidden="true" />
              <span className="truncate">Agents, skills and connectors you can turn on in one click</span> <ArrowRight size={12} className="shrink-0" />
            </a>
            <h1 className="display-title mt-6 text-[clamp(2.5rem,5.6vw,4.9rem)]">
              Your Personal AI.
              <span className="block text-brand-600">Your Intelligence.</span>
              <span className="block">Your World.</span>
            </h1>
            <p className="mt-6 max-w-[36rem] text-[16px] leading-[1.75] text-slate-600">
              HANNAH is an AI companion that talks with you, remembers what you ask her to, and gets real work done: she searches the web, sets your reminders, works in the tools you connect and runs workflows on her own. You choose the model and approve every action.
            </p>
            <HeroPrompt onTry={onTry} />
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button type="button" onClick={openKeyDialog} className="btn-primary group min-h-[3.25rem] !gap-3 !rounded-2xl !px-6 text-sm">
                {hasSession ? "Open HANNAH" : "Talk to HANNAH"}
                <ArrowRight size={15} className="transition group-hover:translate-x-0.5" />
              </button>
              <a {...sectionLink("download")} className="inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-5 text-sm font-semibold text-ink transition hover:border-brand-300">
                <Download size={15} /> Download the app
              </a>
            </div>
            <p className="mt-4 text-[13px] text-slate-500">{freeNote}</p>
            <ul className="mt-9 grid gap-3 border-t border-slate-200 pt-6 text-[13px] text-slate-600 sm:grid-cols-3">
              <li className="flex items-center gap-2"><ShieldCheck size={15} className="shrink-0 text-emerald-600" aria-hidden="true" /> You approve every action</li>
              <li className="flex items-center gap-2"><LockKeyhole size={15} className="shrink-0 text-brand-600" aria-hidden="true" /> Private mode stays local</li>
              <li className="flex items-center gap-2"><MonitorSmartphone size={15} className="shrink-0 text-violet-600" aria-hidden="true" /> Web, Mac, Windows, Linux, Android</li>
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

        {/* Works with */}
        <div className="border-y border-slate-200/70 bg-white/70">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-5 sm:px-8 lg:flex-row lg:items-center lg:gap-8 lg:px-12">
            <p className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Works with</p>
            <p className="text-[13px] leading-6 text-slate-600">{[...providers.cloud.slice(0, 9), "Ollama", "LM Studio", "llama.cpp", "WebLLM"].join(" · ")} <span className="text-slate-500">and more</span></p>
          </div>
        </div>

        <FactsStrip connectors={connectors?.length ?? null} />

        {/* Try it */}
        <section id="try" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20 lg:px-12">
            <SectionHeading kicker="Try it now" title="Pick something. HANNAH takes it from there.">Each one opens the chat with the right agent switched on and the message ready to send. Change it, send it, or write your own.</SectionHeading>
            <UseCases onTry={onTry} />
          </div>
        </section>

        {/* Overview */}
        <section id="features" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-14 outline-none sm:px-8 sm:py-20 lg:py-24 lg:px-12">
          <SectionHeading kicker="What HANNAH does" title="One companion. Every kind of intelligence.">Four things HANNAH is built around, and everything else it does. Each feature is labelled when it's in beta or still coming.</SectionHeading>
          <div className="mt-10 grid gap-3 md:grid-cols-2">
            {[
              { id: "models", icon: Cpu, title: "Any model, picked for you", text: "20 providers, cloud or on your own hardware. Auto mode chooses a model for each message, explains why, and falls back if a provider fails.", accent: "text-sky-700 bg-sky-50" },
              { id: "agents", icon: Bot, title: "Agents that get work done", text: "A team of Research, Coding, Memory and Tasks agents plans, works in parallel and checks the result. On desktop, they can work in folders you share.", accent: "text-violet-700 bg-violet-50" },
              { id: "automation", icon: Workflow, title: "Workflows that run on their own", text: "A visual editor and a server engine: triggers, AI steps, conditions and integrations, with retries, approvals and a record of every step.", accent: "text-amber-800 bg-amber-50" },
              { id: "privacy", icon: Brain, title: "Memory and privacy you control", text: "See, edit, export or delete what HANNAH remembers. Private mode keeps every request on your own hardware.", accent: "text-emerald-700 bg-emerald-50" },
            ].map(({ id, icon: Icon, title, text, accent }) => (
              <a key={id} {...sectionLink(id)} className="group flex gap-4 rounded-2xl border border-slate-200/80 bg-white p-6 transition hover:border-brand-200 hover:shadow-soft">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accent}`}><Icon size={19} strokeWidth={1.8} aria-hidden="true" /></span>
                <span>
                  <span className="flex items-center gap-1.5 text-[16px] font-semibold text-ink">{title} <ArrowRight size={14} className="text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-brand-600" aria-hidden="true" /></span>
                  <span className="mt-1.5 block text-[14px] leading-6 text-slate-600">{text}</span>
                </span>
              </a>
            ))}
          </div>
          <h3 className="mt-14 text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-500">Also in HANNAH</h3>
          <ul className="mt-5 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((item) => {
              const Icon = capabilityIcons[item.icon];
              return (
                <li key={item.title} className="flex gap-3">
                  <Icon size={18} strokeWidth={1.8} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />
                  <span>
                    <span className="block text-[14px] font-semibold text-ink">{item.title}</span>
                    <span className="mt-1 block text-[13px] leading-6 text-slate-600">{item.description}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Models */}
        <section id="models" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none">
          <div className="mx-auto grid max-w-7xl gap-12 px-5 py-14 sm:px-8 sm:py-20 lg:py-24 lg:grid-cols-[1fr_1fr] lg:px-12">
            <div>
              <SectionHeading kicker="AI models" title="Bring any model. Or let HANNAH choose.">Use your own key with the cloud providers you already have, or keep everything on your hardware. Switch at any time; your history and memories stay the same.</SectionHeading>
              <div className="mt-8 space-y-5">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">Cloud, with your key</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">{providers.cloud.map((name) => <li key={name} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] text-slate-700">{name}</li>)}</ul>
                </div>
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">On your own hardware</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">{providers.local.map((name) => <li key={name} className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 py-1 text-[12px] text-emerald-900">{name}</li>)}</ul>
                </div>
              </div>
              <p className="mt-6 text-[13px] leading-6 text-slate-500">Before you send, HANNAH shows which model will answer and why, and asks first when a message would be expensive. Set a daily budget and requests stop once it's reached.</p>
            </div>
            <div className="rounded-[1.75rem] border border-slate-200 bg-white p-2 shadow-[0_30px_80px_-50px_rgba(15,23,42,0.45)]">
              <div className="flex items-center justify-between px-4 pb-2 pt-3">
                <p className="text-[13px] font-semibold text-ink">Auto routing</p>
                <p className="text-[11px] text-slate-500">Settings → Models</p>
              </div>
              <ul className="divide-y divide-slate-100 rounded-[1.25rem] border border-slate-100" aria-label="Auto routing modes">
                {routingModes.map(([label, text], index) => (
                  <li key={label} className="flex gap-3 px-4 py-3.5">
                    <span className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${index === 0 ? "border-brand-600" : "border-slate-300"}`} aria-hidden="true">{index === 0 && <span className="h-2 w-2 rounded-full bg-brand-600" />}</span>
                    <span>
                      <span className="flex items-center gap-2 text-[14px] font-semibold text-ink">{label}{label === "Private" && <LockKeyhole size={13} className="text-emerald-600" aria-hidden="true" />}</span>
                      <span className="mt-0.5 block text-[13px] leading-5 text-slate-600">{text}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Agents */}
        <section id="agents" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-14 outline-none sm:px-8 sm:py-20 lg:py-24 lg:px-12">
          <SectionHeading kicker="AI agents" title="A team for the hard questions.">Turn on Team and HANNAH breaks your request into steps, gives each to a specialist, runs them in parallel, and checks the result before answering. Guardian reviews every tool call, and anything that changes your data waits for your yes.</SectionHeading>
          <ol className="mt-10 grid items-stretch gap-3 lg:grid-cols-[1fr_auto_2fr_auto_1fr_auto_1fr]" aria-label="How a Team request runs">
            <li className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">1 · Plan</p><p className="mt-2 text-[14px] leading-6 text-slate-700">Your request becomes steps, each with the right specialist.</p></li>
            <li className="hidden items-center text-slate-300 lg:flex" aria-hidden="true"><ArrowRight size={18} /></li>
            <li className="rounded-2xl border border-violet-200 bg-violet-50/50 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-800">2 · Specialists, in parallel</p>
              <ul className="mt-3 grid grid-cols-2 gap-2">{agents.team.map((name) => <li key={name} className="rounded-xl border border-violet-200 bg-white px-3 py-2 text-[13px] font-medium text-violet-900">{name}</li>)}</ul>
            </li>
            <li className="hidden items-center text-slate-300 lg:flex" aria-hidden="true"><ArrowRight size={18} /></li>
            <li className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">3 · Verify</p><p className="mt-2 text-[14px] leading-6 text-slate-700">The result is checked against your request; failed steps retry.</p></li>
            <li className="hidden items-center text-slate-300 lg:flex" aria-hidden="true"><ArrowRight size={18} /></li>
            <li className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-5"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-800">4 · You approve</p><p className="mt-2 text-[14px] leading-6 text-slate-700">Actions wait for you, on this device or any signed-in one.</p></li>
          </ol>
          <div className="mt-12 grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <h3 className="flex items-center gap-2 text-[17px] font-semibold text-ink"><TerminalSquare size={18} className="text-violet-700" aria-hidden="true" /> On your computer</h3>
              <p className="mt-2 text-[14px] leading-6 text-slate-600">In the desktop app, agents can work with your files. The app enforces the limits itself, outside the AI model, so a prompt can't talk its way past them.</p>
            </div>
            <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {agents.computer.map((item) => (
                <li key={item.name} className="flex flex-col gap-1.5 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
                  <span className="flex flex-wrap items-center gap-2 sm:w-64 sm:shrink-0"><span className="text-[14px] font-semibold text-ink">{item.name}</span><StatusChip status={item.status} /></span>
                  <span className="text-[13px] leading-6 text-slate-600">{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Automation */}
        <section id="automation" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none">
          <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20 lg:py-24 lg:px-12">
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
              <div>
                <SectionHeading kicker="Automation" title="Workflows you can watch work.">Build automations on a canvas the way you'd sketch them: a trigger, then steps that read, decide, call AI and act. They run on HANNAH's server, so a schedule, a new email or a webhook doesn't need your laptop open, and every run shows what each step received and produced.</SectionHeading>
                <p className="mt-4 text-[13px] text-slate-500">For signed-in accounts on a HANNAH server with its database set up. Without an account, simpler routines run on your device while HANNAH is open.</p>
              </div>
              <figure className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white shadow-[0_30px_90px_-45px_rgba(15,23,42,0.45)]">
                <img src="/screens/workflow-editor.webp" width={1600} height={833} loading="lazy" decoding="async" alt="HANNAH's workflow editor after a test run: Invoice arrives (webhook), Extract invoice, AI review and Over 1,000? each marked Done with one item; the true branch saves the invoice and notifies, the false branch is skipped; the run panel lists every step's time." className="block h-auto w-full" />
                <figcaption className="border-t border-slate-100 px-4 py-2.5 text-[12px] text-slate-500">A real test run of the invoice workflow below: each step shows its result on the canvas.</figcaption>
              </figure>
            </div>

            <ol className="mt-10 flex flex-wrap items-center gap-2" aria-label="Example workflow">
              {automation.flow.map((step, index) => (
                <li key={step} className="flex items-center gap-2">
                  <span className={`rounded-xl border px-3 py-1.5 text-[13px] font-medium ${index === 0 ? "border-amber-200 bg-amber-50 text-amber-900" : index === 3 ? "border-violet-200 bg-violet-50 text-violet-900" : index === 1 || index === 2 ? "border-rose-200 bg-rose-50 text-rose-900" : "border-sky-200 bg-sky-50 text-sky-900"}`}>{step}</span>
                  {index < automation.flow.length - 1 && <ArrowRight size={14} className="text-slate-400" aria-hidden="true" />}
                </li>
              ))}
            </ol>

            <dl className="mt-10 grid gap-x-10 border-t border-slate-200 sm:grid-cols-2">
              {automation.points.map(([title, text]) => (
                <div key={title} className="border-b border-slate-200 py-5">
                  <dt className="text-[14px] font-semibold text-ink">{title}</dt>
                  <dd className="mt-1.5 text-[13px] leading-6 text-slate-600">{text}</dd>
                </div>
              ))}
            </dl>

            <div id="integrations" className="mt-12 grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
              <figure className="overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white">
                <img src="/screens/workflow-runs.webp" width={1600} height={920} loading="lazy" decoding="async" alt="The runs view: a completed run of Invoice intake with each step's duration; the Extract invoice step is open, showing the webhook text as input and vendor Acme, amount 1250.5 and date 2026-12-01 as output." className="block h-auto w-full" />
                <figcaption className="border-t border-slate-100 px-4 py-2.5 text-[12px] text-slate-500">Every run keeps each step's input, output, timing and errors. Here, the AI extraction turned an invoice's text into fields.</figcaption>
              </figure>
              <div>
                <h3 className="text-[17px] font-semibold text-ink">Steps and integrations</h3>
                <p className="mt-1 text-[13px] text-slate-600">Plus If, Switch, Merge, Wait, Approval and data steps. Status as of version {APP_VERSION}:</p>
                <ul className="mt-4 grid grid-cols-2 gap-2" aria-label="Workflow integrations">
                  {automation.integrations.map((item) => (
                    <li key={item.type} className="flex flex-col items-start justify-between gap-1.5 rounded-xl border border-slate-200/80 bg-white px-3 py-2 text-[12px] sm:flex-row sm:items-center sm:gap-2 sm:text-[13px]">
                      <span className="text-ink">{item.name}</span>
                      <StatusChip status={item.status} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Connectors */}
        {connectors && connectors.length > 0 && (
          <section id="connect" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-14 outline-none sm:px-8 sm:py-20 lg:px-12 lg:py-24">
            <SectionHeading kicker="Connectors" title="Works in the tools you already use.">Connect {connectors.length} services with your own sign-in, each through the service's own MCP server. Your tokens stay in your browser, and HANNAH asks before every action she takes in them.</SectionHeading>
            <ConnectorWall connectors={connectors} onMarketplace={onMarketplace} marketplaceHref="/marketplace" />
          </section>
        )}

        {/* Real screens */}
        <section className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20 lg:py-24 lg:px-12">
          <SectionHeading kicker="The app" title="Designed to stay out of your way.">Take a look around. Pick a screen to see what it does.</SectionHeading>
          <AppTour version={APP_VERSION} />
        </section>

        {/* Memory and privacy */}
        <section id="privacy" tabIndex={-1} className="bg-ink text-white outline-none">
          <div className="mx-auto grid max-w-7xl gap-12 px-5 py-14 sm:px-8 sm:py-20 lg:py-24 lg:grid-cols-[0.85fr_1.15fr] lg:px-12">
            <div>
              <SectionHeading kicker="Memory and privacy" title="You stay in charge." invert>HANNAH enforces these rules in code, outside the AI model, so a clever prompt can't talk its way around them.</SectionHeading>
              <a href={`${REPOSITORY_URL}/blob/main/docs/PRIVACY_POLICY.md`} target="_blank" rel="noreferrer" className="mt-8 inline-flex items-center gap-1.5 text-[13px] font-semibold text-sky-300 hover:text-sky-200">Read the privacy policy <ArrowRight size={13} /></a>
            </div>
            <ul className="grid gap-x-8 gap-y-7 sm:grid-cols-2">
              {[
                ["Memory you can see", "Every memory shows where it came from and when it was used. Edit, export or delete any of it, or turn memory off."],
                ["Only what's relevant is sent", "Each message carries the memories related to it, not everything. Sensitive ones go only to local models."],
                ["Approval for every action", "Guardian checks each tool call, then waits for your yes before anything on your device or data changes."],
                ["Private mode means private", "The server refuses to send a Private-mode request to any hosted provider, even a model you picked by hand."],
                ["Your keys stay yours", "A visitor's Groq key lives only in that browser tab. Account keys and workflow credentials are stored encrypted."],
                ["Your data, your database", "History stays on your device. Accounts sync through a database you choose, and you can export or delete everything."],
              ].map(([title, text]) => (
                <li key={title}>
                  <p className="flex items-center gap-2 text-[15px] font-semibold"><Check size={15} className="text-emerald-400" aria-hidden="true" /> {title}</p>
                  <p className="mt-1.5 text-[14px] leading-6 text-slate-300">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Download and platforms */}
        <section id="download" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-14 outline-none sm:px-8 sm:py-20 lg:py-24 lg:px-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <SectionHeading kicker="Download" title={`HANNAH ${APP_VERSION} for every device.`}>Installers come from the latest GitHub release, each with a SHA-256 checksum. Your account, memories and tasks follow you between them.</SectionHeading>
            <a href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-600 hover:text-brand-700">What's new in {APP_VERSION} <ArrowRight size={13} /></a>
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

          <div className="mt-12">
            <h3 className="text-[17px] font-semibold text-ink">What works where</h3>
            <div tabIndex={0} role="region" aria-label="Features by platform (scrolls sideways)" className="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300">
              <table className="w-full min-w-[42rem] text-left text-[13px]">
                <caption className="sr-only">Features by platform</caption>
                <thead className="bg-slate-50 text-[12px] text-slate-600">
                  <tr><th scope="col" className="px-4 py-3 font-semibold">Feature</th>{matrix.columns.map((column) => <th key={column} scope="col" className="px-4 py-3 font-semibold">{column}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {matrix.rows.map(([feature, ...cells]) => (
                    <tr key={feature}>
                      <th scope="row" className="px-4 py-3 font-medium text-ink">{feature}</th>
                      {cells.map((cell, index) => (
                        <td key={index} className="px-4 py-3 text-slate-600">
                          {cell === "yes" ? <Check size={16} className="text-emerald-600" aria-label="Yes" /> : cell === "—" ? <span className="text-slate-400" aria-label="Not available">—</span> : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[12px] text-slate-500">The full matrix, with how each cell was checked: <a href={`${REPOSITORY_URL}/blob/main/docs/PLATFORM_SUPPORT.md`} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:text-brand-700">platform support</a>.</p>
          </div>
        </section>

        {/* Developers */}
        <section id="developers" tabIndex={-1} className="border-y border-slate-200/70 bg-white/60 outline-none">
          <div className="mx-auto grid max-w-7xl gap-10 px-5 py-14 sm:px-8 sm:py-20 lg:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:px-12">
            <div>
              <SectionHeading kicker="Developers" title="Build on HANNAH.">An OpenAI-compatible API with HANNAH's routing, an MCP server and client, agent-to-agent (A2A) messaging, signed webhooks, a JavaScript SDK and a skills marketplace.</SectionHeading>
              <div className="mt-7 flex flex-wrap gap-3">
                <a href="/integrations" onClick={(event) => followInApp(event, onIntegrations)} className="btn-primary !rounded-xl !px-4 !py-2.5 text-[13px]"><Cable size={14} /> API and integrations</a>
                <a href="/marketplace" onClick={(event) => followInApp(event, onMarketplace)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-ink transition hover:border-brand-300"><PackageOpen size={14} /> Skills marketplace</a>
              </div>
            </div>
            <figure className="min-w-0 overflow-hidden rounded-[1.25rem] border border-slate-800 bg-slate-950 text-slate-100">
              <figcaption className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5 text-[12px] text-slate-400"><Code2 size={13} aria-hidden="true" /> Any OpenAI client works. Here, Auto routing on a budget with your Groq key:</figcaption>
              <pre tabIndex={0} aria-label="Example request" className="overflow-x-auto p-4 font-mono text-[12px] leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"><code>{API_EXAMPLE}</code></pre>
            </figure>
          </div>
        </section>

        {/* Roadmap */}
        <section id="roadmap" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-14 outline-none sm:px-8 sm:py-20 lg:py-24 lg:px-12">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <SectionHeading kicker="Coming next" title="On the roadmap.">Planned and not in this release. Everything above is labelled Available, Beta or Coming, and only Available features are promised to work everywhere they're listed.</SectionHeading>
              <ul className="mt-6 flex flex-wrap gap-2" aria-label="Status labels">
                {(["available", "beta", "upcoming"] as Status[]).map((status) => <li key={status}><StatusChip status={status} /></li>)}
              </ul>
            </div>
            <ul className="divide-y divide-slate-200 border-y border-slate-200">
              {roadmap.map(([title, text]) => (
                <li key={title} className="py-5">
                  <p className="flex items-center gap-2 text-[15px] font-semibold text-ink">{title} <StatusChip status="upcoming" /></p>
                  <p className="mt-1.5 text-[14px] leading-6 text-slate-600">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" tabIndex={-1} className="border-t border-slate-200/70 bg-white/60 outline-none">
          <div className="mx-auto max-w-4xl px-5 py-14 sm:px-8 sm:py-20 lg:py-24">
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
          </div>
        </section>

        {/* Support */}
        <section id="support" tabIndex={-1} className="mx-auto max-w-7xl px-5 py-14 outline-none sm:px-8 sm:py-20 lg:px-12">
          <SectionHeading kicker="Help and support" title="Stuck, or found a bug?" />
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: Bug, title: "Report a problem", text: "Open a GitHub issue with what happened. Settings → Diagnostics exports a report with keys removed.", href: `${REPOSITORY_URL}/issues/new` },
              { icon: FileText, title: "Documentation", text: "Setup, self-hosting, the API, workflows and the security model.", href: `${REPOSITORY_URL}#readme` },
              { icon: History, title: "Releases and changelog", text: "What changed in each version, with installers and checksums.", href: `${REPOSITORY_URL}/blob/main/docs/CHANGELOG.md` },
              { icon: LifeBuoy, title: "Security contact", text: "Found a vulnerability? Open an issue asking for a private contact; don't post the details.", href: `${REPOSITORY_URL}/issues/new?title=${encodeURIComponent("Security contact request")}` },
            ].map(({ icon: Icon, title, text, href }) => (
              <li key={title}>
                <a href={href} target="_blank" rel="noreferrer" className="group flex h-full flex-col rounded-2xl border border-slate-200/80 bg-white p-5 transition hover:border-brand-200">
                  <Icon size={18} strokeWidth={1.8} className="text-brand-600" aria-hidden="true" />
                  <span className="mt-3 flex items-center gap-1.5 text-[14px] font-semibold text-ink">{title} <ArrowRight size={13} className="text-slate-400 transition group-hover:translate-x-0.5" aria-hidden="true" /></span>
                  <span className="mt-1.5 text-[13px] leading-6 text-slate-600">{text}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        {/* How to start */}
        <section id="start" tabIndex={-1} className="mx-auto max-w-7xl px-5 pb-14 outline-none sm:px-8 sm:pb-20 lg:px-12">
          <SectionHeading kicker="Getting started" title="Talking to HANNAH takes about a minute." />
          <StartSteps keyless={keyless} />
        </section>

        {/* Closing call to action */}
        <section className="mx-auto max-w-7xl px-5 pb-14 sm:px-8 sm:pb-20 lg:px-12">
          <div className="flex flex-col items-start justify-between gap-6 rounded-[2rem] bg-ink px-7 py-10 text-white sm:px-10 lg:flex-row lg:items-center">
            <div>
              <h2 className="font-display text-[clamp(1.6rem,3vw,2.3rem)] font-medium tracking-tight">Say hello to HANNAH.</h2>
              <p className="mt-2 max-w-xl text-[15px] text-slate-300">{keyless ? "Start in your browser with a free account, no API key needed, or download the app." : "Start in your browser in a minute with a free Groq key, or download the app."}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={openKeyDialog} className="inline-flex min-h-[3rem] items-center gap-2 rounded-2xl bg-white px-6 text-sm font-semibold text-ink transition hover:bg-slate-100">
                {hasSession ? "Open HANNAH" : "Talk to HANNAH"} <ArrowRight size={15} />
              </button>
              <a {...sectionLink("download")} className="inline-flex min-h-[3rem] items-center gap-2 rounded-2xl border border-white/20 px-5 text-sm font-semibold text-white transition hover:bg-white/10"><Download size={15} /> Get the apps</a>
            </div>
          </div>
        </section>

        <footer className="border-t border-slate-200 bg-white/70 pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto grid max-w-7xl gap-8 px-5 py-12 text-[13px] sm:grid-cols-2 sm:px-8 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] lg:px-12">
            <div>
              <p className="flex items-center gap-2 font-semibold text-ink"><span className="logo-ring !h-5 !w-5" aria-hidden="true" /> HANNAH</p>
              <p className="mt-3 max-w-xs leading-6 text-slate-500">Your Personal AI. Your Intelligence. Your World.</p>
              <p className="mt-3 font-mono text-[12px] text-slate-500">Version {APP_VERSION}</p>
            </div>
            <div>
              <p className="font-semibold text-ink">Product</p>
              <ul className="mt-3 space-y-2 text-slate-600">
                <li><button type="button" onClick={openKeyDialog} className="hover:text-ink">Open the web app</button></li>
                <li><a {...sectionLink("models")} className="hover:text-ink">AI models</a></li>
                <li><a {...sectionLink("agents")} className="hover:text-ink">AI agents</a></li>
                <li><a {...sectionLink("automation")} className="hover:text-ink">Automation</a></li>
                <li><a {...sectionLink("download")} className="hover:text-ink">Download</a></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Developers</p>
              <ul className="mt-3 space-y-2 text-slate-600">
                <li><a href="/integrations" onClick={(event) => followInApp(event, onIntegrations)} className="hover:text-ink">API and integrations</a></li>
                <li><a href="/marketplace" onClick={(event) => followInApp(event, onMarketplace)} className="hover:text-ink">Marketplace</a></li>
                <li><a href={`${REPOSITORY_URL}#readme`} target="_blank" rel="noreferrer" className="hover:text-ink">Documentation</a></li>
                <li><a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className="hover:text-ink">Source code</a></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-ink">Resources</p>
              <ul className="mt-3 space-y-2 text-slate-600">
                <li><a href="/about/" className="hover:text-ink">About HANNAH</a></li>
                <li><a href={RELEASES_URL} target="_blank" rel="noreferrer" className="hover:text-ink">Releases</a></li>
                <li><a href={`${REPOSITORY_URL}/blob/main/docs/CHANGELOG.md`} target="_blank" rel="noreferrer" className="hover:text-ink">Changelog</a></li>
                <li><a {...sectionLink("faq")} className="hover:text-ink">FAQ</a></li>
                <li><a {...sectionLink("support")} className="hover:text-ink">Support</a></li>
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

      {pastHero && !keyDialogOpen && !mobileNavigationOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:hidden">
          <button type="button" onClick={openKeyDialog} className="btn-primary min-h-[3rem] w-full !rounded-2xl text-sm">
            {hasSession ? "Open HANNAH" : keyless ? "Start free: no API key needed" : "Talk to HANNAH: it's free"} <ArrowRight size={15} />
          </button>
        </div>
      )}

      {keyDialogOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-ink/40 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget) setKeyDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="connect-title" className="deck-frame relative my-auto w-full max-w-md">
            <ConnectPanel onStart={onStart} onClose={() => setKeyDialogOpen(false)} />
          </section>
        </div>
      )}
    </main>
  );
}
