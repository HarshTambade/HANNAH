import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/SpeechService", () => ({ SpeechService: { speak: vi.fn(async () => "Device voice"), cancel: vi.fn(async () => undefined) } }));
vi.mock("../services/VoiceService", () => ({ VoiceService: { startSession: vi.fn() } }));

const { createVad, readVoiceSettings, saveVoiceSettings, VoiceOut } = await import("../services/VoiceEngines");
const { SpeechService } = await import("../services/SpeechService");

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

describe("voice activity detection", () => {
  it("calibrates on room noise, then reports speech start and end", () => {
    const vad = createVad({ minThreshold: 0.02, startMs: 100, endSilenceMs: 200, frameMs: 50 });
    const states = [
      ...Array(6).fill(0.005).map((level) => vad(level)),
      vad(0.1), vad(0.1),
      vad(0.1),
      vad(0.004), vad(0.004), vad(0.004), vad(0.004),
    ];
    expect(states.slice(0, 6).every((state) => state === "calibrating")).toBe(true);
    expect(states).toContain("speech-start");
    expect(states.indexOf("speech-start")).toBe(7);
    // 200 ms of silence after speech ends the utterance.
    expect(states.at(-1)).toBe("speech-end");
    expect(states.slice(8, -1).every((state) => state === "speaking")).toBe(true);
  });

  it("ignores short clicks", () => {
    const vad = createVad({ startMs: 200, frameMs: 50 });
    for (let i = 0; i < 6; i += 1) vad(0.005);
    expect([vad(0.2), vad(0.001), vad(0.2), vad(0.001)]).not.toContain("speech-start");
  });
});

describe("voice settings and engines", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    vi.mocked(SpeechService.speak).mockClear();
  });

  it("defaults to automatic speaking, device listening and barge-in on", () => {
    expect(readVoiceSettings()).toEqual({ tts: "auto", openaiVoice: "coral", systemVoice: "", stt: "system", bargeIn: true });
    expect(saveVoiceSettings({ tts: "openai", openaiVoice: "nova" }).tts).toBe("openai");
    expect(readVoiceSettings().openaiVoice).toBe("nova");
  });

  it("uses only the device voice when chosen", async () => {
    saveVoiceSettings({ tts: "system", systemVoice: "Samantha" });
    await expect(VoiceOut.speak("hi", "en-US")).resolves.toBe("Device voice");
    expect(SpeechService.speak).toHaveBeenCalledWith("hi", "en-US", { systemOnly: true, voiceName: "Samantha" });
  });
});
