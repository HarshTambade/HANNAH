import { PersonalizationEngine } from "./PersonalizationEngine";
import { DreamingConsolidator } from "./DreamingConsolidator";
import { CognitiveReadinessEngine } from "./CognitiveReadinessEngine";

export const OnDeviceLoRAService = {
  async prepare(onProgress: (progress: number) => void = () => {}) {
    onProgress(5);
    const idleWindow = await new Promise<boolean>((resolve) => {
      const startedAt = Date.now();
      const check = async () => {
        const state = await CognitiveReadinessEngine.readiness();
        if (state === "open" || state === "focused") { resolve(true); return; }
        if (state === "fatigued" || Date.now() - startedAt > 2 * 60_000) { resolve(false); return; }
        onProgress(15);
        setTimeout(check, 2_000);
      };
      if ("requestIdleCallback" in window) (window as any).requestIdleCallback(() => void check(), { timeout: 10_000 });
      else setTimeout(check, 500);
    });
    if (!idleWindow) return { jsonl: "", examples: 0, ready: false };
    onProgress(25);
    await DreamingConsolidator.start();
    onProgress(65);
    const jsonl = PersonalizationEngine.exportJsonl();
    const examples = jsonl ? jsonl.split("\n").length : 0;
    onProgress(100);
    return { jsonl, examples, ready: examples >= 3 };
  },
};
