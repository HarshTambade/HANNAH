export type ReadinessState = "busy" | "focused" | "fatigued" | "open";

export const CognitiveReadinessEngine = {
  lastInteraction: Date.now(),
  interactionCount: 0,
  recordInteraction() {
    this.lastInteraction = Date.now();
    this.interactionCount += 1;
  },
  async readiness(): Promise<ReadinessState> {
    const idleMs = Date.now() - this.lastInteraction;
    if (idleMs < 60_000) return "busy";
    if (idleMs > 30 * 60_000) return "fatigued";
    if (this.interactionCount > 50) return "focused";
    return "open";
  },
};