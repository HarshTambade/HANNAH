export type CalibrationCase = {
  id: string;
  claim: string;
  expertAnswer: string; // the ground-truth expert-derived answer
  confidence: number; // 0..1, agent's stated confidence
  domain: string; // e.g., "medicine", "law", "finance", "general"
  requiresDataAccess: boolean; // does the case benefit from external data?
};

export type CalibrationResult = {
  caseId: string;
  agentAnswer: string;
  aligned: boolean; // does agent answer match expert answer?
  agentConfidence: number;
  expertConfidenceImplied: number; // confidence implied by alignment
  dataAccessUsed: boolean;
  judgmentImproved: boolean; // did data access improve or degrade judgment?
};

export const JudgmentCalibrationHarness = {
  cases: [] as CalibrationCase[],
  results: [] as CalibrationResult[],

  addCase(caseItem: CalibrationCase) {
    this.cases.push(caseItem);
    if (this.cases.length > 1000) this.cases.shift();
  },

  evaluate(caseId: string, agentAnswer: string, agentConfidence: number, dataAccessUsed = false): CalibrationResult {
    const caseItem = this.cases.find((c) => c.id === caseId);
    if (!caseItem) {
      throw new Error(`Calibration case ${caseId} not found.`);
    }

    // Simple alignment check: keyword overlap + semantic approximation
    const aligned = this.isAligned(agentAnswer, caseItem.expertAnswer);

    // Determine if data access helped
    const judgmentImproved = dataAccessUsed
      ? aligned // data access helped if it led to alignment
      : !aligned; // without data access, misalignment suggests data would have helped

    const result: CalibrationResult = {
      caseId,
      agentAnswer,
      aligned,
      agentConfidence: Math.max(0, Math.min(1, agentConfidence)),
      expertConfidenceImplied: aligned ? 0.8 : 0.2,
      dataAccessUsed,
      judgmentImproved,
    };

    this.results.push(result);
    if (this.results.length > 1000) this.results.shift();
    return result;
  },

  isAligned(agentAnswer: string, expertAnswer: string): boolean {
    const a = agentAnswer.toLowerCase();
    const e = expertAnswer.toLowerCase();
    const expertWords = e.split(/\s+/).filter((w) => w.length > 3);
    const matches = expertWords.filter((w) => a.includes(w));
    return matches.length >= Math.max(1, Math.floor(expertWords.length * 0.5));
  },

  calibrationMetrics() {
    const total = this.results.length;
    if (total === 0) return { total, alignmentRate: 0, avgConfidence: 0, dataAccessImprovement: 0 };

    const aligned = this.results.filter((r) => r.aligned).length;
    const avgConfidence =
      this.results.reduce((sum, r) => sum + r.agentConfidence, 0) / total;

    const withData = this.results.filter((r) => r.dataAccessUsed);
    const withoutData = this.results.filter((r) => !r.dataAccessUsed);
    const withDataAligned =
      withData.length > 0 ? withData.filter((r) => r.aligned).length / withData.length : 0;
    const withoutDataAligned =
      withoutData.length > 0 ? withoutData.filter((r) => r.aligned).length / withoutData.length : 0;

    return {
      total,
      alignmentRate: aligned / total,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      dataAccessImprovement: Math.round((withDataAligned - withoutDataAligned) * 100) / 100,
    };
  },
};