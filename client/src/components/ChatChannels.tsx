import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, RefreshCw, Trash2, UserCheck, UserX } from "lucide-react";
import { apiFetch, apiUrl, getAccountHint } from "../services/api";
import LocalChatApps from "./LocalChatApps";

type Person = { id: string; name: string | null; at?: number; preview?: string; approvedAt?: number };
type Setup = { webhookUrl?: string; verifyToken?: string; installUrl?: string; steps?: string[] };
type Channel = { id: string; kind: Kind; label: string; name: string; paired: boolean; pairedName: string | null; pairingOpen: boolean; webhookVerified: boolean; allowed: Person[]; pending: Person[]; setup: Setup | null };
type Pairing = { code: string; link: string | null; expiresAt: number };
type Kind = "telegram" | "slack" | "discord" | "gchat" | "teams" | "whatsapp";

type Field = { name: string; label: string; placeholder: string; secret?: boolean; optional?: boolean };
/** What each platform asks for, and where to get it. The server checks every credential with the platform itself. */
export const PLATFORMS: Record<Kind, { label: string; icon: string; intro: string; create: { label: string; url: string }; fields: Field[] }> = {
  telegram: { label: "Telegram", icon: "/connectors/telegram.png", intro: "Create a bot with @BotFather (send /newbot) and paste its token.", create: { label: "Open @BotFather", url: "https://t.me/BotFather" }, fields: [{ name: "botToken", label: "Bot token", placeholder: "123456789:AAE…", secret: true }] },
  slack: { label: "Slack", icon: "/connectors/slack.png", intro: "Create a Slack app for your workspace with the bot scopes chat:write and im:history, install it, then paste its bot token and signing secret.", create: { label: "Create a Slack app", url: "https://api.slack.com/apps?new_app=1" }, fields: [{ name: "botToken", label: "Bot User OAuth Token", placeholder: "xoxb-…", secret: true }, { name: "signingSecret", label: "Signing secret", placeholder: "32 characters", secret: true }] },
  discord: { label: "Discord", icon: "/connectors/discord.png", intro: "Create an application in Discord's Developer Portal and paste its bot token. HANNAH registers the /hannah command for you.", create: { label: "Open the Developer Portal", url: "https://discord.com/developers/applications" }, fields: [{ name: "botToken", label: "Bot token", placeholder: "From the Bot tab", secret: true }] },
  gchat: { label: "Google Chat", icon: "/connectors/gchat.png", intro: "Use a Google Cloud project with the Google Chat API turned on (Google Workspace accounts). Paste the project number.", create: { label: "Open Google Cloud", url: "https://console.cloud.google.com/apis/library/chat.googleapis.com" }, fields: [{ name: "projectNumber", label: "Project number", placeholder: "123456789012" }] },
  teams: { label: "Microsoft Teams", icon: "/connectors/teams.png", intro: "Create an Azure Bot, then paste its Microsoft App ID and a client secret (and the tenant ID for a single-tenant bot).", create: { label: "Create an Azure Bot", url: "https://portal.azure.com/#create/Microsoft.AzureBot" }, fields: [{ name: "appId", label: "Microsoft App ID", placeholder: "xxxxxxxx-xxxx-…" }, { name: "appPassword", label: "Client secret", placeholder: "The secret's value", secret: true }, { name: "tenantId", label: "Tenant ID (single-tenant bots)", placeholder: "Optional", optional: true }] },
  whatsapp: { label: "WhatsApp", icon: "/connectors/whatsapp.png", intro: "Use the official WhatsApp Cloud API: a Meta app with WhatsApp, a business number, a permanent access token and the app secret.", create: { label: "Open Meta for Developers", url: "https://developers.facebook.com/apps/" }, fields: [{ name: "phoneNumberId", label: "Phone number ID", placeholder: "Digits, from API Setup" }, { name: "accessToken", label: "Permanent access token", placeholder: "EAAG…", secret: true }, { name: "appSecret", label: "App secret", placeholder: "32 characters", secret: true }] },
};
const KINDS = Object.keys(PLATFORMS) as Kind[];

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(apiUrl(path), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || `The server answered ${response.status}.`), { reason: data.reason });
  return data;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5">
      <p className="text-[11px] font-semibold text-slate-600">{label}</p>
      <div className="mt-0.5 flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-2 py-1 font-mono text-[11px] text-ink" title={value}>{value}</code>
        <button type="button" aria-label={`Copy ${label}`} onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} className="btn-ghost !px-2 !py-1 text-[11px]">{copied ? <Check size={12} /> : <Copy size={12} />}</button>
      </div>
    </div>
  );
}

function SetupSteps({ setup, verified }: { setup: Setup; verified: boolean }) {
  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
      <p className="font-semibold text-ink">{verified ? "Connected to the platform" : "Finish on the platform"}</p>
      {setup.steps && <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[11px] leading-5">{setup.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
      {setup.webhookUrl && <CopyLine label="Webhook URL" value={setup.webhookUrl} />}
      {setup.verifyToken && <CopyLine label="Verify token (shown once)" value={setup.verifyToken} />}
      {setup.installUrl && <a href={setup.installUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 underline">Install the app on your account <ExternalLink size={11} /></a>}
      {!verified && <p className="mt-2 text-[11px] text-amber-800">Waiting for the platform to reach HANNAH at the webhook URL.</p>}
    </div>
  );
}

/** Chat with HANNAH from a chat app, paired to your own chat (server/channels.js, server/channel-drivers.js). */
export default function ChatChannels() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [blocked, setBlocked] = useState("");
  const [kind, setKind] = useState<Kind>("telegram");
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ channel: string; pairing: Pairing; setup: Setup | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signedIn = Boolean(getAccountHint());
  const platform = PLATFORMS[kind];

  const load = useCallback(() => {
    if (!signedIn) return;
    call<{ channels: Channel[] }>("GET", "/api/channels").then((body) => { setChannels(body.channels); setBlocked(""); }).catch((failure: Error) => setBlocked(failure.message));
  }, [signedIn]);
  useEffect(load, [load]);

  const act = async (work: () => Promise<void>) => {
    setError("");
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : "That didn't work."); }
  };
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await act(async () => {
      const body = Object.fromEntries(platform.fields.map((field) => [field.name, (values[field.name] || "").trim()]));
      const connected = await call<{ channel: Channel; pairing: Pairing; setup: Setup | null }>("POST", `/api/channels/${kind}`, body);
      setValues({});
      setResult({ channel: connected.channel.name, pairing: connected.pairing, setup: connected.setup });
      load();
    });
    setBusy(false);
  };
  const ready = platform.fields.every((field) => field.optional || (values[field.name] || "").trim());

  return (
    <section aria-label="Chat apps" className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex -space-x-2" aria-hidden="true">{KINDS.slice(0, 4).map((item) => <img key={item} src={PLATFORMS[item].icon} alt="" className="h-8 w-8 rounded-lg border-2 border-white bg-white" />)}</div>
        <div className="min-w-0">
          <h3 className="font-['Manrope'] text-sm font-semibold text-ink">Chat apps</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">Message HANNAH from Telegram, Slack, Discord, Google Chat, Teams or WhatsApp. Your bot answers only the chat you pair with it, and anyone you approve; others are told it's private.</p>
        </div>
      </div>

      {!signedIn ? (
        <p className="mt-3 text-xs text-slate-600">Sign in to your HANNAH account (Settings → Account) to connect a chat app: the bot needs somewhere safe to keep its credentials.</p>
      ) : blocked ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">{blocked}</p>
      ) : (
        <>
          {channels && channels.length > 0 && (
            <ul className="mt-3 space-y-2" aria-label="Connected chat apps">
              {channels.map((channel) => (
                <li key={channel.id} className="rounded-xl border border-slate-200 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <img src={PLATFORMS[channel.kind]?.icon} alt="" className="h-5 w-5" />
                    <span className="font-semibold text-ink">{channel.name}</span>
                    <span className={channel.paired ? "text-emerald-700" : "text-amber-800"}>{channel.paired ? `Paired with ${channel.pairedName}` : channel.pairingOpen ? "Waiting for you to pair" : "Not paired"}</span>
                    {channel.webhookVerified === false && <span className="text-amber-800">· platform not connected yet</span>}
                    <span className="ml-auto flex gap-1">
                      <button type="button" onClick={() => void act(async () => { const body = await call<{ pairing: Pairing }>("POST", `/api/channels/${channel.id}/pairing`); setResult({ channel: channel.name, pairing: body.pairing, setup: null }); load(); })} className="btn-ghost inline-flex items-center gap-1 !px-2 !py-1 text-[11px]"><RefreshCw size={11} /> New pairing code</button>
                      <button type="button" aria-label={`Disconnect ${channel.name}`} onClick={() => void act(async () => { await call("DELETE", `/api/channels/${channel.id}`); load(); })} className="btn-ghost inline-flex items-center gap-1 !px-2 !py-1 text-[11px] text-rose-600"><Trash2 size={11} /> Disconnect</button>
                    </span>
                  </div>
                  {(channel.pending || []).length > 0 && (
                    <div className="mt-2" role="group" aria-label={`People asking to chat on ${channel.name}`}>
                      <p className="text-[11px] font-semibold text-slate-600">Asking to chat with HANNAH</p>
                      {(channel.pending || []).map((person) => (
                        <div key={person.id} className="mt-1 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{person.name || person.id}{person.preview ? <span className="text-slate-500"> · “{person.preview}”</span> : null}</span>
                          <button type="button" aria-label={`Approve ${person.name || person.id}`} onClick={() => void act(async () => { await call("POST", `/api/channels/${channel.id}/approve`, { senderId: person.id }); load(); })} className="btn-ghost inline-flex items-center gap-1 !px-2 !py-1 text-[11px] text-emerald-700"><UserCheck size={11} /> Approve</button>
                          <button type="button" aria-label={`Deny ${person.name || person.id}`} onClick={() => void act(async () => { await call("POST", `/api/channels/${channel.id}/deny`, { senderId: person.id }); load(); })} className="btn-ghost inline-flex items-center gap-1 !px-2 !py-1 text-[11px] text-rose-600"><UserX size={11} /> Deny</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {(channel.allowed || []).length > 0 && (
                    <p className="mt-2 text-[11px] text-slate-600">Also approved: {(channel.allowed || []).map((person) => (
                      <button key={person.id} type="button" title="Remove" onClick={() => void act(async () => { await call("POST", `/api/channels/${channel.id}/deny`, { senderId: person.id }); load(); })} className="mr-1 underline decoration-dotted">{person.name || person.id} ×</button>
                    ))}</p>
                  )}
                  {channel.setup && channel.webhookVerified === false && <SetupSteps setup={channel.setup} verified={channel.webhookVerified} />}
                </li>
              ))}
            </ul>
          )}
          {result && (
            <div role="status" className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700">
              <p className="font-semibold text-ink">Pair {result.channel} with your chat</p>
              <p className="mt-1">Send this code to the bot from your own account. It works once, for 15 minutes. <code className="font-mono font-semibold">{result.pairing.code}</code></p>
              {result.pairing.link && <a href={result.pairing.link} target="_blank" rel="noreferrer" className="btn-primary mt-2 inline-flex items-center gap-1.5 !py-1.5 text-xs">Open the chat <ExternalLink size={12} /></a>}
              {result.setup && <SetupSteps setup={result.setup} verified={false} />}
              <button type="button" onClick={load} className="mt-2 text-[11px] underline">I've paired</button>
            </div>
          )}
          <form onSubmit={connect} className="mt-3" aria-label="Connect a chat app">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Chat app">
              {KINDS.map((item) => (
                <button key={item} type="button" role="radio" aria-checked={kind === item} onClick={() => { setKind(item); setValues({}); }} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${kind === item ? "border-sky-400 bg-sky-50 font-semibold text-ink" : "border-slate-200 text-slate-600"}`}>
                  <img src={PLATFORMS[item].icon} alt="" className="h-4 w-4" /> {PLATFORMS[item].label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-5 text-slate-500">{platform.intro} <a href={platform.create.url} target="_blank" rel="noreferrer" className="underline">{platform.create.label}</a></p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {platform.fields.map((field) => (
                <label key={field.name} className="text-[11px] text-slate-600">
                  {field.label}
                  <input type={field.secret ? "password" : "text"} value={values[field.name] || ""} onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} placeholder={field.placeholder} autoComplete="off" spellCheck={false} className="mt-0.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs outline-none focus:border-sky-400" />
                </label>
              ))}
            </div>
            <button type="submit" disabled={busy || !ready} className="btn-outline mt-2">{busy ? "Checking with " + platform.label + "…" : `Connect ${platform.label}`}</button>
          </form>
        </>
      )}
      {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
      <LocalChatApps />
    </section>
  );
}
