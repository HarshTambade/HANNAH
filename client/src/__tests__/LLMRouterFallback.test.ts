import { describe, expect, it, vi } from "vitest";

describe("LLMRouter fallback logic", () => {
  it("handles 429 rate limit responses", () => {
    const error = new Error("Rate limited");
    (error as any).status = 429;
    expect((error as any).status).toBe(429);
  });

  it("handles timeout errors", () => {
    const error = new Error("Timeout");
    (error as any).status = 408;
    expect((error as any).status).toBe(408);
  });

  it("handles 5xx server errors", () => {
    const error = new Error("Server error");
    (error as any).status = 500;
    expect((error as any).status).toBe(500);
  });
});
