import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestStep, resolveMode } = vi.hoisted(() => ({ requestStep: vi.fn(), resolveMode: vi.fn() }));
vi.mock("../services/DeviceTools", () => ({ executeHANNAHTool: vi.fn(), getDeviceTools: () => [] }));
vi.mock("../services/MobileAgent", () => ({ getNativeMemoryTools: vi.fn(async () => []) }));
vi.mock("../services/LLMRouter", () => ({ LLMRouter: { requestStep, resolveMode }, shouldUseLocalFallback: () => false }));

import { categoryOf, rankMemories, secretIn, sensitivityOf, similarity, type RankableMemory } from "../services/MemoryModel";
import { MemoryService } from "../services/MemoryService";
import { runAgentTurn } from "../services/AgentRuntime";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
});

describe("memory rules", () => {
  it("refuses secrets, but not ordinary sentences that mention them", () => {
    expect(secretIn("my groq key is gsk_abcdefghijklmnopqrstuvwx")).toBe("an API key");
    expect(secretIn("My password is hunter22!")).toBe("a password or PIN");
    expect(secretIn("bank PIN: 4821")).toBe("a password or PIN");
    expect(secretIn("card 4111 1111 1111 1111 expires soon")).toBe("a card number");
    expect(secretIn("Aadhaar 1234 5678 9012")).toBe("an ID number");
    expect(secretIn("PAN ABCDE1234F")).toBe("an ID number");
    expect(secretIn("token 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc")).toBe("a key or token");
    expect(secretIn("My pin code is 411001")).toBe("");
    expect(secretIn("My password manager is 1Password")).toBe("");
    expect(secretIn("I forgot my password again today")).toBe("");
    expect(secretIn("I prefer short answers")).toBe("");
    expect(secretIn("My order number is 4111 1111 1111 1112")).toBe("");
  });

  it("marks health, money, beliefs and contact details as sensitive", () => {
    expect(sensitivityOf("I was diagnosed with diabetes last year")).toBe("sensitive");
    expect(sensitivityOf("My salary is 18 lakh")).toBe("sensitive");
    expect(sensitivityOf("Reach me at sam@example.com")).toBe("sensitive");
    expect(sensitivityOf("I like masala chai")).toBe("normal");
  });

  it("guesses a category", () => {
    expect(categoryOf("I prefer short answers")).toBe("preference");
    expect(categoryOf("My sister Riya lives in Mumbai")).toBe("people");
    expect(categoryOf("I go for a run every morning")).toBe("routine");
    expect(categoryOf("I'm building a React app called HANNAH")).toBe("project");
    expect(categoryOf("I live in Pune")).toBe("personal");
    expect(categoryOf("The sky is blue")).toBe("other");
  });

  it("treats rewordings as the same memory", () => {
    expect(similarity("I live in Pune", "I live in Pune.")).toBe(1);
    expect(similarity("I live in Pune", "I live in Pune, India")).toBeGreaterThan(0.6);
    expect(similarity("I live in Pune", "I work at Infosys")).toBeLessThan(0.3);
  });
});

const mem = (id: string, content: string, extra: Partial<RankableMemory> = {}): RankableMemory => ({
  id, content, layer: "long_term", weight: 1, decay: 0, updatedAt: "2026-11-01T00:00:00Z", category: categoryOf(content), sensitivity: sensitivityOf(content), ...extra,
});

describe("relevance ranking", () => {
  const memories = [
    mem("pref", "I prefer short answers"),
    mem("dog", "My dog Bruno is a beagle"),
    mem("trip", "I'm planning a trip to Goa in December"),
    mem("allergy", "I'm allergic to peanuts"),
    mem("health", "I take medication for anxiety"),
    ...Array.from({ length: 20 }, (_, index) => mem(`filler-${index}`, `Filler fact number ${index} about gardening`, { updatedAt: "2026-11-16T00:00:00Z" })),
  ];

  it("sends what relates to the message, not the newest, plus preferences", () => {
    const { picked } = rankMemories(memories, "Can you suggest a snack? Something without nuts", { now: Date.parse("2026-11-17T00:00:00Z") });
    expect(picked.map((item) => item.memory.id)).toEqual(["pref"]);
    const food = rankMemories(memories, "suggest peanut-free snacks", { now: Date.parse("2026-11-17T00:00:00Z") }).picked;
    expect(food[0].memory.id).toBe("allergy");
    expect(food.map((item) => item.memory.id)).toContain("pref");
    expect(food.some((item) => item.memory.id.startsWith("filler"))).toBe(false);
    const travel = rankMemories(memories, "What should I pack for Goa?").picked;
    expect(travel[0]).toMatchObject({ memory: { id: "trip" }, why: "match" });
  });

  it("keeps sensitive memories back unless the model is private, and respects switched-off categories", () => {
    const hosted = rankMemories(memories, "my anxiety medication");
    expect(hosted.picked.map((item) => item.memory.id)).not.toContain("health");
    expect(hosted.hiddenSensitive).toBe(1);
    expect(rankMemories(memories, "my anxiety medication", { allowSensitive: true }).picked[0].memory.id).toBe("health");
    expect(rankMemories(memories, "short answers please", { categories: { preference: false } }).picked).toEqual([]);
  });

  it("matches Hinglish and word forms", () => {
    const list = [mem("chai", "Mujhe chai pasand hai, bina cheeni"), mem("run", "I go running every morning")];
    expect(rankMemories(list, "chai banana sikhao", { preferences: 0 }).picked[0].memory.id).toBe("chai");
    expect(rankMemories(list, "plan my runs this week", { preferences: 0 }).picked[0].memory.id).toBe("run");
  });
});

describe("MemoryService", () => {
  it("records where a memory came from, refuses secrets, and merges near-duplicates", () => {
    const first = MemoryService.remember("I live in Pune", { source: { kind: "chat" } });
    expect(first).toMatchObject({ ok: true, merged: false, record: { category: "personal", source: { kind: "chat" }, sensitivity: "normal" } });
    const again = MemoryService.remember("i live in pune.", { source: { kind: "assistant" } });
    expect(again).toMatchObject({ ok: true, merged: true });
    expect(MemoryService.list()).toHaveLength(1);
    expect(MemoryService.list()[0].content).toBe("i live in pune.");
    expect(MemoryService.remember("My sister lives in Pune", { source: { kind: "chat" } })).toMatchObject({ ok: true, merged: false });

    const secret = MemoryService.remember("my wifi password is chai4life", { source: { kind: "chat" } });
    expect(secret.ok).toBe(false);
    expect(MemoryService.list()).toHaveLength(2);
    expect(MemoryService.edit(MemoryService.list()[0].id, { content: "API key sk-proj-abcdefghijklmnopqrstu" })).toMatch(/API key/);
  });

  it("uses and saves nothing while memory is off", () => {
    MemoryService.remember("I prefer short answers", { source: { kind: "you" } });
    MemoryService.saveSettings({ enabled: false });
    expect(MemoryService.remember("I like tea", { source: { kind: "chat" } }).ok).toBe(false);
    expect(MemoryService.add("long_term", "derived insight")).toBeNull();
    expect(MemoryService.forMessage("answers").picked).toEqual([]);
    expect(MemoryService.search("answers")).toMatchObject({ off: true, memories: [] });
    MemoryService.saveSettings({ enabled: true });
    expect(MemoryService.forMessage("answers").picked).toHaveLength(1);
  });

  it("reads memories saved before this change", () => {
    window.localStorage.setItem("hannah.memory.v1", JSON.stringify([{ id: "old-1", layer: "long_term", tier: "semantic", content: "I prefer dark mode", weight: 1, decay: 0, lastAccessed: "2026-01-01T00:00:00Z", accessCount: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]));
    expect(MemoryService.list()[0]).toMatchObject({ category: "preference", source: { kind: "legacy" }, sensitivity: "normal" });
  });

  it("search never returns sensitive memories, and says how many it held back", () => {
    MemoryService.remember("I take medication for anxiety", { source: { kind: "you" } });
    MemoryService.remember("I like evening walks", { source: { kind: "you" } });
    const result = MemoryService.search("");
    expect(result.memories.map((record) => record.content)).toEqual(["I like evening walks"]);
    expect(result.hiddenSensitive).toBe(1);
  });
});

describe("what goes to the model", () => {
  beforeEach(() => {
    requestStep.mockReset().mockResolvedValue({ content: JSON.stringify({ reply: "ok", emotion: "neutral" }), toolCalls: [] });
    MemoryService.remember("I prefer short answers", { source: { kind: "you" } });
    MemoryService.remember("I take medication for anxiety", { source: { kind: "you" } });
    MemoryService.remember("My dog Bruno is a beagle", { source: { kind: "you" } });
  });
  const turn = (mode: "cloud" | "ollama", model?: string) => {
    resolveMode.mockReset().mockResolvedValue(mode);
    return runAgentTurn({ mode, model, messages: [{ role: "user", content: "Any tips for my anxiety medication schedule?" }], generateLocal: async () => "" });
  };
  const sent = () => requestStep.mock.calls[0][8] as string[];

  it("a hosted model gets the related memories and preferences, never sensitive ones", async () => {
    await turn("cloud", "llama-3.3-70b-versatile");
    expect(sent()).toEqual(["I prefer short answers"]);
  });

  it("Ollama, or Auto in Private routing, also gets sensitive memories", async () => {
    await turn("ollama");
    expect(sent()).toContain("I take medication for anxiety");
    expect(sent()).not.toContain("My dog Bruno is a beagle");

    requestStep.mockClear();
    window.localStorage.setItem("hannah.routing.v1", JSON.stringify({ mode: "private" }));
    await turn("cloud", "auto");
    expect(sent()).toContain("I take medication for anxiety");
    expect(MemoryService.list().find((record) => record.content.includes("anxiety"))!.accessCount).toBeGreaterThan(0);
  });
});
