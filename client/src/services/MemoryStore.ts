/**
 * Small helpers around HANNAH's saved memories (the same storage key that
 * MemoryService uses). Kept separate so the UI and prompt wiring do not depend
 * on MemoryService internals.
 */
const KEY = "hannah.memory.v1";
export const MEMORY_EVENT = "hannah:memory";

type StoredMemory = { id?: unknown; layer?: unknown; content?: unknown };

function readRaw(): StoredMemory[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Tell open screens (memory panel, dashboard) that memories changed. */
export function notifyMemoryChanged() {
  try {
    window.dispatchEvent(new Event(MEMORY_EVENT));
  } catch {
    // No window outside the browser.
  }
}

/** Saved facts sent with each cloud turn so HANNAH can use them. Newest first. */
export function memoriesForPrompt(limit = 12): string[] {
  return readRaw()
    .filter((record) => record.layer !== "session" && typeof record.content === "string" && record.content.trim())
    .slice(0, limit)
    .map((record) => String(record.content).slice(0, 300));
}

export function clearAllMemories() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Best effort.
  }
  notifyMemoryChanged();
}
