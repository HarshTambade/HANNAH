import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceMode } from "../types";

const { executeTool } = vi.hoisted(() => ({ executeTool: vi.fn(async () => ({ temperature: 20 })) }));

vi.mock("../services/AIService", () => ({
  resolveInferenceMode: (requested: InferenceMode, connected: boolean) => connected ? requested : "webllm",
  getNetworkStatus: async () => ({ connected: true }),
}));
vi.mock("../services/DeviceTools", () => ({
  getDeviceTools: () => [{ name: "lookup_weather", description: "Look up weather", inputSchema: { type: "object", properties: {} }, execute: executeTool }],
  executeHANNAHTool: async (tool: { execute: (args: Record<string, unknown>) => Promise<unknown> }, args: Record<string, unknown>) => tool.execute(args),
}));
vi.mock("../services/MobileAgent", () => ({ getNativeMemoryTools: async () => [] }));
vi.mock("../services/SubscriptionService", () => ({ SubscriptionService: { assertCanSend: vi.fn(), recordMessage: vi.fn() } }));

import { runAgentTurn } from "../services/AgentRuntime";
import { ChaosEngine } from "../services/ChaosEngine";
import { toolCircuitBreaker } from "../services/CircuitBreaker";
import { MemoryRouter } from "../services/MemoryRouter";

function jsonResponse(content: string, toolCalls: unknown[] = []) {
  return new Response(JSON.stringify({ message: { content, tool_calls: toolCalls } }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Phase 25 chaos resilience", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { onLine: true });
    ChaosEngine.resetForTests();
    toolCircuitBreaker.resetSession();
    executeTool.mockClear();
  });

  it("cascades a dropped cloud request to local inference without throwing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ChaosEngine.armOnce("network-drop");
    const local = vi.fn(async (_prompt: string, _mode: InferenceMode) => JSON.stringify({ reply: "Local fallback worked.", emotion: "happy" }));

    const reply = await runAgentTurn({ mode: "cloud", messages: [{ role: "user", content: "Hello" }], generateLocal: local });

    expect(reply.reply).toBe("Local fallback worked.");
    expect(local).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ChaosEngine.getDegraded().degraded).toBe(true);
  });

  it("opens the tool circuit breaker after three timeouts and continues without side effects", async () => {
    const toolCall = (id: string) => ({ id, type: "function", function: { name: "lookup_weather", arguments: "{}" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse("", [toolCall("tool-1")]))
      .mockResolvedValueOnce(jsonResponse("", [toolCall("tool-2")]))
      .mockResolvedValueOnce(jsonResponse("", [toolCall("tool-3")]))
      .mockResolvedValueOnce(jsonResponse(JSON.stringify({ reply: "I could not reach the weather tool, but the app is still responsive.", emotion: "neutral" })));
    vi.stubGlobal("fetch", fetchMock);
    ChaosEngine.armOnce("tool-timeout");
    ChaosEngine.armOnce("tool-timeout");
    ChaosEngine.armOnce("tool-timeout");

    const reply = await runAgentTurn({ mode: "cloud", messages: [{ role: "user", content: "Check weather in Pune" }], generateLocal: async () => "" });

    expect(reply.reply).toContain("app is still responsive");
    expect(toolCircuitBreaker.failures.get("lookup_weather")).toBe(3);
    expect(toolCircuitBreaker.isDisabled("lookup_weather")).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("abstains from corrupted memory retrieval", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "[]", setItem: () => undefined, removeItem: () => undefined } });
    ChaosEngine.armOnce("corrupted-memory");
    const result = await MemoryRouter.route("what do you remember about my project?");
    expect(result.abstained).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.abstentionReason).toMatch(/integrity/i);
  });

  it("stops a multi-step task after the user denies approval", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse("", [{ id: "tool-approval", type: "function", function: { name: "lookup_weather", arguments: "{}" } }])));
    ChaosEngine.armOnce("hitl-denial");
    const reply = await runAgentTurn({ mode: "cloud", messages: [{ role: "user", content: "Check weather in Pune" }], generateLocal: async () => "" });
    expect(reply.reply).toMatch(/declined|cancelled/i);
    expect(executeTool).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce();
  });
});
