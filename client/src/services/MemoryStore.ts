/**
 * Helpers around HANNAH's saved memories for the UI and prompt wiring:
 * change notifications, choosing what goes with a message, and clearing.
 */
import { MemoryService } from "./MemoryService";

const KEY = "hannah.memory.v1";
export const MEMORY_EVENT = "hannah:memory";

/** Tell open screens (memory panel, dashboard) that memories changed. */
export function notifyMemoryChanged() {
  try {
    window.dispatchEvent(new Event(MEMORY_EVENT));
  } catch {
    // No window outside the browser.
  }
}

/**
 * The memories to send with a message: the ones that relate to it, plus a few
 * of your preferences (at most 11, under the server's limit of 12). Sensitive
 * memories only when the model is on-device or self-hosted. The chosen ones
 * are marked as used, so the memory panel can show when each last helped.
 */
export function selectMemoriesForPrompt(query: string, options: { allowSensitive?: boolean } = {}) {
  const { picked, hiddenSensitive } = MemoryService.forMessage(query, { allowSensitive: options.allowSensitive });
  if (picked.length) MemoryService.access(...picked.map((item) => item.memory.id));
  return {
    texts: picked.map((item) => item.memory.content.replace(/[\r\n]+/g, " ").slice(0, 300)),
    ids: picked.map((item) => item.memory.id),
    hiddenSensitive,
  };
}

/** Compatibility wrapper: the texts only. */
export function memoriesForPrompt(query = "", options: { allowSensitive?: boolean } = {}): string[] {
  return selectMemoriesForPrompt(query, options).texts;
}

export function clearAllMemories() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Best effort.
  }
  notifyMemoryChanged();
}
