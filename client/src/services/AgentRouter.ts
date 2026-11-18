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
  research: { name: "research", modelTier: "high-capability cloud", allowedTools: ["knowledge_search", "knowledge_documents", "list_app_files", "read_app_file", "web_search", "web_read"], maxIterations: 10, timeoutMs: 90000 },
  maintenance: { name: "maintenance", modelTier: "local", allowedTools: [], maxIterations: 4, timeoutMs: 20000 },
};

export function selectToolsForProfile(profile: AgentProfile, allTools: HANNAHTool[]): HANNAHTool[] {
  if (profile.allowedTools === "all") return allTools;
  const allowed = new Set(profile.allowedTools);
  return allTools.filter((tool) => allowed.has(tool.name));
}

/** The server accepts at most this many tools in one agent request. */
export const MAX_TOOLS_PER_REQUEST = 20;

/**
 * Tool families and the words that call for them. A request gets the
 * families it mentions, so "find a GATE lecture on YouTube" gets the browser
 * and notes tools and "call Aman" gets the phone tools.
 */
const TOOL_FAMILIES: Array<{ match: RegExp; tools: RegExp }> = [
  { match: /youtube|video|lecture|tutorial|browse|browser|website|web ?page|\bweb\b|online|internet|google|look (it |this |that )?up|\bsearch|instagram|reels?|swiggy|zomato|blinkit|amazon|flipkart|food|restaurant|order|https?:\/\/|www\.|\.(com|org|in|io)\b|site\b|news|latest|current|today'?s|this (week|year)|price|stock|score|who (is|won)|release/i, tools: /^(browser_|web_search$|web_read$|youtube_read_video$|desktop_save_notes_pdf$)/ },
  { match: /\bnotes?\b|\bpdf\b|summar/i, tools: /^(desktop_save_notes_pdf|youtube_read_video|browser_search|browser_read)$/ },
  { match: /screen|this error|what('s| is) (happening|this)|looking at|window|display/i, tools: /^desktop_look_at_screen$/ },
  { match: /\b(open|launch|start|close|switch to)\b|\bapps?\b|application|vs ?code|vscode|chrome|terminal|spotify|slack/i, tools: /^(desktop_open_app|desktop_list_apps|open_app|desktop_folders)$/ },
  // Using apps for the user: click, type, press keys, fill in, switch, windows (control.mjs).
  { match: /\b(click|double[- ]?click|right[- ]?click|press|tap|type|fill (in|out)|enter (the|my|a)|select|scroll|drag|drop|switch to|bring up|minimi[sz]e|maximi[sz]e|full ?screen|close (this|the|that)|quit|go to the|in (this|the) (app|window)|on my (screen|computer|mac|pc)|control|for me in|menu|button|tab\b|dialog)\b/i, tools: /^desktop_(control_start|observe|act|switch_app|window|quit_app|control_finish)$/ },
  { match: /startup|start ?up|log ?in|sign ?in|boot|every (morning|day|time)|when(ever)? i (start|turn on|log|open)|(laptop|computer|pc|mac) (starts|boots|turns on)|routine/i, tools: /^desktop_(startup_routine|set_startup_routine|list_apps|folders)$/ },
  { match: /\bcall\b|dial|\bphone\b|\btext\b|\bsms\b|message|contact|whatsapp/i, tools: /^(phone_|make_call$|send_message$)/ },
  { match: /\bfiles?\b|folder|project|\bcode\b|\brun\b|\btest|build|repo|script|read|write|save/i, tools: /^(desktop_(folders|list_files|read_file|write_file|run_command)|list_app_files|read_app_file|write_app_file|delete_app_file)$/ },
  { match: /remind|reminder|alarm|later|tomorrow|tonight|\bat \d/i, tools: /^(create_reminder|list_reminders|cancel_reminder)$/ },
  { match: /remember|memory|memories|forget|my (favou?rite|preference)/i, tools: /^(search_memories|save_memory)$/ },
  { match: /knowledge|document|uploaded|my notes/i, tools: /^knowledge_/ },
  { match: /briefing|weather|agenda|my day/i, tools: /^daily_briefing$/ },
  { match: /workflow|automat/i, tools: /^(create_workflow_draft|list_workflows)$/ },
  { match: /battery|device|setting|wi-?fi|bluetooth|volume|brightness/i, tools: /^(get_device_status|get_battery_status|toggle_setting)$/ },
  { match: /mail|e-?mail|inbox|gmail|outlook|calendar|meeting|event|schedule/i, tools: /^(email_|calendar_)/ },
  { match: /google chat|\bchat\b|\bspaces?\b|team chat|channel/i, tools: /^gchat_/ },
];
// web_search is always kept, so "can you check…" never finds HANNAH without a way to look.
const CORE_TOOLS = ["search_memories", "save_memory", "create_reminder", "web_search"];

/**
 * Keep a request within the server's tool limit by choosing the tools it
 * calls for: the families its words mention, then the profile's own tools,
 * then a few core ones. A request that fits already is left alone.
 */
export function selectToolsForRequest(tools: HANNAHTool[], request: string, { preferred = [] as HANNAHTool[], limit = MAX_TOOLS_PER_REQUEST } = {}): HANNAHTool[] {
  const wanted = new Set<string>();
  for (const family of TOOL_FAMILIES) {
    if (!family.match.test(request)) continue;
    for (const tool of tools) if (family.tools.test(tool.name)) wanted.add(tool.name);
  }
  // A connector named in the request ("in Linear", "my Notion") brings its tools (mcp_c_<connector>_<tool>).
  const words = request.toLowerCase();
  for (const tool of tools) {
    const connector = /^mcp_c_([a-z0-9]+)_/.exec(tool.name)?.[1];
    if (connector && connector.length > 2 && words.includes(connector)) wanted.add(tool.name);
  }
  if (!wanted.size && tools.length <= limit) return tools;
  for (const tool of preferred) wanted.add(tool.name);
  for (const name of CORE_TOOLS) wanted.add(name);
  const chosen = tools.filter((tool) => wanted.has(tool.name));
  return chosen.slice(0, limit);
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