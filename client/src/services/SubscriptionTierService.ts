export type SubscriptionTier = "free" | "premium" | "pro";

type TierLimits = {
  messagesPerDay: number;
  memory: "session" | "long_term" | "cross_device";
  sync: boolean;
  proactive: boolean;
  specialists: number;
  cloudProviders: boolean;
};

const LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: { messagesPerDay: 25, memory: "session", sync: false, proactive: false, specialists: 0, cloudProviders: false },
  premium: { messagesPerDay: -1, memory: "long_term", sync: false, proactive: true, specialists: 3, cloudProviders: true },
  pro: { messagesPerDay: -1, memory: "cross_device", sync: true, proactive: true, specialists: 10, cloudProviders: true },
};

export const SubscriptionTierService = {
  tier: "free" as SubscriptionTier,
  setTier(tier: SubscriptionTier) {
    this.tier = tier;
  },
  canUse(feature: keyof TierLimits) {
    const limit = LIMITS[this.tier][feature];
    if (feature === "messagesPerDay") {
      const value = limit as number;
      return value === -1 || value > 0;
    }
    if (typeof limit === "boolean") return limit;
    return true;
  },
  specialistCap() {
    return LIMITS[this.tier].specialists;
  },
  getTier() {
    return this.tier;
  },
};