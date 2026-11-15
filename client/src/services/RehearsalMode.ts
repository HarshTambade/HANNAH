export const RehearsalMode = {
  enabled: false,
  scenarios: [] as string[],
  enable(value: boolean) { this.enabled = value; },
  async run(workflow: () => Promise<unknown>) {
    if (!this.enabled) return workflow();
    const result = await workflow();
    return { rehearsed: true, result };
  },
};