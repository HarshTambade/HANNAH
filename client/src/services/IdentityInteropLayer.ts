export type ITUAgenticIdentity = {
  identityId: string;
  intent: string;
  capabilities: string[];
  autonomySpectrum: "assisted" | "supervised" | "autonomous";
  delegationChain: string[];
  governanceBindings: string[];
  issuedAt: number;
  expiresAt: number;
  issuer: string;
};

export type HANNAHProfile = {
  name: string;
  version: string;
  tools: string[];
  specialists: string[];
  memoryQuery: boolean;
  strictness: string;
};

export const IdentityInteropLayer = {
  toITU(profile: HANNAHProfile, issuer = "hannah-local"): ITUAgenticIdentity {
    return {
      identityId: `hannah:${crypto.randomUUID()}`,
      intent: "User-assistant companion with privacy-first governance",
      capabilities: profile.tools,
      autonomySpectrum: "supervised",
      delegationChain: profile.specialists,
      governanceBindings: ["HITL_for_irreversible_actions", "persona_kernel_immutable", "egress_policy_deny_by_default"],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      issuer,
    };
  },
  fromITU(identity: ITUAgenticIdentity): HANNAHProfile {
    return {
      name: "HANNAH",
      version: "1.0.3",
      tools: identity.capabilities,
      specialists: identity.delegationChain,
      memoryQuery: identity.capabilities.includes("memory_query"),
      strictness: identity.autonomySpectrum === "autonomous" ? "strict" : "balanced",
    };
  },
  present() {
    // Returns the ITU identity for presentation to compliant platforms.
    return this.toITU({
      name: "HANNAH",
      version: "1.0.3",
      tools: ["memory_query"],
      specialists: [],
      memoryQuery: true,
      strictness: "balanced",
    });
  },
};