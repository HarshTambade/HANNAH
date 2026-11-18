import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capgo/capacitor-speech-synthesis", () => ({ SpeechSynthesis: {} }));
vi.mock("../services/api", () => ({ apiFetch: vi.fn(), apiUrl: (path: string) => path, getAccountHint: () => null, getApiAccessToken: () => "", getSessionGroqKey: () => "" }));
vi.mock("../services/AIService", () => ({ getNetworkStatus: async () => ({ connected: false }) }));

const { isEchoOf, isRecentEcho } = await import("../services/EchoGuard");
const { SpeechService, speakNativeUntilDone } = await import("../services/SpeechService");
type NativeSpeechPlugin = Parameters<typeof speakNativeUntilDone>[0];

const reply = "Sure! I've set a reminder for 5 pm to call Aman about the invoice.";

describe("echo guard", () => {
  it("recognises HANNAH's own reply heard back through the microphone", () => {
    expect(isEchoOf("sure I've set a reminder for 5 p.m. to call Aman about the invoice", reply)).toBe(true);
    // Recognition often catches only part of it.
    expect(isEchoOf("set a reminder for 5 pm to call", reply)).toBe(true);
  });

  it("lets the user through: short answers, new requests, and quoting part of the reply", () => {
    expect(isEchoOf("yes", reply)).toBe(false);
    expect(isEchoOf("call Aman", reply)).toBe(false);
    expect(isEchoOf("what's the weather tomorrow in Pune", reply)).toBe(false);
    expect(isEchoOf("no change the reminder to six and also text my brother that I'm running late", reply)).toBe(false);
  });

  it("only while HANNAH speaks or shortly after", () => {
    const heard = "set a reminder for 5 pm to call Aman";
    expect(isRecentEcho(heard, { text: reply, endedAt: Number.POSITIVE_INFINITY })).toBe(true);
    expect(isRecentEcho(heard, { text: reply, endedAt: 1_000 }, 5_000)).toBe(true);
    expect(isRecentEcho(heard, { text: reply, endedAt: 1_000 }, 60_000)).toBe(false);
    expect(isRecentEcho(heard, null)).toBe(false);
  });
});

function fakePlugin({ events = true, speaking = [true, true, false, false] }: { events?: boolean; speaking?: boolean[] } = {}) {
  const listeners = new Map<string, (event: { utteranceId: string }) => void>();
  let removed = 0;
  const polls = [...speaking];
  const plugin: NativeSpeechPlugin = {
    // Like the real plugins: resolves as soon as the text is queued.
    speak: async () => ({ utteranceId: "u1" }),
    isSpeaking: async () => ({ isSpeaking: polls.length ? polls.shift()! : false }),
    addListener: async (event, listener) => { listeners.set(event, listener); return { remove: async () => { removed += 1; } }; },
  };
  return { plugin, finish: (id = "u1") => { if (events) listeners.get("end")?.({ utteranceId: id }); }, removed: () => removed };
}

describe("native speech waits until it has been said", () => {
  it("does not resolve when the text is queued, only when the device reports the end", async () => {
    const { plugin, finish, removed } = fakePlugin({ speaking: Array(50).fill(true) });
    let done = false;
    const speaking = speakNativeUntilDone(plugin, { text: reply }, { pollMs: 5 }).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(done).toBe(false);
    finish("another-utterance");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done, "an end event for a different utterance doesn't count").toBe(false);
    finish();
    await speaking;
    expect(removed()).toBe(2);
  });

  it("still finishes if the end event is missed, once the device stops speaking", async () => {
    const { plugin } = fakePlugin({ events: false, speaking: [true, true, true, false, false] });
    await expect(speakNativeUntilDone(plugin, { text: reply }, { pollMs: 2 })).resolves.toBeUndefined();
  });

  it("cancel ends the wait at once (Android sends no event when stopped)", async () => {
    const { plugin } = fakePlugin({ events: false, speaking: Array(1000).fill(true) });
    const speaking = speakNativeUntilDone(plugin, { text: reply }, { pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await SpeechService.cancel();
    await expect(speaking).resolves.toBeUndefined();
  });
});
