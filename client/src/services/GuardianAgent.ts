export type Strictness = "permissive" | "balanced" | "strict";

export type GuardianDecision = {
  allowed: boolean;
  reason: string;
  riskVector: Record<string, number>;
};

export type GuardianLogEntry = {
  id: string;
  at: number;
  tool: string;
  allowed: boolean;
  reason: string;
  score: number;
  strictness: Strictness;
};

const SUSPICIOUS_PATTERNS = [
  /delete.*then.*send/i,
  /bypass.*then.*execute/i,
  /ignore.*safety/i,
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /override.*consent/i,
  /exfiltrate/i,
  /disable.*guardian/i,
  /rm\s+-rf/i,
];

const STRICTNESS_KEY = "hannah.guardian.strictness.v1";
const LOG_KEY = "hannah.guardian.log.v1";
const MAX_LOG = 100;
/** How many recent actions are scanned for a multi-step attack. */
const MULTI_TURN_WINDOW = 10;
export const GUARDIAN_EVENT = "hannah:guardian";

function savedStrictness(): Strictness {
  try {
    const value = window.localStorage.getItem(STRICTNESS_KEY);
    return value === "permissive" || value === "strict" ? value : "balanced";
  } catch {
    return "balanced";
  }
}

function readLog(): GuardianLogEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(parsed) ? parsed as GuardianLogEntry[] : [];
  } catch {
    return [];
  }
}

function appendLog(entry: GuardianLogEntry) {
  try {
    window.localStorage.setItem(LOG_KEY, JSON.stringify([...readLog(), entry].slice(-MAX_LOG)));
    window.dispatchEvent(new Event(GUARDIAN_EVENT));
  } catch {
    // The decision still applies when storage is unavailable.
  }
}

function newId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `guardian-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Supervisor that reviews every tool call before it can run or reach a
 * confirmation prompt. Explicit attack patterns are blocked at every
 * strictness level; stricter levels also block multi-step patterns and
 * high-risk calls.
 */
export const GuardianAgent = {
  strictness: savedStrictness(),
  history: [] as string[],
  setStrictness(level: Strictness) {
    this.strictness = level;
    try {
      window.localStorage.setItem(STRICTNESS_KEY, level);
    } catch {
      // The choice still applies for this session.
    }
  },
  evaluate(action: { tool: string; args: unknown; intent?: string }): GuardianDecision {
    const payload = JSON.stringify({ tool: action.tool, args: action.args }).toLowerCase();
    const riskVector: Record<string, number> = {
      intent_uncertainty: action.intent ? 0.2 : 0.8,
      consequence_severity: /delete|shell|write_file|send_message|make_call|payment/.test(payload) ? 0.8 : 0.2,
      action_irreversibility: /delete|shell|write_file/.test(payload) ? 0.9 : 0.1,
      memory_uncertainty: 0.3,
      environmental_risk: 0.2,
    };
    const score = Object.values(riskVector).reduce((a, b) => a + b, 0) / Object.keys(riskVector).length;

    const suspicious = SUSPICIOUS_PATTERNS.some((re) => re.test(payload));
    const multiTurn = this.detectMultiTurn(payload);

    let allowed = true;
    let reason = "No risk pattern found.";

    if (suspicious) {
      allowed = false;
      reason = "The request matches a known attack pattern (for example bypassing safety or exfiltrating data).";
    } else if (this.strictness !== "permissive" && multiTurn) {
      allowed = false;
      reason = "Combined with recent actions, this looks like a multi-step attempt to get around safety rules.";
    } else if (this.strictness === "strict" && score > 0.5) {
      allowed = false;
      reason = `Strict mode blocks high-risk actions (risk ${score.toFixed(2)} > 0.50).`;
    }

    this.history.push(payload);
    if (this.history.length > MULTI_TURN_WINDOW) this.history.shift();
    appendLog({ id: newId(), at: Date.now(), tool: action.tool, allowed, reason, score: Math.round(score * 100) / 100, strictness: this.strictness });

    return { allowed, reason, riskVector: score > 0.7 ? riskVector : {} };
  },
  detectMultiTurn(current = "") {
    const joined = [...this.history.slice(-MULTI_TURN_WINDOW), current].join(" ").toLowerCase();
    return SUSPICIOUS_PATTERNS.some((re) => re.test(joined));
  },
  resetSession() {
    this.history = [];
  },
  log(): GuardianLogEntry[] {
    return readLog();
  },
  clearLog() {
    try {
      window.localStorage.removeItem(LOG_KEY);
      window.dispatchEvent(new Event(GUARDIAN_EVENT));
    } catch {
      // Best effort.
    }
  },
};
