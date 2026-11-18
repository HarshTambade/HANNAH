import { Capacitor } from "@capacitor/core";
import { SpeechSynthesis } from "@capgo/capacitor-speech-synthesis";
import type { SpeechLanguage } from "../types";
import { apiFetch, apiUrl } from "./api";
import { getNetworkStatus } from "./AIService";
import { chunkForSpeech } from "./SpeakableText";

/** Bumped by cancel(): a reply being spoken piece by piece stops before its next piece. */
let generation = 0;
/** The server voice's audio element while it plays, so cancel() can stop it too. */
let currentAudio: HTMLAudioElement | null = null;

const voiceNames: Record<SpeechLanguage, string[]> = {
  "en-US": ["charvi", "zoe", "ava", "aria", "allison", "samantha", "victoria", "serena", "female", "woman"],
  "hi-IN": ["charvi", "lekha", "aditi", "neelam", "swara", "female", "woman"],
  "mr-IN": ["charvi", "aditi", "swara", "lekha", "female", "woman"],
};

const softVoiceStyle = { pitch: 1.18, rate: 0.84, volume: 0.86 };

function preferredVoice<T extends { name: string }>(voices: T[], language: SpeechLanguage) {
  for (const term of voiceNames[language]) {
    const match = voices.find((voice) => voice.name.toLowerCase().includes(term));
    if (match) return match;
  }
  return undefined;
}

/**
 * One piece in the browser. Chrome sometimes stops an utterance and never
 * fires onend; the watchdog (well past the time the piece takes to say)
 * ends the wait so HANNAH isn't stuck "speaking". Exported for tests.
 */
export function speakInBrowser(text: string, language: SpeechLanguage, voiceName = "", { first = true, watchdogMs }: { first?: boolean; watchdogMs?: number } = {}) {
  const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
    throw new Error(`Speech output is unavailable for ${language} on this device.`);
  }

  return new Promise<string>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const prefix = language.split("-")[0].toLowerCase();
    const voices = synthesis.getVoices();
    const matchingVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(prefix));
    const softFemaleVoices = matchingVoices.filter((voice) => !/\b(male|david|fred|daniel|james|tom|alex)\b/i.test(voice.name));
    const chosen = voiceName ? voices.find((candidate) => candidate.name === voiceName) : undefined;
    const voice = chosen
      ?? preferredVoice(softFemaleVoices, language)
      ?? softFemaleVoices.find((candidate) => /\b(female|woman)\b/i.test(candidate.name))
      ?? softFemaleVoices[0]
      ?? preferredVoice(matchingVoices, language)
      ?? matchingVoices[0];
    if (voice) utterance.voice = voice;
    utterance.lang = language;
    utterance.pitch = softVoiceStyle.pitch;
    utterance.rate = softVoiceStyle.rate;
    utterance.volume = softVoiceStyle.volume;
    const name = voice?.name || `${language} system voice`;
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      done();
    };
    const limit = watchdogMs ?? 8_000 + text.length * 160;
    const watchdog = setTimeout(() => finish(() => resolve(name)), limit);
    utterance.onend = () => finish(() => resolve(name));
    utterance.onerror = (event) => finish(() => (event.error === "interrupted" || event.error === "canceled"
      ? resolve(name)
      : reject(new Error(event.error === "not-allowed" ? "Allow speech output in your browser and try again." : `Browser speech output failed (${event.error}).`))));
    // Only the first piece clears what was playing; later pieces follow it.
    if (first) synthesis.cancel();
    synthesis.speak(utterance);
  });
}

/** Say every piece in the browser, in order, until cancel(). */
async function speakAllInBrowser(text: string, language: SpeechLanguage, voiceName: string, run: number) {
  let name = `${language} system voice`;
  const pieces = chunkForSpeech(text, 200);
  for (let index = 0; index < pieces.length; index += 1) {
    if (run !== generation) break;
    name = await speakInBrowser(pieces[index], language, voiceName, { first: index === 0 });
  }
  return name;
}

type NativeSpeakOptions = Parameters<typeof SpeechSynthesis.speak>[0];
type UtteranceEvent = { utteranceId: string };
export type NativeSpeechPlugin = {
  speak: (options: NativeSpeakOptions) => Promise<{ utteranceId: string }>;
  isSpeaking: () => Promise<{ isSpeaking: boolean }>;
  addListener: (event: "end" | "error", listener: (event: UtteranceEvent) => void) => Promise<{ remove: () => Promise<void> }>;
};

let releaseNativeWait: (() => void) | null = null;

/**
 * The native plugins resolve speak() as soon as the text is queued, not when
 * it has been said. Wait for the device to report this utterance finished
 * (its "end" or "error" event), so the microphone doesn't reopen while
 * HANNAH is still talking and hear her own reply. If an event is missed,
 * isSpeaking() polling ends the wait; cancel() ends it at once, since
 * Android's stop() sends no event.
 */
export async function speakNativeUntilDone(plugin: NativeSpeechPlugin, options: NativeSpeakOptions, { pollMs = 400, startGraceMs = 5_000, now = () => Date.now() } = {}) {
  const finished = new Set<string>();
  let wake: (() => void) | null = null;
  let released = false;
  const onDone = (event: UtteranceEvent) => { finished.add(event.utteranceId); wake?.(); };
  const handles = await Promise.all([plugin.addListener("end", onDone), plugin.addListener("error", onDone)]);
  const release = () => { released = true; wake?.(); };
  releaseNativeWait?.();
  releaseNativeWait = release;
  try {
    const { utteranceId } = await plugin.speak(options);
    const startedAt = now();
    const deadline = startedAt + Math.min(10 * 60_000, 15_000 + options.text.length * 150);
    let heardSpeaking = false;
    let quietPolls = 0;
    while (!released && !finished.has(utteranceId) && now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = null;
      if (released || finished.has(utteranceId)) break;
      const { isSpeaking } = await plugin.isSpeaking().catch(() => ({ isSpeaking: true }));
      if (isSpeaking) {
        heardSpeaking = true;
        quietPolls = 0;
        continue;
      }
      quietPolls += 1;
      if ((heardSpeaking && quietPolls >= 2) || (!heardSpeaking && now() - startedAt > startGraceMs)) break;
    }
  } finally {
    if (releaseNativeWait === release) releaseNativeWait = null;
    await Promise.allSettled(handles.map((handle) => handle.remove()));
  }
}

/** Play one piece of the server voice to the end (or until cancel() pauses it). */
async function playServerAudio(blob: Blob) {
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  currentAudio = audio;
  try {
    audio.playbackRate = 0.96;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => reject(new Error("Mithi audio playback failed."));
      void audio.play().catch(reject);
    });
  } finally {
    if (currentAudio === audio) currentAudio = null;
    audio.onended = null;
    audio.onpause = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(audioUrl);
  }
}

export type SpeakOptions = {
  /** Skip the optional Mithi server voice and use the device's own voices. */
  systemOnly?: boolean;
  /** A specific installed voice, by name. */
  voiceName?: string;
};

export class SpeechService {
  static async speak(text: string, language: SpeechLanguage, options: SpeakOptions = {}) {
    const run = ++generation;
    const network = await getNetworkStatus().catch(() => ({ connected: typeof navigator === "undefined" || navigator.onLine }));
    // The server voice, piece by piece (it cuts text past 5,000 characters). If a piece fails, the device voice says the rest.
    let remaining = text;
    if (!options.systemOnly && network.connected) {
      const pieces = chunkForSpeech(text, 1500);
      let spoken = 0;
      try {
        for (const piece of pieces) {
          if (run !== generation) return "Charvi · Mithi v1 Flash";
          const response = await apiFetch(apiUrl("/api/tts"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: piece, language }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) break;
          const audioBlob = await response.blob();
          if (!audioBlob.size) break;
          await playServerAudio(audioBlob);
          spoken += 1;
        }
      } catch {
        // The Mithi service is optional; continue with a voice installed on the device.
      }
      if (run !== generation) return "Charvi · Mithi v1 Flash";
      if (spoken === pieces.length && spoken > 0) return "Charvi · Mithi v1 Flash";
      remaining = pieces.slice(spoken).join(" ");
    }

    if (Capacitor.getPlatform() === "web") return speakAllInBrowser(remaining, language, options.voiceName ?? "", run);

    try {
      const { voices } = await SpeechSynthesis.getVoices();
      const languagePrefix = language.split("-")[0].toLowerCase();
      const offlineVoices = voices.filter(
        (voice) => voice.language.toLowerCase().startsWith(languagePrefix) && !voice.isNetworkConnectionRequired,
      );

      // The OS speech plugin can select Charvi only if that voice is installed as a system voice.
      const voice = (options.voiceName ? offlineVoices.find((candidate) => candidate.name === options.voiceName) : undefined)
        || preferredVoice(offlineVoices, language)
        || offlineVoices.find((candidate) => candidate.gender === "female")
        || offlineVoices[0];

      if (!voice) {
        throw new Error(`No offline ${language} voice is installed. Download a native voice in your device language settings.`);
      }

      // Android's TextToSpeech refuses more than 4,000 characters at once.
      for (const piece of chunkForSpeech(remaining, 3000)) {
        if (run !== generation) break;
        await speakNativeUntilDone(SpeechSynthesis as unknown as NativeSpeechPlugin, {
          text: piece,
          language,
          voiceId: voice.id,
          pitch: softVoiceStyle.pitch,
          rate: softVoiceStyle.rate,
          volume: softVoiceStyle.volume,
          queueStrategy: "Flush",
        });
      }
      return voice.name;
    } catch (error) {
      if (run !== generation) return "interrupted";
      if (typeof window !== "undefined" && window.speechSynthesis) return speakAllInBrowser(remaining, language, options.voiceName ?? "", run);
      throw error;
    }
  }

  static async cancel() {
    generation += 1;
    releaseNativeWait?.();
    currentAudio?.pause();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    try {
      await SpeechSynthesis.cancel();
    } catch {
      // Browser speech is already cancelled above; the native plugin may not exist on web.
    }
  }
}
