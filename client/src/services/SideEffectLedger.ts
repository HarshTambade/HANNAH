export type SideEffectStatus = "pending" | "executed" | "undone";

export type SideEffectEntry = {
  id: string;
  action: string;
  target: string;
  timestamp: string;
  delaySeconds: number;
  status: SideEffectStatus;
  undoableUntil: string;
};

const STORAGE_KEY = "hannah.sideEffects.v1";
const DEFAULT_DELAY = 30;

function readEntries(): SideEffectEntry[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: SideEffectEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 200)));
  } catch {
    // Best effort.
  }
}

export const SideEffectLedger = {
  record(action: string, target: string, delaySeconds = DEFAULT_DELAY): SideEffectEntry {
    const now = Date.now();
    const entry: SideEffectEntry = {
      id: crypto.randomUUID(),
      action,
      target,
      timestamp: new Date(now).toISOString(),
      delaySeconds,
      status: "pending",
      undoableUntil: new Date(now + delaySeconds * 1000).toISOString(),
    };
    writeEntries([entry, ...readEntries()]);
    return entry;
  },
  list(): SideEffectEntry[] {
    return readEntries();
  },
  undo(id: string) {
    const entries = readEntries();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index >= 0 && entries[index].status === "pending") {
      entries[index].status = "undone";
      writeEntries(entries);
    }
  },
  markExecuted(id: string) {
    const entries = readEntries();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      entries[index].status = "executed";
      writeEntries(entries);
    }
  },
  pendingUndoable() {
    const now = Date.now();
    return readEntries().filter((entry) => entry.status === "pending" && new Date(entry.undoableUntil).getTime() > now);
  },
};