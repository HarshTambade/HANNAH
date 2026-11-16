import { useEffect, useState, type FormEvent } from "react";
import { Code2, Download, Eye, EyeOff, KeyRound, LogOut, Server, Trash2, Wallet } from "lucide-react";
import { apiFetch, apiUrl, getApiAccessToken, getSessionGroqKey, isGroqKey, setSessionGroqKey } from "../services/api";
import { DAILY_BUDGET_KEY } from "../services/LLMRouter";
import { ChatHistory } from "../services/ChatHistory";
import { UsageStats } from "../services/UsageStats";
import { MemoryService } from "../services/MemoryService";
import { clearAllMemories } from "../services/MemoryStore";
import { PersonalizationEngine } from "../services/PersonalizationEngine";
import { ChaosEngine, type DegradedState } from "../services/ChaosEngine";
import { getAppVersion } from "../services/appInfo";

type SettingsPageProps = {
  onDisconnect: () => void;
  onGroqKeyChange: (key: string) => void;
};

type Counts = { messages: number; memories: number; turns: number; ratings: number };

function readCounts(): Counts {
  return {
    messages: ChatHistory.load().filter((message) => message.role === "user" || message.role === "assistant").length,
    memories: MemoryService.list().length,
    turns: UsageStats.list().length,
    ratings: PersonalizationEngine.list().length,
  };
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="deck-frame" aria-label={title}>
      <div className="deck-card tone-plain">
        <h2 className="font-display text-lg font-medium tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-1 text-sm leading-relaxed text-slate-500">{description}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </section>
  );
}

export default function SettingsPage({ onDisconnect, onGroqKeyChange }: SettingsPageProps) {
  const [counts, setCounts] = useState(readCounts);
  const [health, setHealth] = useState<{ state: string; provider?: string }>({ state: "Checking…" });
  const [groqKey, setGroqKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasGroqKey, setHasGroqKey] = useState(() => Boolean(getSessionGroqKey()));
  // Guests connect with only their Groq key; removing it ends the session.
  const usingAccessToken = Boolean(getApiAccessToken());
  const [notice, setNotice] = useState("");
  const [budgetInput, setBudgetInput] = useState(() => {
    try { return window.localStorage.getItem(DAILY_BUDGET_KEY) || ""; } catch { return ""; }
  });
  const [usage, setUsage] = useState<{ spentUsd: number; capUsd: number | null; remainingUsd: number | null } | null>(null);
  const loadUsage = async (cap = budgetInput) => {
    try {
      const response = await apiFetch(apiUrl("/v1/usage"), { headers: cap ? { "X-HANNAH-Daily-Budget": cap } : {}, signal: AbortSignal.timeout(5_000) });
      if (response.ok) setUsage(await response.json());
    } catch {
      setUsage(null);
    }
  };
  useEffect(() => { void loadUsage(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saveBudget = (event: FormEvent) => {
    event.preventDefault();
    const value = budgetInput.trim();
    const amount = Number(value);
    if (value && (!Number.isFinite(amount) || amount <= 0 || amount > 10_000)) {
      setNotice("Enter a daily limit between $0.01 and $10,000, or leave it empty for no limit.");
      return;
    }
    try {
      if (value) window.localStorage.setItem(DAILY_BUDGET_KEY, String(amount));
      else window.localStorage.setItem(DAILY_BUDGET_KEY, "");
    } catch { /* still applies this visit */ }
    setNotice(value ? `Daily limit set to $${amount.toFixed(2)}. HANNAH stops paid requests once it's reached and prefers lighter models near it.` : "Daily limit removed.");
    void loadUsage(value);
  };
  const [chaosEnabled, setChaosEnabled] = useState(ChaosEngine.isEnabled());
  const [degraded, setDegraded] = useState<DegradedState>(ChaosEngine.getDegraded());

  useEffect(() => ChaosEngine.subscribe(() => {
    setChaosEnabled(ChaosEngine.isEnabled());
    setDegraded(ChaosEngine.getDegraded());
  }), []);

  useEffect(() => {
    fetch(apiUrl("/api/health"), { signal: AbortSignal.timeout(6_000) })
      .then((response) => response.json())
      .then((data) => setHealth({ state: data?.ready ? "Online · ready" : "Online · no server-side model key", provider: data?.provider }))
      .catch(() => setHealth({ state: "Unreachable" }));
  }, []);

  const say = (message: string) => {
    setNotice(message);
    setCounts(readCounts());
  };

  const saveGroqKey = (event: FormEvent) => {
    event.preventDefault();
    const key = groqKey.trim();
    if (!key) return;
    if (!isGroqKey(key)) { setNotice("That doesn’t look like a Groq key. Groq keys start with gsk_ and have no spaces."); return; }
    setSessionGroqKey(key);
    onGroqKeyChange(key);
    setGroqKey("");
    setHasGroqKey(true);
    setNotice("Groq key saved for this browser tab.");
  };

  const exportData = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: "HANNAH",
      version: getAppVersion(),
      conversation: ChatHistory.load(),
      memories: MemoryService.list(),
      styleFeedback: PersonalizationEngine.list(),
      usage: UsageStats.list(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hannah-data-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Your data was exported as a JSON file.");
  };

  const clearAll = () => {
    if (!window.confirm("Delete your conversation, memories, style feedback and usage stats from this browser? This can’t be undone.")) return;
    ChatHistory.clear();
    clearAllMemories();
    PersonalizationEngine.clear();
    UsageStats.clear();
    say("All HANNAH data was removed from this browser.");
  };

  const dataRows: Array<{ label: string; count: number; unit: string; clear: () => void }> = [
    { label: "Conversation", count: counts.messages, unit: "messages", clear: () => { ChatHistory.clear(); say("Conversation cleared."); } },
    { label: "Memories", count: counts.memories, unit: "items", clear: () => { clearAllMemories(); say("Memories cleared."); } },
    { label: "Style feedback", count: counts.ratings, unit: "ratings", clear: () => { PersonalizationEngine.clear(); say("Style feedback cleared."); } },
    { label: "Usage stats", count: counts.turns, unit: "requests", clear: () => { UsageStats.clear(); say("Usage stats cleared."); } },
  ];

  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
      <div>
        <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Connection, keys, and the data HANNAH keeps in this browser.</p>
      </div>

      {notice && <p role="status" className="rounded-2xl border border-brand-100 bg-brand-50 px-4 py-3 text-sm text-brand-800">{notice}</p>}

      <Section title="Connection" description="Your key and access token are kept for this browser tab only and cleared when you close it.">
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-slate-500"><Server size={15} /> Server</dt>
            <dd className="text-right font-medium text-ink">{health.state}{health.provider ? ` · ${health.provider}` : ""}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-slate-500"><KeyRound size={15} /> Your Groq key</dt>
            <dd className="font-medium text-ink">{hasGroqKey ? "Saved for this tab" : "Not set (server key used)"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-slate-500"><Server size={15} /> Signed in with</dt>
            <dd className="font-medium text-ink">{usingAccessToken ? "Access token" : "Your Groq key"}</dd>
          </div>
        </dl>
        <form onSubmit={saveGroqKey} className="mt-4 flex gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-xl border border-slate-200 bg-white pr-1 focus-within:border-brand-300">
            <input
              type={showKey ? "text" : "password"}
              value={groqKey}
              onChange={(event) => setGroqKey(event.target.value)}
              placeholder={hasGroqKey ? "Replace your Groq key" : "Paste a gsk_ key"}
              aria-label="Groq API key"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-base text-ink outline-none placeholder:text-slate-400 sm:text-sm"
            />
            <button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Hide key" : "Show key"} className="rounded-lg p-2 text-slate-400 hover:text-ink">{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </div>
          <button type="submit" disabled={!groqKey.trim()} className="btn-outline disabled:opacity-40">Save</button>
          {hasGroqKey && <button type="button" onClick={() => { if (!usingAccessToken) { onDisconnect(); return; } setSessionGroqKey(""); onGroqKeyChange(""); setHasGroqKey(false); setNotice("Groq key removed."); }} className="btn-ghost" title={usingAccessToken ? undefined : "Removing your key disconnects this tab"}>Remove</button>}
        </form>
        <button type="button" onClick={onDisconnect} className="btn-outline mt-5 text-rose-600 hover:!border-rose-300 hover:!text-rose-700"><LogOut size={15} /> Disconnect this tab</button>
      </Section>

      <Section title="Spending" description="An estimate from list prices for the tokens HANNAH used today. Free tiers and unpriced models count as $0. The server enforces the limit for this key or token.">
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-slate-500"><Wallet size={15} /> Spent today</dt>
            <dd className="font-medium text-ink">{usage ? `$${usage.spentUsd.toFixed(4)}${usage.capUsd !== null ? ` of $${usage.capUsd.toFixed(2)}` : ""}` : "—"}</dd>
          </div>
        </dl>
        <form onSubmit={saveBudget} className="mt-4 flex gap-2">
          <label htmlFor="daily-budget" className="sr-only">Daily spending limit in US dollars</label>
          <div className="flex min-w-0 flex-1 items-center rounded-xl border border-slate-200 bg-white pl-3 focus-within:border-brand-300">
            <span className="text-sm text-slate-500">$</span>
            <input id="daily-budget" inputMode="decimal" value={budgetInput} onChange={(event) => setBudgetInput(event.target.value)} placeholder="No daily limit" className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base text-ink outline-none placeholder:text-slate-400 sm:text-sm" />
            <span className="pr-3 text-xs text-slate-500">per day</span>
          </div>
          <button type="submit" className="btn-outline">Save</button>
        </form>
      </Section>

      <Section title="Your data" description="Stored only in this browser’s local storage. Nothing here is uploaded except the messages and saved memories sent with each chat request.">
        <ul className="divide-y divide-slate-100">
          {dataRows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <p className="text-sm font-medium text-ink">{row.label}</p>
                <p className="text-xs text-slate-500">{row.count.toLocaleString()} {row.unit}</p>
              </div>
              <button type="button" disabled={!row.count} onClick={row.clear} className="btn-ghost text-rose-600 disabled:opacity-30"><Trash2 size={14} /> Clear</button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={exportData} className="btn-outline"><Download size={15} /> Export my data</button>
          <button type="button" onClick={clearAll} className="btn-ghost text-rose-600"><Trash2 size={15} /> Delete everything</button>
        </div>
      </Section>

      {ChaosEngine.available() && (
        <Section title="Developer" description="Only shown in development and test builds.">
          <label className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
            <span>
              <span className="block text-sm font-semibold text-ink">Chaos mode</span>
              <span className="mt-0.5 block text-xs text-slate-500">Inject one simulated failure at a time: network drop, tool timeout, corrupted memory, or denied approval.</span>
            </span>
            <input type="checkbox" checked={chaosEnabled} onChange={(event) => ChaosEngine.setEnabled(event.target.checked)} className="h-5 w-5 accent-violet-600" />
          </label>
          <div className="mt-3 rounded-xl border border-sky-100 bg-sky-50 p-4 text-sm text-sky-900">
            <p className="flex items-center gap-2 font-semibold"><Code2 size={15} /> Fallback status</p>
            <p className="mt-1 text-xs">{degraded.degraded ? degraded.reason : "No degraded condition is currently reported."}</p>
            {degraded.degraded && <button type="button" className="mt-2 text-xs font-semibold underline" onClick={() => ChaosEngine.clearDegraded()}>Clear degraded status</button>}
          </div>
        </Section>
      )}

      <p className="text-center text-xs text-slate-400">HANNAH v{getAppVersion()}</p>
    </main>
  );
}
