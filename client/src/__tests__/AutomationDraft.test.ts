import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({ getSessionGroqKey: () => "", getAccountHint: () => null, apiFetch: vi.fn(), apiUrl: (path: string) => path }));

import { blankDraft, draftFromWorkflow, draftProblem, newStep, TEMPLATES, workflowFromDraft, type Draft } from "../services/AutomationDraft";
import { AutomationService, planSteps, type AutomationDeps } from "../services/AutomationService";
import { TaskSpineService } from "../services/TaskSpineService";
import type { WorkflowSchema } from "../services/WorkflowSchema";

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
  vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) });
});

const deps = (): AutomationDeps & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    ask: async (prompt) => { asked.push(prompt); return "result"; },
    notify: () => undefined,
    speak: async () => undefined,
    saveMemory: () => undefined,
    createReminder: () => undefined,
    now: () => Date.parse("2026-11-17T08:00:00Z"),
  };
};

describe("automation drafts", () => {
  it("saves steps as a chain in order and opens them back the same way", () => {
    const draft: Draft = { ...blankDraft(), name: "Lunch nudge", steps: [{ ...newStep("agent-task"), task: "Suggest a light lunch" } as Draft["steps"][number], newStep("tool-action"), newStep("output")] };
    const workflow = workflowFromDraft(draft);
    expect(planSteps(workflow).map((node) => node.kind)).toEqual(["trigger", "agent-task", "tool-action", "output"]);
    expect(workflow.nodes[1].label).toBe("Suggest a light lunch");
    const reopened = draftFromWorkflow(workflow);
    expect(reopened.unconnected).toBe(0);
    expect(reopened.draft.steps.map((step) => step.kind)).toEqual(["agent-task", "tool-action", "output"]);
    expect(reopened.draft.schedule).toEqual(draft.schedule);
    // Saving again keeps the same step ids, so a run waiting for approval still finds its step.
    expect(workflowFromDraft(reopened.draft).nodes.map((node) => node.id)).toEqual(workflow.nodes.map((node) => node.id));
  });

  it("opens an older canvas automation in run order and drops steps that were never connected", () => {
    const old: WorkflowSchema = {
      version: 1, id: "wf-old", name: "Old", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
      nodes: [
        { id: "o", kind: "output", label: "Speak", config: { channel: "voice" }, position: { x: 50, y: 0 } },
        { id: "t", kind: "trigger", label: "Daily", config: { schedule: "30 7 * * 1-5" }, position: { x: 400, y: 0 } },
        { id: "a", kind: "agent-task", label: "Brief", config: { task: "Brief me" }, position: { x: 200, y: 0 } },
        { id: "stray", kind: "agent-task", label: "Never connected", config: { task: "x" }, position: { x: 900, y: 0 } },
      ],
      edges: [{ id: "1", source: "t", target: "a" }, { id: "2", source: "a", target: "o" }],
    };
    const { draft, unconnected } = draftFromWorkflow(old);
    expect(unconnected).toBe(1);
    expect(draft.steps.map((step) => step.id)).toEqual(["a", "o"]);
    expect(draft.steps[1]).toMatchObject({ kind: "output", channel: "speak" });
    expect(draft.schedule).toEqual({ type: "daily", time: "07:30", days: [1, 2, 3, 4, 5] });
  });

  it("says what's missing before saving", () => {
    const draft = blankDraft();
    expect(draftProblem(draft)).toMatch(/name/);
    draft.name = "Test";
    expect(draftProblem(draft)).toMatch(/Step 1: say what HANNAH should do/);
    draft.steps = [];
    expect(draftProblem(draft)).toMatch(/at least one step/);
    draft.steps = [newStep("tool-action")];
    expect(draftProblem(draft)).toMatch(/before it/);
    draft.steps = [{ ...newStep("agent-task"), task: "Hi" } as Draft["steps"][number]];
    draft.schedule = { type: "daily", time: "08:00", days: [] };
    expect(draftProblem(draft)).toMatch(/at least one day/);
    draft.schedule = { type: "manual" };
    expect(draftProblem(draft)).toBe("");
  });

  it("every template is valid and runs from start to finish", async () => {
    for (const template of TEMPLATES) {
      const draft = template.build();
      expect(draftProblem(draft), template.name).toBe("");
      const workflow = workflowFromDraft(draft);
      // Saved first, as the editor does: approving looks the automation up by id.
      TaskSpineService.createWorkflow(workflow);
      const d = deps();
      let run = await AutomationService.run(workflow, "manual", d);
      if (run.status === "waiting-approval") run = await AutomationService.decide(run.id, true, d);
      expect(run.status, template.name).toBe("done");
      expect(d.asked).toHaveLength(1);
    }
  });
});
