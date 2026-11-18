// Apps on this computer, for "open VS Code" and startup routines.
//
// - Found only from the platform's own launcher records: .app bundles in the
//   Applications folders (macOS), Start menu shortcuts (Windows), and
//   .desktop entries in the XDG application folders (Linux).
// - Opened without a shell: `open -a` on macOS, the shortcut itself on
//   Windows, the entry's Exec line split into a program and arguments on Linux.
// - Checked afterwards by looking for the app's process, so HANNAH reports
//   "opened" only when it's actually running.
//
// No Electron imports here; Windows shortcut reading and opening are passed in.
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

const MAX_APPS = 2_000;

/** Where each platform keeps its launchers, in precedence order. */
export function appRoots(platform, home, env = {}) {
  if (platform === "darwin") {
    return ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", path.join(home, "Applications")];
  }
  if (platform === "win32") {
    const programData = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"), path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs")];
  }
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = String(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [dataHome, ...dataDirs, path.join(home, ".local", "share", "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"]
    .map((dir) => path.join(dir, "applications"));
}

/** The [Desktop Entry] group of a .desktop file (unlocalized keys only). Exported for tests. */
export function parseDesktopEntry(text) {
  const entry = {};
  let inGroup = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { inGroup = line === "[Desktop Entry]"; continue; }
    if (!inGroup) continue;
    const at = line.indexOf("=");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    if (key.includes("[")) continue;
    entry[key] = line.slice(at + 1).trim();
  }
  return entry;
}

/**
 * Split a desktop entry's Exec value into a program and arguments, per the
 * Desktop Entry spec: quoted arguments, escapes, and field codes. %f/%F/%u/%U
 * become the folder to open (if any); other field codes are dropped.
 */
export function parseExec(exec, folder = "") {
  const args = [];
  let current = "";
  let quoted = false;
  let hasToken = false;
  const text = String(exec || "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\\" && index + 1 < text.length) { current += text[index + 1]; index += 1; continue; }
      if (char === '"') { quoted = false; continue; }
      current += char;
      continue;
    }
    if (char === '"') { quoted = true; hasToken = true; continue; }
    if (/\s/.test(char)) {
      if (hasToken) { args.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) args.push(current);
  const out = [];
  let folderUsed = false;
  for (const arg of args) {
    if (/^%[fFuU]$/.test(arg)) {
      if (folder && !folderUsed) { out.push(folder); folderUsed = true; }
      continue;
    }
    if (/^%[a-zA-Z]$/.test(arg)) continue;
    out.push(arg.replace(/%%/g, "%"));
  }
  const [program, ...rest] = out;
  return { program: program || "", args: rest, acceptsFolder: folderUsed };
}

const SKIP_SHORTCUT = /\b(uninstall|readme|read me|help|documentation|release notes|license|website|support)\b/i;

async function walk(root, { depth, match }) {
  const found = [];
  const visit = async (dir, level) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_APPS) return;
      const full = path.join(dir, entry.name);
      if (match(entry)) { found.push(full); continue; }
      if (entry.isDirectory() && level < depth) await visit(full, level + 1);
    }
  };
  await visit(root, 0);
  return found;
}

/** Find launchable apps. Each has a stable id (its launcher path), a name and a platform kind. */
export async function discoverApps({ platform, home, env = {}, roots = appRoots(platform, home, env) }) {
  const apps = new Map();
  for (const root of roots) {
    if (platform === "darwin") {
      for (const bundle of await walk(root, { depth: 1, match: (entry) => entry.name.endsWith(".app") })) {
        const name = path.basename(bundle, ".app");
        if (!apps.has(name.toLowerCase())) apps.set(name.toLowerCase(), { id: bundle, name, kind: "bundle" });
      }
    } else if (platform === "win32") {
      for (const link of await walk(root, { depth: 3, match: (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lnk") })) {
        const name = path.basename(link).replace(/\.lnk$/i, "");
        if (SKIP_SHORTCUT.test(name) || apps.has(name.toLowerCase())) continue;
        apps.set(name.toLowerCase(), { id: link, name, kind: "shortcut" });
      }
    } else {
      for (const file of await walk(root, { depth: 2, match: (entry) => entry.isFile() && entry.name.endsWith(".desktop") })) {
        const desktopId = path.relative(root, file).split(path.sep).join("-");
        const entry = parseDesktopEntry(await fsp.readFile(file, "utf8").catch(() => ""));
        if (entry.Type !== "Application" || !entry.Name || !entry.Exec || entry.NoDisplay === "true" || entry.Hidden === "true" || entry.Terminal === "true") continue;
        if ([...apps.values()].some((app) => app.desktopId === desktopId)) continue;
        const key = entry.Name.toLowerCase();
        if (apps.has(key)) continue;
        apps.set(key, { id: file, name: entry.Name, kind: "desktop-entry", desktopId, exec: entry.Exec });
      }
    }
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const ALIASES = {
  "vs code": "visual studio code", vscode: "visual studio code", code: "visual studio code",
  chrome: "google chrome", "google chrome": "google chrome", edge: "microsoft edge",
  word: "microsoft word", excel: "microsoft excel", powerpoint: "microsoft powerpoint", outlook: "microsoft outlook", teams: "microsoft teams",
  terminal: "terminal", files: "files", explorer: "file explorer", settings: "system settings",
};

/**
 * Match what someone said ("vs code", "chrome") to installed apps. Returns
 * the best matches; more than one means HANNAH should ask which.
 */
export function findApps(apps, query) {
  const wanted = String(query || "").toLowerCase().replace(/\.app$/, "").replace(/\s+/g, " ").trim();
  if (!wanted) return [];
  const target = ALIASES[wanted] || wanted;
  const name = (app) => app.name.toLowerCase();
  const exact = apps.filter((app) => name(app) === target || name(app) === wanted);
  if (exact.length) return exact;
  const prefix = apps.filter((app) => name(app).startsWith(target));
  if (prefix.length) return prefix.slice(0, 8);
  const words = target.split(" ");
  return apps.filter((app) => words.every((word) => name(app).includes(word))).slice(0, 8);
}

/** "  123 /path/to/program --flag" → { pid, program: "/path/to/program --flag" }. Exported for tests. */
export function parsePs(line) {
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  return match ? { pid: Number(match[1]), program: match[2].trim() } : null;
}

/** A tasklist CSV row: "Code.exe","1234",... → { pid, program: "Code.exe" }. Exported for tests. */
export function parseTasklist(line) {
  const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
  return match ? { pid: Number(match[2]), program: match[1] } : null;
}

function run(execFile, program, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(program, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || ""), error });
    });
  });
}

/**
 * Open apps and check they're running. `deps.readShortcut` and `deps.openPath`
 * come from Electron's shell on Windows.
 */
export function createAppLauncher({ platform, home, env = {}, execFile = nodeExecFile, spawn = nodeSpawn, readShortcut, openPath, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), checks = 20, checkEveryMs = 500 } = {}) {
  /**
   * How to find this app's processes: a process-list command, and a test on
   * each process's program. Each line is parsed to { pid, program }.
   */
  function processMatcher(app) {
    if (platform === "darwin") {
      const inside = `${app.id}/Contents/`;
      return { list: ["ps", ["-axo", "pid=,comm="]], parse: parsePs, test: (program) => program.startsWith(inside) };
    }
    if (platform === "win32") {
      let target = "";
      try { target = readShortcut?.(app.id)?.target || ""; } catch { target = ""; }
      if (!target || !/\.exe$/i.test(target)) return null;
      const image = path.win32.basename(target).toLowerCase();
      return { list: ["tasklist", ["/FO", "CSV", "/NH"]], parse: parseTasklist, test: (program) => program.toLowerCase() === image };
    }
    const { program, args } = parseExec(app.exec);
    if (!program) return null;
    const flatpak = path.basename(program) === "flatpak" ? args.find((arg) => /^[\w-]+(\.[\w-]+){2,}$/.test(arg)) : null;
    const binary = path.basename(program);
    // The program is the first word of each command line; for Flatpak apps, the app id anywhere in it.
    return { list: ["ps", ["-eo", "pid=,args="]], parse: parsePs, test: (line) => (flatpak ? line.includes(flatpak) : path.basename(line.split(/\s+/)[0] || "") === binary) };
  }

  /** The matching process ids, or null when the process list can't be read. */
  async function matchingPids(matcher) {
    if (!matcher) return null;
    const result = await run(execFile, ...matcher.list);
    if (!result.ok) return null;
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const entry = matcher.parse(line);
      if (entry && matcher.test(entry.program)) pids.add(entry.pid);
    }
    return pids;
  }

  async function start(app, folder) {
    if (platform === "darwin") {
      const result = await run(execFile, "open", ["-a", app.id, ...(folder ? [folder] : [])]);
      if (!result.ok) throw new Error(result.stderr.trim() || `macOS couldn't open ${app.name}.`);
      return;
    }
    if (platform === "win32") {
      let target = "";
      try { target = readShortcut?.(app.id)?.target || ""; } catch { target = ""; }
      if (folder && target && /\.exe$/i.test(target)) {
        spawn(target, [folder], { detached: true, stdio: "ignore", shell: false, windowsHide: false }).unref();
        return;
      }
      if (!openPath) throw new Error("This build can't open Windows shortcuts.");
      const error = await openPath(app.id);
      if (error) throw new Error(error);
      return;
    }
    const { program, args } = parseExec(app.exec, folder);
    if (!program) throw new Error(`${app.name}'s launcher has no program to run.`);
    await new Promise((resolve, reject) => {
      const child = spawn(program, args, { detached: true, stdio: "ignore", shell: false, cwd: home });
      child.once("error", (error) => reject(error?.code === "ENOENT" ? new Error(`${program} isn't installed or isn't on the PATH.`) : error));
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }

  return {
    discover: () => discoverApps({ platform, home, env }),
    /**
     * Open an app (optionally with a folder) and check its process appears.
     * `verified` is true only when the process was seen; null means this
     * platform gave no way to check (for example a Windows shortcut without a target).
     */
    async launch(app, { folder = "" } = {}) {
      const matcher = processMatcher(app);
      const before = await matchingPids(matcher);
      await start(app, folder);
      if (!matcher || before === null) return { verified: null, alreadyRunning: false };
      // A new process proves it opened. If none appears but one was already
      // running, the app was brought forward (most apps hand a second launch
      // to the running instance).
      for (let attempt = 0; attempt < checks; attempt += 1) {
        await wait(checkEveryMs);
        const now = await matchingPids(matcher);
        if (!now) continue;
        if ([...now].some((pid) => !before.has(pid))) return { verified: true, alreadyRunning: false };
        if (before.size > 0 && now.size > 0 && attempt >= 2) return { verified: true, alreadyRunning: true };
      }
      return { verified: false, alreadyRunning: false };
    },
  };
}
