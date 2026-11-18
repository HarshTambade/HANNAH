import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Download, EyeOff, Pencil, Plus, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { MEMORY_SETTINGS_EVENT, MemoryService, type MemoryRecord } from "../services/MemoryService";
import { CATEGORY_LABELS, MEMORY_CATEGORIES, SOURCE_LABELS, tokens, type MemoryCategory } from "../services/MemoryModel";
import { memoriesAsMarkdown } from "../services/MemoryExportService";
import { MEMORY_EVENT, notifyMemoryChanged } from "../services/MemoryStore";

function when(iso: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

/** The memory center: what HANNAH remembers, where each memory came from, and what she may use. */
export default function MemoryPanel() {
  const [records, setRecords] = useState<MemoryRecord[]>(() => MemoryService.list());
  const [settings, setSettings] = useState(() => MemoryService.settings());
  const [draft, setDraft] = useState("");
  const [draftCategory, setDraftCategory] = useState<MemoryCategory | "auto">("auto");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemoryCategory | "all">("all");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const refresh = () => setRecords(MemoryService.list());
    const refreshSettings = () => setSettings(MemoryService.settings());
    window.addEventListener(MEMORY_EVENT, refresh);
    window.addEventListener(MEMORY_SETTINGS_EVENT, refreshSettings);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(MEMORY_EVENT, refresh);
      window.removeEventListener(MEMORY_SETTINGS_EVENT, refreshSettings);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const counts = useMemo(() => {
    const result = Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, 0])) as Record<MemoryCategory, number>;
    for (const record of records) result[record.category] += 1;
    return result;
  }, [records]);

  const shown = useMemo(() => {
    const words = tokens(query);
    return records.filter((record) => {
      if (filter !== "all" && record.category !== filter) return false;
      if (!words.length) return true;
      const own = tokens(record.content);
      return words.every((word) => own.some((candidate) => candidate.startsWith(word) || word.startsWith(candidate)));
    });
  }, [records, query, filter]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const result = MemoryService.remember(draft, { source: { kind: "you" }, layer: "persona", ...(draftCategory === "auto" ? {} : { category: draftCategory }) });
    if (!result.ok) {
      setNotice(result.reason);
      return;
    }
    notifyMemoryChanged();
    setNotice(result.merged ? "Updated a memory that said nearly the same thing." : `Saved under ${CATEGORY_LABELS[result.record.category]}${result.record.sensitivity === "sensitive" ? ", marked sensitive" : ""}.`);
    setDraft("");
  };

  const change = (id: string, patch: Parameters<typeof MemoryService.edit>[1]) => {
    const problem = MemoryService.edit(id, patch);
    setNotice(problem);
    if (!problem) notifyMemoryChanged();
    return !problem;
  };

  const exportMemories = (format: "json" | "markdown" = "json") => {
    const payload = { exportedAt: new Date().toISOString(), app: "HANNAH", settings, memories: MemoryService.list() };
    const url = URL.createObjectURL(format === "markdown" ? new Blob([memoriesAsMarkdown()], { type: "text/markdown" }) : new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hannah-memories-${new Date().toISOString().slice(0, 10)}.${format === "markdown" ? "md" : "json"}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm leading-relaxed text-slate-600">
          With each message HANNAH sends only the memories that relate to it, plus a few of your preferences. Sensitive ones (health, money, beliefs, contact details) go only to Ollama or to Auto in Private routing. Passwords, keys and ID numbers are never saved. Memories are kept on this device, and in your account when you sync.
        </p>
        <button type="button" role="switch" aria-checked={settings.enabled} onClick={() => setSettings(MemoryService.saveSettings({ enabled: !settings.enabled }))} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${settings.enabled ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>
          Memory {settings.enabled ? "on" : "off"}
        </button>
      </div>
      {!settings.enabled && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Memory is off: HANNAH doesn't use or save memories. What's below stays until you delete it.</p>}

      <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
        <input
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setNotice(""); }}
          maxLength={300}
          disabled={!settings.enabled}
          placeholder="e.g. I prefer short answers, I live in Pune"
          aria-label="Add something for HANNAH to remember"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-ink outline-none placeholder:text-slate-400 focus:border-brand-300 disabled:opacity-50 sm:text-sm"
        />
        <select value={draftCategory} onChange={(event) => setDraftCategory(event.target.value as MemoryCategory | "auto")} aria-label="Category for the new memory" disabled={!settings.enabled} className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-sm text-ink disabled:opacity-50">
          <option value="auto">Category: automatic</option>
          {MEMORY_CATEGORIES.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
        </select>
        <button type="submit" disabled={!draft.trim() || !settings.enabled} className="btn-primary disabled:opacity-40"><Plus size={15} /> Add</button>
      </form>
      {notice && <p role="status" className="mt-2 text-sm text-slate-700">{notice}</p>}

      <details className="mt-3 rounded-xl bg-white/60 px-3 py-2 text-sm">
        <summary className="cursor-pointer font-medium text-ink">Kinds of memory HANNAH may use in replies</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {MEMORY_CATEGORIES.map((category) => {
            const on = settings.categories[category];
            return (
              <button key={category} type="button" role="switch" aria-checked={on} aria-label={`Use ${CATEGORY_LABELS[category]} in replies`} onClick={() => setSettings(MemoryService.saveSettings({ categories: { ...settings.categories, [category]: !on } }))} className={`rounded-full px-3 py-1 text-xs font-medium ${on ? "bg-emerald-100 text-emerald-800" : "bg-white text-slate-500 line-through ring-1 ring-slate-200"}`}>
                {CATEGORY_LABELS[category]}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">A kind that's off is never sent to a model or returned by memory search. Its memories stay here.</p>
      </details>

      {records.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5">
            <Search size={14} className="text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memories" aria-label="Search memories" className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none" />
          </label>
          <button type="button" onClick={() => exportMemories("json")} className="btn-outline !py-1.5 text-xs"><Download size={12} /> Export JSON</button>
          <button type="button" onClick={() => exportMemories("markdown")} className="btn-outline !py-1.5 text-xs"><Download size={12} /> Export Markdown</button>
          <div className="flex w-full flex-wrap gap-1.5" role="group" aria-label="Filter by category">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className={`rounded-full px-2.5 py-0.5 text-xs ${filter === "all" ? "bg-ink text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>All {records.length}</button>
            {MEMORY_CATEGORIES.filter((category) => counts[category]).map((category) => (
              <button key={category} type="button" aria-pressed={filter === category} onClick={() => setFilter(category)} className={`rounded-full px-2.5 py-0.5 text-xs ${filter === category ? "bg-ink text-white" : "bg-white text-slate-600 ring-1 ring-slate-200"}`}>{CATEGORY_LABELS[category]} {counts[category]}</button>
            ))}
          </div>
        </div>
      )}

      {records.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
          Nothing saved yet. Add a note above, or tap “Remember this” under any of your messages in chat.
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No memories match.</p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label="Memories">
          {shown.map((record) => (
            <li key={record.id} className="rounded-xl border border-slate-100 bg-white px-3 py-2.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <select value={record.category} onChange={(event) => change(record.id, { category: event.target.value as MemoryCategory })} aria-label="Change category" className={`rounded-md bg-slate-50 px-1 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${settings.categories[record.category] ? "text-slate-600" : "text-slate-400 line-through"}`}>
                      {MEMORY_CATEGORIES.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
                    </select>
                    {record.layer === "session" && <span>This session</span>}
                    {record.sensitivity === "sensitive" && <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-800"><ShieldAlert size={11} /> Sensitive</span>}
                  </div>
                  {editing?.id === record.id ? (
                    <form className="mt-1 flex gap-2" onSubmit={(event) => { event.preventDefault(); if (change(record.id, { content: editing.text })) setEditing(null); }}>
                      <input value={editing.text} onChange={(event) => setEditing({ id: record.id, text: event.target.value })} maxLength={300} aria-label="Edit memory text" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-sm text-ink outline-none focus:border-brand-300" autoFocus />
                      <button type="submit" aria-label="Save memory" className="rounded-lg p-1.5 text-emerald-700 hover:bg-emerald-50"><Check size={14} /></button>
                      <button type="button" aria-label="Cancel editing" onClick={() => setEditing(null)} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X size={14} /></button>
                    </form>
                  ) : (
                    <p className="mt-0.5 break-words text-sm text-slate-700">{record.content}</p>
                  )}
                  {record.previous?.length ? <p className="mt-0.5 text-xs text-slate-500">Earlier: {record.previous.map((entry) => `“${entry.content}” (until ${when(entry.until)})`).join("; ")}</p> : null}
                  <p className="mt-1 text-xs text-slate-500">
                    {SOURCE_LABELS[record.source.kind]}{record.source.detail ? ` (${record.source.detail})` : ""} · saved {when(record.createdAt)}
                    {record.updatedAt !== record.createdAt ? ` · updated ${when(record.updatedAt)}` : ""}
                    {record.accessCount > 0 ? ` · used in ${record.accessCount} repl${record.accessCount === 1 ? "y" : "ies"}, last ${when(record.lastAccessed)}` : " · not used yet"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center">
                  <button type="button" onClick={() => change(record.id, { sensitivity: record.sensitivity === "sensitive" ? "normal" : "sensitive" })} aria-label={record.sensitivity === "sensitive" ? "Mark as not sensitive" : "Mark as sensitive"} title={record.sensitivity === "sensitive" ? "Sensitive: only sent to Ollama or Private routing. Click to allow cloud models." : "Mark sensitive: only send to Ollama or Private routing"} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-amber-50 hover:text-amber-700">
                    {record.sensitivity === "sensitive" ? <ShieldAlert size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button type="button" onClick={() => setEditing({ id: record.id, text: record.content })} aria-label="Edit memory" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><Pencil size={14} /></button>
                  <button type="button" onClick={() => { MemoryService.remove(record.id); notifyMemoryChanged(); }} aria-label="Delete memory" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
