import { useEffect, useState, type FormEvent } from "react";
import { Brain, Eye, LockKeyhole, Search, Trash2 } from "lucide-react";
import {
  clearMobileAgentMemories,
  deleteMobileAgentMemory,
  getMobileAgentMemoryStatus,
  searchMobileAgentMemories,
  setMobileAgentMemoryConsent,
  type MobileMemoryItem,
} from "../services/MobileAgent";

export default function MemoryControls() {
  const [enabled, setEnabled] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MobileMemoryItem[]>([]);
  const [status, setStatus] = useState("Loading on-device memory settings…");
  const [busy, setBusy] = useState(false);

  const refreshStatus = async () => {
    const result = await getMobileAgentMemoryStatus();
    setEnabled(result.enabled);
    setCount(result.count);
  };

  useEffect(() => {
    let active = true;
    void getMobileAgentMemoryStatus().then((result) => {
      if (!active) return;
      setEnabled(result.enabled);
      setCount(result.count);
      setStatus("");
    }).catch(() => {
      if (active) setStatus("On-device memory controls are unavailable on this build.");
    });
    return () => { active = false; };
  }, []);

  const toggleMemory = async () => {
    setBusy(true);
    setStatus("");
    try {
      await setMobileAgentMemoryConsent(!enabled);
      setEnabled(!enabled);
      setStatus(!enabled
        ? "On-device memory is enabled. HANNAH may save and recall personal facts from future conversations."
        : "Memory is off. Existing entries remain on this device until you delete them.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update the memory setting.");
    } finally {
      setBusy(false);
      await refreshStatus().catch(() => undefined);
    }
  };

  const searchMemories = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      const results = await searchMobileAgentMemories(query, 30);
      setItems(results);
      setStatus(results.length ? `Showing ${results.length} matching saved memories.` : "No matching saved memories were found.");
    } catch (error) {
      setItems([]);
      setStatus(error instanceof Error ? error.message : "Could not search saved memories.");
    } finally {
      setBusy(false);
    }
  };

  const removeMemory = async (item: MobileMemoryItem) => {
    setBusy(true);
    setStatus("");
    try {
      await deleteMobileAgentMemory(item.key);
      setItems((current) => current.filter(({ key }) => key !== item.key));
      await refreshStatus();
      setStatus("Saved memory deleted from this device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete that memory.");
    } finally {
      setBusy(false);
    }
  };

  const removeAllMemories = async () => {
    setBusy(true);
    setStatus("");
    try {
      await clearMobileAgentMemories();
      setItems([]);
      await refreshStatus();
      setStatus("All saved memories were deleted from this device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not clear saved memories.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3 shadow-soft" aria-label="On-device memory controls">
      <div className="mb-2 flex items-center gap-2 text-xs font-bold text-slate-500">
        <Brain size={14} className="text-emerald-300" /> On-device memory
        <span className="ml-auto text-xs text-slate-500">{count === null ? "…" : `${count} saved`}</span>
      </div>
      <p className="text-[13px] leading-relaxed text-slate-600">
        {enabled
          ? "When enabled, conversation memories are stored in this app’s private device storage and may be recalled in later chats. If you select MobileClaw · Anthropic, relevant recalled entries are sent to Anthropic with that request."
          : "Memory is off by default. Enabling it allows automatic saving and recall of personal facts on this device. You can turn it off or delete saved entries at any time."}
      </p>
      <button
        type="button"
        onClick={() => void toggleMemory()}
        disabled={busy || count === null}
        aria-pressed={enabled}
        className={`mt-2 w-full rounded-lg border px-3 py-2 text-left text-xs font-medium transition disabled:opacity-50 ${enabled ? "border-emerald-200 bg-emerald-50 text-emerald-600" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
      >
        <LockKeyhole size={12} className="mr-2 inline" />
        {enabled ? "Turn off memory" : "Enable on-device memory"}
      </button>

      {count !== null && count > 0 && (
        <>
          <form className="mt-3 flex gap-2" onSubmit={(event) => void searchMemories(event)}>
            <label className="sr-only" htmlFor="memory-search">Search saved memories</label>
            <input
              id="memory-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your saved memories"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600 outline-none placeholder:text-slate-400 focus:border-brand-400/60"
            />
            <button type="submit" disabled={busy || query.trim().length < 2} aria-label="Search saved memories" className="rounded-lg border border-slate-200 bg-white px-3 text-slate-600 disabled:opacity-40">
              <Search size={13} />
            </button>
          </form>
          {items.length > 0 && (
            <div className="mt-2 max-h-52 space-y-2 overflow-y-auto pr-1">
              {items.map((item) => (
                <article key={item.key} className="rounded-lg border border-slate-100 bg-white p-2.5 shadow-soft">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs uppercase tracking-wide text-emerald-600">{item.category}</span>
                    <button type="button" onClick={() => void removeMemory(item)} disabled={busy} aria-label="Delete this saved memory" className="rounded p-1 text-slate-500 hover:text-rose-600 disabled:opacity-40">
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-600">{item.text}</p>
                </article>
              ))}
            </div>
          )}
          <button type="button" onClick={() => void removeAllMemories()} disabled={busy} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-rose-600 transition hover:bg-rose-50 disabled:opacity-40">
            <Trash2 size={12} /> Delete all saved memories
          </button>
        </>
      )}
      {count === 0 && <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><Eye size={12} /> No saved memories are currently stored.</p>}
      {status && <p role="status" className="mt-2 text-xs leading-relaxed text-slate-500">{status}</p>}
    </section>
  );
}
