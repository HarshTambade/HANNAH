import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedFolder } from "../services/DesktopFiles";

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
    if (path === "/api/workflows/device-jobs") return { jobs: state.jobs };
    const claimed = /device-jobs\/([^/]+)\/claim$/.exec(path);
    if (claimed && state.claimRefused.has(claimed[1])) throw new Error("Another device took this task.");
    return {};
  },
}));

import { checkForJobs, findFolder, runJob, type DeviceJob, type JobDeps } from "../services/DesktopWorkflowJobs";

const folder = (name: string, access: SharedFolder["access"] = "read-write"): SharedFolder => ({ id: `f-${name}`, name, path: `/Users/me/${name}`, access, addedAt: 0 });
const job = (kind: DeviceJob["kind"], input: Record<string, unknown>, id = "dj_1"): DeviceJob => ({ id, kind, workflowName: "Nightly check", executionId: "ex_1", input, createdAt: 0, expiresAt: 0 });

function deps(overrides: Partial<{ approvePage: boolean; approveTask: boolean; folders: SharedFolder[]; reply: string; fail: string }> = {}) {
  const seen: Record<string, unknown[]> = { readWebPage: [], approveWorkflowTask: [], agent: [] };
  const value: JobDeps = {
    plugin: {
      readWebPage: async (options) => {
        seen.readWebPage.push(options);
        if (overrides.fail) throw new Error(overrides.fail);
        return overrides.approvePage === false ? { approved: false } : { approved: true, page: { title: "Status", url: String(options.url), description: "", text: "All good", textTruncated: false, links: [], status: 200, loadedInMs: 5 } };
      },
      approveWorkflowTask: async (options) => { seen.approveWorkflowTask.push(options); return { approved: overrides.approveTask !== false }; },
      listFolders: async () => ({ folders: overrides.folders ?? [folder("hannah"), folder("notes", "read")], allowedCommands: [], platform: "darwin" }),
    },
    runCodingAgent: async (options) => {
      seen.agent.push(options);
      options.onActivity("Read package.json");
      options.onActivity("Ran npm test");
      return overrides.reply ?? "Tests pass after fixing the import.";
    },
  };
  return { value, seen };
}

beforeEach(() => { state.calls = []; state.jobs = []; state.claimRefused.clear(); });

describe("workflow tasks on the desktop", () => {
  it("finds the shared folder by name, id or as the only one", () => {
    const folders = [folder("hannah"), folder("Notes")];
    expect(findFolder(folders, "notes")?.id).toBe("f-Notes");
    expect(findFolder(folders, "f-hannah")?.name).toBe("hannah");
    expect(findFolder(folders, "")).toBeNull();
    expect(findFolder([folder("only")], "")?.name).toBe("only");
    expect(findFolder(folders, "missing")).toBeNull();
  });

  it("reads a page through the plugin and reports a decline or an error as a failure", async () => {
    const ok = deps();
    expect(await runJob(job("browser", { url: "https://status.example.com/", waitFor: "#ok", screenshot: true }), ok.value)).toMatchObject({ ok: true, output: { title: "Status", text: "All good" } });
    expect(ok.seen.readWebPage[0]).toEqual({ url: "https://status.example.com/", waitFor: "#ok", screenshot: true, workflowName: "Nightly check" });
    expect(await runJob(job("browser", { url: "https://status.example.com/" }), deps({ approvePage: false }).value)).toEqual({ ok: false, error: "You chose not to open this page on your desktop." });
    expect(await runJob(job("browser", { url: "http://localhost/" }), deps({ fail: "Workflows can't open pages on this computer itself." }).value)).toEqual({ ok: false, error: "Workflows can't open pages on this computer itself." });
  });

  it("runs a coding task only in the named folder, after approval, and returns its report and activity", async () => {
    const ok = deps();
    const outcome = await runJob(job("coding", { folder: "HANNAH", task: "Run the tests", allowCommands: false }), ok.value);
    expect(outcome).toEqual({ ok: true, output: { reply: "Tests pass after fixing the import.", activity: ["Read package.json", "Ran npm test"], folder: "hannah" } });
    expect(ok.seen.approveWorkflowTask[0]).toMatchObject({ workflowName: "Nightly check", folderId: "f-hannah" });
    expect(String((ok.seen.approveWorkflowTask[0] as { summary: string }).summary)).toMatch(/Commands are off/);
    expect(ok.seen.agent[0]).toMatchObject({ task: "Run the tests", allowCommands: false, folder: { id: "f-hannah" } });

    const declined = deps({ approveTask: false });
    expect(await runJob(job("coding", { folder: "hannah", task: "x" }), declined.value)).toEqual({ ok: false, error: "You declined this coding task on your desktop." });
    expect(declined.seen.agent).toHaveLength(0);
    expect(await runJob(job("coding", { folder: "secrets", task: "x" }), deps().value)).toMatchObject({ ok: false, error: expect.stringMatching(/No folder called “secrets”/) });
  });

  it("claims each job before running it, skips ones another device took, and reports every outcome", async () => {
    state.jobs = [job("browser", { url: "https://a.example.com/" }, "dj_a"), job("browser", { url: "https://b.example.com/" }, "dj_b")];
    state.claimRefused.add("dj_a");
    const ran = await checkForJobs(deps().value);
    expect(ran).toBe(1);
    expect(state.calls.map((call) => call.path)).toEqual([
      "/api/workflows/device-jobs",
      "/api/workflows/device-jobs/dj_a/claim",
      "/api/workflows/device-jobs/dj_b/claim",
      "/api/workflows/device-jobs/dj_b/complete",
    ]);
    expect(state.calls[2].body).toEqual({ deviceId: "dev-test0123456789", deviceName: "Test Mac" });
    expect(state.calls[3].body).toMatchObject({ deviceId: "dev-test0123456789", ok: true, output: { title: "Status" } });
  });
});
