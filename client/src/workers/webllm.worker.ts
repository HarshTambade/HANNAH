/// <reference lib="webworker" />
// Runs the WebLLM engine off the main thread. Lives in our source tree (not
// inside a package) so Vite bundles it in both dev and production builds.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (message: MessageEvent) => handler.onmessage(message);
