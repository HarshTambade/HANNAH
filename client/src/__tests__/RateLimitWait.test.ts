import { describe, expect, it } from "vitest";
import { rateLimitWaitMs } from "../services/LLMRouter";

describe("waiting out a provider's rate limit", () => {
  it("uses the provider's Retry-After, capped at a minute, or backs off", () => {
    expect(rateLimitWaitMs("27", 0)).toBe(27_000);
    expect(rateLimitWaitMs("999", 0)).toBe(60_000);
    expect(rateLimitWaitMs(null, 0)).toBe(10_000);
    expect(rateLimitWaitMs("soon", 2)).toBe(30_000);
  });
});
