/**
 * HANNAH's specialist agents. Each has a focus, its own tool permissions and
 * its own model choice. Every tool call still goes through the Guardian and,
 * for anything that changes data, the user's approval.
 */
export type SpecialistId = "research" | "coding" | "memory" | "tasks";
export type RouteHint = "simple" | "standard" | "complex";

export type Specialist = {
  id: SpecialistId;
  name: string;
  /** What the planner reads when assigning steps. */
  description: string;
  /** Prefixed to each step so the model works within the specialist's focus. */
  instructions: string;
  tools: string[];
  /** Tier requested from Auto routing when the model is "auto". */
  routeHint: RouteHint;
  maxIterations: number;
};

export const SPECIALISTS: Specialist[] = [
  {
    id: "research",
    name: "Research",
    description: "Explains, compares and summarizes using the model's knowledge and the user's app files. It has no web access, so it must say when facts may be out of date.",
    instructions: "Work as HANNAH's research specialist. Answer accurately and concisely, separate facts from estimates, and say plainly when something may be out of date because you can't browse the web.",
    tools: ["list_app_files", "read_app_file", "desktop_folders", "desktop_list_files", "desktop_read_file"],
    routeHint: "complex",
    maxIterations: 6,
  },
  {
    id: "coding",
    name: "Coding",
    description: "Writes, reviews and fixes code and saves files (with approval). In the desktop app it can also work in folders you share and run commands you approve, such as tests.",
    instructions: "Work as HANNAH's coding specialist. Give working, complete code with short explanations. If desktop_* tools are available, read the relevant files first, make focused changes, and run the project's tests with desktop_run_command to check your work; each write and command waits for the user's approval. Without those tools you can't execute code, so point out what the user should test.",
    tools: ["list_app_files", "read_app_file", "write_app_file", "desktop_folders", "desktop_list_files", "desktop_read_file", "desktop_write_file", "desktop_run_command"],
    routeHint: "complex",
    maxIterations: 8,
  },
  {
    id: "memory",
    name: "Memory",
    description: "Looks up what the user asked HANNAH to remember and saves new facts they ask to keep (with approval).",
    instructions: "Work as HANNAH's memory specialist. Search saved memories before answering questions about the user. Save something only when the user clearly asked you to remember it.",
    tools: ["search_memories", "save_memory"],
    routeHint: "simple",
    maxIterations: 4,
  },
  {
    id: "tasks",
    name: "Tasks",
    description: "Handles reminders and device actions: creating, listing and cancelling reminders, opening apps, battery and device status, message and call drafts (with approval).",
    instructions: "Work as HANNAH's task specialist. Use the tools to actually do the step, and report exactly what the tool results confirm.",
    tools: ["create_reminder", "list_reminders", "cancel_reminder", "get_device_status", "get_battery_status", "open_app", "send_message", "make_call"],
    routeHint: "standard",
    maxIterations: 6,
  },
];

const SETTINGS_KEY = "hannah.specialists.v1";
export const SPECIALISTS_EVENT = "hannah:specialists";
export type SpecialistSettings = Partial<Record<SpecialistId, { model?: string; enabled?: boolean }>>;

export function readSpecialistSettings(): SpecialistSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function updateSpecialist(id: SpecialistId, change: { model?: string; enabled?: boolean }) {
  const settings = readSpecialistSettings();
  settings[id] = { ...settings[id], ...change };
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new Event(SPECIALISTS_EVENT));
  } catch {
    // Best effort.
  }
}

/** Enabled specialists with the user's model choice ("auto" unless they picked one). */
export function activeSpecialists() {
  const settings = readSpecialistSettings();
  return SPECIALISTS.filter((agent) => settings[agent.id]?.enabled !== false).map((agent) => ({ ...agent, model: settings[agent.id]?.model || "auto" }));
}
