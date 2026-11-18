/**
 * Queued sync of changes to a relay, end-to-end encrypted.
 *
 * Changes are queued on the device and sent together. Before anything leaves
 * the device it's encrypted with AES-256-GCM under a key derived from the
 * person's sync passphrase (PBKDF2-SHA-256, 310,000 iterations, a fresh salt
 * and IV for every upload), so the relay only ever holds ciphertext. Without
 * a passphrase nothing is sent. Only what the relay confirmed storing (a 2xx
 * answer) leaves the queue.
 */
export type SyncStatus = { lastSyncAt: string | null; pendingOps: number; encrypted: boolean; connected: boolean; lastError?: string | null };
export type EncryptedEnvelope = { v: 1; alg: "AES-256-GCM"; kdf: "PBKDF2-SHA-256"; iterations: number; salt: string; iv: string; ciphertext: string };

const KEY = "hannah.sync.v1";
const ITERATIONS = 310_000;

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

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Encrypt any JSON value under the passphrase. */
export async function encryptForSync(value: unknown, passphrase: string, iterations = ITERATIONS): Promise<EncryptedEnvelope> {
  if (!passphrase || passphrase.length < 8) throw new Error("Choose a sync passphrase of at least 8 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(value))));
  return { v: 1, alg: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

/** Decrypt an envelope from encryptForSync. A wrong passphrase or a changed byte fails (GCM authenticates). */
export async function decryptFromSync<T = unknown>(envelope: EncryptedEnvelope, passphrase: string): Promise<T> {
  if (envelope?.v !== 1 || envelope.alg !== "AES-256-GCM") throw new Error("That isn't a HANNAH sync envelope.");
  const key = await deriveKey(passphrase, fromBase64(envelope.salt), envelope.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv) as BufferSource }, key, fromBase64(envelope.ciphertext) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new Error("The sync passphrase is wrong, or the data was changed.");
  }
}

export const SyncService = {
  status: { lastSyncAt: null as string | null, pendingOps: 0, encrypted: true, connected: false, lastError: null as string | null },
  enqueue(op: unknown) {
    const ops = readOps();
    ops.push({ ...op as object, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    writeOps(ops);
    this.status.pendingOps = ops.length;
  },
  /** Send the queued changes, encrypted, to the relay. Returns the status; `ok` says whether the relay stored them. */
  async sync(relayUrl: string, passphrase: string, { fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args), iterations = ITERATIONS } = {}): Promise<SyncStatus & { ok: boolean }> {
    const ops = readOps();
    if (!ops.length) return { ...this.getStatus(), ok: true };
    try {
      const envelope = await encryptForSync(ops, passphrase, iterations);
      const response = await fetchImpl(relayUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope, count: ops.length }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`The sync relay answered ${response.status}.`);
      // Only what was sent is cleared; changes queued meanwhile stay.
      const sent = new Set(ops.map((op: { id?: string }) => op.id));
      writeOps(readOps().filter((op: { id?: string }) => !sent.has(op.id)));
      this.status.lastSyncAt = new Date().toISOString();
      this.status.connected = true;
      this.status.lastError = null;
      return { ...this.getStatus(), ok: true };
    } catch (error) {
      this.status.connected = false;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      return { ...this.getStatus(), ok: false };
    }
  },
  getStatus(): SyncStatus {
    this.status.pendingOps = readOps().length;
    return { ...this.status };
  },
};
