export type AgentProfile = {
  name: string;
  modelTier: "local" | "low-cost cloud" | "high-capability cloud";
  allowedTools: string[] | "all";
  maxIterations: number;
  timeoutMs: number;
};

export type TaskType = "quick_chat" | "code_generation" | "system_operation" | "research" | "maintenance";

export class FreelanceAgent {
  profile: AgentProfile;
  constructor(profile: AgentProfile) { this.profile = profile; }
  async run(prompt: string) {
    return { reply: `FreelanceAgent (${this.profile.modelTier}): ${prompt.slice(0, 120)}`, emotion: "neutral" as const };
  }
}

export class ResearchAgent {
  profile: AgentProfile;
  constructor(profile: AgentProfile) { this.profile = profile; }
  async run(prompt: string) {
    return { reply: `ResearchAgent (${this.profile.modelTier}): ${prompt.slice(0, 120)}`, emotion: "thinking" as const };
  }
}

export class RouterAgent {
  profiles: Record<string, AgentProfile>;
  constructor(profiles: Record<string, AgentProfile>) { this.profiles = profiles; }
  classify(prompt: string): TaskType {
    const text = prompt.toLowerCase();
    if (/code|function|bug|refactor|typescript|python/.test(text)) return "code_generation";
    if (/research|search|compare|analyze|latest/.test(text)) return "research";
    if (/system|device|battery|file|open app/.test(text)) return "system_operation";
    if (/maintain|cleanup|optimize|audit/.test(text)) return "maintenance";
    return "quick_chat";
  }
  selectProfile(taskType: TaskType): AgentProfile {
    if (taskType === "research") return this.profiles.research || this.profiles.default;
    if (taskType === "code_generation") return this.profiles.code || this.profiles.default;
    if (taskType === "system_operation") return this.profiles.system || this.profiles.default;
    return this.profiles.chat || this.profiles.default;
  }
}