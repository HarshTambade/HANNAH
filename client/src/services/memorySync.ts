/**
 * Offline-first memory sync through the server's sync store
 * (`GET/POST /api/sync/memory`).
 *
 * Entries merge by id, last write wins (`updatedAt`), and deletes are kept as
 * tombstones in what's uploaded, so a memory deleted on one device stays
 * deleted instead of coming back from another device's older copy. Callers
 * get the visible entries; the store keeps the tombstones.
 */
import { apiFetch, apiUrl } from "./api";

export type MemoryEntry = {
  id: string;
  content: string;
  updatedAt: number;
  deleted?: boolean;
};

/** Every entry, tombstones included, newest version of each id. Exported for tests. */
export function mergeAll(local: MemoryEntry[], remote: MemoryEntry[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>();
  for (const entry of [...local, ...remote]) {
    if (!entry || typeof entry.id !== "string") continue;
    const existing = byId.get(entry.id);
    // Equal times: a delete wins, so a tie can't bring a memory back.
    if (!existing || entry.updatedAt > existing.updatedAt || (entry.updatedAt === existing.updatedAt && entry.deleted && !existing.deleted)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** The visible result of a merge (no tombstones). */
export function mergeMemories(local: MemoryEntry[], remote: MemoryEntry[]): MemoryEntry[] {
  return mergeAll(local, remote).filter((entry) => !entry.deleted);
}

export type MemorySyncResult = { ok: boolean; entries: MemoryEntry[]; error?: string };

/** Merge with the server copy and upload the result. On failure the local entries come back unchanged, with the reason. */
export async function syncMemory(syncId: string, local: MemoryEntry[]): Promise<MemorySyncResult> {
  try {
    const response = await apiFetch(apiUrl(`/api/sync/memory?syncId=${encodeURIComponent(syncId)}`), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok && response.status !== 404) throw new Error(`The sync store answered ${response.status}.`);
    const remoteData = response.ok ? await response.json() as { blob?: string } : { blob: "[]" };
    let remote: MemoryEntry[] = [];
    try {
      const parsed = JSON.parse(remoteData.blob || "[]");
      remote = Array.isArray(parsed) ? parsed : [];
    } catch {
      remote = [];
    }
    const all = mergeAll(local, remote);
    const saved = await apiFetch(apiUrl("/api/sync/memory"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncId, blob: JSON.stringify(all), version: Date.now() }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!saved.ok) throw new Error(`The sync store answered ${saved.status}.`);
    return { ok: true, entries: all.filter((entry) => !entry.deleted) };
  } catch (error) {
    return { ok: false, entries: local.filter((entry) => !entry.deleted), error: error instanceof Error ? error.message : String(error) };
  }
}
