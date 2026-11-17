// Run with: node --test client/plugins/desktop-tools
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { checkPageUrl, classifyAddress, createDesktopTools, parseCommand, tooBroad } from "./electron/dist/core.mjs";

let sandbox;
let project;
let outside;

before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "hannah-desktop-"));
  project = path.join(sandbox, "home", "project");
  outside = path.join(sandbox, "home", "secrets");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(project, "README.md"), "# Demo\n");
  await writeFile(path.join(project, "image.bin"), Buffer.from([1, 2, 0, 3]));
  await writeFile(path.join(outside, "token.txt"), "do-not-read");
  await symlink(outside, path.join(project, "escape"));
});

after(() => rm(sandbox, { recursive: true, force: true }));

function tools({ answers = [], pick = project, loadPage, lookup } = {}) {
  const asked = [];
  const queue = [...answers];
  const instance = createDesktopTools({
    loadPage,
    lookup,
    storePath: path.join(sandbox, `store-${Math.random()}.json`),
    chooseFolder: async () => pick,
    confirm: async (request) => { asked.push(request); return queue.length ? queue.shift() : 0; },
    home: path.join(sandbox, "home"),
  });
  return { instance, asked };
}

test("parses commands without a shell and refuses shell syntax", () => {
  assert.deepEqual(parseCommand(`git commit -m "fix: tidy up"`), { program: "git", args: ["commit", "-m", "fix: tidy up"] });
  assert.deepEqual(parseCommand("npm test"), { program: "npm", args: ["test"] });
  for (const bad of ["ls | grep x", "echo hi > out.txt", "npm test && rm x", "echo $HOME", "cat `id`"]) {
    assert.throws(() => parseCommand(bad), /without a shell/);
  }
  assert.throws(() => parseCommand("sudo rm -rf /"), /never runs “sudo”/);
  assert.throws(() => parseCommand("/bin/bash -c ls"), /doesn't start shells/);
  assert.throws(() => parseCommand("mkfs.ext4 /dev/sda"), /never runs/);
  assert.throws(() => parseCommand('echo "unclosed'), /isn't closed/);
});

test("refuses folders that are too broad or hold credentials", () => {
  const home = "/Users/demo";
  assert.match(tooBroad("/", home, "darwin"), /whole drive/);
  assert.match(tooBroad(home, home, "darwin"), /entire home/);
  assert.match(tooBroad("/Users", home, "darwin"), /contains your home/);
  assert.match(tooBroad(`${home}/.ssh`, home, "darwin"), /keys or credentials/);
  assert.match(tooBroad("/etc/nginx", home, "linux"), /system folder/);
  assert.equal(tooBroad(`${home}/code/app`, home, "darwin"), null);
});

test("lists and reads inside a granted folder only", async () => {
  const { instance } = tools();
  const { folder } = await instance.addFolder({ access: "read" });
  const listing = await instance.listDirectory({ folderId: folder.id });
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ["README.md", "escape", "image.bin", "src"]);
  assert.equal((await instance.readFile({ folderId: folder.id, path: "README.md" })).content, "# Demo\n");
  await assert.rejects(instance.readFile({ folderId: folder.id, path: "../secrets/token.txt" }), /above the granted folder/);
  await assert.rejects(instance.readFile({ folderId: folder.id, path: "/etc/passwd" }), /relative to the granted folder/);
  await assert.rejects(instance.readFile({ folderId: folder.id, path: "escape/token.txt" }), /outside the granted folder/);
  await assert.rejects(instance.readFile({ folderId: folder.id, path: "image.bin" }), /binary/);
  await assert.rejects(instance.readFile({ folderId: "nope", path: "README.md" }), /isn't shared/);
});

test("writes need read-write access and a native yes, and never escape through links", async () => {
  const { instance, asked } = tools({ answers: [0, 1, 0, 0] });
  const { folder } = await instance.addFolder({ access: "read" });
  await assert.rejects(instance.writeFile({ folderId: folder.id, path: "notes.txt", content: "hi" }), /read-only/);
  await instance.setAccess({ id: folder.id, access: "read-write" }); // answer 0: allow
  await assert.rejects(instance.writeFile({ folderId: folder.id, path: "notes.txt", content: "hi" }), /declined/); // answer 1: cancel
  await assert.rejects(readFile(path.join(project, "notes.txt")), /ENOENT/);
  const written = await instance.writeFile({ folderId: folder.id, path: "src/notes.txt", content: "hello" }); // answer 0
  assert.equal(written.created, true);
  assert.equal(await readFile(path.join(project, "src", "notes.txt"), "utf8"), "hello");
  assert.match(asked.at(-1).message, /create “src\/notes.txt”/);
  await assert.rejects(instance.writeFile({ folderId: folder.id, path: "escape/new.txt", content: "x" }), /outside the granted folder/);
  await assert.rejects(readFile(path.join(outside, "new.txt")), /ENOENT/);
});

test("commands run in the folder after approval, and 'always allow' covers only that exact command", async () => {
  const { instance, asked } = tools({ answers: [2, 1] });
  const { folder } = await instance.addFolder({ access: "read" });
  await assert.rejects(instance.runCommand({ folderId: folder.id, command: "node --version" }), /declined/); // answer 2: cancel
  const first = await instance.runCommand({ folderId: folder.id, command: "node -e \"console.log(process.cwd())\"" }); // answer 1: always
  assert.equal(first.exitCode, 0);
  assert.equal(first.stdout.trim(), await import("node:fs/promises").then((fs) => fs.realpath(project)));
  const promptsBefore = asked.length;
  const second = await instance.runCommand({ folderId: folder.id, command: "node -e \"console.log(process.cwd())\"" });
  assert.equal(second.exitCode, 0);
  assert.equal(asked.length, promptsBefore, "an always-allowed command doesn't ask again");
  await instance.runCommand({ folderId: folder.id, command: "node --version" }); // a different command asks again (default answer 0)
  assert.equal(asked.length, promptsBefore + 1);
  const missing = await instance.runCommand({ folderId: folder.id, command: "definitely-not-a-real-program-xyz" });
  assert.equal(missing.exitCode, null);
  assert.match(missing.stderr, /wasn't found/);
  const { activity } = await instance.recentActivity();
  assert.ok(activity.some((entry) => entry.kind === "command-denied"));
});

test("removing a folder revokes its access and its allowed commands", async () => {
  const { instance } = tools({ answers: [1] });
  const { folder } = await instance.addFolder({ access: "read" });
  await instance.runCommand({ folderId: folder.id, command: "node --version" });
  assert.equal((await instance.listFolders()).allowedCommands.length, 1);
  await instance.removeFolder({ id: folder.id });
  const state = await instance.listFolders();
  assert.equal(state.folders.length, 0);
  assert.equal(state.allowedCommands.length, 0);
  await assert.rejects(instance.listDirectory({ folderId: folder.id }), /isn't shared/);
});

test("workflow page addresses: this computer, link-local and metadata are refused; the local network is flagged", async () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyAddress("::1"), "loopback");
  assert.equal(classifyAddress("169.254.169.254"), "link-local");
  assert.equal(classifyAddress("fe80::1"), "link-local");
  assert.equal(classifyAddress("192.168.1.10"), "private");
  assert.equal(classifyAddress("fd00::1"), "private");
  assert.equal(classifyAddress("93.184.216.34"), "public");
  const lookup = async (host) => ({ "status.example.com": [{ address: "93.184.216.34" }], "router.home": [{ address: "192.168.1.1" }], "sneaky.example.com": [{ address: "93.184.216.34" }, { address: "127.0.0.1" }], "meta.example.com": [{ address: "169.254.169.254" }] })[host] ?? [];
  assert.deepEqual(await checkPageUrl("https://status.example.com/x?y=1", lookup), { url: "https://status.example.com/x?y=1", host: "status.example.com", localNetwork: false });
  assert.equal((await checkPageUrl("http://router.home/", lookup)).localNetwork, true);
  for (const [bad, reason] of [["http://localhost:3000/", /this computer itself/], ["http://127.0.0.1/", /this computer itself/], ["http://[::1]/", /this computer itself/], ["http://sneaky.example.com/", /this computer itself/], ["http://meta.example.com/", /link-local/], ["file:///etc/passwd", /Only http and https/], ["javascript:alert(1)", /Only http and https/], ["https://user:pw@status.example.com/", /user name or password/], ["https://nowhere.example.com/", /couldn't be found/]]) {
    await assert.rejects(checkPageUrl(bad, lookup), reason, bad);
  }
});

test("workflow tasks are off until allowed in a dialog; every page and coding task asks first", async () => {
  const pages = [];
  const lookup = async () => [{ address: "93.184.216.34" }];
  const { instance, asked } = tools({ answers: [1, 0, 0, 1, 0, 1], lookup, loadPage: async (request) => { pages.push(request); return { title: "Status", text: "OK" }; } });
  await assert.rejects(instance.readWebPage({ url: "https://status.example.com/", workflowName: "Watch status" }), /Workflow tasks are off/);
  assert.deepEqual(await instance.workflowTaskSettings(), { enabled: false });

  assert.deepEqual(await instance.setWorkflowTasks({ enabled: true }), { enabled: false }, "cancelled in the dialog");
  assert.deepEqual(await instance.setWorkflowTasks({ enabled: true }), { enabled: true });
  assert.match(asked[1].message, /send tasks to this computer/);

  const read = await instance.readWebPage({ url: "https://status.example.com/", waitFor: "#status", screenshot: true, workflowName: "Watch status" });
  assert.deepEqual(read, { approved: true, page: { title: "Status", text: "OK" } });
  assert.deepEqual(pages, [{ url: "https://status.example.com/", waitFor: "#status", screenshot: true }]);
  assert.match(asked[2].message, /“Watch status” wants to read a web page/);
  assert.match(asked[2].detail, /https:\/\/status.example.com\//);

  assert.deepEqual(await instance.readWebPage({ url: "https://status.example.com/", workflowName: "Watch status" }), { approved: false }, "declined: nothing is opened");
  assert.equal(pages.length, 1);
  await assert.rejects(instance.readWebPage({ url: "http://localhost:8080/admin", workflowName: "Watch status" }), /this computer itself/);
  assert.equal(asked.length, 4, "a refused address never reaches a dialog");

  const { folder } = await instance.addFolder({ access: "read-write" });
  const approved = await instance.approveWorkflowTask({ workflowName: "Fix the build", summary: "Run the tests", folderId: folder.id });
  assert.deepEqual(approved, { approved: true });
  assert.match(asked.at(-1).message, /Coding agent to work in project/);
  assert.deepEqual(await instance.approveWorkflowTask({ workflowName: "Fix the build", summary: "Run the tests", folderId: folder.id }), { approved: false });
  const kinds = (await instance.recentActivity()).activity.map((entry) => entry.kind);
  assert.ok(kinds.includes("workflow-page-read") && kinds.includes("workflow-page-declined") && kinds.includes("workflow-task-declined"));

  assert.deepEqual(await instance.setWorkflowTasks({ enabled: false }), { enabled: false });
  await assert.rejects(instance.approveWorkflowTask({ workflowName: "x", folderId: folder.id }), /Workflow tasks are off/);
});
