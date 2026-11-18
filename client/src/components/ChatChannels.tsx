import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { apiFetch, apiUrl, getAccountHint } from "../services/api";

type Channel = { id: string; kind: string; name: string; paired: boolean; pairedName: string | null; pairingOpen: boolean };
type Pairing = { code: string; link: string; expiresAt: number };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(apiUrl(path), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw Object.assign(new Error(data.error || `The server answered ${response.status}.`), { reason: data.reason });
  return data;
}

/** Chat with HANNAH from a chat app (Telegram), paired to your own chat (server/channels.js). */
export default function ChatChannels() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [blocked, setBlocked] = useState("");
  const [botToken, setBotToken] = useState("");
  const [pairing, setPairing] = useState<(Pairing & { channel: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signedIn = Boolean(getAccountHint());

  const load = useCallback(() => {
    if (!signedIn) return;
    call<{ channels: Channel[] }>("GET", "/api/channels").then((body) => { setChannels(body.channels); setBlocked(""); }).catch((failure: Error & { reason?: string }) => setBlocked(failure.message));
  }, [signedIn]);
  useEffect(load, [load]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = await call<{ channel: Channel; pairing: Pairing }>("POST", "/api/channels/telegram", { botToken: botToken.trim() });
      setBotToken("");
      setPairing({ ...body.pairing, channel: body.channel.name });
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const repair = async (channel: Channel) => {
    try {
      const body = await call<{ pairing: Pairing }>("POST", `/api/channels/${channel.id}/pairing`);
      setPairing({ ...body.pairing, channel: channel.name });
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work.");
    }
  };
  const remove = async (channel: Channel) => {
    try {
      await call("DELETE", `/api/channels/${channel.id}`);
      if (pairing?.channel === channel.name) setPairing(null);
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't work.");
    }
  };

  return (
    <section aria-label="Chat apps" className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-soft sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white" aria-hidden="true"><img src="/connectors/telegram.png" alt="" className="h-6 w-6" /></span>
        <div className="min-w-0">
          <h3 className="font-['Manrope'] text-sm font-semibold text-ink">Chat apps · Telegram</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">Message HANNAH from Telegram. Your bot answers only the chat you pair with it; anyone else is told it's private.</p>
        </div>
      </div>

      {!signedIn ? (
        <p className="mt-3 text-xs text-slate-600">Sign in to your HANNAH account (Settings → Account) to connect a chat app: the bot needs somewhere safe to keep its token.</p>
      ) : blocked ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">{blocked}</p>
      ) : (
        <>
          {channels && channels.length > 0 && (
            <ul className="mt-3 space-y-2" aria-label="Connected chat apps">
              {channels.map((channel) => (
                <li key={channel.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs">
                  <span className="font-semibold text-ink">{channel.name}</span>
                  <span className={channel.paired ? "text-emerald-700" : "text-amber-800"}>{channel.paired ? `Paired with ${channel.pairedName}` : channel.pairingOpen ? "Waiting for you to pair" : "Not paired"}</span>
                  <span className="ml-auto flex gap-1">
                    <button type="button" onClick={() => void repair(channel)} className="btn-ghost inline-flex items-center gap-1 !px-2 !py-1 text-[11px]"><RefreshCw size={11} /> New pairing code</button>
                    <button type="button" aria-label={`Disconnect ${channel.name}`} onClick={() => void remove(channel)} className="btn-ghost inline-flex items-center gap-1 !px-2 !py-1 text-[11px] text-rose-600"><Trash2 size={11} /> Disconnect</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {pairing && (
            <div role="status" className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700">
              <p className="font-semibold text-ink">Pair {pairing.channel} with your Telegram</p>
              <p className="mt-1">Open this link on the phone or computer where you use Telegram and press Start. It works once, for 15 minutes.</p>
              <a href={pairing.link} target="_blank" rel="noreferrer" className="btn-primary mt-2 inline-flex items-center gap-1.5 !py-1.5 text-xs">Open in Telegram <ExternalLink size={12} /></a>
              <p className="mt-2 text-[11px] text-slate-500">Or send the bot this code: <code className="font-mono">{pairing.code}</code>. <button type="button" onClick={load} className="underline">I've paired</button></p>
            </div>
          )}
          <form onSubmit={connect} className="mt-3" aria-label="Connect a Telegram bot">
            <ol className="list-decimal space-y-0.5 pl-5 text-[11px] leading-5 text-slate-500">
              <li>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">@BotFather</a>, send <code>/newbot</code> and pick a name.</li>
              <li>Paste the token it gives you here.</li>
            </ol>
            <div className="mt-2 flex gap-2">
              <label htmlFor="telegram-bot-token" className="sr-only">Telegram bot token</label>
              <input id="telegram-bot-token" type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="123456789:AAE…" autoComplete="off" spellCheck={false} className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs outline-none focus:border-sky-400" />
              <button type="submit" disabled={busy || !botToken.trim()} className="btn-outline">{busy ? "Connecting…" : "Connect"}</button>
            </div>
          </form>
        </>
      )}
      {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
    </section>
  );
}
