import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: Record<string, unknown> | null }>,
  jobs: [] as unknown[],
  claimRefused: new Set<string>(),
}));
vi.mock("../services/api", () => ({ getAccountHint: () => ({ email: "me@example.com" }), getSessionGroqKey: () => "" }));
vi.mock("../services/DeviceTasks", () => ({ thisDevice: () => ({ id: "dev-test0123456789", name: "Test Mac" }) }));
vi.mock("../services/Account", () => ({
  accountRequest: async (path: string, init: RequestInit = {}) => {
    state.calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/workforce/local-jobs") return { jobs: state.jobs };
    const claimed = /local-jobs\/([^/]+)\/claim$/.exec(path);
    if (claimed && state.claimRefused.has(claimed[1])) throw new Error("Another device took this job.");
    return {};
  },
}));

import { checkForTeammateJobs, teammateJobAsDeviceJob, type JobDeps, type TeammateJob } from "../services/DesktopWorkflowJobs";

const teammateJob = (id: string, kind: TeammateJob["kind"], input: Record<string, unknown>): TeammateJob => ({ id, kind, taskId: "task_1", input: { teammate: "Pip", taskTitle: "Status check", ...input }, createdAt: 0, expiresAt: 0 });

function deps(approved = true) {
  const seen: Array<Record<string, unknown>> = [];
  const value: JobDeps = {
    plugin: {
      readWebPage: async (options) => { seen.push(options as unknown as Record<string, unknown>); return approved ? { approved: true, page: { title: "Status", url: String(options.url), description: "", text: "All good", textTruncated: false, links: [], status: 200, loadedInMs: 5 } } : { approved: false }; },
      approveWorkflowTask: async () => ({ approved }),
      listFolders: async () => ({ folders: [], allowedCommands: [], platform: "darwin" }),
      runWorkflowOpen: async () => ({ approved }),
      workflowNotify: async () => ({ shown: true }),
    },
    runCodingAgent: async () => "done",
  };
  return { value, seen };
}

beforeEach(() => { state.calls = []; state.jobs = []; state.claimRefused.clear(); });

describe("teammate jobs on the desktop", () => {
  it("names the teammate and task in the desktop's dialog", () => {
    const job = teammateJobAsDeviceJob(teammateJob("lj_1", "browser", { url: "https://status.example.com/" }));
    expect(job.workflowName).toBe("Teammate Pip (task “Status check”)");
    expect(job.kind).toBe("browser");
  });

  it("claims each job before running it, skips ones another device took, and reports the outcome to the workforce", async () => {
    state.jobs = [teammateJob("lj_1", "browser", { url: "https://status.example.com/" }), teammateJob("lj_2", "browser", { url: "https://other.example.com/" })];
    state.claimRefused.add("lj_2");
    const { value, seen } = deps();
    expect(await checkForTeammateJobs(value)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].workflowName).toBe("Teammate Pip (task “Status check”)");
    const complete = state.calls.find((call) => call.path === "/api/workforce/local-jobs/lj_1/complete");
    expect(complete?.body).toMatchObject({ deviceId: "dev-test0123456789", deviceName: "Test Mac", ok: true });
    expect(state.calls.some((call) => call.path === "/api/workforce/local-jobs/lj_2/complete")).toBe(false);
  });

  it("reports a declined dialog as a failure, not a success", async () => {
    state.jobs = [teammateJob("lj_3", "browser", { url: "https://status.example.com/" })];
    await checkForTeammateJobs(deps(false).value);
    const complete = state.calls.find((call) => call.path === "/api/workforce/local-jobs/lj_3/complete");
    expect(complete?.body).toMatchObject({ ok: false, error: "You chose not to open this page on your desktop." });
  });
});
