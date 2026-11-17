"use strict";

/**
 * Runs one Code step inside QuickJS compiled to WebAssembly, in a worker
 * thread. The code gets no Node.js APIs at all: no require, process, fs,
 * network, timers or host objects. Only plain JavaScript, the items as JSON,
 * and a console.log that is captured.
 *
 * Isolation:
 * - It runs on a separate JavaScript engine with its own heap inside WASM
 *   linear memory, and the only bridge is a console.log callback that copies
 *   strings.
 * - QuickJS limits memory and stack, and an interrupt handler stops the code
 *   at its deadline.
 * - The parent thread terminates this worker if it overruns anyway.
 */
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { newQuickJSWASMModuleFromVariant, newVariant, shouldInterruptAfterDeadline } = require("quickjs-emscripten-core");
const releaseVariant = require("@jitl/quickjs-wasmfile-release-sync");

const MAX_LOG_LINES = 50;
const MAX_LOG_CHARS = 2000;

async function main() {
  const { code, mode, items, timeoutMs, memoryBytes, maxOutputBytes } = workerData;
  // Read the .wasm from an explicit path so bundlers and file tracing ship it.
  const wasmBinary = fs.readFileSync(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"));
  // QuickJS's own memory limit doesn't count every string allocation, so the
  // hard cap is the WebAssembly memory itself: it can't grow past this, and an
  // allocation beyond it fails inside the engine as "out of memory".
  const pages = Math.ceil((memoryBytes * 2) / 65536);
  const wasmMemory = new WebAssembly.Memory({ initial: Math.min(256, pages), maximum: pages });
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(releaseVariant.default || releaseVariant, { wasmBinary, wasmMemory }));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = runtime.newContext();
  const logs = [];
  try {
    const log = vm.newFunction("__log", (handle) => {
      if (logs.length < MAX_LOG_LINES) logs.push(String(vm.getString(handle)).slice(0, MAX_LOG_CHARS));
      return vm.undefined;
    });
    vm.setProp(vm.global, "__log", log);
    log.dispose();
    const input = vm.newString(JSON.stringify(items));
    vm.setProp(vm.global, "__input", input);
    input.dispose();

    // The user's code is a function body. In "each" mode it runs once per item
    // with $json and $index; in "all" mode once, with items.
    const body = `"use strict";\n${code}\n`;
    const program = `
      const __show = (value) => typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
      globalThis.console = Object.freeze({ log: (...args) => __log(args.map(__show).join(" ")), error: (...args) => __log("error: " + args.map(__show).join(" ")), warn: (...args) => __log("warn: " + args.map(__show).join(" ")) });
      const items = JSON.parse(__input).map((item) => item.json);
      const __run = new Function(${mode === "each" ? `"$json", "$index", "items"` : `"items", "$input"`}, ${JSON.stringify(body)});
      let __result;
      if (${JSON.stringify(mode)} === "each") {
        __result = [];
        for (let i = 0; i < items.length; i += 1) {
          const value = __run(items[i], i, items);
          if (value !== undefined && value !== null) __result.push(value);
        }
      } else {
        __result = __run(items, Object.freeze({ all: () => items, first: () => items[0], last: () => items[items.length - 1] }));
      }
      if (__result && typeof __result.then === "function") throw new Error("Return a value, not a promise: the Code step can't wait for anything.");
      JSON.stringify(__result === undefined ? null : __result);
    `;
    const result = vm.evalCode(program, "code-step.js");
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      const message = error && typeof error === "object" ? `${error.name || "Error"}: ${error.message || "the code failed"}` : String(error);
      const interrupted = /interrupted/i.test(message);
      // With memory exhausted the engine can't even build an error object.
      const outOfMemory = /out of memory/i.test(message) || error === null || error === undefined;
      parentPort.postMessage({ ok: false, logs, error: interrupted ? `The code ran longer than ${timeoutMs / 1000} seconds and was stopped.` : outOfMemory ? `The code used more than ${Math.round(memoryBytes / 1048576)} MB of memory and was stopped.` : message, kind: interrupted ? "timeout" : outOfMemory ? "memory" : "code" });
      return;
    }
    const output = vm.getString(result.value);
    result.value.dispose();
    if (Buffer.byteLength(output) > maxOutputBytes) {
      parentPort.postMessage({ ok: false, logs, error: `The code returned more than ${Math.round(maxOutputBytes / 1024)} KB of data.`, kind: "output" });
      return;
    }
    parentPort.postMessage({ ok: true, logs, output });
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

main().catch((error) => parentPort.postMessage({ ok: false, logs: [], error: `The code sandbox couldn't start: ${error.message}`, kind: "sandbox" }));
