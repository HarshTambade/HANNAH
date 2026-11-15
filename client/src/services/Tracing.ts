export type Span = { name: string; start: number; end?: number; attributes?: Record<string, unknown> };

export const Tracing = {
  spans: [] as Span[],
  start(name: string, attributes?: Record<string, unknown>) {
    const span: Span = { name, start: Date.now(), attributes };
    this.spans.push(span);
    return span;
  },
  end(span: Span) {
    span.end = Date.now();
  },
  exportBatch() {
    const batch = this.spans.splice(0, this.spans.length);
    // Batch exporter: never block execution.
    void fetch("/api/traces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) }).catch(() => undefined);
    return batch;
  },
};