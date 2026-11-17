"use strict";

/**
 * The Code step's sandbox. Each run gets a fresh worker thread hosting a fresh
 * QuickJS engine (see sandbox-worker.js), so nothing leaks between runs or
 * between users.
 *
 * Limits:
 * - CPU time: QuickJS's own interrupt, plus a hard terminate from here.
 * - Memory: inside QuickJS, and as a heap cap on the worker.
 * - Output size.
 *
 * The code never sees the server, credentials, other items' workflows, the
 * network or the file system.
 */
const { Worker } = require("node:worker_threads");

const DEFAULTS = { timeoutMs: 2000, memoryBytes: 32 * 1024 * 1024, maxOutputBytes: 1024 * 1024 };

function runCode({ code, mode = "all", items = [], timeoutMs = DEFAULTS.timeoutMs, memoryBytes = DEFAULTS.memoryBytes, maxOutputBytes = DEFAULTS.maxOutputBytes, signal } = {}) {
  return new Promise((resolve, reject) => {
    // require.resolve (not a computed path) so deployment file tracing ships the worker.
    const worker = new Worker(require.resolve("./sandbox-worker.js"), {
      workerData: { code: String(code), mode: mode === "each" ? "each" : "all", items, timeoutMs, memoryBytes, maxOutputBytes },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {},
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const failWith = (message, kind, logs = []) => finish(reject, Object.assign(new Error(message), { code: `code-${kind}`, retryable: false, logs }));
    // Startup (WASM compile) is outside the code's own budget; this backstop isn't.
    const timer = setTimeout(() => failWith(`The code ran longer than ${timeoutMs / 1000} seconds and was stopped.`, "timeout"), timeoutMs + 5000);
    const onAbort = () => failWith("Cancelled.", "cancelled");
    signal?.addEventListener?.("abort", onAbort, { once: true });
    worker.once("message", (message) => {
      if (!message.ok) return failWith(message.error, message.kind, message.logs);
      let value;
      try {
        value = JSON.parse(message.output);
      } catch {
        return failWith("The code's result couldn't be read.", "output", message.logs);
      }
      finish(resolve, { value, logs: message.logs });
    });
    worker.once("error", (error) => failWith(/memory/i.test(error.message) ? "The code used too much memory and was stopped." : `The code sandbox failed: ${error.message}`, "sandbox"));
    worker.once("exit", (exitCode) => failWith(`The code sandbox stopped unexpectedly (exit ${exitCode}).`, "sandbox"));
  });
}

/** Turn what the code returned into items: [{json}], one per object. */
function toItems(value) {
  const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list.map((entry, index) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const keys = Object.keys(entry);
      if (keys.length === 1 && keys[0] === "json" && entry.json && typeof entry.json === "object" && !Array.isArray(entry.json)) return { json: entry.json };
      return { json: entry };
    }
    if (entry === null || entry === undefined) throw Object.assign(new Error(`Item ${index + 1} of the code's result is empty.`), { retryable: false });
    return { json: { value: entry } };
  });
}

module.exports = { DEFAULTS, runCode, toItems };
