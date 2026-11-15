export type BudgetComponent = "system" | "tools" | "context" | "history" | "current";

export const TokenBudgetService = {
  caps: { system: 1200, tools: 1500, context: 2000, history: 2000, current: 1000 },
  taskCap: 8000,
  spent: 0,
  decompose(text: string) {
    return Math.ceil(text.length / 4);
  },
  checkComponent(component: BudgetComponent, tokens: number) {
    if (tokens > this.caps[component]) throw new Error(`Token budget exceeded for ${component}`);
    return true;
  },
  charge(tokens: number) {
    this.spent += tokens;
    if (this.spent > this.taskCap) throw new Error("task budget exhausted");
  },
  resetTask() {
    this.spent = 0;
  },
  status() {
    return { spent: this.spent, cap: this.taskCap };
  },
};