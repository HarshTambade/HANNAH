/**
 * Shared pieces of the in-browser code runner (services/CodeRunner.ts and the
 * two workers in workers/). Everything here is plain logic with no DOM, so the
 * workers can import it and the tests can run it in Node.
 *
 * The sandbox has two layers. Each worker deletes or replaces the network,
 * nested-worker and eval entry points before any user code runs
 * (lockDownScope). Where HANNAH serves the worker files itself (the website,
 * dev and preview), the worker scripts also get their own strict
 * Content-Security-Policy header (CODE_WORKER_CSP), which the browser enforces
 * on everything the worker does, dynamic import() included.
 */

export type CodeLanguage = "python" | "javascript";
export type RunFile = { name: string; text: string };
export type RunTable = { columns: string[]; rows: string[][]; truncated: boolean };
export type RunStatus = "ok" | "error" | "timeout" | "unavailable";

export type RunResult = {
  language: CodeLanguage;
  status: RunStatus;
  stdout: string;
  stderr: string;
  /** The value of the last expression (Python), or what the code returned (JavaScript), as text. */
  result?: string;
  error?: string;
  /** PNG images as base64 (no data: prefix), from matplotlib figures. */
  images: string[];
  table?: RunTable;
  /** Some output was cut to stay within the limits. */
  truncated: boolean;
  durationMs: number;
  /** Files that were available to the code. */
  files: string[];
};

/** Pinned Pyodide release, loaded from the jsDelivr CDN the first time Python runs. */
export const PYODIDE_VERSION = "0.29.5";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export const LIMITS = {
  /** Wall-clock limit for one run; the worker is terminated when it passes. */
  timeoutMs: 20_000,
  maxTimeoutMs: 60_000,
  /** Downloading Python and its packages the first time. */
  pythonLoadMs: 120_000,
  maxCodeChars: 50_000,
  /** stdout and stderr together. */
  maxOutputChars: 20_000,
  maxResultChars: 5_000,
  maxImages: 4,
  maxImageBase64Chars: 2_000_000,
  maxTableRows: 50,
  maxTableColumns: 20,
  maxFiles: 4,
  maxFileChars: 2_000_000,
};

/**
 * Content-Security-Policy for the runner workers' own scripts. A worker loaded
 * from a URL is governed by the policy sent with its script, not the page's.
 * The JavaScript runner compiles the user's code with the AsyncFunction
 * constructor, hence 'unsafe-eval' there and only there; neither worker may
 * connect anywhere, except the Python worker to the pinned Pyodide files.
 * vercel.json carries the same values (checked by a test).
 */
export const CODE_WORKER_CSP = {
  javascript: "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'",
  python: `default-src 'none'; script-src 'self' ${PYODIDE_INDEX_URL} 'wasm-unsafe-eval'; connect-src ${PYODIDE_INDEX_URL}; worker-src 'none'`,
};

const languageAliases: Record<string, CodeLanguage> = {
  py: "python", python: "python", python3: "python", py3: "python",
  js: "javascript", javascript: "javascript", mjs: "javascript", node: "javascript",
};

/** The runnable language a code fence's tag names, or null. */
export function normalizeLanguage(tag: unknown): CodeLanguage | null {
  if (typeof tag !== "string") return null;
  return languageAliases[tag.trim().toLowerCase()] ?? null;
}

/** Collects stdout and stderr up to a shared character limit. */
export class OutputBuffer {
  stdout = "";
  stderr = "";
  truncated = false;
  private used = 0;
  constructor(private readonly limit = LIMITS.maxOutputChars) {}
  /** Returns false once the limit is reached, so a caller can stop sending more. */
  append(stream: "stdout" | "stderr", text: string): boolean {
    if (this.truncated) return false;
    const room = this.limit - this.used;
    const piece = text.length > room ? text.slice(0, room) : text;
    this.used += piece.length;
    if (stream === "stdout") this.stdout += piece; else this.stderr += piece;
    if (piece.length < text.length) {
      this.truncated = true;
      return false;
    }
    return true;
  }
}

/** Shorten text to `limit` characters, marking the cut. */
export function clip(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length > limit ? { text: `${text.slice(0, limit)}\n… (cut at ${limit.toLocaleString("en-US")} characters)`, truncated: true } : { text, truncated: false };
}

/**
 * JavaScript code can't use import (static or dynamic): an import() would
 * fetch a script from anywhere. A plain word check, so even "import" inside a
 * string is refused; the message says how to write it instead.
 */
export function findForbiddenJs(code: string): string | null {
  if (/\bimport\b/.test(code)) return "import isn't available in the sandbox: it has no network and no modules. Use plain JavaScript.";
  if (/\brequire\s*\(/.test(code)) return "require() isn't available in the sandbox: it has no modules. Use plain JavaScript.";
  return null;
}

const statementStart = /^(?:const|let|var|function|async\s+function|class|if|else|for|while|do|switch|case|default|try|catch|finally|return|throw|break|continue|import|export|\/\/|\/\*|\*|}|\)|\])/;

/**
 * Like a console, show the value of a trailing expression: the last line
 * becomes `return (…)` when that compiles. Returns null when the last line
 * isn't a lone expression (the caller then runs the code as written).
 */
export function withTrailingReturn(code: string): string | null {
  const lines = code.replace(/\s+$/, "").split("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!last || statementStart.test(last) || last.endsWith("{") || last.endsWith(",")) return null;
  // A multi-line expression whose last line is a fragment (`  .map(x => x)`) doesn't compile alone; the compile check catches it.
  const expression = last.replace(/;+\s*$/, "");
  if (!expression) return null;
  return [...lines.slice(0, -1), `return (${expression});`].join("\n");
}

/** An Error, also one from another realm (instanceof fails across realms). */
function isErrorLike(value: unknown): value is { name: string; message: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as Error).message === "string" && typeof (value as Error).name === "string" && Object.prototype.toString.call(value) === "[object Error]";
}

/** A readable one-value rendering, like a console's. */
export function formatValue(value: unknown, depth = 0): string {
  if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "(anonymous)"}]`;
  if (isErrorLike(value)) return `${value.name}: ${value.message}`;
  if (depth > 3) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => formatValue(item, depth + 1));
    return `[${items.join(", ")}${value.length > 100 ? `, … ${value.length - 100} more` : ""}]`;
  }
  if (value instanceof Map) return `Map(${value.size}) {${[...value].slice(0, 50).map(([key, item]) => `${formatValue(key, depth + 1)} => ${formatValue(item, depth + 1)}`).join(", ")}}`;
  if (value instanceof Set) return `Set(${value.size}) {${[...value].slice(0, 50).map((item) => formatValue(item, depth + 1)).join(", ")}}`;
  if (value instanceof Date) return value.toISOString();
  try {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    return `{${entries.map(([key, item]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${formatValue(item, depth + 1)}`).join(", ")}}`;
  } catch {
    return String(value);
  }
}

/** console.table's data as a table: an array of objects or arrays, or an object of rows. */
export function toTable(data: unknown): RunTable | null {
  if (!data || typeof data !== "object") return null;
  const entries: Array<[string, unknown]> = Array.isArray(data) ? data.map((row, index) => [String(index), row]) : Object.entries(data as Record<string, unknown>);
  if (!entries.length) return null;
  const columns: string[] = [];
  for (const [, row] of entries) {
    const keys = row && typeof row === "object" ? Object.keys(row as object) : ["Value"];
    for (const key of keys) if (!columns.includes(key) && columns.length < LIMITS.maxTableColumns) columns.push(key);
  }
  const rows = entries.slice(0, LIMITS.maxTableRows).map(([index, row]) => [
    index,
    ...columns.map((column) => {
      if (row && typeof row === "object") return column in (row as object) ? formatValue((row as Record<string, unknown>)[column], 1) : "";
      return column === "Value" ? formatValue(row, 1) : "";
    }),
  ]);
  return { columns: ["(index)", ...columns], rows, truncated: entries.length > LIMITS.maxTableRows };
}

/** A safe file name for the sandbox's working folder. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").trim().slice(0, 100);
  return cleaned || "file.txt";
}

/** Keep the files within the limits; anything over is left out. */
export function prepareFiles(files: RunFile[] | undefined): RunFile[] {
  const seen = new Set<string>();
  const chosen: RunFile[] = [];
  for (const file of files ?? []) {
    if (chosen.length >= LIMITS.maxFiles) break;
    if (typeof file?.text !== "string" || file.text.length > LIMITS.maxFileChars) continue;
    const name = safeFileName(String(file.name ?? ""));
    if (seen.has(name)) continue;
    seen.add(name);
    chosen.push({ name, text: file.text });
  }
  return chosen;
}

// ——— Locking down a worker ———

/** What user code may not reach: the network, other workers, storage shared with the app, and eval. */
export const BLOCKED_GLOBALS = [
  "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts",
  "Worker", "SharedWorker", "BroadcastChannel", "RTCPeerConnection", "indexedDB", "caches", "eval",
];

type Scope = Record<string, unknown>;

function blockProperty(target: object, name: string, replacement: unknown) {
  try {
    Object.defineProperty(target, name, { value: replacement, writable: false, configurable: false, enumerable: false });
  } catch {
    try { delete (target as Scope)[name]; } catch { /* not ours to change */ }
  }
}

/**
 * Remove the network and eval entry points from a worker's global scope, all
 * the way up its prototype chain (fetch lives on WorkerGlobalScope.prototype,
 * so shadowing it on `self` alone isn't enough). With `allowFetch`, fetch is
 * replaced by a wrapper that only lets through URLs starting with that prefix
 * (the Python worker still downloads Pyodide packages). With `blockFunctionConstructors`,
 * `new Function`, and its async and generator relatives reached through any function's
 * `.constructor`, throw. Strings passed to setTimeout and setInterval are refused.
 * Returns the names that were blocked.
 */
export function lockDownScope(scope: object, options: { allowFetch?: { prefix: string; fetch: (input: unknown, init?: unknown) => Promise<unknown> }; blockFunctionConstructors?: boolean; functionConstructors?: unknown[] } = {}): string[] {
  const blocked: string[] = [];
  const chain: object[] = [];
  for (let current: object | null = scope; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) chain.push(current);
  // A TypeError, as the browser throws for a failed request; Pyodide's loader expects one from importScripts in a module worker and falls back to import().
  const refuse = (name: string) => function blockedInSandbox() { throw new TypeError(`${name} is blocked in HANNAH's code sandbox (no network, no eval).`); };
  for (const name of BLOCKED_GLOBALS) {
    let replacement: unknown = refuse(name);
    if (name === "fetch" && options.allowFetch) {
      const { prefix, fetch: realFetch } = options.allowFetch;
      replacement = function guardedFetch(input: unknown, init?: unknown) {
        const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
        if (!url.startsWith(prefix)) return Promise.reject(new TypeError("fetch is blocked in HANNAH's code sandbox (no network)."));
        return realFetch(input, init);
      };
    }
    let found = false;
    for (const target of chain) {
      if (Object.prototype.hasOwnProperty.call(target, name)) {
        found = true;
        if (target !== scope) {
          try { delete (target as Scope)[name]; } catch { /* fall through to shadowing */ }
        }
      }
    }
    if (found || name === "fetch" || name === "eval") {
      blockProperty(scope, name, replacement);
      blocked.push(name);
    }
  }
  for (const name of ["setTimeout", "setInterval"]) {
    const original = (scope as Scope)[name];
    if (typeof original !== "function") continue;
    blockProperty(scope, name, function timerWithoutStrings(handler: unknown, ...rest: unknown[]) {
      if (typeof handler !== "function") throw new Error(`${name} needs a function in HANNAH's code sandbox, not a string.`);
      return (original as (...args: unknown[]) => unknown).call(scope, handler, ...rest);
    });
  }
  if (options.blockFunctionConstructors) {
    // The scope's own constructors when it is another realm (the tests' vm contexts); a worker's are this module's.
    const constructors = (options.functionConstructors ?? [
      Function,
      Object.getPrototypeOf(async function () { /* AsyncFunction */ }).constructor,
      Object.getPrototypeOf(function* () { /* GeneratorFunction */ }).constructor,
      Object.getPrototypeOf(async function* () { /* AsyncGeneratorFunction */ }).constructor,
    ]) as Array<{ prototype: object; name: string }>;
    // The stand-ins keep the original's name and prototype: Pyodide (and other code) reads `value.constructor.name`.
    const standIn = (ctor: { prototype: object; name: string }) => {
      const replacement = refuse(ctor.name);
      Object.defineProperty(replacement, "name", { value: ctor.name });
      Object.defineProperty(replacement, "prototype", { value: ctor.prototype });
      return replacement;
    };
    for (const ctor of constructors) blockProperty(ctor.prototype, "constructor", standIn(ctor));
    blockProperty(scope, "Function", standIn(constructors[0]));
    blocked.push("Function");
  }
  return blocked;
}

// ——— Running JavaScript ———

export type JsWorkerMessage =
  | { type: "out"; stream: "stdout" | "stderr"; text: string }
  | { type: "table"; table: RunTable }
  | { type: "done"; result?: string; error?: string };

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

/**
 * Run user JavaScript inside an already isolated scope (a fresh worker). The
 * code is compiled first, with `AsyncFunction` captured before the lockdown,
 * then the scope is locked down, then the code runs with a console that posts
 * its output and `files` (name → text) as its only inputs.
 */
export async function runJavaScript(code: string, files: RunFile[], context: { scope: object; AsyncFunction: AsyncFunctionConstructor; post: (message: JsWorkerMessage) => void }) {
  const { post } = context;
  const forbidden = findForbiddenJs(code);
  if (forbidden) { post({ type: "done", error: forbidden }); return; }
  let compiled: (...args: unknown[]) => Promise<unknown>;
  try {
    const returning = withTrailingReturn(code);
    compiled = (() => {
      if (returning) {
        try { return new context.AsyncFunction("console", "files", `"use strict";\n${returning}`); } catch { /* not a lone expression */ }
      }
      return new context.AsyncFunction("console", "files", `"use strict";\n${code}`);
    })();
  } catch (error) {
    post({ type: "done", error: isErrorLike(error) ? `${error.name}: ${error.message}` : String(error) });
    return;
  }
  let functionConstructors: unknown[] | undefined;
  try {
    functionConstructors = await new context.AsyncFunction("return [Function, (async function () {}).constructor, (function* () {}).constructor, (async function* () {}).constructor];")() as unknown[];
  } catch { /* fall back to this realm's, which is the worker's own */ }
  lockDownScope(context.scope, { blockFunctionConstructors: true, functionConstructors });
  let room = LIMITS.maxOutputChars;
  const write = (stream: "stdout" | "stderr") => (...values: unknown[]) => {
    if (room <= 0) return;
    const text = `${values.map((value) => formatValue(value)).join(" ")}\n`;
    room -= text.length;
    post({ type: "out", stream, text });
  };
  const sandboxConsole = Object.freeze({
    log: write("stdout"), info: write("stdout"), debug: write("stdout"),
    warn: write("stderr"), error: write("stderr"),
    table: (data: unknown) => { const table = toTable(data); if (table) post({ type: "table", table }); else write("stdout")(data); },
    dir: write("stdout"),
  });
  const fileMap = Object.freeze(Object.fromEntries(files.map((file) => [file.name, file.text])));
  try {
    const value = await compiled(sandboxConsole, fileMap);
    post({ type: "done", ...(value === undefined ? {} : { result: formatValue(value) }) });
  } catch (error) {
    post({ type: "done", error: isErrorLike(error) ? `${error.name}: ${error.message}` : `Uncaught ${formatValue(error)}` });
  }
}

// ——— Running Python ———

export type PyWorkerRequest = { type: "run"; id: number; code: string; files: RunFile[] };
export type PyWorkerMessage =
  | { type: "status"; id: number; text: string }
  | { type: "loaded"; id: number }
  | { type: "out"; id: number; stream: "stdout" | "stderr"; text: string }
  | { type: "done"; id: number; result?: string; error?: string; images?: string[]; table?: RunTable; unavailable?: boolean };

/**
 * The Python side of a run, executed by Pyodide with `__hannah_code` set. It
 * runs the code in one persistent namespace (so a later run sees earlier
 * variables, like a notebook), shows the last expression's value (a pandas
 * table as a table), and saves open matplotlib figures as PNG images.
 */
export const PYTHON_HARNESS = String.raw`
import sys, json, traceback, io, base64, os
os.environ.setdefault("MPLBACKEND", "AGG")
from pyodide.code import eval_code_async

if "__hannah_namespace" not in globals():
    __hannah_namespace = {"__name__": "__main__"}

def __hannah_cell(value):
    text = "" if value is None else str(value)
    return text if len(text) <= 200 else text[:200] + "…"

def __hannah_table(value, max_rows, max_cols):
    module = type(value).__module__ or ""
    if not module.startswith("pandas"):
        return None
    if type(value).__name__ == "Series":
        value = value.to_frame()
    if type(value).__name__ != "DataFrame":
        return None
    frame = value.iloc[:max_rows, :max_cols]
    columns = [str(name) for name in frame.columns]
    rows = [[__hannah_cell(index)] + [__hannah_cell(cell) for cell in row] for index, row in zip(frame.index, frame.itertuples(index=False))]
    return {"columns": [""] + columns, "rows": rows, "truncated": len(value) > max_rows or len(value.columns) > max_cols}

async def __hannah_run(code, limits):
    out = {}
    value = None
    try:
        value = await eval_code_async(code, __hannah_namespace, filename="<cell>")
    except BaseException:
        kind, error, trace = sys.exc_info()
        lines = traceback.format_exception(kind, error, trace)
        kept = [line for line in lines if "/lib/python" not in line and "_pyodide" not in line and "pyodide/" not in line]
        out["error"] = "".join(kept)[-limits["maxOutputChars"]:]
    if value is not None:
        try:
            table = __hannah_table(value, limits["maxTableRows"], limits["maxTableColumns"])
        except Exception:
            table = None
        if table:
            out["table"] = table
        else:
            text = repr(value)
            out["result"] = text if len(text) <= limits["maxResultChars"] else text[:limits["maxResultChars"]] + "…"
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        images = []
        for number in plt.get_fignums()[:limits["maxImages"]]:
            buffer = io.BytesIO()
            plt.figure(number).savefig(buffer, format="png", dpi=100, bbox_inches="tight")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            if len(encoded) <= limits["maxImageBase64Chars"]:
                images.append(encoded)
        plt.close("all")
        if images:
            out["images"] = images
    return json.dumps(out)

await __hannah_run(__hannah_code, json.loads(__hannah_limits))
`;

// ——— What the model reads ———

/** A compact text version of a run for the model (images and tables summarised). */
export function describeRun(result: RunResult): Record<string, unknown> {
  const description: Record<string, unknown> = { status: result.status, language: result.language };
  if (result.stdout) description.stdout = clip(result.stdout, 6_000).text;
  if (result.stderr) description.stderr = clip(result.stderr, 3_000).text;
  if (result.result !== undefined) description.result = clip(result.result, 3_000).text;
  if (result.error) description.error = clip(result.error, 3_000).text;
  if (result.table) description.table = { columns: result.table.columns, rows: result.table.rows.slice(0, 20), truncated: result.table.truncated || result.table.rows.length > 20 };
  if (result.images.length) description.images = `${result.images.length} image${result.images.length === 1 ? "" : "s"} shown to the user under the code`;
  if (result.truncated) description.note = "Some output was cut to stay within the sandbox's limits.";
  if (result.files.length) description.files = result.files;
  description.durationMs = Math.round(result.durationMs);
  return description;
}
