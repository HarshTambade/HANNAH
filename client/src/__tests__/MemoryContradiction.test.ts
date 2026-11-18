import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const stubWindow = () => vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } } }));
stubWindow();
const { MemoryService } = await import("../services/MemoryService");
const { contradicts, factOf } = await import("../services/MemoryModel");
const { memoriesAsMarkdown } = await import("../services/MemoryExportService");

beforeEach(() => { store.clear(); stubWindow(); MemoryService.setTemporaryChat(false); });

describe("memory updates and temporary chat", () => {
  it("reads one-value facts and spots a changed value", () => {
    expect(factOf("My favourite food is biryani")).toEqual({ subject: "favourite food", value: "biryani" });
    expect(factOf("I live in Pune.")).toEqual({ subject: "live", value: "pune" });
    expect(factOf("I prefer VS Code for coding")).toEqual({ subject: "prefer for coding", value: "vs code" });
    expect(contradicts("My favorite food is pizza", "My favourite food is biryani")).toBe(true);
    expect(contradicts("I live in Mumbai", "I now live in Pune")).toBe(true);
    expect(contradicts("I live in Pune", "My favourite food is biryani")).toBe(false);
    expect(factOf("I had a great day")).toBeNull();
  });

  it("a newer value replaces the old one and keeps it as history, instead of keeping both", () => {
    const first = MemoryService.remember("I live in Mumbai", { source: { kind: "you" } });
    expect(first.ok).toBe(true);
    MemoryService.remember("My favourite food is pizza", { source: { kind: "you" } });
    const moved = MemoryService.remember("I live in Pune", { source: { kind: "chat" } });
    expect(moved).toMatchObject({ ok: true, merged: false, replaced: "I live in Mumbai" });
    const homes = MemoryService.list().filter((record) => /live in/.test(record.content));
    expect(homes).toHaveLength(1);
    expect(homes[0].content).toBe("I live in Pune");
    expect(homes[0].previous?.[0].content).toBe("I live in Mumbai");
    expect(MemoryService.list()).toHaveLength(2);
    const markdown = memoriesAsMarkdown();
    expect(markdown).toMatch(/# What HANNAH remembers/);
    expect(markdown).toMatch(/- I live in Pune[\s\S]*Before \d{4}-\d\d-\d\d: I live in Mumbai/);
  });

  it("temporary chat neither uses nor saves memories, and normal chat resumes after it", () => {
    MemoryService.remember("My favourite food is biryani", { source: { kind: "you" } });
    MemoryService.setTemporaryChat(true);
    expect(MemoryService.forMessage("what's my favourite food?").picked).toHaveLength(0);
    expect(MemoryService.search("food").memories).toHaveLength(0);
    const refused = MemoryService.remember("My brother is Aman", { source: { kind: "chat" } });
    expect(refused.ok).toBe(false);
    MemoryService.setTemporaryChat(false);
    expect(MemoryService.forMessage("what's my favourite food?").picked.map((item) => item.memory.content)).toEqual(["My favourite food is biryani"]);
    expect(MemoryService.list()).toHaveLength(1);
  });

  it("secrets are still refused", () => {
    expect(MemoryService.remember("my password is hunter2!", { source: { kind: "chat" } }).ok).toBe(false);
  });
});
