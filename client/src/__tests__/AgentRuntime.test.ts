import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceMode } from "../types";

const { executeTool, requestStep, resolveMode } = vi.hoisted(() => ({
  executeTool: vi.fn(),
  requestStep: vi.fn(),
  resolveMode: vi.fn(),
}));

vi.mock("../services/DeviceTools", () => ({
  getDeviceTools: () => [{
    name: "lookup_weather",
    description: "Look up the weather.",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    execute: executeTool,
  }],
}));
vi.mock("../services/MobileAgent", () => ({ getNativeMemoryTools: vi.fn(async () => []) }));
vi.mock("../services/LLMRouter", () => ({
  LLMRouter: { requestStep, resolveMode },
  shouldUseLocalFallback: () => true,
}));

import { runAgentTurn } from "../services/AgentRuntime";

describe("AgentRuntime tool loop", () => {
  beforeEach(() => {
    executeTool.mockReset().mockResolvedValue({ temperatureC: 22, condition: "sunny" });
    resolveMode.mockReset().mockResolvedValue("cloud");
    requestStep.mockReset()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call-weather-1", name: "lookup_weather", arguments: { city: "Pune" } }],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ reply: "Pune is sunny at 22°C.", emotion: "happy" }),
        toolCalls: [],
      });
  });

  it("parses a JSON tool call, executes the allow-listed tool, and feeds its result back to the model", async () => {
    const result = await runAgentTurn({
      mode: "cloud",
      messages: [{ role: "user", content: "What is the weather in Pune?" }],
      generateLocal: async (_prompt: string, _mode: InferenceMode) => {
        throw new Error("Local inference should not be used for this turn.");
      },
    });

    expect(executeTool).toHaveBeenCalledWith({ city: "Pune" });
    expect(requestStep).toHaveBeenCalledTimes(2);
    const secondStepMessages = requestStep.mock.calls[1][1] as Array<Record<string, unknown>>;
    expect(secondStepMessages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call-weather-1",
      content: JSON.stringify({ temperatureC: 22, condition: "sunny" }),
    }));
    expect(result).toEqual({ reply: "Pune is sunny at 22°C.", emotion: "happy" });
  });
});
