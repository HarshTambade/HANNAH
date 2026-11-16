import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ phase: string; body: Record<string, unknown> }> = [];
let planSteps: unknown[] = [];
let verifyQueue: unknown[] = [];
const agentCalls: Array<{ label?: string; tools?: string[]; content: string; startedAt: number }> = [];
let agentImpl: (content: string) => Promise<{ reply: string; emotion: "neutral"; outcome?: string }> = async (content) => ({ reply: `done: ${content.match(/Your step: (.*)/)?.[1]}`, emotion: "neutral" });

vi.mock("../services/api", () => ({
  getAccountHint: () => null,
  setAccountHint: () => undefined,
  usesBearerSession: () => false,
  apiUrl: (path: string) => path,
  apiFetch: async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ phase: body.phase, body });
    const payload = body.phase === "plan" ? { summary: "plan", steps: planSteps, fallback: false } : verifyQueue.shift();
    return new Response(JSON.stringify(payload), { status: 200 });
  },
}));

vi.mock("../services/LLMRouter", () => ({ DAILY_BUDGET_KEY: "hannah.budget.dailyUsd" }));

vi.mock("../services/AgentRuntime", () => ({
  runAgentTurn: async (options: { agentLabel?: string; allowedTools?: string[]; messages: Array<{ content: string }> }) => {
    agentCalls.push({ label: options.agentLabel, tools: options.allowedTools, content: options.messages[0].content, startedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 15));
    return agentImpl(options.messages[0].content);
  },
}));

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

const { runTeamTask, resumeTeamRun, TeamRuns } = await import("../services/Orchestrator");

const base = { mode: "cloud" as const, providerId: "groq", generateLocal: async () => "" };
const pass = (reply = "Final answer") => ({ verdict: "pass", issues: [], revise: [], reply, emotion: "happy" });

describe("Orchestrator", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    calls.length = 0;
    agentCalls.length = 0;
    verifyQueue = [];
    agentImpl = async (content) => ({ reply: `done: ${content.match(/Your step: (.*)/)?.[1]}`, emotion: "neutral" });
  });

  it("runs independent steps in parallel, then dependents with their inputs, then verifies", async () => {
    planSteps = [
      { id: "s1", agent: "research", task: "Weather in Pune", dependsOn: [] },
      { id: "s2", agent: "research", task: "Train times", dependsOn: [] },
      { id: "s3", agent: "tasks", task: "Remind me to pack", dependsOn: ["s1", "s2"] },
    ];
    verifyQueue = [pass("Trip planned")];
    const reply = await runTeamTask({ ...base, messages: [{ role: "user", content: "Plan my Pune trip" }] });
    expect(reply.reply).toBe("Trip planned");
    expect(agentCalls).toHaveLength(3);
    // s1 and s2 start together; s3 starts after both.
    expect(Math.abs(agentCalls[0].startedAt - agentCalls[1].startedAt)).toBeLessThan(10);
    expect(agentCalls[2].startedAt).toBeGreaterThanOrEqual(agentCalls[0].startedAt + 10);
    expect(agentCalls[2].content).toContain("done: Weather in Pune");
    expect(agentCalls[2].tools).toContain("create_reminder");
    expect(agentCalls[0].tools).toEqual(["list_app_files", "read_app_file"]);
    expect(calls.map((call) => call.phase)).toEqual(["plan", "verify"]);
    const [run] = TeamRuns.list();
    expect(run.status).toBe("succeeded");
    expect(run.steps.every((step) => step.status === "done")).toBe(true);
  });

  it("re-runs steps the verifier sends back, once, with its feedback", async () => {
    planSteps = [{ id: "s1", agent: "coding", task: "Write the script", dependsOn: [] }];
    verifyQueue = [{ verdict: "revise", issues: ["bug"], revise: [{ stepId: "s1", feedback: "Handle empty input." }], reply: "draft", emotion: "neutral" }, pass("Fixed script")];
    const reply = await runTeamTask({ ...base, messages: [{ role: "user", content: "Write a script" }] });
    expect(reply.reply).toBe("Fixed script");
    expect(agentCalls).toHaveLength(2);
    expect(agentCalls[1].content).toContain("Handle empty input.");
    expect(TeamRuns.list()[0].steps[0].attempts).toBe(2);
  });

  it("skips steps whose dependency was declined and reports needs-attention", async () => {
    planSteps = [
      { id: "s1", agent: "memory", task: "Save my address", dependsOn: [] },
      { id: "s2", agent: "tasks", task: "Text it to Sam", dependsOn: ["s1"] },
      { id: "s3", agent: "research", task: "Explain postcodes", dependsOn: [] },
    ];
    agentImpl = async (content) => (content.includes("Save my address") ? { reply: "You declined.", emotion: "neutral", outcome: "declined" } : { reply: "ok", emotion: "neutral" });
    verifyQueue = [pass("Partly done")];
    await runTeamTask({ ...base, messages: [{ role: "user", content: "do it" }] });
    const [run] = TeamRuns.list();
    expect(run.steps.map((step) => step.status)).toEqual(["declined", "skipped", "done"]);
    expect(run.status).toBe("needs-attention");
  });

  it("stops between steps and resumes only what didn't finish", async () => {
    planSteps = [
      { id: "s1", agent: "research", task: "First", dependsOn: [] },
      { id: "s2", agent: "research", task: "Second", dependsOn: ["s1"] },
    ];
    const controller = new AbortController();
    agentImpl = async (content) => {
      if (content.includes("Your step: First")) controller.abort();
      return { reply: "ok", emotion: "neutral" };
    };
    const stopped = await runTeamTask({ ...base, signal: controller.signal, messages: [{ role: "user", content: "two things" }] });
    expect(stopped.outcome).toBe("stopped");
    let [run] = TeamRuns.list();
    expect(run.status).toBe("stopped");
    expect(run.steps.map((step) => step.status)).toEqual(["done", "stopped"]);

    agentCalls.length = 0;
    verifyQueue = [pass("Resumed")];
    const resumed = await resumeTeamRun(run.id, { generateLocal: async () => "" });
    expect(resumed.reply).toBe("Resumed");
    expect(agentCalls.map((call) => call.content.match(/Your step: (.*)/)?.[1])).toEqual(["Second"]);
    [run] = TeamRuns.list();
    expect(run.status).toBe("succeeded");
  });

  it("marks runs left active by a closed page as interrupted", async () => {
    window.localStorage.setItem("hannah.teamRuns.v1", JSON.stringify([{ id: "old", objective: "x", createdAt: 1, updatedAt: 1, status: "running", steps: [{ id: "s1", agent: "research", task: "t", dependsOn: [], status: "running", attempts: 1 }], settings: { mode: "cloud" }, context: [] }]));
    const [run] = TeamRuns.list();
    expect(run.status).toBe("interrupted");
    expect(run.steps[0].status).toBe("pending");
  });

  it("needs a server-backed mode", async () => {
    await expect(runTeamTask({ ...base, mode: "webllm", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/cloud or Ollama/);
  });
});
