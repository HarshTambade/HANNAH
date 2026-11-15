export const LATENCY_BUDGETS = {
  inlineSuggestionMs: 800,
  fullGenerationMs: 8000,
  summaryMs: 3000,
  toolCallMs: 5000,
};

export function checkBudget(kind: keyof typeof LATENCY_BUDGETS, elapsedMs: number) {
  const budget = LATENCY_BUDGETS[kind];
  if (elapsedMs > budget) {
    console.warn(`Latency budget exceeded for ${kind}: ${elapsedMs}ms > ${budget}ms`);
    return false;
  }
  return true;
}