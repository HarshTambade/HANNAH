/**
 * HANNAH's voice layer: one interface over several speech engines.
 *
 * Speaking (text → speech)
 *   auto    Mithi when the server has it, otherwise the device's own voice
 *   system  the device's own voice only (on-device, works offline)
 *   openai  OpenAI voices through the HANNAH server (hosted)
 *
 * Listening (speech → text)
 *   system        the browser's or device's recognition
 *   groq-whisper  record on the device, transcribe with Groq Whisper (hosted);
 *                 works in browsers without built-in recognition
 *
 * Barge-in: while HANNAH speaks, the microphone listens for the user's voice
 * (with echo cancellation) and stops playback as soon as they start talking.
 *
 * Hosted engines send text or audio to that provider; the Settings screen says
 * so next to each choice.
 */
import type { SpeechLanguage } from "../types";
import { apiFetch, apiUrl } from "./api";
import { SpeechService } from "./SpeechService";
import { VoiceService, type TranscriptListener } from "./VoiceService";

export type TtsEngine = "auto" | "system" | "openai";
export type SttEngine = "system" | "groq-whisper";
export type VoiceSettings = { tts: TtsEngine; openaiVoice: string; systemVoice: string; stt: SttEngine; bargeIn: boolean };
export type VoiceProviders = {
  tts: Array<{ id: "openai"; label: string; available: boolean; voices: string[]; model: string }>;
  stt: Array<{ id: "groq-whisper"; label: string; available: boolean; model: string }>;
  mithi: boolean;
};

const SETTINGS_KEY = "hannah.voice.settings.v1";
export const VOICE_SETTINGS_EVENT = "hannah:voice-settings";
const DEFAULTS: VoiceSettings = { tts: "auto", openaiVoice: "coral", systemVoice: "", stt: "system", bargeIn: true };

export function readVoiceSettings(): VoiceSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<VoiceSettings>;
    return {
      tts: parsed.tts === "system" || parsed.tts === "openai" ? parsed.tts : "auto",
      openaiVoice: typeof parsed.openaiVoice === "string" && parsed.openaiVoice ? parsed.openaiVoice : DEFAULTS.openaiVoice,
      systemVoice: typeof parsed.systemVoice === "string" ? parsed.systemVoice : "",
      stt: parsed.stt === "groq-whisper" ? "groq-whisper" : "system",
      bargeIn: parsed.bargeIn !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveVoiceSettings(change: Partial<VoiceSettings>) {
  const next = { ...readVoiceSettings(), ...change };
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(VOICE_SETTINGS_EVENT));
  } catch {
    // Best effort.
  }
  return next;
}

export async function loadVoiceProviders(): Promise<VoiceProviders | null> {
  try {
    const response = await apiFetch(apiUrl("/api/voice/providers"), { signal: AbortSignal.timeout(6_000) });
    return response.ok ? await response.json() as VoiceProviders : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Speaking

let currentAudio: HTMLAudioElement | null = null;
let interrupted = false;

async function playBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => reject(new Error("Audio playback failed."));
      void audio.play().catch(reject);
    });
  } finally {
    audio.onended = null;
    audio.onpause = null;
    audio.onerror = null;
    if (currentAudio === audio) currentAudio = null;
    URL.revokeObjectURL(url);
  }
}

export const VoiceOut = {
  /** Speak with the chosen engine. Resolves with the voice used, or "interrupted". */
  async speak(text: string, language: SpeechLanguage): Promise<string> {
    const settings = readVoiceSettings();
    interrupted = false;
    if (settings.tts === "openai") {
      try {
        const response = await apiFetch(apiUrl("/api/voice/speak"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.slice(0, 4000), voice: settings.openaiVoice }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error || "OpenAI voice is unavailable.");
        }
        await playBlob(await response.blob());
        return interrupted ? "interrupted" : `OpenAI · ${settings.openaiVoice}`;
      } catch (error) {
        if (interrupted) return "interrupted";
        // Fall back to the device voice so the reply is still heard.
        const name = await SpeechService.speak(text, language, { systemOnly: true, voiceName: settings.systemVoice });
        return `${name} (OpenAI voice unavailable: ${error instanceof Error ? error.message : "error"})`;
      }
    }
    try {
      return await SpeechService.speak(text, language, { systemOnly: settings.tts === "system", voiceName: settings.systemVoice });
    } catch (error) {
      if (interrupted) return "interrupted";
      throw error;
    }
  },
  async cancel() {
    interrupted = true;
    currentAudio?.pause();
    await SpeechService.cancel().catch(() => undefined);
  },
};

/** Installed device voices for a language, for the voice picker. */
export function systemVoices(language: SpeechLanguage) {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  const prefix = language.split("-")[0].toLowerCase();
  return window.speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith(prefix)).map((voice) => ({ name: voice.name, local: voice.localService }));
}

// ---------------------------------------------------------------------------
// Listening

type LevelMeter = { level: () => number; close: () => void };

function levelMeter(stream: MediaStream): LevelMeter {
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    level() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += value * value;
      return Math.sqrt(sum / samples.length);
    },
    close() {
      source.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}

/**
 * Voice activity detection over a level meter: calibrates on the first
 * ~300 ms of room noise, then reports when speech starts and when it's
 * followed by silence. Exported for tests.
 */
export function createVad({ minThreshold = 0.02, startMs = 200, endSilenceMs = 900, frameMs = 50 } = {}) {
  let floor = 0;
  let calibrated = 0;
  let loudMs = 0;
  let quietMs = 0;
  let speaking = false;
  return (level: number): "calibrating" | "idle" | "speech-start" | "speaking" | "speech-end" => {
    if (calibrated < 6) {
      floor = (floor * calibrated + level) / (calibrated + 1);
      calibrated += 1;
      return "calibrating";
    }
    const threshold = Math.max(minThreshold, floor * 3);
    if (level > threshold) {
      loudMs += frameMs;
      quietMs = 0;
      if (!speaking && loudMs >= startMs) {
        speaking = true;
        return "speech-start";
      }
      return speaking ? "speaking" : "idle";
    }
    loudMs = 0;
    if (!speaking) {
      floor = floor * 0.95 + level * 0.05;
      return "idle";
    }
    quietMs += frameMs;
    if (quietMs >= endSilenceMs) {
      speaking = false;
      quietMs = 0;
      return "speech-end";
    }
    return "speaking";
  };
}

async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser can't record audio.");
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    throw new Error("Allow microphone access to talk to HANNAH.");
  }
}

function recorderType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

/** Record utterances and transcribe each with Groq Whisper until stopped. */
async function startWhisperSession(language: SpeechLanguage, onTranscript: TranscriptListener, onError?: (message: string) => void) {
  const type = recorderType();
  if (!type) throw new Error("This browser can't record audio for Whisper. Choose browser recognition in Settings → Voice.");
  const stream = await openMicrophone();
  const meter = levelMeter(stream);
  let stopped = false;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  const vad = createVad();

  const transcribe = async (blob: Blob) => {
    if (blob.size < 1500) return;
    try {
      const response = await apiFetch(apiUrl(`/api/voice/transcribe?language=${language.split("-")[0]}`), { method: "POST", headers: { "Content-Type": type.split(";")[0] }, body: blob, signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "Transcription failed.");
      if (body.text && !stopped) onTranscript(body.text, true);
    } catch (error) {
      if (!stopped) onError?.(error instanceof Error ? error.message : "Transcription failed.");
    }
  };

  const begin = () => {
    chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: type });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => { void transcribe(new Blob(chunks, { type: type.split(";")[0] })); };
    recorder.start(250);
    startedAt = Date.now();
  };
  const timer = window.setInterval(() => {
    if (stopped) return;
    const state = vad(meter.level());
    if (state === "speech-start" && !recorder) begin();
    // End on silence, or after 30 seconds of continuous speech.
    if (recorder && (state === "speech-end" || Date.now() - startedAt > 30_000)) {
      const active = recorder;
      recorder = null;
      active.stop();
    }
  }, 50);

  return async () => {
    stopped = true;
    window.clearInterval(timer);
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    meter.close();
    stream.getTracks().forEach((track) => track.stop());
  };
}

export const VoiceIn = {
  /** Same contract as VoiceService.startSession: returns a stop function. */
  startSession(language: SpeechLanguage, onTranscript: TranscriptListener, onError?: (message: string) => void) {
    return readVoiceSettings().stt === "groq-whisper"
      ? startWhisperSession(language, onTranscript, onError)
      : VoiceService.startSession(language, onTranscript, onError);
  },
};

/**
 * Listen for the user's voice while HANNAH speaks and call onSpeech once when
 * they start talking. Resolves to a stop function (a no-op if the mic is unavailable).
 */
export async function startBargeInMonitor(onSpeech: () => void): Promise<() => void> {
  let stream: MediaStream;
  try {
    stream = await openMicrophone();
  } catch {
    return () => undefined;
  }
  const meter = levelMeter(stream);
  // Higher bar than normal listening, so residual echo of HANNAH's own voice doesn't trigger it.
  const vad = createVad({ minThreshold: 0.06, startMs: 300 });
  let fired = false;
  const timer = window.setInterval(() => {
    if (!fired && vad(meter.level()) === "speech-start") {
      fired = true;
      onSpeech();
    }
  }, 50);
  return () => {
    window.clearInterval(timer);
    meter.close();
    stream.getTracks().forEach((track) => track.stop());
  };
}
