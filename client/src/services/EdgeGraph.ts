/**
 * The client side of two server subsystems:
 *
 *   - edge resources (server/edge): what a robot's onboard Edge Resource
 *     Manager measured, its history and the model advice drawn from it;
 *   - the Device Intelligence Graph (server/graph): entities, versioned
 *     relationships, history and live-checked context.
 *
 * Nothing here computes a reading. A metric the robot couldn't measure comes
 * back as { available: false, reason } and is shown that way.
 */
import { accountRequest } from "./Account";
import type { EdgeMetric } from "./ModelAdvisor";

export type { EdgeMetric };
export type EdgeWarning = { kind: string; severity: "warning" | "critical"; metric: string; value: unknown; threshold: number; message: string; source: string };
export type EdgeAction = { policy: string; targets: string[]; status?: string; detail?: string; applied?: boolean | null; reason?: string; resource?: string; commands?: string[] };
export type Workload = { cls: string; description: string; slice: string; protected: boolean; sheddable: boolean; nice: number; cpu_weight: number; cpu_quota_pct: number | null; services: string[]; shed: boolean };
export type GpuDevice = { name?: string; utilization_pct?: EdgeMetric; memory_used_mb?: EdgeMetric; memory_total_mb?: EdgeMetric; temperature_c?: EdgeMetric; power_w?: EdgeMetric; shared_memory?: boolean };
export type EdgeSnapshotFull = {
  measured_at_ms: number;
  host?: { system?: string; machine?: string };
  cpu?: { utilization_pct?: EdgeMetric; load_1m?: EdgeMetric; cores?: EdgeMetric; temperature_c?: EdgeMetric };
  memory?: { total_mb?: EdgeMetric; available_mb?: EdgeMetric; used_pct?: EdgeMetric; swap_used_pct?: EdgeMetric };
  gpu?: { devices?: GpuDevice[]; status?: EdgeMetric };
  storage?: Array<{ path: string; total_gb?: EdgeMetric; free_gb?: EdgeMetric; used_pct?: EdgeMetric }>;
  network?: { interfaces?: Array<{ name: string; up?: EdgeMetric; speed_mbps?: EdgeMetric }>; link_up?: EdgeMetric };
  battery?: { percent?: EdgeMetric; status?: EdgeMetric; voltage_v?: EdgeMetric; power_w?: EdgeMetric };
  power?: { external_power?: EdgeMetric };
  processes?: { count?: EdgeMetric; services?: Array<{ name: string; ok: boolean; reason: string }> };
  inference?: { latency_ms_p50?: EdgeMetric; latency_ms_p95?: EdgeMetric; samples?: number };
};
export type EdgeReport = {
  id: string; robotId: string; receivedAt: number; measuredAt: number; ageS: number; fresh: boolean; source: string; status: string;
  measuredOn: string; simulatedHost: boolean; enforcement: string; shedActive: boolean;
  snapshot: EdgeSnapshotFull; evaluation: { status: string; warnings: EdgeWarning[]; unmeasured: string[] }; actions: EdgeAction[]; workloads: Workload[];
};
export type EdgeHistoryRow = { id: string; receivedAt: number; measuredAt: number; status: string; warnings: number; cpuPct: number | null; cpuTempC: number | null; memoryPct: number | null; gpuPct: number | null; storagePct: number | null; batteryPct: number | null };
export type ModelDecision = { workload: string; action: string; model?: string | null; resource?: string | null; reason: string };
export type ModelAdvice = {
  available: boolean; reason?: string; fresh?: boolean; measuredOn?: string;
  hardware: { ramGB: number | null; availableRamGB: number | null; gpuKind: string; gpuName: string | null; vramGB: number | null; storageFreeGB: number | null; online: boolean | null; missing: string[] } | null;
  chosen?: { model: string; label: string; tier: string; placement: string; reason: string } | null;
  recommendations: Array<{ id: string; label: string; ollama: string; tier: string; fits: boolean | null; placement: string; totalGB: number; reason: string }>;
  degradation: { level: "normal" | "reduced" | "minimal"; reasons: string[]; decisions: ModelDecision[] } | null;
  notes: string[];
};
export type RobotResources = { robot: { id: string; name: string; kind: string; connection: string }; latest: EdgeReport | null; history: EdgeHistoryRow[]; advice: ModelAdvice; note: string };

export type GraphLive = { verified: boolean; current: boolean | null; state: string; detail: string; checkedAt: number; approved?: boolean };
export type GraphNode = {
  id: string; type: string; typeLabel: string; name: string; ref: string | null; props: Record<string, unknown>; source: string; derived: boolean;
  scope: { team: string | null; workspace: string | null; project: string | null; owner: string }; validFrom: number; validTo: number | null;
  hops?: number; live?: GraphLive; label?: "current" | "not current" | "recorded";
};
export type GraphEdge = { id: string; type: string; typeVersion: number; currentTypeVersion: number | null; from: string; to: string; source: string; derived: boolean; validFrom: number; validTo: number | null; fromName?: string; toName?: string };
export type GraphSchema = { entities: Array<{ id: string; label: string }>; relations: Array<{ id: string; version: number; from: string[]; to: string[]; description: string; changes: Array<{ version: number; note: string }> }> };
export type GraphContext = {
  start: GraphNode; machines: GraphNode[]; places: GraphNode[]; robots: GraphNode[]; workflows: GraphNode[];
  approvedWorkflows: Array<{ id: string; name: string }>; path: GraphEdge[]; summary: string; note: string;
};

const id = (value: string) => encodeURIComponent(value);
const json = (body: unknown) => JSON.stringify(body);

export const EdgeResources = {
  get: (robotId: string, { hours = 6, task = "chat" }: { hours?: number; task?: string } = {}) => accountRequest<RobotResources>(`/api/robots/${id(robotId)}/resources?hours=${hours}&task=${encodeURIComponent(task)}`),
};

export const DeviceGraph = {
  list: (filters: { type?: string; workspace?: string; project?: string; team?: string; asOf?: number } = {}) => {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)]));
    return accountRequest<{ nodes: GraphNode[]; edges: GraphEdge[]; asOf: number | null }>(`/api/graph${query.size ? `?${query}` : ""}`);
  },
  schema: () => accountRequest<GraphSchema>("/api/graph/schema"),
  populate: () => accountRequest<{ nodes: number; edges: number; closedNodes: number; closedEdges: number }>("/api/graph/populate", { method: "POST" }),
  addNode: (body: { type: string; name: string; props?: Record<string, unknown>; team?: string; workspace?: string; project?: string }) => accountRequest<{ node: GraphNode }>("/api/graph/nodes", { method: "POST", body: json(body) }),
  removeNode: (nodeId: string) => accountRequest<{ closed: boolean }>(`/api/graph/nodes/${id(nodeId)}`, { method: "DELETE" }),
  addEdge: (body: { type: string; from: string; to: string }) => accountRequest<{ edge: GraphEdge }>("/api/graph/edges", { method: "POST", body: json(body) }),
  removeEdge: (edgeId: string) => accountRequest<{ closed: boolean }>(`/api/graph/edges/${id(edgeId)}`, { method: "DELETE" }),
  history: (nodeId: string) => accountRequest<{ node: GraphNode; versions: Array<{ version: number; name: string; source: string; validFrom: number; validTo: number | null }>; edges: GraphEdge[] }>(`/api/graph/nodes/${id(nodeId)}/history`),
  context: (nodeId: string) => accountRequest<GraphContext>(`/api/graph/nodes/${id(nodeId)}/context`),
};

/** A metric as text: the value with its unit, or "not measurable" — never a placeholder number. */
export function metricText(metric: EdgeMetric | undefined, digits = 1): string {
  if (!metric) return "not reported";
  if (!metric.available) return "not measurable on this device";
  if (typeof metric.value === "number") return `${Number.isInteger(metric.value) ? metric.value : metric.value.toFixed(digits)}${metric.unit === "%" ? "%" : metric.unit === "C" ? " °C" : ` ${metric.unit}`}`;
  if (typeof metric.value === "boolean") return metric.value ? "yes" : "no";
  return String(metric.value);
}

export function metricNote(metric: EdgeMetric | undefined): string {
  if (!metric) return "The robot's report doesn't include this.";
  return metric.available ? `Source: ${metric.source}` : metric.reason;
}
