/**
 * In-browser AI with WebLLM (WebGPU), shared across the whole app.
 *
 * One engine per page: leaving the chat and coming back reuses the loaded
 * model instead of reloading ~900 MB. The first download reports real
 * progress (bytes, shard count) and only gives up when the download has truly
 * stalled for several minutes. Every failure keeps a plain-language reason so
 * the chat can show it and offer a retry.
 *
 * The engine library runs only inside workers/webllm.worker.ts. This file
 * talks to it with a few typed messages, so the ~2 MB (gzip) library is never
 * part of the main bundle.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { WorkerRequest, WorkerResponse } from "../workers/webllm.worker";

export type WebLLMStatus = "idle" | "loading" | "ready" | "error" | "unsupported";
export type WebLLMMessage = { role: "system" | "user" | "assistant"; content: string };

export type WebLLMState = {
  status: WebLLMStatus;
  modelId: string | null;
  /** 0..1 while loading. */
  progress: number;
  /** WebLLM's own progress line, for example "Fetching param cache[3/22]: 120MB fetched…". */
  detail: string;
  error: string | null;
};

/** How long a download may go without any new progress before it counts as stalled. */
export const STALL_TIMEOUT_MS = 10 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 3 * 60 * 1000;

let state: WebLLMState = { status: "idle", modelId: null, progress: 0, detail: "", error: null };
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let loading: Promise<void> | null = null;
let stallTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
type Pending = { resolve: (content: string) => void; reject: (error: Error) => void; onProgress?: (progress: number, text: string) => void };
const pending = new Map<number, Pending>();

function setState(next: Partial<WebLLMState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWebLLMState() {
  return state;
}

/** Plain-language reason for a load or generation failure. Exported for tests. */
export function describeWebLLMError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/quota|QuotaExceeded|storage/i.test(message)) return "The browser ran out of storage for the model (about 900 MB). Free some disk space or allow this site more storage, then retry.";
  if (/Failed to fetch|NetworkError|network|ERR_/i.test(message)) return "Couldn't download the model. Check your connection, then retry. Once downloaded it works offline.";
  if (/device.*lost|out of memory|OOM|allocation/i.test(message)) return "The GPU ran out of memory while loading the model. Close other tabs or apps using the GPU, then retry.";
  if (/shader-f16|f16/i.test(message)) return "This GPU doesn't support the 16-bit features this model needs. Try Chrome or Edge on a newer GPU.";
  return message ? `The browser model failed: ${message}` : "The browser model failed to load.";
}

/** Whether this browser can run WebGPU models, and why not if it can't. */
export async function detectWebGPU(): Promise<{ supported: boolean; reason?: string }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (!gpu) return { supported: false, reason: "This browser doesn't support WebGPU. Use a recent Chrome or Edge (or Safari 26+), or the HANNAH mobile app for on-device AI." };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { supported: false, reason: "WebGPU is turned off or no compatible GPU was found. Check that hardware acceleration is on in your browser settings." };
  } catch {
    return { supported: false, reason: "WebGPU couldn't start on this device." };
  }
  return { supported: true };
}

function clearStall() {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = null;
}

function armStall() {
  clearStall();
  stallTimer = setTimeout(() => {
    reset();
    setState({ status: "error", error: "The model download stopped making progress for 10 minutes. Check your connection, then retry; finished parts are kept." });
  }, STALL_TIMEOUT_MS);
}

function reset() {
  clearStall();
  loading = null;
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(new Error("The browser model was stopped."));
  pending.clear();
}

function startWorker() {
  const next = new Worker(new URL("../workers/webllm.worker.ts", import.meta.url), { type: "module" });
  next.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === "progress") {
      request.onProgress?.(message.progress, message.text);
      return;
    }
    pending.delete(message.id);
    if (message.type === "done") request.resolve(message.content ?? "");
    else request.reject(new Error(message.message));
  };
  next.onerror = (event) => {
    const reason = describeWebLLMError(event.message || "the model worker stopped");
    reset();
    setState({ status: "error", error: reason });
  };
  return next;
}

type WorkerCall = WorkerRequest extends infer R ? R extends { id: number } ? Omit<R, "id"> : never : never;

function call(request: WorkerCall, onProgress?: Pending["onProgress"]) {
  if (!worker) return Promise.reject(new Error("The browser model isn't running."));
  const id = nextId++;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ ...request, id } as WorkerRequest);
  });
}

/** Load `modelId` into the shared engine. Safe to call repeatedly. */
export function loadWebLLM(modelId: string) {
  if (state.modelId === modelId && (state.status === "ready" || state.status === "loading")) return loading ?? Promise.resolve();
  loading = (async () => {
    reset();
    setState({ status: "loading", modelId, progress: 0, detail: "Checking WebGPU support…", error: null });
    const support = await detectWebGPU();
    if (!support.supported) {
      setState({ status: "unsupported", error: support.reason ?? "WebGPU is unavailable." });
      return;
    }
    setState({ status: "loading", detail: "Starting the browser model…" });
    try {
      worker = startWorker();
      armStall();
      await call({ type: "load", modelId }, (progress, text) => {
        armStall();
        setState({ progress: Math.max(0, Math.min(1, progress || 0)), detail: text || "" });
      });
      clearStall();
      setState({ status: "ready", progress: 1, detail: "Browser model ready" });
    } catch (error) {
      reset();
      setState({ status: "error", error: describeWebLLMError(error) });
    }
  })();
  return loading;
}

/** Reply to a conversation with the loaded model. */
export async function generateWebLLM(messages: WebLLMMessage[]) {
  if (!worker || state.status !== "ready") throw new Error("The browser model isn't ready yet.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void call({ type: "interrupt" }).catch(() => undefined);
      reject(new Error("The browser model took too long to answer."));
    }, GENERATE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call({ type: "generate", messages }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Try again after an error. */
export function retryWebLLM() {
  const modelId = state.modelId;
  if (!modelId) return;
  setState({ status: "idle" });
  void loadWebLLM(modelId);
}

/**
 * React hook: loads `modelId` when given (and keeps it loaded afterwards), and
 * returns the shared state plus `generate`.
 */
export function useWebLLM(modelId: string | undefined) {
  const current = useSyncExternalStore(subscribe, getWebLLMState, getWebLLMState);
  useEffect(() => {
    if (modelId) void loadWebLLM(modelId);
  }, [modelId]);
  return { ...current, generate: generateWebLLM, retry: retryWebLLM };
}
