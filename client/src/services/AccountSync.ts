/**
 * Sync on-device data with the signed-in account.
 *
 * Each namespace is merged three ways: the copy from the last sync (base), this
 * device (local) and the account (remote). Something added or changed on one
 * side is kept; something deleted on one side and unchanged on the other is
 * deleted; when both sides changed the same item, the newer one wins (or this
 * device's, when neither has a timestamp). Writes use the server version, so a
 * concurrent sync from another device retries instead of overwriting it.
 */
import { Account, AccountError } from "./Account";
import { isAccountSession } from "./api";

type Item = Record<string, unknown>;
type Namespace = {
  name: "memories" | "reminders" | "communitySkills" | "chatHistory" | "settings";
  label: string;
  storageKey?: string;
  /** settings: the localStorage keys synced as one object. */
  keys?: string[];
  idOf?: (item: Item) => string | undefined;
  stampOf?: (item: Item) => number;
  event: string;
  limit?: number;
};

const stamp = (...values: unknown[]) => Math.max(0, ...values.map((value) => (typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) || 0 : 0)));

export const SYNC_NAMESPACES: Namespace[] = [
  { name: "memories", label: "Memories", storageKey: "hannah.memory.v1", idOf: (item) => item.id as string, stampOf: (item) => stamp(item.updatedAt, item.createdAt), event: "hannah:memory", limit: 500 },
  { name: "reminders", label: "Reminders", storageKey: "hannah.reminders.v1", idOf: (item) => item.id as string, stampOf: (item) => stamp(item.firedAt, item.createdAt), event: "hannah:reminders", limit: 200 },
  { name: "communitySkills", label: "Community skills", storageKey: "hannah.communitySkills.v1", idOf: (item) => (item.manifest as Item | undefined)?.id as string, stampOf: (item) => stamp(item.installedAt), event: "hannah:community-skills", limit: 50 },
  { name: "chatHistory", label: "Chat history", storageKey: "hannah.chat.history.v1", idOf: (item) => item.id as string, event: "hannah:chat-history", limit: 200 },
  { name: "settings", label: "Preferences", keys: ["hannah.budget.dailyUsd", "hannah.guardian.strictness.v1", "hannah.cloudProvider", "hannah.voiceEnabled", "hannah.voice.settings.v1", "hannah.speechLanguage", "hannah.specialists.v1", "hannah.chat.team"], event: "hannah:settings" },
];

const BASE_PREFIX = "hannah.sync.base.";
export const SYNC_STATUS_KEY = "hannah.sync.status.v1";
export const SYNC_EVENT = "hannah:sync";

export type SyncStatus = { at: number; ok: boolean; message: string; counts?: Record<string, number> };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked.
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Three-way merge of id-keyed lists. Exported for tests. */
export function mergeLists(base: Item[], local: Item[], remote: Item[], idOf: (item: Item) => string | undefined, stampOf: (item: Item) => number = () => 0): Item[] {
  const index = (items: Item[]) => new Map(items.map((item) => [idOf(item), item] as const).filter((entry): entry is [string, Item] => Boolean(entry[0])));
  const b = index(base);
  const l = index(local);
  const r = index(remote);
  const ids = new Set([...l.keys(), ...r.keys()]);
  const order: string[] = [];
  for (const id of [...l.keys(), ...r.keys()]) if (!order.includes(id)) order.push(id);
  const merged = new Map<string, Item>();
  for (const id of ids) {
    const was = b.get(id);
    const mine = l.get(id);
    const theirs = r.get(id);
    if (mine && theirs) {
      if (same(mine, theirs)) merged.set(id, mine);
      else if (was && same(mine, was)) merged.set(id, theirs);
      else if (was && same(theirs, was)) merged.set(id, mine);
      else merged.set(id, stampOf(theirs) > stampOf(mine) ? theirs : mine);
    } else if (mine) {
      // Missing remotely: deleted there if it existed at the last sync and we didn't change it.
      if (!(was && same(mine, was))) merged.set(id, mine);
    } else if (theirs) {
      if (!(was && same(theirs, was))) merged.set(id, theirs);
    }
  }
  return order.filter((id) => merged.has(id)).map((id) => merged.get(id)!);
}

/** Three-way merge of a flat key/value object. Exported for tests. */
export function mergeObjects(base: Record<string, unknown>, local: Record<string, unknown>, remote: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
    const changedLocally = !same(local[key], base[key]);
    const value = changedLocally ? local[key] : remote[key];
    if (value !== undefined && value !== null) result[key] = value;
  }
  return result;
}

function readLocal(ns: Namespace): unknown {
  if (ns.keys) {
    const values: Record<string, string> = {};
    for (const key of ns.keys) {
      try {
        const value = window.localStorage.getItem(key);
        if (value !== null) values[key] = value;
      } catch {
        // Skip unreadable keys.
      }
    }
    return values;
  }
  const value = readJson<unknown>(ns.storageKey!, []);
  return Array.isArray(value) ? value : [];
}

function writeLocal(ns: Namespace, value: unknown) {
  if (ns.keys) {
    const values = value as Record<string, string>;
    for (const key of ns.keys) {
      try {
        if (typeof values[key] === "string") window.localStorage.setItem(key, values[key]);
        else window.localStorage.removeItem(key);
      } catch {
        // Best effort.
      }
    }
  } else {
    writeJson(ns.storageKey!, value);
  }
  try {
    window.dispatchEvent(new Event(ns.event));
  } catch {
    // No window events.
  }
}

async function syncNamespace(ns: Namespace, attempt = 0): Promise<number> {
  const baseRecord = readJson<{ value: unknown; version: number }>(BASE_PREFIX + ns.name, { value: ns.keys ? {} : [], version: 0 });
  const local = readLocal(ns);
  const remote = await Account.readData<unknown>(ns.name);
  let merged: unknown;
  if (ns.keys) {
    merged = mergeObjects(baseRecord.value as Record<string, unknown>, local as Record<string, unknown>, (remote.value as Record<string, unknown>) || {});
  } else {
    const remoteList = Array.isArray(remote.value) ? (remote.value as Item[]) : [];
    // Items without ids (old chat messages) can't be merged one by one; keep this device's list then.
    const allIds = (local as Item[]).every((item) => ns.idOf!(item));
    merged = allIds
      ? mergeLists(baseRecord.value as Item[], local as Item[], remoteList, ns.idOf!, ns.stampOf)
      : local;
    if (ns.limit) merged = (merged as Item[]).slice(ns.name === "chatHistory" ? -ns.limit : 0, ns.name === "chatHistory" ? undefined : ns.limit);
  }
  if (!same(merged, local)) writeLocal(ns, merged);
  let version = remote.version;
  if (!same(merged, remote.value)) {
    try {
      version = (await Account.writeData(ns.name, merged, remote.version)).version;
    } catch (error) {
      if (error instanceof AccountError && error.status === 409 && attempt < 2) return syncNamespace(ns, attempt + 1);
      throw error;
    }
  }
  writeJson(BASE_PREFIX + ns.name, { value: merged, version });
  return Array.isArray(merged) ? merged.length : Object.keys(merged as object).length;
}

let running: Promise<SyncStatus> | null = null;

/** Sync every namespace. Safe to call often; concurrent calls share one run. */
export function syncNow(): Promise<SyncStatus> {
  if (!isAccountSession()) return Promise.resolve({ at: Date.now(), ok: false, message: "Sign in to sync." });
  if (running) return running;
  running = (async () => {
    const counts: Record<string, number> = {};
    let status: SyncStatus;
    try {
      for (const ns of SYNC_NAMESPACES) counts[ns.name] = await syncNamespace(ns);
      status = { at: Date.now(), ok: true, message: "Synced", counts };
    } catch (error) {
      status = { at: Date.now(), ok: false, message: error instanceof Error ? error.message : "Sync failed." };
    }
    writeJson(SYNC_STATUS_KEY, status);
    try {
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {
      // No window events.
    }
    return status;
  })().finally(() => {
    running = null;
  });
  return running;
}

export function lastSyncStatus(): SyncStatus | null {
  return readJson<SyncStatus | null>(SYNC_STATUS_KEY, null);
}

/** Forget sync bases, for example after signing out, so another account starts clean. */
export function resetSyncState() {
  for (const ns of SYNC_NAMESPACES) {
    try {
      window.localStorage.removeItem(BASE_PREFIX + ns.name);
    } catch {
      // Best effort.
    }
  }
  try {
    window.localStorage.removeItem(SYNC_STATUS_KEY);
  } catch {
    // Best effort.
  }
}

/** Sync on start, every 5 minutes while visible, and when the tab is hidden. */
export function startAccountSync() {
  const tick = () => {
    if (isAccountSession() && document.visibilityState === "visible") void syncNow();
  };
  const onHide = () => {
    if (document.visibilityState === "hidden" && isAccountSession()) void syncNow();
  };
  tick();
  const timer = window.setInterval(tick, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", onHide);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onHide);
  };
}
