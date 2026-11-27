// Run with: node --test client/plugins/desktop-tools/teammate.test.mjs
// A command a person sent from an AI Workforce teammate's task.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDesktopTools } from "./electron/dist/core.mjs";

let sandbox;
let project;

before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "hannah-teammate-"));
  project = path.join(sandbox, "home", "project");
  await mkdir(project, { recursive: true });
});

after(() => rm(sandbox, { recursive: true, force: true }));

function tools(answers = []) {
  const asked = [];
  const queue = [...answers];
  const instance = createDesktopTools({
    storePath: path.join(sandbox, `store-${Math.random()}.json`),
    chooseFolder: async () => project,
    confirm: async (request) => { asked.push(request); return queue.length ? queue.shift() : 0; },
    home: path.join(sandbox, "home"),
  });
  return { instance, asked };
}

test("a teammate's command needs workflow tasks on", async () => {
  const { instance } = tools();
  const { folder } = await instance.addFolder({ access: "read" });
  await assert.rejects(instance.runTeammateCommand({ teammate: "Ops", task: "Check", folderId: folder.id, command: "node --version" }), /Workflow tasks are off/);
});

test("a teammate's command names the teammate, shows the exact command, and runs only on a yes", async () => {
  const { instance, asked } = tools([0, 0, 1, 0]); // add folder needs none; enable tasks: 0; first run: 0; second: 1 (don't); third: 0
  const { folder } = await instance.addFolder({ access: "read" });
  await instance.setWorkflowTasks({ enabled: true });
  const ran = await instance.runTeammateCommand({ teammate: "Ops Analyst", task: "Check the repo", folderId: folder.id, command: "node -e \"console.log(process.cwd())\"" });
  assert.equal(ran.approved, true);
  assert.equal(ran.exitCode, 0);
  assert.equal(ran.stdout.trim(), await realpath(project));
  const prompt = asked.at(-1);
  assert.match(prompt.message, /Ops Analyst \(task “Check the repo”\)/);
  assert.match(prompt.detail, /node -e "console\.log\(process\.cwd\(\)\)"/);
  assert.deepEqual(prompt.buttons, ["Run it", "Don't run"], "no 'always allow' for a teammate");

  const declined = await instance.runTeammateCommand({ teammate: "Ops Analyst", task: "Check the repo", folderId: folder.id, command: "node --version" });
  assert.deepEqual(declined, { approved: false });

  // Always-allowing a command for HANNAH doesn't let a teammate run it without asking.
  const before = asked.length;
  await instance.runTeammateCommand({ teammate: "Ops Analyst", task: "Check", folderId: folder.id, command: "node --version" });
  assert.equal(asked.length, before + 1);

  const { activity } = await instance.recentActivity();
  assert.ok(activity.some((entry) => entry.kind === "teammate-command-denied"));
  assert.ok(activity.some((entry) => entry.kind === "command" && /teammate Ops Analyst/.test(entry.by || "")));
});

test("a teammate's command keeps the folder and shell rules", async () => {
  const { instance } = tools();
  const { folder } = await instance.addFolder({ access: "read" });
  await instance.setWorkflowTasks({ enabled: true });
  await assert.rejects(instance.runTeammateCommand({ teammate: "Ops", task: "x", folderId: folder.id, command: "ls | grep x" }), /without a shell/);
  await assert.rejects(instance.runTeammateCommand({ teammate: "Ops", task: "x", folderId: folder.id, command: "sudo ls" }), /never runs “sudo”/);
  await assert.rejects(instance.runTeammateCommand({ teammate: "Ops", task: "x", folderId: folder.id, path: "../..", command: "node --version" }));
  await assert.rejects(instance.runTeammateCommand({ teammate: "Ops", task: "x", folderId: "nope", command: "node --version" }));
});
