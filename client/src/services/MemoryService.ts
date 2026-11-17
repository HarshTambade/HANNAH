import { categoryOf, DUPLICATE_THRESHOLD, MEMORY_CATEGORIES, rankMemories, secretIn, sensitivityOf, similarity, type MemoryCategory, type MemorySource, type Ranked, type Sensitivity } from "./MemoryModel";

export type MemoryLayer = "session" | "long_term" | "persona";
export type MemoryTier = "episodic" | "semantic" | "procedural";

export type MemoryRecord = {
  id: string;
  layer: MemoryLayer;
  tier: MemoryTier;
  content: string;
  weight: number;
  decay: number; // 0..1, higher = more decay
  lastAccessed: string;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  /** Older records don't have these; they're filled in when read. */
  category: MemoryCategory;
  source: MemorySource;
  sensitivity: Sensitivity;
};

export type MemorySettings = { enabled: boolean; categories: Record<MemoryCategory, boolean> };
export type RememberResult = { ok: true; record: MemoryRecord; merged: boolean } | { ok: false; reason: string };

const KEY = "hannah.memory.v1";
const SETTINGS_KEY = "hannah.memory.settings.v1";
export const MEMORY_SETTINGS_EVENT = "hannah:memory-settings";
const MAX_CHARS = 300;
const SOURCE_KINDS = new Set(["you", "chat", "assistant", "automation", "insight", "import", "legacy"]);
const SECRET_REFUSAL = (secret: string) => `That looks like ${secret}. HANNAH never stores passwords, keys, tokens, card or ID numbers as memories.`;

/** Fill in fields older records don't have, without trusting stored values blindly. */
function normalize(raw: Partial<MemoryRecord> & { content?: unknown }): MemoryRecord | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.content !== "string") return null;
  const content = raw.content;
  const layer: MemoryLayer = raw.layer === "session" || raw.layer === "persona" ? raw.layer : "long_term";
  const now = new Date().toISOString();
  return {
    id: raw.id,
    layer,
    tier: raw.tier === "episodic" || raw.tier === "procedural" || raw.tier === "semantic" ? raw.tier : layer === "session" ? "episodic" : "semantic",
    content,
    weight: Number.isFinite(raw.weight) ? Number(raw.weight) : 1,
    decay: Number.isFinite(raw.decay) ? Number(raw.decay) : 0,
    lastAccessed: typeof raw.lastAccessed === "string" ? raw.lastAccessed : raw.createdAt ?? now,
    accessCount: Number.isFinite(raw.accessCount) ? Number(raw.accessCount) : 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : raw.createdAt ?? now,
    category: MEMORY_CATEGORIES.includes(raw.category as MemoryCategory) ? raw.category as MemoryCategory : categoryOf(content),
    source: raw.source && typeof raw.source === "object" && SOURCE_KINDS.has(String(raw.source.kind))
      ? { kind: raw.source.kind, ...(typeof raw.source.detail === "string" ? { detail: raw.source.detail.slice(0, 120) } : {}) }
      : { kind: layer === "persona" ? "you" : "legacy" },
    sensitivity: raw.sensitivity === "sensitive" || raw.sensitivity === "normal" ? raw.sensitivity : sensitivityOf(content),
  };
}

function read(): MemoryRecord[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalize).filter((record): record is MemoryRecord => Boolean(record)) : [];
  } catch {
    return [];
  }
}

function write(records: MemoryRecord[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(records.slice(0, 500)));
  } catch {
    // Best effort.
  }
}

const allCategories = (on: boolean) => Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, on])) as Record<MemoryCategory, boolean>;

function readSettings(): MemorySettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null") as Partial<MemorySettings> | null;
    const categories = allCategories(true);
    if (parsed?.categories && typeof parsed.categories === "object") {
      for (const category of MEMORY_CATEGORIES) if (parsed.categories[category] === false) categories[category] = false;
    }
    return { enabled: parsed?.enabled !== false, categories };
  } catch {
    return { enabled: true, categories: allCategories(true) };
  }
}

const clean = (content: string) => content.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);

export const MemoryService = {
  list(layer?: MemoryLayer, tier?: MemoryTier) {
    const records = read();
    let filtered = records;
    if (layer) filtered = filtered.filter((r) => r.layer === layer);
    if (tier) filtered = filtered.filter((r) => r.tier === tier);
    return filtered;
  },

  settings: readSettings,
  saveSettings(next: Partial<MemorySettings>) {
    const current = readSettings();
    const settings: MemorySettings = { enabled: next.enabled ?? current.enabled, categories: { ...current.categories, ...(next.categories ?? {}) } };
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      window.dispatchEvent(new Event(MEMORY_SETTINGS_EVENT));
    } catch {
      // Best effort.
    }
    return settings;
  },

  /**
   * Save something to remember. Refuses secrets, and refuses everything while
   * memory is off. A memory that says nearly the same as an existing one
   * replaces it (the newer wording wins) instead of adding a duplicate.
   */
  remember(content: string, options: { source: MemorySource; layer?: MemoryLayer; category?: MemoryCategory; sensitivity?: Sensitivity; weight?: number }): RememberResult {
    if (!readSettings().enabled) return { ok: false, reason: "Memory is turned off, so HANNAH didn't save this. Turn it on under What HANNAH remembers." };
    const text = clean(content);
    if (!text) return { ok: false, reason: "There's nothing to save." };
    const secret = secretIn(text);
    if (secret) return { ok: false, reason: SECRET_REFUSAL(secret) };
    const layer = options.layer ?? "long_term";
    const records = read();
    const now = new Date().toISOString();
    if (layer !== "session") {
      const index = records.findIndex((record) => record.layer !== "session" && similarity(record.content, text) >= DUPLICATE_THRESHOLD);
      if (index >= 0) {
        const existing = records[index];
        const merged: MemoryRecord = {
          ...existing,
          content: text,
          weight: Math.min(5, Math.max(existing.weight, options.weight ?? 1) + 0.5),
          decay: 0,
          updatedAt: now,
          category: options.category ?? existing.category,
          sensitivity: options.sensitivity ?? (existing.sensitivity === "sensitive" ? "sensitive" : sensitivityOf(text)),
        };
        records.splice(index, 1);
        write([merged, ...records]);
        return { ok: true, record: merged, merged: true };
      }
    }
    const tier: MemoryTier = layer === "session" ? "episodic" : layer === "long_term" ? "semantic" : "procedural";
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      layer,
      tier,
      content: text,
      weight: options.weight ?? 1,
      decay: tier === "episodic" ? 0.5 : tier === "semantic" ? 0.2 : 0,
      lastAccessed: now,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      category: options.category ?? categoryOf(text),
      source: options.source,
      sensitivity: options.sensitivity ?? sensitivityOf(text),
    };
    write([record, ...records]);
    return { ok: true, record, merged: false };
  },

  /** Older entry point, used by background modules: an insight HANNAH derived. Null when refused. */
  add(layer: MemoryLayer, content: string, weight = 1, _tier?: MemoryTier): MemoryRecord | null {
    const result = this.remember(content, { source: { kind: layer === "persona" ? "you" : "insight" }, layer, weight });
    return result.ok ? result.record : null;
  },

  /** Change a memory's text, category or sensitivity. Returns why it was refused, or "". */
  edit(id: string, patch: { content?: string; category?: MemoryCategory; sensitivity?: Sensitivity }) {
    const records = read();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return "That memory no longer exists.";
    const next = { ...records[index] };
    if (patch.content !== undefined) {
      const text = clean(patch.content);
      if (!text) return "A memory can't be empty. Delete it instead.";
      const secret = secretIn(text);
      if (secret) return SECRET_REFUSAL(secret);
      next.content = text;
      if (patch.sensitivity === undefined && next.sensitivity === "normal") next.sensitivity = sensitivityOf(text);
    }
    if (patch.category) next.category = patch.category;
    if (patch.sensitivity) next.sensitivity = patch.sensitivity;
    next.updatedAt = new Date().toISOString();
    records[index] = next;
    write(records);
    return "";
  },
  update(id: string, content: string) {
    this.edit(id, { content });
  },
  remove(id: string) {
    write(read().filter((record) => record.id !== id));
  },
  resetPersona() {
    write(read().filter((record) => record.layer !== "persona"));
  },

  /**
   * The memories to send with a message: the ones that match it, plus a few
   * preferences. Nothing while memory is off. Sensitive memories only when the
   * model is on-device or self-hosted (`allowSensitive`).
   */
  forMessage(query: string, options: { allowSensitive?: boolean; limit?: number } = {}): { picked: Ranked<MemoryRecord>[]; hiddenSensitive: number } {
    const settings = readSettings();
    if (!settings.enabled) return { picked: [], hiddenSensitive: 0 };
    return rankMemories(read(), query, { limit: options.limit ?? 8, allowSensitive: options.allowSensitive, categories: settings.categories });
  },

  /** For the search_memories tool: ranked matches, or the newest when there's no query. Never sensitive ones. */
  search(query: string, limit = 20) {
    const settings = readSettings();
    if (!settings.enabled) return { memories: [] as MemoryRecord[], hiddenSensitive: 0, off: true };
    const usable = read().filter((record) => record.layer !== "session" && settings.categories[record.category] !== false);
    const hiddenSensitive = usable.filter((record) => record.sensitivity === "sensitive").length;
    const open = usable.filter((record) => record.sensitivity !== "sensitive");
    if (!query.trim()) return { memories: open.slice(0, limit), hiddenSensitive, off: false };
    const { picked } = rankMemories(open, query, { limit, preferences: 0, categories: settings.categories });
    return { memories: picked.map((item) => item.memory), hiddenSensitive, off: false };
  },

  consolidated() {
    return read().filter((record) => record.layer === "long_term");
  },
  persona() {
    return read().filter((record) => record.layer === "persona");
  },
  // Tier-specific access
  episodic() {
    return read().filter((record) => record.tier === "episodic");
  },
  semantic() {
    return read().filter((record) => record.tier === "semantic");
  },
  procedural() {
    return read().filter((record) => record.tier === "procedural");
  },
  // Temporal decay: apply decay to unused memories
  applyDecay() {
    const now = Date.now();
    const records = read();
    const updated = records.map((record) => {
      const lastAccess = new Date(record.lastAccessed).getTime();
      const daysSinceAccess = (now - lastAccess) / (1000 * 60 * 60 * 24);
      // Episodic decays faster, semantic decays slower, procedural doesn't decay
      const decayRate = record.tier === "episodic" ? 0.05 : record.tier === "semantic" ? 0.01 : 0;
      const newDecay = Math.min(1, record.decay + decayRate * daysSinceAccess);
      // Reinforce: if accessed recently, reduce decay
      const reinforced = record.accessCount > 0 ? Math.max(0, newDecay - 0.02 * Math.min(record.accessCount, 5)) : newDecay;
      return { ...record, decay: reinforced };
    });
    write(updated);
  },
  /** Mark memories as used in a reply (reinforces them, and the panel shows when). */
  access(...ids: string[]) {
    const wanted = new Set(ids);
    const records = read();
    const now = new Date().toISOString();
    let changed = false;
    for (const record of records) {
      if (!wanted.has(record.id)) continue;
      record.lastAccessed = now;
      record.accessCount += 1;
      record.decay = Math.max(0, record.decay - 0.01);
      changed = true;
    }
    if (changed) write(records);
  },
  // Get memories sorted by relevance (weight * (1 - decay))
  getRelevant(tier?: MemoryTier, limit = 10) {
    const records = tier ? this.list(undefined, tier) : read();
    return records
      .map((r) => ({ ...r, relevance: r.weight * (1 - r.decay) }))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);
  },
};
