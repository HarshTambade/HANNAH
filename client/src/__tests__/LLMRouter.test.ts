import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { InferenceMode } from "../types";

const { getDeviceTools, getNativeMemoryTools, assertCanSend, recordMessage } = vi.hoisted(() => ({
  getDeviceTools: vi.fn(() => []),
  getNativeMemoryTools: vi.fn(async () => []),
  assertCanSend: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock("../services/DeviceTools", () => ({ getDeviceTools }));
vi.mock("../services/MobileAgent", () => ({ getNativeMemoryTools }));
vi.mock("../services/SubscriptionService", () => ({
  SubscriptionService: { assertCanSend, recordMessage },
}));
vi.mock("../services/AIService", () => ({
  getNetworkStatus: vi.fn(async () => ({ connected: true })),
  resolveInferenceMode: (preferred: InferenceMode, connected: boolean) => connected ? preferred : "webllm",
}));

import { runAgentTurn } from "../services/AgentRuntime";

const require = createRequire(import.meta.url);
const providerRuntime = require("../../../server/providers/runtime.js") as {
  requestWithProviderFallback: (options: Record<string, unknown>) => Promise<{
    content: string;
    tool_calls: unknown[];
  }>;
};

const groqProvider = {
  id: "groq",
  label: "Groq",
  kind: "openai",
  baseUrl: "https://api.groq.com/openai/v1",
  local: false,
};

describe("LLM routing failover", () => {
  it("retries Groq with llama-3.1-8b-instant after a primary 429, then uses local inference if the API tiers are exhausted", async () => {
    vi.stubEnv("GROQ_MODELS", "");
    vi.stubEnv("GROQ_MODEL_FALLBACKS", "llama-3.1-8b-instant");
    const groqFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }));
    vi.stubGlobal("fetch", groqFetch);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(providerRuntime.requestWithProviderFallback({
      provider: groqProvider,
      apiKey: "test-groq-key",
      requestedModel: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      systemPrompt: "test system prompt",
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ status: 429 });

    const attemptedModels = groqFetch.mock.calls.map(([, init]) => {
      return JSON.parse(String(init.body)).model;
    });
    expect(attemptedModels).toEqual(["openai/gpt-oss-120b", "llama-3.1-8b-instant"]);

    const appFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/agent/step")) {
        return new Response(JSON.stringify({ detail: "All configured cloud models are rate limited." }), { status: 503 });
      }
      return new Response(JSON.stringify({ error: "Groq rate limit exceeded." }), { status: 429 });
    });
    vi.stubGlobal("fetch", appFetch);
    vi.stubGlobal("navigator", { onLine: true });
    // The loopback Python fallback is only attempted when the app itself runs locally.
    vi.stubGlobal("window", { location: { hostname: "localhost", href: "http://localhost:5173/" } });

    const generateLocal = vi.fn(async (_prompt: string, mode: InferenceMode) => {
      expect(mode).toBe("webllm");
      return JSON.stringify({ reply: "I can keep helping offline.", emotion: "happy" });
    });
    const result = await runAgentTurn({
      mode: "cloud",
      providerId: "groq",
      messages: [{ role: "user", content: "Please continue." }],
      generateLocal,
    });

    expect(result).toEqual({ reply: "I can keep helping offline.", emotion: "happy" });
    expect(appFetch).toHaveBeenCalledTimes(2);
    expect(String(appFetch.mock.calls[0][0])).toContain("/api/agent");
    expect(String(appFetch.mock.calls[1][0])).toContain("/api/agent/step");
    expect(generateLocal).toHaveBeenCalledOnce();
  });
});
