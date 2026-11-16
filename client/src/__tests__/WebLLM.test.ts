import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mlc-ai/web-llm", () => ({ CreateWebWorkerMLCEngine: vi.fn() }));

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, dump: () => Object.fromEntries(store) };
}

describe("WebLLM", () => {
  beforeEach(() => vi.resetModules());

  it("explains failures in plain language", async () => {
    const { describeWebLLMError } = await import("../services/WebLLM");
    expect(describeWebLLMError(new Error("QuotaExceededError: storage full"))).toMatch(/ran out of storage/);
    expect(describeWebLLMError(new TypeError("Failed to fetch"))).toMatch(/Couldn't download the model/);
    expect(describeWebLLMError(new Error("GPU device was lost"))).toMatch(/GPU ran out of memory/);
    expect(describeWebLLMError(new Error("This model requires feature shader-f16"))).toMatch(/16-bit/);
    expect(describeWebLLMError(new Error("something odd"))).toBe("The browser model failed: something odd");
  });

  it("detects whether WebGPU can run", async () => {
    const { detectWebGPU } = await import("../services/WebLLM");
    vi.stubGlobal("navigator", {});
    expect((await detectWebGPU()).supported).toBe(false);
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
    expect(await detectWebGPU()).toMatchObject({ supported: false, reason: expect.stringMatching(/hardware acceleration/) });
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    expect(await detectWebGPU()).toEqual({ supported: true });
  });

  it("reports unsupported browsers instead of loading forever", async () => {
    vi.stubGlobal("navigator", {});
    const { loadWebLLM, getWebLLMState } = await import("../services/WebLLM");
    await loadWebLLM("Llama-3.2-1B-Instruct-q4f16_1-MLC");
    expect(getWebLLMState()).toMatchObject({ status: "unsupported", error: expect.stringMatching(/WebGPU/) });
  });

  it("gives up only after a long stall, not a slow first download", async () => {
    const { STALL_TIMEOUT_MS } = await import("../services/WebLLM");
    expect(STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});

describe("Use in chat", () => {
  beforeEach(() => vi.resetModules());

  it("saves a hosted choice for cloud mode and an Ollama choice for local mode", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const { applyToChat } = await import("../services/ModelAdvisor");
    expect(applyToChat("openai", "gpt-4.1-mini")).toBe(true);
    expect(storage.dump()).toMatchObject({
      "hannah.chat.mode": "cloud",
      "hannah.cloudProvider": "openai",
      "hannah.cloudModel:openai": "gpt-4.1-mini",
      "hannah.cloudModel.chosen:openai": "gpt-4.1-mini",
    });
    expect(applyToChat("ollama", "llama3.2:3b")).toBe(true);
    expect(storage.dump()).toMatchObject({ "hannah.chat.mode": "ollama", "hannah.ollamaModel": "llama3.2:3b" });
  });
});
