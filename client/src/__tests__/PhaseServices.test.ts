import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryService } from "../services/MemoryService";
import { SyncService } from "../services/SyncService";
import { OversightMetricsService } from "../services/OversightMetricsService";
import { GuardianAgent } from "../services/GuardianAgent";
import { PolicyEnforcementLayer } from "../services/PolicyEnforcementLayer";
import { KillSwitch } from "../services/KillSwitch";
import { SpecialistMarketplace } from "../services/SpecialistMarketplace";
import { SubscriptionTierService } from "../services/SubscriptionTierService";
import { MemoryExportService } from "../services/MemoryExportService";
import { DreamingConsolidator } from "../services/DreamingConsolidator";
import { IdentityInteropLayer } from "../services/IdentityInteropLayer";

describe("phase services integration", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), clear: () => store.clear() } });
    window.localStorage.clear();
    PolicyEnforcementLayer.resetSession();
    KillSwitch.deactivate();
    GuardianAgent.resetSession();
    SubscriptionTierService.setTier("free");
  });

  it("stores and lists memory records", () => {
    MemoryService.add("session", "hello");
    expect(MemoryService.list("session").length).toBe(1);
  });

  it("enqueues sync operations", () => {
    SyncService.enqueue({ type: "test" });
    expect(SyncService.getStatus().pendingOps).toBe(1);
  });

  it("calculates oversight index", () => {
    const aoi = OversightMetricsService.calculate(1, 0.5);
    expect(aoi).toBe(0.75);
  });

  it("guardian blocks suspicious actions in strict mode", () => {
    GuardianAgent.setStrictness("strict");
    const result = GuardianAgent.evaluate({ tool: "delete_file", args: {} });
    expect(result.allowed).toBe(false);
  });

  it("policy enforces allow-list", () => {
    expect(() => PolicyEnforcementLayer.check("unknown_tool")).toThrow();
  });

  it("kill switch activates and deactivates", () => {
    KillSwitch.activate("test");
    expect(KillSwitch.isActive()).toBe(true);
    KillSwitch.deactivate();
    expect(KillSwitch.isActive()).toBe(false);
  });

  it("marketplace publishes and reviews listing", async () => {
    const listing = await SpecialistMarketplace.publish({
      author: "user",
      name: "Test Specialist",
      description: "A test specialist",
      prompt: "helpful assistant",
      modelTier: "low-cost cloud",
      toolSubset: ["read_file"],
      priceUsd: 0,
    });
    expect(listing.status).toBe("pending");
    const reviewed = SpecialistMarketplace.review(listing.id, true);
    expect(reviewed.status).toBe("published");
    expect(SpecialistMarketplace.list().length).toBe(1);
  });

  it("subscription tier blocks pro features on free", () => {
    expect(SubscriptionTierService.canUse("cloudProviders")).toBe(false);
    expect(SubscriptionTierService.specialistCap()).toBe(0);
    SubscriptionTierService.setTier("pro");
    expect(SubscriptionTierService.canUse("cloudProviders")).toBe(true);
    expect(SubscriptionTierService.specialistCap()).toBe(10);
  });

  it("memory export produces profile", async () => {
    MemoryService.add("persona", "privacy first");
    const profile = await MemoryExportService.export();
    expect(profile.version).toBe("1.0.3");
    expect(profile.persona.length).toBeGreaterThan(0);
  });

  it("dreaming consolidator runs and logs", async () => {
    MemoryService.add("session", "This is a durable strategy for planning trips that should be remembered long term.");
    const log = await DreamingConsolidator.consolidate();
    expect(log.length).toBeGreaterThan(0);
  });

  it("ITU identity interop round-trips", () => {
    const identity = IdentityInteropLayer.present();
    expect(identity.identityId.startsWith("shanaya:")).toBe(true);
    const back = IdentityInteropLayer.fromITU(identity);
    expect(back.memoryQuery).toBe(true);
  });
});