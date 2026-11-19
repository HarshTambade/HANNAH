import catalog from "../../../shared/marketplace-catalog.json";

export type MarketplacePackageType = "agent" | "skill";
export type MarketplacePackage = {
  id: string;
  type: MarketplacePackageType;
  name: string;
  description: string;
  category: string;
  version: string;
  publisher: string;
  tags: string[];
  instructions: string;
  /** Messages to try: choosing one puts it in the chat's message box. */
  starters: string[];
  /** Agents only: tools HANNAH always has to hand while this agent is active (they still ask for approval). */
  tools?: string[];
};

export type MarketplaceState = {
  installedIds: string[];
  activeAgentId: string | null;
  enabledSkillIds: string[];
};

const STORAGE_KEY = "hannah.marketplace.v1";
/** A message waiting for the chat's message box (from "Try it" in the marketplace or a prompt on the home page). */
const DRAFT_KEY = "hannah.chat.draft";
export const MARKETPLACE_EVENT = "hannah:marketplace";
/** The server accepts one agent and this many skills in a request. */
export const MAX_ENABLED_SKILLS = 5;
const packages = catalog as unknown as MarketplacePackage[];
const packageById = new Map(packages.map((item) => [item.id, item]));
let memoryState: MarketplaceState | null = null;

const copy = (item: MarketplacePackage): MarketplacePackage => ({ ...item, tags: [...item.tags], starters: [...(item.starters ?? [])], ...(item.tools ? { tools: [...item.tools] } : {}) });

function blankState(): MarketplaceState {
  return { installedIds: [], activeAgentId: null, enabledSkillIds: [] };
}

function readState(): MarketplaceState {
  try {
    const value: unknown = memoryState ?? JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return blankState();
    const record = value as Record<string, unknown>;
    const installedIds = Array.isArray(record.installedIds)
      ? [...new Set(record.installedIds.filter((id): id is string => typeof id === "string" && packageById.has(id)))]
      : [];
    const installed = new Set(installedIds);
    const activeCandidate = typeof record.activeAgentId === "string" ? record.activeAgentId : null;
    const activeAgentId = activeCandidate && installed.has(activeCandidate) && packageById.get(activeCandidate)?.type === "agent"
      ? activeCandidate
      : null;
    const enabledSkillIds = Array.isArray(record.enabledSkillIds)
      ? [...new Set(record.enabledSkillIds.filter((id): id is string => typeof id === "string" && installed.has(id) && packageById.get(id)?.type === "skill"))]
      : [];
    return { installedIds, activeAgentId, enabledSkillIds };
  } catch {
    return memoryState ? { ...memoryState } : blankState();
  }
}

function writeState(state: MarketplaceState) {
  memoryState = state;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The marketplace still works for this app session when storage is unavailable.
  }
  try {
    window.dispatchEvent(new Event(MARKETPLACE_EVENT));
  } catch {
    // No window events in some environments.
  }
  return state;
}

export const MarketplaceService = {
  list(): MarketplacePackage[] {
    return packages.map(copy);
  },

  getPackage(id: string): MarketplacePackage | undefined {
    const item = packageById.get(id);
    return item ? copy(item) : undefined;
  },

  getState(): MarketplaceState {
    return readState();
  },

  install(id: string): MarketplaceState {
    if (!packageById.has(id)) throw new Error("This package is not in the HANNAH marketplace catalog.");
    const state = readState();
    if (state.installedIds.includes(id)) return state;
    return writeState({ ...state, installedIds: [...state.installedIds, id] });
  },

  /**
   * Install a package if needed and turn it on: an agent becomes the active
   * one (replacing another), a skill is enabled. This is what "Add" does, so
   * a package works in the next message without a second step.
   */
  turnOn(id: string): MarketplaceState {
    const item = packageById.get(id);
    if (!item) throw new Error("This package is not in the HANNAH marketplace catalog.");
    this.install(id);
    return item.type === "agent" ? this.activateAgent(id) : this.setSkillEnabled(id, true);
  },

  uninstall(id: string): MarketplaceState {
    const state = readState();
    return writeState({
      installedIds: state.installedIds.filter((installedId) => installedId !== id),
      activeAgentId: state.activeAgentId === id ? null : state.activeAgentId,
      enabledSkillIds: state.enabledSkillIds.filter((skillId) => skillId !== id),
    });
  },

  activateAgent(id: string | null): MarketplaceState {
    const state = readState();
    if (id !== null && (!state.installedIds.includes(id) || packageById.get(id)?.type !== "agent")) {
      throw new Error("Install this agent before activating it.");
    }
    return writeState({ ...state, activeAgentId: id });
  },

  setSkillEnabled(id: string, enabled: boolean): MarketplaceState {
    const state = readState();
    if (!state.installedIds.includes(id) || packageById.get(id)?.type !== "skill") {
      throw new Error("Install this skill before enabling it.");
    }
    const enabledSkillIds = new Set(state.enabledSkillIds);
    if (enabled && !enabledSkillIds.has(id) && enabledSkillIds.size >= MAX_ENABLED_SKILLS) {
      throw new Error(`Up to ${MAX_ENABLED_SKILLS} skills can be on at once. Turn one off first.`);
    }
    if (enabled) enabledSkillIds.add(id);
    else enabledSkillIds.delete(id);
    return writeState({ ...state, enabledSkillIds: [...enabledSkillIds] });
  },

  getActivePackageIds(): string[] {
    const state = readState();
    return [
      ...(state.activeAgentId ? [state.activeAgentId] : []),
      ...state.enabledSkillIds.filter((id) => state.installedIds.includes(id)),
    ];
  },

  /** The agent that's on, if any. */
  getActiveAgent(): MarketplacePackage | undefined {
    const id = readState().activeAgentId;
    return id ? this.getPackage(id) : undefined;
  },

  /** Installed agents, for switching between them in chat. */
  getInstalledAgents(): MarketplacePackage[] {
    const installed = new Set(readState().installedIds);
    return packages.filter((item) => item.type === "agent" && installed.has(item.id)).map(copy);
  },

  getEnabledSkills(): MarketplacePackage[] {
    const state = readState();
    return state.enabledSkillIds.map((id) => packageById.get(id)).filter((item): item is MarketplacePackage => Boolean(item)).map(copy);
  },

  /** Tools the active agent should always have to hand. */
  getAgentTools(): string[] {
    return this.getActiveAgent()?.tools ?? [];
  },

  /** Leave a message for the chat's message box; the chat takes it once when it opens. */
  setChatDraft(text: string) {
    try {
      window.sessionStorage.setItem(DRAFT_KEY, text.slice(0, 4000));
    } catch {
      // Without session storage the chat just opens empty.
    }
  },

  /** The waiting message, left in place (see clearChatDraft). */
  peekChatDraft(): string {
    try {
      return window.sessionStorage.getItem(DRAFT_KEY) || "";
    } catch {
      return "";
    }
  },

  clearChatDraft() {
    try {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing to clear.
    }
  },

  getRuntimeInstructions(): string {
    return this.getActivePackageIds()
      .map((id) => packageById.get(id))
      .filter((item): item is MarketplacePackage => Boolean(item))
      .map((item) => `${item.type === "agent" ? "Active agent" : "Enabled skill"} — ${item.name}: ${item.instructions}`)
      .join("\n");
  },
};
