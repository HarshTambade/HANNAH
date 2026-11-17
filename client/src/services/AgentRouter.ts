import type { HANNAHTool } from "./DeviceTools";

export type AgentProfile = {
  name: string;
  modelTier: "local" | "low-cost cloud" | "high-capability cloud";
  allowedTools: string[] | "all";
  maxIterations: number;
  timeoutMs: number;
};

export type TaskType = "quick_chat" | "code_generation" | "system_operation" | "research" | "maintenance";

/** Default profiles mirroring agent_profiles.yaml. */
export const defaultAgentProfiles: Record<string, AgentProfile> = {
  default: { name: "default", modelTier: "low-cost cloud", allowedTools: "all", maxIterations: 8, timeoutMs: 30000 },
  chat: { name: "chat", modelTier: "low-cost cloud", allowedTools: [], maxIterations: 4, timeoutMs: 20000 },
  code: { name: "code", modelTier: "high-capability cloud", allowedTools: ["list_app_files", "read_app_file", "write_app_file"], maxIterations: 12, timeoutMs: 60000 },
  system: { name: "system", modelTier: "low-cost cloud", allowedTools: ["get_device_status", "get_battery_status", "open_app", "toggle_setting", "list_app_files", "read_app_file", "write_app_file", "delete_app_file", "create_reminder", "list_reminders", "cancel_reminder", "search_memories", "save_memory"], maxIterations: 6, timeoutMs: 30000 },
  research: { name: "research", modelTier: "high-capability cloud", allowedTools: ["knowledge_search", "knowledge_documents", "list_app_files", "read_app_file"], maxIterations: 10, timeoutMs: 90000 },
  maintenance: { name: "maintenance", modelTier: "local", allowedTools: [], maxIterations: 4, timeoutMs: 20000 },
};

export function selectToolsForProfile(profile: AgentProfile, allTools: HANNAHTool[]): HANNAHTool[] {
  if (profile.allowedTools === "all") return allTools;
  const allowed = new Set(profile.allowedTools);
  return allTools.filter((tool) => allowed.has(tool.name));
}

export class FreelanceAgent {
  profile: AgentProfile;
  constructor(profile: AgentProfile) { this.profile = profile; }
  async run(prompt: string) {
    // Fast, low-cost model, no tools.
    return { reply: `FreelanceAgent (${this.profile.modelTier}): ${prompt.slice(0, 120)}`, emotion: "neutral" as const, tools: [] as string[] };
  }
}

export class ResearchAgent {
  profile: AgentProfile;
  constructor(profile: AgentProfile) { this.profile = profile; }
  async spawnWorkers(prompts: string[]): Promise<string[]> {
    // Spawn parallel search/scrape workers (scaffold).
    return Promise.all(prompts.map(async (prompt) => `research-result:${prompt.slice(0, 60)}`));
  }
  async run(prompt: string) {
    const workers = await this.spawnWorkers([prompt]);
    return { reply: `ResearchAgent (${this.profile.modelTier}): ${workers.join(" | ")}`, emotion: "thinking" as const };
  }
}

export class RouterAgent {
  profiles: Record<string, AgentProfile>;
  constructor(profiles: Record<string, AgentProfile> = defaultAgentProfiles) { this.profiles = profiles; }
  classify(prompt: string): TaskType {
    const text = prompt.toLowerCase();
    if (/code|function|bug|refactor|typescript|python/.test(text)) return "code_generation";
    if (/research|search|compare|analyze|latest/.test(text)) return "research";
    if (/system|device|battery|file|open app|remind|reminder|alarm|schedule|remember|memory|memories/.test(text)) return "system_operation";
    if (/maintain|cleanup|optimize|audit/.test(text)) return "maintenance";
    return "quick_chat";
  }
  selectProfile(taskType: TaskType): AgentProfile {
    const map: Record<TaskType, string> = {
      quick_chat: "chat",
      code_generation: "code",
      system_operation: "system",
      research: "research",
      maintenance: "maintenance",
    };
    return this.profiles[map[taskType]] || this.profiles.default;
  }
  delegate(taskType: TaskType, _prompt?: string) {
    const profile = this.selectProfile(taskType);
    if (taskType === "research") return new ResearchAgent(profile);
    if (taskType === "quick_chat") return new FreelanceAgent(profile);
    return null;
  }
}

/** Minimal YAML parser for the flat agent_profiles.yaml structure. */
export function parseAgentProfilesYaml(yaml: string): Record<string, AgentProfile> {
  const profiles: Record<string, AgentProfile> = {};
  let current: string | null = null;
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0 && trimmed.endsWith(":")) {
      current = trimmed.slice(0, -1);
      profiles[current] = { name: current, modelTier: "low-cost cloud", allowedTools: "all", maxIterations: 8, timeoutMs: 30000 };
      continue;
    }
    if (!current) continue;
    const [key, ...rest] = trimmed.split(":");
    const value = rest.join(":").trim();
    if (key === "name") profiles[current].name = value;
    else if (key === "modelTier") profiles[current].modelTier = value as AgentProfile["modelTier"];
    else if (key === "maxIterations") profiles[current].maxIterations = Number(value) || profiles[current].maxIterations;
    else if (key === "timeoutMs") profiles[current].timeoutMs = Number(value) || profiles[current].timeoutMs;
    else if (key === "allowedTools") {
      if (value === "all") profiles[current].allowedTools = "all";
      else {
        const cleaned = value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
        profiles[current].allowedTools = cleaned;
      }
    }
  }
  return Object.keys(profiles).length ? profiles : defaultAgentProfiles;
}

export async function loadAgentProfiles(url = "/agent_profiles.yaml"): Promise<Record<string, AgentProfile>> {
  try {
    const response = await fetch(url);
    if (!response.ok) return defaultAgentProfiles;
    const text = await response.text();
    return parseAgentProfilesYaml(text);
  } catch {
    return defaultAgentProfiles;
  }
}