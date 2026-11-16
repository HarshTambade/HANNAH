import { describe, expect, it, beforeEach, vi } from "vitest";
import { SideEffectLedger } from "../services/SideEffectLedger";
import { SafetyGuard } from "../services/SafetyGuard";
import { KillSwitch } from "../services/KillSwitch";

describe("HITL approval flow", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      },
      confirm: () => true,
    });
    window.localStorage.clear();
    KillSwitch.deactivate();
  });

  it("records a side effect for destructive actions", () => {
    const entry = SideEffectLedger.record("delete_file", "test.txt");
    expect(entry.status).toBe("pending");
    expect(entry.delaySeconds).toBe(30);
    expect(SideEffectLedger.list().length).toBe(1);
  });

  it("allows undo within the delay window", () => {
    const entry = SideEffectLedger.record("delete_file", "test.txt");
    SideEffectLedger.undo(entry.id);
    const updated = SideEffectLedger.list().find((e) => e.id === entry.id);
    expect(updated?.status).toBe("undone");
  });

  it("marks executed after delay window", () => {
    const entry = SideEffectLedger.record("send_message", "recipient", 1);
    SideEffectLedger.markExecuted(entry.id);
    const updated = SideEffectLedger.list().find((e) => e.id === entry.id);
    expect(updated?.status).toBe("executed");
  });

  it("kill switch halts all activity", () => {
    KillSwitch.activate("test");
    expect(KillSwitch.isActive()).toBe(true);
    KillSwitch.deactivate();
    expect(KillSwitch.isActive()).toBe(false);
  });

  it("safety guard records to ledger on approval", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      },
      confirm: () => true,
    });
    const result = await SafetyGuard.confirm("delete_file", { path: "test.txt" });
    expect(result).toBe(true);
  });
});
