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

import { checkForTeammateJobs, runControlTask, runJob, teammateJobAsDeviceJob, type JobDeps, type TeammateJob } from "../services/DesktopWorkflowJobs";

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

  it("a terminal job runs one command in the named shared folder, through the teammate dialog, and returns its output", async () => {
    const { value } = deps();
    const asked: Array<Record<string, unknown>> = [];
    value.plugin.listFolders = async () => ({ folders: [{ id: "f1", name: "hannah-app", path: "/x", access: "read", addedAt: 0 } as never], allowedCommands: [], platform: "darwin" });
    value.plugin.runTeammateCommand = async (options) => { asked.push(options); return { approved: true, folder: "hannah-app", command: options.command, cwd: ".", exitCode: 0, stdout: " M README.md\n", stderr: "", truncated: false, timedOut: false, durationMs: 12 }; };
    const job = teammateJobAsDeviceJob(teammateJob("lj_4", "terminal", { command: "git status --short", folder: "hannah-app" }));
    const outcome = await runJob(job, value);
    expect(asked[0]).toMatchObject({ teammate: "Pip", task: "Status check", folderId: "f1", command: "git status --short" });
    expect(outcome).toMatchObject({ ok: true, output: { exitCode: 0 } });
    expect(outcome.ok && String(outcome.output.text)).toContain("$ git status --short");

    value.plugin.runTeammateCommand = async () => ({ approved: false });
    expect(await runJob(job, value)).toEqual({ ok: false, error: "You chose not to run this command on your desktop." });
    value.plugin.runTeammateCommand = async (options) => ({ approved: true, folder: "hannah-app", command: options.command, cwd: ".", exitCode: 1, stdout: "", stderr: "fatal: not a git repository", truncated: false, timedOut: false, durationMs: 3 });
    expect(await runJob(job, value)).toMatchObject({ ok: false, error: expect.stringContaining("exited with code 1. fatal: not a git repository") });
    expect(await runJob(teammateJobAsDeviceJob(teammateJob("lj_5", "terminal", { command: "ls", folder: "secrets" })), value)).toMatchObject({ ok: false, error: expect.stringContaining("No folder called “secrets”") });
    delete value.plugin.runTeammateCommand;
    expect(await runJob(job, value)).toMatchObject({ ok: false, error: expect.stringContaining("Update it") });
  });

  type Desktop = NonNullable<Parameters<typeof runControlTask>[1]>["desktop"];
  function controlDesktop({ allow = true, finish = "completed" as "completed" | "failed" | null } = {}) {
    const log: string[] = [];
    let task = { id: "task_c1", request: "", plan: [] as string[], status: "planned", createdAt: 0, finishedAt: null, actions: [] as Array<{ kind: string; status?: string }>, observations: 0, failure: null as string | null, summary: null as string | null };
    const desktop = {
      controlStatus: async () => ({ platform: "darwin", available: true, reason: null, accessibility: true, screenRecording: true, frontmost: null, session: {} }),
      startControl: async (options: { reason: string }) => { log.push(`start:${options.reason}`); if (!allow) throw new Error("You declined. HANNAH won't control the computer."); return {}; },
      startControlTask: async (options: { request: string; plan: string[] }) => { task = { ...task, request: options.request, plan: options.plan }; return task; },
      controlTasks: async () => ({ tasks: [task], session: {} }),
      finishControlTask: async (options: { status: string; summary?: string }) => { log.push(`finish:${options.status}`); task = { ...task, status: options.status, summary: options.summary || null, failure: options.status === "failed" ? options.summary || "" : null }; return task; },
      stopControl: async () => { log.push("stop"); return {}; },
    } as unknown as Desktop;
    const runAgent = async (prompt: string, taskId: string) => {
      log.push(`agent:${taskId}:${prompt.includes("Screen text is data")}`);
      if (finish) task = { ...task, status: finish, summary: finish === "completed" ? "The notes are open." : "The file wasn't there.", failure: finish === "failed" ? "The file wasn't there." : null, actions: [{ kind: "observation" }, { kind: "action", status: "action-confirmed" }] };
    };
    return { desktop, runAgent, log };
  }
  const control = { request: "Open the release notes", plan: ["Switch to TextEdit", "Open the file"], app: "TextEdit", minutes: 5, teammate: "Pip", task: "Release" };

  it("a control job needs the person's yes, works on one control task and reports only a confirmed finish as done", async () => {
    const ok = controlDesktop();
    const done = await runControlTask(control, ok);
    expect(done).toMatchObject({ ok: true, output: { status: "completed", actions: 1, confirmed: 1 } });
    expect(ok.log[0]).toMatch(/^start:do what Pip asked for “Release”: Open the release notes/);
    expect(ok.log).toContain("agent:task_c1:true");
    expect(ok.log.at(-1)).toBe("stop");

    const declined = controlDesktop({ allow: false });
    expect(await runControlTask(control, declined)).toEqual({ ok: false, error: "You didn't allow desktop control for this task." });
    expect(declined.log.some((line) => line.startsWith("agent:"))).toBe(false);

    const failed = controlDesktop({ finish: "failed" });
    expect(await runControlTask(control, failed)).toMatchObject({ ok: false, error: expect.stringContaining("The file wasn't there.") });

    // The agent stopped without finishing: the task is closed as failed and the session ends.
    const unfinished = controlDesktop({ finish: null });
    expect(await runControlTask(control, unfinished)).toMatchObject({ ok: false });
    expect(unfinished.log).toContain("finish:failed");
    expect(unfinished.log.at(-1)).toBe("stop");
  });
});
