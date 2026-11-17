/**
 * Durable task runs in your account (brief Phase 4).
 *
 * When you're signed in, a device running a long task (an agent team run)
 * saves a checkpoint to your account after every change: the plan and each
 * step's status and result. While it works it holds a short lease, renewed
 * every 30 seconds, so no other device runs the same task at the same time.
 *
 * - Pause it, close the app, or lose the device: any of your signed-in devices
 *   can claim the task and continue from the last checkpoint. Finished steps
 *   aren't run again.
 * - Cancel it from another device: this device stops at its next checkpoint or
 *   heartbeat.
 * - Offline: the latest checkpoint waits here and goes out with the next one.
 *   A retried write keeps its id, so the server applies it once.
 *
 * Nothing leaves the device when you're signed out, or after you turn off
 * "Across your devices". The server stores the record; the work never runs
 * there.
 */
import { AccountError, accountRequest } from "./Account";
import { DeviceTasks, thisDevice } from "./DeviceTasks";

export type RunStatus = "queued" | "running" | "waiting-approval" | "paused" | "failed" | "completed" | "cancelled";
export type RemoteRun = {
  id: string;
  kind: string;
  title: string;
  status: RunStatus;
  version: number;
  record: unknown;
  lease: { deviceId: string; deviceName: string; expiresAt: number } | null;
  lastDevice: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};
/** Why this device must stop working on a run. */
export type LostReason = "cancelled" | "lease-held" | "lease-lost" | "stale" | "final" | "not-found";
type Checkpoint = { kind: string; title: string; status: RunStatus; record: unknown };
type Write = Checkpoint & { writeId: string };
type State = {
  version: number | null;
  pending: Checkpoint | null;
  /** Sent but not confirmed (offline, or the response was lost). Resent with the same id. */
  unsent: Write | null;
  flushing: Promise<void> | null;
  lost: boolean;
  disabled: boolean;
  onLost?: (message: string, reason: LostReason) => void;
  heartbeat?: ReturnType<typeof setInterval>;
};

const VERSIONS_KEY = "hannah.taskRuns.versions.v1";
export const HEARTBEAT_MS = 30_000;
const states = new Map<string, State>();
const LOST_REASONS = new Set<string>(["cancelled", "lease-held", "lease-lost", "stale", "final", "not-found"]);

function readVersions(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(VERSIONS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch {
    return {};
  }
}

function writeVersion(id: string, version: number | null) {
  try {
    const versions = readVersions();
    if (version === null) delete versions[id];
    else versions[id] = version;
    const entries = Object.entries(versions).slice(-50);
    window.localStorage.setItem(VERSIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable: versions are kept in memory for this session.
  }
}

function stateOf(id: string): State {
  let state = states.get(id);
  if (!state) {
    const saved = readVersions()[id];
    state = { version: Number.isInteger(saved) ? saved : null, pending: null, unsent: null, flushing: null, lost: false, disabled: false };
    states.set(id, state);
  }
  return state;
}

function setVersion(id: string, version: number) {
  stateOf(id).version = version;
  writeVersion(id, version);
}

const path = (id: string, suffix = "") => `/api/account/runs/${encodeURIComponent(id)}${suffix}`;
const deviceBody = () => {
  const device = thisDevice();
  return { deviceId: device.id, deviceName: device.name };
};
const isConflict = (error: unknown): error is AccountError => error instanceof AccountError && (error.status === 409 || error.status === 404);
const reasonOf = (error: AccountError): LostReason => (LOST_REASONS.has(error.reason ?? "") ? error.reason as LostReason : error.status === 404 ? "not-found" : "stale");

function lose(id: string, error: AccountError) {
  const state = stateOf(id);
  if (state.lost) return;
  state.lost = true;
  state.pending = null;
  state.unsent = null;
  if (state.heartbeat !== undefined) clearInterval(state.heartbeat);
  state.heartbeat = undefined;
  try {
    state.onLost?.(error.message, reasonOf(error));
  } catch {
    // The run's own handler failed; nothing more to do here.
  }
}

async function flush(id: string) {
  const state = stateOf(id);
  while (!state.lost && !state.disabled && (state.unsent || state.pending)) {
    const write: Write = state.unsent ?? { ...state.pending!, writeId: `w-${crypto.randomUUID()}` };
    if (!state.unsent) state.pending = null;
    state.unsent = write;
    try {
      const { run } = await accountRequest<{ run: RemoteRun }>(path(id), {
        method: "PUT",
        body: JSON.stringify({ ...deviceBody(), ...write, baseVersion: state.version }),
      });
      state.unsent = null;
      setVersion(id, run.version);
    } catch (error) {
      if (isConflict(error)) {
        lose(id, error);
      } else if (error instanceof AccountError && (error.status === 400 || error.status === 413)) {
        // The server won't take this record; keep the run going on this device only.
        state.unsent = null;
        state.pending = null;
        state.disabled = true;
      }
      // Offline or a server error: keep the write for the next checkpoint.
      return;
    }
  }
}

export const TaskRecords = {
  /** On when signed in, unless "Across your devices" is turned off on this device. */
  enabled() {
    return DeviceTasks.enabled();
  },

  knownVersion(id: string): number | null {
    return stateOf(id).version;
  },
  rememberVersion(id: string, version: number) {
    setVersion(id, version);
  },

  /** This device is about to work on the run: watch for cancellation and keep the lease alive. */
  attach(id: string, onLost: (message: string, reason: LostReason) => void) {
    const state = stateOf(id);
    state.lost = false;
    state.disabled = false;
    state.onLost = onLost;
    if (state.heartbeat !== undefined) clearInterval(state.heartbeat);
    state.heartbeat = setInterval(() => {
      if (state.version === null || state.lost || !this.enabled()) return;
      accountRequest(path(id, "/heartbeat"), { method: "POST", body: JSON.stringify(deviceBody()) }).catch((error: unknown) => {
        if (isConflict(error)) lose(id, error);
      });
    }, HEARTBEAT_MS);
  },

  detach(id: string) {
    const state = stateOf(id);
    if (state.heartbeat !== undefined) clearInterval(state.heartbeat);
    state.heartbeat = undefined;
    state.onLost = undefined;
  },

  /**
   * Create a run that must happen once across your devices (a scheduled
   * automation): the first device to create it runs it. "exists" means another
   * device already has it; "unavailable" means the server couldn't be reached,
   * so the caller decides whether to go ahead on this device alone.
   */
  async create(id: string, checkpoint: Checkpoint): Promise<{ outcome: "created" } | { outcome: "exists"; run: RemoteRun | null } | { outcome: "unavailable" }> {
    if (!this.enabled()) return { outcome: "unavailable" };
    const state = stateOf(id);
    try {
      const { run } = await accountRequest<{ run: RemoteRun }>(path(id), {
        method: "PUT",
        body: JSON.stringify({ ...deviceBody(), ...checkpoint, writeId: `w-${crypto.randomUUID()}`, baseVersion: null }),
      });
      setVersion(id, run.version);
      state.lost = false;
      return { outcome: "created" };
    } catch (error) {
      if (isConflict(error)) return { outcome: "exists", run: (error.body?.run as RemoteRun | undefined) ?? null };
      return { outcome: "unavailable" };
    }
  },

  /** Save the run's latest state. Only the newest waiting checkpoint is sent. */
  checkpoint(id: string, checkpoint: Checkpoint) {
    const state = stateOf(id);
    if (!this.enabled() || !state.onLost || state.lost || state.disabled) return Promise.resolve();
    state.pending = checkpoint;
    state.flushing ??= flush(id).finally(() => { state.flushing = null; });
    return state.flushing;
  },

  /** Wait for checkpoints already queued: the executor confirms one before starting more steps. */
  async settled(id: string) {
    while (states.get(id)?.flushing) await states.get(id)!.flushing;
  },

  /** Send checkpoints that couldn't go out earlier (made offline, or the server was down). */
  async retryPending() {
    if (!this.enabled()) return;
    await Promise.all([...states.entries()].map(([id, state]) => {
      if (state.lost || state.disabled || (!state.unsent && !state.pending)) return state.flushing;
      state.flushing ??= flush(id).finally(() => { state.flushing = null; });
      return state.flushing;
    }));
  },

  /**
   * Take over a run to continue it here. Returns the server's copy, or null
   * when the server doesn't have it (never saved, or saved while signed out).
   * Throws an AccountError when another device is working on it or it's final.
   */
  async claim(id: string): Promise<RemoteRun | null> {
    try {
      const { run } = await accountRequest<{ run: RemoteRun }>(path(id, "/claim"), { method: "POST", body: JSON.stringify(deviceBody()) });
      setVersion(id, run.version);
      return run;
    } catch (error) {
      if (error instanceof AccountError && error.status === 404) return null;
      throw error;
    }
  },

  async list(): Promise<RemoteRun[]> {
    const { runs } = await accountRequest<{ runs: RemoteRun[] }>("/api/account/runs");
    return Array.isArray(runs) ? runs : [];
  },

  /** Stop a run from this device, wherever it's running. Final. */
  async cancel(id: string) {
    const { run } = await accountRequest<{ run: RemoteRun }>(path(id, "/cancel"), { method: "POST", body: JSON.stringify(deviceBody()) });
    setVersion(id, run.version);
    return run;
  },

  async remove(id: string) {
    await accountRequest(`${path(id)}?deviceId=${encodeURIComponent(thisDevice().id)}`, { method: "DELETE" });
    states.delete(id);
    writeVersion(id, null);
  },
};
