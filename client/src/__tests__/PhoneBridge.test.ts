import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ account: { email: "me@example.com" } as null | { email: string }, platform: "web", native: false }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => state.platform, isNativePlatform: () => state.native },
  registerPlugin: () => ({}),
}));
vi.mock("../services/api", () => ({ getAccountHint: () => state.account, apiFetch: vi.fn(), apiUrl: (path: string) => path, usesBearerSession: () => false }));
vi.mock("../services/DeviceTasks", () => ({ thisDevice: () => ({ id: "dev-0123456789", name: "MacBook" }) }));

import { checkNumber, describeOutcome, handleCommand, signedMessage, type HannahPhonePlugin, type PhoneCommand, type PhoneSettings } from "../services/PhoneBridge";
import { getPhoneTools } from "../services/PhoneTools";

const require = createRequire(import.meta.url);
const server = require("../../../server/phone-bridge.js") as { signedMessage: (input: { phoneId: string; time: number; method: string; path: string; body: string }) => string; normalizeNumber: (input: string) => string };

function fakePlugin(overrides: Partial<{ dial: () => Promise<unknown>; composeSms: () => Promise<{ result: string }>; findContacts: () => Promise<unknown>; presents: boolean }> = {}) {
  const calls: Array<[string, unknown]> = [];
  let presented: (() => void) | null = null;
  const plugin = {
    capabilities: async () => ({ platform: "android", canDial: true, canSms: true, contactsPermission: "granted" }),
    dial: async (options: unknown) => { calls.push(["dial", options]); return overrides.dial ? overrides.dial() : { result: "opened" }; },
    composeSms: async (options: unknown) => { calls.push(["composeSms", options]); if (overrides.presents) presented?.(); return overrides.composeSms ? overrides.composeSms() : { result: "opened" }; },
    findContacts: async (options: unknown) => { calls.push(["findContacts", options]); return overrides.findContacts ? overrides.findContacts() : { matches: [{ name: "Aman Gupta", numbers: [{ label: "mobile", number: "+91 98765 43210" }] }] }; },
    addListener: async (_event: string, listener: () => void) => { presented = listener; return { remove: async () => { presented = null; } }; },
  } as unknown as HannahPhonePlugin;
  return { plugin, calls };
}

const settings = (overrides: Partial<PhoneSettings> = {}): PhoneSettings => ({ enabled: true, capabilities: ["call", "sms", "contacts"], phoneId: "ph_1", fingerprint: "AAAA BBBB CCCC", ...overrides });
let nonce = 0;
const command = (action: "call" | "sms" | "lookup", payload: Record<string, string>, extra: Record<string, unknown> = {}) => ({ id: `pc_${action}`, action, payload, nonce: `nonce-${(nonce += 1)}-${Math.random()}`, expiresAt: Date.now() + 30_000, requestedBy: "MacBook", ...extra });

async function run(cmd: ReturnType<typeof command>, plugin: HannahPhonePlugin, phone = settings()) {
  const reports: Array<[string, Record<string, unknown> | undefined]> = [];
  await handleCommand(cmd, { plugin, settings: phone, now: () => Date.now(), report: async (status, extra) => { reports.push([status, extra]); } });
  return reports;
}

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

beforeEach(() => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent: () => true });
  state.account = { email: "me@example.com" }; state.platform = "web"; state.native = false; });

describe("phone bridge on the phone", () => {
  it("signs exactly the string the server checks", async () => {
    const input = { phoneId: "ph_1", time: 1_700_000_000_000, method: "post", path: "/api/phone/me/commands", body: "{\"a\":1}" };
    expect(await signedMessage(input.phoneId, input.time, input.method, input.path, input.body)).toBe(server.signedMessage(input));
  });

  it("checks numbers the same way as the server, refusing emergency and service codes", () => {
    for (const ok of ["+91 98765-43210", "(022) 4000 1000", "9876543210"]) expect(checkNumber(ok)).toEqual({ number: server.normalizeNumber(ok) });
    for (const bad of ["112", "+1 911", "999", "*#06#", "call me", "12"]) {
      expect("refused" in checkNumber(bad), bad).toBe(true);
      expect(() => server.normalizeNumber(bad), bad).toThrow();
    }
  });

  it("opens the dialer and reports only that the dialer opened", async () => {
    const { plugin, calls } = fakePlugin();
    expect(await run(command("call", { number: "+919876543210", name: "Aman" }), plugin)).toEqual([["dialer-opened", undefined]]);
    expect(calls).toEqual([["dial", { number: "+919876543210" }]]);
  });

  it("on Android reports the composer opened; on iPhone also what the person did", async () => {
    const android = fakePlugin();
    expect((await run(command("sms", { number: "9876543210", body: "Late by 20" }), android.plugin)).map(([status]) => status)).toEqual(["composer-opened"]);
    expect(android.calls[0]).toEqual(["composeSms", { number: "9876543210", body: "Late by 20" }]);

    const iphone = fakePlugin({ presents: true, composeSms: async () => ({ result: "sent" }) });
    expect((await run(command("sms", { number: "9876543210", body: "Late" }), iphone.plugin)).map(([status]) => status)).toEqual(["composer-opened", "sent"]);
    const cancelled = fakePlugin({ presents: true, composeSms: async () => ({ result: "cancelled" }) });
    expect((await run(command("sms", { number: "9876543210", body: "Late" }), cancelled.plugin)).map(([status]) => status)).toEqual(["composer-opened", "cancelled"]);
  });

  it("refuses on the phone itself: turned off, not allowed, too old, repeated, or an emergency number", async () => {
    const { plugin, calls } = fakePlugin();
    expect((await run(command("call", { number: "9876543210" }), plugin, settings({ enabled: false })))[0][0]).toBe("declined");
    expect((await run(command("sms", { number: "9876543210", body: "x" }), plugin, settings({ capabilities: ["call"] })))[0][0]).toBe("declined");
    expect((await run(command("call", { number: "9876543210" }, { expiresAt: Date.now() - 1 }), plugin))[0][0]).toBe("declined");
    const once = command("call", { number: "9876543210" });
    await run(once, plugin);
    expect((await run(once, plugin))[0]).toEqual(["declined", { detail: "This request was already handled." }]);
    expect((await run(command("call", { number: "112" }), plugin))[0][0]).toBe("declined");
    expect(calls.filter(([name]) => name === "dial")).toHaveLength(1);
  });

  it("looks up contacts and reports a refused permission as declined", async () => {
    const { plugin } = fakePlugin();
    expect(await run(command("lookup", { query: "Aman" }), plugin)).toEqual([["resolved", { matches: [{ name: "Aman Gupta", numbers: [{ label: "mobile", number: "+91 98765 43210" }] }] }]]);
    const denied = fakePlugin({ findContacts: async () => { throw Object.assign(new Error("Contacts permission wasn't given."), { code: "PERMISSION_DENIED" }); } });
    expect((await run(command("lookup", { query: "Aman" }), denied.plugin))[0][0]).toBe("declined");
  });
});

describe("phone bridge on the computer", () => {
  const base: PhoneCommand = { id: "pc_1", phoneId: "ph_1", action: "call", status: "dialer-opened", requestedBy: "MacBook", payload: { number: "+919876543210", name: "Aman" }, createdAt: 0, expiresAt: 0, deliveredAt: 0, finishedAt: 0, result: null };

  it("never claims more than the phone verified", () => {
    const dialer = describeOutcome(base, "Pixel 8");
    expect(dialer).toMatch(/dialer opened on Pixel 8/);
    expect(dialer).toMatch(/can't see whether the call connects/);
    expect(describeOutcome({ ...base, action: "sms", status: "composer-opened" }, "Pixel 8")).toMatch(/doesn't tell HANNAH whether you did/);
    expect(describeOutcome({ ...base, action: "sms", status: "sent" }, "iPhone")).toMatch(/delivery isn't reported/);
    expect(describeOutcome({ ...base, status: "expired" }, "Pixel 8")).toMatch(/Nothing will happen later/);
  });

  it("offers phone tools to signed-in computers only, and calls and texts need approval", () => {
    expect(getPhoneTools().map((tool) => tool.name)).toEqual(["phone_find_contact", "phone_call", "phone_text"]);
    const [lookup, call, text] = getPhoneTools();
    expect(lookup.requiresApproval).toBeUndefined();
    expect(call.requiresApproval).toBe(true);
    expect(call.approvalDetails?.({ number: "+919876543210", name: "Aman" })).toEqual({ call: "Aman (+919876543210)", using: "your paired phone's dialer" });
    expect(text.requiresApproval).toBe(true);
    state.account = null;
    expect(getPhoneTools()).toEqual([]);
    state.account = { email: "me@example.com" };
    state.native = true;
    state.platform = "android";
    expect(getPhoneTools(), "the phone itself uses make_call").toEqual([]);
  });
});
