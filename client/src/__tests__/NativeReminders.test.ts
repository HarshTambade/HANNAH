import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => false } }));
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: {} }));

const { notificationId, planNotifications } = await import("../services/NativeReminders");

const reminder = (id: string, dueAt: number, status: "scheduled" | "done" | "cancelled" | "fired" = "scheduled") => ({ id, text: id, dueAt, createdAt: 0, status });

describe("native reminder notifications", () => {
  it("derives stable positive ids", () => {
    expect(notificationId("abc")).toBe(notificationId("abc"));
    expect(notificationId("abc")).not.toBe(notificationId("abd"));
    expect(notificationId("x".repeat(500))).toBeGreaterThan(0);
  });

  it("schedules future reminders once and cancels finished ones", () => {
    const now = 1_000;
    const keep = reminder("keep", 5_000);
    const add = reminder("add", 6_000);
    const done = reminder("done", 7_000, "done");
    const past = reminder("past", 500);
    const plan = planNotifications([keep, add, done, past], [notificationId("keep"), notificationId("done")], now);
    expect(plan.schedule.map((item) => item.item.id)).toEqual(["add"]);
    expect(plan.cancel).toEqual([notificationId("done")]);
  });
});
