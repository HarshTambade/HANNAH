import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../services/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args), apiUrl: (path: string) => path }));
vi.mock("../services/ModelRouting", () => ({ readRoutingPreferences: () => ({ mode: "balanced" }) }));
vi.mock("../services/LLMRouter", () => ({ DAILY_BUDGET_KEY: "hannah.budget.dailyUsd" }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/filesystem", () => ({ Directory: { Documents: "DOCUMENTS" }, Filesystem: { writeFile: vi.fn() } }));

// A small window: storage and events. There is no IndexedDB here, so files are held for the session, as in a private window.
function storage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, String(value)), removeItem: (key) => void data.delete(key), clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
const target = new EventTarget();
(globalThis as { window?: unknown }).window = { localStorage: storage(), sessionStorage: storage(), addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target), setTimeout };

import { generateImage, generateVideo, getMediaTools, mediaIntent, promptFrom, runMediaTurn, secondsIn } from "../services/Media";
import { STUDIO_EVENT, getFile, getLastFiles, listFiles } from "../services/Studio";
import { summarizeToolResult } from "../services/ToolResultSummary";
import { selectToolsForRequest } from "../services/AgentRouter";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);
const PNG = btoa("\x89PNG fake image");

beforeEach(() => { apiFetch.mockReset(); window.localStorage.clear(); });

describe("what a chat message asks to be generated", () => {
  it("takes plain requests for a picture", () => {
    expect(mediaIntent("draw a red fox in snow")).toEqual({ kind: "image", prompt: "a red fox in snow", aspect: "1:1" });
    expect(mediaIntent("Can you draw me a cat wearing a hat?")).toMatchObject({ kind: "image", prompt: "a cat wearing a hat?" });
    expect(mediaIntent("Generate an image of a lighthouse at dusk, landscape")).toEqual({ kind: "image", prompt: "a lighthouse at dusk, landscape", aspect: "16:9" });
    expect(mediaIntent("make a logo for my bakery")).toMatchObject({ kind: "image", prompt: "a logo for my bakery" });
  });

  it("takes plain requests for a clip, with its length", () => {
    expect(mediaIntent("make a 5-second clip of waves")).toEqual({ kind: "video", prompt: "waves", aspect: "16:9", seconds: 5 });
    expect(mediaIntent("generate a 10 second video of a dog running on a beach, vertical")).toEqual({ kind: "video", prompt: "a dog running on a beach, vertical", aspect: "9:16", seconds: 10 });
    expect(mediaIntent("create a short animation of a spinning globe")).toMatchObject({ kind: "video", seconds: 5 });
    expect(secondsIn("a 40 second clip")).toBe(15);
  });

  it("leaves everything else to the agent", () => {
    for (const text of ["What's the weather?", "describe this image", "Can we do a video call later?", "Create a PDF report with pictures of the results", "find an image of the Eiffel Tower", "summarize this video", "I love that picture you made", "show me photos from my trip"]) {
      expect(mediaIntent(text), text).toEqual({ kind: "none" });
    }
  });

  it("with Create on, the whole message is the description", () => {
    expect(mediaIntent("a cosy cabin in the woods", { forced: "image" })).toEqual({ kind: "image", prompt: "a cosy cabin in the woods", aspect: "1:1" });
    expect(mediaIntent("rain on a window, 8 seconds", { forced: "video" })).toMatchObject({ kind: "video", seconds: 8 });
    expect(promptFrom("please")).toBe("please");
  });
});

describe("generating", () => {
  it("an image is kept with the files, announced, and doesn't become the last document", async () => {
    window.localStorage.setItem("hannah.budget.dailyUsd", "2");
    apiFetch.mockResolvedValueOnce(json({ provider: "xai", providerLabel: "xAI Grok", model: "grok-imagine-image-2.0", aspect: "1:1", costUsd: 0.07, images: [{ mime: "image/png", bytes: 15, data: PNG }] }));
    const seen: unknown[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(STUDIO_EVENT, listen);
    const made = await generateImage("a red fox in snow");
    window.removeEventListener(STUDIO_EVENT, listen);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/media/image");
    expect(bodyOf(apiFetch.mock.calls[0])).toEqual({ prompt: "a red fox in snow", aspect: "1:1", n: 1, budget: { dailyUsd: 2 } });
    expect(made.files[0]).toMatchObject({ format: "image", mime: "image/png", name: "hannah-a-red-fox-in-snow.png" });
    expect(made.files[0].summary).toMatchObject({ provider: "xAI Grok", prompt: "a red fox in snow", costUsd: 0.07 });
    const stored = await getFile(made.files[0].id);
    expect(atob(btoa(String.fromCharCode(...stored!.data)))).toContain("PNG");
    expect((await listFiles()).some((file) => file.id === made.files[0].id)).toBe(true);
    expect(seen).toContainEqual({ kind: "media-result", ids: [made.files[0].id] });
    expect(getLastFiles().some((file) => file.id === made.files[0].id)).toBe(false);
  });

  it("a video is a job polled until the mp4 arrives", async () => {
    apiFetch
      .mockResolvedValueOnce(json({ job: { provider: "xai", id: "req_1" }, seconds: 5, aspect: "16:9", model: "grok-imagine-video-1.5", providerLabel: "xAI Grok" }, 202))
      .mockResolvedValueOnce(json({ status: "pending", progress: 30 }))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(json({ status: "done", model: "grok-imagine-video-1.5", video: { mime: "video/mp4", bytes: 8, data: btoa("mp4bytes"), duration: 5 } }));
    const progress: Array<number | null> = [];
    const made = await generateVideo("waves at sunset", { seconds: 5, pollMs: 1, onProgress: (value) => progress.push(value) });
    expect(apiFetch.mock.calls.map((call) => call[0])).toEqual(["/api/media/video", "/api/media/video/xai/req_1", "/api/media/video/xai/req_1", "/api/media/video/xai/req_1"]);
    expect(progress).toEqual([null, 30]);
    expect(made.file).toMatchObject({ format: "video", mime: "video/mp4", name: "hannah-waves-at-sunset.mp4" });
    expect(made.file.summary).toMatchObject({ seconds: 5 });
  });

  it("a refusal, a missing key or a provider's no is HANNAH's reply, not an error", async () => {
    apiFetch.mockResolvedValueOnce(json({ error: "I don't make pictures or videos of real private people.", reason: "private-person" }, 422));
    expect(await runMediaTurn({ kind: "image", prompt: "my neighbour Sarah", aspect: "1:1" })).toEqual({ reply: "I don't make pictures or videos of real private people.", mediaIds: [] });
    apiFetch.mockResolvedValueOnce(json({ error: "Video generation isn't set up: it needs an xAI key.", reason: "media-unavailable" }, 403));
    expect((await runMediaTurn({ kind: "video", prompt: "waves", aspect: "16:9", seconds: 5 })).reply).toMatch(/needs an xAI key/);
    apiFetch.mockResolvedValueOnce(json({ error: "OpenAI declined this request: rejected by the safety system.", reason: "provider-refused" }, 400));
    expect((await runMediaTurn({ kind: "image", prompt: "x", aspect: "1:1" })).reply).toBe("OpenAI declined this request: rejected by the safety system.");
    apiFetch.mockResolvedValueOnce(json({ error: "Something broke." }, 500));
    await expect(runMediaTurn({ kind: "image", prompt: "x", aspect: "1:1" })).rejects.toThrow("Something broke.");
  });
});

describe("tools", () => {
  it("the agent gets generate_image, and generate_video asks for approval first", async () => {
    const tools = getMediaTools();
    expect(tools.map((tool) => tool.name)).toEqual(["generate_image", "generate_video"]);
    const video = tools[1];
    expect(video.requiresApproval).toBe(true);
    expect(video.approvalDetails?.({ prompt: "waves", seconds: 99 })).toMatchObject({ clip: "waves", seconds: 15 });
    apiFetch.mockResolvedValueOnce(json({ provider: "openai", providerLabel: "OpenAI", model: "gpt-image-2", aspect: "16:9", images: [{ mime: "image/png", bytes: 15, data: PNG }] }));
    const out = await tools[0].execute({ prompt: "a fox", aspect: "16:9" }) as { message: string };
    expect(out.message).toMatch(/already sees it/);
    expect(bodyOf(apiFetch.mock.calls[0]).aspect).toBe("16:9");
    expect(summarizeToolResult("generate_image", out)).toBe("Made an image");
  });

  it("a request that mentions a picture keeps the media tools when tools are trimmed", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ name: `tool_${index}`, description: "", inputSchema: { type: "object" as const, properties: {} }, execute: async () => ({}) }));
    const chosen = selectToolsForRequest([...many, ...getMediaTools()], "please draw a picture of a dragon");
    expect(chosen.map((tool) => tool.name)).toEqual(expect.arrayContaining(["generate_image", "generate_video"]));
  });
});
