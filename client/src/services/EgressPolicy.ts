export type EgressRequest = { url: string; method: string; bodyShape?: string };

const ALLOWED: Array<{ origin: string; methods: string[]; shapes?: string[] }> = [
  { origin: "http://127.0.0.1:8000", methods: ["GET", "POST", "OPTIONS"], shapes: ["agent", "tasks", "side-effects"] },
];

export const EgressPolicy = {
  isAllowed(request: EgressRequest): boolean {
    try {
      const url = new URL(request.url);
      const origin = `${url.protocol}//${url.host}`;
      return ALLOWED.some((entry) => {
        if (entry.origin !== origin) return false;
        if (!entry.methods.includes(request.method.toUpperCase())) return false;
        if (entry.shapes && request.bodyShape && !entry.shapes.includes(request.bodyShape)) return false;
        return true;
      });
    } catch {
      return false;
    }
  },
  assertAllowed(request: EgressRequest) {
    if (!this.isAllowed(request)) throw new Error(`Egress denied by policy: ${request.method} ${request.url}`);
  },
  addEntry(entry: { origin: string; methods: string[]; shapes?: string[] }) {
    ALLOWED.push(entry);
  },
};