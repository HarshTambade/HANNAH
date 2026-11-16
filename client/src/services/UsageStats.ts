import type { InferenceMode } from "../types";

export type TurnRecord = {
  at: number;
  latencyMs: number;
  ok: boolean;
  mode: InferenceMode;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  voice?: boolean;
};

export type UsageSummary = {
  turns: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  lastLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  voiceTurns: number;
  lastProvider?: string;
  lastModel?: string;
  lastMode?: InferenceMode;
  lastAt?: number;
  /** Messages per day for the last seven days, oldest first. */
  daily: Array<{ label: string; date: string; count: number }>;
};

const STORAGE_KEY = "hannah.usage.turns.v1";
const MAX_RECORDS = 1000;
export const USAGE_STATS_EVENT = "hannah:usage-stats";

function read(): TurnRecord[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TurnRecord =>
      Boolean(item) && typeof item.at === "number" && typeof item.latencyMs === "number" && typeof item.ok === "boolean");
  } catch {
    return [];
  }
}

function dayKey(time: number) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Real, on-device metrics for each chat turn. No message content is stored. */
export const UsageStats = {
  record(entry: Omit<TurnRecord, "at">) {
    const records = [...read(), { ...entry, at: Date.now() }].slice(-MAX_RECORDS);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      window.dispatchEvent(new Event(USAGE_STATS_EVENT));
    } catch {
      // Metrics are optional.
    }
  },
  list() {
    return read();
  },
  clear() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new Event(USAGE_STATS_EVENT));
    } catch {
      // Best effort.
    }
  },
  /** Request counts per calendar day, oldest first. */
  dailySeries(days = 30, now = Date.now()) {
    const counts = new Map<string, number>();
    for (const record of read()) counts.set(dayKey(record.at), (counts.get(dayKey(record.at)) ?? 0) + 1);
    return Array.from({ length: days }, (_, index) => {
      const time = now - (days - 1 - index) * 86_400_000;
      const date = dayKey(time);
      return { date, label: new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" }), count: counts.get(date) ?? 0 };
    });
  },
  /** One row per provider + model that has answered on this device. */
  byModel() {
    const groups = new Map<string, TurnRecord[]>();
    for (const record of read()) {
      if (!record.ok || (!record.model && !record.provider)) continue;
      const key = `${record.provider ?? ""}::${record.model ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    return [...groups.values()].map((records) => ({
      provider: records[0].provider ?? "—",
      model: records[0].model ?? "—",
      replies: records.length,
      avgLatencyMs: Math.round(records.reduce((sum, record) => sum + record.latencyMs, 0) / records.length),
      tokens: records.reduce((sum, record) => sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0), 0),
      lastAt: Math.max(...records.map((record) => record.at)),
    })).sort((a, b) => b.replies - a.replies);
  },
  summary(now = Date.now()): UsageSummary {
    const records = read();
    const succeeded = records.filter((record) => record.ok);
    const latencies = succeeded.map((record) => record.latencyMs);
    const last = records[records.length - 1];
    const lastSuccess = succeeded[succeeded.length - 1];
    const counts = new Map<string, number>();
    for (const record of records) counts.set(dayKey(record.at), (counts.get(dayKey(record.at)) ?? 0) + 1);
    const daily = Array.from({ length: 7 }, (_, index) => {
      const time = now - (6 - index) * 86_400_000;
      const date = dayKey(time);
      return { date, label: new Date(time).toLocaleDateString(undefined, { weekday: "short" }), count: counts.get(date) ?? 0 };
    });
    return {
      turns: records.length,
      succeeded: succeeded.length,
      failed: records.length - succeeded.length,
      successRate: records.length ? Math.round((succeeded.length / records.length) * 100) : null,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      lastLatencyMs: lastSuccess?.latencyMs ?? null,
      inputTokens: records.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
      outputTokens: records.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
      voiceTurns: records.filter((record) => record.voice).length,
      lastProvider: lastSuccess?.provider,
      lastModel: lastSuccess?.model,
      lastMode: last?.mode,
      lastAt: last?.at,
      daily,
    };
  },
};
