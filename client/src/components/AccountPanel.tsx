import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Database, Download, ExternalLink, KeyRound, LogOut, RefreshCw, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Account, databaseLabel, type AccountStatus, type AuditEvent, type DeveloperKey, type StoredCredential, type Webhook } from "../services/Account";
import { lastSyncStatus, resetSyncState, SYNC_EVENT, SYNC_NAMESPACES, syncNow, type SyncStatus } from "../services/AccountSync";
import { ACCOUNT_EVENT, isGroqKey } from "../services/api";
import { VERCEL_SUPABASE_URL } from "../config/project";
import DatabaseIntegration from "./DatabaseIntegration";
import HostingSetup from "./HostingSetup";
import { copyText } from "../services/clipboard";

const inputClass = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-ink outline-none transition placeholder:text-slate-400 focus:border-sky-400 sm:text-sm";

// Hosted providers a user can save a key for. Local runtimes and custom endpoints are excluded on the server too.
const KEY_PROVIDERS = [
  ["groq", "Groq"], ["openai", "OpenAI"], ["azure", "Azure OpenAI"], ["bedrock", "Amazon Bedrock"], ["anthropic", "Anthropic"], ["gemini", "Google Gemini"], ["openrouter", "OpenRouter"],
  ["together", "Together AI"], ["cerebras", "Cerebras"], ["deepseek", "DeepSeek"], ["mistral", "Mistral"], ["xai", "xAI"],
  ["fireworks", "Fireworks"], ["nvidia", "NVIDIA NIM"], ["sambanova", "SambaNova"], ["perplexity", "Perplexity"], ["hyperbolic", "Hyperbolic"],
] as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** Email + password sign-in or sign-up. Used in the connect dialog and Settings. */
export function SignInForm({ signupAllowed, vault, onSignedIn, serverKeys = false, startWith = "signin" }: {
  signupAllowed: boolean;
  vault: boolean;
  onSignedIn: (groqKeyForTab: string) => void;
  /** This server lets accounts use its own models, so a new account needs no API key. */
  serverKeys?: boolean;
  startWith?: "signin" | "signup";
}) {
  const [mode, setMode] = useState<"signin" | "signup">(startWith === "signup" && signupAllowed ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (mode === "signup" && groqKey.trim() && !isGroqKey(groqKey)) {
      setError("That doesn't look like a Groq key. Groq keys start with gsk_.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "signup") await Account.register(email.trim(), password, displayName.trim());
      else await Account.login(email.trim(), password);
      let tabKey = "";
      if (mode === "signup" && groqKey.trim()) {
        if (vault) await Account.saveCredential("groq", groqKey.trim()).catch(() => { tabKey = groqKey.trim(); });
        else tabKey = groqKey.trim();
      }
      onSignedIn(tabKey);
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label={mode === "signup" ? "Create account" : "Sign in"}>
      {signupAllowed && (
        <div className="flex rounded-xl bg-slate-100 p-1 text-xs font-semibold" role="tablist">
          {(["signin", "signup"] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => { setMode(item); setError(""); }} className={`flex-1 rounded-lg px-3 py-2 transition ${mode === item ? "bg-white text-ink shadow-sm" : "text-slate-500"}`}>
              {item === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
      )}
      {mode === "signup" && (
        <div>
          <label htmlFor="account-name" className="mb-1 block text-xs font-medium text-slate-600">Name (optional)</label>
          <input id="account-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={60} autoComplete="name" className={inputClass} />
        </div>
      )}
      <div>
        <label htmlFor="account-email" className="mb-1 block text-xs font-medium text-slate-600">Email</label>
        <input id="account-email" type="email" required value={email} onChange={(event) => { setEmail(event.target.value); setError(""); }} autoComplete="email" className={inputClass} />
      </div>
      <div>
        <label htmlFor="account-password" className="mb-1 block text-xs font-medium text-slate-600">Password</label>
        <input id="account-password" type="password" required minLength={mode === "signup" ? 10 : 1} value={password} onChange={(event) => { setPassword(event.target.value); setError(""); }} autoComplete={mode === "signup" ? "new-password" : "current-password"} className={inputClass} />
        {mode === "signup" && <p className="mt-1 text-[11px] text-slate-500">At least 10 characters.</p>}
      </div>
      {mode === "signup" && serverKeys && (
        <details className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer select-none text-xs font-medium text-slate-600">Use my own Groq key instead (optional)</summary>
          <label htmlFor="account-groq" className="sr-only">Groq API key (optional)</label>
          <input id="account-groq" type="password" value={groqKey} onChange={(event) => setGroqKey(event.target.value)} placeholder="gsk_…" autoComplete="off" spellCheck={false} className={`${inputClass} mt-2 font-mono`} />
          <p className="mt-1 text-[11px] text-slate-500">Without one, HANNAH uses this server's models, within its daily limits. {vault ? "Your key would be saved encrypted to your account." : "Your key would be kept in this tab only."}</p>
        </details>
      )}
      {mode === "signup" && !serverKeys && (
        <div>
          <label htmlFor="account-groq" className="mb-1 block text-xs font-medium text-slate-600">Groq API key</label>
          <input id="account-groq" type="password" value={groqKey} onChange={(event) => setGroqKey(event.target.value)} placeholder="gsk_…" autoComplete="off" spellCheck={false} className={`${inputClass} font-mono`} />
          <p className="mt-1 text-[11px] text-slate-500">HANNAH needs it to answer. It's free at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="underline">console.groq.com/keys</a>, and you can add it later in Settings. {vault ? "Saved encrypted to your account so it works on every device." : "This server can't store keys, so it's kept in this tab only."}</p>
        </div>
      )}
      {error && <p role="alert" className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full !rounded-2xl disabled:cursor-wait">{busy ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}</button>
    </form>
  );
}

function useAccountStatus() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await Account.status());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener(ACCOUNT_EVENT, load);
    return () => window.removeEventListener(ACCOUNT_EVENT, load);
  }, [load]);
  return { status, loading, reload: load };
}

function ProviderKeys({ vault }: { vault: boolean }) {
  const [items, setItems] = useState<StoredCredential[]>([]);
  const [provider, setProvider] = useState("groq");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(() => Account.credentials().then((result) => setItems(result.credentials)).catch((error) => setMessage(errorText(error))), []);
  useEffect(() => { void load(); }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await Account.saveCredential(provider, key.trim());
      setKey("");
      setMessage(result.verified ? "Saved and checked with the provider." : "Saved. The provider couldn't be reached to check it.");
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><KeyRound size={14} /> Provider keys</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">Encrypted on the server with a key only the server holds, and sent only to that provider's own API. HANNAH never shows a saved key again.</p>
      {!vault && <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">Key storage is off: the server operator needs to connect Supabase through Vercel, or set HANNAH_VAULT_KEY.</p>}
      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white" aria-label="Saved provider keys">
          {items.map((item) => (
            <li key={item.providerId} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
              <span><span className="font-medium text-ink">{item.label}</span> <span className="font-mono text-xs text-slate-500">{item.hint}</span></span>
              <button type="button" aria-label={`Remove ${item.label} key`} onClick={() => void Account.removeCredential(item.providerId).then(load)} className="btn-ghost text-rose-600"><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      {vault && (
        <form onSubmit={save} className="mt-3 flex flex-wrap gap-2">
          <label htmlFor="key-provider" className="sr-only">Provider</label>
          <select id="key-provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-ink">
            {KEY_PROVIDERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <label htmlFor="key-value" className="sr-only">API key</label>
          <input id="key-value" type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="Paste API key" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-sky-400" />
          <button type="submit" disabled={busy || key.trim().length < 8} className="btn-outline">{busy ? "Checking…" : "Save key"}</button>
        </form>
      )}
      {message && <p role="status" className="mt-2 text-xs text-slate-600">{message}</p>}
    </div>
  );
}

function DeveloperKeys() {
  const [keys, setKeys] = useState<DeveloperKey[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(() => Account.apiKeys().then((result) => setKeys(result.keys)).catch((error) => setMessage(errorText(error))), []);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    try {
      const result = await Account.createApiKey(name.trim());
      setCreated(result.key);
      setCopied(false);
      setName("");
      await load();
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><ShieldCheck size={14} /> Developer API keys</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">For the OpenAI-compatible <code className="font-mono">/v1</code> API and scripts. Requests use your saved provider keys and count toward your budget.</p>
      {created && (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">
          <p className="font-semibold">Copy this key now. It won't be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg bg-white px-2 py-1.5 font-mono">{created}</code>
            <button type="button" className="btn-outline" onClick={() => { void copyText(created).then((copied) => copied && setCopied(true)); }}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      )}
      {keys.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white" aria-label="Developer API keys">
          {keys.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-ink">{item.name}</span> <span className="font-mono text-xs text-slate-500">{item.prefix}</span>
                <span className="block text-[11px] text-slate-500">{item.lastUsedAt ? `Last used ${new Date(item.lastUsedAt).toLocaleString()}` : "Never used"}</span>
              </span>
              <button type="button" aria-label={`Revoke ${item.name}`} onClick={() => void Account.revokeApiKey(item.id).then(load)} className="btn-ghost text-rose-600">Revoke</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="mt-3 flex gap-2">
        <label htmlFor="api-key-name" className="sr-only">Key name</label>
        <input id="api-key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Name, for example Laptop scripts" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-sky-400" />
        <button type="submit" disabled={!name.trim()} className="btn-outline">Create key</button>
      </form>
      {message && <p role="status" className="mt-2 text-xs text-slate-600">{message}</p>}
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = { "reminder.fired": "A reminder goes off", "team.completed": "A team task finishes", "budget.exceeded": "Today's budget runs out" };

function Webhooks() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<string[]>(["reminder.fired"]);
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(() => Account.webhooks().then((result) => { setHooks(result.webhooks); setEvents(result.events); }).catch((error) => setMessage(errorText(error))), []);
  useEffect(() => { void load(); }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    try {
      const result = await Account.createWebhook(url.trim(), chosen);
      setSecret(result.secret);
      setUrl("");
      await load();
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">Webhooks</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">HANNAH POSTs signed JSON to your https URL. Verify <code className="font-mono">X-HANNAH-Signature</code>: the HMAC-SHA256 of <code className="font-mono">timestamp.body</code> with your signing secret.</p>
      {secret && <p className="mt-2 break-all rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" role="status">Signing secret (shown once): <code className="font-mono">{secret}</code></p>}
      {hooks.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm" aria-label="Webhooks">
          {hooks.map((hook) => (
            <li key={hook.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs text-ink">{hook.url}</span>
                <span className="text-[11px] text-slate-500">{hook.events.map((item) => EVENT_LABELS[item] || item).join(" · ")}{hook.lastDeliveryAt ? ` · last delivery ${hook.lastStatus ? `HTTP ${hook.lastStatus}` : "failed"}` : ""}</span>
              </span>
              <span className="flex gap-1">
                <button type="button" className="btn-ghost text-xs" onClick={() => void Account.testWebhook(hook.id).then((result) => setMessage(result.ok ? `Test delivered (HTTP ${result.status}).` : `Test failed${result.status ? ` (HTTP ${result.status})` : ""}.`)).then(load).catch((error) => setMessage(errorText(error)))}>Send test</button>
                <button type="button" aria-label={`Remove webhook ${hook.url}`} className="btn-ghost text-rose-600" onClick={() => void Account.removeWebhook(hook.id).then(load)}><Trash2 size={13} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="mt-3 space-y-2">
        <label htmlFor="webhook-url" className="sr-only">Webhook URL</label>
        <input id="webhook-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/hannah-hook" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-sky-400" />
        <div className="flex flex-wrap gap-3 text-xs text-slate-700">
          {events.map((item) => (
            <label key={item} className="flex items-center gap-1.5"><input type="checkbox" checked={chosen.includes(item)} onChange={(event) => setChosen((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} className="accent-brand-600" /> {EVENT_LABELS[item] || item}</label>
          ))}
        </div>
        <button type="submit" disabled={!url.trim() || !chosen.length} className="btn-outline">Add webhook</button>
      </form>
      {message && <p role="status" className="mt-2 text-xs text-slate-600">{message}</p>}
    </div>
  );
}

function SyncControls() {
  const [status, setStatus] = useState<SyncStatus | null>(() => lastSyncStatus());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () => setStatus(lastSyncStatus());
    window.addEventListener(SYNC_EVENT, refresh);
    return () => window.removeEventListener(SYNC_EVENT, refresh);
  }, []);
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><RefreshCw size={14} /> Sync</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">Keeps {SYNC_NAMESPACES.map((ns) => ns.label.toLowerCase()).join(", ")} the same on every device you sign in on. Runs on start, every 5 minutes and when you leave the app.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} className="btn-outline" onClick={() => { setBusy(true); void syncNow().then(setStatus).finally(() => setBusy(false)); }}><RefreshCw size={13} className={busy ? "animate-spin" : ""} /> {busy ? "Syncing…" : "Sync now"}</button>
        <span className="text-xs text-slate-500" role="status">{status ? `${status.ok ? "Last synced" : "Last attempt failed"} ${new Date(status.at).toLocaleString()}${status.ok ? "" : `: ${status.message}`}` : "Not synced yet"}</span>
      </div>
    </div>
  );
}

function DangerZone({ onSignedOut }: { onSignedOut: () => void }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");

  const exportAccount = async () => {
    try {
      const data = await Account.exportData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "hannah-account-export.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-outline" onClick={() => void exportAccount()}><Download size={13} /> Export account data</button>
        <button type="button" className="btn-outline" onClick={() => void Account.audit().then((result) => setEvents(result.events)).catch((error) => setMessage(errorText(error)))}>Security activity</button>
        <button type="button" className="btn-ghost" onClick={() => { void Account.logoutEverywhere().finally(() => { resetSyncState(); onSignedOut(); }); }}><LogOut size={13} /> Sign out everywhere</button>
        <button type="button" className="btn-ghost text-rose-600" onClick={() => setConfirming((value) => !value)}><Trash2 size={13} /> Delete account</button>
      </div>
      {events && (
        <ul className="max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white text-xs" aria-label="Security activity">
          {events.length === 0 && <li className="px-3 py-2 text-slate-500">No activity yet.</li>}
          {events.map((item, index) => <li key={`${item.at}-${index}`} className="flex justify-between gap-3 border-b border-slate-100 px-3 py-2 last:border-0"><span className="text-ink">{item.event.replace(/\./g, " ")}{item.detail?.providerId ? ` · ${String(item.detail.providerId)}` : ""}{item.detail?.name ? ` · ${String(item.detail.name)}` : ""}</span><span className="shrink-0 text-slate-500">{new Date(item.at).toLocaleString()}</span></li>)}
        </ul>
      )}
      {confirming && (
        <form className="rounded-xl border border-rose-200 bg-rose-50 p-3" onSubmit={(event) => { event.preventDefault(); void Account.deleteAccount(password).then(() => { resetSyncState(); onSignedOut(); }).catch((error) => setMessage(errorText(error))); }}>
          <p className="text-xs text-rose-900">This deletes your account, saved keys, developer keys and synced data from the server. Data on this device stays.</p>
          <label htmlFor="delete-password" className="mt-2 block text-xs font-medium text-rose-900">Password</label>
          <div className="mt-1 flex gap-2">
            <input id="delete-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className="min-w-0 flex-1 rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm" />
            <button type="submit" disabled={!password} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Delete for good</button>
          </div>
        </form>
      )}
      {message && <p role="alert" className="text-xs text-rose-700">{message}</p>}
    </div>
  );
}

/** Settings → Account. */
export default function AccountPanel({ onSignedOut, onTabGroqKey }: { onSignedOut: () => void; onTabGroqKey: (key: string) => void }) {
  const { status, loading, reload } = useAccountStatus();

  if (loading && !status) return <p className="text-sm text-slate-500">Checking accounts on this server…</p>;
  if (!status) return <p className="text-sm text-slate-500">Couldn't reach the server to check accounts.</p>;
  if (!status.accounts.enabled) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="flex items-start gap-3">
          <Database size={18} className="mt-0.5 shrink-0 text-slate-400" />
          <div>
            <p className="text-slate-600">
              {status.database.configured
                ? `This server's database isn't reachable: ${status.database.error || "unknown error"}.`
                : "Accounts aren't turned on for this server yet. Until the server's operator connects a database, everything stays on this device."}
            </p>
          </div>
        </div>
        {!status.database.configured && <div className="mt-3"><HostingSetup /></div>}
        <details className="mt-3 [&>section]:mt-3" open={status.database.configured}>
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">Other ways to connect a database (for the server's operator)</summary>
          {!status.database.configured && <p className="mt-2 text-xs text-slate-600">Or connect Supabase through <a href={VERCEL_SUPABASE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-sky-700 underline">Vercel's Supabase integration <ExternalLink size={11} /></a>, or use any Postgres:</p>}
          <DatabaseIntegration showSetup={false} />
        </details>
      </div>
    );
  }
  if (!status.user) {
    return (
      <div className="max-w-sm">
        <p className="mb-3 text-sm text-slate-600">Sign in to keep your keys, memories and reminders across devices. Stored on {databaseLabel(status.database.provider)}, run by this server's operator.</p>
        <SignInForm signupAllowed={status.accounts.signup} vault={status.vault} serverKeys={status.accounts.serverKeys} onSignedIn={(key) => { if (key) onTabGroqKey(key); void reload(); void syncNow(); }} />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm text-ink"><UserRound size={16} className="text-slate-500" /> <span><span className="font-medium">{status.user.displayName || status.user.email}</span>{status.user.displayName && <span className="text-slate-500"> · {status.user.email}</span>}</span></p>
        <span className="pill-badge"><Database size={12} /> {databaseLabel(status.database.provider)}</span>
        <button type="button" className="btn-ghost" onClick={() => { void Account.logout().finally(() => { resetSyncState(); onSignedOut(); }); }}><LogOut size={13} /> Sign out</button>
      </div>
      <ProviderKeys vault={status.vault} />
      <SyncControls />
      <DeveloperKeys />
      <Webhooks />
      <DangerZone onSignedOut={onSignedOut} />
    </div>
  );
}
