/// <reference lib="webworker" />
// Runs the WebLLM engine off the main thread. The engine library (~6 MB) is
// loaded only here; the page talks to it with the small message protocol
// below (see services/WebLLM.ts), so it isn't bundled a second time there.
import { MLCEngine } from "@mlc-ai/web-llm";

export type WorkerRequest =
  | { id: number; type: "load"; modelId: string }
  | { id: number; type: "generate"; messages: Array<{ role: "system" | "user" | "assistant"; content: string }> }
  | { id: number; type: "interrupt" };

export type WorkerResponse =
  | { id: number; type: "progress"; progress: number; text: string }
  | { id: number; type: "done"; content?: string }
  | { id: number; type: "error"; message: string };

const engine = new MLCEngine();
const post = (message: WorkerResponse) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      engine.setInitProgressCallback((report) => post({ id: request.id, type: "progress", progress: report.progress, text: report.text }));
      await engine.reload(request.modelId);
      post({ id: request.id, type: "done" });
    } else if (request.type === "generate") {
      const completion = await engine.chat.completions.create({ messages: request.messages, stream: false });
      post({ id: request.id, type: "done", content: completion.choices[0]?.message?.content ?? "" });
    } else if (request.type === "interrupt") {
      engine.interruptGenerate();
      post({ id: request.id, type: "done" });
    }
  } catch (error) {
    post({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
