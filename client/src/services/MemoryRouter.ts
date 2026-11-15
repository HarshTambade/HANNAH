import { MemoryService } from "./MemoryService";

export type QueryType = "factual" | "associative" | "complex";

export type RoutingDecision = {
  queryType: QueryType;
  path: "vector" | "graph" | "hybrid";
  confidence: number; // 0..1
  reason: string;
};

export type RetrievalResult = {
  items: Array<{ id: string; content: string; score: number; source: "vector" | "graph" | "hybrid" }>;
  routingDecision: RoutingDecision;
  latencyMs: number;
};

const FACTUAL_KEYWORDS = [
  "what", "when", "where", "who", "how many", "how much", "date", "time",
  "price", "price of", "status of", "definition of",
];
const ASSOCIATIVE_KEYWORDS = [
  "related", "similar", "like", "connected", "associated", "remind me of",
  "pattern", "trend", "history of", "evolution of",
];

export const MemoryRouter = {
  routingLog: [] as { query: string; queryType: QueryType; path: string; latencyMs: number; at: number }[],

  classify(query: string): RoutingDecision {
    const lower = query.toLowerCase();
    let queryType: QueryType;
    let path: "vector" | "graph" | "hybrid";
    let confidence = 0.5;
    let reason = "";

    const factualScore = FACTUAL_KEYWORDS.filter((kw) => lower.includes(kw)).length;
    const associativeScore = ASSOCIATIVE_KEYWORDS.filter((kw) => lower.includes(kw)).length;

    if (factualScore > associativeScore && factualScore > 0) {
      queryType = "factual";
      path = "vector";
      confidence = Math.min(0.9, 0.5 + factualScore * 0.15);
      reason = "factual keywords detected; vector retrieval optimal";
    } else if (associativeScore > factualScore && associativeScore > 0) {
      queryType = "associative";
      path = "graph";
      confidence = Math.min(0.9, 0.5 + associativeScore * 0.15);
      reason = "associative keywords detected; graph traversal optimal";
    } else {
      queryType = "complex";
      path = "hybrid";
      confidence = 0.6;
      reason = "no clear signal; hybrid retrieval for completeness";
    }

    return { queryType, path, confidence, reason };
  },

  async route(query: string): Promise<RetrievalResult> {
    const start = Date.now();
    const decision = this.classify(query);

    // Retrieve from MemoryService (unified store backing both graph and vector)
    const allRecords = MemoryService.list();
    const lower = query.toLowerCase();
    const queryWords = lower.split(/\s+/).filter((w) => w.length > 3);

    const scored = allRecords
      .map((record) => {
        const contentLower = record.content.toLowerCase();
        const matches = queryWords.filter((w) => contentLower.includes(w));
        const score = matches.length / Math.max(1, queryWords.length);
        return { record, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const items = scored.map((s) => ({
      id: s.record.id,
      content: s.record.content,
      score: Math.round(s.score * 100) / 100,
      source: decision.path as "vector" | "graph" | "hybrid",
    }));

    const latencyMs = Date.now() - start;

    const result: RetrievalResult = { items, routingDecision: decision, latencyMs };

    this.routingLog.push({
      query,
      queryType: decision.queryType,
      path: decision.path,
      latencyMs,
      at: Date.now(),
    });
    if (this.routingLog.length > 500) this.routingLog.shift();

    return result;
  },

  getRoutingLog() {
    return [...this.routingLog];
  },

  metrics() {
    const total = this.routingLog.length;
    if (total === 0) return { total, factualPct: 0, associativePct: 0, complexPct: 0, avgLatencyMs: 0 };

    const factual = this.routingLog.filter((r) => r.queryType === "factual").length;
    const associative = this.routingLog.filter((r) => r.queryType === "associative").length;
    const complex = this.routingLog.filter((r) => r.queryType === "complex").length;
    const avgLatency = this.routingLog.reduce((sum, r) => sum + r.latencyMs, 0) / total;

    return {
      total,
      factualPct: Math.round((factual / total) * 100),
      associativePct: Math.round((associative / total) * 100),
      complexPct: Math.round((complex / total) * 100),
      avgLatencyMs: Math.round(avgLatency),
    };
  },
};