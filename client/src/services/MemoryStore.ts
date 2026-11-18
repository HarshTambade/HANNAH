/**
 * Helpers around HANNAH's saved memories for the UI and prompt wiring:
 * change notifications, choosing what goes with a message, and clearing.
 */
import { MemoryService } from "./MemoryService";
import { MemoryResolutionService } from "./MemoryResolutionService";
import { secretIn } from "./MemoryModel";

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
  const chosen = MemoryService.forMessage(query, { allowSensitive: options.allowSensitive });
  // Checked again on the way out: each memory must still be valid text with no secret in it (storage can be edited).
  // If the set as a whole fails its integrity check (chaos mode's "corrupted memory"), none is sent.
  const resolution = MemoryResolutionService.resolve(chosen.picked.filter((item) => typeof item.memory.content === "string" && item.memory.content.trim().length > 0 && item.memory.content.length <= 2_000 && !secretIn(item.memory.content)));
  const picked = resolution.status === "resolved" ? resolution.value : [];
  const { hiddenSensitive } = chosen;
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
