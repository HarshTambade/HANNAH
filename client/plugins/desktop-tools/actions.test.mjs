// Run with: node --test client/plugins/desktop-tools
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createAppLauncher, discoverApps, findApps, parseDesktopEntry, parseExec, parsePs, parseTasklist } from "./electron/dist/apps.mjs";
import { createDesktopTools } from "./electron/dist/core.mjs";

let sandbox;
before(async () => { sandbox = await mkdtemp(path.join(os.tmpdir(), "hannah-actions-")); });
after(() => rm(sandbox, { recursive: true, force: true }));

test("reads .desktop entries and their Exec lines per the Desktop Entry spec", () => {
  const entry = parseDesktopEntry("[Desktop Entry]\nName=Visual Studio Code\nName[de]=Code\nExec=/usr/share/code/code --unity-launch %F\nType=Application\n[Desktop Action new-window]\nExec=/usr/share/code/code --new-window\n");
  assert.deepEqual(entry, { Name: "Visual Studio Code", Exec: "/usr/share/code/code --unity-launch %F", Type: "Application" });
  assert.deepEqual(parseExec(entry.Exec, "/home/me/project"), { program: "/usr/share/code/code", args: ["--unity-launch", "/home/me/project"], acceptsFolder: true });
  assert.deepEqual(parseExec(entry.Exec), { program: "/usr/share/code/code", args: ["--unity-launch"], acceptsFolder: false });
  assert.deepEqual(parseExec('"/opt/My App/run" --name "a \\"b\\"" %i %c 100%%'), { program: "/opt/My App/run", args: ["--name", 'a "b"', "100%"], acceptsFolder: false });
});

test("finds apps from each platform's own launchers", async () => {
  const mac = path.join(sandbox, "mac");
  await mkdir(path.join(mac, "Visual Studio Code.app", "Contents"), { recursive: true });
  await mkdir(path.join(mac, "Google Chrome.app"), { recursive: true });
  await mkdir(path.join(mac, "Utilities", "Terminal.app"), { recursive: true });
  await mkdir(path.join(mac, "notes-folder"), { recursive: true });
  const macApps = await discoverApps({ platform: "darwin", home: sandbox, roots: [mac] });
  assert.deepEqual(macApps.map((app) => app.name), ["Google Chrome", "Terminal", "Visual Studio Code"]);
  assert.equal(macApps[2].id, path.join(mac, "Visual Studio Code.app"));

  const start = path.join(sandbox, "start");
  await mkdir(path.join(start, "Visual Studio Code"), { recursive: true });
  await writeFile(path.join(start, "Visual Studio Code", "Visual Studio Code.lnk"), "lnk");
  await writeFile(path.join(start, "Visual Studio Code", "Uninstall Visual Studio Code.lnk"), "lnk");
  await writeFile(path.join(start, "Notepad.lnk"), "lnk");
  const winApps = await discoverApps({ platform: "win32", home: sandbox, roots: [start] });
  assert.deepEqual(winApps.map((app) => app.name), ["Notepad", "Visual Studio Code"], "uninstallers are left out");

  const user = path.join(sandbox, "local", "applications");
  const system = path.join(sandbox, "usr", "applications");
  await mkdir(user, { recursive: true });
  await mkdir(system, { recursive: true });
  await writeFile(path.join(system, "code.desktop"), "[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=/usr/bin/code %F\n");
  await writeFile(path.join(user, "code.desktop"), "[Desktop Entry]\nType=Application\nName=Visual Studio Code\nExec=/home/me/bin/code %F\n");
  await writeFile(path.join(system, "hidden.desktop"), "[Desktop Entry]\nType=Application\nName=Helper\nExec=helper\nNoDisplay=true\n");
  await writeFile(path.join(system, "htop.desktop"), "[Desktop Entry]\nType=Application\nName=htop\nExec=htop\nTerminal=true\n");
  const linuxApps = await discoverApps({ platform: "linux", home: sandbox, roots: [user, system] });
  assert.deepEqual(linuxApps.map((app) => [app.name, app.exec]), [["Visual Studio Code", "/home/me/bin/code %F"]], "the user's entry wins; hidden and terminal entries are left out");
});

test("reads process lists on each platform", () => {
  assert.deepEqual(parsePs("  4242 /Applications/Visual Studio Code.app/Contents/MacOS/Electron"), { pid: 4242, program: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" });
  assert.deepEqual(parseTasklist('"Code.exe","9120","Console","1","120,404 K"'), { pid: 9120, program: "Code.exe" });
  assert.equal(parsePs(""), null);
});

test("matches what people say to installed apps, and reports ties", () => {
  const apps = ["Visual Studio Code", "Visual Studio Code - Insiders", "Google Chrome", "Chrome Remote Desktop", "Notes"].map((name) => ({ id: name, name }));
  assert.deepEqual(findApps(apps, "vs code").map((app) => app.name), ["Visual Studio Code"]);
  assert.deepEqual(findApps(apps, "chrome").map((app) => app.name), ["Google Chrome"]);
  assert.deepEqual(findApps(apps, "visual studio").map((app) => app.name), ["Visual Studio Code", "Visual Studio Code - Insiders"]);
  assert.deepEqual(findApps(apps, "photoshop"), []);
});

test("reports an app open only when its process is seen", async () => {
  const app = { id: "/Applications/Visual Studio Code.app", name: "Visual Studio Code", kind: "bundle" };
  const run = [];
  let launched = false;
  const execFile = (program, args, _options, callback) => {
    run.push([program, ...args]);
    if (program === "open") { launched = true; return callback(null, "", ""); }
    const lines = ["  101 /usr/libexec/coreaudiod", ...(launched ? [" 4242 /Applications/Visual Studio Code.app/Contents/MacOS/Electron"] : [])];
    return callback(null, lines.join("\n"), "");
  };
  const launcher = createAppLauncher({ platform: "darwin", home: "/Users/me", execFile, wait: async () => undefined });
  assert.deepEqual(await launcher.launch(app, { folder: "/Users/me/project" }), { verified: true, alreadyRunning: false });
  assert.deepEqual(run.find(([program]) => program === "open"), ["open", "-a", "/Applications/Visual Studio Code.app", "/Users/me/project"]);

  const never = createAppLauncher({ platform: "darwin", home: "/Users/me", execFile: (program, _args, _options, callback) => callback(null, program === "ps" ? "  7 /usr/libexec/other" : "", ""), wait: async () => undefined, checks: 3 });
  assert.deepEqual(await never.launch(app), { verified: false, alreadyRunning: false });

  // Already running: the launch is handed to the existing process, so no new one appears.
  const running = createAppLauncher({ platform: "darwin", home: "/Users/me", execFile: (program, _args, _options, callback) => callback(null, program === "ps" ? " 900 /Applications/Visual Studio Code.app/Contents/MacOS/Electron" : "", ""), wait: async () => undefined });
  assert.deepEqual(await running.launch(app), { verified: true, alreadyRunning: true });

  // Linux: only the program itself counts, not an argument that happens to share its name.
  const entry = { id: "/usr/share/applications/code.desktop", name: "Visual Studio Code", exec: "/usr/bin/code %F" };
  let started = false;
  const linuxPs = () => ["  10 vim notes/code", "  11 grep code", ...(started ? ["  12 /usr/share/code/code --unity-launch"] : [])].join("\n");
  const spawn = () => { started = true; const child = { once: (event, handler) => { if (event === "spawn") setImmediate(handler); return child; }, unref: () => undefined }; return child; };
  const linux = createAppLauncher({ platform: "linux", home: "/home/me", spawn, execFile: (_program, _args, _options, callback) => callback(null, linuxPs(), ""), wait: async () => undefined });
  assert.deepEqual(await linux.launch(entry), { verified: true, alreadyRunning: false });

  const noTarget = createAppLauncher({ platform: "win32", home: "C:\\Users\\me", readShortcut: () => ({ target: "" }), openPath: async () => "", execFile: () => assert.fail("nothing to check") });
  assert.deepEqual(await noTarget.launch({ id: "C:\\Start\\Calculator.lnk", name: "Calculator" }), { verified: null, alreadyRunning: false }, "no way to check is reported as unknown, not as success");
});

function harness({ answers = [], shot = { permission: "granted", image: "/9j/AAAA", mediaType: "image/jpeg", width: 1568, height: 980, windows: ["index.ts — app"] }, apps = [], folder } = {}) {
  const asked = [];
  const queue = [...answers];
  const sessions = [];
  const launches = [];
  const opened = [];
  const notes = [];
  let loginItemOn = false;
  let clock = 1_000_000;
  const instance = createDesktopTools({
    storePath: path.join(sandbox, `store-${Math.random()}.json`),
    chooseFolder: async () => folder ?? null,
    confirm: async (request) => { asked.push(request); return queue.length ? queue.shift() : 0; },
    home: path.join(sandbox, "home"),
    now: () => clock,
    captureScreen: async () => (typeof shot === "function" ? shot() : shot),
    screenPermission: async () => (typeof shot === "function" ? "granted" : shot.permission),
    onScreenSession: (state) => sessions.push(state.state),
    apps: { discover: async () => apps, launch: async (app, options) => { launches.push([app.name, options.folder]); return { verified: true, alreadyRunning: false }; } },
    loginItem: { get: async () => ({ openAtLogin: loginItemOn, status: loginItemOn ? "enabled" : "not-registered", where: "Login Items" }), set: async (on) => { loginItemOn = on; } },
    openUrl: async (url) => { opened.push(url); },
    notify: (note) => notes.push(note),
    wait: async () => undefined,
  });
  return { instance, asked, sessions, launches, opened, notes, tick: (ms) => { clock += ms; }, loginItem: () => loginItemOn };
}

test("the screen: asks first, once or for 15 minutes, shows the session, and can be stopped", async () => {
  const declined = harness({ answers: [2] });
  await assert.rejects(declined.instance.captureScreen({ reason: "explain this error" }), /declined/);
  assert.match(declined.asked[0].message, /explain this error/);
  assert.match(declined.asked[0].detail, /can't click or type/);

  const once = harness({ answers: [0, 2] });
  const shot = await once.instance.captureScreen({ reason: "see the page" });
  assert.equal(shot.image, "/9j/AAAA");
  assert.deepEqual(shot.windows, ["index.ts — app"]);
  assert.equal((await once.instance.screenStatus()).state, "inactive", "looking once doesn't start a session");
  await assert.rejects(once.instance.captureScreen({}), /declined/, "the next look asks again");

  const session = harness({ answers: [1] });
  await session.instance.captureScreen({ reason: "watch the build" });
  await session.instance.captureScreen({ reason: "again" });
  assert.equal(session.asked.length, 1, "within a session HANNAH doesn't ask each time");
  assert.equal((await session.instance.screenStatus()).captures, 2);
  await session.instance.pauseScreenSession({ paused: true });
  await assert.rejects(session.instance.captureScreen({}), /paused/);
  await session.instance.pauseScreenSession({ paused: false });
  await session.instance.stopScreenSession();
  assert.deepEqual(session.sessions, ["observing", "paused", "observing", "inactive"], "the tray indicator follows every change");
  assert.equal((await session.instance.screenStatus()).state, "inactive");

  const expiring = harness({ answers: [1, 2] });
  await expiring.instance.captureScreen({});
  expiring.tick(15 * 60_000 + 1);
  assert.equal((await expiring.instance.screenStatus()).state, "inactive", "a session ends after 15 minutes");
  await assert.rejects(expiring.instance.captureScreen({}), /declined/);
});

test("the screen: no macOS permission is an error with the way to fix it, and looks are rate-limited", async () => {
  const blocked = harness({ answers: [1], shot: { permission: "denied" } });
  const original = process.platform;
  await assert.rejects(blocked.instance.captureScreen({}), (error) => error.code === "SCREEN_PERMISSION");
  assert.equal(blocked.asked.length, 0, "with the system permission off, HANNAH says how to turn it on instead of asking");
  assert.equal((await blocked.instance.screenStatus()).state, "inactive", "a session that never got a picture ends");
  assert.equal(original, process.platform);

  // A capture can fail with a bare string, not an Error (Electron does this); the session still ends.
  const throws = harness({ answers: [1], shot: () => { throw "Failed to get sources."; } });
  await assert.rejects(throws.instance.captureScreen({}), (error) => error.code === "SCREEN_PERMISSION" && /couldn't capture/.test(error.message));
  assert.equal((await throws.instance.screenStatus()).state, "inactive", "the session doesn't stay on after a failed capture");
  assert.deepEqual(throws.sessions, ["observing", "inactive"]);

  const busy = harness({ answers: [1] });
  for (let index = 0; index < 12; index += 1) await busy.instance.captureScreen({});
  await assert.rejects(busy.instance.captureScreen({}), /many times this minute/);
});

test("apps: open after a yes (or always), ask about ties, open with a shared folder only", async () => {
  const project = path.join(sandbox, "home", "work", "project");
  await mkdir(project, { recursive: true });
  const apps = [{ id: "/A/Visual Studio Code.app", name: "Visual Studio Code" }, { id: "/A/Visual Studio Code - Insiders.app", name: "Visual Studio Code - Insiders" }, { id: "/A/Google Chrome.app", name: "Google Chrome" }];
  const { instance, asked, launches } = harness({ apps, folder: project, answers: [1, 2] });
  const { folder } = await instance.addFolder({ access: "read" });

  const result = await instance.openApp({ name: "vs code", folderId: folder.id });
  assert.equal(result.verified, true);
  assert.match(result.outcome, /process is running/);
  assert.deepEqual(launches[0], ["Visual Studio Code", await import("node:fs").then((fs) => fs.realpathSync(project))]);
  assert.equal(asked[0].buttons[1], "Always allow opening Visual Studio Code");
  await instance.openApp({ name: "Visual Studio Code" });
  assert.equal(asked.length, 1, "“always” means no dialog next time");

  await assert.rejects(instance.openApp({ name: "Google Chrome" }), /declined/);
  await assert.rejects(instance.openApp({ name: "visual studio" }), /More than one app matches/);
  await assert.rejects(instance.openApp({ name: "Photoshop" }), /No app called/);
  await assert.rejects(instance.openApp({ name: "Google Chrome", folderId: "not-shared" }), /isn't shared/);
  const { allowedApps } = await instance.forgetApp({ id: "/A/Visual Studio Code.app" });
  assert.deepEqual(allowedApps, []);
});

test("startup routine: saved after showing the steps, on only when turned on, runs in order with a history", async () => {
  const apps = [{ id: "/A/Visual Studio Code.app", name: "Visual Studio Code" }];
  const { instance, asked, launches, opened, notes, loginItem } = harness({ apps, answers: [0, 1, 0] });

  await assert.rejects(instance.saveStartupRoutine({ steps: [{ kind: "url", url: "file:///etc/passwd" }] }), /http or https/);
  await assert.rejects(instance.saveStartupRoutine({ steps: [{ kind: "wait", seconds: 999 }] }), /1 to 120/);

  const saved = await instance.saveStartupRoutine({ steps: [{ kind: "wait", seconds: 2 }, { kind: "app", app: { id: "", name: "vs code" } }, { kind: "url", url: "https://mail.google.com" }] });
  assert.match(asked[0].detail, /1\. Wait 2 seconds\n2\. Open Visual Studio Code\n3\. Open https:\/\/mail\.google\.com\//);
  assert.deepEqual(saved.steps.map((step) => step.label), ["Wait 2 seconds", "Open Visual Studio Code", "Open https://mail.google.com/ in your browser"]);
  assert.equal(saved.enabled, false);

  assert.deepEqual(await instance.runStartupRoutine({ trigger: "login" }), { ran: false, reason: "The startup routine is off." });
  assert.equal(launches.length, 0, "nothing runs at login until it's turned on");

  await instance.setStartupEnabled({ enabled: true });
  assert.equal(loginItem(), false, "declining the dialog leaves the login item off");
  const on = await instance.setStartupEnabled({ enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(loginItem(), true);
  assert.match(asked.at(-1).detail, /login items/);

  const run = await instance.runStartupRoutine({ trigger: "login" });
  assert.equal(run.ok, true);
  assert.deepEqual(launches, [["Visual Studio Code", ""]]);
  assert.deepEqual(opened, ["https://mail.google.com/"]);
  assert.equal(notes[0].title, "Startup routine done");
  assert.equal((await instance.startupSettings()).history[0].trigger, "login");

  const off = await instance.setStartupEnabled({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(loginItem(), false, "turning it off removes the login item");
  assert.equal((await instance.runStartupRoutine({ trigger: "login" })).ran, false);
});

test("workflow open step: off unless workflow tasks are on; one dialog lists everything; declined opens nothing; only http(s) links", async () => {
  const project = path.join(sandbox, "home", "work", "startup");
  await mkdir(project, { recursive: true });
  const apps = [{ id: "/A/Visual Studio Code.app", name: "Visual Studio Code" }];
  const { instance, asked, launches, opened, notes } = harness({ apps, folder: project, answers: [0, 0, 1, 0] });
  const { folder } = await instance.addFolder({ access: "read" });
  const request = { workflowName: "Morning startup", app: "Visual Studio Code", folder: folder.name, urls: ["https://github.com/", "https://mail.google.com/"], notify: true };
  await assert.rejects(instance.runWorkflowOpen(request), /Workflow tasks are off/);
  await instance.setWorkflowTasks({ enabled: true }); // answers[0]
  const result = await instance.runWorkflowOpen(request); // answers[1]
  assert.equal(result.approved, true);
  assert.equal(result.ok, true);
  assert.match(asked.at(-1).detail, /1\. Open Visual Studio Code with startup\n2\. Open https:\/\/github.com\/ in your browser\n3\. Open https:\/\/mail.google.com\/ in your browser/);
  assert.equal(launches.length, 1);
  assert.deepEqual(opened, ["https://github.com/", "https://mail.google.com/"]);
  assert.equal(result.steps[1].verified, null, "a link handed to the browser isn't claimed as loaded");
  assert.match(notes.at(-1).body, /✓ Open Visual Studio Code with startup/);

  assert.deepEqual(await instance.runWorkflowOpen(request), { approved: false }); // answers[2]: declined
  assert.equal(launches.length, 1, "declined: nothing opened");
  assert.equal(opened.length, 2);
  await assert.rejects(instance.runWorkflowOpen({ ...request, urls: ["file:///etc/passwd"] }), /Only http and https/);
  await assert.rejects(instance.runWorkflowOpen({ ...request, folder: "not-shared" }), /No folder called/);
  await assert.rejects(instance.runWorkflowOpen({ workflowName: "Empty" }), /nothing to open/);
  assert.deepEqual(await instance.workflowNotify({ workflowName: "W", title: "Done", body: "All set" }), { shown: true });
  assert.deepEqual(notes.at(-1), { title: "Done", body: "All set" });
});

test("Hey HANNAH on the desktop: background listening is switched with the wake word and shown in the menu bar", async () => {
  const calls = [];
  const instance = createDesktopTools({ storePath: path.join(sandbox, `wake-${Math.random()}.json`), confirm: async () => 0, home: path.join(sandbox, "home"), setBackgroundListening: (on) => calls.push(["throttle-off", on]), onWakeListening: (state) => calls.push(["indicator", state.listening]) });
  assert.deepEqual(await instance.setWakeListening({ on: true }), { listening: true, background: true });
  assert.deepEqual(await instance.setWakeListening({ on: false }), { listening: false, background: true });
  assert.deepEqual(calls, [["throttle-off", true], ["indicator", true], ["throttle-off", false], ["indicator", false]]);
});
