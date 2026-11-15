export type Strictness = "permissive" | "balanced" | "strict";

export type GuardianDecision = {
  allowed: boolean;
  reason: string;
  riskVector: Record<string, number>;
};

const SUSPICIOUS_PATTERNS = [
  /delete.*then.*send/i,
  /bypass.*then.*execute/i,
  /ignore.*safety/i,
  /override.*consent/i,
  /exfiltrate/i,
  /disable.*guardian/i,
];

export const GuardianAgent = {
  strictness: "balanced" as Strictness,
  history: [] as string[],
  setStrictness(level: Strictness) {
    this.strictness = level;
  },
  evaluate(action: { tool: string; args: unknown; intent?: string }): GuardianDecision {
    const payload = JSON.stringify({ ...action, args: action.args }).toLowerCase();
    const riskVector: Record<string, number> = {
      intent_uncertainty: action.intent ? 0.2 : 0.8,
      consequence_severity: /delete|shell|write_file|send_message/.test(payload) ? 0.8 : 0.2,
      action_irreversibility: /delete|shell|write_file/.test(payload) ? 0.9 : 0.1,
      memory_uncertainty: 0.3,
      environmental_risk: 0.2,
    };
    const score = Object.values(riskVector).reduce((a, b) => a + b, 0) / Object.keys(riskVector).length;

    const suspicious = SUSPICIOUS_PATTERNS.some((re) => re.test(payload));
    const multiTurn = this.detectMultiTurn();

    let allowed = true;
    let reason = "ok";

    if (this.strictness === "strict") {
      if (suspicious || score > 0.5 || multiTurn) {
        allowed = false;
        reason = "strict mode: flagged by guardian";
      }
    } else if (this.strictness === "balanced") {
      if (suspicious || multiTurn) {
        allowed = false;
        reason = "balanced mode: suspicious or multi-turn pattern";
      }
    }

    this.history.push(payload);
    if (this.history.length > 100) this.history.shift();

    return { allowed, reason, riskVector: score > 0.7 ? riskVector : {} };
  },
  detectMultiTurn() {
    const joined = this.history.join(" ").toLowerCase();
    return SUSPICIOUS_PATTERNS.some((re) => re.test(joined));
  },
  resetSession() {
    this.history = [];
  },
};