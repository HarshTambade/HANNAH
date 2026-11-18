#!/usr/bin/env node
/**
 * Computer control on a real Mac, end to end: the real helper
 * (native/macos-control), the real rules (plugins/desktop-tools/electron/dist/control.mjs),
 * real apps. Nothing is simulated; approvals are answered "yes" by this script
 * (in the app they're system dialogs).
 *
 *   node scripts/macos-control-check.mjs            TextEdit checks
 *   node scripts/macos-control-check.mjs --vscode   also "open VS Code with my project"
 *
 * Needs Accessibility permission for the app running this script (Terminal,
 * VS Code …): System Settings → Privacy & Security → Accessibility. Without it,
 * it checks that every action is refused with the permission message, and
 * exits with code 2 (blocked). It takes the focus for about 20 seconds: don't type meanwhile.
 *
 * TextEdit: opens a new temporary file, reads its window (accessibility tree),
 * puts text in it with set-value (verified), types more with real key events
 * (verified), saves with Cmd+S, and checks the file on disk; clicks and
 * scrolls; minimizes and restores the window; checks that a stale observation
 * and the emergency stop are enforced; then quits TextEdit (verified).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createControlTools, createMacAdapter } from "../plugins/desktop-tools/electron/dist/control.mjs";
import { createAppLauncher } from "../plugins/desktop-tools/electron/dist/apps.mjs";
import { ASK_BEFORE_PRESS, NEVER_PRESS } from "../plugins/desktop-tools/electron/dist/core.mjs";

if (process.platform !== "darwin") { console.log("This check runs on macOS."); process.exit(0); }
const clientRoot = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "hannah-control-check-"));
const helperPath = join(work, "hannah-control");
execFileSync(process.execPath, [join(clientRoot, "scripts", "build-macos-control.mjs"), helperPath], { stdio: "ignore" });

const results = [];
const check = (name, ok, evidence) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${evidence}`); };
const dialogs = [];
const adapter = createMacAdapter({ helperPath });
const tools = createControlTools({ adapter, confirm: async (request) => { dialogs.push(request.title); return 0; }, record: async () => {}, ownPid: process.pid, neverPress: NEVER_PRESS, askBeforePress: ASK_BEFORE_PRESS, storePath: join(work, "control-tasks.json") });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let exitCode = 0;
try {
  const status = await tools.controlStatus();
  console.log(`Accessibility: ${status.accessibility ? "on" : "off"}; Screen Recording: ${status.screenRecording ? "on" : "off"}; in front: ${status.frontmost?.name}`);
  if (!status.accessibility) {
    const refused = await tools.startControl({ reason: "check" }).then(() => null, (error) => error);
    check("without Accessibility permission, control refuses to start and says how to turn it on", refused?.code === "ACCESSIBILITY_PERMISSION", refused?.message);
    const direct = await adapter.act("click", { x: 10, y: 10 }).then(() => null, (error) => error);
    check("the helper itself refuses to post mouse events without the permission", direct?.code === "ACCESSIBILITY_PERMISSION", direct?.message);
    console.log("\nBLOCKED: turn on Accessibility for this terminal or editor, then run this again for the full check.");
    exitCode = 2;
  } else {
    await tools.startControl({ reason: "run HANNAH's macOS control check" });
    const task = await tools.startControlTask({ request: "macOS control check in TextEdit", plan: ["open a temporary file", "set text", "type", "save", "check the file", "window", "quit"] });
    const file = join(work, "hannah-check.txt");
    writeFileSync(file, "");
    execFileSync("open", ["-a", "TextEdit", file]);
    let seen;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(500);
      seen = await tools.observeScreen({ taskId: task.id, app: "TextEdit" }).catch(() => null);
      if (seen?.window?.title?.includes("hannah-check")) break;
    }
    check("observe: TextEdit's window and its text area are read from the accessibility tree", seen?.app?.name === "TextEdit" && seen.window?.title.includes("hannah-check") && seen.elements.some((element) => element.role === "TextArea"),
      `${seen?.app?.name} — “${seen?.window?.title}”, ${seen?.elements?.length} elements, roles: ${[...new Set((seen?.elements || []).map((element) => element.role))].slice(0, 12).join(", ")}`);
    await tools.focusApp({ app: "TextEdit", taskId: task.id });
    seen = await tools.observeScreen({ taskId: task.id });
    const area = seen.elements.find((element) => element.role === "TextArea");
    const set = await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "set-value", path: area.path, text: "Hello from HANNAH." });
    check("set-value: the text is put in the field and confirmed by reading it back", set.status === "action-confirmed", `${set.status}: ${set.verification?.evidence}`);
    const click = await tools.controlAct({ taskId: task.id, observationId: set.observationId, action: "click", x: area.frame.x + area.frame.width - 20, y: area.frame.y + 20 });
    check("click: a real mouse click at the text area's position (focus lands in the document)", ["action-confirmed", "action-attempted"].includes(click.status) && click.focused?.role === "AXTextArea", `${click.status}: focus ${click.focused?.role}; ${click.verification?.evidence}`);
    const end = await tools.controlAct({ taskId: task.id, observationId: click.observationId, action: "key", key: "end", modifiers: ["cmd"] });
    const typed = await tools.controlAct({ taskId: task.id, observationId: end.observationId, action: "type", text: " Typed with real key events." });
    check("type: real key events, confirmed by the field's new value", typed.status === "action-confirmed" && typed.elements.find((element) => element.role === "TextArea")?.value?.includes("Typed with real key events."), `${typed.status}: ${typed.verification?.evidence}`);
    const saved = await tools.controlAct({ taskId: task.id, observationId: typed.observationId, action: "key", key: "s", modifiers: ["cmd"] });
    await sleep(1000);
    const onDisk = readFileSync(file, "utf8");
    check("keyboard shortcut: Cmd+S saved the document; the file on disk has both texts", onDisk.includes("Hello from HANNAH.") && onDisk.includes("Typed with real key events."), `${saved.status}; file: ${JSON.stringify(onDisk.slice(0, 80))}`);
    const scrolled = await tools.controlAct({ taskId: task.id, observationId: saved.observationId, action: "scroll", dy: -3, x: area.frame.x + 50, y: area.frame.y + 50 });
    check("scroll: a real scroll-wheel event is posted inside the window", ["action-confirmed", "action-attempted"].includes(scrolled.status), `${scrolled.status}: ${scrolled.verification?.evidence} (a short document may not move)`);
    const minimized = await tools.controlWindow({ app: "TextEdit", action: "minimize", taskId: task.id });
    const restored = await tools.controlWindow({ app: "TextEdit", action: "restore", taskId: task.id });
    check("windows: minimize and restore, each confirmed by the window's state", minimized.confirmed && restored.confirmed, `minimize ${minimized.confirmed}, restore ${restored.confirmed}`);
    // Safeguards on the real system.
    const stale = await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: area.path }).then(() => null, (error) => error);
    check("an old observation can't be acted on", stale?.code === "STALE", stale?.message);
    const quit = await tools.quitApp({ app: "TextEdit", taskId: task.id });
    check("quit: TextEdit quits (it was saved, so it doesn't ask), confirmed by the process list", quit.quit === true, JSON.stringify(quit));
    const finished = await tools.finishControlTask({ taskId: task.id, status: "completed", summary: "TextEdit check finished; the file on disk has the text." });
    check("the task record has every action with its verification", finished.status === "completed" && finished.actions.filter((step) => step.kind === "action").length >= 8, `${finished.actions.length} steps; ${finished.actions.filter((step) => step.status === "action-confirmed").length} confirmed`);
    await tools.stopControl({ emergency: true });
    const after = await tools.observeScreen({}).then(() => null, (error) => error);
    check("after the emergency stop nothing more can be done", after?.code === "NO_SESSION", after?.message);

    if (process.argv.includes("--vscode")) {
      const project = join(work, "hannah-project-check");
      execFileSync("mkdir", ["-p", project]);
      writeFileSync(join(project, "README.md"), "# HANNAH project check\n");
      const launcher = createAppLauncher({ platform: "darwin", home: process.env.HOME });
      const apps = await launcher.discover();
      const code = apps.find((app) => app.name === "Visual Studio Code");
      if (!code) check("Test A: VS Code is installed", false, "Visual Studio Code wasn't found in the Applications folders.");
      else {
        const launch = await launcher.launch(code, { folder: project });
        const shown = await tools.waitForWindow({ appName: "Code", text: "hannah-project-check" });
        check("Test A: VS Code opens the project, confirmed by a window titled with the folder", launch.verified !== false && shown.found, `launch verified ${launch.verified}; window: ${shown.windowTitle || JSON.stringify(shown.windowTitles)}`);
      }
    }
  }
} catch (error) {
  check("the check ran to the end", false, error.stack || error.message);
} finally {
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
process.exit(failed.length ? 1 : exitCode);
