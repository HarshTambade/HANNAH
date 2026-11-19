import { beforeEach, describe, expect, it, vi } from "vitest";

// AgentRuntime pulls in the native agent bridge; these tests only need its pure helpers.
vi.mock("../services/MobileAgent", () => ({ getNativeMemoryTools: vi.fn(async () => []) }));

// A small window: two storages and events, which is all the marketplace uses.
function storage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, String(value)), removeItem: (key) => void data.delete(key), clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
const target = new EventTarget();
(globalThis as { window?: unknown }).window = { localStorage: storage(), sessionStorage: storage(), addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target), location: { hostname: "localhost", origin: "http://localhost", href: "http://localhost/", pathname: "/", search: "", hash: "" } };

import catalog from "../../../shared/marketplace-catalog.json";
import { MARKETPLACE_EVENT, MAX_ENABLED_SKILLS, MarketplaceService } from "../services/MarketplaceService";
import { selectRelevantTools, UNANSWERED_NOTE, withUnansweredMarked } from "../services/AgentRuntime";
import { selectToolsForRequest } from "../services/AgentRouter";
import { screenToolOutput } from "../services/AgentGuardrails";
import { getDeviceTools, type HANNAHTool } from "../services/DeviceTools";

const tool = (name: string): HANNAHTool => ({ name, description: name, inputSchema: { type: "object", properties: {} }, execute: async () => null });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const item of MarketplaceService.list()) MarketplaceService.uninstall(item.id);
});

describe("the marketplace catalog", () => {
  it("every package is complete: instructions the server accepts, and prompts to try", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(20);
    expect(new Set(catalog.map((item) => item.id)).size).toBe(catalog.length);
    for (const item of catalog) {
      expect(item.id, item.id).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(["agent", "skill"], item.id).toContain(item.type);
      expect(item.instructions.length, item.id).toBeGreaterThan(100);
      expect(item.instructions.length, item.id).toBeLessThanOrEqual(1200);
      expect(item.starters.length, item.id).toBeGreaterThan(0);
      expect(item.description.length, item.id).toBeGreaterThan(20);
    }
  });

  it("every tool an agent names is a real HANNAH tool", () => {
    const real = new Set(getDeviceTools().map((item) => item.name));
    for (const item of catalog) for (const name of ("tools" in item ? item.tools ?? [] : [])) expect(real.has(name), `${item.id}: ${name}`).toBe(true);
  });
});

describe("adding a package turns it on", () => {
  it("an agent becomes the active one, replacing another, and its tools and prompts come with it", () => {
    const heard: string[] = [];
    window.addEventListener(MARKETPLACE_EVENT, () => heard.push("changed"));
    MarketplaceService.turnOn("study-coach");
    expect(MarketplaceService.getActiveAgent()?.id).toBe("study-coach");
    MarketplaceService.turnOn("research-analyst");
    expect(MarketplaceService.getActiveAgent()?.id).toBe("research-analyst");
    expect(MarketplaceService.getInstalledAgents().map((item) => item.id).sort()).toEqual(["research-analyst", "study-coach"]);
    expect(MarketplaceService.getAgentTools()).toEqual(["web_search", "web_read", "knowledge_search"]);
    expect(MarketplaceService.getActiveAgent()?.starters.length).toBeGreaterThan(0);
    expect(MarketplaceService.getActivePackageIds()).toEqual(["research-analyst"]);
    expect(MarketplaceService.getRuntimeInstructions()).toContain("research analyst");
    expect(heard.length).toBeGreaterThan(0);

    MarketplaceService.activateAgent(null);
    expect(MarketplaceService.getActiveAgent()).toBeUndefined();
    expect(MarketplaceService.getAgentTools()).toEqual([]);
    expect(MarketplaceService.getRuntimeInstructions()).toBe("");
  });

  it("a skill is enabled at once, up to the limit the server accepts", () => {
    const skills = MarketplaceService.list().filter((item) => item.type === "skill");
    for (const skill of skills.slice(0, MAX_ENABLED_SKILLS)) MarketplaceService.turnOn(skill.id);
    expect(MarketplaceService.getEnabledSkills()).toHaveLength(MAX_ENABLED_SKILLS);
    expect(() => MarketplaceService.turnOn(skills[MAX_ENABLED_SKILLS].id)).toThrow(/Up to 5 skills/);
    MarketplaceService.turnOn("study-coach");
    // One agent and five skills: what one request may carry.
    expect(MarketplaceService.getActivePackageIds()).toHaveLength(MAX_ENABLED_SKILLS + 1);
    MarketplaceService.uninstall(skills[0].id);
    expect(MarketplaceService.getEnabledSkills()).toHaveLength(MAX_ENABLED_SKILLS - 1);
  });

  it("a prompt handed to the chat waits there until the chat takes it", () => {
    MarketplaceService.setChatDraft("Teach me how photosynthesis works, then quiz me on it.");
    expect(MarketplaceService.peekChatDraft()).toBe("Teach me how photosynthesis works, then quiz me on it.");
    expect(MarketplaceService.peekChatDraft()).not.toBe("");
    MarketplaceService.clearChatDraft();
    expect(MarketplaceService.peekChatDraft()).toBe("");
  });
});

describe("the active agent's tools reach the model", () => {
  const all = ["toggle_setting", "open_app", "send_message", "make_call", "list_app_files", "read_app_file", "write_app_file", "delete_app_file", "get_device_status", "get_battery_status", "create_reminder", "list_reminders", "cancel_reminder", "search_memories", "save_memory", "web_search", "web_read", "knowledge_search", "knowledge_documents", "daily_briefing", "email_search", "calendar_list"].map(tool);

  it("both tool filters keep them for a request that never mentions them", () => {
    const request = "What changed in the latest stable release of Node.js?";
    const first = selectToolsForRequest(all, request, { required: ["web_search", "web_read", "knowledge_search"] }).map((item) => item.name);
    expect(first).toEqual(expect.arrayContaining(["web_search", "web_read", "knowledge_search"]));
    const kept = selectRelevantTools(all, [{ role: "user", content: "Plan my day please." }], ["list_reminders", "cancel_reminder"]).map((item) => item.name);
    expect(kept).toEqual(expect.arrayContaining(["list_reminders", "cancel_reminder", "create_reminder"]));
    const without = selectRelevantTools(all, [{ role: "user", content: "Plan my day please." }]).map((item) => item.name);
    expect(without).not.toContain("cancel_reminder");
  });
});

describe("a long tool result or a failed reply doesn't derail the next turn", () => {
  it("a web page longer than the limit is shortened with a note, not thrown away", () => {
    const page = `Page https://example.org:\n${"Release notes. ".repeat(2000)}`;
    const screened = screenToolOutput(page);
    expect(screened.length).toBeLessThanOrEqual(8_000);
    expect(screened).toMatch(/\[Shortened: [\d,]+ more characters not shown\.\]$/);
    expect(screened.startsWith("Page https://example.org")).toBe(true);
    expect(screenToolOutput("short result")).toBe("short result");
  });

  it("a tool result the safety screen objects to is withheld instead of ending the turn", () => {
    expect(screenToolOutput("a forum post saying you should kill yourself")).toBe("[The tool's output was withheld by the safety screen.]");
  });

  it("an unanswered message is marked, so the model answers the latest one", () => {
    const marked = withUnansweredMarked([
      { role: "assistant", content: "Hello" },
      { role: "user", content: "What changed in Node.js?" },
      { role: "user", content: "How does HTTPS work?" },
    ]);
    expect(marked.map((message) => message.role)).toEqual(["assistant", "user", "assistant", "user"]);
    expect(marked[2].content).toBe(UNANSWERED_NOTE);
    const normal = [{ role: "user" as const, content: "a" }, { role: "assistant" as const, content: "b" }, { role: "user" as const, content: "c" }];
    expect(withUnansweredMarked(normal)).toEqual(normal);
  });
});
