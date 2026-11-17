/**
 * Workflow tasks on this desktop.
 *
 * A server workflow's "Read a web page on your desktop" and "Coding task on
 * your desktop" steps queue a job for the account. While the desktop app is
 * open and signed in, and the person turned on "Run workflow tasks" in
 * Settings → Desktop access, this runner checks for jobs, claims one (only one
 * device gets it), asks the person in a system dialog, runs it here and
 * reports the result, which continues the workflow on the server.
 *
 * The system dialogs and the folder and address rules live in the desktop
 * plugin's main process (plugins/desktop-tools), so nothing here, and no
 * model, can skip them.
 */
import { accountRequest } from "./Account";
import { getAccountHint } from "./api";
import { desktopFilesAvailable, hannahDesktop, scopedDesktopTools, type SharedFolder } from "./DesktopFiles";
import { thisDevice } from "./DeviceTasks";

export type DeviceJob = {
  id: string;
  kind: "browser" | "coding";
  workflowName: string;
  executionId: string;
  input: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
};

type Outcome = { ok: true; output: Record<string, unknown> } | { ok: false; error: string };

export type JobDeps = {
  plugin: Pick<ReturnType<typeof hannahDesktop>, "readWebPage" | "approveWorkflowTask" | "listFolders">;
  runCodingAgent: (options: { task: string; folder: SharedFolder; allowCommands: boolean; onActivity: (line: string) => void }) => Promise<string>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Pick the shared folder a coding job names: by name (case-insensitive) or id, or the only one. */
export function findFolder(folders: SharedFolder[], wanted: string): SharedFolder | null {
  const name = wanted.trim().toLowerCase();
  if (!name) return folders.length === 1 ? folders[0] : null;
  return folders.find((folder) => folder.id === wanted || folder.name.toLowerCase() === name) ?? null;
}

/** Run one claimed job on this desktop and say how it went. Never throws. */
export async function runJob(job: DeviceJob, deps: JobDeps): Promise<Outcome> {
  try {
    if (job.kind === "browser") {
      const result = await deps.plugin.readWebPage({ url: String(job.input.url || ""), waitFor: String(job.input.waitFor || ""), screenshot: job.input.screenshot === true, workflowName: job.workflowName });
      if (!result.approved) return { ok: false, error: "You chose not to open this page on your desktop." };
      return { ok: true, output: result.page as Record<string, unknown> };
    }
    if (job.kind === "coding") {
      const { folders } = await deps.plugin.listFolders();
      const folder = findFolder(folders, String(job.input.folder || ""));
      if (!folder) return { ok: false, error: job.input.folder ? `No folder called “${String(job.input.folder)}” is shared in this desktop app. Share it in Settings → Desktop access, or fix the step's folder name.` : "Name the shared folder in the step: more than one (or no) folder is shared in this desktop app." };
      const task = String(job.input.task || "");
      const allowCommands = job.input.allowCommands !== false;
      const { approved } = await deps.plugin.approveWorkflowTask({ workflowName: job.workflowName, summary: `${task}${allowCommands ? "" : "\n\n(Commands are off for this task.)"}`, folderId: folder.id });
      if (!approved) return { ok: false, error: "You declined this coding task on your desktop." };
      const activity: string[] = [];
      const reply = await deps.runCodingAgent({ task, folder, allowCommands, onActivity: (line) => { if (activity.length < 40) activity.push(line.slice(0, 300)); } });
      return { ok: true, output: { reply, activity, folder: folder.name } };
    }
    return { ok: false, error: `This desktop app can't run “${String(job.kind)}” tasks. Update it.` };
  } catch (error) {
    return { ok: false, error: message(error).slice(0, 900) };
  }
}

async function runCodingAgent({ task, folder, allowCommands, onActivity }: Parameters<JobDeps["runCodingAgent"]>[0]) {
  const [{ runAgentTurn }, { automationModel }, { getSessionGroqKey }] = await Promise.all([import("./AgentRuntime"), import("./AutomationService"), import("./api")]);
  const { mode, providerId, model } = automationModel();
  const result = await runAgentTurn({
    mode, providerId, model,
    groqApiKey: getSessionGroqKey() || undefined,
    messages: [{ role: "user", content: `You're HANNAH's Coding agent, running a task a workflow sent to this computer. Work only in the shared folder “${folder.name}” (${folder.access}). ${allowCommands ? "You may run commands such as tests; each one asks the person first." : "Don't run commands for this task."} Finish with a short report of what you found or changed.\n\nTask: ${task}` }],
    toolsOverride: scopedDesktopTools(folder, { allowCommands }),
    maxIterations: 12,
    agentLabel: "Workflow coding task",
    signal: AbortSignal.timeout(15 * 60_000),
    onActivity: (activity) => onActivity(activity.message),
    generateLocal: async (_prompt, _mode, cause) => {
      throw cause instanceof Error ? cause : new Error("HANNAH's AI didn't answer.");
    },
  });
  if (result.outcome === "stopped") throw new Error("The coding task ran longer than 15 minutes and was stopped.");
  if (result.outcome) throw new Error(result.reply || "The coding task didn't finish.");
  return result.reply;
}

const POLL_MS = 20_000;
let running = false;

/** Check for jobs once and run them one at a time. Returns how many ran. */
export async function checkForJobs(deps: JobDeps = { plugin: hannahDesktop(), runCodingAgent }): Promise<number> {
  if (running) return 0;
  running = true;
  let ran = 0;
  try {
    const { jobs } = await accountRequest<{ jobs: DeviceJob[] }>("/api/workflows/device-jobs");
    const device = thisDevice();
    for (const job of jobs) {
      try {
        await accountRequest(`/api/workflows/device-jobs/${encodeURIComponent(job.id)}/claim`, { method: "POST", body: JSON.stringify({ deviceId: device.id, deviceName: device.name }) });
      } catch {
        continue; // Another device took it, or it was cancelled.
      }
      const outcome = await runJob(job, deps);
      await accountRequest(`/api/workflows/device-jobs/${encodeURIComponent(job.id)}/complete`, { method: "POST", body: JSON.stringify({ deviceId: device.id, deviceName: device.name, ...outcome }), signal: AbortSignal.timeout(60_000) }).catch(() => {});
      ran += 1;
    }
  } finally {
    running = false;
  }
  return ran;
}

/** Start checking while the desktop app is open. Returns a stop function. */
export function startDesktopWorkflowJobs(): () => void {
  if (!desktopFilesAvailable()) return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped || !getAccountHint()) return;
    try {
      const { enabled } = await hannahDesktop().workflowTaskSettings();
      if (enabled) await checkForJobs();
    } catch {
      // Offline, signed out or the server has no workflows: try again later.
    }
  };
  const timer = window.setInterval(() => void tick(), POLL_MS);
  const onFocus = () => void tick();
  window.addEventListener("focus", onFocus);
  void tick();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("focus", onFocus);
  };
}
