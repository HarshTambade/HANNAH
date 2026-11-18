import { SyncService, decryptFromSync, type EncryptedEnvelope } from "./SyncService";

/**
 * A state-based CRDT for HANNAH's synced collections (memory, tasks, side
 * effects): each entry is a last-writer-wins register ordered by vector
 * clocks.
 *
 * - A write that causally follows another (its clock dominates) wins.
 * - Truly concurrent writes are ordered the same way on every device: the
 *   later timestamp, then the larger device id, so all devices converge.
 * - Deletes are tombstones, so a delete isn't undone by an older copy.
 * - Applying the same update twice changes nothing (idempotent), and order
 *   of arrival doesn't matter (commutative).
 *
 * Updates travel through SyncService, end-to-end encrypted with the sync
 * passphrase; the relay never sees their contents.
 */
export type CRDTUpdate = {
  id: string;
  collection: "memory" | "tasks" | "sideEffects";
  operation: "insert" | "update" | "delete";
  data: unknown;
  timestamp: number;
  vectorClock: Record<string, number>;
  deviceId: string;
};

export type CRDTEntry = { key: string; value: unknown; deleted: boolean; clock: Record<string, number>; timestamp: number; deviceId: string };
export type CRDTState = Record<CRDTUpdate["collection"], Map<string, CRDTEntry>>;

const DEVICE_ID_KEY = "hannah.deviceId.v1";

function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** -1: a happened before b; 1: b before a; 0: concurrent or equal. Exported for tests. */
export function compareClocks(a: Record<string, number>, b: Record<string, number>): -1 | 0 | 1 {
  let aLess = false;
  let bLess = false;
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[device] ?? 0;
    const y = b[device] ?? 0;
    if (x < y) aLess = true;
    if (y < x) bLess = true;
  }
  if (aLess && !bLess) return -1;
  if (bLess && !aLess) return 1;
  return 0;
}

const keyOf = (update: CRDTUpdate) => {
  const id = update.data && typeof update.data === "object" ? (update.data as { id?: unknown }).id : undefined;
  return typeof id === "string" && id ? id : update.id;
};

/** Whether `incoming` should replace `current` (the same answer on every device). */
function wins(incoming: CRDTEntry, current: CRDTEntry | undefined) {
  if (!current) return true;
  const order = compareClocks(current.clock, incoming.clock);
  if (order === -1) return true;
  if (order === 1) return false;
  if (incoming.timestamp !== current.timestamp) return incoming.timestamp > current.timestamp;
  return incoming.deviceId > current.deviceId;
}

const emptyState = (): CRDTState => ({ memory: new Map(), tasks: new Map(), sideEffects: new Map() });

export const CRDTSyncProvider = {
  deviceId: getDeviceId(),
  vectorClock: {} as Record<string, number>,
  pendingUpdates: [] as CRDTUpdate[],
  state: emptyState(),
  applied: new Set<string>(),

  incrementClock() {
    this.vectorClock[this.deviceId] = (this.vectorClock[this.deviceId] || 0) + 1;
  },

  /** A local change: applied here at once and queued for the other devices. */
  createUpdate(collection: CRDTUpdate["collection"], operation: CRDTUpdate["operation"], data: unknown): CRDTUpdate {
    this.incrementClock();
    const update: CRDTUpdate = {
      id: crypto.randomUUID(),
      collection,
      operation,
      data,
      timestamp: Date.now(),
      vectorClock: { ...this.vectorClock },
      deviceId: this.deviceId,
    };
    this.applyUpdate(update);
    this.pendingUpdates.push(update);
    return update;
  },

  /** Merge an update (local or remote). Returns whether it changed the state. */
  applyUpdate(update: CRDTUpdate): boolean {
    if (!update || !this.state[update.collection] || this.applied.has(update.id)) return false;
    this.applied.add(update.id);
    // The local clock learns everything it has now seen.
    for (const [device, count] of Object.entries(update.vectorClock || {})) {
      this.vectorClock[device] = Math.max(this.vectorClock[device] ?? 0, count);
    }
    const key = keyOf(update);
    const entry: CRDTEntry = { key, value: update.operation === "delete" ? null : update.data, deleted: update.operation === "delete", clock: { ...update.vectorClock }, timestamp: update.timestamp, deviceId: update.deviceId };
    const collection = this.state[update.collection];
    if (!wins(entry, collection.get(key))) return false;
    collection.set(key, entry);
    return true;
  },

  /** The live (not deleted) values of a collection. */
  values(collection: CRDTUpdate["collection"]) {
    return [...this.state[collection].values()].filter((entry) => !entry.deleted).map((entry) => entry.value);
  },

  getPendingUpdates(): CRDTUpdate[] {
    return [...this.pendingUpdates];
  },

  clearPendingUpdates(ids?: Set<string>) {
    this.pendingUpdates = ids ? this.pendingUpdates.filter((update) => !ids.has(update.id)) : [];
  },

  /**
   * Send this device's updates (encrypted) and merge the others'. The relay
   * keeps encrypted envelopes; `${relayUrl}/sync/<deviceId>` returns the ones
   * from other devices.
   */
  async sync(relayUrl: string, passphrase: string, { fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args), iterations }: { fetchImpl?: typeof fetch; iterations?: number } = {}) {
    const updates = this.getPendingUpdates();
    let sent = 0;
    if (updates.length) {
      for (const update of updates) SyncService.enqueue(update);
      const result = await SyncService.sync(relayUrl, passphrase, { fetchImpl, ...(iterations ? { iterations } : {}) });
      if (result.ok) {
        this.clearPendingUpdates(new Set(updates.map((update) => update.id)));
        sent = updates.length;
      }
    }
    let merged = 0;
    try {
      const response = await fetchImpl(`${relayUrl}/sync/${encodeURIComponent(this.deviceId)}`, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        const remote = await response.json() as { envelopes?: EncryptedEnvelope[] };
        for (const envelope of Array.isArray(remote.envelopes) ? remote.envelopes : []) {
          const batch = await decryptFromSync<Array<CRDTUpdate & { id: string }>>(envelope, passphrase);
          for (const update of Array.isArray(batch) ? batch : []) if (this.applyUpdate(update)) merged += 1;
        }
      }
    } catch {
      // Offline or a wrong passphrase: this device's updates stay queued for the next try.
    }
    return { synced: sent, merged, pending: this.pendingUpdates.length };
  },

  /** For tests: start over with an empty state. */
  reset(deviceId = getDeviceId()) {
    this.deviceId = deviceId;
    this.vectorClock = {};
    this.pendingUpdates = [];
    this.state = emptyState();
    this.applied = new Set();
  },

  // Conflict resolution for callers comparing two plain records: last-write-wins.
  resolveConflict(local: { updatedAt: number }, remote: { updatedAt: number }) {
    return local.updatedAt >= remote.updatedAt ? local : remote;
  },
};
