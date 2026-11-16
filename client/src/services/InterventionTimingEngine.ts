import { CognitiveReadinessEngine } from "./CognitiveReadinessEngine";

export type InterventionProposal = {
  id: string;
  type: "suggestion" | "reminder" | "alert" | "notification";
  content: string;
  benefit: number; // 0..1
  cost: number; // 0..1
  decision: "intervene" | "suppress";
  reason: string;
  at: number;
};

export type InterventionFeedback = "useful" | "dismissed" | "ignored";

const STORAGE_KEY = "hannah.intervention.v1";
const THRESHOLD_KEY = "hannah.intervention.threshold.v1";

function readLog(): InterventionProposal[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLog(log: InterventionProposal[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log.slice(-500)));
  } catch {
    // Best effort.
  }
}

function readThreshold(): number {
  try {
    const val = window.localStorage.getItem(THRESHOLD_KEY);
    return val ? parseFloat(val) : 0.5;
  } catch {
    return 0.5;
  }
}

function writeThreshold(theta: number) {
  try {
    window.localStorage.setItem(THRESHOLD_KEY, String(theta));
  } catch {
    // Best effort.
  }
}

export const InterventionTimingEngine = {
  theta: readThreshold(),

  async evaluate(proposal: Omit<InterventionProposal, "id" | "decision" | "reason" | "at">): Promise<InterventionProposal> {
    const readiness = await CognitiveReadinessEngine.readiness();
    const now = Date.now();

    // Compute benefit based on proposal type
    let benefit = proposal.benefit;
    if (proposal.type === "alert") benefit = Math.min(1, benefit + 0.2);
    if (proposal.type === "reminder") benefit = Math.min(1, benefit + 0.1);

    // Compute cost based on readiness
    let cost = proposal.cost;
    if (readiness === "busy") cost = Math.min(1, cost + 0.3);
    if (readiness === "focused") cost = Math.min(1, cost + 0.15);
    if (readiness === "fatigued") cost = Math.min(1, cost + 0.4);
    // open state: no additional cost

    const decision = benefit - cost > this.theta ? "intervene" : "suppress";
    const reason = decision === "intervene"
      ? `benefit (${benefit.toFixed(2)}) - cost (${cost.toFixed(2)}) = ${(benefit - cost).toFixed(2)} > threshold ${this.theta.toFixed(2)}`
      : `benefit (${benefit.toFixed(2)}) - cost (${cost.toFixed(2)}) = ${(benefit - cost).toFixed(2)} <= threshold ${this.theta.toFixed(2)}`;

    const entry: InterventionProposal = {
      id: crypto.randomUUID(),
      type: proposal.type,
      content: proposal.content,
      benefit,
      cost,
      decision,
      reason,
      at: now,
    };

    const log = readLog();
    log.push(entry);
    writeLog(log);

    return entry;
  },

  recordFeedback(id: string, feedback: InterventionFeedback) {
    const log = readLog();
    const entry = log.find((e) => e.id === id);
    if (!entry) return;

    // Adapt threshold based on feedback
    if (feedback === "dismissed") {
      this.theta = Math.min(1, this.theta + 0.05);
      writeThreshold(this.theta);
    } else if (feedback === "useful") {
      this.theta = Math.max(0, this.theta - 0.02);
      writeThreshold(this.theta);
    }
    // "ignored" - slight increase in cost estimate for next similar intervention
  },

  getLog(): InterventionProposal[] {
    return readLog();
  },

  getMetrics() {
    const log = readLog();
    const total = log.length;
    if (total === 0) return { total, interveneRate: 0, suppressRate: 0, avgBenefit: 0, avgCost: 0, theta: this.theta };

    const intervened = log.filter((e) => e.decision === "intervene").length;
    const avgBenefit = log.reduce((s, e) => s + e.benefit, 0) / total;
    const avgCost = log.reduce((s, e) => s + e.cost, 0) / total;

    return {
      total,
      interveneRate: Math.round((intervened / total) * 100),
      suppressRate: Math.round(((total - intervened) / total) * 100),
      avgBenefit: Math.round(avgBenefit * 100) / 100,
      avgCost: Math.round(avgCost * 100) / 100,
      theta: Math.round(this.theta * 100) / 100,
    };
  },

  getThreshold(): number {
    return this.theta;
  },

  setThreshold(theta: number) {
    this.theta = Math.max(0, Math.min(1, theta));
    writeThreshold(this.theta);
  },
};