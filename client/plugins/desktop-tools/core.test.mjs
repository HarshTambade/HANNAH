// Run with: node --test client/plugins/desktop-tools
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createDesktopTools, parseCommand, tooBroad } from "./electron/dist/core.mjs";

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

function tools({ answers = [], pick = project } = {}) {
  const asked = [];
  const queue = [...answers];
  const instance = createDesktopTools({
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
