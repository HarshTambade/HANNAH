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
};

const KEY = "hannah.memory.v1";

function read(): MemoryRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
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

export const MemoryService = {
  list(layer?: MemoryLayer, tier?: MemoryTier) {
    const records = read();
    let filtered = records;
    if (layer) filtered = filtered.filter((r) => r.layer === layer);
    if (tier) filtered = filtered.filter((r) => r.tier === tier);
    return filtered;
  },
  add(layer: MemoryLayer, content: string, weight = 1, tier?: MemoryTier) {
    const now = new Date().toISOString();
    const resolvedTier: MemoryTier = tier || (layer === "session" ? "episodic" : layer === "long_term" ? "semantic" : "procedural");
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      layer,
      tier: resolvedTier,
      content,
      weight,
      decay: resolvedTier === "episodic" ? 0.5 : resolvedTier === "semantic" ? 0.2 : 0,
      lastAccessed: now,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    write([record, ...read()]);
    return record;
  },
  update(id: string, content: string) {
    const records = read();
    const index = records.findIndex((record) => record.id === id);
    if (index >= 0) {
      records[index] = { ...records[index], content, updatedAt: new Date().toISOString() };
      write(records);
    }
  },
  remove(id: string) {
    write(read().filter((record) => record.id !== id));
  },
  resetPersona() {
    write(read().filter((record) => record.layer !== "persona"));
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
  // Access a memory (reinforces it, reducing decay)
  access(id: string) {
    const records = read();
    const index = records.findIndex((r) => r.id === id);
    if (index >= 0) {
      records[index].lastAccessed = new Date().toISOString();
      records[index].accessCount += 1;
      records[index].decay = Math.max(0, records[index].decay - 0.01);
      write(records);
    }
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