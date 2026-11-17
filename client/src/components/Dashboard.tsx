import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Bookmark, Cable, Check, MessageSquare, PackageOpen, ShieldCheck, Workflow } from "lucide-react";
import { CHAT_HISTORY_EVENT, ChatHistory } from "../services/ChatHistory";
import { USAGE_STATS_EVENT, UsageStats } from "../services/UsageStats";
import { MemoryService } from "../services/MemoryService";
import { MEMORY_EVENT } from "../services/MemoryStore";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { MarketplaceService } from "../services/MarketplaceService";
import { TaskSpineService } from "../services/TaskSpineService";
import { GUARDIAN_EVENT, GuardianAgent } from "../services/GuardianAgent";
import { apiUrl } from "../services/api";
import { ChaosEngine, type DegradedState } from "../services/ChaosEngine";
import { RemindersCard } from "./Reminders";
import { DeviceTasksCard } from "./DeviceTasksPanel";

type DashboardProps = {
  onOpenChat: () => void;
  onOpenMemory: () => void;
  onOpenAutomations: () => void;
  onOpenMarketplace: () => void;
  onOpenIntegrations: () => void;
  onOpenSettings: () => void;
};

type ServerHealth = { state: "checking" | "ready" | "no-model" | "unreachable"; provider?: string };
type Tone = "plain" | "lavender" | "sky" | "butter" | "mint" | "slate";

/* Validated categorical slots (light surface). Aqua and yellow sit below 3:1
   contrast, so every segment also carries a visible text label. */
const SERIES = { blue: "#2a78d6", orange: "#eb6834", aqua: "#1baf7a", yellow: "#eda100" };
const SERIES_TRACK = "#dfe5f3";

function readSnapshot() {
  const history = ChatHistory.load().filter((message) => message.role === "user" || message.role === "assistant");
  const ratings = PersonalizationEngine.list();
  const now = Date.now();
  const lastWeek = UsageStats.list().filter((record) => record.ok && now - record.at < 7 * 86_400_000).length;
  const guardian = GuardianAgent.log();
  return {
    usage: UsageStats.summary(),
    daily30: UsageStats.dailySeries(30),
    models: UsageStats.byModel(),
    lastWeek,
    history,
    userMessages: history.filter((message) => message.role === "user").length,
    memories: MemoryService.list().filter((record) => record.layer !== "session"),
    feedback: [
      { key: "liked", label: "Liked", color: SERIES.blue, count: ratings.filter((item) => item.feedback === "liked").length },
      { key: "accepted", label: "Accepted", color: SERIES.orange, count: ratings.filter((item) => item.feedback === "accepted").length },
      { key: "edited", label: "Edited", color: SERIES.aqua, count: ratings.filter((item) => item.feedback === "edited").length },
      { key: "rejected", label: "Missed", color: SERIES.yellow, count: ratings.filter((item) => item.feedback === "rejected").length },
    ],
    guardianReviewed: guardian.length,
    guardianBlocked: guardian.filter((entry) => !entry.allowed).length,
    installedPackages: MarketplaceService.getState().installedIds.length,
    activePackages: MarketplaceService.getActivePackageIds().length,
    workflows: TaskSpineService.list().filter((task) => task.kind === "workflow").length,
  };
}

function formatLatency(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function compact(value: number) {
  if (value >= 1_000_000) return { whole: (value / 1_000_000).toFixed(1).replace(/\.0$/, ""), unit: "M" };
  if (value >= 10_000) return { whole: (value / 1000).toFixed(1).replace(/\.0$/, ""), unit: "K" };
  return { whole: value.toLocaleString(), unit: "" };
}

function relativeTime(time?: number) {
  if (!time) return "never";
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Dashboard previews show assistant replies as plain text, clamped to three lines. */
function plainPreview(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

const monthLabel = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });

function Deck({ tone = "plain", label, className = "", children }: { tone?: Tone; label?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`deck-frame ${className}`} aria-label={label}>
      <div className={`deck-card tone-${tone} flex flex-col`}>
        <div className="deck-head">
          <span className="flex items-center gap-2 font-medium"><span className="logo-ring" aria-hidden="true" /> HANNAH</span>
          <span className={`deck-date ${tone === "slate" ? "!text-white/70" : ""}`}>{monthLabel}</span>
        </div>
        {children}
      </div>
    </section>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="pill-badge"><span className="pill-badge-dot"><Check size={9} strokeWidth={3} /></span>{children}</span>;
}

function GlassStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="glass-tile flex min-w-0 flex-col items-center justify-center px-2 py-4 text-center sm:px-3 sm:py-5">
      <span className="max-w-full truncate font-display text-2xl font-medium tabular-nums tracking-[-0.05em] text-ink sm:text-4xl">{value}</span>
      <span className="mt-1 text-[11px] font-medium text-slate-700">{label}</span>
    </div>
  );
}

function RingGauge({ value }: { value: number | null }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const fraction = value === null ? 0 : value / 100;
  return (
    <svg viewBox="0 0 100 100" className="h-40 w-40" role="img" aria-label={value === null ? "No success rate yet" : `Success rate ${value} percent`}>
      <circle cx="50" cy="50" r={radius} fill="none" stroke={SERIES_TRACK} strokeWidth="7" />
      {value !== null && value > 0 && (
        <circle cx="50" cy="50" r={radius} fill="none" stroke={SERIES.blue} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`} transform="rotate(-90 50 50)" />
      )}
      <text x="50" y="54" textAnchor="middle" className="fill-ink font-display" fontSize="20" fontWeight="500" letterSpacing="-1">
        {value === null ? "—" : `${value}%`}
      </text>
    </svg>
  );
}

function DotMatrix({ days }: { days: Array<{ date: string; label: string; count: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = 6;
  const max = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  return (
    <div className="relative">
      <div className="flex items-end gap-[3px] sm:gap-1" role="group" aria-label={`Messages per day over the last ${days.length} days, ${total} in total`}>
        {days.map((day, index) => {
          const filled = day.count ? Math.max(1, Math.round((day.count / max) * rows)) : 0;
          return (
            <button
              key={day.date}
              type="button"
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              aria-label={`${day.label}: ${day.count} message${day.count === 1 ? "" : "s"}`}
              className="flex h-full min-w-0 flex-1 flex-col-reverse items-center gap-[3px] rounded-md py-1 outline-none focus-visible:ring-2 focus-visible:ring-brand-300 sm:gap-1"
            >
              {Array.from({ length: rows }, (_, dot) => (
                <span
                  key={dot}
                  className="aspect-square w-full max-w-[12px] rounded-full transition"
                  style={{ background: dot < filled ? SERIES.blue : SERIES_TRACK, opacity: hover !== null && hover !== index && dot < filled ? 0.45 : 1 }}
                />
              ))}
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{days[0]?.label}</span><span>{days[Math.floor(days.length / 2)]?.label}</span><span>Today</span>
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}>
          <span className="font-semibold tabular-nums">{days[hover].count}</span> · {days[hover].label}
        </div>
      )}
    </div>
  );
}

function FeedbackDonut({ segments }: { segments: Array<{ key: string; label: string; color: string; count: number }> }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const gap = total && segments.filter((segment) => segment.count).length > 1 ? 2.2 : 0;
  let offset = 0;
  const active = segments.find((segment) => segment.key === hover);
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col xl:flex-row">
      <svg viewBox="0 0 100 100" className="h-36 w-36 shrink-0" role="img" aria-label={total ? `Feedback on ${total} replies` : "No feedback yet"}>
        <circle cx="50" cy="50" r={radius} fill="none" stroke={SERIES_TRACK} strokeWidth="12" />
        {total > 0 && segments.filter((segment) => segment.count).map((segment) => {
          const length = (segment.count / total) * circumference;
          const dash = Math.max(0.5, length - gap);
          const element = (
            <circle key={segment.key} cx="50" cy="50" r={radius} fill="none" stroke={segment.color} strokeWidth={hover === segment.key ? 14 : 12}
              strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset} transform="rotate(-90 50 50)"
              onMouseEnter={() => setHover(segment.key)} onMouseLeave={() => setHover(null)} className="cursor-default transition-[stroke-width]" />
          );
          offset += length;
          return element;
        })}
        <text x="50" y="50" textAnchor="middle" className="fill-ink font-display" fontSize="16" fontWeight="500">{active ? active.count : total}</text>
        <text x="50" y="62" textAnchor="middle" className="fill-slate-500" fontSize="7">{active ? active.label : "rated"}</text>
      </svg>
      <ul className="w-full space-y-1.5 text-sm">
        {segments.map((segment) => (
          <li key={segment.key} onMouseEnter={() => setHover(segment.key)} onMouseLeave={() => setHover(null)}
            className={`flex items-center gap-2 rounded-lg px-2 py-1 ${hover === segment.key ? "bg-white/70" : ""}`}>
            <span className="h-2.5 w-5 rounded-full" style={{ background: segment.color }} aria-hidden="true" />
            <span className="flex-1 text-slate-700">{segment.label}</span>
            <span className="tabular-nums text-ink">{segment.count}</span>
            <span className="w-10 text-right tabular-nums text-slate-500">{total ? `${Math.round((segment.count / total) * 100)}%` : "—"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Dashboard({ onOpenChat, onOpenMemory, onOpenAutomations, onOpenMarketplace, onOpenIntegrations, onOpenSettings }: DashboardProps) {
  const [snapshot, setSnapshot] = useState(readSnapshot);
  const [health, setHealth] = useState<ServerHealth>({ state: "checking" });
  const [degraded, setDegraded] = useState<DegradedState>(ChaosEngine.getDegraded());

  useEffect(() => {
    const refresh = () => setSnapshot(readSnapshot());
    const events = [CHAT_HISTORY_EVENT, USAGE_STATS_EVENT, MEMORY_EVENT, GUARDIAN_EVENT, "storage", "focus"];
    events.forEach((name) => window.addEventListener(name, refresh));
    const unsubscribe = ChaosEngine.subscribe(() => setDegraded(ChaosEngine.getDegraded()));
    return () => {
      events.forEach((name) => window.removeEventListener(name, refresh));
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(6_000) })
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!active) return;
        if (!ok) setHealth({ state: "unreachable" });
        else setHealth({ state: data?.ready ? "ready" : "no-model", provider: typeof data?.provider === "string" ? data.provider : undefined });
      })
      .catch(() => active && setHealth({ state: "unreachable" }));
    return () => { active = false; };
  }, []);

  const { usage, history, memories } = snapshot;
  const recent = history.slice(-4);
  const weekly = compact(snapshot.lastWeek);
  const statusText = health.state === "ready"
    ? `Online · ${health.provider ?? "AI"} ready`
    : health.state === "no-model" ? "Online · add your own key" : health.state === "unreachable" ? "Server unreachable" : "Checking server…";

  return (
    <main className="mx-auto w-full max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8">
      {degraded.degraded && (
        <div role="status" className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          <span className="flex-1"><strong>Degraded mode</strong> · {degraded.reason || "Using a fallback model."}</span>
          <button type="button" onClick={() => ChaosEngine.clearDegraded()} className="text-xs font-semibold underline">Dismiss</button>
        </div>
      )}

      <div className="grid gap-3 sm:gap-4 lg:grid-cols-3">
        {/* Hero — mirrors the "An AI Assistant That Truly Delivers" slide. */}
        <Deck tone="sky" label="Overview" className="lg:col-span-3">
          <div className="mt-8 grid flex-1 items-center gap-8 md:grid-cols-[1.1fr_1fr]">
            <div>
              <Badge>{statusText}</Badge>
              <h1 className="display-title mt-5 text-[clamp(2.4rem,5.5vw,4rem)]">{greeting()}.</h1>
              <p className="mt-3 max-w-md text-[15px] leading-relaxed text-slate-600">
                {usage.turns
                  ? `${snapshot.userMessages} message${snapshot.userMessages === 1 ? "" : "s"} in your current conversation. Last reply ${relativeTime(usage.lastAt)}.`
                  : "Start a conversation and your activity, memory and model performance will appear here."}
              </p>
              <button type="button" onClick={onOpenChat} className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink px-5 text-sm font-semibold text-white transition hover:bg-slate-800">
                <MessageSquare size={16} /> {history.length ? "Continue conversation" : "Start a conversation"}
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              <GlassStat value={usage.succeeded.toLocaleString()} label="Replies" />
              <GlassStat value={formatLatency(usage.avgLatencyMs)} label="Avg response" />
              <GlassStat value={usage.successRate === null ? "—" : `${usage.successRate}%`} label="Success rate" />
            </div>
          </div>
        </Deck>

        {/* Headline number — mirrors the "Resolved Conversations 98.9K" slide. */}
        <Deck tone="butter" label="Replies this week" className="lg:col-span-2">
          <div className="mt-8 flex flex-1 flex-col justify-center gap-6 md:flex-row md:items-center md:justify-between">
            <h2 className="display-title text-[clamp(1.8rem,3.6vw,2.75rem)]">Replies<br />from HANNAH</h2>
            <div className="flex items-end gap-3">
              <span className="display-stat text-[clamp(4.5rem,11vw,8rem)]">{weekly.whole}{weekly.unit}</span>
              <span className="display-title pb-2 text-lg leading-tight sm:text-xl">in the<br />past 7<br />days</span>
            </div>
          </div>
        </Deck>

        <Deck tone="plain" label="Success rate">
          <p className="mt-6 text-sm font-medium text-ink">Reply success rate</p>
          <p className="text-xs text-slate-500">{usage.turns ? `${usage.succeeded} of ${usage.turns} requests answered` : "No requests yet"}</p>
          <div className="flex flex-1 items-center justify-center py-4"><RingGauge value={usage.successRate} /></div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-slate-50 px-3 py-2"><dt className="text-slate-500">Last reply</dt><dd className="mt-0.5 font-medium tabular-nums text-ink">{formatLatency(usage.lastLatencyMs)}</dd></div>
            <div className="rounded-xl bg-slate-50 px-3 py-2"><dt className="text-slate-500">Tokens</dt><dd className="mt-0.5 font-medium tabular-nums text-ink">{usage.inputTokens + usage.outputTokens ? (usage.inputTokens + usage.outputTokens).toLocaleString() : "—"}</dd></div>
          </dl>
        </Deck>

        <Deck tone="plain" label="Activity" className="lg:col-span-2">
          <div className="mt-6 flex items-baseline justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Conversation activity</p>
              <p className="text-xs text-slate-500">Requests per day, last 30 days</p>
            </div>
            <span className="font-display text-2xl font-medium tracking-tight text-ink tabular-nums">{snapshot.daily30.reduce((sum, day) => sum + day.count, 0)}</span>
          </div>
          <div className="mt-5"><DotMatrix days={snapshot.daily30} /></div>
          {usage.voiceTurns > 0 && <p className="mt-3 text-xs text-slate-500">{usage.voiceTurns} by voice</p>}
        </Deck>

        {/* Mirrors the "Focus Area Distribution" donut slide, with real feedback. */}
        <Deck tone="lavender" label="Feedback">
          <p className="mt-6 text-sm font-medium text-ink">How replies landed</p>
          <p className="mb-4 text-xs text-slate-600">From the ratings you give under each reply</p>
          <FeedbackDonut segments={snapshot.feedback} />
        </Deck>

        <Deck tone="plain" label="Conversation" className="lg:col-span-2">
          <div className="mt-6 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-ink">Where you left off</h2>
            {history.length > 0 && <button type="button" onClick={onOpenChat} className="btn-ghost">Open chat <ArrowRight size={14} /></button>}
          </div>
          {recent.length ? (
            <ul className="mt-4 space-y-2.5">
              {recent.map((message, index) => (
                <li key={message.id || index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <p className={`line-clamp-3 max-w-[85%] whitespace-pre-line break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed text-ink ${message.role === "user" ? "rounded-br-md bg-[#e9edfb]" : "rounded-bl-md bg-slate-100"}`}>
                    {message.role === "user" ? message.content : plainPreview(message.content)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
              <p className="text-sm text-slate-500">Nothing here yet.</p>
              <button type="button" onClick={onOpenChat} className="btn-outline mt-3"><MessageSquare size={14} /> Say hello to HANNAH</button>
            </div>
          )}
        </Deck>

        <Deck tone="mint" label="Memory">
          <div className="mt-6 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">Memory</p>
              <p className="display-title mt-2 text-4xl tabular-nums">{memories.length}</p>
              <p className="text-xs text-slate-600">{memories.length === 1 ? "thing remembered" : "things remembered"}</p>
            </div>
            <Bookmark size={18} className="text-slate-500" />
          </div>
          {memories.length ? (
            <ul className="mt-4 space-y-2">
              {memories.slice(0, 3).map((record) => (
                <li key={record.id} className="truncate rounded-xl bg-white/70 px-3 py-2 text-sm text-slate-700">{record.content}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm leading-relaxed text-slate-600">Tap “Remember this” under a message, or add notes yourself. HANNAH uses them in later replies.</p>
          )}
          <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-slate-600">
            <span className="flex items-center gap-1.5" title="Tool calls the Guardian reviewed"><ShieldCheck size={14} /> {snapshot.guardianReviewed} reviewed · {snapshot.guardianBlocked} blocked</span>
            <button type="button" onClick={onOpenMemory} className="font-semibold text-ink underline-offset-2 hover:underline">Manage</button>
          </div>
        </Deck>

        {/* Mirrors the "Channel Performance Overview" table card. */}
        <Deck tone="slate" label="Model performance" className="lg:col-span-3">
          <p className="mt-6 text-sm font-medium text-white">Model performance</p>
          <p className="text-xs text-white/70">Every provider and model that has answered in this browser</p>
          {snapshot.models.length ? (
            <div className="mt-4 overflow-x-auto" role="region" aria-label="Model performance table" tabIndex={0}>
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-xs text-white/70">
                  <tr><th className="py-2 pr-4 font-medium">Provider</th><th className="py-2 pr-4 font-medium">Model</th><th className="py-2 pr-4 text-right font-medium">Replies</th><th className="py-2 pr-4 text-right font-medium">Avg response</th><th className="py-2 pr-4 text-right font-medium">Tokens</th><th className="py-2 text-right font-medium">Last used</th></tr>
                </thead>
                <tbody className="divide-y divide-white/15">
                  {snapshot.models.slice(0, 6).map((row) => (
                    <tr key={`${row.provider}-${row.model}`}>
                      <td className="py-2.5 pr-4">{row.provider}</td>
                      <td className="max-w-[16rem] truncate py-2.5 pr-4 font-mono text-[13px]" title={row.model}>{row.model}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{row.replies.toLocaleString()}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{formatLatency(row.avgLatencyMs)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{row.tokens ? row.tokens.toLocaleString() : "—"}</td>
                      <td className="py-2.5 text-right text-white/80">{relativeTime(row.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 rounded-xl bg-white/10 px-4 py-6 text-center text-sm text-white/80">No replies yet. Each model appears here after it answers.</p>
          )}
        </Deck>
      </div>

      <div className="mt-4"><DeviceTasksCard onSignIn={onOpenSettings} /></div>

      <div className="mt-4"><RemindersCard /></div>

      <section className="mt-4 grid gap-3 sm:grid-cols-3" aria-label="More">
        {[
          { label: "Automations", detail: snapshot.workflows ? `${snapshot.workflows} saved automation${snapshot.workflows === 1 ? "" : "s"}` : "Start from a template", Icon: Workflow, onClick: onOpenAutomations },
          { label: "Marketplace", detail: snapshot.installedPackages ? `${snapshot.installedPackages} installed · ${snapshot.activePackages} active` : "Add agents and skills", Icon: PackageOpen, onClick: onOpenMarketplace },
          { label: "Integrations", detail: "REST API and MCP setup", Icon: Cable, onClick: onOpenIntegrations },
        ].map(({ label, detail, Icon, onClick }) => (
          <button key={label} type="button" onClick={onClick} className="group flex items-center gap-3 rounded-[1.5rem] bg-white/90 p-4 text-left shadow-[0_12px_30px_-20px_rgba(38,44,74,0.4)] transition hover:bg-white">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eef0fb] text-[#4b55b8]"><Icon size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{label}</span>
              <span className="block truncate text-xs text-slate-500">{detail}</span>
            </span>
            <ArrowRight size={16} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-ink" />
          </button>
        ))}
      </section>

      <p className="mt-8 text-center text-xs text-slate-500">Every number here is computed from activity stored in this browser. Nothing is estimated.</p>
    </main>
  );
}
