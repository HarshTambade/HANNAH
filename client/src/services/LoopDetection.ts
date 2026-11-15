export const LoopDetection = {
  history: [] as string[],
  threshold: 3,
  check(tool: string, args: unknown) {
    const key = `${tool}:${JSON.stringify(args)}`;
    const recent = this.history.filter((entry) => entry === key);
    if (recent.length >= this.threshold) {
      console.warn("Loop detected; blocking repeated tool call", key);
      return false;
    }
    this.history.push(key);
    if (this.history.length > 50) this.history.shift();
    return true;
  },
  reset() {
    this.history = [];
  },
};