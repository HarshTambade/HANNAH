/**
 * Media: pictures and short video clips HANNAH generates in chat.
 *
 *   mediaIntent()     does a chat message plainly ask for a picture or a clip?
 *   generateImage()   POST /api/media/image, kept as files on this device
 *   generateVideo()   POST /api/media/video, then poll the job until the mp4 arrives
 *   runMediaTurn()    a chat message handled directly, with a short reply
 *   getMediaTools()   generate_image and generate_video for the agent
 *
 * The work happens on HANNAH's server (server/media.js) with the person's own
 * provider key (OpenAI, xAI or Together for images; xAI for video) or the
 * operator's. What comes back is kept with the Studio's files (IndexedDB), so
 * it shows in the conversation and in Library → Files, and downloads the same way.
 */
import { apiFetch, apiUrl } from "./api";
import type { HANNAHTool } from "./DeviceTools";
import { DAILY_BUDGET_KEY } from "./LLMRouter";
import { STUDIO_EVENT, formatsIn, keepMedia, type StudioFile } from "./Studio";

export type MediaKind = "image" | "video";
export type MediaAspect = "1:1" | "16:9" | "9:16";
export type MediaIntent =
  | { kind: "none" }
  | { kind: "image"; prompt: string; aspect: MediaAspect }
  | { kind: "video"; prompt: string; aspect: MediaAspect; seconds: number };
export type MediaEngine = { id: string; label: string; model: string; available: boolean; maxSeconds?: number };

export class MediaError extends Error {
  constructor(message: string, readonly reason?: string, readonly status?: number) { super(message); }
}

/** Answers HANNAH gives as a reply rather than as an error: a refusal, a missing key, a spent budget. */
const ANSWERS = new Set(["minor-sexual", "private-person", "real-person-sexual", "provider-refused", "media-unavailable", "budget-exceeded", "key-rejected", "rate-limited", "expired"]);
export const isMediaAnswer = (error: unknown): error is MediaError => error instanceof MediaError && ANSWERS.has(error.reason || "");

const announce = (detail: Record<string, unknown>) => { try { window.dispatchEvent(new CustomEvent(STUDIO_EVENT, { detail })); } catch { /* no window events here */ } };

function dailyBudgetUsd() {
  try {
    const value = Number(window.localStorage.getItem(DAILY_BUDGET_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function call<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 180_000, signal, ...rest } = init;
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  const response = await apiFetch(apiUrl(path), { ...rest, signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
  const data = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw new MediaError(data.error || `The server answered ${response.status}.`, data.reason, response.status);
  return data;
}
const post = <T>(path: string, body: unknown, signal?: AbortSignal) => call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body as object, ...(dailyBudgetUsd() ? { budget: { dailyUsd: dailyBudgetUsd() } } : {}) }), signal });

export async function mediaProviders(): Promise<{ image: MediaEngine[]; video: MediaEngine[] }> {
  return call("/api/media/providers", { timeoutMs: 15_000 });
}

// ——— Understanding a request ———

const VIDEO_THING = /\b(videos?|clips?|animations?|animated (gif|loop|clip)|short film|movie)\b/i;
const IMAGE_THING = /\b(images?|pictures?|pics?|illustrations?|drawings?|paintings?|artwork|art|logos?|posters?|wallpapers?|portraits?|sketch(es)?|photos?|icons?|avatars?|renders?|concept art|sticker)\b/i;
const MAKE = /\b(make|create|generate|render|produce|design|give me|can (you|i) (get|have))\b/i;
const NOT_MEDIA = /\b(video ?call|video ?chat|facetime|describe|summari[sz]e|transcribe|watch|analy[sz]e|edit (my|this|the)|this (image|picture|photo|video)|attached|my screen|screenshot|search (for|the web)|find (me )?(an? )?(image|picture|photo|video)s? (of|on|about)|youtube|script for)\b/i;

/** The words that describe the picture, without "can you draw me". */
export function promptFrom(text: string): string {
  const stripped = text.trim()
    .replace(/^(hey |hi |ok |okay )?(hannah[,:]?\s+)?/i, "")
    .replace(/^(please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|i'?d like you to\s+)*/i, "")
    .replace(/^(please\s+)?(draw|sketch|paint|illustrate|animate|generate|create|make|render|produce|design|give me|show me)\s+(me\s+|us\s+)?/i, "")
    .replace(/^(an?\s+|the\s+|some\s+)?((\d{1,2}|one|two|three|four|five|ten)[- ]?(s|sec|secs|seconds?)\s+(long\s+)?)?(short\s+|quick\s+|little\s+)?(images?|pictures?|pics?|illustrations?|drawings?|paintings?|videos?|clips?|animations?|photos?)\s+(of\s+|showing\s+|with\s+)?/i, "")
    .replace(/\s*(,\s*)?please[.!]?$/i, "")
    .trim();
  return stripped || text.trim();
}

const WORD_SECONDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
export function secondsIn(text: string, fallback = 5): number {
  const match = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)[- ]?(s|sec|secs|seconds?)\b/i.exec(text);
  const value = match ? Number(match[1]) || WORD_SECONDS[match[1].toLowerCase()] || fallback : fallback;
  return Math.max(1, Math.min(15, Math.round(value)));
}

export function aspectIn(text: string, kind: MediaKind): MediaAspect {
  if (/\b(portrait|vertical|9:16|phone wallpaper|stor(y|ies)|reels?|tiktok)\b/i.test(text)) return "9:16";
  if (/\b(landscape|wide|widescreen|16:9|banner|cinematic|desktop wallpaper|header)\b/i.test(text)) return "16:9";
  if (/\b(square|1:1)\b/i.test(text)) return "1:1";
  return kind === "video" ? "16:9" : "1:1";
}

/**
 * What a chat message asks to be generated, if anything. `forced` is the
 * composer's Create switch: the whole message is then the description.
 * Otherwise only a plain request ("draw…", "make a picture of…", "make a
 * 5-second clip of…") is taken; a message about documents, an attached
 * image, a search, or a video call goes on as usual.
 */
export function mediaIntent(text: string, { forced = null as MediaKind | null } = {}): MediaIntent {
  const message = text.trim();
  if (!message) return { kind: "none" };
  if (forced) return forced === "video"
    ? { kind: "video", prompt: promptFrom(message), aspect: aspectIn(message, "video"), seconds: secondsIn(message) }
    : { kind: "image", prompt: promptFrom(message), aspect: aspectIn(message, "image") };
  if (message.length > 1500 || NOT_MEDIA.test(message) || formatsIn(message).length) return { kind: "none" };
  const asksVideo = (MAKE.test(message) || /^\s*(please\s+)?animate\b/i.test(message)) && VIDEO_THING.test(message);
  if (asksVideo) return { kind: "video", prompt: promptFrom(message), aspect: aspectIn(message, "video"), seconds: secondsIn(message) };
  const draws = /^\s*((hey |ok )?hannah[,:]?\s+)?(please\s+|can you\s+|could you\s+)*(draw|sketch|paint|illustrate)\b/i.test(message);
  if (draws || (MAKE.test(message) && IMAGE_THING.test(message))) return { kind: "image", prompt: promptFrom(message), aspect: aspectIn(message, "image") };
  return { kind: "none" };
}

// ——— Generating ———

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "untitled";
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };

type ImageResponse = { provider: string; providerLabel: string; model: string; aspect: MediaAspect; costUsd?: number; images: Array<{ mime: string; bytes: number; data: string; revisedPrompt?: string }> };

export async function generateImage(prompt: string, { aspect = "1:1" as MediaAspect, provider, n = 1, signal }: { aspect?: MediaAspect; provider?: string; n?: number; signal?: AbortSignal } = {}): Promise<{ files: StudioFile[]; providerLabel: string; model: string; costUsd?: number }> {
  const body = await post<ImageResponse>("/api/media/image", { prompt, aspect, n, ...(provider ? { provider } : {}) }, signal);
  const files: StudioFile[] = [];
  for (const [index, image] of body.images.entries()) {
    files.push(await keepMedia({
      name: `hannah-${slug(prompt)}${body.images.length > 1 ? `-${index + 1}` : ""}.${EXT[image.mime] || "png"}`,
      format: "image", mime: image.mime, bytes: image.bytes, data: image.data,
      summary: { provider: body.providerLabel, model: body.model, aspect: body.aspect, prompt, ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}), ...(body.costUsd ? { costUsd: body.costUsd } : {}) },
    }, prompt));
  }
  announce({ kind: "media-result", ids: files.map((file) => file.id) });
  return { files, providerLabel: body.providerLabel, model: body.model, costUsd: body.costUsd };
}

type VideoStart = { job: { provider: string; id: string }; seconds: number; aspect: MediaAspect; model: string; providerLabel: string };
type VideoPoll = { status: "pending"; progress?: number } | { status: "done"; model: string; video: { mime: string; bytes: number; data: string; duration?: number } };

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new MediaError("Stopped.", "stopped")); }, { once: true });
});

/**
 * Start a clip and wait for it. Providers take one to several minutes; the
 * job is checked every few seconds and a passing network hiccup is retried.
 */
export async function generateVideo(prompt: string, { seconds = 5, aspect = "16:9" as MediaAspect, provider, signal, onProgress = () => {}, pollMs = 5_000, maxWaitMs = 12 * 60_000 }: { seconds?: number; aspect?: MediaAspect; provider?: string; signal?: AbortSignal; onProgress?: (progress: number | null) => void; pollMs?: number; maxWaitMs?: number } = {}): Promise<{ file: StudioFile; providerLabel: string; model: string }> {
  const start = await post<VideoStart>("/api/media/video", { prompt, seconds, aspect, ...(provider ? { provider } : {}) }, signal);
  const path = `/api/media/video/${encodeURIComponent(start.job.provider)}/${encodeURIComponent(start.job.id)}`;
  const deadline = Date.now() + maxWaitMs;
  let misses = 0;
  onProgress(null);
  while (Date.now() < deadline) {
    await wait(pollMs, signal);
    let poll: VideoPoll;
    try {
      poll = await call<VideoPoll>(path, { signal, timeoutMs: 180_000 });
      misses = 0;
    } catch (error) {
      // A dropped connection or a provider blip: check again, a few times.
      if (error instanceof MediaError && error.status && error.status < 500) throw error;
      if (signal?.aborted) throw error;
      misses += 1;
      if (misses > 4) throw error;
      continue;
    }
    if (poll.status === "pending") { onProgress(typeof poll.progress === "number" ? poll.progress : null); continue; }
    const file = await keepMedia({
      name: `hannah-${slug(prompt)}.${EXT[poll.video.mime] || "mp4"}`,
      format: "video", mime: poll.video.mime, bytes: poll.video.bytes, data: poll.video.data,
      summary: { provider: start.providerLabel, model: poll.model || start.model, aspect: start.aspect, prompt, seconds: poll.video.duration ?? start.seconds },
    }, prompt);
    announce({ kind: "media-result", ids: [file.id] });
    return { file, providerLabel: start.providerLabel, model: poll.model || start.model };
  }
  throw new MediaError(`The video wasn't ready after ${Math.round(maxWaitMs / 60_000)} minutes. ${start.providerLabel} may still finish it, but HANNAH stopped waiting.`, "timeout");
}

// ——— From chat ———

export type MediaTurn = { reply: string; mediaIds: string[] };

/** Carry out a picture or clip request from chat. Refusals and missing keys come back as the reply. */
export async function runMediaTurn(intent: Exclude<MediaIntent, { kind: "none" }>, { signal, onProgress, provider }: { signal?: AbortSignal; onProgress?: (message: string) => void; provider?: string } = {}): Promise<MediaTurn> {
  try {
    if (intent.kind === "image") {
      const made = await generateImage(intent.prompt, { aspect: intent.aspect, provider, signal });
      const revised = made.files[0]?.summary?.revisedPrompt;
      return { reply: `Here it is: “${intent.prompt}”, made with ${made.providerLabel} (${made.model}).${typeof revised === "string" && revised !== intent.prompt ? ` ${made.providerLabel} reworded the description as: “${revised.slice(0, 300)}”.` : ""}`, mediaIds: made.files.map((file) => file.id) };
    }
    const made = await generateVideo(intent.prompt, { seconds: intent.seconds, aspect: intent.aspect, provider, signal, onProgress: (progress) => onProgress?.(progress === null ? "HANNAH is making your video… this usually takes a minute or two." : `HANNAH is making your video… ${progress}%`) });
    return { reply: `Here is your clip: “${intent.prompt}”, ${made.file.summary?.seconds ?? intent.seconds} seconds, made with ${made.providerLabel} (${made.model}).`, mediaIds: [made.file.id] };
  } catch (error) {
    if (isMediaAnswer(error)) return { reply: error.message, mediaIds: [] };
    throw error;
  }
}

// ——— Tools for the agent ———

const ASPECT_PROP = { type: "string", enum: ["1:1", "16:9", "9:16"], description: "1:1 square (default for images), 16:9 landscape (default for video), 9:16 portrait." };
const aspectArg = (value: unknown, fallback: MediaAspect): MediaAspect => (["1:1", "16:9", "9:16"] as const).find((item) => item === value) || fallback;

export function getMediaTools(): HANNAHTool[] {
  return [
    {
      name: "generate_image",
      description: "Generate a picture from a description (a drawing, illustration, photo-style image, logo or poster) with the user's image provider (OpenAI, xAI or Together). The user sees the image in the chat with a download button; don't describe it at length afterwards. Write a vivid, specific description in English. Never use it for real private people (someone the user knows), for sexual content involving anyone who might be under 18, or for sexual images of real named people; refuse those yourself.",
      inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What the picture shows, its style, lighting and composition." }, aspect: ASPECT_PROP }, required: ["prompt"] },
      execute: async (args) => {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) throw new Error("Describe the picture to make.");
        try {
          const made = await generateImage(prompt, { aspect: aspectArg(args.aspect, "1:1") });
          return { message: `Made ${made.files.length === 1 ? "the image" : `${made.files.length} images`} with ${made.providerLabel} (${made.model}). The user already sees ${made.files.length === 1 ? "it" : "them"} in the chat with a download button; reply in one short sentence.` };
        } catch (error) {
          if (isMediaAnswer(error)) return { message: `Not made: ${error.message} Tell the user this plainly.` };
          throw error;
        }
      },
    },
    {
      name: "generate_video",
      description: "Generate a short video clip (1–15 seconds) from a description with the user's xAI key. It takes one to a few minutes and costs more than an image, so use it only when the user asks for a video or clip. The user sees the clip in the chat with a download button. The same content rules as generate_image apply.",
      inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What happens in the clip: subject, motion, camera, style." }, seconds: { type: "number", description: "Length in seconds, 1–15. Default 5." }, aspect: ASPECT_PROP }, required: ["prompt"] },
      requiresApproval: true,
      approvalDetails: (args) => ({ clip: String(args.prompt || "").slice(0, 300), seconds: secondsIn(`${Number(args.seconds) || 5} seconds`), cost: "Billed to the xAI account whose key is used; counts toward your daily budget when one is set.", time: "Usually one to three minutes." }),
      execute: async (args) => {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) throw new Error("Describe the clip to make.");
        try {
          const made = await generateVideo(prompt, { seconds: secondsIn(`${Number(args.seconds) || 5} seconds`), aspect: aspectArg(args.aspect, "16:9") });
          return { message: `Made the clip with ${made.providerLabel} (${made.model}). The user already sees it in the chat with a download button; reply in one short sentence.` };
        } catch (error) {
          if (isMediaAnswer(error)) return { message: `Not made: ${error.message} Tell the user this plainly.` };
          throw error;
        }
      },
    },
  ];
}
