import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  health: { ok: true, status: 200, body: { status: "ok", provider: "Groq", ready: true } as Record<string, unknown> },
  throwOnHealth: false,
  session: true,
  account: null as { email: string; displayName?: string } | null,
  desktop: false,
  errors: [] as Array<{ at: number; level: string; message: string }>,
}));

vi.mock("../services/api", () => ({
  apiUrl: (path: string) => path,
  apiFetch: async (url: string) => {
    if (state.throwOnHealth) throw new TypeError("Failed to fetch");
    if (url === "/api/health") return { ok: state.health.ok, status: state.health.status, json: async () => state.health.body };
    if (url === "/api/health/agent") return { ok: true, status: 200, json: async () => ({ checks: { ollama: { ready: false, error: "model_missing" } } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  },
  getAccountHint: () => state.account,
  hasApiSession: () => state.session,
  isGuestSession: () => state.session && !state.account,
}));
vi.mock("../services/Connections", () => ({ Connections: { connectedProviders: () => (state.account ? [{ id: "google", label: "Google", connected: true }] : []) } }));
vi.mock("../services/DesktopFiles", () => ({ desktopFilesAvailable: () => state.desktop, hannahDesktop: () => ({ desktopInfo: async () => ({ version: "1.4.0", channel: "stable", shortcut: { registered: true }, tray: false }) }) }));
vi.mock("../services/Diagnostics", () => ({ Diagnostics: { list: () => state.errors } }));
vi.mock("../services/ReminderService", () => ({ ReminderService: { list: () => [] } }));
vi.mock("../services/MemoryService", () => ({ MemoryService: { list: () => [] } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web" } }));

import { CHECK_IDS, runSetupCheck } from "../services/SetupCheck";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { get length() { return store.size; }, key: (index: number) => [...store.keys()][index] ?? null, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

beforeEach(() => {
  state.health = { ok: true, status: 200, body: { status: "ok", provider: "Groq", ready: true } };
  state.throwOnHealth = false;
  state.session = true;
  state.account = null;
  state.desktop = false;
  state.errors = [];
  vi.stubGlobal("window", { localStorage: memoryStorage({ "hannah.chat.mode": "cloud", "hannah.cloudProvider": "groq", "hannah.cloudModel:groq": "llama-3.3-70b-versatile" }), speechSynthesis: { getVoices: () => [{ name: "Samantha" }, { name: "Daniel" }] }, dispatchEvent: () => true });
  vi.stubGlobal("navigator", { onLine: true, permissions: { query: async () => ({ state: "granted" }) } });
  vi.stubGlobal("Notification", { permission: "default" });
  vi.stubGlobal("CustomEvent", class { type: string; constructor(type: string) { this.type = type; } });
});

const byId = async (only?: string[]) => Object.fromEntries((await runSetupCheck(only)).results.map((result) => [result.id, result]));

describe("setup check", () => {
  it("runs every check and sums the verdicts", async () => {
    const report = await runSetupCheck();
    expect(report.results.map((result) => result.id)).toEqual(CHECK_IDS);
    expect(report.counts.ok + report.counts.warn + report.counts.fail + report.counts.skip).toBe(CHECK_IDS.length);
    const results = Object.fromEntries(report.results.map((result) => [result.id, result]));
    expect(results.network).toMatchObject({ status: "ok" });
    expect(results.server).toMatchObject({ status: "ok", detail: expect.stringContaining("default provider Groq") });
    expect(results.ai).toMatchObject({ status: "ok", detail: expect.stringContaining("llama-3.3-70b-versatile") });
    expect(results.account).toMatchObject({ status: "skip" });
    expect(results.connections).toMatchObject({ status: "skip", detail: "Needs an account." });
    expect(results.voice).toMatchObject({ status: "ok", detail: "2 device voices available." });
    expect(results.microphone).toMatchObject({ status: "ok", detail: "Allowed." });
    expect(results.notifications).toMatchObject({ status: "warn" });
    expect(results.storage).toMatchObject({ status: "ok" });
    expect(results.desktop).toMatchObject({ status: "skip", detail: expect.stringContaining("in a browser") });
    expect(results.briefing).toMatchObject({ status: "ok" });
    expect(results.diagnostics).toMatchObject({ status: "ok" });
  });

  it("reports the server, the key and the model as problems with a fix each", async () => {
    state.throwOnHealth = true;
    state.session = false;
    const results = await byId(["server", "ai"]);
    expect(results.server).toMatchObject({ status: "fail", detail: "Failed to fetch", fix: expect.stringContaining("connection") });
    expect(results.ai).toMatchObject({ status: "fail", fix: expect.stringContaining("Settings → Connection") });
  });

  it("checks Ollama through the server when chat uses it", async () => {
    window.localStorage.setItem("hannah.chat.mode", "ollama");
    const results = await byId(["ai"]);
    expect(results.ai).toMatchObject({ status: "fail", detail: expect.stringContaining("model isn't pulled") });
  });

  it("sees an account, its connections, the desktop app's tray and recent errors", async () => {
    state.account = { email: "me@example.com", displayName: "Harsh" };
    state.desktop = true;
    state.errors = [{ at: Date.now() - 60_000, level: "error", message: "Sync failed: HTTP 500" }, { at: Date.now() - 3 * 86_400_000, level: "error", message: "old" }];
    const results = await byId(["account", "connections", "desktop", "diagnostics", "notifications", "microphone"]);
    expect(results.account).toMatchObject({ status: "ok", detail: expect.stringContaining("Harsh") });
    expect(results.account!.detail).not.toContain("me@example.com");
    expect(results.connections).toMatchObject({ status: "ok", detail: "Connected: Google." });
    expect(results.desktop).toMatchObject({ status: "warn", detail: expect.stringContaining("tray icon is missing") });
    expect(results.diagnostics).toMatchObject({ status: "warn", detail: expect.stringContaining("1 error in the last 24 hours") });
    vi.stubGlobal("Notification", { permission: "denied" });
    vi.stubGlobal("navigator", { onLine: false, permissions: { query: async () => ({ state: "denied" }) } });
    const again = await byId(["notifications", "microphone", "network"]);
    expect(again.notifications).toMatchObject({ status: "warn", fix: expect.stringContaining("site settings") });
    expect(again.microphone).toMatchObject({ status: "warn" });
    expect(again.network).toMatchObject({ status: "warn" });
  });

  it("warns when storage is nearly full and when the weather has no place", async () => {
    window.localStorage.setItem("hannah.knowledge.v1", "x".repeat(2_300_000));
    window.localStorage.setItem("hannah.briefing.v1", JSON.stringify({ sections: { weather: true }, location: null }));
    const results = await byId(["storage", "briefing"]);
    expect(results.storage).toMatchObject({ status: "warn", fix: expect.stringContaining("knowledge") });
    expect(results.briefing).toMatchObject({ status: "warn", fix: expect.stringContaining("choose a place") });
  });
});
