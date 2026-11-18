import { describe, expect, it } from "vitest";
import { emptyStops } from "../components/workflows/support";
import type { NodeRun, WorkflowDefinition } from "../services/WorkflowApi";

const run = (nodeId: string, status: string, output: NodeRun["output"]): NodeRun => ({ nodeId, name: nodeId, status, attempts: 1, startedAt: 1, finishedAt: 2, durationMs: 1, input: null, output, error: null });
const definition = (links: Array<[string, string, string?]>): WorkflowDefinition => ({
  format: "hannah-workflow", version: 2, settings: {},
  nodes: [],
  connections: links.map(([source, target, sourceOutput = "main"], index) => ({ id: `c${index}`, source, target, sourceOutput, targetInput: "main" })),
});

describe("why a completed run did less than expected", () => {
  it("names the step that returned nothing and counts the steps it stopped", () => {
    const nodes = [
      run("Schedule", "done", { main: { count: 1, items: [{}] } }),
      run("Today's reminders", "done", { main: { count: 0, items: [] } }),
      run("Collect", "skipped", null),
      run("Summarize", "skipped", null),
      run("Notify", "skipped", null),
    ];
    expect(emptyStops(definition([["Schedule", "Today's reminders"], ["Today's reminders", "Collect"], ["Collect", "Summarize"], ["Summarize", "Notify"]]), nodes))
      .toEqual([{ nodeId: "Today's reminders", name: "Today's reminders", skipped: 3 }]);
  });

  it("doesn't count a branch that wasn't taken", () => {
    const nodes = [
      run("Start", "done", { main: { count: 1, items: [{}] } }),
      run("Big?", "done", { true: { count: 0, items: [] }, false: { count: 1, items: [{}] } }),
      run("Alert", "skipped", null),
    ];
    expect(emptyStops(definition([["Start", "Big?"], ["Big?", "Alert", "true"]]), nodes)).toEqual([]);
  });
});
