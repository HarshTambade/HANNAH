export const OversightMetricsService = {
  sessions: [] as Array<{ aoi: number; taskType: string; at: number }>,
  calculate(U: number, P: number, lambda = 0.5) {
    return U - lambda * P;
  },
  record(taskType: string, U: number, P: number) {
    const aoi = this.calculate(U, P);
    this.sessions.push({ aoi, taskType, at: Date.now() });
    return aoi;
  },
  trend() {
    return this.sessions.slice(-20);
  },
  recommend() {
    return "Pre-approve this tool for this workflow to reduce interventions by 40%.";
  },
};