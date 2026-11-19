import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { ArrowRight, BookOpen, CalendarCheck, MessageCircleHeart, PenLine, Search, UserRoundCheck } from "lucide-react";
import catalog from "../../../shared/marketplace-catalog.json";
import { Account } from "../services/Account";
import { loadCatalog, type CatalogEntry } from "../services/Connectors";
import { MODEL_PROVIDERS } from "../content/landing";
import { PLATFORM_DOWNLOADS } from "../config/project";

export type TryIt = (prompt: string, agentId?: string) => void;

/**
 * What this server offers a new visitor, asked from the server itself, so the
 * page never promises something this deployment doesn't do:
 * - keyless: accounts can use the server's own models (no API key to find);
 * - connectors: the live connector directory.
 * Both are null until the server has answered (and in the pre-rendered page).
 */
export function useServerFacts() {
  const [keyless, setKeyless] = useState<boolean | null>(null);
  const [connectors, setConnectors] = useState<CatalogEntry[] | null>(null);
  useEffect(() => {
    let active = true;
    Account.status().then((status) => { if (active) setKeyless(Boolean(status.accounts.enabled && status.accounts.signup && status.accounts.serverKeys)); }).catch(() => { if (active) setKeyless(false); });
    loadCatalog().then((list) => { if (active) setConnectors(list); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return { keyless, connectors };
}

const starter = (id: string) => (catalog.find((item) => item.id === id)?.starters[0] ?? "").trim();

const HERO_PROMPTS = [
  "Plan my day: I need to finish a report, go to the gym and call my mum.",
  "Explain how HTTPS keeps a connection secure.",
  "Draft a polite email asking my landlord to fix the heating this week.",
];

/** Type a first message on the home page; it's waiting in the chat's message box when the chat opens. */
export function HeroPrompt({ onTry }: { onTry: TryIt }) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) onTry(text.trim());
  };
  return (
    <div className="mt-8">
      <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.45)] transition focus-within:border-brand-300">
        <label htmlFor="hero-prompt" className="sr-only">Your first message to HANNAH</label>
        <input id="hero-prompt" value={text} onChange={(event) => setText(event.target.value.slice(0, 2000))} placeholder="Ask HANNAH anything…" autoComplete="off" enterKeyHint="send" className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[15px] text-ink outline-none placeholder:text-slate-400" />
        <button type="submit" disabled={!text.trim()} className="btn-primary !rounded-xl !px-4 !py-2.5 text-sm disabled:opacity-40">Ask <ArrowRight size={14} /></button>
      </form>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Example messages">
        {HERO_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button type="button" onClick={() => onTry(prompt)} className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-left text-[12px] text-slate-700 transition hover:border-brand-300 hover:text-ink">{prompt}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Counts read from the product's own data, never typed in. */
export function FactsStrip({ connectors }: { connectors: number | null }) {
  const facts: Array<[string, string]> = [
    [String(MODEL_PROVIDERS.cloud.length + MODEL_PROVIDERS.local.length), "ways to run a model, cloud or your own hardware"],
    ...(connectors ? [[String(connectors), "services to connect with your own sign-in"] as [string, string]] : []),
    [String(catalog.length), `agents and skills (${catalog.filter((item) => item.type === "agent").length} agents, ${catalog.filter((item) => item.type === "skill").length} skills)`],
    [String(PLATFORM_DOWNLOADS.length), "platforms, with your account in sync across them"],
  ];
  return (
    <dl className="mx-auto grid max-w-7xl grid-cols-2 gap-x-6 gap-y-5 px-5 py-8 sm:px-8 lg:grid-cols-4 lg:px-12" aria-label="HANNAH in numbers">
      {facts.map(([value, label]) => (
        <div key={label} className="flex flex-col-reverse justify-end">
          <dt className="mt-1 text-[13px] leading-5 text-slate-600">{label}</dt>
          <dd className="font-display text-[2rem] font-medium leading-none tracking-tight text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const USE_CASES = [
  { title: "Learn something properly", body: "Study coach explains one idea at a time, checks you understood, then quizzes you until it sticks.", agentId: "study-coach", prompt: starter("study-coach"), icon: BookOpen, tone: "bg-sky-50 text-sky-700" },
  { title: "Get an answer with sources", body: "Research analyst searches the web, reads the pages and tells you what it found and where.", agentId: "research-analyst", prompt: starter("research-analyst"), icon: Search, tone: "bg-violet-50 text-violet-700" },
  { title: "Plan your day and be reminded", body: "Daily organizer checks what's already scheduled, plans around your priorities and sets the reminders.", agentId: "daily-organizer", prompt: starter("daily-organizer"), icon: CalendarCheck, tone: "bg-emerald-50 text-emerald-700" },
  { title: "Write it, in your voice", body: "Writing partner drafts and tightens emails, posts and documents without flattening how you sound.", agentId: "writing-partner", prompt: starter("writing-partner"), icon: PenLine, tone: "bg-amber-50 text-amber-700" },
  { title: "Practise before the real thing", body: "Interview coach runs a mock interview one question at a time, with specific feedback on each answer.", agentId: "interview-coach", prompt: starter("interview-coach"), icon: UserRoundCheck, tone: "bg-rose-50 text-rose-700" },
  { title: "Or just talk", body: "No agent, no task. HANNAH listens, remembers what you ask her to, and answers in English, Hindi or Marathi.", agentId: undefined, prompt: "I want to talk through something that's been on my mind.", icon: MessageCircleHeart, tone: "bg-cyan-50 text-cyan-700" },
] as const;

/** What people use HANNAH for. Each card opens the chat with that agent on and its message ready to send. */
export function UseCases({ onTry }: { onTry: TryIt }) {
  return (
    <ul className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Things to try">
      {USE_CASES.map((item) => (
        <li key={item.title} className="flex flex-col rounded-[1.5rem] border border-slate-200 bg-white p-5 transition hover:border-brand-200 hover:shadow-[0_20px_50px_-34px_rgba(15,23,42,0.4)]">
          <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${item.tone}`} aria-hidden="true"><item.icon size={18} /></span>
          <h3 className="mt-4 text-[16px] font-semibold text-ink">{item.title}</h3>
          <p className="mt-1.5 text-[13px] leading-6 text-slate-600">{item.body}</p>
          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[12px] leading-5 text-slate-700">“{item.prompt}”</p>
          <button type="button" onClick={() => onTry(item.prompt, item.agentId)} aria-label={`Try it: ${item.title}`} className="mt-auto inline-flex items-center gap-1.5 self-start pt-4 text-[13px] font-semibold text-brand-700 transition hover:text-brand-600">
            Try this <ArrowRight size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The connector directory's own entries and icons. */
export function ConnectorWall({ connectors, onMarketplace, marketplaceHref }: { connectors: CatalogEntry[]; onMarketplace: () => void; marketplaceHref: string }) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onMarketplace();
  };
  return (
    <div className="mt-10">
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8" aria-label="Connectors">
        {connectors.map((entry) => (
          <li key={entry.id} className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white px-2 py-3 text-center">
            {entry.icon
              ? <img src={entry.icon} alt="" width={28} height={28} loading="lazy" decoding="async" className="h-7 w-7 object-contain" />
              : <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-[10px] font-bold text-slate-600" aria-hidden="true">{entry.name.slice(0, 2).toUpperCase()}</span>}
            <span className="line-clamp-2 text-[11px] leading-4 text-slate-700">{entry.name.replace(/\s*\(.*\)/, "")}</span>
          </li>
        ))}
      </ul>
      <a href={marketplaceHref} onClick={follow} className="mt-6 inline-flex items-center gap-1.5 text-[14px] font-semibold text-brand-700 transition hover:text-brand-600">
        Open the marketplace <ArrowRight size={14} />
      </a>
    </div>
  );
}

/** How a new visitor starts, in the words that are true for this server. */
export function StartSteps({ keyless }: { keyless: boolean | null }) {
  const steps: Array<[string, string]> = [
    ["Open it in your browser", "Nothing to install. The apps for Mac, Windows, Linux and Android are there when you want them."],
    keyless
      ? ["Create a free account", "An email and a password. There's no API key to find and nothing to pay."]
      : ["Connect a free AI key", "Paste a Groq key (free to create, about a minute), or sign in to an account. HANNAH has no paid tiers of its own."],
    ["Say hello", "Type or talk. Add an agent for the job at hand, connect your tools, and tell HANNAH what to remember."],
  ];
  return (
    <ol className="mt-10 grid gap-3 md:grid-cols-3">
      {steps.map(([title, body], index) => (
        <li key={title} className="rounded-[1.5rem] border border-slate-200 bg-white p-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[13px] font-semibold text-white" aria-hidden="true">{index + 1}</span>
          <h3 className="mt-4 text-[16px] font-semibold text-ink">{title}</h3>
          <p className="mt-1.5 text-[13px] leading-6 text-slate-600">{body}</p>
        </li>
      ))}
    </ol>
  );
}
