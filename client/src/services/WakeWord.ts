/**
 * "Hey HANNAH" wake word.
 *
 * Detection runs on this device: Vosk (Kaldi speech recognition compiled to
 * WebAssembly, Apache-2.0) listens with a two-entry grammar, "hey hannah" or
 * anything else, so it can't transcribe what you say and no audio leaves the
 * device. When it hears "Hey HANNAH" it releases the microphone and opens a
 * voice turn in chat, exactly as if you'd pressed the mic button; it starts
 * listening for the wake word again when that conversation goes quiet.
 *
 * Off by default. The first time it's turned on, the app downloads the speech
 * model (about 41 MB) from the HANNAH website and keeps it in this device's
 * storage. In the desktop app it keeps listening while the window is hidden;
 * on Android a native foreground service (HannahWakeService.java, always shown
 * with Stop) listens in the background. It pauses while HANNAH is listening to
 * you or speaking. iOS doesn't allow it: "Hey Siri, talk to HANNAH" instead.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { apiUrl } from "./api";

export const WAKE_EVENT = "hannah:wake";
export const WAKE_STATE_EVENT = "hannah:wake-state";
export const WAKE_MODEL_PATH = "/models/wake/vosk-model-small-en-us-0.15.tar.gz";
const ENABLED_KEY = "hannah.wakeWord.enabled";
const COOLDOWN_MS = 3_000;
const MODEL_RATE = 16_000;
const RESUME_AFTER_MS = 1_500;

export type WakeState = "off" | "loading" | "listening" | "paused" | "error" | "unsupported";

type VoskModel = import("vosk-browser").Model;
type VoskRecognizer = InstanceType<VoskModel["KaldiRecognizer"]>;

let state: WakeState = "off";
let lastError = "";
let model: VoskModel | null = null;
let modelLoading: Promise<VoskModel> | null = null;
let recognizer: VoskRecognizer | null = null;
let stream: MediaStream | null = null;
let audio: AudioContext | null = null;
let processor: ScriptProcessorNode | null = null;
let busy = false;
let pendingWake = false;
let lastWake = 0;
let resumeTimer: ReturnType<typeof setTimeout> | undefined;
let starting = false;

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** In the desktop app, keep listening while the window is hidden and show it in the menu bar. */
let desktopListening: boolean | null = null;
function tellDesktop(listening: boolean) {
  if (desktopListening === listening) return;
  desktopListening = listening;
  void import("./DesktopFiles").then(({ desktopFilesAvailable, hannahDesktop }) => (desktopFilesAvailable() ? hannahDesktop().setWakeListening({ on: listening }) : undefined)).catch(() => undefined);
}

function setState(next: WakeState, error = "") {
  state = next;
  lastError = error;
  // Paused (HANNAH has the microphone for a voice turn) still counts as on.
  tellDesktop(next === "listening" || next === "paused" || next === "loading");
  try {
    window.dispatchEvent(new Event(WAKE_STATE_EVENT));
  } catch {
    // No window (tests).
  }
}

/** Average-and-pick downsampling, enough for a 16 kHz speech model. Exported for tests. */
export function downsample(samples: Float32Array, fromRate: number, toRate: number) {
  if (fromRate <= toRate) return samples.slice();
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < out.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let at = start; at < end; at += 1) sum += samples[at];
    out[index] = sum / Math.max(1, end - start);
  }
  return out;
}

/** True for "hey hannah" said as two consecutive words. Exported for tests. */
export function heardWakePhrase(text: string) {
  return /(?:^|\s)hey hannah(?:\s|$)/.test(String(text).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim());
}

/** Desktop app, Android and desktop browsers. iOS doesn't allow it: use Siri, “Talk to HANNAH” (startSiriVoiceLaunch). */
export function wakeWordSupported() {
  if (typeof window === "undefined" || Capacitor.getPlatform() === "ios") return false;
  if (usesNativeWake()) return true;
  const hasAudio = typeof window.AudioContext === "function" || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === "function";
  return typeof navigator.mediaDevices?.getUserMedia === "function" && typeof WebAssembly === "object" && typeof Worker === "function" && hasAudio;
}

/** The website serves the model; the apps download it from there (once). */
export function wakeModelUrl() {
  const configured = import.meta.env.VITE_WAKE_MODEL_URL?.trim();
  if (configured) return configured;
  return Capacitor.getPlatform() === "web" ? WAKE_MODEL_PATH : apiUrl(WAKE_MODEL_PATH);
}

async function loadModel() {
  if (model) return model;
  modelLoading ??= (async () => {
    const { Model } = await import("vosk-browser");
    const loaded = new Model(new URL(wakeModelUrl(), window.location.href).toString());
    // vosk-browser's createModel waits forever when the worker reports an error; listen for both.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The wake-word model took too long to download or load.")), 5 * 60_000);
        loaded.on("load", (message) => {
          clearTimeout(timer);
          if ((message as { result?: boolean }).result) resolve();
          else reject(new Error("Couldn't load the wake-word model."));
        });
        loaded.on("error", (message) => {
          clearTimeout(timer);
          reject(new Error(`Couldn't load the wake-word model: ${String((message as { error?: string }).error ?? "unknown error")}`));
        });
      });
    } catch (error) {
      loaded.terminate();
      throw error;
    }
    model = loaded;
    return loaded;
  })().catch((error) => {
    modelLoading = null;
    throw error;
  });
  return modelLoading;
}

function stopAudio() {
  if (processor) processor.onaudioprocess = null;
  try { processor?.disconnect(); } catch { /* already disconnected */ }
  try { recognizer?.remove(); } catch { /* the model may be gone */ }
  stream?.getTracks().forEach((track) => track.stop());
  void audio?.close().catch(() => undefined);
  processor = null;
  recognizer = null;
  stream = null;
  audio = null;
}

function heard(text: string) {
  if (!heardWakePhrase(text) || Date.now() - lastWake < COOLDOWN_MS) return;
  lastWake = Date.now();
  // Let go of the microphone so the voice turn can use it.
  stopAudio();
  pendingWake = true;
  setState("paused");
  window.dispatchEvent(new Event(WAKE_EVENT));
  // If nothing picks up the voice turn, go back to listening.
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (pendingWake) {
      pendingWake = false;
      void start();
    }
  }, 10_000);
}

// ---------- Android: the native background listener (HannahWakeService.java) ----------

type NativeWakeState = "off" | "loading" | "listening" | "paused" | "error";
interface HannahWakePlugin {
  start(options: { modelUrl: string }): Promise<{ state: NativeWakeState }>;
  stop(): Promise<{ state: NativeWakeState }>;
  pause(options: { paused: boolean }): Promise<{ paused: boolean }>;
  status(): Promise<{ state: NativeWakeState; detail: string; microphone: string }>;
  pendingWake(): Promise<{ pending: boolean }>;
  addListener(event: "wake", listener: (data: { source: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "state", listener: (data: { state: NativeWakeState; detail: string }) => void): Promise<PluginListenerHandle>;
}
let nativePlugin: HannahWakePlugin | null = null;
let nativeListening = false;
/** On Android the app listens natively, in a foreground service that keeps going in the background. */
export function usesNativeWake() {
  return typeof window !== "undefined" && Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("HannahWake");
}
function nativeWake() {
  if (!nativePlugin) {
    nativePlugin = registerPlugin<HannahWakePlugin>("HannahWake");
    void nativePlugin.addListener("state", ({ state: next, detail }) => {
      nativeListening = next !== "off" && next !== "error";
      // Stop in the notification means off: the next launch doesn't start listening again.
      if (next === "off") storage()?.setItem(ENABLED_KEY, "off");
      setState(next, detail);
    });
    void nativePlugin.addListener("wake", () => openVoiceTurnFromNative());
    // Opened by tapping "You said Hey HANNAH" while HANNAH was in the background.
    void nativePlugin.pendingWake().then(({ pending }) => { if (pending) openVoiceTurnFromNative(); }).catch(() => undefined);
  }
  return nativePlugin;
}
function openVoiceTurnFromNative() {
  if (Date.now() - lastWake < COOLDOWN_MS) return;
  lastWake = Date.now();
  pendingWake = true;
  setState("paused");
  window.dispatchEvent(new Event(WAKE_EVENT));
  // If no voice turn takes the microphone, the service listens again.
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (pendingWake && !busy) {
      pendingWake = false;
      void nativeWake().pause({ paused: false }).catch(() => undefined);
    }
  }, 10_000);
}
async function startNative() {
  setState("loading");
  try {
    const url = new URL(wakeModelUrl(), window.location.href).toString();
    await nativeWake().start({ modelUrl: url });
    nativeListening = true;
  } catch (error) {
    nativeListening = false;
    setState("error", error instanceof Error ? error.message : String(error));
  }
}

async function start() {
  if (usesNativeWake()) {
    if (!WakeWord.enabled() || nativeListening) return;
    return startNative();
  }
  if (!WakeWord.enabled() || busy || starting || recognizer) return;
  if (!wakeWordSupported()) {
    setState("unsupported", "This device can't run the wake word.");
    return;
  }
  starting = true;
  if (!model) setState("loading");
  try {
    const loaded = await loadModel();
    if (!WakeWord.enabled() || busy) return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // The model takes 16 kHz audio and its recognizer can't be created at the
    // microphone's own rate (usually 48 kHz). Ask the browser to resample;
    // where it can't, downsample each frame here.
    try {
      audio = new Context({ sampleRate: MODEL_RATE });
    } catch {
      audio = new Context();
    }
    const inputRate = audio.sampleRate;
    const created = new loaded.KaldiRecognizer(MODEL_RATE, JSON.stringify(["hey hannah", "[unk]"]));
    recognizer = created;
    created.on("partialresult", (message) => heard((message as { result: { partial?: string } }).result.partial ?? ""));
    created.on("result", (message) => heard((message as { result: { text?: string } }).result.text ?? ""));
    created.on("error" as never, (message: unknown) => {
      stopAudio();
      setState("error", `The wake word stopped: ${String((message as { error?: string }).error ?? "recognizer error").split("\n")[0]}`);
    });
    const source = audio.createMediaStreamSource(stream);
    // ScriptProcessor works in every WebView this app runs in; the output stays silent.
    processor = audio.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      try {
        const samples = event.inputBuffer.getChannelData(0);
        recognizer?.acceptWaveformFloat(inputRate === MODEL_RATE ? samples.slice() : downsample(samples, inputRate, MODEL_RATE), MODEL_RATE);
      } catch {
        // A frame arriving while stopping.
      }
    };
    source.connect(processor);
    processor.connect(audio.destination);
    setState("listening");
  } catch (error) {
    stopAudio();
    const message = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")
      ? "Microphone access was blocked. Allow it for HANNAH, then turn the wake word on again."
      : error instanceof Error && /fetch|download|load|404|tar/i.test(error.message)
        ? "Couldn't download the wake-word model. Check your connection and try again."
        : error instanceof Error ? error.message : String(error);
    setState("error", message);
  } finally {
    starting = false;
  }
}

function stop() {
  clearTimeout(resumeTimer);
  pendingWake = false;
  stopAudio();
}

/** Turning the wake word off on Android stops the background service; leaving the screen doesn't. */
function stopNative() {
  nativeListening = false;
  void nativeWake().stop().catch(() => undefined);
}

export const WakeWord = {
  enabled() {
    return storage()?.getItem(ENABLED_KEY) === "on";
  },
  async setEnabled(on: boolean) {
    storage()?.setItem(ENABLED_KEY, on ? "on" : "off");
    if (on) {
      await start();
    } else {
      stop();
      if (usesNativeWake()) stopNative();
      model?.terminate();
      model = null;
      modelLoading = null;
      setState("off");
    }
  },
  state: () => state,
  error: () => lastError,
  /** Chat is listening to you, thinking or speaking: give it the microphone, then listen again. */
  setBusy(value: boolean) {
    if (busy === value) return;
    busy = value;
    if (usesNativeWake()) {
      // The voice turn takes the microphone from the service, then gives it back.
      clearTimeout(resumeTimer);
      if (value) pendingWake = false;
      if (WakeWord.enabled() && nativeListening) void nativeWake().pause({ paused: value }).catch(() => undefined);
      return;
    }
    if (value) {
      pendingWake = false;
      clearTimeout(resumeTimer);
      if (recognizer) stopAudio();
      if (WakeWord.enabled()) setState("paused");
      return;
    }
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => void start(), RESUME_AFTER_MS);
  },
  /** True once after a wake, for the chat screen that opens because of it. */
  consumePendingWake() {
    const value = pendingWake;
    pendingWake = false;
    return value;
  },
};

/**
 * Open a voice turn from outside the detector: Siri / Shortcuts on iPhone
 * ("Talk to HANNAH", HannahIntents.swift). Same event and same chat path as
 * "Hey HANNAH", so voice and text use one task system.
 */
export function requestVoiceTurn() {
  if (typeof window === "undefined") return;
  pendingWake = true;
  window.dispatchEvent(new Event(WAKE_EVENT));
}

const SIRI_LAUNCH_KEY = "hannah.voiceLaunch";
const SIRI_LAUNCH_FRESH_MS = 2 * 60_000;

/** On iPhone, a "Talk to HANNAH" from Siri leaves a timestamp; a fresh one opens a voice turn, once. Exported for tests. */
export async function checkSiriLaunch({ now = Date.now(), preferences }: { now?: number; preferences?: { get(o: { key: string }): Promise<{ value: string | null }>; remove(o: { key: string }): Promise<void> } } = {}) {
  const prefs = preferences ?? (await import("@capacitor/preferences")).Preferences;
  const { value } = await prefs.get({ key: SIRI_LAUNCH_KEY });
  if (!value) return false;
  await prefs.remove({ key: SIRI_LAUNCH_KEY });
  const at = Number(value);
  if (!Number.isFinite(at) || now - at > SIRI_LAUNCH_FRESH_MS || at - now > 60_000) return false;
  requestVoiceTurn();
  return true;
}

/** Listen for Siri launches while the iPhone app runs. Returns a stop function. */
export function startSiriVoiceLaunch() {
  if (typeof window === "undefined" || !Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return () => undefined;
  const check = () => void checkSiriLaunch().catch(() => undefined);
  check();
  const onVisible = () => { if (document.visibilityState === "visible") check(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

/** Start listening if the wake word was left on. */
export function startWakeWord() {
  if (typeof window === "undefined") return () => undefined;
  if (usesNativeWake()) {
    // Attach to a service that may already be running, and report its real state.
    void nativeWake().status().then(({ state: current, detail }) => {
      nativeListening = current !== "off" && current !== "error";
      if (nativeListening || current === "error") setState(current, detail);
      else if (WakeWord.enabled()) void start();
    }).catch(() => { if (WakeWord.enabled()) void start(); });
    return () => undefined;
  }
  if (WakeWord.enabled()) void start();
  return () => stop();
}
