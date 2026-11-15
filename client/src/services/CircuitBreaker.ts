export class CircuitBreaker {
  failures = new Map<string, number>();
  disabled = new Set<string>();

  recordFailure(tool: string) {
    const count = (this.failures.get(tool) || 0) + 1;
    this.failures.set(tool, count);
    if (count >= 3) this.disabled.add(tool);
  }
  recordSuccess(tool: string) {
    this.failures.set(tool, 0);
  }
  isDisabled(tool: string) {
    return this.disabled.has(tool);
  }
  resetSession() {
    this.failures.clear();
    this.disabled.clear();
  }
}

export const toolCircuitBreaker = new CircuitBreaker();