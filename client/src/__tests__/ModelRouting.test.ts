import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../services/api", () => ({
  apiUrl: (path: string) => `https://hannah.test${path}`,
  apiHeaders: (init?: HeadersInit) => new Headers(init),
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

const routing = () => import("../services/ModelRouting");
const estimate = (over: Record<string, unknown>) => ({ inputTokens: 100, outputTokens: 700, assumption: "about 700 reply tokens", usd: null, basis: "unverified", ...over });

describe("ModelRouting", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string, readonly init?: unknown) {} });
  });

  it("defaults to Balanced and cleans up stored values", async () => {
    const { readRoutingPreferences, DEFAULT_ROUTING } = await routing();
    expect(readRoutingPreferences()).toEqual(DEFAULT_ROUTING);
    vi.stubGlobal("window", { localStorage: memoryStorage({ "hannah.routing.v1": JSON.stringify({ mode: "turbo", providers: ["groq", "groq", "../x"], maxTier: "huge", confirmAboveUsd: -4 }) }), dispatchEvent: () => true });
    const cleaned = (await routing()).readRoutingPreferences();
    expect(cleaned).toEqual({ mode: "balanced", providers: ["groq"], maxTier: null, localOnly: false, confirmAboveUsd: 0.05 });
  });

  it("saves preferences and builds the server's routing field", async () => {
    const { saveRoutingPreferences, readRoutingPreferences, routingRequest } = await routing();
    saveRoutingPreferences({ mode: "private" });
    expect(routingRequest()).toEqual({ mode: "private" });
    saveRoutingPreferences({ mode: "custom", providers: ["groq", "openai"], maxTier: "strong", localOnly: true });
    expect(readRoutingPreferences().mode).toBe("custom");
    expect(routingRequest()).toEqual({ mode: "custom", providers: ["groq", "openai"], maxTier: "strong", localOnly: true });
    // Custom-only fields are not sent in other modes.
    saveRoutingPreferences({ mode: "budget" });
    expect(routingRequest()).toEqual({ mode: "budget" });
  });

  it("asks before sending only for a verified estimate at or above the threshold", async () => {
    const { needsCostConfirmation } = await routing();
    const threshold = { confirmAboveUsd: 0.05 };
    expect(needsCostConfirmation({ estimate: estimate({ usd: 0.08, basis: "verified" }) as never }, threshold)).toBe(true);
    expect(needsCostConfirmation({ estimate: estimate({ usd: 0.01, basis: "verified" }) as never }, threshold)).toBe(false);
    expect(needsCostConfirmation({ estimate: estimate({ usd: null, basis: "unverified" }) as never }, threshold)).toBe(false);
    expect(needsCostConfirmation({ estimate: estimate({ usd: 0, basis: "local" }) as never }, { confirmAboveUsd: 0 })).toBe(false);
    expect(needsCostConfirmation(null, threshold)).toBe(false);
  });

  it("never shows a number without a verified price", async () => {
    const { costLabel } = await routing();
    expect(costLabel(estimate({}) as never)).toBe("No verified price");
    expect(costLabel(estimate({ usd: 0, basis: "local" }) as never)).toMatch(/self-hosted/);
    expect(costLabel(estimate({ usd: 0.0123, basis: "verified", verified: "2026-11-01" }) as never)).toBe("about $0.01 (price checked 2026-11-01)");
    expect(costLabel(estimate({ usd: 0.00002, basis: "verified", verified: "2026-11-01" }) as never)).toMatch(/^under \$0\.0001/);
  });

  it("previews a route and surfaces the server's reason when there is none", async () => {
    const { previewRoute, RoutePreviewError, saveRoutingPreferences } = await routing();
    saveRoutingPreferences({ mode: "private" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ providerId: "ollama", model: "qwen3:8b", local: true }), { status: 200 }));
    const preview = await previewRoute([{ role: "user", content: "hi" }], { providerId: "groq", groqApiKey: "gsk_test" });
    expect(preview.providerId).toBe("ollama");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hannah.test/api/route/preview");
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: "user", content: "hi" }], routing: { mode: "private" }, provider: "groq" });
    expect(new Headers(init.headers).get("X-Groq-API-Key")).toBe("gsk_test");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Private mode only uses models on your own hardware…", code: "no_private_route" }), { status: 409 }));
    await expect(previewRoute([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "no_private_route" });
    expect(RoutePreviewError).toBeDefined();
  });
});
