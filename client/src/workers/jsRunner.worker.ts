/// <reference lib="webworker" />
// Runs one piece of JavaScript from the chat, then is terminated by
// services/CodeRunner.ts (a fresh worker per run). No DOM; the network, eval
// and nested workers are removed before the code runs (services/codeSandbox.ts).
import { runJavaScript, type JsWorkerMessage, type RunFile } from "../services/codeSandbox";

const post = self.postMessage.bind(self) as (message: JsWorkerMessage) => void;
const AsyncFunction = Object.getPrototypeOf(async function () { /* AsyncFunction */ }).constructor;

self.onmessage = (event: MessageEvent<{ code: string; files: RunFile[] }>) => {
  self.onmessage = null;
  void runJavaScript(String(event.data?.code ?? ""), Array.isArray(event.data?.files) ? event.data.files : [], { scope: self, AsyncFunction, post });
};
