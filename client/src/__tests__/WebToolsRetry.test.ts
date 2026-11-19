import { beforeEach, describe, expect, it, vi } from "vitest";

const replies = vi.hoisted(() => ({ queue: [] as Response[], calls: 0 }));
vi.mock("../services/api", () => ({
  apiUrl: (path: string) => path,
  apiFetch: vi.fn(async () => { replies.calls += 1; return replies.queue.shift() ?? new Response("{}", { status: 500 }); }),
}));

const { postForTests } = await import("../services/WebTools");
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("web search waits out a short rate limit once", () => {
  beforeEach(() => { replies.queue = []; replies.calls = 0; });

  it("a 429 with a short Retry-After is waited out, then the search succeeds", async () => {
    replies.queue.push(json({ error: "Groq is busy" }, 429, { "retry-after": "3" }), json({ answer: "Go 1.25", sources: [] }));
    const slept: number[] = [];
    const result = await postForTests<{ answer: string }>("/api/web/search", { query: "go" }, 5_000, async (ms) => { slept.push(ms); });
    expect(result.answer).toBe("Go 1.25");
    expect(slept).toEqual([3_000]);
    expect(replies.calls).toBe(2);
  });

  it("a long Retry-After or a second 429 fails saying not to retry now", async () => {
    replies.queue.push(json({ error: "Groq is busy right now." }, 429, { "retry-after": "60" }));
    await expect(postForTests("/api/web/search", { query: "go" }, 5_000, async () => {})).rejects.toThrow("Don't retry now");
    expect(replies.calls).toBe(1);
    replies.calls = 0;
    replies.queue.push(json({}, 429, { "retry-after": "1" }), json({ error: "Still busy" }, 429, { "retry-after": "1" }));
    await expect(postForTests("/api/web/search", { query: "go" }, 5_000, async () => {})).rejects.toThrow("over their rate limit");
    expect(replies.calls).toBe(2);
  });

  it("other errors fail at once", async () => {
    replies.queue.push(json({ error: "Web search failed (Groq answered 500)." }, 502));
    await expect(postForTests("/api/web/search", { query: "go" }, 5_000, async () => {})).rejects.toThrow("Groq answered 500");
    expect(replies.calls).toBe(1);
  });
});
