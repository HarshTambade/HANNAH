import type { InferenceMode } from "../types";

/**
 * Local, placeholder subscription architecture.
 *
 * IMPORTANT: this service is intentionally client-side only. It is suitable for
 * preview builds and store screenshots, but it is not an entitlement authority.
 * Before charging money, connect RevenueCat, Stripe, or the platform billing
 * APIs and validate entitlements on the Shanaya API. A user can edit local
 * storage, so never unlock server-side spend from this file alone.
 */

export type SubscriptionTier = "free" | "premium";
export type SubscriptionQuotaReason = "ok" | "daily_limit" | "premium_required";

export type SubscriptionPlan = {
  tier: SubscriptionTier;
  name: string;
  priceLabel: string;
  cadence: string;
  dailyMessageLimit: number | null;
  /** `"all"` means every inference mode, including cloud and desktop agents. */
  allowedModes: InferenceMode[] | "all";
  features: string[];
  cta: string;
};

export type SubscriptionQuota = {
  tier: SubscriptionTier;
  day: string;
  used: number;
  /** `null` means unlimited. */
  limit: number | null;
  /** `null` means unlimited. */
  remaining: number | null;
};

export type SubscriptionDecision = {
  allowed: boolean;
  reason: SubscriptionQuotaReason;
  quota: SubscriptionQuota;
  message?: string;
};

export const FREE_DAILY_MESSAGE_LIMIT = 25;
export const PREMIUM_MONTHLY_PRICE_USD = 9.99;

/** Modes that keep inference on the device or a user-controlled local host. */
export const FREE_INFERENCE_MODES: readonly InferenceMode[] = ["webllm", "native", "ollama"];

export const FREE_PLAN: SubscriptionPlan = {
  tier: "free",
  name: "Free",
  priceLabel: "$0",
  cadence: "forever",
  dailyMessageLimit: FREE_DAILY_MESSAGE_LIMIT,
  allowedModes: [...FREE_INFERENCE_MODES],
  features: [
    `${FREE_DAILY_MESSAGE_LIMIT} messages per day`,
    "On-device and local-model inference",
    "WebLLM, downloaded GGUF, and Ollama",
    "Voice, 3D avatar, and device tools",
    "No account and no server-side chat history",
  ],
  cta: "Included",
};

export const PREMIUM_PLAN: SubscriptionPlan = {
  tier: "premium",
  name: "Premium",
  priceLabel: `$${PREMIUM_MONTHLY_PRICE_USD.toFixed(2)}`,
  cadence: "per month",
  dailyMessageLimit: null,
  allowedModes: "all",
  features: [
    "Unlimited messages",
    "Priority Groq access",
    "All configured cloud providers",
    "Cloud-backed desktop and mobile agents",
    "Early access to new companion features",
  ],
  cta: "Start Premium",
};

export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = [FREE_PLAN, PREMIUM_PLAN];

const STORAGE_KEY = "shanaya.subscription.v1";
const MAX_TRACKED_USAGE = 1_000_000;

type PersistedSubscription = {
  tier: SubscriptionTier;
  day: string;
  used: number;
};

let memoryState: PersistedSubscription | null = null;

export class SubscriptionError extends Error {
  readonly code: Exclude<SubscriptionQuotaReason, "ok">;
  readonly quota: SubscriptionQuota;

  constructor(code: Exclude<SubscriptionQuotaReason, "ok">, message: string, quota: SubscriptionQuota) {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
    this.quota = quota;
  }
}

export function isSubscriptionError(value: unknown): value is SubscriptionError {
  return value instanceof SubscriptionError;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** Local calendar day, so a user's quota resets at their local midnight. */
export function subscriptionDay(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function bypassEnabled(): boolean {
  try {
    return import.meta.env.VITE_SUBSCRIPTION_BYPASS === "true";
  } catch {
    return false;
  }
}

function blankState(now: Date): PersistedSubscription {
  return { tier: "free", day: subscriptionDay(now), used: 0 };
}

function normalizeState(value: unknown, now: Date): PersistedSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) return blankState(now);
  const record = value as Record<string, unknown>;
  const tier: SubscriptionTier = record.tier === "premium" ? "premium" : "free";
  const today = subscriptionDay(now);
  const recordedDay = typeof record.day === "string" ? record.day : "";
  const rawUsed = typeof record.used === "number" && Number.isFinite(record.used) ? Math.floor(record.used) : 0;
  const used = Math.max(0, Math.min(MAX_TRACKED_USAGE, rawUsed));
  if (recordedDay !== today) return { tier, day: today, used: 0 };
  return { tier, day: today, used };
}

function readState(now = new Date()): PersistedSubscription {
  if (bypassEnabled()) return { tier: "premium", day: subscriptionDay(now), used: 0 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const state = memoryState ?? blankState(now);
      return normalizeState(state, now);
    }
    return normalizeState(JSON.parse(raw), now);
  } catch {
    return normalizeState(memoryState, now);
  }
}

function writeState(state: PersistedSubscription): void {
  memoryState = state;
  if (bypassEnabled()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing or a full quota can disable storage. The in-memory
    // fallback still enforces the limit for this session.
  }
}

function quotaFromState(state: PersistedSubscription): SubscriptionQuota {
  if (state.tier === "premium") {
    return { tier: "premium", day: state.day, used: state.used, limit: null, remaining: null };
  }
  return {
    tier: "free",
    day: state.day,
    used: state.used,
    limit: FREE_DAILY_MESSAGE_LIMIT,
    remaining: Math.max(0, FREE_DAILY_MESSAGE_LIMIT - state.used),
  };
}

function modeAllowedOnFree(mode: InferenceMode): boolean {
  return FREE_INFERENCE_MODES.includes(mode);
}

function isCloudMode(mode: InferenceMode): boolean {
  return mode === "cloud" || mode === "mobileclaw" || mode === "desktop";
}

export const SubscriptionService = {
  getPlan(tier: SubscriptionTier): SubscriptionPlan {
    return tier === "premium" ? PREMIUM_PLAN : FREE_PLAN;
  },

  getTier(now = new Date()): SubscriptionTier {
    return readState(now).tier;
  },

  isPremium(now = new Date()): boolean {
    return readState(now).tier === "premium";
  },

  /**
   * Local preview only. Production entitlement changes must come from a
   * verified store receipt or billing webhook, never from a UI toggle.
   */
  setTier(tier: SubscriptionTier, now = new Date()): SubscriptionQuota {
    const state = readState(now);
    const next = { ...state, tier };
    writeState(next);
    return quotaFromState(next);
  },

  getQuota(now = new Date()): SubscriptionQuota {
    return quotaFromState(readState(now));
  },

  /** Check whether a turn may start without changing the counter. */
  canSendMessage(mode: InferenceMode, now = new Date()): SubscriptionDecision {
    const state = readState(now);
    const quota = quotaFromState(state);
    if (state.tier === "premium") {
      return { allowed: true, reason: "ok", quota };
    }
    if (!modeAllowedOnFree(mode)) {
      return {
        allowed: false,
        reason: "premium_required",
        quota,
        message: isCloudMode(mode)
          ? "Cloud AI and cloud-backed agents are part of Premium. Switch to WebLLM, on-device GGUF, or local Ollama, or upgrade to continue with cloud models."
          : "This inference mode is part of Premium. Switch to a local model or upgrade to continue.",
      };
    }
    if (state.used >= FREE_DAILY_MESSAGE_LIMIT) {
      return {
        allowed: false,
        reason: "daily_limit",
        quota,
        message: `You’ve used all ${FREE_DAILY_MESSAGE_LIMIT} free messages for today. Local models reset at midnight, or Premium unlocks unlimited messages now.`,
      };
    }
    return { allowed: true, reason: "ok", quota };
  },

  /** Enforce the quota and throw a typed error the UI can turn into an upgrade prompt. */
  assertCanSend(mode: InferenceMode, now = new Date()): SubscriptionQuota {
    const decision = SubscriptionService.canSendMessage(mode, now);
    if (!decision.allowed) {
      const code = decision.reason === "daily_limit" ? "daily_limit" : "premium_required";
      throw new SubscriptionError(code, decision.message || "Upgrade to Premium to continue.", decision.quota);
    }
    return decision.quota;
  },

  /**
   * Count one successful assistant turn. Failures should not consume a free
   * message, so callers record only after the reply is ready.
   */
  recordMessage(now = new Date()): SubscriptionQuota {
    const state = readState(now);
    if (state.tier === "premium") return quotaFromState(state);
    const next = {
      ...state,
      used: Math.min(MAX_TRACKED_USAGE, state.used + 1),
    };
    writeState(next);
    return quotaFromState(next);
  },

  /** Support/QA helper. It does not change the tier. */
  resetUsage(now = new Date()): SubscriptionQuota {
    const state = readState(now);
    const next = { ...state, day: subscriptionDay(now), used: 0 };
    writeState(next);
    return quotaFromState(next);
  },

  /** Used by tests and by a full local-data reset. */
  resetAll(): void {
    memoryState = null;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable; clearing memory is enough for this session.
    }
  },
};
