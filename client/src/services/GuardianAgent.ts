export type Strictness = "permissive" | "balanced" | "strict";

export const GuardianAgent = {
  strictness: "balanced" as Strictness,
  setStrictness(level: Strictness) {
    this.strictness = level;
  },
  evaluate(action: { tool: string; args: unknown; intent?: string }) {
    const suspicious = /delete|exfiltrate|bypass|override/i.test(JSON.stringify(action));
    if (this.strictness === "strict" && suspicious) return { allowed: false, reason: "flagged by guardian" };
    if (this.strictness === "balanced" && suspicious) return { allowed: false, reason: "suspicious pattern" };
    return { allowed: true, reason: "ok" };
  },
  detectMultiTurn(history: string[]) {
    const joined = history.join(" ").toLowerCase();
    return /delete.*then.*send|bypass.*then.*execute/.test(joined);
  },
};