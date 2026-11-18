/**
 * Background reminder notifications on Android and iOS.
 *
 * The web app can only alert while it's open. In the native apps, every
 * scheduled reminder is also handed to the operating system as a local
 * notification, so it arrives even when HANNAH is closed. This keeps the OS
 * schedule in step with the reminder list (including reminders that arrive by
 * sync), and cancels notifications for reminders that were done or cancelled.
 */
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { REMINDER_EVENT, ReminderService, type Reminder } from "./ReminderService";

/** A stable positive 31-bit id for a reminder, as the plugin requires. Exported for tests. */
export function notificationId(reminderId: string) {
  let hash = 0;
  for (let index = 0; index < reminderId.length; index += 1) hash = (Math.imul(31, hash) + reminderId.charCodeAt(index)) | 0;
  return (hash & 0x7fffffff) || 1;
}

/** Which notifications to add and remove so the OS matches the reminders. Exported for tests. */
export function planNotifications(reminders: Reminder[], pendingIds: number[], now = Date.now()) {
  const wanted = new Map(reminders.filter((item) => item.status === "scheduled" && item.dueAt > now).map((item) => [notificationId(item.id), item]));
  const pending = new Set(pendingIds);
  return {
    schedule: [...wanted.entries()].filter(([id]) => !pending.has(id)).map(([id, item]) => ({ id, item })),
    cancel: pendingIds.filter((id) => !wanted.has(id)),
  };
}

let permission: "granted" | "denied" | "unknown" = "unknown";

async function ensurePermission() {
  if (permission !== "unknown") return permission === "granted";
  try {
    const current = await LocalNotifications.checkPermissions();
    const state = current.display === "granted" ? current : await LocalNotifications.requestPermissions();
    permission = state.display === "granted" ? "granted" : "denied";
  } catch {
    permission = "denied";
  }
  return permission === "granted";
}

let syncing: Promise<void> | null = null;

/** What the last sync did, for Settings and the reminders list. */
export type NativeReminderStatus = {
  native: boolean;
  notifications: "granted" | "denied" | "unknown";
  /** Android 12+: exact alarms ("Alarms & reminders"). Without them a reminder can arrive a few minutes late. */
  exactAlarms: "granted" | "denied" | "not-needed" | "unknown";
  scheduled: number;
  lastSyncAt: number | null;
  error: string | null;
};
let status: NativeReminderStatus = { native: false, notifications: "unknown", exactAlarms: "unknown", scheduled: 0, lastSyncAt: null, error: null };
export const NATIVE_REMINDER_STATUS_EVENT = "hannah:native-reminders";
export function nativeReminderStatus() { return status; }
function setStatus(patch: Partial<NativeReminderStatus>) {
  status = { ...status, ...patch };
  window.dispatchEvent(new Event(NATIVE_REMINDER_STATUS_EVENT));
}

/**
 * Android 12+ asks before an app may set exact alarms (Android 14 says no by
 * default). Asking the plugin for an exact alarm without that permission makes
 * it open the "Alarms & reminders" settings screen and wait, on every sync, so
 * check first and use an inexact alarm (delivered, maybe a few minutes late) instead.
 */
async function exactAlarms(): Promise<NativeReminderStatus["exactAlarms"]> {
  if (Capacitor.getPlatform() !== "android") return "not-needed";
  try {
    const { exact_alarm: state } = await LocalNotifications.checkExactNotificationSetting();
    return state === "granted" ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

/** One sync can't hold up the next: a plugin call that never answers is given up after this. */
export const SYNC_TIMEOUT_MS = 30_000;
export function withTimeout<T>(work: Promise<T>, ms = SYNC_TIMEOUT_MS) {
  return Promise.race([work, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`The reminder sync didn't finish within ${Math.round(ms / 1000)} seconds.`)), ms))]);
}

async function reconcile() {
  const reminders = ReminderService.list();
  const { notifications } = await LocalNotifications.getPending();
  const plan = planNotifications(reminders, notifications.map((item) => item.id));
  if (plan.cancel.length) await LocalNotifications.cancel({ notifications: plan.cancel.map((id) => ({ id })) });
  let scheduled = notifications.length - plan.cancel.length;
  const exact = await exactAlarms();
  if (plan.schedule.length && await ensurePermission()) {
    await LocalNotifications.schedule({
      notifications: plan.schedule.map(({ id, item }) => ({
        id,
        title: "Reminder from HANNAH",
        body: item.text,
        schedule: { at: new Date(item.dueAt), allowWhileIdle: true },
        // Exact only when Android allows it; otherwise inexact instead of a settings screen on every sync.
        isExactNotification: exact !== "denied",
        extra: { reminderId: item.id },
      })),
    });
    scheduled += plan.schedule.length;
  }
  setStatus({ native: true, notifications: permission, exactAlarms: exact, scheduled: Math.max(0, scheduled), lastSyncAt: Date.now(), error: null });
}

/** Ask Android for exact alarms (opens its "Alarms & reminders" screen), then sync again. */
export async function allowExactAlarms() {
  if (Capacitor.getPlatform() !== "android") return;
  await LocalNotifications.changeExactNotificationSetting();
  setStatus({ exactAlarms: await exactAlarms() });
  window.dispatchEvent(new Event(REMINDER_EVENT));
}

/** Ask for notification permission again (from the reminders list), then sync. */
export async function allowReminderNotifications() {
  permission = "unknown";
  const granted = await ensurePermission();
  setStatus({ notifications: granted ? "granted" : "denied" });
  window.dispatchEvent(new Event(REMINDER_EVENT));
  return granted;
}

/** Start keeping OS notifications in step with reminders. No-op on the web and desktop. */
export function startNativeReminders() {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("LocalNotifications")) return () => undefined;
  setStatus({ native: true });
  const run = () => {
    syncing = (syncing ?? Promise.resolve()).then(() => withTimeout(reconcile())).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ error: message, lastSyncAt: Date.now() });
      console.warn("Native reminder sync failed", message);
    });
  };
  run();
  window.addEventListener(REMINDER_EVENT, run);
  return () => window.removeEventListener(REMINDER_EVENT, run);
}
