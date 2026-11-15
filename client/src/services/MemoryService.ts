export type MemoryLayer = "session" | "long_term" | "persona";

export type MemoryRecord = {
  id: string;
  layer: MemoryLayer;
  content: string;
  weight: number;
  createdAt: string;
  updatedAt: string;
  decay: boolean;
};

const KEY = "shanaya.memory.v1";

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
  list(layer?: MemoryLayer) {
    const records = read();
    return layer ? records.filter((record) => record.layer === layer) : records;
  },
  add(layer: MemoryLayer, content: string, weight = 1) {
    const now = new Date().toISOString();
    const record: MemoryRecord = { id: crypto.randomUUID(), layer, content, weight, createdAt: now, updatedAt: now, decay: layer !== "persona" };
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
};