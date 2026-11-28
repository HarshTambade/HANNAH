/// <reference lib="webworker" />
// Python for the chat: Pyodide (CPython compiled to WebAssembly), loaded from
// the pinned jsDelivr release the first time a run asks for it. The worker
// stays alive between runs, so variables carry over like a notebook, until a
// run times out and services/CodeRunner.ts terminates it.
//
// Before Pyodide loads, fetch is narrowed to the Pyodide release folder (it
// still downloads packages such as numpy) and every other network, eval and
// worker entry point is removed, so Python code (through `import js`) can't
// reach the network either.
import { LIMITS, PYODIDE_INDEX_URL, PYTHON_HARNESS, lockDownScope, type PyWorkerMessage, type PyWorkerRequest, type RunTable } from "../services/codeSandbox";

type Pyodide = {
  globals: { set(name: string, value: unknown): void };
  FS: { writeFile(path: string, data: string): void; mkdirTree(path: string): void };
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  setStdin(options: { error: boolean }): void;
  loadPackagesFromImports(code: string, options?: { messageCallback?: (message: string) => void; errorCallback?: (message: string) => void }): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
};

const post = self.postMessage.bind(self) as (message: PyWorkerMessage) => void;
const realFetch = self.fetch.bind(self);
let pyodide: Promise<Pyodide> | null = null;
let currentRun = 0;
let room = 0;

lockDownScope(self, { allowFetch: { prefix: PYODIDE_INDEX_URL, fetch: realFetch as (input: unknown, init?: unknown) => Promise<unknown> } });

function load(id: number): Promise<Pyodide> {
  if (!pyodide) {
    pyodide = (async () => {
      post({ type: "status", id, text: "Downloading Python (first time only)…" });
      const module = await import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`) as { loadPyodide: (options: Record<string, unknown>) => Promise<Pyodide> };
      const instance = await module.loadPyodide({ indexURL: PYODIDE_INDEX_URL, packageBaseUrl: PYODIDE_INDEX_URL, env: { HOME: "/home/pyodide", MPLBACKEND: "AGG" } });
      const write = (stream: "stdout" | "stderr") => (text: string) => {
        if (room <= 0) return;
        const piece = `${text}\n`;
        room -= piece.length;
        post({ type: "out", id: currentRun, stream, text: piece });
      };
      instance.setStdout({ batched: write("stdout") });
      instance.setStderr({ batched: write("stderr") });
      instance.setStdin({ error: true });
      // Python code can reach JavaScript through `import js`; without these it can't compile new JavaScript.
      lockDownScope(self, { blockFunctionConstructors: true });
      return instance;
    })();
    pyodide.catch(() => { pyodide = null; });
  }
  return pyodide;
}

self.onmessage = async (event: MessageEvent<PyWorkerRequest>) => {
  const request = event.data;
  if (request?.type !== "run") return;
  const { id } = request;
  let instance: Pyodide;
  try {
    instance = await load(id);
  } catch (error) {
    post({ type: "done", id, unavailable: true, error: `Python couldn't load: ${(error instanceof Error ? error.message : String(error)).replace(/\.+$/, "")}. It needs an internet connection the first time.` });
    return;
  }
  post({ type: "loaded", id });
  currentRun = id;
  room = LIMITS.maxOutputChars;
  try {
    instance.FS.mkdirTree("/home/pyodide");
    for (const file of request.files ?? []) instance.FS.writeFile(`/home/pyodide/${file.name}`, file.text);
    await instance.loadPackagesFromImports(request.code, {
      messageCallback: (message) => { if (/^Loading /.test(message)) post({ type: "status", id, text: message.replace(/^Loading /, "Loading Python packages: ") }); },
      errorCallback: (message) => post({ type: "out", id, stream: "stderr", text: `${message}\n` }),
    });
    instance.globals.set("__hannah_code", request.code);
    instance.globals.set("__hannah_limits", JSON.stringify(LIMITS));
    const raw = await instance.runPythonAsync(PYTHON_HARNESS);
    const parsed = JSON.parse(String(raw)) as { result?: string; error?: string; images?: string[]; table?: RunTable };
    post({ type: "done", id, ...parsed });
  } catch (error) {
    post({ type: "done", id, error: error instanceof Error ? error.message : String(error) });
  }
};
