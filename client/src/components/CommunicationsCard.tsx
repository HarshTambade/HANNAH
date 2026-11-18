/**
 * Communications on the dashboard: mail that still needs a reply in each
 * connected account, reply drafts that stay in the conversation, archiving,
 * and recent Google Chat spaces. Every item says which account it's from;
 * accounts are never merged silently. Nothing is sent from here: a reply is
 * saved as a draft in the person's own mail app.
 */
import { useCallback, useEffect, useState } from "react";
import { Archive, ExternalLink, Loader2, Mail, MessagesSquare, PenLine, RefreshCw } from "lucide-react";
import { CONNECTIONS_EVENT, Connections, type ChatMessage, type ChatSpace, type ConnectionProvider, type MailSummary } from "../services/Connections";
import { getAccountHint } from "../services/api";

type Waiting = MailSummary & { threadId: string };
const accountName = (provider: string) => (provider === "microsoft" ? "Outlook" : "Gmail");
const when = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  return days <= 0 ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : days === 1 ? "yesterday" : `${days} days ago`;
};
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function CommunicationsCard({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [providers, setProviders] = useState<ConnectionProvider[]>(() => Connections.connectedProviders());
  const [waiting, setWaiting] = useState<Waiting[] | null>(null);
  const [spaces, setSpaces] = useState<ChatSpace[] | null>(null);
  const [open, setOpen] = useState<{ space: ChatSpace; messages: ChatMessage[] } | null>(null);
  const [replying, setReplying] = useState<Waiting | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const chatOn = providers.some((provider) => provider.id === "google" && provider.features?.chat);

  const load = useCallback(async () => {
    if (!getAccountHint()) return;
    setError("");
    setBusy("load");
    try {
      const status = await Connections.status();
      const connected = status.providers.filter((provider) => provider.connected);
      setProviders(connected);
      if (!connected.length) return;
      const [mail, chat] = await Promise.all([
        Connections.needsReply({ days: 7, max: 10 }).catch((cause) => { setError(message(cause)); return null; }),
        connected.some((provider) => provider.id === "google" && provider.features?.chat) ? Connections.chatSpaces().catch(() => null) : Promise.resolve(null),
      ]);
      setWaiting(mail ? (mail.messages as Waiting[]) : []);
      setSpaces(chat ? chat.spaces.slice(0, 5) : null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => setProviders(Connections.connectedProviders());
    window.addEventListener(CONNECTIONS_EVENT, refresh);
    return () => window.removeEventListener(CONNECTIONS_EVENT, refresh);
  }, [load]);

  const saveReply = async () => {
    if (!replying || !reply.trim()) return;
    setBusy(`reply:${replying.id}`);
    setError("");
    try {
      const { draft } = await Connections.replyDraft(replying.provider, replying.id, { body: reply });
      setNotice(`Reply saved as a draft in ${accountName(draft.provider)}, in the same conversation. It hasn't been sent: send it from your mail app.`);
      setReplying(null);
      setReply("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  };

  const archive = async (item: Waiting) => {
    setBusy(`archive:${item.id}`);
    setError("");
    try {
      const result = await Connections.organize(item.provider, item.id, { archive: true });
      if (result.archived) {
        setWaiting((list) => list?.filter((entry) => entry.id !== item.id) ?? null);
        setNotice(`Archived “${item.subject}” in ${accountName(item.provider)}. It's still in All Mail; nothing was deleted.`);
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  };

  const openSpace = async (space: ChatSpace) => {
    setBusy(`space:${space.name}`);
    try {
      const { messages } = await Connections.chatMessages(space.name, { max: 15 });
      setOpen({ space, messages });
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  };

  if (!getAccountHint()) return null;
  const organizeOk = (provider: string) => providers.find((entry) => entry.id === provider)?.features?.organize !== false;

  return (
    <section className="deck-frame" aria-label="Communications">
      <div className="deck-card tone-plain">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-medium tracking-tight text-ink">Communications</h2>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {providers.map((provider) => <span key={provider.id} className="rounded-full bg-slate-100 px-2 py-0.5">{provider.id === "google" ? `Gmail${provider.features?.chat ? " · Chat" : ""}` : "Outlook"}{provider.email ? ` · ${provider.email}` : ""}</span>)}
            {providers.length > 0 && <button type="button" className="btn-ghost !p-1.5" aria-label="Check again" onClick={() => void load()} disabled={busy === "load"}>{busy === "load" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}</button>}
          </div>
        </div>

        {providers.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Connect Gmail or Outlook in Settings → Calendar and email, and the mail that still needs your reply shows up here. {onOpenSettings && <button type="button" className="font-medium text-ink underline" onClick={onOpenSettings}>Open Settings</button>}</p>
        ) : (
          <>
            <h3 className="mt-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><Mail size={12} /> Needs your reply (last 7 days)</h3>
            {waiting === null ? (
              <p className="mt-2 text-sm text-slate-500">{busy === "load" ? "Checking your mail…" : "Not checked yet."}</p>
            ) : waiting.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing is waiting on you. Automated senders and newsletters aren't counted.</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100">
                {waiting.slice(0, 8).map((item) => (
                  <li key={`${item.provider}:${item.id}`} className="py-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink"><span className={item.unread ? "font-semibold" : ""}>{item.subject}</span></p>
                        <p className="truncate text-xs text-slate-500">{item.from} · {when(item.date)} · {accountName(item.provider)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" className="btn-ghost !p-1.5" aria-label={`Draft a reply to ${item.subject}`} onClick={() => { setReplying(item); setReply(""); }}><PenLine size={14} /></button>
                        {organizeOk(item.provider) && <button type="button" className="btn-ghost !p-1.5" aria-label={`Archive ${item.subject}`} disabled={busy === `archive:${item.id}`} onClick={() => void archive(item)}><Archive size={14} /></button>}
                        {item.link && <a className="btn-ghost !p-1.5" href={item.link} target="_blank" rel="noreferrer" aria-label={`Open ${item.subject} in ${accountName(item.provider)}`}><ExternalLink size={14} /></a>}
                      </div>
                    </div>
                    {replying?.id === item.id && (
                      <div className="mt-2 space-y-2">
                        <label htmlFor={`reply-${item.id}`} className="sr-only">Reply</label>
                        <textarea id={`reply-${item.id}`} value={reply} onChange={(event) => setReply(event.target.value)} rows={3} maxLength={5000} placeholder={`Reply to ${item.from}…`} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-ink outline-none focus:border-sky-400 sm:text-sm" />
                        <div className="flex gap-2">
                          <button type="button" className="btn-primary !py-1.5 text-xs" disabled={!reply.trim() || busy === `reply:${item.id}`} onClick={() => void saveReply()}>Save as draft</button>
                          <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => setReplying(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {chatOn && (
              <>
                <h3 className="mt-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"><MessagesSquare size={12} /> Google Chat</h3>
                {spaces === null ? <p className="mt-2 text-sm text-slate-500">Couldn't list your spaces.</p> : spaces.length === 0 ? <p className="mt-2 text-sm text-slate-500">You're not in any spaces.</p> : (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {spaces.map((space) => <li key={space.name}><button type="button" className={`rounded-full border px-3 py-1 text-xs ${open?.space.name === space.name ? "border-ink bg-ink text-white" : "border-slate-200 text-ink hover:bg-slate-50"}`} onClick={() => void openSpace(space)}>{space.displayName}</button></li>)}
                  </ul>
                )}
                {open && (
                  <ol className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-xl bg-slate-50 p-3 text-xs" aria-label={`Recent messages in ${open.space.displayName}`}>
                    {open.messages.length === 0 ? <li className="text-slate-500">No recent messages.</li> : open.messages.map((entry) => <li key={entry.name}><span className="font-semibold text-ink">{entry.sender || "Someone"}:</span> <span className="text-slate-700">{entry.text}</span></li>)}
                  </ol>
                )}
              </>
            )}
            <p className="mt-3 text-xs text-slate-500">Ask HANNAH “summarize today's important emails” or “prepare a reply to Aman”: drafts and posts wait for your yes, and nothing is sent without it.</p>
          </>
        )}
        {notice && <p role="status" className="mt-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{notice}</p>}
        {error && <p role="alert" className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
      </div>
    </section>
  );
}
