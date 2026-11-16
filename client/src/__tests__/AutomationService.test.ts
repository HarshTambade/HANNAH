import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationService, describeSchedule, nextRunAt, parseSchedule, planSteps, type AutomationDeps } from "../services/AutomationService";
import { TaskSpineService } from "../services/TaskSpineService";
import type { WorkflowSchema } from "../services/WorkflowSchema";

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

const at = (iso: string) => new Date(iso).getTime();

function workflow(nodes: WorkflowSchema["nodes"], edges: Array<[string, string]>, id = "wf-1"): WorkflowSchema {
  return { version: 1, id, name: "Morning brief", nodes, edges: edges.map(([source, target], index) => ({ id: `e${index}`, source, target })), createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
}
const node = (id: string, kind: WorkflowSchema["nodes"][number]["kind"], label: string, config: Record<string, unknown> = {}) => ({ id, kind, label, config, position: { x: 0, y: 0 } });

function deps(overrides: Partial<AutomationDeps> = {}) {
  let clock = at("2026-11-16T08:00:00");
  const calls = { ask: [] as string[], notify: [] as string[], memory: [] as string[], reminders: [] as string[] };
  const value: AutomationDeps = {
    ask: async (prompt) => { calls.ask.push(prompt); return `answer ${calls.ask.length}`; },
    notify: (title, body) => { calls.notify.push(`${title}: ${body}`); },
    speak: async () => undefined,
    saveMemory: (text) => { calls.memory.push(text); },
    createReminder: (text) => { calls.reminders.push(text); },
    now: () => clock,
    ...overrides,
  };
  return { deps: value, calls, setNow: (iso: string) => { clock = at(iso); } };
}

describe("automation schedules", () => {
  it("reads structured schedules and older cron strings", () => {
    expect(parseSchedule({ schedule: "0 8 * * *" })).toEqual({ type: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] });
    expect(parseSchedule({ schedule: "30 7 * * 1-5" })).toEqual({ type: "daily", time: "07:30", days: [1, 2, 3, 4, 5] });
    expect(parseSchedule({ schedule: { type: "interval", hours: 500 } })).toEqual({ type: "interval", hours: 168 });
    expect(parseSchedule({ schedule: "every tuesday" })).toEqual({ type: "manual" });
    expect(parseSchedule(undefined)).toEqual({ type: "manual" });
  });

  it("finds the next run in local time, skipping days that aren't selected", () => {
    const weekdays = { type: "daily" as const, time: "08:00", days: [1, 2, 3, 4, 5] };
    // 2026-11-16 is a Monday.
    expect(nextRunAt(weekdays, at("2026-11-16T07:59:00"))).toBe(at("2026-11-16T08:00:00"));
    expect(nextRunAt(weekdays, at("2026-11-16T08:00:00"))).toBe(at("2026-11-17T08:00:00"));
    expect(nextRunAt(weekdays, at("2026-11-20T09:00:00"))).toBe(at("2026-11-23T08:00:00"));
    expect(nextRunAt({ type: "interval", hours: 3 }, 1000)).toBe(1000 + 3 * 3_600_000);
    expect(nextRunAt({ type: "manual" }, 1000)).toBeNull();
    expect(describeSchedule(weekdays)).toBe("Weekdays at 08:00");
  });
});

describe("automation plans", () => {
  it("orders steps along the connections and ignores unconnected nodes", () => {
    const flow = workflow([node("o", "output", "Notify"), node("a", "agent-task", "Summarize"), node("t", "trigger", "Daily"), node("x", "agent-task", "Unused")], [["t", "a"], ["a", "o"]]);
    expect(planSteps(flow).map((item) => item.id)).toEqual(["t", "a", "o"]);
  });

  it("rejects loops and workflows without a trigger", () => {
    expect(() => planSteps(workflow([node("t", "trigger", "T"), node("a", "agent-task", "A"), node("b", "agent-task", "B")], [["t", "a"], ["a", "b"], ["b", "a"]]))).toThrow(/loop/);
    expect(() => planSteps(workflow([node("a", "agent-task", "A")], []))).toThrow(/no trigger/);
  });
});

describe("running automations", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) });
  });

  it("passes each step's result to the next and notifies at the end", async () => {
    const flow = workflow([node("t", "trigger", "Daily", { schedule: "0 8 * * *" }), node("a", "agent-task", "List three priorities"), node("b", "agent-task", "Make it shorter"), node("o", "output", "Notify", { channel: "notify" })], [["t", "a"], ["a", "b"], ["b", "o"]]);
    const { deps: d, calls } = deps();
    const run = await AutomationService.run(flow, "manual", d);
    expect(run.status).toBe("done");
    expect(calls.ask[0]).toBe("List three priorities");
    expect(calls.ask[1]).toContain("Result of the previous step:\nanswer 1");
    expect(calls.notify).toEqual(["Morning brief: answer 2"]);
    expect(AutomationService.runs()[0].steps.map((step) => step.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("pauses before an action until it's approved, then continues", async () => {
    const flow = workflow([node("t", "trigger", "Daily"), node("a", "agent-task", "Summarize"), node("m", "tool-action", "Save to memory", { action: "save-memory" }), node("o", "output", "Log", { channel: "log" })], [["t", "a"], ["a", "m"], ["m", "o"]]);
    TaskSpineService.createWorkflow(flow);
    const { deps: d, calls } = deps();
    const paused = await AutomationService.run(flow, "manual", d);
    expect(paused.status).toBe("waiting-approval");
    expect(calls.memory).toEqual([]);
    expect(calls.notify[0]).toMatch(/needs your approval/);
    const finished = await AutomationService.decide(paused.id, true, d);
    expect(finished.status).toBe("done");
    expect(calls.memory).toEqual(["answer 1"]);
  });

  it("stops without acting when the action is denied", async () => {
    const flow = workflow([node("t", "trigger", "Daily"), node("r", "tool-action", "Remind me", { action: "create-reminder", minutes: 30 }), node("o", "output", "Notify")], [["t", "r"], ["r", "o"]]);
    TaskSpineService.createWorkflow(flow);
    const { deps: d, calls } = deps();
    const paused = await AutomationService.run(flow, "manual", d);
    const denied = await AutomationService.decide(paused.id, false, d);
    expect(denied.status).toBe("denied");
    expect(denied.steps.map((step) => step.status)).toEqual(["done", "denied", "skipped"]);
    expect(calls.reminders).toEqual([]);
    await expect(AutomationService.decide(paused.id, true, d)).rejects.toThrow(/isn't waiting/);
  });

  it("records a failed step with the reason and skips the rest", async () => {
    const flow = workflow([node("t", "trigger", "T"), node("a", "agent-task", "A"), node("o", "output", "Notify")], [["t", "a"], ["a", "o"]]);
    const { deps: d, calls } = deps({ ask: async () => { throw new Error("Add your Groq API key to use HANNAH."); } });
    const run = await AutomationService.run(flow, "manual", d);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/Groq API key/);
    expect(run.steps.map((step) => step.status)).toEqual(["done", "failed", "skipped"]);
    expect(calls.notify).toEqual([]);
  });

  it("runs due schedules once, catches up a missed run once, and moves the next run forward", async () => {
    const flow = workflow([node("t", "trigger", "Daily", { schedule: { type: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] } }), node("o", "output", "Log", { channel: "log" })], [["t", "o"]]);
    TaskSpineService.createWorkflow(flow);
    const { deps: d, setNow } = deps();
    setNow("2026-11-16T07:00:00");
    const state = AutomationService.setEnabled(flow, true, at("2026-11-16T07:00:00"));
    expect(state.nextRunAt).toBe(at("2026-11-16T08:00:00"));
    expect(await AutomationService.runDue(d)).toHaveLength(0);
    // HANNAH was closed for two days: one catch-up run, not three.
    setNow("2026-11-18T12:00:00");
    const runs = await AutomationService.runDue(d);
    expect(runs.map((run) => run.trigger)).toEqual(["catch-up"]);
    expect(AutomationService.state(flow.id).nextRunAt).toBe(at("2026-11-19T08:00:00"));
    expect(await AutomationService.runDue(d)).toHaveLength(0);
  });

  it("won't schedule a manual-only workflow", () => {
    const flow = workflow([node("t", "trigger", "Manual"), node("o", "output", "Log")], [["t", "o"]]);
    expect(AutomationService.setEnabled(flow, true).enabled).toBe(false);
  });
});
