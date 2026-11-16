/**
 * Offline-first memory sync scaffold.
 *
 * Uses a simple last-write-wins + id-based merge strategy that behaves like a
 * CRDT for append-only memory entries. When yjs/automerge is added, replace
 * mergeMemories with a document merge.
 */
export type MemoryEntry = {
  id: string;
  content: string;
  updatedAt: number;
  deleted?: boolean;
};

export function mergeMemories(local: MemoryEntry[], remote: MemoryEntry[]): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>();
  for (const entry of [...local, ...remote]) {
    const existing = byId.get(entry.id);
    if (!existing || entry.updatedAt >= existing.updatedAt) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].filter((entry) => !entry.deleted);
}

export async function syncMemory(syncId: string, local: MemoryEntry[]): Promise<MemoryEntry[]> {
  try {
    const response = await fetch(`/api/sync/memory?syncId=${encodeURIComponent(syncId)}`);
    const remoteData = response.ok ? await response.json() : { blob: "[]" };
    const remote = JSON.parse(remoteData.blob || "[]") as MemoryEntry[];
    const merged = mergeMemories(local, remote);
    await fetch("/api/sync/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncId, blob: JSON.stringify(merged), version: Date.now() }),
    });
    return merged;
  } catch {
    return local;
  }
}
