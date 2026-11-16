import { useEffect, useState } from "react";
import {
  Activity, ArrowRight, Bookmark, Brain, Cable, Clock3, Gauge, MessageSquare, PackageOpen, Sparkles, ThumbsUp, Workflow, Zap,
} from "lucide-react";
import { CHAT_HISTORY_EVENT, ChatHistory } from "../services/ChatHistory";
import { USAGE_STATS_EVENT, UsageStats, type UsageSummary } from "../services/UsageStats";
import { MemoryService } from "../services/MemoryService";
import { MEMORY_EVENT } from "../services/MemoryStore";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { MarketplaceService } from "../services/MarketplaceService";
import { TaskSpineService } from "../services/TaskSpineService";
import { apiUrl } from "../services/api";
import { ChaosEngine, type DegradedState } from "../services/ChaosEngine";
import MessageContent from "./MessageContent";

type DashboardProps = {
  onOpenChat: () => void;
  onOpenMemory: () => void;
  onOpenAutomations: () => void;
  onOpenMarketplace: () => void;
  onOpenIntegrations: () => void;
};

type ServerHealth = { state: "checking" | "ready" | "no-model" | "unreachable"; provider?: string };

function readSnapshot() {
  const history = ChatHistory.load().filter((message) => message.role === "user" || message.role === "assistant");
  const ratings = PersonalizationEngine.list();
  return {
    usage: UsageStats.summary(),
    history,
    userMessages: history.filter((message) => message.role === "user").length,
    memories: MemoryService.list().filter((record) => record.layer !== "session"),
    liked: ratings.filter((item) => item.feedback === "liked" || item.feedback === "accepted").length,
    edited: ratings.filter((item) => item.feedback === "edited").length,
    rejected: ratings.filter((item) => item.feedback === "rejected").length,
    installedPackages: MarketplaceService.getState().installedIds.length,
    activePackages: MarketplaceService.getActivePackageIds().length,
    workflows: TaskSpineService.list().filter((task) => task.kind === "workflow").length,
  };
}

function formatLatency(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatCount(value: number) {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();
}

function relativeTime(time?: number) {
  if (!time) return "never";
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Hello" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function StatTile({ icon: Icon, label, value, hint }: { icon: typeof Gauge; label: string; value: string; hint: string }) {
  return (
    <div className="bento-card">
      <div className="flex items-center gap-2 text-slate-500">
        <Icon size={15} />
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-3 font-display text-3xl font-extrabold tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function ActivityChart({ daily }: { daily: UsageSummary["daily"] }) {
  const max = Math.max(1, ...daily.map((day) => day.count));
  const total = daily.reduce((sum, day) => sum + day.count, 0);
  return (
    <div>
      <div className="flex h-36 items-end gap-2" role="img" aria-label={`Messages over the last 7 days: ${daily.map((day) => `${day.label} ${day.count}`).join(", ")}`}>
        {daily.map((day, index) => {
          const isToday = index === daily.length - 1;
          return (
            <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
              <span className="text-[11px] font-semibold tabular-nums text-slate-500">{day.count || ""}</span>
              <div
                className={`w-full max-w-10 rounded-t-lg ${day.count ? (isToday ? "bg-brand-500" : "bg-brand-200") : "bg-slate-100"}`}
                style={{ height: `${day.count ? Math.max(8, (day.count / max) * 100) : 4}%` }}
              />
              <span className={`text-[11px] ${isToday ? "font-semibold text-ink" : "text-slate-400"}`}>{day.label}</span>
            </div>
          );
        })}
      </div>
      {total === 0 && <p className="mt-3 text-center text-xs text-slate-500">No messages in the last 7 days yet.</p>}
    </div>
  );
}

export default function Dashboard({ onOpenChat, onOpenMemory, onOpenAutomations, onOpenMarketplace, onOpenIntegrations }: DashboardProps) {
  const [snapshot, setSnapshot] = useState(readSnapshot);
  const [health, setHealth] = useState<ServerHealth>({ state: "checking" });
  const [degraded, setDegraded] = useState<DegradedState>(ChaosEngine.getDegraded());

  useEffect(() => {
    const refresh = () => setSnapshot(readSnapshot());
    const events = [CHAT_HISTORY_EVENT, USAGE_STATS_EVENT, MEMORY_EVENT, "storage", "focus"];
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
  const hasActivity = usage.turns > 0 || history.length > 0;
  const statusTone = health.state === "ready" ? "bg-emerald-500" : health.state === "checking" ? "bg-slate-300" : "bg-amber-500";
  const statusText = health.state === "ready"
    ? `Server online · ${health.provider ?? "AI provider"} ready`
    : health.state === "no-model"
      ? "Server online · bring your own Groq key to chat"
      : health.state === "unreachable" ? "Server unreachable right now" : "Checking server…";

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <span className={`h-2 w-2 rounded-full ${statusTone}`} aria-hidden="true" /> {statusText}
          </p>
          <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{greeting()}.</h1>
          <p className="mt-1 text-sm text-slate-500">
            {hasActivity
              ? `You've sent ${formatCount(snapshot.userMessages)} message${snapshot.userMessages === 1 ? "" : "s"} in this conversation. Last reply ${relativeTime(usage.lastAt)}.`
              : "Your conversations, memory and usage show up here once you start chatting."}
          </p>
        </div>
        <button type="button" onClick={onOpenChat} className="btn-primary min-h-11 self-start px-5 sm:self-auto">
          <MessageSquare size={16} /> {history.length ? "Continue conversation" : "Start a conversation"}
        </button>
      </section>

      {degraded.degraded && (
        <div role="status" className="mt-5 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          <span className="flex-1"><strong>Degraded mode</strong> · {degraded.reason || "Using a fallback model."}</span>
          <button type="button" onClick={() => ChaosEngine.clearDegraded()} className="text-xs font-semibold underline">Dismiss</button>
        </div>
      )}

      <section className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4" aria-label="Usage">
        <StatTile icon={Zap} label="Replies" value={formatCount(usage.succeeded)} hint={usage.failed ? `${usage.failed} failed` : "All time, on this device"} />
        <StatTile icon={Clock3} label="Response time" value={formatLatency(usage.avgLatencyMs)} hint={usage.lastLatencyMs !== null ? `Last: ${formatLatency(usage.lastLatencyMs)}` : "Average per reply"} />
        <StatTile icon={Gauge} label="Success rate" value={usage.successRate === null ? "—" : `${usage.successRate}%`} hint={`${usage.turns} request${usage.turns === 1 ? "" : "s"} total`} />
        <StatTile
          icon={Activity}
          label="Tokens"
          value={usage.inputTokens + usage.outputTokens ? formatCount(usage.inputTokens + usage.outputTokens) : "—"}
          hint={usage.inputTokens + usage.outputTokens ? `${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out` : "Reported by cloud providers"}
        />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="bento-card">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="bento-kicker">Activity</p>
              <h2 className="font-display text-lg font-bold text-ink">Messages, last 7 days</h2>
            </div>
            {usage.voiceTurns > 0 && <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">{usage.voiceTurns} by voice</span>}
          </div>
          <div className="mt-5"><ActivityChart daily={usage.daily} /></div>
        </div>

        <div className="bento-card flex flex-col">
          <p className="bento-kicker">Model</p>
          <h2 className="font-display text-lg font-bold text-ink">What answered last</h2>
          {usage.lastModel || usage.lastProvider ? (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Provider</dt><dd className="truncate font-medium text-ink">{usage.lastProvider ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Model</dt><dd className="truncate font-mono text-[13px] text-ink" title={usage.lastModel}>{usage.lastModel ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-500">Last reply</dt><dd className="font-medium text-ink">{relativeTime(usage.lastAt)}</dd></div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-slate-500">No replies yet. The provider and model appear after your first message.</p>
          )}
          <p className="mt-auto pt-4 text-xs text-slate-400">Change the model from the settings button inside chat.</p>
        </div>
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="bento-card">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="bento-kicker">Conversation</p>
              <h2 className="font-display text-lg font-bold text-ink">Where you left off</h2>
            </div>
            {history.length > 0 && <button type="button" onClick={onOpenChat} className="btn-ghost">Open <ArrowRight size={14} /></button>}
          </div>
          {recent.length ? (
            <ul className="mt-4 space-y-2.5">
              {recent.map((message, index) => (
                <li key={message.id || index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-h-28 max-w-[85%] overflow-hidden rounded-2xl px-3.5 py-2 text-sm leading-relaxed text-ink ${message.role === "user" ? "whitespace-pre-wrap break-words rounded-br-md border border-brand-100 bg-brand-50" : "rounded-bl-md border border-slate-100 bg-slate-50"}`}>
                    {message.role === "user" ? message.content : <MessageContent text={message.content} />}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-4 rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
              <p className="text-sm text-slate-500">Nothing here yet.</p>
              <button type="button" onClick={onOpenChat} className="btn-outline mt-3"><MessageSquare size={14} /> Say hello to HANNAH</button>
            </div>
          )}
        </div>

        <div className="bento-card flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="bento-kicker">Memory</p>
              <h2 className="font-display text-lg font-bold text-ink">{memories.length ? `${memories.length} thing${memories.length === 1 ? "" : "s"} remembered` : "Nothing remembered yet"}</h2>
            </div>
            <Bookmark size={18} className="text-slate-300" />
          </div>
          {memories.length ? (
            <ul className="mt-4 space-y-2">
              {memories.slice(0, 3).map((record) => (
                <li key={record.id} className="truncate rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">{record.content}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Tap “Remember this” under a message, or add notes yourself. HANNAH uses them in later replies.</p>
          )}
          <div className="mt-4 flex items-center gap-4 border-t border-slate-100 pt-4 text-sm text-slate-600">
            <span className="flex items-center gap-1.5" title="Liked or accepted replies used as style examples"><ThumbsUp size={14} className="text-emerald-500" /> {snapshot.liked}</span>
            <span className="flex items-center gap-1.5" title="Replies you edited"><Brain size={14} className="text-violet-500" /> {snapshot.edited} edited</span>
            <button type="button" onClick={onOpenMemory} className="ml-auto btn-ghost">Manage <ArrowRight size={14} /></button>
          </div>
        </div>
      </section>

      <section className="mt-4 grid gap-3 sm:grid-cols-3" aria-label="More">
        {[
          { label: "Automations", detail: snapshot.workflows ? `${snapshot.workflows} saved workflow${snapshot.workflows === 1 ? "" : "s"}` : "Design a routine visually", Icon: Workflow, onClick: onOpenAutomations },
          { label: "Marketplace", detail: snapshot.installedPackages ? `${snapshot.installedPackages} installed · ${snapshot.activePackages} active` : "Add agents and skills", Icon: PackageOpen, onClick: onOpenMarketplace },
          { label: "Integrations", detail: "REST API and MCP setup", Icon: Cable, onClick: onOpenIntegrations },
        ].map(({ label, detail, Icon, onClick }) => (
          <button key={label} type="button" onClick={onClick} className="group flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 text-left shadow-soft transition hover:border-brand-200">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon size={18} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{label}</span>
              <span className="block truncate text-xs text-slate-500">{detail}</span>
            </span>
            <ArrowRight size={16} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
          </button>
        ))}
      </section>

      <p className="mt-8 flex items-center justify-center gap-1.5 text-center text-xs text-slate-400">
        <Sparkles size={12} /> Everything on this page is computed from activity stored in this browser.
      </p>
    </main>
  );
}
