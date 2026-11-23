import { describe, expect, it } from "vitest";
import { commandTone, envelopeSummary, formatEnvelopeTime, rollbackActionParams, stageActionParams } from "../components/RobotOSPage";

const env = (over: Record<string, unknown> = {}) => ({
  envelopeId: "e1", robotId: "r1", kind: "event", tsMs: 1000, receivedAt: 1100,
  hasSignature: true, payload: { type: "motor_fault" }, ...over,
});

describe("Robot OS admin page helpers", () => {
  it("summarizes kinds and faults", () => {
    const summary = envelopeSummary([
      env(),
      env({ envelopeId: "e2", kind: "telemetry", payload: { cpu: 0.2 }, hasSignature: false }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.byKind.telemetry).toBe(1);
    expect(summary.faults).toBe(1);
    expect(summary.unsigned).toBe(1);
  });

  it("formats only finite timestamps", () => {
    expect(formatEnvelopeTime(0)).toBe("unknown");
    expect(formatEnvelopeTime(1000)).toContain("1970");
  });

  it("builds trimmed action params for admin controls", () => {
    expect(stageActionParams({ robot: " r1 ", version: " 0.2.0 ", artifact: " https://x ", sha256: " abc ", signature: " sig ", signer: " rel " })).toEqual({
      robot: "r1", version: "0.2.0", artifact: "https://x", sha256: "abc", signature: "sig", signer: "rel",
    });
    expect(rollbackActionParams(" r1 ", " bad update ")).toEqual({ robot: "r1", reason: "bad update" });
  });

  it("uses distinct tones for command states", () => {
    expect(commandTone("acked")).toContain("emerald");
    expect(commandTone("failed")).toContain("rose");
    expect(commandTone("pending")).toContain("amber");
    expect(commandTone("unknown")).toContain("slate");
  });
});
