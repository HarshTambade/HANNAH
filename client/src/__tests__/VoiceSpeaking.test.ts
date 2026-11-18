import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Speaking a whole reply, stopping cleanly, and never hearing herself as the person.
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web", isNativePlatform: () => false, isPluginAvailable: () => false }, registerPlugin: () => ({}) }));
vi.mock("@capgo/capacitor-speech-synthesis", () => ({ SpeechSynthesis: {} }));
const session = vi.hoisted(() => ({ token: "" }));
vi.mock("../services/api", () => ({ apiFetch: vi.fn(async () => new Response("", { status: 503 })), apiUrl: (path: string) => path, getAccountHint: () => null, getApiAccessToken: () => session.token, getSessionGroqKey: () => "" }));
const net = vi.hoisted(() => ({ connected: false }));
vi.mock("../services/AIService", () => ({ getNetworkStatus: async () => ({ connected: net.connected }) }));

const { chunkForSpeech, speakableText } = await import("../services/SpeakableText");
const { SpeechService, speakInBrowser } = await import("../services/SpeechService");
const { isRecentEcho, isTailEcho } = await import("../services/EchoGuard");
const { createEchoAwareVad } = await import("../services/VoiceEngines");

/** A browser speechSynthesis that records utterances; `stall` pieces never fire onend (Chrome's bug). */
function fakeSynthesis({ stall = new Set<number>(), autoEnd = true } = {}) {
  const spoken: string[] = [];
  let cancels = 0;
  const synthesis = {
    getVoices: () => [{ name: "Samantha", lang: "en-US" }],
    cancel: () => { cancels += 1; },
    speak: (utterance: { text: string; onend?: () => void }) => {
      const index = spoken.length;
      spoken.push(utterance.text);
      if (autoEnd && !stall.has(index)) setTimeout(() => utterance.onend?.(), 1);
    },
  };
  class Utterance {
    text: string; voice: unknown; lang = ""; pitch = 1; rate = 1; volume = 1;
    onend?: () => void; onerror?: (event: { error: string }) => void;
    constructor(text: string) { this.text = text; }
  }
  vi.stubGlobal("window", { speechSynthesis: synthesis });
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  return { spoken, cancels: () => cancels };
}

const longReply = Array.from({ length: 30 }, (_, index) => `This is sentence number ${index + 1} of a long answer about your trip to Pune.`).join(" ");

afterEach(() => { vi.useRealTimers(); });

describe("the whole reply is spoken", () => {
  it("splits a long reply into pieces under the limit, in order, losing nothing", () => {
    const pieces = chunkForSpeech(longReply, 200);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((piece) => piece.length <= 200)).toBe(true);
    expect(pieces.join(" ")).toBe(longReply);
    const run = "word ".repeat(120).trim();
    const split = chunkForSpeech(run, 100);
    expect(split.every((piece) => piece.length <= 100)).toBe(true);
    expect(split.join(" ")).toBe(run);
  });

  it("doesn't read Markdown, code or links aloud", () => {
    const said = speakableText("**Done!** Here's the fix:\n\n```js\nconst a = 1;\n```\n\n- Open [the docs](https://example.com/docs)\n- See https://example.com/x");
    expect(said).not.toMatch(/[*`]|https?:|const a/);
    expect(said).toContain("Done!");
    expect(said).toContain("There's code in the chat");
    expect(said).toContain("Open the docs");
  });

  it("the browser voice says every piece, and a piece Chrome stalls on doesn't stop the rest", async () => {
    const synthesis = fakeSynthesis({ stall: new Set([2]) });
    vi.useFakeTimers();
    const done = SpeechService.speak(longReply, "en-US", { systemOnly: true });
    await vi.runAllTimersAsync();
    await expect(done).resolves.toBe("Samantha");
    expect(synthesis.spoken.join(" ")).toBe(longReply);
    expect(synthesis.cancels()).toBe(1);
  });

  it("a stalled utterance ends by its watchdog instead of leaving HANNAH stuck speaking", async () => {
    fakeSynthesis({ autoEnd: false });
    vi.useFakeTimers();
    const done = speakInBrowser("Hello there.", "en-US", "", { watchdogMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    await expect(done).resolves.toBe("Samantha");
  });

  it("stopping her stops the remaining pieces", async () => {
    const synthesis = fakeSynthesis({ autoEnd: false });
    vi.useFakeTimers();
    const done = SpeechService.speak(longReply, "en-US", { systemOnly: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(synthesis.spoken).toHaveLength(1);
    await SpeechService.cancel();
    await vi.runAllTimersAsync();
    await done;
    expect(synthesis.spoken).toHaveLength(1);
  });
});

describe("she never answers herself", () => {
  const reply = "I've added the reminder for tomorrow at nine. Is there anything else you need today?";
  it("the last words caught by the microphone just after she stops are echo, however short", () => {
    expect(isTailEcho("you need today", reply)).toBe(true);
    expect(isTailEcho("today", reply)).toBe(true);
    expect(isRecentEcho("need today", { text: reply, endedAt: 1_000 }, 2_000)).toBe(true);
    // The person answering is not.
    expect(isRecentEcho("yes", { text: reply, endedAt: 1_000 }, 2_000)).toBe(false);
    expect(isRecentEcho("no thanks", { text: reply, endedAt: 1_000 }, 2_000)).toBe(false);
    expect(isRecentEcho("also call Aman", { text: reply, endedAt: 1_000 }, 2_000)).toBe(false);
  });

  it("her reply recognised out of order or with missing words is still echo", () => {
    expect(isRecentEcho("reminder added tomorrow nine anything else need", { text: reply, endedAt: Number.POSITIVE_INFINITY })).toBe(true);
    expect(isRecentEcho("change the reminder to ten and text my brother", { text: reply, endedAt: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe("barge-in hears the person, not HANNAH", () => {
  const frames = (vad: ReturnType<typeof createEchoAwareVad>, levels: number[]) => levels.map((level) => vad(level));
  // Her voice through the speakers: loud and uneven (0.12–0.3), like real speech at a laptop microphone.
  const herVoice = (count: number) => Array.from({ length: count }, (_, index) => 0.12 + 0.18 * Math.abs(Math.sin(index * 0.7)));

  it("her own voice, even loud, never stops her", () => {
    const vad = createEchoAwareVad();
    expect(frames(vad, herVoice(400))).not.toContain("speech-start");
  });

  it("a server voice that starts two seconds late is learned when it starts", () => {
    const vad = createEchoAwareVad();
    expect(frames(vad, [...Array(40).fill(0.005), ...herVoice(300)])).not.toContain("speech-start");
  });

  it("the person talking over her does stop her", () => {
    const vad = createEchoAwareVad();
    const states = frames(vad, [...herVoice(60), ...Array(12).fill(0.75)]);
    expect(states.filter((state) => state === "speech-start")).toHaveLength(1);
  });
});

beforeEach(() => { vi.restoreAllMocks(); });

describe("the server voice is used only where it's offered", () => {
  it("asks once per session, shares the request, doesn't hold up speech, and asks again after signing in differently", async () => {
    const { apiFetch } = await import("../services/api");
    const { resetVoiceAvailability } = await import("../services/SpeechService");
    resetVoiceAvailability();
    const calls: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      calls.push(String(input));
      if (String(input).includes("/api/voice/providers")) return new Response(JSON.stringify({ mithi: false }), { status: 200 });
      return new Response("", { status: 403 });
    });
    net.connected = true;
    const synthesis = fakeSynthesis();
    await Promise.all([SpeechService.speak("First reply.", "en-US"), SpeechService.speak("Second reply.", "en-US")]);
    await SpeechService.speak("Third reply.", "en-US");
    expect(calls.filter((url) => url.includes("/api/voice/providers"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("/api/tts"))).toBe(false);
    expect(synthesis.spoken.length).toBeGreaterThan(0);
    session.token = "operator-token-that-changed-0123456789";
    await SpeechService.speak("After signing in.", "en-US");
    expect(calls.filter((url) => url.includes("/api/voice/providers"))).toHaveLength(2);
    net.connected = false;
  });
});
