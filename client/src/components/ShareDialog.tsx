/**
 * Share this chat as a read-only link (services/Shares.ts).
 *
 * Your chat history stays on this device; this dialog is the only place a
 * copy leaves it, and only the messages you tick, when you press Publish.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Link2, Trash2, X } from "lucide-react";
import type { ChatMessage } from "../types";
import { isAccountSession } from "../services/api";
import { secretIn } from "../services/MemoryModel";
import { buildSharePayload, shareableMessages, Shares, type SharedLink } from "../services/Shares";
import { getResearch, listFiles } from "../services/Studio";
import { citationsOf } from "./StudioCards";
import { chatTitle } from "../services/Projects";

type Props = { open: boolean; onClose: () => void; messages: ChatMessage[]; skipIds?: string[] };

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

export default function ShareDialog({ open, onClose, messages, skipIds = [] }: Props) {
  const signedIn = isAccountSession();
  const candidates = useMemo(() => shareableMessages(messages).filter((message) => !message.id || !skipIds.includes(message.id)), [messages, skipIds]);
  const [unticked, setUnticked] = useState<Set<number>>(new Set());
  const [title, setTitle] = useState("");
  const [includeSources, setIncludeSources] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<SharedLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<SharedLink[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setUnticked(new Set());
    setTitle(chatTitle(candidates));
    setIncludeSources(false);
    setIncludeAttachments(false);
    setCreated(null);
    setCopied(false);
    setError("");
    if (!signedIn) return;
    void Shares.list().then(setLinks).catch(() => setLinks([]));
    void listFiles().then((files) => setFileNames(Object.fromEntries(files.map((file) => [file.id, file.name])))).catch(() => undefined);
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const hasSources = candidates.some((message) => message.studio?.researchId);
  const hasFiles = candidates.some((message) => message.studio?.fileIds?.length);
  const chosenCount = candidates.length - unticked.size;
  const secretCount = candidates.filter((message, index) => !unticked.has(index) && secretIn(message.content)).length;

  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const payload = buildSharePayload(candidates, (_message, index) => !unticked.has(index), title, { sources: includeSources, attachments: includeAttachments }, {
        sourcesFor: (id) => citationsOf(getResearch(id)),
        fileName: (id) => fileNames[id],
      });
      const link = await Shares.create(payload);
      setCreated(link);
      setLinks((current) => [link, ...(current ?? [])]);
    } catch (shareError) {
      setError(errorText(shareError));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: SharedLink) => {
    if (!window.confirm(`Delete the link “${link.title}”? Anyone who opens it after this sees that it was removed.`)) return;
    try {
      await Shares.revoke(link.id);
      setLinks((current) => (current ?? []).filter((item) => item.id !== link.id));
      if (created?.id === link.id) setCreated(null);
    } catch (revokeError) {
      setError(errorText(revokeError));
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-ink/60 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="share-title" className="relative my-auto w-full max-w-lg rounded-3xl border border-slate-200 bg-white shadow-soft-lg" data-testid="share-dialog">
        <div className="p-5 sm:p-7">
          <button type="button" aria-label="Close sharing" onClick={onClose} disabled={busy} className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"><X size={15} /></button>
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-brand-100 bg-brand-50 text-brand-600"><Link2 size={18} /></span>
          <h2 id="share-title" className="mt-4 font-['Manrope'] text-xl font-semibold text-ink">Share a read-only link</h2>
          <p className="mt-2 text-[13px] leading-6 text-slate-600">
            Your chat history stays on this device. Publishing uploads a copy of the messages you tick to this HANNAH server, and anyone with the link can read it.
            Messages you send later aren't added; share again for a new link. Memories, tool results and file contents are never included. You can delete the link at any time.
          </p>

          {!signedIn ? (
            <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">Sign in to an account (Settings → Account) to share. Links are kept by your account so you can delete them.</p>
          ) : created ? (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-[13px] font-semibold text-emerald-900">Published. Anyone with this link can read {created.messageCount} message{created.messageCount === 1 ? "" : "s"}.</p>
              <div className="mt-3 flex items-center gap-2">
                <input readOnly value={created.url} aria-label="Shared link" className="min-w-0 flex-1 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-[13px] text-ink" onFocus={(event) => event.currentTarget.select()} />
                <button type="button" onClick={() => void copy(created.url)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[13px] font-semibold text-white">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}</button>
              </div>
            </div>
          ) : candidates.length === 0 ? (
            <p className="mt-5 text-[13px] text-slate-600">There's nothing to share yet. Send a message first.</p>
          ) : (
            <div className="mt-5 space-y-4">
              <label className="block text-[13px] font-medium text-ink">
                Title
                <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px]" />
              </label>
              <fieldset>
                <legend className="text-[13px] font-medium text-ink">Messages to publish ({chosenCount} of {candidates.length})</legend>
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
                  {candidates.map((message, index) => (
                    <li key={message.id ?? index}>
                      <label className="flex items-start gap-2 rounded-lg p-1.5 text-[12.5px] hover:bg-slate-50">
                        <input type="checkbox" checked={!unticked.has(index)} onChange={(event) => setUnticked((current) => { const next = new Set(current); if (event.target.checked) next.delete(index); else next.add(index); return next; })} className="mt-0.5" />
                        <span className="min-w-0"><span className="font-semibold text-slate-500">{message.role === "user" ? "You" : "HANNAH"}: </span><span className="text-slate-700">{message.content.length > 140 ? `${message.content.slice(0, 140)}…` : message.content}</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              {secretCount > 0 && <p className="text-[12.5px] text-amber-800">{secretCount} ticked message{secretCount === 1 ? " looks" : "s look"} like {secretCount === 1 ? "it holds" : "they hold"} a key, password or ID number. The server hides keys, tokens and passwords it recognizes, but untick anything private to be sure.</p>}
              {(hasSources || hasFiles) && (
                <div className="space-y-1.5 text-[13px] text-slate-700">
                  {hasSources && <label className="flex items-center gap-2"><input type="checkbox" checked={includeSources} onChange={(event) => setIncludeSources(event.target.checked)} /> Include research sources (their links and titles)</label>}
                  {hasFiles && <label className="flex items-center gap-2"><input type="checkbox" checked={includeAttachments} onChange={(event) => setIncludeAttachments(event.target.checked)} /> Include file names (never the files)</label>}
                </div>
              )}
              <button type="button" onClick={() => void publish()} disabled={busy || chosenCount === 0} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-600 to-violet-600 px-5 text-[13px] font-bold text-white disabled:opacity-50">
                <Link2 size={14} /> {busy ? "Publishing…" : `Publish ${chosenCount} message${chosenCount === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-[13px] text-rose-700">{error}</p>}

          {signedIn && links && links.length > 0 && (
            <div className="mt-6">
              <h3 className="text-[12px] font-bold uppercase tracking-[0.15em] text-slate-500">Your shared links</h3>
              <ul className="mt-2 space-y-1.5">
                {links.map((link) => (
                  <li key={link.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[12.5px]">
                    <a href={link.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-brand-700 underline">{link.title}</a>
                    <span className="shrink-0 text-slate-500">{link.messageCount} msg · {new Date(link.createdAt).toLocaleDateString()}</span>
                    <button type="button" onClick={() => void revoke(link)} aria-label={`Delete the link ${link.title}`} title="Delete link" className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600"><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
