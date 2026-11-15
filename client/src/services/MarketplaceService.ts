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
};

export type MarketplaceState = {
  installedIds: string[];
  activeAgentId: string | null;
  enabledSkillIds: string[];
};

const STORAGE_KEY = "shanaya.marketplace.v1";
const packages = catalog as unknown as MarketplacePackage[];
const packageById = new Map(packages.map((item) => [item.id, item]));
let memoryState: MarketplaceState | null = null;

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
  return state;
}

export const MarketplaceService = {
  list(): MarketplacePackage[] {
    return packages.map((item) => ({ ...item, tags: [...item.tags] }));
  },

  getPackage(id: string): MarketplacePackage | undefined {
    const item = packageById.get(id);
    return item ? { ...item, tags: [...item.tags] } : undefined;
  },

  getState(): MarketplaceState {
    return readState();
  },

  install(id: string): MarketplaceState {
    if (!packageById.has(id)) throw new Error("This package is not in the Shanaya marketplace catalog.");
    const state = readState();
    if (state.installedIds.includes(id)) return state;
    return writeState({ ...state, installedIds: [...state.installedIds, id] });
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

  getRuntimeInstructions(): string {
    return this.getActivePackageIds()
      .map((id) => packageById.get(id))
      .filter((item): item is MarketplacePackage => Boolean(item))
      .map((item) => `${item.type === "agent" ? "Active agent" : "Enabled skill"} — ${item.name}: ${item.instructions}`)
      .join("\n");
  },
};
