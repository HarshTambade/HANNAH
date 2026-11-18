import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" } }));
const stub = () => vi.stubGlobal("window", new EventTarget());
stub();
const { checkSiriLaunch, WAKE_EVENT, WakeWord } = await import("../services/WakeWord");

function preferences(value: string | null) {
  const store = new Map<string, string>(value === null ? [] : [["hannah.voiceLaunch", value]]);
  return { store, get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }), remove: async ({ key }: { key: string }) => { store.delete(key); } };
}

describe("Talk to HANNAH from Siri", () => {
  beforeEach(stub);
  it("a fresh Siri launch opens one voice turn, through the same event as the wake word", async () => {
    const heard = vi.fn();
    window.addEventListener(WAKE_EVENT, heard);
    const prefs = preferences(String(1_000_000));
    expect(await checkSiriLaunch({ now: 1_030_000, preferences: prefs })).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(WakeWord.consumePendingWake()).toBe(true);
    expect(prefs.store.size).toBe(0);
    expect(await checkSiriLaunch({ now: 1_031_000, preferences: prefs })).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });
  it("an old or malformed launch note is cleared without opening anything", async () => {
    const heard = vi.fn();
    window.addEventListener(WAKE_EVENT, heard);
    const old = preferences(String(1_000_000));
    expect(await checkSiriLaunch({ now: 1_000_000 + 10 * 60_000, preferences: old })).toBe(false);
    expect(old.store.size).toBe(0);
    expect(await checkSiriLaunch({ now: 1, preferences: preferences("soon") })).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });
});
