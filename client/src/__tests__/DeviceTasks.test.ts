import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init: RequestInit }>, statuses: [] as string[], signedIn: true }));
vi.mock("../services/Account", () => ({
  accountRequest: vi.fn(async (path: string, init: RequestInit = {}) => {
    server.calls.push({ path, init });
    if (path === "/api/account/tasks") return { tasks: [] };
    if (path.endsWith("/decision")) return { task: { id: path.split("/")[4], status: JSON.parse(String(init.body)).approve ? "approved" : "denied" } };
    if (!init.method) return { task: { status: server.statuses.shift() ?? "waiting", decidedBy: "Pixel" } };
    return { task: {} };
  }),
}));
vi.mock("../services/api", () => ({ getAccountHint: () => (server.signedIn ? { email: "me@example.com", displayName: "" } : null) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web" } }));

import { DeviceTasks, defaultDeviceName } from "../services/DeviceTasks";
import { ApprovalCenter } from "../services/ApprovalCenter";

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
  server.calls = [];
  server.statuses = [];
  server.signedIn = true;
});

describe("device names", () => {
  it("names devices the way people recognise them", () => {
    expect(defaultDeviceName("web", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36")).toBe("Chrome on macOS");
    expect(defaultDeviceName("android", "Mozilla/5.0 (Linux; Android 15)")).toBe("Android phone");
    expect(defaultDeviceName("electron", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Desktop app on Windows");
    expect(DeviceTasks.device().id).toMatch(/^dev-[a-f0-9]{24}$/);
    expect(DeviceTasks.device()).toEqual(DeviceTasks.device());
  });
});

describe("reporting tasks", () => {
  it("shares nothing when signed out or turned off", () => {
    server.signedIn = false;
    DeviceTasks.report({ id: "team-run-0001", title: "Research", status: "running" });
    server.signedIn = true;
    DeviceTasks.setEnabled(false);
    DeviceTasks.report({ id: "team-run-0001", title: "Research", status: "running" });
    expect(server.calls).toEqual([]);
  });

  it("sends status changes at once and progress at most every few seconds", () => {
    DeviceTasks.report({ id: "team-run-0002", title: "Research", status: "running", detail: "0 of 3 steps done" });
    DeviceTasks.report({ id: "team-run-0002", title: "Research", status: "running", detail: "1 of 3 steps done" });
    DeviceTasks.report({ id: "team-run-0002", title: "Research", status: "done", detail: "Found it" });
    const puts = server.calls.filter((call) => call.init.method === "PUT").map((call) => JSON.parse(String(call.init.body)));
    expect(puts.map((body) => [body.status, body.detail])).toEqual([["running", "0 of 3 steps done"], ["done", "Found it"]]);
    expect(puts[0]).toMatchObject({ kind: "task", title: "Research", deviceName: expect.any(String) });
  });
});

describe("approvals from another device", () => {
  it("closes the chat card with the answer given on the phone", async () => {
    vi.useFakeTimers();
    const updates: Array<Array<{ id: string; shared?: boolean }>> = [];
    const detach = ApprovalCenter.attachHost((requests) => updates.push(requests));
    const answer = ApprovalCenter.request("send_message", "Text Sam: running late");
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.at(-1)?.[0].shared).toBe(true);
    const created = server.calls.find((call) => call.init.method === "PUT");
    expect(JSON.parse(String(created?.init.body))).toMatchObject({ kind: "approval", title: "Send a message", detail: "Text Sam: running late" });

    server.statuses.push("waiting", "approved");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(answer).resolves.toBe(true);
    expect(updates.at(-1)).toEqual([]);
    // The phone already answered, so this device doesn't send its own decision.
    expect(server.calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
    detach();
  });

  it("tells the other devices when the user answers here", async () => {
    vi.useFakeTimers();
    let current: Array<{ id: string }> = [];
    const detach = ApprovalCenter.attachHost((requests) => { current = requests; });
    const answer = ApprovalCenter.request("store_memory", "Save: likes jazz");
    await vi.advanceTimersByTimeAsync(0);
    ApprovalCenter.respond(current[0].id, false);
    await expect(answer).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const decision = server.calls.find((call) => call.path.endsWith("/decision"));
    expect(JSON.parse(String(decision?.init.body))).toMatchObject({ approve: false });
    detach();
  });

  it("withdraws the shared request when the chat closes", async () => {
    vi.useFakeTimers();
    const detach = ApprovalCenter.attachHost(() => undefined);
    const answer = ApprovalCenter.request("delete_file", "Delete notes.txt");
    await vi.advanceTimersByTimeAsync(0);
    detach();
    await expect(answer).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const withdraw = server.calls.filter((call) => call.init.method === "PUT").map((call) => JSON.parse(String(call.init.body))).find((body) => body.status === "cancelled");
    expect(withdraw).toMatchObject({ kind: "approval", status: "cancelled" });
  });
});
