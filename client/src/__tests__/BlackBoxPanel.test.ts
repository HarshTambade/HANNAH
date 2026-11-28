import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IncidentReportView, PlaybackBanner, TimelineList } from "../components/robotops/BlackBoxPanel";
import type { IncidentReport, TimelineEvent } from "../services/BlackBox";
import { ROBOT_TOOL_NAMES } from "../services/Robotics";
import { SPECIALISTS } from "../services/SpecialistAgents";

const report: IncidentReport = {
  found: true, question: "Why did my robot stop?", robot: { id: "rb_1", name: "Scout", kind: "simulation" }, label: "Simulation: these records come from a simulated robot.",
  method: "Deterministic rules over stored records.", generatedAt: 1,
  anchor: { id: "msn_ms_1_finished", at: 2, type: "mission-failed", kind: "mission", summary: "Mission ms_1 ended failed.", missionId: "ms_1" },
  confirmed: [{ id: "c1", text: "Mission ms_1 ended failed: The emergency stop was engaged.", evidence: ["msn_ms_1_finished"], at: 2 }, { id: "c2", text: "0.1 s before: The emergency stop was engaged.", evidence: ["bbx_estop"], at: 1 }],
  suspected: [{ id: "s1", cause: "The simulated emergency-stop input was set.", status: "suspected", rule: "an emergency stop was recorded shortly before the stop", evidence: ["bbx_estop", "msn_ms_1_finished"], check: "Check the e-stop." }],
  history: { count: 0, evidence: [], text: "No other stop of this kind is recorded in the 30 days before." },
  recovery: { note: "Steps for a person. HANNAH carries out none of them by itself.", steps: ["Release the emergency stop on the robot itself."] },
  gaps: [], clock: { notes: ["1 robot record in this window carries a robot time that wasn't synchronised with HANNAH."] }, evidenceIds: ["msn_ms_1_finished", "bbx_estop"],
};

describe("Black box panel", () => {
  it("keeps what the records confirm apart from what is only suspected, with the record ids each line rests on", () => {
    const html = renderToStaticMarkup(createElement(IncidentReportView, { report, simulated: true }));
    const confirmed = html.indexOf("Confirmed (from records)");
    const suspected = html.indexOf("Suspected (not verified)");
    expect(confirmed).toBeGreaterThan(-1);
    expect(suspected).toBeGreaterThan(confirmed);
    expect(html.slice(confirmed, suspected)).toContain("[bbx_estop]");
    expect(html.slice(confirmed, suspected)).not.toContain("simulated emergency-stop input");
    expect(html.slice(suspected)).toContain("Suspected: The simulated emergency-stop input was set.");
    expect(html).toContain("Simulation: these records come from a simulated robot.");
    expect(html).toContain("wasn&#x27;t synchronised");
    expect(html).toContain("HANNAH carries out none of them");
  });

  it("says plainly when no stop is recorded and suspects nothing", () => {
    const html = renderToStaticMarkup(createElement(IncidentReportView, { report: { ...report, found: false, reason: "No stop is recorded in the time searched.", confirmed: [], suspected: [] }, simulated: false }));
    expect(html).toContain("No stop is recorded");
    expect(html).not.toContain("Suspected");
  });

  it("a replay always carries the playback label", () => {
    const html = renderToStaticMarkup(createElement(PlaybackBanner, { replay: { label: "PLAYBACK: recorded data, not live.", robot: { id: "rb_1", name: "Scout", kind: "simulation" } } }));
    expect(html).toContain("PLAYBACK: recorded data, not live.");
    expect(html).toContain("Recorded from a simulation.");
  });

  it("each timeline item says where it came from and whether its clock was synchronised", () => {
    const base: TimelineEvent = { id: "e1", robotId: "rb_1", deviceId: null, at: 1_800_000_000_000, receivedAt: 1_800_000_000_000, clock: { synced: false, uncertaintyMs: null, note: "not synchronised" }, source: "safety", type: "estop-engaged", missionId: "ms_1", severity: "error", summary: "The emergency stop was engaged.", details: {}, dataRefs: [], sensitivity: "normal", simulated: true, origin: "robot-blackbox" };
    const html = renderToStaticMarkup(createElement(TimelineList, { events: [base, { ...base, id: "e2", origin: "server", type: "mission-failed", summary: "Mission failed.", clock: { synced: true, uncertaintyMs: 0, note: "server" } }, { ...base, id: "e3", at: base.at + 5000, summary: "Latest record.", clock: { synced: true, uncertaintyMs: 40, note: "synced" }, sensitivity: "sensitive" }] }));
    expect(html).toContain("robot black box");
    expect(html).toContain("clock not synced");
    expect(html).toContain("±40 ms");
    expect(html).toContain("sensitive");
    expect(html.indexOf("Latest record.")).toBeLessThan(html.indexOf("The emergency stop was engaged."));
  });

  it("the incident tools exist and the read-only care agent has them", () => {
    expect(ROBOT_TOOL_NAMES).toEqual(expect.arrayContaining(["robot_why_stopped", "robot_timeline"]));
    const care = SPECIALISTS.find((agent) => agent.id === "robot_care")!;
    expect(care.tools).toEqual(expect.arrayContaining(["robot_why_stopped", "robot_timeline"]));
    expect(care.instructions).toMatch(/suspected, never as the cause/);
  });
});
