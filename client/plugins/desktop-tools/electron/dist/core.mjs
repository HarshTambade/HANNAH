// HANNAH desktop files and terminal: the rules, enforced in Electron's main
// process (outside the web page and outside the AI model).
//
// - HANNAH can only touch folders you picked in the system folder dialog.
//   Each folder is read-only or read-write. Every path is resolved (symlinks
//   included) and must stay inside its folder.
// - Writing a file or running a command shows a native confirmation dialog
//   with the exact path or command. Web content can't fake or skip it.
// - Commands run one program directly (no shell, so no pipes, redirects or
//   chaining), inside a granted folder, with a minimal environment, a time
//   limit and capped output. Some programs are never allowed.
//
// No Electron imports here, so the rules can be tested with plain Node.
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fsp, realpathSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { findApps } from "./apps.mjs";

export const LIMITS = Object.freeze({
  readBytes: 256 * 1024,
  writeBytes: 1024 * 1024,
  listEntries: 500,
  outputBytes: 100 * 1024,
  commandMs: 60_000,
  commandLength: 2_000,
  logEntries: 100,
  allowedCommands: 50,
  allowedApps: 50,
  screenSessionMs: 15 * 60_000,
  capturesPerMinute: 12,
  startupSteps: 12,
  startupHistory: 20,
  startupWaitSeconds: 120,
});

/** Programs HANNAH never runs, even with approval. */
const BLOCKED_PROGRAMS = new Set([
  "sudo", "su", "doas", "pkexec", "runas", "gsudo",
  "dd", "mkfs", "fdisk", "diskpart", "format", "diskutil", "parted",
  "shutdown", "reboot", "halt", "poweroff", "init",
  "reg", "regedit", "bcdedit", "launchctl", "systemctl", "crontab", "schtasks",
  "chown", "passwd", "useradd", "userdel", "visudo",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "cmd", "powershell", "pwsh"]);

export class DesktopToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new DesktopToolError(code, message); };

/**
 * Split a command line into a program and arguments, honouring simple quotes.
 * Rejects shell syntax, because commands run without a shell.
 */
export function parseCommand(input) {
  const text = String(input ?? "").trim();
  if (!text) fail("INVALID", "Enter a command to run.");
  if (text.length > LIMITS.commandLength) fail("INVALID", "That command is too long.");
  if (/[\r\n\0]/.test(text)) fail("INVALID", "Run one command on one line.");
  const args = [];
  let current = "";
  let quote = null;
  let hasToken = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; hasToken = true; continue; }
    if (/\s/.test(char)) {
      if (hasToken) { args.push(current); current = ""; hasToken = false; }
      continue;
    }
    if ("|&;<>`$(){}".includes(char)) fail("SHELL_SYNTAX", "Pipes, redirects, variables and chaining aren't supported. HANNAH runs one program without a shell.");
    current += char;
    hasToken = true;
  }
  if (quote) fail("INVALID", "A quote in the command isn't closed.");
  if (hasToken) args.push(current);
  const [program, ...rest] = args;
  const base = path.basename(program).toLowerCase().replace(/\.(exe|com|cmd|bat)$/, "");
  if (BLOCKED_PROGRAMS.has(base) || base.startsWith("mkfs")) fail("BLOCKED", `HANNAH never runs “${base}”. Run it yourself in a terminal if you need it.`);
  if (SHELLS.has(base)) fail("BLOCKED", "HANNAH doesn't start shells. Ask for the program you want to run directly.");
  return { program, args: rest };
}

const TEMP_DIR = (() => {
  try {
    return realpathSync(os.tmpdir());
  } catch {
    return path.resolve(os.tmpdir());
  }
})();

function isSameOrInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Folders that are too broad (or too sensitive) to hand over. Exported for tests. */
export function tooBroad(folder, home = os.homedir(), platform = process.platform) {
  const resolved = path.resolve(folder);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return "the whole drive";
  if (path.resolve(home) === resolved) return "your entire home folder";
  if (isSameOrInside(resolved, path.resolve(home))) return "a folder that contains your home folder";
  const sensitive = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube", "Library/Keychains"].map((item) => path.join(home, item));
  if (sensitive.some((item) => isSameOrInside(item, resolved) || isSameOrInside(resolved, item))) return "a folder with keys or credentials";
  const system = platform === "win32"
    ? ["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]
    : ["/System", "/Library", "/bin", "/sbin", "/usr", "/etc", "/var", "/private", "/boot", "/dev", "/proc", "/sys", "/Applications"];
  // The temp folder lives under /private/var on macOS; scratch work there is fine.
  if (isSameOrInside(TEMP_DIR, resolved) && resolved !== TEMP_DIR) return null;
  if (system.some((item) => isSameOrInside(path.resolve(item), resolved))) return "a system folder";
  return null;
}

function cleanRelative(input) {
  const raw = String(input ?? "").trim().replaceAll("\\", "/");
  if (!raw || raw === ".") return "";
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw) || raw.includes("\0")) fail("OUTSIDE", "Use a path relative to the granted folder.");
  const segments = raw.split("/").filter((part) => part && part !== ".");
  if (segments.some((part) => part === "..")) fail("OUTSIDE", "Paths can't go above the granted folder.");
  return segments.join("/");
}

function minimalEnv(env = process.env, platform = process.platform) {
  const keep = platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "COMSPEC", "LANG"]
    : ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM"];
  const result = {};
  for (const key of keep) if (env[key]) result[key] = env[key];
  // Common install locations GUI apps don't inherit on macOS.
  if (platform === "darwin") result.PATH = [result.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  return result;
}

/**
 * @param {{
 *   storePath: string,
 *   chooseFolder: () => Promise<string | null>,
 *   confirm: (request: { title: string, message: string, detail: string, buttons: string[] }) => Promise<number>,
 *   reveal?: (folder: string) => Promise<void>,
 *   spawn?: typeof nodeSpawn,
 *   now?: () => number,
 *   home?: string,
 *   platform?: NodeJS.Platform,
 * }} deps
 */
/**
 * Where a workflow may send this computer's hidden browser. A workflow is
 * started from the server (possibly by a webhook with someone else's data), so
 * the page it names is untrusted: this machine's own services (loopback),
 * link-local addresses and cloud metadata endpoints are refused outright, and
 * a page on the local network is allowed only after a dialog that says so.
 */
export function classifyAddress(address) {
  const family = net.isIP(address);
  if (!family) return "invalid";
  let ip = address.toLowerCase();
  if (family === 6 && ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0) return "loopback";
    if (a === 169 && b === 254) return "link-local";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
    if (a >= 224) return "reserved";
    return "public";
  }
  if (ip === "::1" || ip === "::") return "loopback";
  if (/^fe[89ab]/.test(ip)) return "link-local";
  if (/^f[cd]/.test(ip)) return "private";
  if (/^ff/.test(ip)) return "reserved";
  return "public";
}

const REFUSED = { loopback: "this computer itself", "link-local": "a link-local address", reserved: "a reserved address", invalid: "an address that couldn't be read" };

/** Check a page address and say where it points. Throws for pages that are never allowed. */
export async function checkPageUrl(input, lookup = (host) => dns.promises.lookup(host, { all: true })) {
  let url;
  try {
    url = new URL(String(input || ""));
  } catch {
    fail("BAD_URL", "That isn't a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("BAD_URL", "Only http and https pages can be opened.");
  if (url.username || url.password) fail("BAD_URL", "Addresses with a user name or password in them aren't opened.");
  if (url.href.length > 2048) fail("BAD_URL", "That address is too long.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") fail("BLOCKED_ADDRESS", "Workflows can't open pages on this computer itself or cloud metadata addresses.");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => fail("DNS", `${host} couldn't be found.`));
  if (!addresses.length) fail("DNS", `${host} couldn't be found.`);
  const kinds = addresses.map((entry) => classifyAddress(entry.address));
  const refused = kinds.find((kind) => REFUSED[kind]);
  if (refused) fail("BLOCKED_ADDRESS", `${host} points to ${REFUSED[refused]}, which workflows can't open.`);
  return { url: url.href, host, localNetwork: kinds.includes("private") };
}

export function createDesktopTools(deps) {
  const spawn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? Date.now;
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await fsp.readFile(deps.storePath, "utf8"));
      cache = {
        workflowTasks: parsed.workflowTasks === true,
        allowedApps: Array.isArray(parsed.allowedApps) ? parsed.allowedApps.filter((item) => item && typeof item.id === "string") : [],
        startup: {
          enabled: parsed.startup?.enabled === true,
          steps: Array.isArray(parsed.startup?.steps) ? parsed.startup.steps : [],
          history: Array.isArray(parsed.startup?.history) ? parsed.startup.history : [],
        },
        folders: Array.isArray(parsed.folders) ? parsed.folders.filter((item) => item && typeof item.id === "string" && typeof item.path === "string") : [],
        allowedCommands: Array.isArray(parsed.allowedCommands) ? parsed.allowedCommands.filter((item) => item && typeof item.command === "string") : [],
        log: Array.isArray(parsed.log) ? parsed.log : [],
      };
    } catch {
      cache = { workflowTasks: false, folders: [], allowedCommands: [], log: [], allowedApps: [], startup: { enabled: false, steps: [], history: [] } };
    }
    return cache;
  }

  // One write at a time, so two saves never race on the same temporary file.
  let saving = Promise.resolve();
  function save() {
    const write = async () => {
      await fsp.mkdir(path.dirname(deps.storePath), { recursive: true });
      const temp = `${deps.storePath}.${process.pid}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(cache, null, 2), { mode: 0o600 });
      await fsp.rename(temp, deps.storePath);
    };
    const next = saving.then(write, write);
    saving = next.catch(() => undefined);
    return next;
  }

  async function record(entry) {
    const state = await load();
    state.log = [{ at: now(), ...entry }, ...state.log].slice(0, LIMITS.logEntries);
    await save();
  }

  async function folderById(id) {
    const state = await load();
    const folder = state.folders.find((item) => item.id === id);
    if (!folder) fail("NO_FOLDER", "That folder isn't shared with HANNAH. Add it in Settings → Desktop access.");
    return folder;
  }

  /** Resolve a relative path inside a granted folder, following symlinks. */
  async function resolveInside(folder, relative, { mustExist = true } = {}) {
    const root = await fsp.realpath(folder.path).catch(() => fail("FOLDER_MISSING", `The folder ${folder.path} no longer exists. Remove it and add it again.`));
    const clean = cleanRelative(relative);
    const target = path.resolve(root, clean);
    if (!isSameOrInside(root, target)) fail("OUTSIDE", "That path is outside the granted folder.");
    let existing = target;
    while (true) {
      try {
        const real = await fsp.realpath(existing);
        if (!isSameOrInside(root, real)) fail("OUTSIDE", "That path leads outside the granted folder through a link.");
        if (existing === target) return { root, target: real, relative: clean, exists: true };
        break;
      } catch (error) {
        if (error instanceof DesktopToolError) throw error;
        if (mustExist) fail("NOT_FOUND", `Nothing exists at “${clean || "."}” in ${folder.name}.`);
        const parent = path.dirname(existing);
        if (parent === existing) fail("OUTSIDE", "That path is outside the granted folder.");
        existing = parent;
      }
    }
    return { root, target, relative: clean, exists: false };
  }

  const publicFolder = (folder) => ({ id: folder.id, name: folder.name, path: folder.path, access: folder.access, addedAt: folder.addedAt });

  // ----- screen: on request, with consent, visibly -----
  // Seeing the screen is separate from acting on it: nothing here clicks or types.
  let screenSession = null; // { startedAt, expiresAt, paused, captures }
  let screenTimer = null;
  let recentCaptures = [];
  const screenState = () => {
    if (screenSession && screenSession.expiresAt <= now()) endScreenSession("expired");
    return screenSession
      ? { state: screenSession.paused ? "paused" : "observing", startedAt: screenSession.startedAt, expiresAt: screenSession.expiresAt, captures: screenSession.captures }
      : { state: "inactive", startedAt: null, expiresAt: null, captures: 0 };
  };
  function endScreenSession(reason) {
    if (!screenSession) return Promise.resolve();
    screenSession = null;
    if (screenTimer) clearTimeout(screenTimer);
    screenTimer = null;
    deps.onScreenSession?.(screenState());
    return record({ kind: "screen-stopped", detail: reason }).catch(() => undefined);
  }

  // ----- apps -----
  let appCache = null;
  async function installedApps({ fresh = false } = {}) {
    if (!deps.apps) fail("UNAVAILABLE", "This build can't open apps.");
    if (!fresh && appCache && appCache.at > now() - 60_000) return appCache.apps;
    appCache = { at: now(), apps: await deps.apps.discover() };
    return appCache.apps;
  }
  async function resolveApp(name) {
    const apps = await installedApps();
    const byId = apps.find((app) => app.id === name);
    if (byId) return byId;
    const matches = findApps(apps, name);
    if (!matches.length) fail("NO_APP", `No app called “${String(name || "").slice(0, 80)}” was found on this computer.`);
    if (matches.length > 1) fail("AMBIGUOUS", `More than one app matches “${String(name).slice(0, 80)}”: ${matches.map((app) => app.name).join(", ")}. Say which one.`);
    return matches[0];
  }
  async function folderPathFor(folderId) {
    if (!folderId) return "";
    const folder = await folderById(String(folderId));
    const { target } = await resolveInside(folder, "");
    return target;
  }
  const publicApp = (app) => ({ id: app.id, name: app.name });
  const describeLaunch = (app, result) => result.alreadyRunning
    ? `${app.name} was already running and was brought forward.`
    : result.verified === true ? `${app.name} is open: its process is running.`
      : result.verified === null ? `${app.name} was asked to open; this system gives HANNAH no way to check it's running.`
        : `${app.name} was asked to open, but no ${app.name} process appeared within 10 seconds.`;

  function cleanStep(step) {
    if (!step || typeof step !== "object") fail("INVALID", "A startup step is missing.");
    if (step.kind === "app") return { kind: "app", app: { id: String(step.app?.id || ""), name: String(step.app?.name || "").slice(0, 120) }, folderId: step.folderId ? String(step.folderId) : "" };
    if (step.kind === "url") {
      let url;
      try { url = new URL(String(step.url || "")); } catch { fail("BAD_URL", "A startup link isn't a web address."); }
      if (url.protocol !== "https:" && url.protocol !== "http:") fail("BAD_URL", "Startup links must be http or https.");
      if (url.username || url.password) fail("BAD_URL", "Startup links can't contain a user name or password.");
      return { kind: "url", url: url.href.slice(0, 2048) };
    }
    if (step.kind === "wait") {
      const seconds = Math.round(Number(step.seconds));
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > LIMITS.startupWaitSeconds) fail("INVALID", `A wait is 1 to ${LIMITS.startupWaitSeconds} seconds.`);
      return { kind: "wait", seconds };
    }
    fail("INVALID", "A startup step is an app, a link or a wait.");
  }
  async function describeStep(step) {
    if (step.kind === "app") {
      const folder = step.folderId ? (await load()).folders.find((item) => item.id === step.folderId) : null;
      return `Open ${step.app.name}${folder ? ` with ${folder.name}` : step.folderId ? " with a folder that's no longer shared" : ""}`;
    }
    if (step.kind === "url") return `Open ${step.url} in your browser`;
    return `Wait ${step.seconds} second${step.seconds === 1 ? "" : "s"}`;
  }

  return {
    async listFolders() {
      const state = await load();
      return { folders: state.folders.map(publicFolder), allowedCommands: state.allowedCommands, platform };
    },

    async addFolder(options = {}) {
      const access = options.access === "read-write" ? "read-write" : "read";
      const chosen = await deps.chooseFolder();
      if (!chosen) return { folder: null };
      const real = await fsp.realpath(chosen);
      const reason = tooBroad(real, home, platform);
      if (reason) fail("TOO_BROAD", `HANNAH can't be given ${reason}. Choose a more specific folder, such as a project folder.`);
      const state = await load();
      const existing = state.folders.find((item) => item.path === real);
      if (existing) return { folder: publicFolder(existing) };
      const folder = { id: randomUUID(), name: path.basename(real) || real, path: real, access, addedAt: now() };
      state.folders.push(folder);
      await record({ kind: "folder-added", folder: folder.name, detail: access });
      return { folder: publicFolder(folder) };
    },

    async removeFolder({ id } = {}) {
      const state = await load();
      const folder = state.folders.find((item) => item.id === id);
      state.folders = state.folders.filter((item) => item.id !== id);
      state.allowedCommands = state.allowedCommands.filter((item) => item.folderId !== id);
      await record({ kind: "folder-removed", folder: folder?.name ?? id });
      return { removed: Boolean(folder) };
    },

    async setAccess({ id, access } = {}) {
      const folder = await folderById(id);
      const next = access === "read-write" ? "read-write" : "read";
      if (next === "read-write" && folder.access !== "read-write") {
        const choice = await deps.confirm({
          title: "Let HANNAH change files?",
          message: `Allow HANNAH to create and change files in “${folder.name}”?`,
          detail: `${folder.path}\n\nYou'll still confirm every file HANNAH writes.`,
          buttons: ["Allow changes", "Cancel"],
        });
        if (choice !== 0) return { folder: publicFolder(folder) };
      }
      folder.access = next;
      await record({ kind: "access-changed", folder: folder.name, detail: next });
      return { folder: publicFolder(folder) };
    },

    async revealFolder({ id } = {}) {
      const folder = await folderById(id);
      await deps.reveal?.(folder.path);
      return {};
    },

    async listDirectory({ folderId, path: relative } = {}) {
      const folder = await folderById(folderId);
      const { target, relative: clean } = await resolveInside(folder, relative);
      const stat = await fsp.stat(target);
      if (!stat.isDirectory()) fail("NOT_DIRECTORY", `“${clean}” is a file, not a folder.`);
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const shown = await Promise.all(entries.slice(0, LIMITS.listEntries).map(async (entry) => {
        let size = null;
        if (entry.isFile()) size = (await fsp.stat(path.join(target, entry.name)).catch(() => null))?.size ?? null;
        return { name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other", size };
      }));
      return { folder: folder.name, path: clean || ".", entries: shown, truncated: entries.length > LIMITS.listEntries, total: entries.length };
    },

    async readFile({ folderId, path: relative } = {}) {
      const folder = await folderById(folderId);
      const { target, relative: clean } = await resolveInside(folder, relative);
      const stat = await fsp.stat(target);
      if (!stat.isFile()) fail("NOT_FILE", `“${clean}” isn't a file.`);
      if (stat.size > LIMITS.readBytes) fail("TOO_LARGE", `“${clean}” is ${Math.round(stat.size / 1024)} KB; HANNAH reads files up to ${LIMITS.readBytes / 1024} KB.`);
      const buffer = await fsp.readFile(target);
      if (buffer.includes(0)) fail("BINARY", `“${clean}” looks like a binary file. HANNAH only reads text.`);
      await record({ kind: "read", folder: folder.name, detail: clean });
      return { folder: folder.name, path: clean, content: buffer.toString("utf8"), bytes: stat.size };
    },

    async writeFile({ folderId, path: relative, content } = {}) {
      const folder = await folderById(folderId);
      if (folder.access !== "read-write") fail("READ_ONLY", `“${folder.name}” is shared read-only. Change it to read-write in Settings → Desktop access first.`);
      if (typeof content !== "string") fail("INVALID", "File content must be text.");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > LIMITS.writeBytes) fail("TOO_LARGE", "HANNAH writes files up to 1 MB.");
      const resolved = await resolveInside(folder, relative, { mustExist: false });
      if (!resolved.relative) fail("INVALID", "Give the file a name.");
      if (resolved.exists && !(await fsp.stat(resolved.target)).isFile()) fail("NOT_FILE", `“${resolved.relative}” is a folder.`);
      const preview = content.split("\n").slice(0, 12).join("\n").slice(0, 800);
      const choice = await deps.confirm({
        title: resolved.exists ? "Replace a file?" : "Create a file?",
        message: `HANNAH wants to ${resolved.exists ? "replace" : "create"} “${resolved.relative}” in ${folder.name} (${bytes.toLocaleString()} bytes).`,
        detail: `${path.join(folder.path, resolved.relative)}\n\n${preview}${content.length > preview.length ? "\n…" : ""}`,
        buttons: [resolved.exists ? "Replace" : "Create", "Cancel"],
      });
      if (choice !== 0) {
        await record({ kind: "write-denied", folder: folder.name, detail: resolved.relative });
        fail("DENIED", "You declined. HANNAH didn't write the file.");
      }
      await fsp.mkdir(path.dirname(resolved.target), { recursive: true });
      // Re-check after creating parents, in case a link appeared meanwhile.
      const parentReal = await fsp.realpath(path.dirname(resolved.target));
      if (!isSameOrInside(resolved.root, parentReal)) fail("OUTSIDE", "That path leads outside the granted folder.");
      await fsp.writeFile(resolved.target, content, "utf8");
      await record({ kind: "write", folder: folder.name, detail: resolved.relative });
      return { folder: folder.name, path: resolved.relative, bytesWritten: bytes, created: !resolved.exists };
    },

    async runCommand({ folderId, path: relative, command } = {}) {
      const folder = await folderById(folderId);
      const { program, args } = parseCommand(command);
      const { target: cwd, relative: clean } = await resolveInside(folder, relative);
      if (!(await fsp.stat(cwd)).isDirectory()) fail("NOT_DIRECTORY", "Commands run in a folder, not a file.");
      const text = String(command).trim();
      const state = await load();
      const preapproved = state.allowedCommands.some((item) => item.folderId === folder.id && item.command === text);
      if (!preapproved) {
        const choice = await deps.confirm({
          title: "Run a command?",
          message: `HANNAH wants to run this command in ${folder.name}${clean ? `/${clean}` : ""}:`,
          detail: `${text}\n\nFolder: ${cwd}\nIt runs without a shell, for up to ${LIMITS.commandMs / 1000} seconds.`,
          buttons: ["Run once", "Always allow this exact command here", "Cancel"],
        });
        if (choice === 2 || choice < 0) {
          await record({ kind: "command-denied", folder: folder.name, detail: text });
          fail("DENIED", "You declined. HANNAH didn't run the command.");
        }
        if (choice === 1) {
          state.allowedCommands = [{ folderId: folder.id, folder: folder.name, command: text, addedAt: now() }, ...state.allowedCommands].slice(0, LIMITS.allowedCommands);
          await save();
        }
      }
      const started = now();
      const result = await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let child;
        try {
          child = spawn(program, args, { cwd, shell: false, windowsHide: true, env: minimalEnv(process.env, platform) });
        } catch (error) {
          resolve({ exitCode: null, stdout: "", stderr: String(error?.message ?? error), truncated: false, timedOut: false });
          return;
        }
        const take = (current, chunk) => {
          const next = current + chunk.toString("utf8");
          if (next.length > LIMITS.outputBytes) { truncated = true; return next.slice(0, LIMITS.outputBytes); }
          return next;
        };
        child.stdout?.on("data", (chunk) => { stdout = take(stdout, chunk); });
        child.stderr?.on("data", (chunk) => { stderr = take(stderr, chunk); });
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, LIMITS.commandMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          const missing = error?.code === "ENOENT";
          resolve({ exitCode: null, stdout, stderr: missing ? `“${program}” wasn't found. Check it's installed and on your PATH.` : String(error?.message ?? error), truncated, timedOut });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code, stdout, stderr, truncated, timedOut });
        });
      });
      await record({ kind: "command", folder: folder.name, detail: text, exitCode: result.exitCode });
      return { folder: folder.name, command: text, cwd: clean || ".", durationMs: now() - started, ...result };
    },

    async forgetCommand({ folderId, command } = {}) {
      const state = await load();
      state.allowedCommands = state.allowedCommands.filter((item) => !(item.folderId === folderId && item.command === command));
      await save();
      return { allowedCommands: state.allowedCommands };
    },

    async recentActivity() {
      const state = await load();
      return { activity: state.log.slice(0, 50) };
    },

    // ----- tasks sent by server workflows -----
    // Off until the person turns it on here (with a native dialog). Even then,
    // every task asks again before it runs, and a coding task's writes and
    // commands keep their own dialogs.

    async workflowTaskSettings() {
      const state = await load();
      return { enabled: state.workflowTasks === true };
    },

    async setWorkflowTasks({ enabled } = {}) {
      const state = await load();
      if (enabled === true && !state.workflowTasks) {
        const choice = await deps.confirm({
          title: "Run workflow tasks",
          message: "Let workflows from your HANNAH account send tasks to this computer?",
          detail: "They can ask to read web pages in a hidden browser window and to run coding tasks in folders you shared. Each task asks you here before it starts, and a coding task still asks before every file change and command. You can turn this off at any time.",
          buttons: ["Allow workflow tasks", "Cancel"],
        });
        if (choice !== 0) return { enabled: false };
      }
      state.workflowTasks = enabled === true;
      await save();
      await record({ kind: enabled === true ? "workflow-tasks-on" : "workflow-tasks-off" });
      return { enabled: state.workflowTasks };
    },

    /** Ask before a workflow's coding task starts. */
    async approveWorkflowTask({ workflowName, summary, folderId } = {}) {
      const state = await load();
      if (!state.workflowTasks) fail("WORKFLOW_TASKS_OFF", "Workflow tasks are off on this computer. Turn on “Run workflow tasks” in Settings → Desktop access.");
      const folder = await folderById(String(folderId || ""));
      const choice = await deps.confirm({
        title: "Workflow task",
        message: `“${String(workflowName || "A workflow").slice(0, 120)}” wants HANNAH's Coding agent to work in ${folder.name}.`,
        detail: `${String(summary || "").slice(0, 1200)}\n\nFile changes and commands will each ask you again.`,
        buttons: ["Start the task", "Decline"],
      });
      await record({ kind: choice === 0 ? "workflow-task-approved" : "workflow-task-declined", folder: folder.name, detail: String(workflowName || "").slice(0, 120) });
      return { approved: choice === 0 };
    },

    /** Read a web page for a workflow: checked, approved here, then opened in a hidden, signed-out window. */
    async readWebPage({ url, waitFor, screenshot, workflowName } = {}) {
      const state = await load();
      if (!state.workflowTasks) fail("WORKFLOW_TASKS_OFF", "Workflow tasks are off on this computer. Turn on “Run workflow tasks” in Settings → Desktop access.");
      if (!deps.loadPage) fail("UNAVAILABLE", "This build can't open pages.");
      const target = await checkPageUrl(url, deps.lookup);
      const choice = await deps.confirm({
        title: "Workflow task",
        message: `“${String(workflowName || "A workflow").slice(0, 120)}” wants to read a web page on this computer.`,
        detail: `${target.url}\n\n${target.localNetwork ? "This address is on your local network, which HANNAH's server can't reach. Open it only if you expect this workflow to read it.\n\n" : ""}It opens in a hidden window with no cookies or sign-ins, and the page's title, text and links go back to the workflow.`,
        buttons: ["Open and read it", "Don't open"],
      });
      if (choice !== 0) {
        await record({ kind: "workflow-page-declined", detail: target.host });
        return { approved: false };
      }
      const page = await deps.loadPage({ url: target.url, waitFor: typeof waitFor === "string" ? waitFor.slice(0, 200) : "", screenshot: screenshot === true });
      await record({ kind: "workflow-page-read", detail: target.host });
      return { approved: true, page };
    },

    // ----- screen -----

    async screenStatus() {
      return { ...screenState(), permission: (await deps.screenPermission?.()) ?? "unknown", platform };
    },

    /**
     * Take one screenshot, for a question the person asked. The first one in
     * a session asks in a system dialog: look once, or allow for 15 minutes
     * (shown by the tray icon, stoppable any time). Nothing is saved here.
     */
    async captureScreen({ reason } = {}) {
      if (!deps.captureScreen) fail("UNAVAILABLE", "This build can't see the screen.");
      const why = String(reason || "answer your question").replace(/\s+/g, " ").trim().slice(0, 200);
      const current = screenState();
      if (current.state === "paused") fail("SCREEN_PAUSED", "Screen viewing is paused. Resume it in the HANNAH menu or Settings → Desktop access.");
      recentCaptures = recentCaptures.filter((at) => at > now() - 60_000);
      if (recentCaptures.length >= LIMITS.capturesPerMinute) fail("TOO_MANY", "HANNAH already looked at the screen many times this minute. Try again shortly.");
      const systemPermission = await deps.screenPermission?.();
      if (systemPermission === "denied" || systemPermission === "restricted") {
        fail("SCREEN_PERMISSION", "macOS hasn't given HANNAH permission to record the screen. Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on HANNAH, then quit and reopen HANNAH.");
      }
      let once = false;
      if (current.state === "inactive") {
        const choice = await deps.confirm({
          title: "Let HANNAH see your screen?",
          message: `HANNAH wants to take a screenshot to ${why}.`,
          detail: "The screenshot goes to your AI model through HANNAH's server to answer you, and isn't saved. HANNAH can only look: she can't click or type.\n\nIf you allow it for 15 minutes, HANNAH's icon in the menu bar or tray shows it, and you can stop at any time.",
          buttons: ["Look once", "Allow for 15 minutes", "Don't allow"],
        });
        if (choice !== 0 && choice !== 1) {
          await record({ kind: "screen-denied", detail: why });
          fail("DENIED", "You declined. HANNAH didn't look at your screen.");
        }
        once = choice === 0;
        if (!once) {
          screenSession = { startedAt: now(), expiresAt: now() + LIMITS.screenSessionMs, paused: false, captures: 0 };
          screenTimer = setTimeout(() => endScreenSession("expired"), LIMITS.screenSessionMs);
          screenTimer.unref?.();
          deps.onScreenSession?.(screenState());
          await record({ kind: "screen-started" });
        }
      }
      let shot;
      try {
        shot = await deps.captureScreen();
      } catch {
        shot = { permission: "unavailable" };
      }
      if (shot?.permission !== "granted" || !shot.image) {
        // A session that never produced a picture ends, so the indicator doesn't stay on.
        if (screenSession?.captures === 0) await endScreenSession("no-permission");
        const blocked = shot?.permission === "denied" || shot?.permission === "restricted" || shot?.permission === "not-determined";
        fail("SCREEN_PERMISSION", platform === "darwin" && blocked
          ? "macOS hasn't given HANNAH permission to record the screen. Open System Settings → Privacy & Security → Screen & System Audio Recording, turn on HANNAH, then quit and reopen HANNAH."
          : "HANNAH couldn't capture the screen on this system.");
      }
      recentCaptures.push(now());
      if (screenSession) screenSession.captures += 1;
      await record({ kind: "screen-captured", detail: why });
      return { image: shot.image, mediaType: shot.mediaType || "image/jpeg", width: shot.width, height: shot.height, windows: Array.isArray(shot.windows) ? shot.windows.slice(0, 20) : [], capturedAt: now(), session: screenState() };
    },

    async pauseScreenSession({ paused } = {}) {
      if (screenSession) {
        screenSession.paused = paused !== false;
        deps.onScreenSession?.(screenState());
        await record({ kind: screenSession.paused ? "screen-paused" : "screen-resumed" });
      }
      return screenState();
    },

    async stopScreenSession() {
      await endScreenSession("stopped");
      return screenState();
    },

    async openScreenSettings() {
      await deps.openScreenSettings?.();
      return {};
    },

    // ----- apps -----

    async listApps({ query } = {}) {
      const apps = await installedApps({ fresh: !query });
      const shown = query ? findApps(apps, query) : apps;
      const state = await load();
      return { apps: shown.slice(0, 300).map(publicApp), total: shown.length, allowedApps: state.allowedApps, platform };
    },

    /** Open an app, optionally with a shared folder. Asks first unless the person said "always" for this app. */
    async openApp({ name, folderId } = {}) {
      const app = await resolveApp(String(name || ""));
      const folder = await folderPathFor(folderId);
      const state = await load();
      if (!state.allowedApps.some((item) => item.id === app.id)) {
        const choice = await deps.confirm({
          title: "Open an app?",
          message: `HANNAH wants to open ${app.name}${folder ? ` with the folder ${path.basename(folder)}` : ""}.`,
          detail: `${app.id}${folder ? `\n\nFolder: ${folder}` : ""}`,
          buttons: ["Open", `Always allow opening ${app.name}`, "Cancel"],
        });
        if (choice !== 0 && choice !== 1) {
          await record({ kind: "app-denied", detail: app.name });
          fail("DENIED", `You declined. HANNAH didn't open ${app.name}.`);
        }
        if (choice === 1) {
          state.allowedApps = [{ id: app.id, name: app.name, addedAt: now() }, ...state.allowedApps].slice(0, LIMITS.allowedApps);
          await save();
        }
      }
      const result = await deps.apps.launch(app, { folder });
      await record({ kind: "app-opened", detail: app.name, verified: result.verified });
      return { app: publicApp(app), folder: folder ? path.basename(folder) : null, ...result, outcome: describeLaunch(app, result) };
    },

    async forgetApp({ id } = {}) {
      const state = await load();
      state.allowedApps = state.allowedApps.filter((item) => item.id !== id);
      await save();
      return { allowedApps: state.allowedApps };
    },

    // ----- startup routine -----
    // HANNAH starts at login only if you turn it on (it's then listed in the
    // system's Login Items or Startup apps). The routine itself is shown in a
    // system dialog before it's saved, then runs without asking at login.

    async startupSettings() {
      const state = await load();
      const steps = await Promise.all(state.startup.steps.map(async (step) => ({ ...step, label: await describeStep(step) })));
      return { enabled: state.startup.enabled, steps, history: state.startup.history, loginItem: (await deps.loginItem?.get()) ?? null };
    },

    async saveStartupRoutine({ steps } = {}) {
      if (!Array.isArray(steps)) fail("INVALID", "The routine needs a list of steps.");
      if (steps.length > LIMITS.startupSteps) fail("INVALID", `A routine has at most ${LIMITS.startupSteps} steps.`);
      const clean = steps.map(cleanStep);
      for (const step of clean) {
        if (step.kind === "app") {
          const app = await resolveApp(step.app.id || step.app.name);
          step.app = publicApp(app);
          if (step.folderId) await folderById(step.folderId);
        }
      }
      if (clean.length) {
        const lines = await Promise.all(clean.map(async (step, index) => `${index + 1}. ${await describeStep(step)}`));
        const choice = await deps.confirm({
          title: "Save your startup routine?",
          message: "When HANNAH starts at login, she'll do this, in order, without asking again:",
          detail: `${lines.join("\n")}\n\nYou can change or turn it off in Settings → Desktop access.`,
          buttons: ["Save", "Cancel"],
        });
        if (choice !== 0) fail("DENIED", "You declined. The startup routine wasn't changed.");
      }
      const state = await load();
      state.startup.steps = clean;
      await save();
      await record({ kind: "startup-saved", detail: `${clean.length} steps` });
      return this.startupSettings();
    },

    async setStartupEnabled({ enabled } = {}) {
      const state = await load();
      if (enabled === true && !state.startup.enabled) {
        const lines = await Promise.all(state.startup.steps.map(describeStep));
        const choice = await deps.confirm({
          title: "Start HANNAH when you sign in?",
          message: "Open HANNAH when you sign in to this computer and run your startup routine?",
          detail: `${lines.length ? lines.map((line, index) => `${index + 1}. ${line}`).join("\n") : "Your routine is empty, so HANNAH will only open."}\n\nHANNAH appears in your system's login items, where you can also remove it.`,
          buttons: ["Turn on", "Cancel"],
        });
        if (choice !== 0) return this.startupSettings();
      }
      await deps.loginItem?.set(enabled === true);
      state.startup.enabled = enabled === true;
      await save();
      await record({ kind: enabled === true ? "startup-on" : "startup-off" });
      return this.startupSettings();
    },

    /**
     * Run the routine: at login (only when turned on) or when the person
     * presses "Run now". Each app is checked to be running; the run is kept
     * in the history with what happened at each step.
     */
    async runStartupRoutine({ trigger } = {}) {
      const state = await load();
      const atLogin = trigger === "login";
      if (atLogin && !state.startup.enabled) return { ran: false, reason: "The startup routine is off." };
      const sleep = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const steps = [];
      for (const step of state.startup.steps) {
        const label = await describeStep(step);
        try {
          if (step.kind === "wait") {
            await sleep(step.seconds * 1000);
            steps.push({ label, ok: true });
          } else if (step.kind === "url") {
            if (!deps.openUrl) fail("UNAVAILABLE", "This build can't open links.");
            await deps.openUrl(step.url);
            steps.push({ label, ok: true, detail: "Handed to your default browser." });
          } else {
            const app = await resolveApp(step.app.id || step.app.name);
            const result = await deps.apps.launch(app, { folder: await folderPathFor(step.folderId) });
            steps.push({ label, ok: result.verified !== false, detail: describeLaunch(app, result) });
          }
        } catch (error) {
          steps.push({ label, ok: false, detail: error instanceof Error ? error.message : String(error) });
        }
      }
      const entry = { at: now(), trigger: atLogin ? "login" : "manual", ok: steps.every((step) => step.ok), steps };
      state.startup.history = [entry, ...state.startup.history].slice(0, LIMITS.startupHistory);
      await save();
      await record({ kind: "startup-ran", detail: `${steps.filter((step) => step.ok).length}/${steps.length} steps` });
      deps.notify?.({ title: entry.ok ? "Startup routine done" : "Startup routine: something didn't work", body: steps.map((step) => `${step.ok ? "✓" : "✗"} ${step.label}`).join("\n") });
      return { ran: true, ...entry };
    },
  };
}

/** Methods the web page may call. Everything else stays in the main process. */
export const BRIDGED_METHODS = Object.freeze([
  "listFolders", "addFolder", "removeFolder", "setAccess", "revealFolder",
  "listDirectory", "readFile", "writeFile", "runCommand", "forgetCommand", "recentActivity",
  "workflowTaskSettings", "setWorkflowTasks", "approveWorkflowTask", "readWebPage",
  "screenStatus", "captureScreen", "pauseScreenSession", "stopScreenSession", "openScreenSettings",
  "listApps", "openApp", "forgetApp",
  "startupSettings", "saveStartupRoutine", "setStartupEnabled", "runStartupRoutine",
]);
