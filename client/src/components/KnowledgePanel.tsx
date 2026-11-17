import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { FileText, FolderSearch, Search, Trash2, Upload } from "lucide-react";
import { isTextFile, Knowledge, KNOWLEDGE_EVENT, MAX_DOC_CHARS, MAX_TOTAL_CHARS, TEXT_EXTENSIONS, type KnowledgeDoc, type KnowledgeHit } from "../services/Knowledge";
import { desktopFilesAvailable, hannahDesktop, type SharedFolder } from "../services/DesktopFiles";

const kb = (chars: number) => `${Math.max(1, Math.round(chars / 1024))} KB`;
const sourceLabel = (doc: KnowledgeDoc) => (doc.source.kind === "paste" ? "Pasted text" : doc.source.kind === "desktop" ? `${doc.source.folder ?? "Shared folder"}/${doc.source.path ?? ""}` : doc.source.path ?? "File");
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "target", "__pycache__", ".venv", "venv"]);
const MAX_FOLDER_FILES = 200;

/** Add documents to HANNAH's knowledge, see what's there, and try a search. */
export default function KnowledgePanel() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>(() => Knowledge.list());
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<SharedFolder[]>([]);
  const [folderId, setFolderId] = useState("");
  const desktop = desktopFilesAvailable();

  useEffect(() => {
    const refresh = () => setDocs(Knowledge.list());
    window.addEventListener(KNOWLEDGE_EVENT, refresh);
    return () => window.removeEventListener(KNOWLEDGE_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    hannahDesktop().listFolders().then((result) => { setFolders(result.folders); setFolderId((current) => current || result.folders[0]?.id || ""); }).catch(() => setFolders([]));
  }, [desktop]);

  const usage = useMemo(() => Knowledge.usage(), [docs]);

  const report = (added: number, replaced: number, refused: string[]) => {
    const parts = [added ? `${added} document${added === 1 ? "" : "s"} added` : "", replaced ? `${replaced} updated` : "", ...refused];
    setNotice(parts.filter(Boolean).join(". ") || "Nothing was added.");
  };

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setBusy(true);
    let added = 0;
    let replaced = 0;
    const refused: string[] = [];
    for (const file of files) {
      if (!isTextFile(file.name)) { refused.push(`“${file.name}” isn't a text file HANNAH can read yet`); continue; }
      if (file.size > MAX_DOC_CHARS * 2) { refused.push(`“${file.name}” is larger than ${Math.round(MAX_DOC_CHARS / 1000)} KB`); continue; }
      const content = await file.text().catch(() => "");
      const result = Knowledge.add({ title: file.name, text: content, source: { kind: "upload", path: file.name } });
      if (result.ok) { added += 1; if (result.replaced) replaced += 1; } else refused.push(result.reason);
    }
    setBusy(false);
    report(added, replaced, refused);
  };

  const addText = (event: FormEvent) => {
    event.preventDefault();
    const result = Knowledge.add({ title: title || text.trim().split("\n")[0]!.slice(0, 60), text, source: { kind: "paste" } });
    if (!result.ok) { setNotice(result.reason); return; }
    setTitle("");
    setText("");
    setNotice(`“${result.doc.title}” ${result.replaced ? "updated" : "added"}: ${result.doc.chunks.length} passage${result.doc.chunks.length === 1 ? "" : "s"}.`);
  };

  const indexFolder = async () => {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return;
    setBusy(true);
    const bridge = hannahDesktop();
    const files: string[] = [];
    const walk = async (path: string, depth: number) => {
      if (depth > 6 || files.length >= MAX_FOLDER_FILES) return;
      const listing = await bridge.listDirectory({ folderId: folder.id, path });
      for (const entry of listing.entries) {
        if (files.length >= MAX_FOLDER_FILES) return;
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (entry.type === "directory") { if (!SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) await walk(child, depth + 1); }
        else if (entry.type === "file" && isTextFile(entry.name) && (entry.size ?? 0) <= MAX_DOC_CHARS * 2) files.push(child);
      }
    };
    let added = 0;
    let replaced = 0;
    const refused: string[] = [];
    try {
      await walk("", 0);
      for (const path of files) {
        const { content } = await bridge.readFile({ folderId: folder.id, path });
        const result = Knowledge.add({ title: path.replace(/^.*\//, ""), text: content, source: { kind: "desktop", folder: folder.name, path } });
        if (result.ok) { added += 1; if (result.replaced) replaced += 1; } else if (!/no text to index/.test(result.reason)) refused.push(result.reason);
        if (/budget|up to/.test(refused[refused.length - 1] ?? "")) break;
      }
      report(added, replaced, [...new Set(refused)].slice(0, 3));
      if (files.length >= MAX_FOLDER_FILES) setNotice((current) => `${current} Stopped at ${MAX_FOLDER_FILES} files; add a smaller folder for the rest.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The folder couldn't be read.");
    } finally {
      setBusy(false);
    }
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    setHits(Knowledge.search(query, 5));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-slate-700">Documents you add here stay on this device and are split into passages HANNAH can search. Ask about them in chat and she answers with citations such as <span className="font-mono text-xs">[Trip notes §3]</span>, so you can check every claim. Text files only for now ({TEXT_EXTENSIONS.slice(0, 6).map((item) => `.${item}`).join(", ")} and code); PDFs and Office files aren't read yet.</p>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex cursor-pointer flex-col items-start gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/70 p-4 text-sm text-slate-700 hover:border-sky-400">
          <span className="inline-flex items-center gap-2 font-semibold text-ink"><Upload size={15} /> Add files</span>
          <span className="text-xs text-slate-500">Up to {Math.round(MAX_DOC_CHARS / 1000)} KB each. The same file added again is updated.</span>
          <input type="file" multiple accept={TEXT_EXTENSIONS.map((item) => `.${item}`).join(",")} onChange={(event) => void addFiles(event)} disabled={busy} className="sr-only" aria-label="Add files to knowledge" />
        </label>
        <form onSubmit={addText} className="rounded-2xl border border-slate-200 bg-white/70 p-4">
          <label className="block text-xs font-semibold text-slate-700">Title
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="Optional" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-normal text-ink outline-none focus:border-sky-400" />
          </label>
          <label className="mt-2 block text-xs font-semibold text-slate-700">Text to add to knowledge
            <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={MAX_DOC_CHARS} placeholder="Paste notes, an article, meeting minutes…" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-normal text-ink outline-none focus:border-sky-400" />
          </label>
          <button type="submit" disabled={!text.trim() || busy} className="btn-outline mt-2 !py-1.5 text-xs disabled:opacity-40"><FileText size={13} /> Add text</button>
        </form>
      </div>

      {desktop && folders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/70 p-3 text-sm">
          <FolderSearch size={15} className="text-slate-500" />
          <label className="text-xs font-semibold text-slate-700">Shared folder
            <select value={folderId} onChange={(event) => setFolderId(event.target.value)} className="ml-2 rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm font-normal text-ink">
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void indexFolder()} disabled={busy} className="btn-outline !py-1.5 text-xs disabled:opacity-40">{busy ? "Indexing…" : "Index its text files"}</button>
          <span className="text-xs text-slate-500">Up to {MAX_FOLDER_FILES} files; node_modules, .git and build folders are skipped.</span>
        </div>
      )}

      {notice && <p role="status" className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">{notice}</p>}

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{usage.docs} document{usage.docs === 1 ? "" : "s"} · {kb(usage.chars)} of {Math.round(MAX_TOTAL_CHARS / 1_000_000)} MB · {usage.chunks} passages</p>
        {docs.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing added yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5" aria-label="Knowledge documents">
            {docs.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{doc.title}</p>
                  <p className="truncate text-xs text-slate-500">{sourceLabel(doc)} · {kb(doc.chars)} · {doc.chunks.length} passage{doc.chunks.length === 1 ? "" : "s"} · added {new Date(doc.addedAt).toLocaleDateString()}</p>
                </div>
                <button type="button" onClick={() => { Knowledge.remove(doc.id); setNotice(`“${doc.title}” removed.`); }} className="btn-ghost !p-2 text-rose-700" aria-label={`Remove ${doc.title}`}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {docs.length > 0 && (
        <form onSubmit={search} className="rounded-2xl border border-slate-200 bg-white/70 p-3">
          <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5">
            <Search size={14} className="text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try a search, as HANNAH would" aria-label="Search knowledge" className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" />
            <button type="submit" className="btn-outline !py-1 text-xs">Search</button>
          </label>
          {hits && (hits.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No passage matches.</p>
          ) : (
            <ol className="mt-2 space-y-1.5" aria-label="Search results">
              {hits.map((hit) => (
                <li key={`${hit.docId}-${hit.chunk}`} className="rounded-xl bg-white px-3 py-2 text-sm">
                  <p className="font-mono text-xs text-sky-800">{hit.citation}</p>
                  <p className="mt-1 line-clamp-3 text-slate-700">{hit.text}</p>
                </li>
              ))}
            </ol>
          ))}
        </form>
      )}
    </div>
  );
}
