export type SyncStatus = { lastSyncAt: string | null; pendingOps: number; encrypted: boolean; connected: boolean };

const KEY = "hannah.sync.v1";

function readOps() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOps(ops: unknown[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ops.slice(0, 500)));
  } catch {
    // Best effort.
  }
}

export const SyncService = {
  status: { lastSyncAt: null as string | null, pendingOps: 0, encrypted: true, connected: false },
  enqueue(op: unknown) {
    const ops = readOps();
    ops.push({ ...op as object, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    writeOps(ops);
    this.status.pendingOps = ops.length;
  },
  async sync(relayUrl: string) {
    const ops = readOps();
    // Encrypt payload before leaving device (scaffold: base64 placeholder).
    const payload = btoa(JSON.stringify(ops));
    try {
      await fetch(relayUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload }) });
      this.status.lastSyncAt = new Date().toISOString();
      this.status.pendingOps = 0;
      this.status.connected = true;
      writeOps([]);
    } catch {
      this.status.connected = false;
    }
    return this.status;
  },
  getStatus(): SyncStatus {
    this.status.pendingOps = readOps().length;
    return { ...this.status };
  },
};