import { SyncService } from "./SyncService";

export type CRDTUpdate = {
  id: string;
  collection: "memory" | "tasks" | "sideEffects";
  operation: "insert" | "update" | "delete";
  data: unknown;
  timestamp: number;
  vectorClock: Record<string, number>;
  deviceId: string;
};

export type CRDTState = {
  memory: Map<string, { content: string; updatedAt: number; deleted: boolean }>;
  tasks: Map<string, { title: string; status: string; progress: number; updatedAt: number }>;
  sideEffects: Map<string, { action: string; target: string; status: string; timestamp: number }>;
};

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

export const CRDTSyncProvider = {
  deviceId: getDeviceId(),
  vectorClock: {} as Record<string, number>,
  pendingUpdates: [] as CRDTUpdate[],

  // Increment vector clock for this device
  incrementClock() {
    this.vectorClock[this.deviceId] = (this.vectorClock[this.deviceId] || 0) + 1;
  },

  // Create a CRDT update
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
    this.pendingUpdates.push(update);
    return update;
  },

  // Apply a remote update (merge)
  applyUpdate(update: CRDTUpdate) {
    // In a real CRDT implementation, this would merge the update into the local state
    // using the vector clock to determine ordering and conflicts.
    // For now, we store it as a pending operation to be merged by the sync service.
    SyncService.enqueue(update);
  },

  // Get pending updates for sync
  getPendingUpdates(): CRDTUpdate[] {
    return [...this.pendingUpdates];
  },

  // Clear pending updates after successful sync
  clearPendingUpdates() {
    this.pendingUpdates = [];
  },

  // Sync with relay
  async sync(relayUrl: string) {
    const updates = this.getPendingUpdates();
    if (updates.length === 0) return { synced: 0 };

    // Encrypt and send
    await SyncService.sync(relayUrl);
    this.clearPendingUpdates();

    // Fetch remote updates
    try {
      const response = await fetch(`${relayUrl}/sync/${this.deviceId}`);
      if (response.ok) {
        const remote = await response.json();
        if (remote.updates && Array.isArray(remote.updates)) {
          for (const update of remote.updates) {
            this.applyUpdate(update);
          }
        }
      }
    } catch {
      // Offline - will retry later
    }

    return { synced: updates.length };
  },

  // Conflict resolution: last-write-wins per field
  resolveConflict(local: { updatedAt: number }, remote: { updatedAt: number }) {
    return local.updatedAt >= remote.updatedAt ? local : remote;
  },
};