/**
 * Diagnostics: what went wrong on this device, kept here for you to read,
 * search and export.
 *
 * Captures crashes (the error boundary), uncaught errors and rejected
 * promises, a start that didn't finish last time, interface freezes (long
 * tasks), failed server connections, agent and automation failures, sync
 * failures and native plugin failures, as short entries (the last 300).
 *
 * Every entry goes through the same redaction as error telemetry: keys,
 * tokens, URLs' query strings and file paths are removed before storing. A
 * diagnostic export holds these entries plus the app version, platform and
 * counts; never your conversation, memories, keys or account.
 */
import { detectPlatform, getAppVersion } from "./appInfo";
import { redactSensitiveText } from "./telemetry";

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticSource = "crash" | "error" | "startup" | "ui" | "network" | "agent" | "automation" | "sync" | "native" | "memory" | "app";
export type DiagnosticEntry = { id: string; at: number; level: DiagnosticLevel; source: DiagnosticSource; message: string; detail?: string };
export type DiagnosticReport = {
  format: "hannah-diagnostics";
  version: 1;
  createdAt: string;
  app: string;
  platform: string;
  userAgent: string;
  online: boolean;
  startedAt: number | null;
  memory: { usedMB: number; limitMB: number } | null;
  storage: { keys: number; approxKB: number };
  counts: Record<DiagnosticLevel, number>;
  entries: DiagnosticEntry[];
};

const KEY = "hannah.diagnostics.v1";
const BOOT_KEY = "hannah.diagnostics.boot.v1";
const MAX_ENTRIES = 300;
const LONG_TASK_MS = 1_000;
const HEAP_WARN_MB = 1_024;
export const DIAGNOSTICS_EVENT = "hannah:diagnostics";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(): DiagnosticEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is DiagnosticEntry => Boolean(item && typeof item === "object" && typeof (item as DiagnosticEntry).message === "string")) : [];
  } catch {
    return [];
  }
}

function write(entries: DiagnosticEntry[]) {
  try {
    storage()?.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Storage full or blocked: keep going without a record.
  }
  try {
    window.dispatchEvent(new Event(DIAGNOSTICS_EVENT));
  } catch {
    // No window events.
  }
}

const clean = (value: unknown, max: number) => redactSensitiveText(String(value ?? "").replace(/\s+/g, " ").trim(), max);

/** A short, redacted description of an error or rejection reason. */
export function describeError(error: unknown): { message: string; detail?: string } {
  if (error instanceof Error) {
    const detail = error.stack?.split("\n").slice(0, 6).join("\n");
    return { message: clean(`${error.name}: ${error.message}`, 300), ...(detail ? { detail: redactSensitiveText(detail, 1200) } : {}) };
  }
  return { message: clean(typeof error === "string" ? error : JSON.stringify(error), 300) || "Unknown error" };
}

let installed = false;
let startedAt: number | null = null;
let lastLongTaskAt = 0;

export const Diagnostics = {
  log(level: DiagnosticLevel, source: DiagnosticSource, message: string, detail?: string) {
    const entry: DiagnosticEntry = { id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), level, source, message: clean(message, 300) || "(no message)", ...(detail ? { detail: clean(detail, 1200) } : {}) };
    const entries = read();
    // The same message repeating (a retry loop) becomes one entry with a count, not 300.
    const last = entries[entries.length - 1];
    if (last && last.level === level && last.source === source && last.message.replace(/ \(×\d+\)$/, "") === entry.message && entry.at - last.at < 60_000) {
      const count = Number(/ \(×(\d+)\)$/.exec(last.message)?.[1] ?? 1) + 1;
      last.message = `${entry.message} (×${count})`;
      last.at = entry.at;
      write(entries);
      return last;
    }
    entries.push(entry);
    write(entries);
    return entry;
  },

  error(source: DiagnosticSource, error: unknown, context?: string) {
    const described = describeError(error);
    return this.log("error", source, context ? `${context}: ${described.message}` : described.message, described.detail);
  },

  list(options: { query?: string; level?: DiagnosticLevel | "all" } = {}): DiagnosticEntry[] {
    const words = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return read()
      .filter((entry) => (options.level && options.level !== "all" ? entry.level === options.level : true))
      .filter((entry) => words.every((word) => `${entry.source} ${entry.message} ${entry.detail ?? ""}`.toLowerCase().includes(word)))
      .reverse();
  },

  counts(): Record<DiagnosticLevel, number> {
    const counts = { info: 0, warn: 0, error: 0 };
    for (const entry of read()) counts[entry.level] += 1;
    return counts;
  },

  clear() {
    write([]);
  },

  /** Hook the browser's error events and the long-task observer. Call once at startup. */
  install() {
    if (installed || typeof window === "undefined") return;
    installed = true;
    startedAt = Date.now();
    // A start that never reached "ready" last time (crash before the first screen, or a hang).
    try {
      const previous = JSON.parse(storage()?.getItem(BOOT_KEY) || "null") as { startedAt?: number; ready?: boolean; app?: string } | null;
      if (previous && previous.startedAt && !previous.ready) this.log("warn", "startup", `HANNAH didn't finish starting last time (${previous.app ?? "unknown version"}, ${new Date(previous.startedAt).toLocaleString()}).`);
      storage()?.setItem(BOOT_KEY, JSON.stringify({ startedAt, ready: false, app: getAppVersion() }));
    } catch {
      // No storage.
    }
    window.addEventListener("error", (event) => {
      const error = event.error ?? event.message;
      const described = describeError(error);
      this.log("error", "error", described.message, described.detail ?? (event.filename ? redactSensitiveText(`${event.filename}:${event.lineno}:${event.colno}`, 300) : undefined));
    });
    window.addEventListener("unhandledrejection", (event) => { this.error("error", event.reason, "Unhandled promise rejection"); });
    try {
      const Observer = (window as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
      if (Observer) {
        const observer = new Observer((list) => {
          for (const task of list.getEntries()) {
            if (task.duration < LONG_TASK_MS || Date.now() - lastLongTaskAt < 10_000) continue;
            lastLongTaskAt = Date.now();
            this.log("warn", "ui", `The interface froze for ${(task.duration / 1000).toFixed(1)} s.`);
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      }
    } catch {
      // Long tasks aren't observable here.
    }
    window.setInterval(() => {
      const heap = heapMB();
      if (heap && heap.usedMB > HEAP_WARN_MB) this.log("warn", "memory", `HANNAH is using ${heap.usedMB} MB of memory (limit ${heap.limitMB} MB).`);
    }, 5 * 60_000);
  },

  /** The first screen has drawn: this start finished. */
  markReady() {
    try {
      const current = JSON.parse(storage()?.getItem(BOOT_KEY) || "null") as Record<string, unknown> | null;
      storage()?.setItem(BOOT_KEY, JSON.stringify({ ...(current ?? { startedAt }), ready: true, readyAfterMs: startedAt ? Date.now() - startedAt : null }));
    } catch {
      // No storage.
    }
  },

  /** A report for support or a bug report. Holds no conversation, memory, key or account data. */
  report(): DiagnosticReport {
    const store = storage();
    let keys = 0;
    let bytes = 0;
    if (store) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (!key) continue;
        keys += 1;
        bytes += (store.getItem(key)?.length ?? 0) * 2;
      }
    }
    return {
      format: "hannah-diagnostics",
      version: 1,
      createdAt: new Date().toISOString(),
      app: getAppVersion(),
      platform: detectPlatform(),
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent.slice(0, 300),
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      startedAt,
      memory: heapMB(),
      storage: { keys, approxKB: Math.round(bytes / 1024) },
      counts: this.counts(),
      entries: read().slice(-100),
    };
  },
};

function heapMB() {
  const memory = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!memory) return null;
  return { usedMB: Math.round(memory.usedJSHeapSize / 1_048_576), limitMB: Math.round(memory.jsHeapSizeLimit / 1_048_576) };
}
