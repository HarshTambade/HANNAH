import { afterEach, describe, expect, it, vi } from "vitest";
import { RobotOps, formatValue, lifecycleProgress, nextStage, pickedWaves, toneOf, type LifecycleStep } from "../services/RobotOps";

const step = (id: string, ok: boolean): LifecycleStep => ({ id, title: id, person: false, ok, detail: "" });

describe("robot operations helpers", () => {
  it("counts lifecycle steps and names the next open one, ignoring the optional expand step", () => {
    expect(lifecycleProgress([step("select", true), step("simulate", false), step("expand", false)])).toEqual({ done: 1, total: 3, next: "simulate" });
    expect(lifecycleProgress([step("select", true), step("expand", false)]).next).toBe("Every step holds");
  });

  it("walks the stages in order and stops after the wider stage", () => {
    expect(["simulation", "development", "test", "limited", "wider"].map(nextStage)).toEqual(["development", "test", "limited", "wider", null]);
  });

  it("groups robots into waves and drops anything that isn't a wave", () => {
    expect(pickedWaves({ a: "development", b: "test", c: "wider", d: "wider", e: "", f: "everyone" })).toEqual({ development: ["a"], test: ["b"], wider: ["c", "d"] });
  });

  it("formats values and colours statuses", () => {
    expect([formatValue(null), formatValue(0.123456), formatValue(3), formatValue("x")]).toEqual(["—", "0.1235", "3", "x"]);
    expect(toneOf("regressed")).toBe("text-rose-700");
    expect(toneOf("healthy")).toBe("text-emerald-700");
    expect(toneOf("rolling-back")).toBe("text-amber-700");
  });
});

describe("robot operations requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("approves a stage with an explicit attestation, and sends a firmware confirmation with the typed name and serial", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ deployment: { id: "dep_1" }, operation: { id: "fw_1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    await RobotOps.approve("dep_1", "development");
    await RobotOps.authorizeFirmware("fw_1", "Rover", "AC-0042");
    expect(calls[0].url).toMatch(/\/api\/robotops\/deployments\/dep_1\/approve$/);
    expect(calls[0].body).toEqual({ stage: "development", robotIds: [], attest: true });
    expect(calls[1].body).toEqual({ confirmName: "Rover", confirmSerial: "AC-0042", atRobot: true });
  });
});
