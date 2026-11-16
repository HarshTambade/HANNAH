import { ChaosEngine } from "./ChaosEngine";

export type MemoryResolution<T> = { status: "resolved"; value: T } | { status: "abstained"; reason: string };

export const MemoryResolutionService = {
  resolve<T>(candidate: T, isValid: (value: T) => boolean = () => true): MemoryResolution<T> {
    if (ChaosEngine.consume("corrupted-memory")) return { status: "abstained", reason: "Memory integrity check failed; no memory was used." };
    try {
      if (!isValid(candidate)) return { status: "abstained", reason: "Retrieved memory did not pass validation." };
      return { status: "resolved", value: candidate };
    } catch {
      return { status: "abstained", reason: "Retrieved memory could not be validated." };
    }
  },
};
