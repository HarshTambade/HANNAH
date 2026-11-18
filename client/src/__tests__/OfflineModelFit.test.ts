import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web", isPluginAvailable: () => false }, registerPlugin: () => ({}) }));
const { fitForOfflineModel } = await import("../services/AIService");

describe("fitting a conversation into the on-device model", () => {
  it("an agent prompt keeps its rules at the start and the current question at the end", () => {
    const prompt = `RULES: never act without approval.\\n${"tool schema ".repeat(900)}\\nuser: what's the weather in Pune right now?`;
    const [message] = fitForOfflineModel([{ role: "user", content: prompt }]);
    expect(message.content.length).toBeLessThanOrEqual(5_600);
    expect(message.content.startsWith("RULES: never act without approval.")).toBe(true);
    expect(message.content.endsWith("what's the weather in Pune right now?")).toBe(true);
  });

  it("keeps the newest messages first and drops the oldest when the budget runs out", () => {
    const history = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index} ${"word ".repeat(400)}` }));
    const fitted = fitForOfflineModel(history);
    expect(fitted.at(-1)?.content.startsWith("turn 7")).toBe(true);
    expect(fitted.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(5_600);
    expect(fitted.length).toBeLessThan(8);
  });
});
