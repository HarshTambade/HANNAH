/**
 * On-device reminders.
 *
 * Reminders persist in this browser's storage and fire while HANNAH is open:
 * a system notification when the user has allowed it, plus an in-app alert.
 * In the Android and iOS apps each reminder is also handed to the phone as a
 * local notification (NativeReminders.ts), so it arrives with the app closed.
 */

export type Reminder = {
  id: string;
  text: string;
  dueAt: number;
  createdAt: number;
  status: "scheduled" | "fired" | "done" | "cancelled";
  firedAt?: number;
};

const STORAGE_KEY = "hannah.reminders.v1";
export const REMINDER_EVENT = "hannah:reminders";
export const REMINDER_FIRED_EVENT = "hannah:reminder-fired";
const MAX_REMINDERS = 200;
const MAX_TEXT = 300;
const MAX_AHEAD_MS = 366 * 86_400_000;

function read(): Reminder[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Reminder => Boolean(item) && typeof item.id === "string" && typeof item.text === "string" && typeof item.dueAt === "number");
  } catch {
    return [];
  }
}

function write(reminders: Reminder[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders.slice(-MAX_REMINDERS)));
  } catch {
    // Storage may be full or blocked; the in-memory change still dispatches.
  }
  window.dispatchEvent(new Event(REMINDER_EVENT));
}

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Resolve a due time from either minutes from now or an ISO 8601 timestamp. */
export function resolveDueAt(args: { in_minutes?: unknown; due_at?: unknown }, now = Date.now()) {
  const minutes = Number(args.in_minutes);
  if (args.in_minutes !== undefined && args.in_minutes !== null && args.in_minutes !== "") {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("in_minutes must be a positive number.");
    return now + Math.round(minutes * 60_000);
  }
  if (typeof args.due_at === "string" && args.due_at.trim()) {
    const time = Date.parse(args.due_at);
    if (!Number.isFinite(time)) throw new Error("due_at must be an ISO 8601 date and time, for example 2026-11-17T09:00:00+05:30.");
    return time;
  }
  throw new Error("Give either in_minutes or due_at.");
}

export const ReminderService = {
  list() {
    return read().sort((a, b) => a.dueAt - b.dueAt);
  },
  upcoming(now = Date.now()) {
    return this.list().filter((item) => item.status === "scheduled" && item.dueAt > now - 60_000);
  },
  create(text: string, dueAt: number, now = Date.now()) {
    const clean = text.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT);
    if (!clean) throw new Error("A reminder needs some text.");
    if (!Number.isFinite(dueAt) || dueAt < now - 60_000) throw new Error("That time has already passed.");
    if (dueAt > now + MAX_AHEAD_MS) throw new Error("Reminders can be set up to a year ahead.");
    const reminder: Reminder = { id: newId(), text: clean, dueAt, createdAt: now, status: "scheduled" };
    write([...read(), reminder]);
    return reminder;
  },
  update(id: string, patch: Partial<Pick<Reminder, "status" | "firedAt">>) {
    const reminders = read();
    const index = reminders.findIndex((item) => item.id === id);
    if (index < 0) return null;
    reminders[index] = { ...reminders[index], ...patch };
    write(reminders);
    return reminders[index];
  },
  cancel(id: string) {
    return this.update(id, { status: "cancelled" });
  },
  complete(id: string) {
    return this.update(id, { status: "done" });
  },
  /** Mark due reminders as fired and return them. */
  takeDue(now = Date.now()) {
    const reminders = read();
    const due = reminders.filter((item) => item.status === "scheduled" && item.dueAt <= now);
    if (!due.length) return [];
    write(reminders.map((item) => (due.some((d) => d.id === item.id) ? { ...item, status: "fired" as const, firedAt: now } : item)));
    return due;
  },
};

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return "unsupported" as const;
  return Notification.requestPermission();
}

let schedulerTimer: number | undefined;

/** Check for due reminders every 15 seconds while the app is open. */
export function startReminderScheduler() {
  if (schedulerTimer !== undefined || typeof window === "undefined") return () => undefined;
  const tick = () => {
    for (const reminder of ReminderService.takeDue()) {
      window.dispatchEvent(new CustomEvent<Reminder>(REMINDER_FIRED_EVENT, { detail: reminder }));
      if (notificationPermission() === "granted") {
        try {
          new Notification("Reminder from HANNAH", { body: reminder.text, tag: reminder.id });
        } catch {
          // Some WebViews expose Notification but can't construct it; the in-app alert still shows.
        }
      }
    }
  };
  tick();
  schedulerTimer = window.setInterval(tick, 15_000);
  const onVisible = () => { if (document.visibilityState === "visible") tick(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(schedulerTimer);
    schedulerTimer = undefined;
    document.removeEventListener("visibilitychange", onVisible);
  };
}
