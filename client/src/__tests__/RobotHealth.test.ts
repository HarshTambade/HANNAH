import { describe, expect, it } from "vitest";
import { checkStatusText, measuredText, precisionText, recoveryChoice, sortFindings, LABEL_TEXT, type MaintenanceFinding } from "../services/RobotHealth";

const finding = (over: Partial<MaintenanceFinding>): MaintenanceFinding => ({
  id: "f", assetId: "r", assetKind: "robot", component: "motor:left", metric: "temperatureC", label: "measured-anomaly", detector: "ewma", status: "open", priority: "medium", confidence: 0.7, simulated: false, title: "t",
  firstSeenAt: 1, lastSeenAt: 1, occurrences: 1, feedback: null, feedbackNote: null, confirmation: null, failureDate: null, confidenceMeans: "", ...over,
});

describe("maintenance and diagnostics helpers never invent a reading", () => {
  it("a missing value is 'not measured', never zero", () => {
    expect(measuredText(undefined, "°C")).toBe("not measured");
    expect(measuredText(null)).toBe("not measured");
    expect(measuredText(Number.NaN, "V")).toBe("not measured");
    expect(measuredText(41.234, "°C")).toBe("41.23 °C");
    expect(measuredText(0, "A")).toBe("0 A");
  });

  it("precision without verdicts says so instead of 0% or 100%", () => {
    expect(precisionText({ truePositives: 0, falsePositives: 0, unsure: 2, judged: 0, precision: null })).toBe("no verdicts yet");
    expect(precisionText({ truePositives: 3, falsePositives: 1, unsure: 0, judged: 4, precision: 0.75 })).toBe("75% of 4 judged findings were real");
  });

  it("confirmed faults come first, then suspected causes, then measured anomalies", () => {
    const sorted = sortFindings([finding({ id: "a", label: "measured-anomaly", priority: "high" }), finding({ id: "b", label: "confirmed-fault", priority: "low" }), finding({ id: "c", label: "suspected-cause" })]);
    expect(sorted.map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(LABEL_TEXT["suspected-cause"]).toMatch(/not confirmed/);
  });

  it("an unmeasured check never reads as healthy", () => {
    expect(checkStatusText("unknown")).toBe("Not measured");
    expect(checkStatusText("not-configured")).toBe("Not set up");
  });

  it("a prohibited recovery has no button; admin-only needs an administrator; approval asks", () => {
    const incident = (policy: string, status = "needs-person") => ({ status, manual: "Release it at the robot.", suggestions: [{ action: "x", title: "Restart a Robot OS service", policy, params: {}, reversible: true }] });
    expect(recoveryChoice(incident("prohibited"), true)).toEqual({ kind: "manual", label: "Release it at the robot." });
    expect(recoveryChoice(incident("admin"), false).kind).toBe("admin");
    expect(recoveryChoice(incident("admin"), true).kind).toBe("run");
    expect(recoveryChoice(incident("approval"), false)).toEqual({ kind: "ask", label: "Ask to restart a robot os service" });
    expect(recoveryChoice(incident("approval", "waiting-approval"), false).kind).toBe("none");
    expect(recoveryChoice(incident("automatic"), false).kind).toBe("run");
    expect(recoveryChoice({ status: "open", manual: null, suggestions: [] }, false).kind).toBe("none");
  });
});
