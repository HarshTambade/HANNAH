import { useEffect, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { MemoryService, type MemoryRecord } from "../services/MemoryService";
import { MEMORY_EVENT, notifyMemoryChanged } from "../services/MemoryStore";

const layerLabel: Record<MemoryRecord["layer"], string> = {
  session: "This session",
  long_term: "Remembered",
  persona: "About you",
};

export default function MemoryPanel() {
  const [records, setRecords] = useState<MemoryRecord[]>(() => MemoryService.list());
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const refresh = () => setRecords(MemoryService.list());
    window.addEventListener(MEMORY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(MEMORY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    MemoryService.add("persona", content.slice(0, 300));
    notifyMemoryChanged();
    setDraft("");
  };

  return (
    <div>
      <p className="text-sm leading-relaxed text-slate-600">
        HANNAH sends the 12 most recent items with each cloud message so replies can use them. They are stored only in this browser.
      </p>
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={300}
          placeholder="e.g. I prefer short answers, I live in Pune"
          aria-label="Add something for HANNAH to remember"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-ink outline-none placeholder:text-slate-400 focus:border-brand-300 sm:text-sm"
        />
        <button type="submit" disabled={!draft.trim()} className="btn-primary disabled:opacity-40"><Plus size={15} /> Add</button>
      </form>
      {records.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
          Nothing saved yet. Add a note above, or tap “Remember this” under any of your messages in chat.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {records.map((record) => (
            <li key={record.id} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-white px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{layerLabel[record.layer]}</span>
                <p className="mt-0.5 break-words text-sm text-slate-700">{record.content}</p>
              </div>
              <button type="button" onClick={() => { MemoryService.remove(record.id); notifyMemoryChanged(); }} aria-label="Delete memory" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600">
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
