import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { FileUp, FolderOpen, Globe, Loader2, Paperclip, Trash2, X } from "lucide-react";
import { RESEARCH_MODES, STUDIO_EVENT, deleteResearch, getAttachments, listFiles, readUpload, removeAttachment, researchHistory, type Extraction, type ResearchMode, type ResearchResult, type StudioFile } from "../services/Studio";
import { FileCard, ResearchCard } from "./StudioCards";
import MessageContent from "./MessageContent";

const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.csv,.tsv,.txt,.md,.json,image/png,image/jpeg,image/webp";

type ComposerProps = {
  /** The research mode the next message is sent with, or null when web search is off. */
  mode: ResearchMode | null;
  onMode: (mode: ResearchMode | null) => void;
  disabled?: boolean;
  onLibrary: () => void;
};

/** The chat's search switch, research mode, and attachments: one row above the message box. */
export function StudioComposer({ mode, onMode, disabled = false, onLibrary }: ComposerProps) {
  const [files, setFiles] = useState<Extraction[]>(getAttachments);
  const [reading, setReading] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const update = () => setFiles([...getAttachments()]);
    window.addEventListener(STUDIO_EVENT, update);
    return () => window.removeEventListener(STUDIO_EVENT, update);
  }, []);

  const attach = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files || [])].slice(0, 4);
    event.target.value = "";
    setError("");
    for (const file of chosen) {
      setReading(file.name);
      try { await readUpload(file); } catch (problem) { setError(`${file.name}: ${problem instanceof Error ? problem.message : "it couldn't be read."}`); }
    }
    setReading("");
  };

  return (
    <div className="mx-auto mb-1.5 w-full max-w-[720px] min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button" disabled={disabled} aria-pressed={mode !== null} onClick={() => onMode(mode === null ? "quick" : null)}
          title={mode === null ? "Search the web for this message and cite the sources" : "Web search is on for your next messages"}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${mode !== null ? "border-sky-200 bg-sky-50 text-sky-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
        >
          <Globe size={12} aria-hidden="true" /> Search the web
        </button>
        {mode !== null && (
          <select value={mode} disabled={disabled} onChange={(event) => onMode(event.target.value as ResearchMode)} aria-label="Research mode" title={RESEARCH_MODES.find((item) => item.id === mode)?.hint} className="max-w-40 rounded-lg border border-sky-200 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none">
            {RESEARCH_MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        )}
        <button type="button" disabled={disabled || Boolean(reading)} onClick={() => input.current?.click()} title="Attach a PDF, Word, PowerPoint, Excel, CSV, text or image file" className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
          {reading ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Paperclip size={12} aria-hidden="true" />} {reading ? "Reading…" : "Attach"}
        </button>
        <input ref={input} type="file" multiple accept={ACCEPT} onChange={(event) => void attach(event)} className="sr-only" aria-label="Attach files" tabIndex={-1} />
        <button type="button" onClick={onLibrary} title="Files HANNAH made and your research history" className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50">
          <FolderOpen size={12} aria-hidden="true" /> Library
        </button>
      </div>
      {files.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Attached files">
          {files.map((file) => (
            <li key={file.name} className={`flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] ${file.coverage.truncated || file.coverage.notes.length ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"}`} title={file.coverage.notes.join(" ") || `${file.coverage.read} of ${file.coverage.total} ${file.coverage.unit} read`}>
              <FileUp size={11} className="shrink-0" aria-hidden="true" />
              <span className="truncate font-medium">{file.name}</span>
              <span className="shrink-0 text-slate-500">{file.kind === "image" ? "described" : `${file.coverage.read}/${file.coverage.total} ${file.coverage.unit}`}{file.tables.length ? ` · ${file.tables.length} table${file.tables.length === 1 ? "" : "s"}` : ""}</span>
              <button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeAttachment(file.name)} className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-white hover:text-rose-600"><X size={11} /></button>
            </li>
          ))}
        </ul>
      )}
      {files.some((file) => file.coverage.notes.length > 0) && <p className="mt-1 text-[11px] leading-4 text-amber-800">{files.flatMap((file) => file.coverage.notes.map((note) => `${file.name}: ${note}`)).slice(0, 3).join(" ")}</p>}
      {error && <p role="alert" className="mt-1 text-[11px] text-rose-700">{error}</p>}
    </div>
  );
}

type LibraryProps = { onClose: () => void; onContinue: (result: ResearchResult) => void };

/** Files HANNAH made and past research, kept on this device. */
export function StudioLibrary({ onClose, onContinue }: LibraryProps) {
  const [tab, setTab] = useState<"files" | "research">("files");
  const [files, setFiles] = useState<StudioFile[] | null>(null);
  const [history, setHistory] = useState<ResearchResult[]>(researchHistory);
  const [open, setOpen] = useState<ResearchResult | null>(null);
  useEffect(() => {
    const load = () => { void listFiles().then(setFiles); setHistory(researchHistory()); };
    load();
    window.addEventListener(STUDIO_EVENT, load);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener(STUDIO_EVENT, load); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/40 p-3 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="library-title" className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <h2 id="library-title" className="font-display text-lg font-medium text-ink">Library</h2>
          <div role="tablist" aria-label="Library sections" className="flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
            {([["files", "Files"], ["research", "Research"]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setOpen(null); }} className={`rounded-lg px-3 py-1.5 transition ${tab === id ? "bg-white text-ink shadow-sm" : "text-slate-600"}`}>{label}</button>)}
          </div>
          <button type="button" aria-label="Close library" onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
          {tab === "files" && (
            files === null ? <p className="text-sm text-slate-500">Loading…</p>
              : files.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500">No files yet. Ask HANNAH for a presentation, a PDF, a Word report or an Excel workbook, and it appears here.</p>
                : <ul className="space-y-2">{files.map((file) => <li key={file.id}><FileCard fileId={file.id} compact onDeleted={() => void listFiles().then(setFiles)} /><p className="mt-0.5 px-1 text-[11px] text-slate-400">{new Date(file.createdAt).toLocaleString()}{file.request ? ` · “${file.request.slice(0, 90)}”` : ""}</p></li>)}</ul>
          )}
          {tab === "research" && !open && (
            history.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500">No research yet. Turn on “Search the web” in chat and ask a question.</p>
              : (
                <ul className="space-y-2">
                  {history.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 rounded-2xl border border-slate-200 p-3">
                      <button type="button" onClick={() => setOpen(item)} className="min-w-0 flex-1 text-left">
                        <p className="line-clamp-2 text-sm font-medium text-ink">{item.question}</p>
                        <p className="mt-0.5 text-[11px] text-slate-500">{item.modeLabel} · {item.sources.length} sources · {new Date(item.createdAt).toLocaleString()}</p>
                      </button>
                      <button type="button" aria-label={`Delete research: ${item.question}`} onClick={() => deleteResearch(item.id)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>
                    </li>
                  ))}
                </ul>
              )
          )}
          {tab === "research" && open && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setOpen(null)} className="btn-ghost !px-2.5 !py-1.5 text-xs">← All research</button>
                <button type="button" onClick={() => { onContinue(open); onClose(); }} className="btn-outline !px-3 !py-1.5 text-xs">Ask a follow-up in chat</button>
              </div>
              <p className="text-sm font-semibold text-ink">{open.question}</p>
              <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-ink"><MessageContent text={open.answer} citations={Object.fromEntries(open.sources.map((source) => [source.n, { url: source.url, title: source.title }]))} /></div>
              <div className="-ml-9"><ResearchCard researchId={open.id} /></div>
            </div>
          )}
        </div>
        <p className="border-t border-slate-100 px-5 py-2.5 text-[11px] leading-4 text-slate-500">Kept on this device. Files made while signed in are also in your account for 30 days; deleting one here deletes it there too.</p>
      </section>
    </div>
  );
}
