// Rules for computer control (electron/dist/control.mjs), with a stand-in
// adapter that keeps a tiny window: what's checked here is when HANNAH may act,
// what asks first, what's refused, and how actions are verified and recorded.
// The real macOS adapter is exercised by scripts/macos-control-check.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createControlTools, createUnsupportedAdapter, riskyKey } from "./electron/dist/control.mjs";
import { ASK_BEFORE_PRESS, NEVER_PRESS } from "./electron/dist/core.mjs";

function world() {
  const state = {
    trusted: true,
    app: { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 501 },
    title: "Untitled",
    field: "",
    focused: "doc",
    buttons: [{ label: "Send" }, { label: "Pay now" }, { label: "Bold" }],
    secure: false,
    changeNext: null, // make the element at a path something else (the UI changed)
    calls: [],
  };
  const observe = () => ({
    ok: true,
    app: state.app,
    window: { index: 0, title: state.title, frame: { x: 0, y: 0, width: 800, height: 600 } },
    windows: [{ index: 0, title: state.title, minimized: false }],
    focused: state.focused === "doc" ? { role: "AXTextArea", label: "Document" } : { role: "AXButton", label: state.focused },
    dialogs: [], errors: [], text: state.field,
    elements: [
      { path: "0.1", role: "AXTextArea", label: "Document", value: state.field, focused: state.focused === "doc", frame: { x: 10, y: 50, width: 700, height: 500 } },
      ...state.buttons.map((button, index) => ({ path: `0.2.${index}`, role: "AXButton", label: button.label, actions: ["AXPress"], frame: { x: 10 + index * 60, y: 10, width: 50, height: 20 } })),
      { path: "0.3", role: "AXSecureTextField", secure: true, frame: { x: 600, y: 10, width: 100, height: 20 } },
    ],
    fingerprint: `${state.title}|${state.field}|${state.focused}`,
  });
  const adapter = {
    platform: "darwin",
    available: true,
    status: async () => ({ accessibility: state.trusted, screenRecording: true, frontmost: state.app }),
    requestAccess: async () => ({ accessibility: state.trusted }),
    observe: async () => observe(),
    frontmost: async () => observe(),
    running: async () => ({ apps: [state.app, { name: "Terminal", bundleId: "com.apple.Terminal", pid: 502, active: false }, { name: "1Password", bundleId: "com.1password.1password", pid: 503 }] }),
    activate: async ({ pid }) => ({ frontmost: pid === state.app.pid }),
    quit: async () => ({}),
    window: async () => ({ windows: [{ index: 0, title: state.title, minimized: false }] }),
    act: async (command, options) => {
      state.calls.push({ command, options });
      if (state.changeNext) { const error = new Error(state.changeNext); error.code = "CHANGED"; state.changeNext = null; throw error; }
      if (command === "set-value") state.field = options.value;
      if (command === "type") state.field += options.text;
      if (command === "focus") state.focused = "doc";
      // Pressing "Bold" changes nothing visible in this stand-in.
      return { ok: true };
    },
  };
  return { state, adapter };
}

function setup({ answers = [], platformAdapter, storePath, confirm } = {}) {
  const { state, adapter } = world();
  const dialogs = [];
  const log = [];
  let clock = 1_000_000;
  const tools = createControlTools({
    adapter: platformAdapter || adapter,
    confirm: async (request) => { dialogs.push(request); return confirm ? confirm(request) : answers.length ? answers.shift() : 0; },
    record: async (entry) => { log.push(entry); },
    storePath,
    ownPid: 999,
    neverPress: NEVER_PRESS,
    askBeforePress: ASK_BEFORE_PRESS,
    now: () => clock,
    sleep: async () => {},
  });
  return { tools, state, dialogs, log, tick: (ms) => { clock += ms; } };
}

test("nothing happens without a session the person started; declining or missing permission stops it", async () => {
  const { tools, state, dialogs } = setup({ answers: [1] });
  await assert.rejects(tools.observeScreen({}), { code: "NO_SESSION" });
  await assert.rejects(tools.startControl({ reason: "edit my note" }), { code: "DENIED" });
  assert.match(dialogs[0].detail, /never types passwords/);
  state.trusted = false;
  await assert.rejects(tools.startControl({ reason: "edit my note" }), { code: "ACCESSIBILITY_PERMISSION" });
  assert.equal((await tools.controlStatus()).session.state, "inactive");
});

test("acts only on the latest, fresh observation, with the observed element's identity checked by the adapter", async () => {
  const { tools, state, tick } = setup();
  await tools.startControl({ reason: "write a note" });
  const task = await tools.startControlTask({ request: "Write hello in TextEdit", plan: ["observe", "set text", "verify"] });
  const seen = await tools.observeScreen({ taskId: task.id });
  assert.equal(seen.app.name, "TextEdit");
  assert.ok(seen.elements.some((element) => element.secure && element.value === undefined), "password fields are listed without a value");
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: "old", action: "press", path: "0.2.2" }), { code: "STALE" });
  tick(31_000);
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: "0.2.2" }), { code: "STALE" });
  const fresh = await tools.observeScreen({ taskId: task.id });
  // The model can't name a different element: the expectation comes from the observation.
  await tools.controlAct({ taskId: task.id, observationId: fresh.observationId, action: "press", path: "0.2.2", expect: { role: "AXWindow", label: "anything" } });
  assert.deepEqual(state.calls.at(-1).options.expect, { role: "AXButton", label: "Bold" });
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: (await tools.observeScreen({})).observationId, action: "press", path: "9.9" }), { code: "NO_ELEMENT" });
  // The interface changed between looking and acting: stop, recorded as failed.
  state.changeNext = "The interface changed.";
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: (await tools.observeScreen({})).observationId, action: "press", path: "0.2.2" }), { code: "CHANGED" });
  const { tasks } = await tools.controlTasks();
  assert.equal(tasks[0].actions.at(-1).status, "failed");
});

test("an action is confirmed only by the app's new state; a task completes only after a confirmed action", async () => {
  const { tools } = setup();
  await tools.startControl({ reason: "write a note" });
  const task = await tools.startControlTask({ request: "Write hello", plan: ["set text"] });
  let seen = await tools.observeScreen({ taskId: task.id });
  const pressed = await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: "0.2.2" });
  assert.equal(pressed.status, "action-attempted", "nothing changed, so it isn't confirmed");
  await assert.rejects(tools.finishControlTask({ taskId: task.id, status: "completed" }), { code: "UNVERIFIED" });
  seen = await tools.observeScreen({ taskId: task.id });
  const set = await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "set-value", path: "0.1", text: "hello" });
  assert.equal(set.status, "action-confirmed");
  assert.match(set.verification.evidence, /holds the text/);
  assert.ok(set.observationId && set.observationId !== seen.observationId, "a fresh observation comes back");
  const done = await tools.finishControlTask({ taskId: task.id, status: "completed", summary: "The document says hello." });
  assert.equal(done.status, "completed");
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: set.observationId, action: "press", path: "0.2.2" }), { code: "TASK_FINISHED" });
});

test("asks before sending, refuses paying and password fields, asks once per app before typing, every time in a terminal", async () => {
  // Answers: start the session, allow the first Send, decline the second.
  const { tools, state, dialogs } = setup({ answers: [0, 0, 1] });
  await tools.startControl({ reason: "reply" });
  const task = await tools.startControlTask({ request: "Reply", plan: ["send"] });
  let seen = await tools.observeScreen({ taskId: task.id });
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: "0.2.1" }), { code: "REFUSED" }, "Pay now is never pressed");
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "set-value", path: "0.3", text: "hunter2" }), { code: "SECURE_FIELD" });
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "click", x: 650, y: 20 }), { code: "SECURE_FIELD" }, "a click on a password field is refused too");
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "click", x: 5000, y: 20 }), { code: "OUTSIDE_WINDOW" });
  // "Send" asks: the first answer (0) allows it, the second (1) declines.
  const before = dialogs.length;
  await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: "0.2.0" });
  assert.match(dialogs[before].detail, /send, delete/);
  seen = await tools.observeScreen({ taskId: task.id });
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: "0.2.0" }), { code: "DENIED" });
  assert.equal((await tools.controlTasks()).tasks[0].actions.at(-1).status, "denied");
  // Typing: asked once for TextEdit, then not again.
  seen = await tools.observeScreen({ taskId: task.id });
  const asked = dialogs.length;
  await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "type", text: "hi" });
  seen = await tools.observeScreen({ taskId: task.id });
  await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "type", text: " there" });
  assert.equal(dialogs.length, asked + 1);
  assert.equal(state.field, "hi there");
  // In a terminal every action asks.
  state.app = { name: "Terminal", bundleId: "com.apple.Terminal", pid: 502 };
  seen = await tools.observeScreen({ taskId: task.id });
  const terminalAsked = dialogs.length;
  await tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "key", key: "return" });
  assert.equal(dialogs.length, terminalAsked + 1);
  assert.match(dialogs.at(-1).detail, /can run commands/);
});

test("never HANNAH's own windows, security prompts or password managers", async () => {
  const { tools, state } = setup();
  await tools.startControl({ reason: "help" });
  state.app = { name: "HANNAH", bundleId: "com.hannah.companion", pid: 999 };
  await assert.rejects(tools.observeScreen({}), { code: "REFUSED_APP" });
  state.app = { name: "SecurityAgent", bundleId: "com.apple.SecurityAgent", pid: 77 };
  await assert.rejects(tools.observeScreen({}), { code: "REFUSED_APP" });
  await assert.rejects(tools.focusApp({ app: "1Password" }), { code: "REFUSED_APP" });
  assert.ok(!(await tools.runningApps()).apps.some((app) => app.name === "1Password"));
});

test("coordinates and keys go nowhere if the app in front changed since HANNAH looked", async () => {
  const { tools, state } = setup();
  await tools.startControl({ reason: "help" });
  const task = await tools.startControlTask({ request: "Bold", plan: ["click"] });
  const seen = await tools.observeScreen({ taskId: task.id });
  state.title = "Another document";
  const callsBefore = state.calls.length;
  await assert.rejects(tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "click", x: 135, y: 15 }), { code: "CHANGED" });
  assert.equal(state.calls.length, callsBefore, "nothing was clicked");
});

test("keys that quit, close or delete ask; signing out and Force Quit are refused", () => {
  assert.deepEqual(riskyKey("q", ["cmd"]), { ask: true, why: "quits the app" });
  assert.deepEqual(riskyKey("w", ["command"]), { ask: true, why: "closes the window or tab" });
  assert.equal(riskyKey("q", ["cmd", "shift"]).refuse, true);
  assert.equal(riskyKey("escape", ["cmd", "option"]).refuse, true);
  assert.equal(riskyKey("s", ["cmd"]), null);
});

test("the emergency stop ends control, cancels the task, and drops an action waiting for approval", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hannah-control-"));
  const storePath = path.join(dir, "control-tasks.json");
  // The "Send" approval stays open until the test answers it.
  let answerSend = null;
  const { tools, state, log } = setup({ storePath, confirm: (request) => (request.title === "Let HANNAH do this?" ? new Promise((resolve) => { answerSend = resolve; }) : 0) });
  await tools.startControl({ reason: "send a message" });
  const task = await tools.startControlTask({ request: "Send it", plan: ["press Send"] });
  const seen = await tools.observeScreen({ taskId: task.id });
  const pending = tools.controlAct({ taskId: task.id, observationId: seen.observationId, action: "press", path: "0.2.0" });
  while (!answerSend) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await tools.controlTasks()).tasks[0].status, "waiting-approval");
  // Stop while the dialog is open: even a yes afterwards doesn't act.
  await tools.stopControl({ emergency: true });
  answerSend(0);
  await assert.rejects(pending, { code: "STOPPED" });
  assert.ok(!state.calls.some((call) => call.command === "press"), "nothing was pressed");
  const saved = JSON.parse(readFileSync(storePath, "utf8")).tasks[0];
  assert.equal(saved.status, "cancelled");
  assert.match(saved.failure, /emergency stop/);
  assert.ok(log.some((entry) => entry.kind === "control-stopped" && entry.detail === "emergency-stop"));
  await assert.rejects(tools.observeScreen({}), { code: "NO_SESSION" });
});

test("Windows and Linux say control isn't built yet instead of pretending", async () => {
  for (const platform of ["win32", "linux"]) {
    const { tools } = setup({ platformAdapter: createUnsupportedAdapter(platform) });
    const status = await tools.controlStatus();
    assert.equal(status.available, false);
    assert.match(status.reason, platform === "win32" ? /UI Automation/ : /AT-SPI/);
    await assert.rejects(tools.startControl({ reason: "x" }), { code: "UNSUPPORTED" });
  }
});
