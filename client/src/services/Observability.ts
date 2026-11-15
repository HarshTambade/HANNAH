export type MetricName =
  | "routing_on_device_ratio"
  | "memory_consolidation_latency_ms"
  | "memory_consolidation_success"
  | "persona_invariant_retention"
  | "sync_conflict_count";

const KEY = "shanaya.metrics.v1";

export const Observability = {
  record(name: MetricName, value: number) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "{}");
      const current = Array.isArray(parsed[name]) ? parsed[name] : [];
      current.push({ value, at: Date.now() });
      parsed[name] = current.slice(-100);
      window.localStorage.setItem(KEY, JSON.stringify(parsed));
    } catch {
      // Best effort.
    }
  },
  summary(name: MetricName) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || "{}");
      const current = Array.isArray(parsed[name]) ? parsed[name] : [];
      return { count: current.length, last: current[current.length - 1]?.value ?? null };
    } catch {
      return { count: 0, last: null };
    }
  },
};