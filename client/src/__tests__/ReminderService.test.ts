import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReminderService, resolveDueAt } from "../services/ReminderService";

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

describe("ReminderService", () => {
  const events: string[] = [];
  beforeEach(() => {
    events.length = 0;
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: (event: Event) => { events.push(event.type); return true; } });
  });

  it("resolves relative and absolute due times", () => {
    const now = Date.parse("2026-11-16T10:00:00Z");
    expect(resolveDueAt({ in_minutes: 20 }, now)).toBe(now + 20 * 60_000);
    expect(resolveDueAt({ due_at: "2026-11-17T09:00:00+05:30" }, now)).toBe(Date.parse("2026-11-17T03:30:00Z"));
    expect(() => resolveDueAt({ in_minutes: -5 }, now)).toThrow(/positive/);
    expect(() => resolveDueAt({ due_at: "tomorrow-ish" }, now)).toThrow(/ISO 8601/);
    expect(() => resolveDueAt({}, now)).toThrow(/in_minutes or due_at/);
  });

  it("creates, lists, fires and completes reminders", () => {
    const now = Date.now();
    const soon = ReminderService.create("Call Mum", now + 60_000, now);
    ReminderService.create("Review the PR", now + 3_600_000, now);
    expect(ReminderService.upcoming(now).map((item) => item.text)).toEqual(["Call Mum", "Review the PR"]);
    expect(events).toContain("hannah:reminders");

    expect(ReminderService.takeDue(now + 30_000)).toHaveLength(0);
    const due = ReminderService.takeDue(now + 61_000);
    expect(due.map((item) => item.id)).toEqual([soon.id]);
    // Fired reminders don't fire twice.
    expect(ReminderService.takeDue(now + 120_000)).toHaveLength(0);
    expect(ReminderService.complete(soon.id)?.status).toBe("done");
  });

  it("rejects past, empty and far-future reminders", () => {
    const now = Date.now();
    expect(() => ReminderService.create("Too late", now - 3_600_000, now)).toThrow(/passed/);
    expect(() => ReminderService.create("   ", now + 60_000, now)).toThrow(/text/);
    expect(() => ReminderService.create("Someday", now + 400 * 86_400_000, now)).toThrow(/year/);
  });

  it("cancels a reminder so it never fires", () => {
    const now = Date.now();
    const reminder = ReminderService.create("Stretch", now + 60_000, now);
    ReminderService.cancel(reminder.id);
    expect(ReminderService.takeDue(now + 120_000)).toHaveLength(0);
    expect(ReminderService.upcoming(now)).toHaveLength(0);
  });
});
