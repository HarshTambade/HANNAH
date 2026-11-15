export const AgentInsuranceLedger = {
  entries: [] as Array<{ id: string; action: string; collateral: number; claimStatus: string; at: number }>,
  record(action: string, collateral = 0) {
    this.entries.push({ id: crypto.randomUUID(), action, collateral, claimStatus: "none", at: Date.now() });
  },
  list() {
    return this.entries;
  },
};