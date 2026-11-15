export type EvidenceSource = {
  id: string;
  title: string;
  url?: string;
  type: "web" | "document" | "dataset" | "api" | "observation";
  confidence: number; // 0..1
  retrievedAt: string;
};

export type EvidenceTrace = {
  id: string;
  claim: string;
  sources: EvidenceSource[];
  confidence: number; // 0..1, overall confidence in the claim
  alternativeInterpretations: string[];
  createdAt: string;
};

export type JudgmentAssessment = {
  traceId: string;
  claim: string;
  evidenceSupported: boolean; // is the conclusion warranted by evidence?
  groundingScore: number; // 0..1, how well evidence supports conclusion
  issues: string[]; // e.g., "unsupported claim", "missing source", "low confidence"
  recommendation: string; // "accept", "qualify", "reject", "request_verification"
};

export const EvidenceGroundingEvaluator = {
  traces: [] as EvidenceTrace[],

  createTrace(claim: string, sources: EvidenceSource[], confidence: number, alternatives: string[] = []): EvidenceTrace {
    const trace: EvidenceTrace = {
      id: crypto.randomUUID(),
      claim,
      sources,
      confidence: Math.max(0, Math.min(1, confidence)),
      alternativeInterpretations: alternatives,
      createdAt: new Date().toISOString(),
    };
    this.traces.push(trace);
    if (this.traces.length > 500) this.traces.shift();
    return trace;
  },

  getTrace(id: string): EvidenceTrace | undefined {
    return this.traces.find((t) => t.id === id);
  },

  assessConclusion(traceId: string, conclusion: string): JudgmentAssessment {
    const trace = this.getTrace(traceId);
    if (!trace) {
      return {
        traceId,
        claim: conclusion,
        evidenceSupported: false,
        groundingScore: 0,
        issues: ["no evidence trace found"],
        recommendation: "reject",
      };
    }

    const issues: string[] = [];
    let groundingScore = trace.confidence;

    // Check source coverage
    if (trace.sources.length === 0) {
      issues.push("no sources cited");
      groundingScore *= 0.2;
    } else {
      const avgSourceConfidence =
        trace.sources.reduce((sum, s) => sum + s.confidence, 0) / trace.sources.length;
      groundingScore = (groundingScore + avgSourceConfidence) / 2;
    }

    // Check for low-confidence sources
    const lowConfSources = trace.sources.filter((s) => s.confidence < 0.5);
    if (lowConfSources.length > 0) {
      issues.push(`${lowConfSources.length} low-confidence source(s)`);
      groundingScore *= 0.8;
    }

    // Check alternative interpretations not addressed
    if (trace.alternativeInterpretations.length > 0) {
      issues.push(`${trace.alternativeInterpretations.length} unaddressed alternative interpretation(s)`);
      groundingScore *= 0.9;
    }

    groundingScore = Math.max(0, Math.min(1, groundingScore));

    const evidenceSupported = groundingScore >= 0.6 && issues.length === 0;

    let recommendation: string;
    if (groundingScore >= 0.8) recommendation = "accept";
    else if (groundingScore >= 0.6) recommendation = "qualify";
    else if (groundingScore >= 0.4) recommendation = "request_verification";
    else recommendation = "reject";

    return {
      traceId,
      claim: conclusion,
      evidenceSupported,
      groundingScore: Math.round(groundingScore * 100) / 100,
      issues,
      recommendation,
    };
  },

  listTraces(): EvidenceTrace[] {
    return [...this.traces];
  },
};