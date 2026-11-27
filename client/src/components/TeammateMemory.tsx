/**
 * What one teammate remembers, and what it shares with others: search, add,
 * edit, mark as checked, and forget. Every record shows where it came from,
 * how confident it is, when it was last checked and when it expires. The
 * server refuses anything that looks like a credential (those belong in the
 * Secure Vault).
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Search, Trash2, X } from "lucide-react";
import workforce, { shortDate, type Bot, type MemoryRecord } from "../services/Workforce";

const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const KINDS = ["fact", "preference", "rule", "decision", "worklog", "context"];
const SCOPE_LABEL: Record<string, string> = { bot: "Only this teammate", user: "Shared with your teammates", project: "Project", team: "Team", device: "Device" };

export default function TeammateMemory({ bot }: { bot: Bot }) {
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<MemoryRecord[] | null>(null);
  const [scope, setScope] = useState("bot");
  const [kind, setKind] = useState("preference");
  const [content, setContent] = useState("");
  const [expires, setExpires] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const scopes = ((bot.memoryConfig?.scopes as string[] | undefined) || ["user", "bot"]).filter((item) => item === "bot" || item === "user");

  const load = useCallback(async () => {
    const [own, shared] = await Promise.all([workforce.memories({ botId: bot.id, scope: "bot" }), workforce.memories({ scope: "user" })]);
    setRecords([...own.memories, ...shared.memories].sort((a, b) => b.updatedAt - a.updatedAt));
  }, [bot.id]);
  useEffect(() => { void load().catch((e) => setError(message(e))); }, [load]);

  const act = async (action: () => Promise<unknown>, done: string) => {
    setError(""); setNote("");
    try { await action(); setNote(done); await load(); if (matches) setMatches(null); } catch (e) { setError(message(e)); }
  };
  const search = async () => {
    if (!query.trim()) { setMatches(null); return; }
    try { setMatches((await workforce.memoryRecall(query.trim(), bot.id)).matches); } catch (e) { setError(message(e)); }
  };
  const shown = matches ?? records;

  return (
    <section className="mt-3 space-y-3" aria-label={`${bot.name}'s memory`} data-testid="teammate-memory">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input className={input} value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) setMatches(null); }} placeholder="Search what it remembers" aria-label="Search memory" />
        <button type="submit" className={button}><Search size={14} /> Search</button>
      </form>
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {shown.map((record) => (
          <li key={record.id} className="rounded-xl border border-slate-200 p-3 text-sm" data-testid={`memory-${record.id}`}>
            {editing?.id === record.id ? (
              <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void act(() => workforce.memoryUpdate(record.id, { content: editing.content }), "Updated."); setEditing(null); }}>
                <textarea className={`${input} min-h-16`} value={editing.content} onChange={(event) => setEditing({ id: record.id, content: event.target.value })} aria-label="Memory text" />
                <div className="flex gap-2"><button type="submit" className={primary}>Save</button><button type="button" className={button} onClick={() => setEditing(null)}><X size={13} /> Cancel</button></div>
              </form>
            ) : <p className="whitespace-pre-wrap text-slate-900">{record.content}</p>}
            <p className="mt-1 text-xs text-slate-500">
              {SCOPE_LABEL[record.scope] || record.scope} · {record.kind}
              {record.provenance ? ` · from ${record.provenance}` : ""}
              {record.confidence !== null ? ` · confidence ${Math.round(record.confidence * 100)}%` : ""}
              {` · checked ${record.verifiedAt ? shortDate(record.verifiedAt) : "never"}`}
              {record.expiresAt ? ` · expires ${shortDate(record.expiresAt)}` : ""}
            </p>
            {editing?.id !== record.id && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" className={button} onClick={() => setEditing({ id: record.id, content: record.content })}><Pencil size={13} /> Edit</button>
                <button type="button" className={button} onClick={() => void act(() => workforce.memoryUpdate(record.id, { verifiedAt: new Date().toISOString() }), "Marked as checked today.")}><Check size={13} /> Still true</button>
                <button type="button" className="btn-ghost text-rose-600" onClick={() => void act(() => workforce.memoryDelete(record.id), "Forgotten.")}><Trash2 size={13} /> Forget</button>
              </div>
            )}
          </li>
        ))}
        {!shown.length && <li className="text-sm text-slate-500">{matches ? "Nothing matches." : `${bot.name} doesn't remember anything yet. Ask it to remember something in Chat, or add it here.`}</li>}
      </ul>
      <form className="rounded-xl border border-slate-200 p-3" onSubmit={(event) => { event.preventDefault(); void act(() => workforce.memoryCreate({ scope, botId: bot.id, kind, content: content.trim(), provenance: "Added by you", confidence: 1, verifiedAt: new Date().toISOString(), ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}) }), "Remembered.").then(() => setContent("")); }}>
        <span className={heading}>Remember something</span>
        <textarea className={`${input} mt-1 min-h-16`} value={content} onChange={(event) => setContent(event.target.value)} placeholder="e.g. Weekly reports go out on Friday afternoons." aria-label="New memory" />
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <select className={input} value={scope} onChange={(event) => setScope(event.target.value)} aria-label="Who remembers it">
            {scopes.map((item) => <option key={item} value={item}>{SCOPE_LABEL[item]}</option>)}
          </select>
          <select className={input} value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Kind">{KINDS.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <input type="date" className={input} value={expires} onChange={(event) => setExpires(event.target.value)} aria-label="Forget after (optional)" title="Forget after (optional)" />
        </div>
        <button type="submit" className={`${primary} mt-2`} disabled={!content.trim() || !scopes.length}>Remember</button>
        {!scopes.length && <p className="mt-1 text-xs text-amber-800">This teammate's memory is switched off in its configuration.</p>}
      </form>
      {note && <p className="text-xs text-emerald-700" role="status">{note}</p>}
      {error && <p className="text-xs text-rose-700" role="alert">{error}</p>}
      <p className="text-xs text-slate-500">Passwords, keys and card numbers are refused here; keep them in the <a className="underline" href="/vault">Secure Vault</a>.</p>
    </section>
  );
}
