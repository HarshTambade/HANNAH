import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FREE_DAILY_MESSAGE_LIMIT,
  SubscriptionError,
  SubscriptionService,
  subscriptionDay,
} from "../services/SubscriptionService";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
  } as unknown as Storage;
}

const morning = new Date(2026, 10, 15, 9, 30);
const nextMorning = new Date(2026, 10, 16, 9, 30);

describe("SubscriptionService", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: createStorage() });
    vi.stubEnv("VITE_SUBSCRIPTION_BYPASS", "false");
    SubscriptionService.resetAll();
  });

  it("keeps the free tier on local inference modes", () => {
    for (const mode of ["webllm", "native", "ollama"] as const) {
      expect(SubscriptionService.canSendMessage(mode, morning)).toMatchObject({
        allowed: true,
        reason: "ok",
        quota: { tier: "free", used: 0, remaining: FREE_DAILY_MESSAGE_LIMIT },
      });
    }

    for (const mode of ["cloud", "mobileclaw", "desktop"] as const) {
      const decision = SubscriptionService.canSendMessage(mode, morning);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("premium_required");
    }
  });

  it("blocks the 26th successful free turn and preserves the quota in storage", () => {
    for (let index = 0; index < FREE_DAILY_MESSAGE_LIMIT; index += 1) {
      SubscriptionService.recordMessage(morning);
    }

    const exhausted = SubscriptionService.canSendMessage("ollama", morning);
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reason).toBe("daily_limit");
    expect(exhausted.quota).toMatchObject({ used: 25, remaining: 0, limit: 25 });

    const persisted = JSON.parse(window.localStorage.getItem("shanaya.subscription.v1") || "{}");
    expect(persisted).toMatchObject({ tier: "free", used: 25, day: subscriptionDay(morning) });
  });

  it("throws a typed SubscriptionError for blocked turns", () => {
    expect(() => SubscriptionService.assertCanSend("cloud", morning)).toThrow(SubscriptionError);
    try {
      SubscriptionService.assertCanSend("cloud", morning);
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe("premium_required");
      expect((error as SubscriptionError).quota.tier).toBe("free");
    }
  });

  it("gives Premium unlimited messages and every inference mode", () => {
    SubscriptionService.setTier("premium", morning);
    expect(SubscriptionService.canSendMessage("cloud", morning)).toMatchObject({
      allowed: true,
      quota: { tier: "premium", limit: null, remaining: null },
    });

    for (let index = 0; index < FREE_DAILY_MESSAGE_LIMIT * 3; index += 1) {
      SubscriptionService.recordMessage(morning);
    }

    expect(SubscriptionService.getQuota(morning)).toMatchObject({
      tier: "premium",
      used: 0,
      limit: null,
      remaining: null,
    });
  });

  it("resets free usage on the next local calendar day", () => {
    for (let index = 0; index < FREE_DAILY_MESSAGE_LIMIT; index += 1) {
      SubscriptionService.recordMessage(morning);
    }
    expect(SubscriptionService.canSendMessage("ollama", morning).allowed).toBe(false);

    const tomorrow = SubscriptionService.canSendMessage("ollama", nextMorning);
    expect(tomorrow.allowed).toBe(true);
    expect(tomorrow.quota).toMatchObject({ day: subscriptionDay(nextMorning), used: 0, remaining: 25 });
  });

  it("supports the local QA bypass without writing a free counter", () => {
    vi.stubEnv("VITE_SUBSCRIPTION_BYPASS", "true");
    expect(SubscriptionService.canSendMessage("cloud", morning)).toMatchObject({
      allowed: true,
      quota: { tier: "premium" },
    });
    SubscriptionService.recordMessage(morning);
    expect(SubscriptionService.getQuota(morning)).toMatchObject({ tier: "premium", used: 0 });
  });

  it("recovers from malformed persisted state", () => {
    window.localStorage.setItem("shanaya.subscription.v1", "{not-json");
    expect(SubscriptionService.getQuota(morning)).toMatchObject({
      tier: "free",
      used: 0,
      remaining: FREE_DAILY_MESSAGE_LIMIT,
    });
  });
});
