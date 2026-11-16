/**
 * Tasks across devices.
 *
 * When you're signed in, this device reports the longer tasks it runs (agent
 * team runs, automations) to your account, and mirrors every approval it asks
 * for. Your other signed-in devices see them and can approve or deny from
 * there; the first answer wins (the server decides atomically). The work
 * itself keeps running on the device that started it.
 *
 * Nothing is shared when you're signed out, or after you turn it off in
 * Dashboard → Across your devices.
 */
import { Capacitor } from "@capacitor/core";
import { accountRequest } from "./Account";
import { getAccountHint } from "./api";

export type DeviceTaskStatus = "running" | "done" | "failed" | "stopped" | "needs-attention" | "waiting" | "approved" | "denied" | "expired" | "cancelled";
export type DeviceTask = {
  id: string;
  kind: "task" | "approval";
  title: string;
  detail: string;
  status: DeviceTaskStatus;
  device: { id: string; name: string };
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  decidedAt: number | null;
  decidedBy: string | null;
};

export const DEVICE_TASKS_EVENT = "hannah:device-tasks";
const DEVICE_KEY = "hannah.device.v1";
const ENABLED_KEY = "hannah.deviceTasks.enabled";
const POLL_MS = 3_000;

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** A readable default name, such as "Chrome on macOS" or "Android phone". Exported for tests. */
export function defaultDeviceName(platform = Capacitor.getPlatform(), userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent) {
  const os = /Android/i.test(userAgent) ? "Android" : /iPhone|iPad|iPod/i.test(userAgent) ? "iOS" : /Mac OS X|Macintosh/i.test(userAgent) ? "macOS" : /Windows/i.test(userAgent) ? "Windows" : /Linux/i.test(userAgent) ? "Linux" : "";
  if (platform === "android") return "Android phone";
  if (platform === "ios") return "iPhone";
  if (platform === "electron") return os ? `Desktop app on ${os}` : "Desktop app";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}

export function thisDevice(): { id: string; name: string } {
  const store = storage();
  try {
    const saved = JSON.parse(store?.getItem(DEVICE_KEY) || "null");
    if (saved && typeof saved.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(saved.id) && typeof saved.name === "string") return saved;
  } catch {
    // Make a new identity below.
  }
  const device = { id: `dev-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, name: defaultDeviceName() };
  store?.setItem(DEVICE_KEY, JSON.stringify(device));
  return device;
}

let tasks: DeviceTask[] = [];
let lastError = "";

function publish() {
  try {
    window.dispatchEvent(new Event(DEVICE_TASKS_EVENT));
  } catch {
    // No window (tests).
  }
}

const deviceBody = () => {
  const device = thisDevice();
  return { deviceId: device.id, deviceName: device.name };
};

/** Last reported state per task, so repeated saves don't spam the server. */
const reported = new Map<string, { key: string; at: number }>();

export type RemoteApproval = {
  id: string;
  /** Resolves when another device answers, the request expires or is withdrawn, or `signal` aborts. */
  wait: (signal?: AbortSignal) => Promise<{ status: DeviceTaskStatus; decidedBy: string | null }>;
  /** This device answered: tell the others so their card closes. */
  answeredHere: (approve: boolean) => Promise<void>;
  withdraw: () => Promise<void>;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export const DeviceTasks = {
  /** On when signed in, unless turned off on this device. */
  enabled() {
    return Boolean(getAccountHint()) && storage()?.getItem(ENABLED_KEY) !== "off";
  },
  setEnabled(on: boolean) {
    storage()?.setItem(ENABLED_KEY, on ? "on" : "off");
    if (!on) tasks = [];
    publish();
  },
  device: thisDevice,
  rename(name: string) {
    const device = { ...thisDevice(), name: name.replace(/[\r\n]+/g, " ").trim().slice(0, 60) || defaultDeviceName() };
    storage()?.setItem(DEVICE_KEY, JSON.stringify(device));
    publish();
    return device;
  },
  snapshot() {
    return { tasks, error: lastError };
  },

  async refresh() {
    if (!this.enabled()) {
      tasks = [];
      publish();
      return tasks;
    }
    try {
      const result = await accountRequest<{ tasks: DeviceTask[] }>("/api/account/tasks");
      tasks = Array.isArray(result.tasks) ? result.tasks : [];
      lastError = "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    publish();
    return tasks;
  },

  /** Create or update a task this device runs. Best effort; never throws. */
  report(task: { id: string; title: string; status: Extract<DeviceTaskStatus, "running" | "done" | "failed" | "stopped" | "needs-attention">; detail?: string }) {
    if (!this.enabled()) return;
    const id = task.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    if (id.length < 8) return;
    const key = `${task.status}|${task.detail ?? ""}`;
    const previous = reported.get(id);
    const now = Date.now();
    // Status changes always go out; progress text at most every 5 seconds.
    if (previous && (previous.key === key || (previous.key.split("|")[0] === task.status && now - previous.at < 5_000))) return;
    reported.set(id, { key, at: now });
    if (reported.size > 200) reported.delete(reported.keys().next().value!);
    void accountRequest(`/api/account/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...deviceBody(), kind: "task", title: task.title.slice(0, 140), status: task.status, detail: (task.detail ?? "").slice(0, 2000) }),
    }).then(() => this.refresh()).catch(() => reported.delete(id));
  },

  /** Mirror an approval this device is asking for. Null when signed out or it couldn't be shared. */
  async requestApproval(request: { id: string; title: string; detail: string; expiresInMs?: number }): Promise<RemoteApproval | null> {
    if (!this.enabled()) return null;
    const id = request.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    if (id.length < 8) return null;
    try {
      await accountRequest(`/api/account/tasks/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...deviceBody(), kind: "approval", title: request.title.slice(0, 140), detail: request.detail.slice(0, 2000), expiresInMs: request.expiresInMs }),
      });
    } catch {
      return null;
    }
    void this.refresh();
    let settled = false;
    return {
      id,
      wait: async (signal) => {
        while (!signal?.aborted && !settled) {
          await sleep(POLL_MS, signal);
          if (signal?.aborted || settled) break;
          try {
            const { task } = await accountRequest<{ task: DeviceTask }>(`/api/account/tasks/${id}`);
            if (task.status !== "waiting") {
              settled = true;
              void this.refresh();
              return { status: task.status, decidedBy: task.decidedBy };
            }
          } catch {
            // Offline for a moment: keep waiting; the local card still works.
          }
        }
        return { status: "cancelled" as const, decidedBy: null };
      },
      answeredHere: async (approve) => {
        if (settled) return;
        settled = true;
        await this.decide(id, approve).catch(() => undefined);
      },
      withdraw: async () => {
        if (settled) return;
        settled = true;
        await accountRequest(`/api/account/tasks/${id}`, { method: "PUT", body: JSON.stringify({ ...deviceBody(), kind: "approval", status: "cancelled" }) }).catch(() => undefined);
        void this.refresh();
      },
    };
  },

  /** Approve or deny a request from any of your devices. Throws with the reason when someone answered first. */
  async decide(id: string, approve: boolean) {
    try {
      const result = await accountRequest<{ task: DeviceTask }>(`/api/account/tasks/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ ...deviceBody(), approve }) });
      return result.task;
    } finally {
      void this.refresh();
    }
  },

  /** One task's current state, or null when it's gone or unreachable. */
  async status(id: string): Promise<DeviceTask | null> {
    if (!this.enabled()) return null;
    try {
      return (await accountRequest<{ task: DeviceTask }>(`/api/account/tasks/${encodeURIComponent(id)}`)).task;
    } catch {
      return null;
    }
  },

  async remove(id: string) {
    await accountRequest(`/api/account/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    await this.refresh();
  },
};

let syncTimer: number | undefined;

/** Keep the list fresh while HANNAH is open: every 8 seconds when visible, at once when it comes back. */
export function startDeviceTaskSync() {
  if (syncTimer !== undefined || typeof window === "undefined") return () => undefined;
  const tick = () => {
    if (document.visibilityState === "visible" && DeviceTasks.enabled()) void DeviceTasks.refresh();
  };
  tick();
  syncTimer = window.setInterval(tick, 8_000);
  const onVisible = () => tick();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("hannah:account", onVisible);
  return () => {
    window.clearInterval(syncTimer);
    syncTimer = undefined;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("hannah:account", onVisible);
  };
}
