import { beforeEach, describe, expect, it, vi } from "vitest";

const agentTurn = vi.hoisted(() => vi.fn());
vi.mock("../services/AgentRuntime", () => ({ runAgentTurn: agentTurn }));
vi.mock("../services/api", () => ({ getSessionGroqKey: () => "gsk_visitorkey", getAccountHint: () => null, apiFetch: vi.fn(), apiUrl: (path: string) => path }));
import { AutomationService, automationModel, defaultDeps, describeSchedule, nextRunAt, parseSchedule, planSteps, type AutomationDeps } from "../services/AutomationService";
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

describe("agent tasks use the AI chosen in chat", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    agentTurn.mockReset();
  });

  it("uses the chat's provider, model and the visitor's key, with no tools", async () => {
    window.localStorage.setItem("hannah.chat.mode", "cloud");
    window.localStorage.setItem("hannah.cloudProvider", "openrouter");
    window.localStorage.setItem("hannah.cloudModel:openrouter", "some/model");
    agentTurn.mockResolvedValue({ reply: "Three bullets", emotion: "neutral" });
    await expect(defaultDeps.ask("Plan my day")).resolves.toBe("Three bullets");
    const options = agentTurn.mock.calls[0][0];
    expect(options).toMatchObject({ mode: "cloud", providerId: "openrouter", model: "some/model", groqApiKey: "gsk_visitorkey", allowedTools: [] });
    expect(options.messages).toEqual([{ role: "user", content: "Plan my day" }]);
  });

  it("uses Ollama when chat does, and explains that on-device models can't run automations", () => {
    window.localStorage.setItem("hannah.chat.mode", "ollama");
    window.localStorage.setItem("hannah.ollamaModel", "llama3.2");
    expect(automationModel()).toEqual({ mode: "ollama", providerId: "ollama", model: "llama3.2" });
    window.localStorage.setItem("hannah.chat.mode", "webllm");
    expect(() => automationModel()).toThrow(/cloud model or Ollama/);
    window.localStorage.clear?.();
  });

  it("turns a stopped or declined turn into a failed step instead of a result", async () => {
    agentTurn.mockResolvedValue({ reply: "Stopped.", emotion: "neutral", outcome: "stopped" });
    await expect(defaultDeps.ask("Plan my day")).rejects.toThrow(/within 2 minutes/);
    agentTurn.mockResolvedValue({ reply: "I can't help with that.", emotion: "neutral", outcome: "declined" });
    await expect(defaultDeps.ask("Plan my day")).rejects.toThrow(/can't help/);
  });
});

describe("automation storage", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) });
  });

  it("keeps saved automations when many other tasks are created", () => {
    const flow = workflow([node("t", "trigger", "T"), node("o", "output", "Log")], [["t", "o"]], "wf-keep");
    TaskSpineService.createWorkflow(flow);
    for (let i = 0; i < 150; i += 1) TaskSpineService.create(`Memory consolidation ${i}`, "text");
    expect(AutomationService.workflows().map((item) => item.id)).toEqual(["wf-keep"]);
    expect(TaskSpineService.list().filter((task) => task.kind !== "workflow")).toHaveLength(100);
  });

  it("marks a run that was cut off by a reload as failed", async () => {
    const flow = workflow([node("t", "trigger", "T"), node("a", "agent-task", "A"), node("o", "output", "Log", { channel: "log" })], [["t", "a"], ["a", "o"]]);
    const { deps: d } = deps({ ask: () => new Promise<string>(() => undefined) });
    void AutomationService.run(flow, "manual", d);
    await Promise.resolve();
    expect(AutomationService.runs()[0].status).toBe("running");
    AutomationService.recoverInterrupted(at("2026-11-16T09:00:00"));
    const run = AutomationService.runs()[0];
    expect(run.status).toBe("failed");
    expect(run.steps.map((step) => step.status)).toEqual(["done", "failed", "skipped"]);
  });
});

describe("approving an automation from another device", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) });
  });

  it("shares the approval, continues when the phone approves, and reports the run", async () => {
    const flow = workflow([node("t", "trigger", "T"), node("a", "agent-task", "Plan"), node("m", "tool-action", "Save the result to memory", { action: "save-memory" }), node("o", "output", "Log", { channel: "log" })], [["t", "a"], ["a", "m"], ["m", "o"]], "wf-remote");
    TaskSpineService.createWorkflow(flow);
    const answers = new Map<string, "approved" | "denied" | null>();
    const reports: string[] = [];
    const asked: string[] = [];
    const answered: string[] = [];
    const { deps: base, calls } = deps();
    const d: AutomationDeps = {
      ...base,
      remote: {
        report: (run) => { reports.push(run.status); },
        ask: async (id, title) => { asked.push(title); answers.set(id, null); return id; },
        check: async (id) => answers.get(id) ?? null,
        answered: (id, approve) => { answered.push(`${id}:${approve}`); },
      },
    };
    const paused = await AutomationService.run(flow, "manual", d);
    expect(paused.status).toBe("waiting-approval");
    expect(asked).toEqual(["Morning brief: Save the result to memory"]);
    expect(await AutomationService.syncRemoteApprovals(d)).toEqual([]);

    answers.set([...answers.keys()][0], "approved");
    const [finished] = await AutomationService.syncRemoteApprovals(d);
    expect(finished.status).toBe("done");
    expect(calls.memory).toEqual(["answer 1"]);
    // The phone answered, so nothing is sent back; the run's progress was reported.
    expect(answered).toEqual([]);
    expect(reports).toEqual(["running", "waiting-approval", "done"]);
  });
});
