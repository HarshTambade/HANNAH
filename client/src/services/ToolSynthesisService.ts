export const ToolSynthesisService = {
  synthesized: [] as Array<{ name: string; script: string; approved: boolean }>,
  async propose(name: string, script: string) {
    // Requires SafetyGuard review and explicit user approval before adding.
    const entry = { name, script, approved: false };
    this.synthesized.push(entry);
    return entry;
  },
  approve(name: string) {
    const entry = this.synthesized.find((item) => item.name === name);
    if (entry) entry.approved = true;
  },
};