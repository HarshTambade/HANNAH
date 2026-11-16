import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

describe("AgentRunLog", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("records steps and the final status of a run", async () => {
    vi.stubGlobal("window", { localStorage: memoryStorage(), dispatchEvent: () => true });
    const { AgentRunLog } = await import("../services/AgentRunLog");
    const id = AgentRunLog.start({ objective: "Save my plan to a file", mode: "cloud" });
    AgentRunLog.step(id, { tool: "write_app_file", outcome: "declined" });
    AgentRunLog.finish(id, "declined");
    // A later finish can't overwrite the first outcome.
    AgentRunLog.finish(id, "succeeded");
    const [run] = AgentRunLog.list();
    expect(run.status).toBe("declined");
    expect(run.steps).toEqual([expect.objectContaining({ tool: "write_app_file", outcome: "declined" })]);
  });

  it("marks runs left running by a closed page as interrupted", async () => {
    const stale = [{ id: "old", startedAt: 1, objective: "Long task", mode: "cloud", status: "running", steps: [] }];
    vi.stubGlobal("window", { localStorage: memoryStorage({ "hannah.agentRuns.v1": JSON.stringify(stale) }), dispatchEvent: () => true });
    const { AgentRunLog } = await import("../services/AgentRunLog");
    expect(AgentRunLog.list()[0].status).toBe("interrupted");
  });
});
