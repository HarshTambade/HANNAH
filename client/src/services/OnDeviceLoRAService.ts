import { PersonalizationEngine } from "./PersonalizationEngine";

/**
 * "Export training examples": the replies you liked, accepted or edited, as a
 * JSONL dataset for fine-tuning elsewhere. It's an export, so it runs at once
 * and changes nothing: no memories are written and no model weights change.
 */
export const OnDeviceLoRAService = {
  async prepare(onProgress: (progress: number) => void = () => {}) {
    onProgress(10);
    const jsonl = PersonalizationEngine.exportJsonl();
    const examples = jsonl ? jsonl.split("\n").filter((line) => line.trim()).length : 0;
    onProgress(100);
    return { jsonl, examples, ready: examples > 0 };
  },
};
