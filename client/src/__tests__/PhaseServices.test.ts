import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryService } from "../services/MemoryService";
import { SyncService } from "../services/SyncService";
import { OversightMetricsService } from "../services/OversightMetricsService";
import { GuardianAgent } from "../services/GuardianAgent";
import { PolicyEnforcementLayer } from "../services/PolicyEnforcementLayer";
import { KillSwitch } from "../services/KillSwitch";

describe("phase services integration", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), clear: () => store.clear() } });
    window.localStorage.clear();
    PolicyEnforcementLayer.resetSession();
    KillSwitch.deactivate();
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
});