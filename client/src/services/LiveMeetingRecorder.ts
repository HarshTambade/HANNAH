/**
 * Live meeting notes from this device's microphone.
 *
 * The recorder is restarted every `pieceMs` so that each piece is a complete,
 * playable file (a MediaRecorder timeslice after the first has no header).
 * Pieces go to the server one at a time, in order, with their number and
 * offset; the server transcribes each with the account's own key and keeps
 * only the text. A piece that failed for a passing reason is retried; a piece
 * the server already has is acknowledged without being transcribed again.
 */

export type RecorderDeps = {
  getStream: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => Pick<MediaRecorder, "start" | "stop" | "state" | "mimeType" | "ondataavailable" | "onstop">;
  upload: (seq: number, atMs: number, piece: Blob) => Promise<{ text: string }>;
  onText: (line: string) => void;
  onProblem: (message: string, fatal: boolean) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  wait?: (ms: number) => Promise<void>;
};

/** Errors from upload carry an HTTP status when the server answered. */
type UploadError = Error & { status?: number };
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function pickAudioType(isSupported: (type: string) => boolean = (type) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => isSupported(type)) || "";
}

export function startLiveRecorder({ firstSeq = 0, pieceMs = 20_000, ...deps }: RecorderDeps & { firstSeq?: number; pieceMs?: number }) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((id) => window.clearTimeout(id));
  const wait = deps.wait ?? ((ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  let stream: MediaStream | null = null;
  let recorder: ReturnType<RecorderDeps["createRecorder"]> | null = null;
  let timer = 0;
  let running = true;
  let seq = firstSeq;
  const startedAt = now();
  let pieceStartedAt = startedAt;
  let queue: Promise<void> = Promise.resolve();
  let fatal = false;

  const send = (piece: Blob, number: number, atMs: number) => {
    queue = queue.then(async () => {
      if (fatal) return;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const { text } = await deps.upload(number, atMs, piece);
          if (text) deps.onText(text);
          return;
        } catch (error) {
          const status = (error as UploadError).status;
          const message = error instanceof Error ? error.message : "A part of the meeting wasn't transcribed.";
          if (status !== undefined && !RETRYABLE.has(status)) {
            // The server refused (meeting ended, no key, consent): stop for good.
            fatal = true;
            running = false;
            stopRecorder();
            deps.onProblem(message, true);
            return;
          }
          if (attempt === 2) { deps.onProblem(`${message} That part of the meeting is missing from the notes.`, false); return; }
          await wait(2000 * (attempt + 1));
        }
      }
    });
  };

  const stopRecorder = () => {
    clearTimer(timer);
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const startPiece = () => {
    if (!running || !stream) return;
    const current = deps.createRecorder(stream);
    recorder = current;
    const chunks: Blob[] = [];
    const offset = pieceStartedAt - startedAt;
    current.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    current.onstop = () => {
      const piece = new Blob(chunks, { type: current.mimeType || chunks[0]?.type || "audio/webm" });
      if (piece.size) send(piece, seq++, offset);
      pieceStartedAt = now();
      if (running) startPiece();
    };
    current.start();
    timer = setTimer(() => { if (current.state !== "inactive") current.stop(); }, pieceMs);
  };

  const ready = (async () => {
    try {
      stream = await deps.getStream();
    } catch (error) {
      running = false;
      deps.onProblem(error instanceof Error && /denied|not allowed|permission/i.test(error.message) ? "Microphone access was refused. Allow it in the browser to take live notes." : "The microphone didn't start.", true);
      return false;
    }
    startPiece();
    return true;
  })();

  return {
    ready,
    /** Stop recording, send the last piece, and wait until every piece is answered. */
    stop: async () => {
      await ready;
      running = false;
      const last = recorder;
      if (last && last.state !== "inactive") {
        await new Promise<void>((resolve) => {
          const previous = last.onstop;
          last.onstop = (event: Event) => { previous?.call(last as MediaRecorder, event); resolve(); };
          stopRecorder();
        });
      }
      stream?.getTracks().forEach((track) => track.stop());
      await queue;
    },
    get nextSeq() { return seq; },
  };
}
