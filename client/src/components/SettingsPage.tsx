import { useEffect, useState, type FormEvent } from "react";
import { Code2, Download, Eye, EyeOff, KeyRound, LogOut, Search, Server, Stethoscope, Trash2, Upload, Wallet } from "lucide-react";
import { createBackup, preview as backupPreview, readBackup, restoreBackup, BackupError, type Backup, type RestoreMode } from "../services/Backup";
import { Diagnostics, DIAGNOSTICS_EVENT, type DiagnosticLevel } from "../services/Diagnostics";
import { applyTextSize, readTextSize, type TextSize } from "../services/appearance";
import { apiFetch, apiUrl, canRememberKey, getAccountHint, getApiAccessToken, getRememberedKeyHint, getSessionGroqKey, isGroqKey, rememberGroqKey, setSessionGroqKey } from "../services/api";
import AccountPanel from "./AccountPanel";
import VoiceSettingsPanel from "./VoiceSettingsPanel";
import DesktopAccessPanel from "./DesktopAccessPanel";
import PhonePanel from "./PhonePanel";
import DesktopAppPanel from "./DesktopAppPanel";
import ConnectionsPanel from "./ConnectionsPanel";
import WakeWordSetting from "./WakeWordSetting";
import BriefingSettings from "./BriefingSettings";
import SetupCheckPanel from "./SetupCheckPanel";
import { desktopFilesAvailable } from "../services/DesktopFiles";
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
  const [hasGroqKey, setHasGroqKey] = useState(() => Boolean(getSessionGroqKey() || getRememberedKeyHint()));
  // Website: the key can be remembered on this browser in a cookie the page can't read.
  const [rememberedHint, setRememberedHint] = useState(getRememberedKeyHint);
  // Guests connect with only their Groq key; removing it ends the session.
  const usingAccessToken = Boolean(getApiAccessToken());
  const usingAccount = !usingAccessToken && Boolean(getAccountHint());
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
    if (rememberedHint) {
      void rememberGroqKey(true).then((ok) => { setRememberedHint(getRememberedKeyHint()); setNotice(ok ? "Groq key saved and remembered on this browser." : "Groq key saved for this browser tab."); });
    } else setNotice("Groq key saved for this browser tab.");
  };

  const toggleRemember = (on: boolean) => {
    void rememberGroqKey(on).then((ok) => {
      setRememberedHint(getRememberedKeyHint());
      setNotice(on ? (ok ? "Remembered on this browser for 30 days." : "Paste your key above first, then turn this on.") : "Forgotten on this browser. It stays for this tab until you close it.");
    });
  };

  const download = (name: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // Backup and restore
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [restoreFile, setRestoreFile] = useState<{ name: string; text: string } | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreMode, setRestoreMode] = useState<RestoreMode>("merge");
  const [restoreBackupData, setRestoreBackupData] = useState<Backup | null>(null);
  const [restoreProblem, setRestoreProblem] = useState("");
  const [restoring, setRestoring] = useState(false);
  const backupContents = backupPreview().filter((section) => section.items > 0);

  const downloadBackup = async () => {
    const text = await createBackup({ passphrase: backupPassphrase });
    download(`hannah-backup-${new Date().toISOString().slice(0, 10)}${backupPassphrase.trim() ? ".encrypted" : ""}.json`, text);
    setNotice(backupPassphrase.trim() ? "Backup downloaded, encrypted with your passphrase. Keep the passphrase: without it the file can't be opened." : "Backup downloaded. It holds no keys or sign-in, so it's safe to keep, but it isn't encrypted.");
    setBackupPassphrase("");
  };

  const chooseRestoreFile = async (file: File | undefined) => {
    setRestoreBackupData(null);
    setRestoreProblem("");
    setRestorePassphrase("");
    if (!file) { setRestoreFile(null); return; }
    const text = await file.text();
    setRestoreFile({ name: file.name, text });
    await openRestoreFile(text, "");
  };

  const openRestoreFile = async (text: string, passphrase: string) => {
    try {
      setRestoreBackupData(await readBackup(text, passphrase));
      setRestoreProblem("");
    } catch (error) {
      setRestoreBackupData(null);
      setRestoreProblem(error instanceof BackupError ? error.message : "This file can't be read.");
    }
  };

  const runRestore = () => {
    if (!restoreBackupData) return;
    if (restoreMode === "replace" && !window.confirm("Replace the data on this device with the backup? Anything here that isn't in the backup is removed from the sections it contains.")) return;
    setRestoring(true);
    const written = restoreBackup(restoreBackupData, { mode: restoreMode });
    setCounts(readCounts());
    setNotice(`Restored ${written.length} section${written.length === 1 ? "" : "s"} from ${restoreFile?.name ?? "the backup"}. Reloading so every screen picks it up…`);
    window.setTimeout(() => window.location.reload(), 1200);
  };

  // Appearance
  const [textSize, setTextSize] = useState<TextSize>(readTextSize);
  const changeTextSize = (size: TextSize) => {
    setTextSize(size);
    applyTextSize(size);
  };

  // Diagnostics
  const [diagnosticQuery, setDiagnosticQuery] = useState("");
  const [diagnosticLevel, setDiagnosticLevel] = useState<DiagnosticLevel | "all">("all");
  const [diagnosticVersion, setDiagnosticVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setDiagnosticVersion((value) => value + 1);
    window.addEventListener(DIAGNOSTICS_EVENT, refresh);
    return () => window.removeEventListener(DIAGNOSTICS_EVENT, refresh);
  }, []);
  const diagnosticEntries = diagnosticVersion >= 0 ? Diagnostics.list({ query: diagnosticQuery, level: diagnosticLevel }) : [];
  const diagnosticCounts = Diagnostics.counts();

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
            <dd className="font-medium text-ink">{rememberedHint ? `Remembered on this browser · ${rememberedHint}` : hasGroqKey ? "Saved for this tab" : "Not set (server key used)"}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-2 text-slate-500"><Server size={15} /> Signed in with</dt>
            <dd className="font-medium text-ink">{usingAccessToken ? "Access token" : usingAccount ? `Account · ${getAccountHint()?.email}` : "Your Groq key"}</dd>
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
          {hasGroqKey && <button type="button" onClick={() => { if (!usingAccessToken && !usingAccount) { onDisconnect(); return; } setSessionGroqKey(""); onGroqKeyChange(""); setHasGroqKey(false); setNotice("Groq key removed."); }} className="btn-ghost" title={usingAccessToken ? undefined : "Removing your key disconnects this tab"}>Remove</button>}
        </form>
        {canRememberKey() && hasGroqKey && !usingAccessToken && (
          <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-600">
            <input type="checkbox" checked={Boolean(rememberedHint)} onChange={(event) => toggleRemember(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
            <span><span className="font-semibold text-slate-700">Remember on this browser</span> for 30 days, in a secure cookie this page's scripts can't read. The server stores nothing.</span>
          </label>
        )}
        <button type="button" onClick={onDisconnect} className="btn-outline mt-5 text-rose-600 hover:!border-rose-300 hover:!text-rose-700"><LogOut size={15} /> Disconnect this tab</button>
      </Section>

      <Section title="Account" description="Optional. Signing in keeps your provider keys (encrypted), memories, reminders and preferences on this server's database so they follow you across devices.">
        <AccountPanel
          onSignedOut={() => { if (!getApiAccessToken() && !getSessionGroqKey()) onDisconnect(); else setNotice("Signed out."); }}
          onTabGroqKey={(key) => { setSessionGroqKey(key); onGroqKeyChange(key); setHasGroqKey(true); }}
        />
      </Section>

      <Section title="Calendar and email" description="Connect Google or Microsoft with their own sign-in. HANNAH reads your calendar and mail when you ask, and adds events, saves drafts or sends mail only after you approve each one.">
        <ConnectionsPanel />
      </Section>

      <Section title="Voice" description="Choose how HANNAH speaks and listens. Device engines keep audio on this device; hosted engines send it to the provider named.">
        <VoiceSettingsPanel />
        <WakeWordSetting />
      </Section>

      <Section title="Daily briefing" description="One short spoken summary of the day: today's calendar, reminders due, the newest mail, your routines, and (if you turn them on) the weather and the news. Say “good morning” in chat, add the Daily briefing step to an automation, or preview it here.">
        <BriefingSettings />
      </Section>

      <Section title="Phone" description="Pair your Android phone or iPhone and ask from your computer to call or text someone: your phone's own dialer or Messages opens with it filled in, and you tap Call or Send there. Nothing is placed or sent silently.">
        <PhonePanel />
      </Section>

      {desktopFilesAvailable() && (
        <Section title="Desktop access" description="Folders on this computer HANNAH may work in, and the commands she may run there. The desktop app enforces these rules itself, outside the AI model.">
          <DesktopAccessPanel />
        </Section>
      )}
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

      <DesktopAppPanel />

      <Section title="Appearance" description="Text size applies to every screen on this device. Motion already follows your system's reduced-motion setting.">
        <label className="flex items-center justify-between gap-4 text-sm">
          <span className="font-medium text-ink">Text size</span>
          <select value={textSize} onChange={(event) => changeTextSize(event.target.value as TextSize)} aria-label="Text size" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-ink">
            <option value="default">Default</option>
            <option value="large">Large (112%)</option>
            <option value="larger">Larger (125%)</option>
          </select>
        </label>
      </Section>

      <Section title="Your data" description={usingAccount ? "Kept in this browser and synced to your account. Clearing here also clears it on your other devices at the next sync." : "Stored only in this browser’s local storage. Nothing here is uploaded except the messages and saved memories sent with each chat request."}>
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
          <button type="button" onClick={clearAll} className="btn-ghost text-rose-600"><Trash2 size={15} /> Delete everything</button>
        </div>
      </Section>

      <Section title="Backup and restore" description="One file with your conversation, memories, reminders, automations, agent settings, skills, personalization and preferences, and which providers and models you chose. Never your keys, access token, sign-in or device identity: after restoring on another device, sign in there again.">
        <p className="text-xs text-slate-500">{backupContents.length ? `Includes: ${backupContents.map((section) => `${section.label} (${section.items.toLocaleString()})`).join(", ")}.` : "There's nothing to back up yet."}</p>
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void downloadBackup(); }}>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-slate-600">
            Passphrase (optional, encrypts the file)
            <input type="password" value={backupPassphrase} onChange={(event) => setBackupPassphrase(event.target.value)} autoComplete="new-password" placeholder="Leave empty for a readable file" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-brand-300" />
          </label>
          <button type="submit" disabled={!backupContents.length} className="btn-outline disabled:opacity-40"><Download size={15} /> Download backup</button>
        </form>
        <div className="mt-5 border-t border-slate-100 pt-4">
          <label className="block text-xs font-medium text-slate-600">
            Restore from a backup file
            <input type="file" accept=".json,application/json" onChange={(event) => void chooseRestoreFile(event.target.files?.[0])} className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-xl file:border file:border-slate-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink" />
          </label>
          {restoreProblem && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
              <p>{restoreProblem}</p>
              {restoreFile && /passphrase/i.test(restoreProblem) && (
                <form className="mt-2 flex gap-2" onSubmit={(event) => { event.preventDefault(); void openRestoreFile(restoreFile.text, restorePassphrase); }}>
                  <input type="password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} aria-label="Backup passphrase" autoComplete="off" className="min-w-0 flex-1 rounded-xl border border-amber-200 bg-white px-3 py-1.5 text-sm text-ink outline-none" />
                  <button type="submit" className="btn-outline !py-1.5 text-xs">Open</button>
                </form>
              )}
            </div>
          )}
          {restoreBackupData && (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-sm" aria-label="Backup contents">
              <p className="font-medium text-ink">Backup from HANNAH {restoreBackupData.manifest.app} on {restoreBackupData.manifest.platform}{restoreBackupData.manifest.createdAt ? `, ${new Date(restoreBackupData.manifest.createdAt).toLocaleString()}` : ""}{restoreBackupData.manifest.encrypted ? " · encrypted" : ""}</p>
              <ul className="mt-1 text-xs text-slate-600">{restoreBackupData.manifest.sections.map((section) => <li key={section.id}>{section.label}: {section.items.toLocaleString()}</li>)}</ul>
              <fieldset className="mt-3 flex flex-wrap gap-3 text-xs text-slate-700">
                <legend className="sr-only">How to restore</legend>
                <label className="flex items-center gap-1.5"><input type="radio" name="restore-mode" checked={restoreMode === "merge"} onChange={() => setRestoreMode("merge")} /> Merge: add what's missing, keep the newer copy of the rest</label>
                <label className="flex items-center gap-1.5"><input type="radio" name="restore-mode" checked={restoreMode === "replace"} onChange={() => setRestoreMode("replace")} /> Replace: make this device match the backup</label>
              </fieldset>
              <button type="button" disabled={restoring} onClick={runRestore} className="btn-primary mt-3 disabled:opacity-40"><Upload size={15} /> {restoring ? "Restoring…" : "Restore"}</button>
            </div>
          )}
        </div>
      </Section>

      <Section title="Setup check" description="One pass over what HANNAH needs on this device: the server, your AI model, account, calendar and email, voice, microphone, notifications, storage, the desktop app and recent errors. Nothing is changed.">
        <SetupCheckPanel />
      </Section>

      <Section title="Diagnostics" description="What went wrong on this device: crashes, errors, freezes, failed connections, agent and automation failures. Keys, tokens and file paths are removed before anything is recorded. An export holds these entries, the app version and platform; never your conversation, memories, keys or account.">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5">
            <Search size={14} className="text-slate-400" />
            <input value={diagnosticQuery} onChange={(event) => setDiagnosticQuery(event.target.value)} placeholder="Search diagnostics" aria-label="Search diagnostics" className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" />
          </label>
          <select value={diagnosticLevel} onChange={(event) => setDiagnosticLevel(event.target.value as DiagnosticLevel | "all")} aria-label="Level" className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-sm text-ink">
            <option value="all">All levels</option>
            <option value="error">Errors ({diagnosticCounts.error})</option>
            <option value="warn">Warnings ({diagnosticCounts.warn})</option>
            <option value="info">Info ({diagnosticCounts.info})</option>
          </select>
          <button type="button" onClick={() => { download(`hannah-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(Diagnostics.report(), null, 2)); setNotice("Diagnostic report downloaded."); }} className="btn-outline !py-1.5 text-xs"><Stethoscope size={13} /> Export diagnostics</button>
          <button type="button" disabled={!diagnosticCounts.error && !diagnosticCounts.warn && !diagnosticCounts.info} onClick={() => { Diagnostics.clear(); setNotice("Diagnostics cleared."); }} className="btn-ghost !py-1.5 text-xs text-rose-600 disabled:opacity-30"><Trash2 size={13} /> Clear</button>
        </div>
        {diagnosticEntries.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{diagnosticQuery || diagnosticLevel !== "all" ? "Nothing matches." : "Nothing recorded. That's good."}</p>
        ) : (
          <ul className="mt-3 max-h-80 space-y-1.5 overflow-y-auto" aria-label="Diagnostic entries">
            {diagnosticEntries.slice(0, 100).map((entry) => (
              <li key={entry.id} className="rounded-xl border border-slate-100 bg-white px-3 py-2 text-xs">
                <p className="flex flex-wrap items-center gap-2 text-slate-500">
                  <span className={`rounded-md px-1.5 py-0.5 font-semibold uppercase tracking-wide ${entry.level === "error" ? "bg-rose-50 text-rose-700" : entry.level === "warn" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{entry.level}</span>
                  <span className="font-medium text-slate-700">{entry.source}</span>
                  <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time>
                </p>
                <p className="mt-1 break-words text-sm text-ink">{entry.message}</p>
                {entry.detail && <details className="mt-1 text-slate-500"><summary className="cursor-pointer">Details</summary><pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{entry.detail}</pre></details>}
              </li>
            ))}
          </ul>
        )}
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
