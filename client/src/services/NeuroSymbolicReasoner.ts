export const NeuroSymbolicReasoner = {
  verify(action: { type: string; payload: unknown }) {
    const forbidden = JSON.stringify(action).toLowerCase();
    if (forbidden.includes("ignore privacy") || forbidden.includes("bypass")) {
      return { allowed: false, reason: "symbolic constraint violation" };
    }
    return { allowed: true, reason: "consistent" };
  },
};