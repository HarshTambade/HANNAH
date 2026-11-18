import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const stubWindow = () => vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } } }));
stubWindow();
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" } }));
vi.mock("@capacitor/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("../services/DesktopBridge", () => ({ getDesktopBridge: () => null }));
vi.mock("../services/api", () => ({ getAccountHint: () => ({ email: "me@example.com" }) }));
const requests: Array<{ path: string; body: unknown }> = [];
vi.mock("../services/Account", () => ({ accountRequest: async (path: string, init: RequestInit = {}) => { requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : null }); return {}; } }));

const { getConnectionTools } = await import("../services/Connections");
const { ACTION_RISK, riskOf } = await import("../services/SafetyGuard");

const connect = (features: { organize: boolean; chat: boolean }) => store.set("hannah.connections.v1", JSON.stringify([{ id: "google", label: "Google", services: "", configured: true, connected: true, email: "me@example.com", connectedAt: 1, redirectUri: "", features }]));

beforeEach(stubWindow);
afterEach(() => { store.clear(); requests.length = 0; });

describe("communication tools", () => {
  it("offers Google Chat tools only when the person connected Google Chat", () => {
    connect({ organize: true, chat: false });
    const names = getConnectionTools().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["email_needs_reply", "email_reply_draft", "email_organize"]));
    expect(names.some((name) => name.startsWith("gchat_"))).toBe(false);
    connect({ organize: true, chat: true });
    expect(getConnectionTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["gchat_spaces", "gchat_read", "gchat_send"]));
  });

  it("anything that changes mail or reaches people waits for approval; reading doesn't", () => {
    connect({ organize: true, chat: true });
    const tools = Object.fromEntries(getConnectionTools().map((tool) => [tool.name, tool]));
    expect(tools.gchat_send.requiresApproval).toBe(true);
    expect(tools.gchat_send.sensitive).toBe("send_chat_message");
    expect(tools.email_reply_draft.requiresApproval).toBe(true);
    expect(tools.email_organize.sensitive).toBe("organize_email");
    expect(tools.email_needs_reply.requiresApproval).toBeFalsy();
    expect(tools.gchat_read.requiresApproval).toBeFalsy();
    expect(riskOf("send_chat_message")).toBe("high");
    expect(riskOf("organize_email")).toBe("medium");
    expect(riskOf("make_payment")).toBe("critical");
  });

  it("calls the server routes with exactly what was approved", async () => {
    connect({ organize: true, chat: true });
    const tools = Object.fromEntries(getConnectionTools().map((tool) => [tool.name, tool]));
    await tools.email_reply_draft.execute({ provider: "google", id: "m1", body: "Thanks!", replyAll: true });
    await tools.email_organize.execute({ provider: "microsoft", id: "m2", archive: true, labels: ["Follow up"] });
    await tools.gchat_send.execute({ space: "spaces/AAA", text: "On it", thread: "spaces/AAA/threads/t" });
    expect(requests).toEqual([
      { path: "/api/account/mail/messages/google/m1/reply-draft", body: { body: "Thanks!", replyAll: true } },
      { path: "/api/account/mail/messages/microsoft/m2/organize", body: { archive: true, labels: ["Follow up"] } },
      { path: "/api/account/chat/messages", body: { space: "spaces/AAA", text: "On it", thread: "spaces/AAA/threads/t" } },
    ]);
  });

  it("every approved action has a risk level", () => {
    for (const level of Object.values(ACTION_RISK)) expect(["low", "medium", "high", "critical"]).toContain(level);
    expect(Object.keys(ACTION_RISK).length).toBe(17);
  });
});
