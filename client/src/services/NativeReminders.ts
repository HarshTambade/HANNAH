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

async function reconcile() {
  const reminders = ReminderService.list();
  const { notifications } = await LocalNotifications.getPending();
  const plan = planNotifications(reminders, notifications.map((item) => item.id));
  if (plan.cancel.length) await LocalNotifications.cancel({ notifications: plan.cancel.map((id) => ({ id })) });
  if (plan.schedule.length && await ensurePermission()) {
    await LocalNotifications.schedule({
      notifications: plan.schedule.map(({ id, item }) => ({
        id,
        title: "Reminder from HANNAH",
        body: item.text,
        schedule: { at: new Date(item.dueAt), allowWhileIdle: true },
        extra: { reminderId: item.id },
      })),
    });
  }
}

/** Start keeping OS notifications in step with reminders. No-op on the web and desktop. */
export function startNativeReminders() {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("LocalNotifications")) return () => undefined;
  const run = () => {
    syncing = (syncing ?? Promise.resolve()).then(reconcile).catch((error) => console.warn("Native reminder sync failed", error instanceof Error ? error.message : error));
  };
  run();
  window.addEventListener(REMINDER_EVENT, run);
  return () => window.removeEventListener(REMINDER_EVENT, run);
}
