/**
 * Code execution in chat: Python (Pyodide) and JavaScript run in Web Workers
 * in the user's own browser or app, never on a server. Used by the Run button
 * on code blocks (components/CodeBlock.tsx) and by the agent's run_code tool.
 *
 * - JavaScript: a fresh worker per run, terminated afterwards.
 * - Python: one worker kept between runs (variables carry over), downloaded
 *   from the pinned Pyodide release the first time; that needs a connection.
 * - Every run has a hard time limit: the worker is terminated when it passes.
 *   Output, images, tables and files are capped (codeSandbox.ts LIMITS). Memory
 *   isn't capped beyond what the browser allows one worker.
 */
import type { HANNAHTool } from "./DeviceTools";
import { LIMITS, OutputBuffer, clip, describeRun, prepareFiles, type CodeLanguage, type JsWorkerMessage, type PyWorkerMessage, type RunFile, type RunResult, type RunTable } from "./codeSandbox";
import { getAttachments, getUploadedFile } from "./Studio";

export type { CodeLanguage, RunFile, RunResult } from "./codeSandbox";

export type WorkerLike = {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};
export type WorkerFactory = (language: CodeLanguage) => WorkerLike;

export type RunRequest = {
  language: CodeLanguage;
  code: string;
  files?: RunFile[];
  timeoutMs?: number;
  /** Progress while Python downloads ("Downloading Python…"). */
  onStatus?: (text: string) => void;
};

const PYTHON_LOADED_KEY = "hannah.codeRunner.pythonLoaded";
export const OFFLINE_PYTHON_MESSAGE = "Python needs an internet connection the first time it runs, to download it (about 10 MB). After that this device keeps a copy.";

const defaultWorkerFactory: WorkerFactory = (language) => (language === "python"
  ? new Worker(new URL("../workers/pyRunner.worker.ts", import.meta.url), { type: "module", name: "hannah-python" })
  : new Worker(new URL("../workers/jsRunner.worker.ts", import.meta.url), { type: "module", name: "hannah-javascript" })) as unknown as WorkerLike;

function readFlag(key: string) {
  try { return globalThis.localStorage?.getItem(key) === "1"; } catch { return false; }
}
function writeFlag(key: string) {
  try { globalThis.localStorage?.setItem(key, "1"); } catch { /* the next first run checks the connection again */ }
}

type RunnerOptions = {
  createWorker?: WorkerFactory;
  isOnline?: () => boolean;
  now?: () => number;
  /** Whether a Worker can be created at all (false in very old WebViews). */
  workersSupported?: () => boolean;
};

export function createCodeRunner(options: RunnerOptions = {}) {
  const createWorker = options.createWorker ?? defaultWorkerFactory;
  const isOnline = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const workersSupported = options.workersSupported ?? (() => typeof Worker !== "undefined");
  let python: WorkerLike | null = null;
  let pythonQueue: Promise<unknown> = Promise.resolve();
  let nextId = 1;

  const finish = (language: CodeLanguage, started: number, files: RunFile[], output: OutputBuffer, fields: Partial<RunResult> & { status: RunResult["status"] }): RunResult => {
    let truncated = output.truncated || Boolean(fields.truncated);
    let result = fields.result;
    if (result !== undefined) { const cut = clip(result, LIMITS.maxResultChars); result = cut.text; truncated ||= cut.truncated; }
    let error = fields.error;
    if (error !== undefined) { const cut = clip(error, LIMITS.maxOutputChars); error = cut.text; truncated ||= cut.truncated; }
    const allImages = (fields.images ?? []).filter((image) => typeof image === "string" && image.length <= LIMITS.maxImageBase64Chars && /^[A-Za-z0-9+/=]+$/.test(image));
    const images = allImages.slice(0, LIMITS.maxImages);
    if (images.length < (fields.images?.length ?? 0)) truncated = true;
    const table = fields.table ? capTable(fields.table) : undefined;
    if (table?.truncated) truncated = true;
    return {
      language, status: fields.status, stdout: output.stdout, stderr: output.stderr, images, truncated,
      durationMs: Math.max(0, now() - started), files: files.map((file) => file.name),
      ...(result !== undefined ? { result } : {}), ...(error !== undefined ? { error } : {}), ...(table ? { table } : {}),
    };
  };

  function runJs(code: string, files: RunFile[], timeoutMs: number): Promise<RunResult> {
    const started = now();
    const output = new OutputBuffer();
    let table: RunTable | undefined;
    return new Promise((resolve) => {
      let worker: WorkerLike;
      try { worker = createWorker("javascript"); } catch (error) {
        resolve(finish("javascript", started, files, output, { status: "unavailable", error: `The JavaScript sandbox couldn't start: ${error instanceof Error ? error.message : String(error)}` }));
        return;
      }
      let settled = false;
      const settle = (fields: Partial<RunResult> & { status: RunResult["status"] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        resolve(finish("javascript", started, files, output, { ...fields, ...(table ? { table } : {}) }));
      };
      const timer = setTimeout(() => settle({ status: "timeout", error: timeoutMessage(timeoutMs) }), timeoutMs);
      worker.onmessage = (event: MessageEvent<JsWorkerMessage>) => {
        const message = event.data;
        if (message?.type === "out") output.append(message.stream === "stderr" ? "stderr" : "stdout", String(message.text));
        else if (message?.type === "table") table ??= message.table;
        else if (message?.type === "done") settle(message.error ? { status: "error", error: String(message.error), ...(message.result !== undefined ? { result: String(message.result) } : {}) } : { status: "ok", ...(message.result !== undefined ? { result: String(message.result) } : {}) });
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault?.();
        settle({ status: "error", error: event.message || "The JavaScript sandbox stopped with an error." });
      };
      worker.postMessage({ code, files });
    });
  }

  function runPython(code: string, files: RunFile[], timeoutMs: number, onStatus?: (text: string) => void): Promise<RunResult> {
    const started = now();
    const output = new OutputBuffer();
    if (!python && !readFlag(PYTHON_LOADED_KEY) && !isOnline()) {
      return Promise.resolve(finish("python", started, files, output, { status: "unavailable", error: OFFLINE_PYTHON_MESSAGE }));
    }
    return new Promise((resolve) => {
      let worker: WorkerLike;
      try { worker = python ?? createWorker("python"); } catch (error) {
        resolve(finish("python", started, files, output, { status: "unavailable", error: `The Python sandbox couldn't start: ${error instanceof Error ? error.message : String(error)}` }));
        return;
      }
      python = worker;
      const id = nextId++;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const discard = () => { worker.terminate(); if (python === worker) python = null; };
      const settle = (fields: Partial<RunResult> & { status: RunResult["status"] }, restart = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        if (restart) discard();
        resolve(finish("python", started, files, output, fields));
      };
      const arm = (ms: number, message: string, status: RunResult["status"]) => {
        clearTimeout(timer);
        timer = setTimeout(() => settle({ status, error: message }, true), ms);
      };
      // Until Python has loaded, the longer download limit applies; then the run's own.
      arm(Math.max(timeoutMs, LIMITS.pythonLoadMs), "Python took too long to download. Check the connection and try again.", "unavailable");
      worker.onmessage = (event: MessageEvent<PyWorkerMessage>) => {
        const message = event.data;
        if (!message || message.id !== id) return;
        if (message.type === "status") onStatus?.(String(message.text));
        else if (message.type === "loaded") { writeFlag(PYTHON_LOADED_KEY); arm(timeoutMs, `${timeoutMessage(timeoutMs)} Python was restarted, so earlier variables are gone.`, "timeout"); }
        else if (message.type === "out") output.append(message.stream === "stderr" ? "stderr" : "stdout", String(message.text));
        else if (message.type === "done") {
          if (message.unavailable) settle({ status: "unavailable", error: String(message.error ?? OFFLINE_PYTHON_MESSAGE) }, true);
          else settle({
            status: message.error ? "error" : "ok",
            ...(message.error ? { error: String(message.error) } : {}),
            ...(message.result !== undefined ? { result: String(message.result) } : {}),
            ...(Array.isArray(message.images) ? { images: message.images } : {}),
            ...(message.table ? { table: message.table } : {}),
          });
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault?.();
        settle({ status: "error", error: event.message || "The Python sandbox stopped with an error." }, true);
      };
      worker.postMessage({ type: "run", id, code, files });
    });
  }

  return {
    /** Run code and wait for its result. Never throws; failures come back as a status. */
    run(request: RunRequest): Promise<RunResult> {
      const language = request.language;
      const code = typeof request.code === "string" ? request.code : "";
      const files = prepareFiles(request.files);
      const timeoutMs = Math.min(LIMITS.maxTimeoutMs, Math.max(1_000, Math.round(request.timeoutMs ?? LIMITS.timeoutMs)));
      const empty = (status: RunResult["status"], error: string): Promise<RunResult> => Promise.resolve({ language, status, stdout: "", stderr: "", images: [], truncated: false, durationMs: 0, files: [], error });
      if (language !== "python" && language !== "javascript") return empty("error", "Only Python and JavaScript can run here.");
      if (!code.trim()) return empty("error", "There is no code to run.");
      if (code.length > LIMITS.maxCodeChars) return empty("error", `The code is longer than ${LIMITS.maxCodeChars.toLocaleString("en-US")} characters, the most one run takes.`);
      if (!workersSupported()) return empty("unavailable", "This browser can't run code in the background (no Web Workers).");
      if (language === "javascript") return runJs(code, files, timeoutMs);
      const next = pythonQueue.then(() => runPython(code, files, timeoutMs, request.onStatus));
      pythonQueue = next.catch(() => undefined);
      return next;
    },
    /** Stop Python and forget its variables. */
    resetPython() {
      python?.terminate();
      python = null;
    },
  };
}

function timeoutMessage(ms: number) {
  return `Stopped after ${Math.round(ms / 1000)} s, the time limit for one run.`;
}

function capTable(table: RunTable): RunTable {
  const columns = (Array.isArray(table.columns) ? table.columns : []).slice(0, LIMITS.maxTableColumns + 1).map(String);
  const rows = (Array.isArray(table.rows) ? table.rows : []).slice(0, LIMITS.maxTableRows).map((row) => (Array.isArray(row) ? row : []).slice(0, columns.length).map((cell) => clip(String(cell ?? ""), 200).text));
  return { columns, rows, truncated: Boolean(table.truncated) || (table.rows?.length ?? 0) > LIMITS.maxTableRows };
}

/** The runner the app uses. */
export const CodeRunner = createCodeRunner();

// ——— Files attached to the chat ———

const TEXT_FILE = /\.(csv|tsv|txt|json|md|xml|ya?ml|log|py|js|ts|html?|ini|toml)$/i;

/** The files attached to this conversation, as text the code can open. */
export async function attachedRunFiles(): Promise<RunFile[]> {
  const files: RunFile[] = [];
  for (const attachment of getAttachments()) {
    const original = getUploadedFile(attachment.name);
    if (original && TEXT_FILE.test(original.name) && original.size <= LIMITS.maxFileChars) {
      try { files.push({ name: original.name, text: await original.text() }); continue; } catch { /* fall back to what was read from it */ }
    }
    if (attachment.tables.length) {
      const base = attachment.name.replace(/\.[^.]+$/, "");
      attachment.tables.forEach((table, index) => files.push({ name: attachment.tables.length === 1 ? `${base}.csv` : `${base}-${table.name || index + 1}.csv`, text: toCsv(table.columns, table.rows) }));
    } else {
      files.push({ name: TEXT_FILE.test(attachment.name) ? attachment.name : `${attachment.name}.txt`, text: attachment.text });
    }
  }
  return prepareFiles(files);
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}

// ——— Runs the agent made, for the reply to show ———

export const CODE_RUN_EVENT = "hannah:code-run";
export type RecordedRun = { id: string; language: CodeLanguage; code: string; result: RunResult };
const recorded = new Map<string, RecordedRun>();

export function recordRun(language: CodeLanguage, code: string, result: RunResult): RecordedRun {
  const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const run = { id, language, code, result };
  recorded.set(id, run);
  while (recorded.size > 40) recorded.delete(recorded.keys().next().value as string);
  try { window.dispatchEvent(new CustomEvent(CODE_RUN_EVENT, { detail: run })); } catch { /* no window here */ }
  return run;
}
export const getRecordedRun = (id: string) => recorded.get(id);

// ——— The agent's tool ———

export function getCodeTools(runner = CodeRunner): HANNAHTool[] {
  return [{
    name: "run_code",
    description: "Run Python or JavaScript in a sandbox in the user's own browser and get the output back: printed text, errors, the last expression's value, pandas tables, and matplotlib charts (the user sees the charts under the code). Use it to calculate, analyse data, check logic, or draw a chart instead of working numbers out in your head. Python has numpy, pandas, matplotlib and the standard library (packages load on first import); variables persist between Python runs. There is no network, no input(), and a 20-second limit per run. With use_attached_files, the files attached to this conversation are in the working folder (open('data.csv') in Python, files['data.csv'] in JavaScript).",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "javascript"], description: "python (default) or javascript." },
        code: { type: "string", description: "The complete code to run. End with an expression or print() to see a value." },
        use_attached_files: { type: "boolean", description: "Make the conversation's attached files available to the code." },
      },
      required: ["code"],
    },
    execute: async (args) => {
      const language: CodeLanguage = args.language === "javascript" ? "javascript" : "python";
      const code = String(args.code ?? "");
      const files = args.use_attached_files ? await attachedRunFiles() : [];
      const result = await runner.run({ language, code, files });
      recordRun(language, code, result);
      return describeRun(result);
    },
  }];
}
