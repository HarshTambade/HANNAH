export type HANNAHInteropProfile = {
  capabilities: string[];
  permissions: string[];
  estimatedCostUsd: number;
};

export const AgentInteropService = {
  profile(): HANNAHInteropProfile {
    return { capabilities: ["chat", "memory", "tasks"], permissions: ["user_approved"], estimatedCostUsd: 0.01 };
  },
  async expose() {
    // Expose via MCP-compatible schema (scaffold).
    return this.profile();
  },
};