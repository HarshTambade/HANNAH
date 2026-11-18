import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ value: false }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.value } }));

import { isNativeShell, removeServiceWorkers } from "../services/appShell";

describe("app shell", () => {
  it("is native inside Capacitor and on the website it isn't", () => {
    native.value = true;
    expect(isNativeShell()).toBe(true);
    native.value = false;
    expect(isNativeShell()).toBe(false);
  });

  it("unregisters every service worker and counts the ones removed", async () => {
    const a = { unregister: vi.fn(async () => true) };
    const b = { unregister: vi.fn(async () => { throw new Error("gone"); }) };
    const container = { getRegistrations: vi.fn(async () => [a, b] as unknown as ServiceWorkerRegistration[]) };
    expect(await removeServiceWorkers(container)).toBe(1);
    expect(a.unregister).toHaveBeenCalled();
    expect(b.unregister).toHaveBeenCalled();
  });

  it("does nothing without service worker support", async () => {
    expect(await removeServiceWorkers(undefined)).toBe(0);
    expect(await removeServiceWorkers({ getRegistrations: async () => { throw new Error("denied"); } })).toBe(0);
  });
});
