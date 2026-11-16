import { PersonalizationEngine } from "./PersonalizationEngine";
import { DreamingConsolidator } from "./DreamingConsolidator";

export const OnDeviceLoRAService = {
  async prepare(onProgress: (progress: number) => void = () => {}) {
    onProgress(10);
    await DreamingConsolidator.start();
    onProgress(45);
    const jsonl = PersonalizationEngine.exportJsonl();
    const examples = jsonl ? jsonl.split("\n").length : 0;
    onProgress(100);
    return { jsonl, examples, ready: examples >= 3 };
  },
};
