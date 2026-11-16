import { describe, expect, it } from "vitest";
import { defaultHardware, estimateMemory, kvBytesPerToken, recommend, type HardwareProfile, type ModelCatalog } from "../services/ModelAdvisor";
import profileData from "../../../shared/model-profiles.json";

const llama8b = profileData.open.find((model) => model.id === "llama3.1-8b")!;
const catalog: ModelCatalog = {
  byok: false,
  providers: [
    { id: "groq", label: "Groq", kind: "openai", local: false, free: true, configured: true, models: [
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", tools: true, vision: false, context: 131072, free: true, price: null },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant", tools: true, vision: false, context: 131072, free: true, price: null },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout", tools: true, vision: false, context: 131072, free: true, price: null },
      { id: "whisper-large-v3-turbo", label: "Whisper", tools: false, vision: false, context: null, free: true, notes: "Audio transcription, not chat.", price: null },
    ] },
    { id: "openai", label: "OpenAI", kind: "openai", local: false, free: false, configured: false, models: [
      { id: "gpt-4.1", label: "GPT-4.1", tools: true, vision: true, context: 1047576, free: false, price: { inputPerMTok: 2, outputPerMTok: 8, currency: "USD" } },
      { id: "gpt-4o-mini", label: "GPT-4o mini", tools: true, vision: true, context: 128000, free: false, price: { inputPerMTok: 0.15, outputPerMTok: 0.6, currency: "USD" } },
    ] },
  ],
};
const laptop = (overrides: Partial<HardwareProfile> = {}): HardwareProfile => ({ ...defaultHardware(), os: "linux", ramGB: 16, reservedGB: 4, ...overrides });

describe("memory estimate", () => {
  it("computes the fp16 KV cache from the architecture", () => {
    // Llama 3.1 8B: 2 (K,V) × 32 layers × 8 KV heads × 128 dims × 2 bytes.
    expect(kvBytesPerToken(llama8b)).toBe(131072);
    const estimate = estimateMemory(llama8b, 8192, laptop());
    expect(estimate.kvGB).toBeCloseTo(1, 5);
  });

  it("counts context length, not just the weights", () => {
    const short = estimateMemory(llama8b, 4096, laptop());
    const long = estimateMemory(llama8b, 131072, laptop());
    expect(long.totalGB - short.totalGB).toBeGreaterThan(15);
    expect(long.placement).toBe("too-large");
  });

  it("subtracts memory reserved for other apps", () => {
    // ≈ 6.7 GB total: fits in 12 GB with 2 GB reserved, not with 6 GB reserved.
    expect(estimateMemory(llama8b, 8192, laptop({ ramGB: 12, reservedGB: 2 })).placement).toBe("cpu");
    expect(estimateMemory(llama8b, 8192, laptop({ ramGB: 12, reservedGB: 6 })).placement).toBe("too-large");
  });

  it("places models in VRAM, splits them, or uses unified memory", () => {
    const gpu = laptop({ gpuKind: "discrete", vramGB: 12 });
    expect(estimateMemory(llama8b, 8192, gpu).placement).toBe("gpu");
    const big = profileData.open.find((model) => model.id === "qwen2.5-coder-32b")!;
    expect(estimateMemory(big, 8192, laptop({ ramGB: 32, gpuKind: "discrete", vramGB: 12 })).placement).toBe("split");
    expect(estimateMemory(big, 8192, laptop({ ramGB: 36, gpuKind: "apple" })).placement).toBe("unified");
  });

  it("reports unknown when RAM isn't known", () => {
    expect(estimateMemory(llama8b, 8192, laptop({ ramGB: null })).placement).toBe("unknown");
  });
});

describe("recommend", () => {
  const needs = { task: "chat" as const, budget: "professional" as const, priority: "best" as const, contextTokens: 8192 };

  it("keeps private work on the device", () => {
    const result = recommend({ ...needs, task: "private-docs", priority: "privacy" }, laptop(), catalog);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((item) => item.kind === "local")).toBe(true);
  });

  it("never recommends local models that don't fit", () => {
    const result = recommend({ ...needs, budget: "free-local" }, laptop({ ramGB: 8, reservedGB: 3 }), catalog);
    expect(result.recommendations.every((item) => item.kind === "local")).toBe(true);
    expect(result.recommendations.some((item) => item.model === "llama3.3:70b")).toBe(false);
    expect(result.recommendations.some((item) => item.model === "llama3.2:3b")).toBe(true);
  });

  it("only offers vision-capable models for image tasks", () => {
    const result = recommend({ ...needs, task: "vision" }, laptop(), catalog);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((item) => item.useCase.toLowerCase().includes("image"))).toBe(true);
  });

  it("skips non-chat models such as speech transcription", () => {
    const result = recommend(needs, laptop(), catalog);
    expect(result.recommendations.some((item) => item.model.includes("whisper"))).toBe(false);
  });

  it("doesn't send simple chat to a frontier model unless asked for the best", () => {
    const everyday = recommend({ ...needs, priority: "fastest", budget: "free-hosted" }, laptop({ online: true }), catalog);
    expect(everyday.recommendations[0].tier).not.toBe("frontier");
    const best = recommend({ ...needs, task: "coding", budget: "free-hosted" }, laptop(), catalog);
    expect(best.recommendations[0].model).toBe("openai/gpt-oss-120b");
  });

  it("respects a low-cost budget and estimates monthly cost", () => {
    const result = recommend({ ...needs, budget: "low-cost", priority: "cheapest", monthlyMessages: 1000 }, laptop({ ramGB: 4 }), catalog);
    expect(result.recommendations.some((item) => item.model === "gpt-4.1")).toBe(false);
    const mini = result.recommendations.find((item) => item.model === "gpt-4o-mini");
    // An unverified list price is labelled as such and never turned into an estimate.
    expect(mini?.monthlyCostUsd).toBeNull();
    expect(mini?.cost).toMatch(/not verified/);

    const verifiedCatalog = {
      ...catalog,
      providers: catalog.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => (model.id === "gpt-4o-mini" && model.price ? { ...model, price: { ...model.price, verified: "2026-11-01" } } : model)),
      })),
    };
    const verified = recommend({ ...needs, budget: "low-cost", priority: "cheapest", monthlyMessages: 1000 }, laptop({ ramGB: 4 }), verifiedCatalog)
      .recommendations.find((item) => item.model === "gpt-4o-mini");
    // 1000 × (1500 × $0.15 + 500 × $0.60) / 1M
    expect(verified?.monthlyCostUsd).toBeCloseTo(0.525, 5);
    expect(verified?.cost).toMatch(/checked 2026-11-01/);
  });

  it("marks models from unconfigured providers as needing a key", () => {
    const result = recommend({ ...needs, task: "vision" }, laptop(), catalog);
    const gpt = result.recommendations.find((item) => item.model === "gpt-4.1");
    expect(gpt?.available).toBe(false);
    expect(gpt?.action.type).toBe("configure");
  });

  it("pairs a local and a cloud model in hybrid mode", () => {
    const result = recommend({ ...needs, task: "coding", budget: "hybrid" }, laptop(), catalog);
    expect(result.hybrid?.local?.kind).toBe("local");
    expect(result.hybrid?.cloud?.kind).toBe("hosted");
  });

  it("falls back to local models when offline", () => {
    const result = recommend(needs, laptop({ online: false }), catalog);
    expect(result.recommendations.every((item) => item.kind === "local")).toBe(true);
  });
});
