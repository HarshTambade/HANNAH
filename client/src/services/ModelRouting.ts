/**
 * How HANNAH chooses a model when the chat model is "Auto".
 *
 * The routing mode lives on this device (and syncs with an account). The
 * server's router (server/router.js) makes the actual choice and enforces
 * Private mode in code; this module stores the preference, asks the server
 * for a preview before sending, and decides when a turn's estimated cost
 * needs the user's go-ahead.
 */
import { apiFetch, apiHeaders, apiUrl } from "./api";

export type RoutingMode = "quality" | "balanced" | "budget" | "fastest" | "private" | "custom";
export type RoutingTier = "small" | "efficient" | "strong" | "frontier";

export type RoutingPreferences = {
  mode: RoutingMode;
  /** Custom mode only: providers HANNAH may choose from (empty = any you can use). */
  providers: string[];
  /** Custom mode only: the most capable tier allowed (null = no limit). */
  maxTier: RoutingTier | null;
  /** Custom mode only: also require self-hosted models. */
  localOnly: boolean;
  /** Ask before sending when a verified estimate is at or above this (USD). */
  confirmAboveUsd: number;
};

export const ROUTING_MODES: Array<{ id: RoutingMode; label: string; description: string }> = [
  { id: "balanced", label: "Balanced", description: "Fits the model to each message: light for chat, stronger for coding and research." },
  { id: "quality", label: "Best quality", description: "The most capable model you can use, for every message." },
  { id: "budget", label: "Budget", description: "The lowest-cost model that can still handle the message." },
  { id: "fastest", label: "Fastest", description: "The quickest measured model, then models known to be fast." },
  { id: "private", label: "Private", description: "Only models on your own hardware or this HANNAH server. Nothing goes to a cloud AI provider." },
  { id: "custom", label: "Custom", description: "Your own provider list and quality ceiling." },
];

export const ROUTING_TIERS: RoutingTier[] = ["small", "efficient", "strong", "frontier"];

const KEY = "hannah.routing.v1";
export const ROUTING_EVENT = "hannah:routing-changed";

export const DEFAULT_ROUTING: RoutingPreferences = { mode: "balanced", providers: [], maxTier: null, localOnly: false, confirmAboveUsd: 0.05 };

function sanitize(value: unknown): RoutingPreferences {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<RoutingPreferences>;
  const mode = ROUTING_MODES.some((item) => item.id === raw.mode) ? raw.mode! : DEFAULT_ROUTING.mode;
  const providers = Array.isArray(raw.providers) ? raw.providers.filter((id): id is string => typeof id === "string" && /^[a-z0-9_-]{1,40}$/.test(id)).slice(0, 25) : [];
  const maxTier = ROUTING_TIERS.includes(raw.maxTier as RoutingTier) ? raw.maxTier as RoutingTier : null;
  const confirm = Number(raw.confirmAboveUsd);
  return {
    mode,
    providers: [...new Set(providers)],
    maxTier,
    localOnly: raw.localOnly === true,
    confirmAboveUsd: Number.isFinite(confirm) && confirm >= 0 && confirm <= 100 ? confirm : DEFAULT_ROUTING.confirmAboveUsd,
  };
}

export function readRoutingPreferences(): RoutingPreferences {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored ? sanitize(JSON.parse(stored)) : { ...DEFAULT_ROUTING };
  } catch {
    return { ...DEFAULT_ROUTING };
  }
}

export function saveRoutingPreferences(next: Partial<RoutingPreferences>) {
  const merged = sanitize({ ...readRoutingPreferences(), ...next });
  try {
    window.localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Kept for this page only if storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(ROUTING_EVENT, { detail: merged }));
  return merged;
}

/** The `routing` field the server expects. */
export function routingRequest(preferences: RoutingPreferences = readRoutingPreferences()) {
  if (preferences.mode !== "custom") return { mode: preferences.mode };
  return {
    mode: "custom" as const,
    ...(preferences.providers.length ? { providers: preferences.providers } : {}),
    ...(preferences.maxTier ? { maxTier: preferences.maxTier } : {}),
    ...(preferences.localOnly ? { localOnly: true } : {}),
  };
}

export type RouteEstimate = {
  inputTokens: number;
  outputTokens: number;
  assumption: string;
  usd: number | null;
  basis: "verified" | "local" | "unverified";
  note?: string;
  verified?: string;
  source?: string | null;
};

export type RouteChoice = { providerId: string; providerLabel: string; model: string; tier: string; local: boolean; estimate: RouteEstimate };

export type RoutePreview = RouteChoice & {
  mode: string;
  modeLabel: string;
  level: string;
  task: string;
  reason: string;
  alternatives: RouteChoice[];
  limitations: string[];
  privacy: "local-only" | "any";
};

export class RoutePreviewError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Ask the server which model it would use for this conversation. No model is called. */
export async function previewRoute(
  messages: Array<{ role: string; content: string }>,
  { providerId, groqApiKey, signal, preferences = readRoutingPreferences() }: { providerId?: string; groqApiKey?: string; signal?: AbortSignal; preferences?: RoutingPreferences } = {},
): Promise<RoutePreview> {
  const headers = apiHeaders({ Accept: "application/json", "Content-Type": "application/json" });
  if (groqApiKey) headers.set("X-Groq-API-Key", groqApiKey);
  const response = await apiFetch(apiUrl("/api/route/preview"), {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({ messages: messages.slice(-12), routing: routingRequest(preferences), ...(providerId ? { provider: providerId } : {}) }),
  });
  const body = await response.json().catch(() => ({})) as Partial<RoutePreview> & { error?: string; code?: string };
  if (!response.ok) throw new RoutePreviewError(typeof body.error === "string" ? body.error : `Route preview failed (HTTP ${response.status}).`, body.code);
  return body as RoutePreview;
}

/** Whether to ask before sending: only for a verified estimate at or above the user's threshold. */
export function needsCostConfirmation(preview: Pick<RoutePreview, "estimate"> | null, preferences: Pick<RoutingPreferences, "confirmAboveUsd">) {
  const usd = preview?.estimate.usd;
  return preview?.estimate.basis === "verified" && typeof usd === "number" && usd > 0 && usd >= preferences.confirmAboveUsd;
}

/** Short cost text for a choice. Never shows a number without a verified price. */
export function costLabel(estimate: RouteEstimate) {
  if (estimate.basis === "local") return "No provider charge (self-hosted)";
  if (estimate.basis === "verified" && estimate.usd !== null) {
    const amount = estimate.usd < 0.0001 ? "under $0.0001" : `about $${estimate.usd < 0.01 ? estimate.usd.toFixed(4) : estimate.usd.toFixed(2)}`;
    return `${amount} (price checked ${estimate.verified})`;
  }
  return "No verified price";
}
