"use strict";

/**
 * Operating-system isolation for a cloud computer's terminal commands.
 *
 * A cloud computer's workspace is a directory on this server, and its terminal
 * runs allow-listed programs without a shell. On their own, those programs run
 * as the server's user. A sandbox driver narrows that for every command:
 *
 *   sandbox-exec (macOS)  no network; writes only inside the workspace; the
 *                         other workspaces and the server's own folder can't
 *                         be read
 *   bwrap (Linux)         bubblewrap: new user, process, network, IPC and host
 *                         namespaces; the system folders read-only; the
 *                         workspace the only writable folder and the only one
 *                         of the server's folders it can see; no network
 *
 * HANNAH_WORKFORCE_SANDBOX chooses: "auto" (the default: whichever driver
 * this host has and that passes the check), "off", "sandbox-exec" or "bwrap"
 * (that driver is required: commands are refused if it's missing or fails).
 *
 * Nothing is assumed. Before a driver is used, a check runs a real program
 * under it, with the same rules a command gets, and confirms that writing in
 * the workspace works, while writing outside it, reading another workspace,
 * reading the server's folder and opening a network connection all fail. A
 * driver that fails the check isn't used, and the capabilities say why.
 *
 * This is process isolation in the host's kernel, not a virtual machine. For
 * a VM or microVM boundary, run each computer on a host built for it.
 */
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { fail } = require("./common");

const MODES = new Set(["auto", "off", "sandbox-exec", "bwrap"]);
const PATH_ENV = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function mode() {
  const value = String(process.env.HANNAH_WORKFORCE_SANDBOX || "auto").trim().toLowerCase();
  return MODES.has(value) ? value : "auto";
}

const quote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The macOS sandbox profile for one workspace. Later rules win, so the allows
 * come after the denies. The folders above the workspace allow only their own
 * metadata (programs resolve their paths through them); their listings and
 * every other file in them stay unreadable.
 */
function seatbeltProfile({ workspace, root, hidden = [] }) {
  const ancestors = [];
  for (let dir = path.dirname(workspace); dir !== path.dirname(dir); dir = path.dirname(dir)) ancestors.push(dir);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quote(workspace)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))`,
    `(deny file-read* (subpath ${quote(root)})${hidden.map((dir) => ` (subpath ${quote(dir)})`).join("")})`,
    `(allow file-read-metadata${ancestors.map((dir) => ` (literal ${quote(dir)})`).join("")})`,
    `(allow file-read* (subpath ${quote(workspace)}))`,
  ].join("\n");
}

/** bubblewrap arguments for one workspace, mounted at /workspace. */
function bwrapArgs({ workspace, cwd, program, args, env }) {
  const inside = path.posix.join("/workspace", path.relative(workspace, cwd).split(path.sep).join("/"));
  const nodeHome = path.dirname(path.dirname(process.execPath));
  return [
    "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin", "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/lib32", "/lib32",
    "--ro-bind-try", "/etc/alternatives", "/etc/alternatives", "--ro-bind-try", "/etc/ssl", "/etc/ssl", "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    ...(nodeHome.startsWith("/usr") ? [] : ["--ro-bind-try", nodeHome, nodeHome]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, "/workspace", "--chdir", inside,
    ...Object.entries(env).flatMap(([key, value]) => ["--setenv", key, String(value).replaceAll(workspace, "/workspace")]),
    "--", program, ...args,
  ];
}

const which = (program) => new Promise((resolve) => {
  execFile("/usr/bin/env", ["which", program], { timeout: 3000 }, (error, stdout) => resolve(error ? "" : String(stdout).trim()));
});

function candidates() {
  const chosen = mode();
  if (chosen === "off") return [];
  if (chosen !== "auto") return [chosen];
  if (process.platform === "darwin") return ["sandbox-exec"];
  if (process.platform === "linux") return ["bwrap"];
  return [];
}

/** How a command runs under a driver: the program to start and its arguments. */
async function plan(driver, { workspace, cwd, program, args, env, root, hidden }) {
  if (driver === "sandbox-exec") {
    return { program: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile({ workspace, root, hidden }), program, ...args], cwd, env };
  }
  if (driver === "bwrap") {
    const resolved = program.includes("/") ? program : (await which(program)) || program;
    return { program: "bwrap", args: bwrapArgs({ workspace, cwd, program: resolved, args, env }), cwd: workspace, env: { PATH: PATH_ENV } };
  }
  throw new Error(`Unknown sandbox driver ${driver}.`);
}

function run({ program, args, cwd, env }, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(program, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(error.code || error.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const PROBE = `
const fs = require("fs"), net = require("net");
const [base, port] = process.argv.slice(2);
const result = {};
const attempt = (name, action) => { try { action(); result[name] = "ok"; } catch (error) { result[name] = error.code || "error"; } };
attempt("writeInside", () => fs.writeFileSync("probe.txt", "x"));
attempt("writeOutside", () => fs.writeFileSync(base + "/outside.txt", "x"));
attempt("readOther", () => fs.readFileSync(base + "/root/other/secret.txt"));
attempt("readServer", () => fs.readFileSync(base + "/server/.env"));
attempt("listOthers", () => fs.readdirSync(base + "/root"));
const socket = net.connect(Number(port), "127.0.0.1");
const done = (value) => { result.network = value; console.log(JSON.stringify(result)); process.exit(0); };
socket.on("connect", () => done("ok"));
socket.on("error", (error) => done(error.code || "error"));
setTimeout(() => done("timeout"), 3000);
`;

/** Run the check for one driver. Returns { ok, driver, reason?, checks? }. */
async function probe(driver) {
  if (driver === "sandbox-exec" && process.platform !== "darwin") return { ok: false, driver, reason: "sandbox-exec is macOS only." };
  if (driver === "bwrap" && process.platform !== "linux") return { ok: false, driver, reason: "bubblewrap is Linux only." };
  if (driver === "bwrap" && !(await which("bwrap"))) return { ok: false, driver, reason: "bubblewrap (bwrap) isn't installed on this server." };
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "hannah-sandbox-")));
  const listener = net.createServer((socket) => socket.destroy());
  try {
    const workspace = path.join(base, "root", "mine");
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(path.join(base, "root", "other"), { recursive: true });
    await fsp.mkdir(path.join(base, "server"), { recursive: true });
    await fsp.writeFile(path.join(base, "root", "other", "secret.txt"), "another workspace");
    await fsp.writeFile(path.join(base, "server", ".env"), "SERVER_SECRET=1");
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = listener.address().port;
    // The host's real paths: under bubblewrap they don't exist inside, under sandbox-exec they're denied.
    // Either way the host file below must not appear.
    await fsp.writeFile(path.join(workspace, "probe.js"), PROBE);
    const command = await plan(driver, { workspace, cwd: workspace, program: process.execPath, args: ["probe.js", base, String(port)], env: { PATH: PATH_ENV, HOME: workspace }, root: path.join(base, "root"), hidden: [path.join(base, "server")] });
    const out = await run(command);
    let checks;
    try { checks = JSON.parse(out.stdout.trim().split("\n").pop()); } catch { return { ok: false, driver, reason: `The check couldn't run under ${driver}: ${(out.stderr || "no output").trim().slice(0, 200)}` }; }
    const blocked = (value) => value !== "ok";
    const ok = checks.writeInside === "ok" && blocked(checks.writeOutside) && blocked(checks.readOther) && blocked(checks.readServer) && blocked(checks.listOthers) && blocked(checks.network);
    // Leaving the workspace must be impossible, not merely missing.
    const outsideWritten = await fsp.stat(path.join(base, "outside.txt")).then(() => true, () => false);
    return ok && !outsideWritten
      ? { ok: true, driver, checks }
      : { ok: false, driver, checks, reason: `${driver} didn't hold: ${Object.entries(checks).map(([key, value]) => `${key}=${value}`).join(", ")}` };
  } finally {
    listener.close();
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

let checked = null;

/** The driver in use, from a real check, once per process. */
function status() {
  checked ??= (async () => {
    const chosen = mode();
    if (chosen === "off") return { driver: null, mode: chosen, required: false, reason: "Turned off (HANNAH_WORKFORCE_SANDBOX=off)." };
    const tried = [];
    for (const driver of candidates()) {
      const result = await probe(driver).catch((error) => ({ ok: false, driver, reason: error.message }));
      if (result.ok) return { driver, mode: chosen, required: chosen !== "auto", checks: result.checks };
      tried.push(result.reason);
    }
    return { driver: null, mode: chosen, required: chosen !== "auto", reason: tried.join(" ") || `No sandbox driver for ${process.platform}.` };
  })();
  return checked;
}

/**
 * Wrap one terminal command. Returns how to start it and which driver holds
 * it (null when none is available and none was required). Throws when a
 * required driver isn't working: the command doesn't run unsandboxed.
 */
async function wrap({ workspace, cwd, program, args, env, root, hidden = [] }) {
  const state = await status();
  if (!state.driver) {
    if (state.required) throw fail(503, `This server requires the ${state.mode} sandbox for terminal commands, and it isn't working: ${state.reason}`, "sandbox-unavailable");
    return { program, args, cwd, env, driver: null };
  }
  const real = await fsp.realpath(workspace);
  const realCwd = await fsp.realpath(cwd);
  const realRoot = await fsp.realpath(root).catch(() => root);
  const realHidden = await Promise.all(hidden.map((dir) => fsp.realpath(dir).catch(() => dir)));
  const command = await plan(state.driver, { workspace: real, cwd: realCwd, program, args, env, root: realRoot, hidden: realHidden });
  return { ...command, driver: state.driver };
}

function resetForTests() {
  checked = null;
}

module.exports = { bwrapArgs, mode, probe, resetForTests, seatbeltProfile, status, wrap };
