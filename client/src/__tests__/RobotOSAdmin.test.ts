import { describe, expect, it, vi } from "vitest";
import { summarizeEnvelopes, submitRobotOSEnvelope, type RobotOSEnvelope } from "../services/RobotOSAdmin";

const env = (over: Partial<RobotOSEnvelope> = {}): RobotOSEnvelope => ({
  envelope_id: "e1", robot_id: "r1", ts_ms: 100, kind: "heartbeat", payload: {}, signature: "sig", ...over,
});

describe("Robot OS admin helpers", () => {
  it("summarizes envelopes and counts fault events", () => {
    const summary = summarizeEnvelopes([
      env(),
      env({ envelope_id: "e2", kind: "event", ts_ms: 200, payload: { type: "motor_fault" } }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.byKind.heartbeat).toBe(1);
    expect(summary.lastTsMs).toBe(200);
    expect(summary.faultEvents).toBe(1);
  });

  it("submits signed envelopes and refuses unsigned ones", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    expect(await submitRobotOSEnvelope(post, env())).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/robotos/bridge", expect.any(Object));
    expect(await submitRobotOSEnvelope(post, env({ signature: "" }))).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
