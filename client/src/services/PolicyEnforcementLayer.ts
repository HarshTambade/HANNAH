export const PolicyEnforcementLayer = {
  rateLimits: new Map<string, number>(),
  allowList: new Set<string>(["get_device_status", "get_battery_status"]),
  check(tool: string) {
    if (!this.allowList.has(tool)) throw new Error(`Tool ${tool} not allowed by policy.`);
    const count = this.rateLimits.get(tool) || 0;
    if (count > 10) throw new Error(`Rate limit exceeded for ${tool}.`);
    this.rateLimits.set(tool, count + 1);
    return true;
  },
  resetSession() {
    this.rateLimits.clear();
  },
};