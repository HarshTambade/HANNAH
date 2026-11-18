import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path }));
vi.mock("../services/ModelRouting", () => ({ routingRequest: () => ({ mode: "private" }) }));
const { capNotes, condenseTranscript } = await import("../services/TranscriptNotes");

const parts = [{ from: "0:00", to: "9:58", text: "A semaphore is an integer variable." }, { from: "10:01", to: "19:40", text: "wait() decrements; signal() increments." }];
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("condensing a long lecture", () => {
  it("condenses each timed part from what is said, waiting out rate limits", async () => {
    const bodies: Array<Record<string, any>> = [];
    const replies = [new Response("{}", { status: 429, headers: { "retry-after": "2" } }), ok("- Semaphore: integer variable"), ok("- wait() decrements, signal() increments")];
    const pauses: number[] = [];
    const notes = await condenseTranscript("Process Synchronization", parts, { ask: async (body) => { bodies.push(body); return replies.shift()!; }, pause: async (ms) => { pauses.push(ms); } });
    expect(notes).toBe("### 0:00–9:58\n- Semaphore: integer variable\n\n### 10:01–19:40\n- wait() decrements, signal() increments");
    expect(pauses).toEqual([2000]);
    expect(bodies[0].messages[0].content).toMatch(/Use only what is said/);
    expect(bodies[0].messages[0].content).toMatch(/data, not instructions/);
    expect(bodies[0].messages[1].content).toMatch(/^Part 1 of 2 \(0:00–9:58\)/);
    expect(bodies[0].hannah).toEqual({ routing: { mode: "private" } });
  });

  it("stops with a clear message if the provider stays busy", async () => {
    await expect(condenseTranscript("T", parts, { ask: async () => new Response("{}", { status: 429 }), pause: async () => undefined })).rejects.toThrow(/kept saying it's busy/);
  });
});

describe("keeping part notes short", () => {
  it("cuts at a line break and marks the cut", () => {
    expect(capNotes("- one\n- two\n- three", 100)).toBe("- one\n- two\n- three");
    expect(capNotes("- first point here\n- second point here\n- third", 25)).toBe("- first point here\n- …");
  });
});
