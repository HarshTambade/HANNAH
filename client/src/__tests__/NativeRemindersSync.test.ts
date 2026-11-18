import { afterEach, describe, expect, it, vi } from "vitest";

// The phone side of reminders on Android, with the plugin replaced by a recorder.
const plugin = vi.hoisted(() => ({
  pending: [] as Array<{ id: number }>,
  scheduled: [] as Array<Record<string, unknown>>,
  exact: "denied" as "granted" | "denied",
  hang: false,
  display: "granted" as "granted" | "denied",
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true, getPlatform: () => "android" } }));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    getPending: async () => ({ notifications: plugin.pending }),
    cancel: async () => undefined,
    checkPermissions: async () => ({ display: plugin.display }),
    requestPermissions: async () => ({ display: plugin.display }),
    checkExactNotificationSetting: async () => ({ exact_alarm: plugin.exact }),
    changeExactNotificationSetting: async () => ({ exact_alarm: plugin.exact }),
    schedule: (options: { notifications: Array<Record<string, unknown>> }) => (plugin.hang ? new Promise(() => undefined) : Promise.resolve().then(() => { plugin.scheduled.push(...options.notifications); plugin.pending.push(...options.notifications.map((item) => ({ id: Number(item.id) }))); return {}; })),
  },
}));

// A window with storage and real events (the sync listens for reminder changes).
const store = new Map<string, string>();
vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } } }));

const { startNativeReminders, nativeReminderStatus, withTimeout } = await import("../services/NativeReminders");
const { ReminderService } = await import("../services/ReminderService");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => { vi.useRealTimers(); });

describe("reminders on the phone", () => {
  it("without Android's exact-alarm permission, schedules inexact alarms instead of opening the settings screen; the status says so", async () => {
    const stop = startNativeReminders();
    ReminderService.create("Call Mum", Date.now() + 3_600_000);
    await settle();
    expect(plugin.scheduled.at(-1)).toMatchObject({ body: "Call Mum", isExactNotification: false });
    expect(nativeReminderStatus()).toMatchObject({ native: true, notifications: "granted", exactAlarms: "denied", scheduled: 1, error: null });
    plugin.exact = "granted";
    ReminderService.create("Gym", Date.now() + 7_200_000);
    await settle();
    expect(plugin.scheduled.at(-1)).toMatchObject({ body: "Gym", isExactNotification: true });
    stop();
  });

  it("a sync that never answers is given up, so later reminders still reach the phone", async () => {
    await expect(withTimeout(new Promise(() => undefined), 30)).rejects.toThrow(/didn't finish/);
  });
});
