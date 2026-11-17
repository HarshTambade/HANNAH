import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ account: null as null | { email: string }, posted: [] as Array<{ path: string; body: unknown }> }));
vi.mock("../services/api", () => ({ getAccountHint: () => state.account }));
vi.mock("../services/Account", () => ({
  AccountError: class extends Error {},
  accountRequest: async (path: string, init: RequestInit = {}) => {
    state.posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/workflows/from-text") return { workflow: { id: "wf_1", name: "Morning mail summary" }, definition: { nodes: [{ name: "Every morning" }, { name: "Newest mail" }] }, validation: { errors: [] }, notes: "Connect Google first." };
    return { workflows: [{ name: "Invoices", active: true, publishedVersion: 2, triggers: ["trigger.webhook"], lastRun: { status: "completed", at: 0, error: null }, nextRunAt: null }] };
  },
}));

import { getWorkflowTools } from "../services/WorkflowTools";

beforeEach(() => { state.account = null; state.posted = []; });

describe("workflow chat tools", () => {
  it("are offered only to signed-in accounts", () => {
    expect(getWorkflowTools()).toEqual([]);
    state.account = { email: "me@example.com" };
    expect(getWorkflowTools().map((tool) => tool.name)).toEqual(["create_workflow_draft", "list_workflows"]);
  });

  it("turn a request into an inactive draft and report what still needs setting up", async () => {
    state.account = { email: "me@example.com" };
    const [create] = getWorkflowTools();
    expect(create.requiresApproval).toBeUndefined();
    const result = await create.execute({ description: "summarize my new emails every morning" }) as { created: { active: boolean; steps: string[] }; needsSetup: string };
    expect(state.posted[0]).toMatchObject({ path: "/api/workflows/from-text", body: { description: "summarize my new emails every morning" } });
    expect(result.created).toMatchObject({ active: false, steps: ["Every morning", "Newest mail"] });
    expect(result.needsSetup).toBe("Connect Google first.");
  });
});
