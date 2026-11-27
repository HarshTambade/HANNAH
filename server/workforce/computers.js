"use strict";

/**
 * Persistent computers for the workforce.
 *
 * A computer here is a server-hosted workspace with a real filesystem, a real
 * Playwright browser profile and a real (but allow-listed) terminal. Workspaces
 * are isolated per person and per computer; paths are re-checked on every
 * operation and symlinks can't escape the workspace.
 *
 * Honest limits:
 *   - this is a workspace under the server user, not a VM or microVM. The
 *     deployment guide says how to run it inside a container for stronger
 *     isolation. High-risk work should use that driver;
 *   - the terminal runs a read-only allow-list by default. Node, git, npm and
 *     other programs need HANNAH_WORKFORCE_EXTENDED_COMMANDS=1 and a container;
 *   - a "local" computer only records the person's authorization. Execution on
 *     their desktop happens in the desktop runtime, never on this server.
 */
const express = require("express");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  asObject, canUseBot, clean, fail, id, parse, readBody, recordEvent, requireId, sha256, withAccount,
} = require("./common");
const { assertAction } = require("./approvals");
const browser = require("./browser");
const { resolveSecret } = require("./secrets");

const KINDS = new Set(["cloud", "local"]);
const HIDDEN = new Set([".hannah"]);
const DEFAULT_STORAGE_MB = 512;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 500;

/** Where workspaces live. Set HANNAH_WORKFORCE_DIR on a real deployment. */
function workforceRoot() {
  return path.resolve(process.env.HANNAH_WORKFORCE_DIR || path.join(os.homedir(), ".hannah", "workforce"));
}

function userRoot(userId) {
  return path.join(workforceRoot(), sha256(userId).slice(0, 24));
}

function workspaceFor(row) {
  return path.join(userRoot(row.user_id), row.workspace_key);
}

async function ensureWorkspace(row) {
  const workspace = workspaceFor(row);
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(path.join(workspace, ".hannah", "home"), { recursive: true });
  await fsp.mkdir(path.join(workspace, ".hannah", "tmp"), { recursive: true });
  return workspace;
}

function relativePath(input) {
  const raw = String(input ?? "").replace(/\\/g, "/").trim();
  if (raw.includes("\u0000")) throw fail(400, "That path has an invalid character.", "bad-path");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw fail(400, "Use a path relative to the workspace.", "bad-path");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === ".." || HIDDEN.has(part))) throw fail(400, "That path is outside the workspace.", "bad-path");
  return parts.join("/");
}

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolve a path, refusing symlinks that leave the workspace. */
async function safePath(workspace, input, { allowMissing = false } = {}) {
  const rel = relativePath(input);
  const root = await fsp.realpath(workspace);
  const target = path.resolve(root, rel);
  if (!inside(root, target)) throw fail(400, "That path is outside the workspace.", "bad-path");
  const direct = await fsp.lstat(target).catch(() => null);
  if (direct) {
    const real = await fsp.realpath(target);
    if (!inside(root, real)) throw fail(400, "A link points outside the workspace.", "bad-path");
    return { absolute: real, relative: path.relative(root, real).split(path.sep).join("/") || "." };
  }
  if (!allowMissing) throw fail(404, "That path doesn't exist.", "not-found");
  // For a new file or folder, every existing ancestor must be inside the workspace.
  let parent = path.dirname(target);
  while (!inside(root, parent) || !(await fsp.lstat(parent).catch(() => null))) {
    if (parent === root || !inside(root, parent)) break;
    parent = path.dirname(parent);
  }
  const realParent = await fsp.realpath(parent);
  if (!inside(root, realParent)) throw fail(400, "A link points outside the workspace.", "bad-path");
  return { absolute: target, relative: rel || "." };
}

// Counting stops here; a workspace this large is treated as full, never as small.
const USAGE_MAX_ENTRIES = 200_000;

async function usage(workspace) {
  let bytes = 0;
  let files = 0;
  let truncated = false;
  async function walk(dir, depth) {
    if (truncated) return;
    if (files >= USAGE_MAX_ENTRIES || depth > 64) { truncated = true; return; }
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === ".hannah" && depth === 0) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const info = await fsp.stat(full).catch(() => null);
        if (info) { bytes += info.size; files += 1; }
      }
    }
  }
  await walk(workspace, 0);
  return { bytes: truncated ? Number.POSITIVE_INFINITY : bytes, files, truncated };
}

function publicComputer(row, extra = {}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    botId: row.bot_id || null,
    teamId: row.team_id || null,
    image: row.image || null,
    risk: row.risk || "standard",
    permissions: parse(row.permissions, {}),
    limits: parse(row.limits, {}),
    retentionDays: row.retention_days === null ? null : Number(row.retention_days),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastStartedAt: row.last_started_at === null || row.last_started_at === undefined ? null : Number(row.last_started_at),
    ...extra,
  };
}

function publicSession(row) {
  return {
    id: row.id,
    computerId: row.computer_id,
    botId: row.bot_id || null,
    taskId: row.task_id || null,
    status: row.status,
    url: row.url || "",
    tabs: parse(row.tabs, []),
    checkpoint: parse(row.checkpoint, {}),
    activity: parse(row.activity, []),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
  };
}

async function loadComputer(db, userId, computerId) {
  const row = (await db.query("SELECT * FROM hannah_computers WHERE user_id = $1 AND id = $2", [userId, requireId(computerId, "computer")])).rows[0];
  if (!row) throw fail(404, "That computer doesn't exist.", "not-found");
  return row;
}

async function loadSession(db, userId, sessionId) {
  const row = (await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND id = $2", [userId, requireId(sessionId, "session")])).rows[0];
  if (!row) throw fail(404, "That session doesn't exist.", "not-found");
  return row;
}

async function botFor(db, userId, botId) {
  if (!botId) return null;
  const bot = await canUseBot(db, userId, clean(botId, 80));
  if (!bot) throw fail(404, "That teammate doesn't exist.", "not-found");
  return bot;
}

async function assertBotComputerAccess(db, userId, bot, computerId) {
  if (!bot) return;
  if (!bot.computer_access) return;
  const access = parse(bot.computer_access, {});
  if (!access.enabled) throw fail(403, `${bot.name} has no computer access. Enable it in the teammate's settings.`, "computer-denied");
  const allowed = Array.isArray(access.computerIds) ? access.computerIds : [];
  if (!allowed.includes(computerId)) throw fail(403, `${bot.name} isn't allowed to use this computer.`, "computer-denied");
}

async function appendActivity(db, row, entry) {
  const activity = parse(row.activity, []);
  activity.push({ at: Date.now(), ...entry });
  const trimmed = activity.slice(-200);
  const url = entry.url !== undefined ? clean(entry.url, 2000) : row.url;
  const tabs = entry.tabs !== undefined ? JSON.stringify(entry.tabs).slice(0, 10_000) : row.tabs;
  let checkpoint = parse(row.checkpoint, {});
  if (entry.checkpoint && typeof entry.checkpoint === "object") checkpoint = { ...checkpoint, ...entry.checkpoint };
  checkpoint.lastActionAt = Date.now();
  await db.query("UPDATE hannah_computer_sessions SET activity = $1, url = $2, tabs = $3, checkpoint = $4, updated_at = $5 WHERE user_id = $6 AND id = $7",
    [JSON.stringify(trimmed), url, tabs, JSON.stringify(checkpoint).slice(0, 50_000), Date.now(), row.user_id, row.id]);
  return trimmed;
}

// ------------------------------------------------------------------ terminal

const SAFE_COMMANDS = {
  pwd: { readOnly: true, maxArgs: 0 },
  whoami: { readOnly: true, maxArgs: 0 },
  uname: { readOnly: true, maxArgs: 2, flags: /^(-a|-s|-r|-m|-sm)$/ },
  date: { readOnly: true, maxArgs: 2, flags: /^(-u|\+[A-Za-z0-9%:._/ -]{1,80})$/ },
  echo: { readOnly: true, maxArgs: 20 },
  ls: { readOnly: true, maxArgs: 20, paths: true, flags: /^(-[alh1trSRd]{1,8})$/ },
  cat: { readOnly: true, maxArgs: 20, paths: true, flags: /^-[nbseE]$/ },
  head: { readOnly: true, maxArgs: 20, paths: true, flags: /^-\d{1,6}$/ },
  tail: { readOnly: true, maxArgs: 20, paths: true, flags: /^-\d{1,6}$/ },
  wc: { readOnly: true, maxArgs: 20, paths: true, flags: /^-[lwc]$/ },
  grep: { readOnly: true, maxArgs: 20, grep: true, flags: /^-[iInrEvclw]{1,6}$/ },
  find: { readOnly: true, maxArgs: 10, find: true, flags: /^-(name|type|maxdepth|mindepth|iname)$/ },
};
const FORBIDDEN_FIND = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const EXTENDED_COMMANDS = new Set(["node", "npm", "npx", "python3", "pip3", "git", "make"]);

function terminalCapabilities() {
  return {
    commands: Object.keys(SAFE_COMMANDS),
    extended: process.env.HANNAH_WORKFORCE_EXTENDED_COMMANDS === "1" ? [...EXTENDED_COMMANDS] : [],
    shell: false,
    note: process.env.HANNAH_WORKFORCE_EXTENDED_COMMANDS === "1"
      ? "Extended commands are enabled. Run this server in a container: a child process shares the server user's permissions."
      : "Only read-only commands are enabled. Set HANNAH_WORKFORCE_EXTENDED_COMMANDS=1 inside a container to allow build tools.",
  };
}

async function validateCommand(workspace, command, args) {
  const name = String(command || "");
  const extended = EXTENDED_COMMANDS.has(name) && process.env.HANNAH_WORKFORCE_EXTENDED_COMMANDS === "1";
  const spec = SAFE_COMMANDS[name];
  if (!spec && !extended) throw fail(403, `Command not allowed: ${clean(name, 40) || "(none)"}. Allowed: ${Object.keys(SAFE_COMMANDS).join(", ")}${process.env.HANNAH_WORKFORCE_EXTENDED_COMMANDS === "1" ? `, ${[...EXTENDED_COMMANDS].join(", ")}` : ""}.`, "command-denied");
  const list = Array.isArray(args) ? args.map((item) => String(item)) : [];
  if (list.length > (spec?.maxArgs ?? 30)) throw fail(400, "Too many arguments.", "invalid");
  for (const arg of list) {
    if (arg.length > 500 || /[\u0000-\u001f\u007f]/.test(arg)) throw fail(400, "An argument is invalid.", "invalid");
  }
  if (spec) {
    if (spec.find) {
      for (const arg of list) if (FORBIDDEN_FIND.test(arg)) throw fail(403, "find may not run or modify anything.", "command-denied");
    }
    if (spec.grep) {
      if (list.length < 2) throw fail(400, "grep needs a pattern and at least one file.", "invalid");
      for (const arg of list) if (arg.startsWith("-") && spec.flags && !spec.flags.test(arg)) throw fail(400, "That option isn't allowed for grep.", "invalid");
      for (const file of list.slice(1)) {
        if (file.startsWith("-")) continue;
        await safePath(workspace, file);
      }
    } else if (spec.find) {
      // Every allowed find option takes one value; any other word is a start
      // path, and each one must be inside the workspace (not just the first).
      const starts = [];
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].startsWith("-")) { index += 1; continue; }
        starts.push(list[index]);
      }
      for (const start of starts.length ? starts : ["."]) await safePath(workspace, start);
      for (const arg of list) if (arg.startsWith("-") && spec.flags && !spec.flags.test(arg) && !FORBIDDEN_FIND.test(arg)) throw fail(400, "That option isn't allowed for find.", "invalid");
    } else if (spec.paths) {
      for (const arg of list) {
        if (arg.startsWith("-")) {
          if (spec.flags && !spec.flags.test(arg)) throw fail(400, `That option isn't allowed for ${name}.`, "invalid");
          continue;
        }
        await safePath(workspace, arg);
      }
    } else if (list.some((arg) => arg.startsWith("-") && (!spec.flags || !spec.flags.test(arg)))) {
      throw fail(400, `${name} doesn't take that option here.`, "invalid");
    }
  }
  return { name, list, readOnly: Boolean(spec?.readOnly), extended };
}

async function runTerminal(workspace, { command, args, cwd, timeoutMs }) {
  const parsed = await validateCommand(workspace, command, args);
  const dir = cwd ? (await safePath(workspace, cwd)).absolute : workspace;
  const info = await fsp.stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw fail(400, "That working directory isn't in the workspace.", "bad-path");
  const limit = Math.min(60_000, Math.max(1000, Number(timeoutMs) || 15_000));
  const outputCap = 256 * 1024;
  return new Promise((resolve) => {
    const child = spawn(parsed.name, parsed.list, {
      cwd: dir,
      shell: false,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        HOME: path.join(workspace, ".hannah", "home"),
        TMPDIR: path.join(workspace, ".hannah", "tmp"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, limit);
    child.stdout.on("data", (chunk) => { if (stdout.length < outputCap) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < outputCap) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command: parsed.name, args: parsed.list, exitCode: null, stdout: "", stderr: `Couldn't start the command (${error.code || "error"}).`, truncated: false, timedOut: false, readOnly: parsed.readOnly, cwd: path.relative(workspace, dir) || "." });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: parsed.name, args: parsed.list, exitCode: code, stdout: stdout.slice(0, outputCap),
        stderr: stderr.slice(0, outputCap), truncated: stdout.length >= outputCap || stderr.length >= outputCap,
        timedOut: killed, readOnly: parsed.readOnly, cwd: path.relative(workspace, dir) || ".",
      });
    });
  });
}

// ------------------------------------------------------------------ router

function createComputersRouter() {
  const router = express.Router();

  router.get("/workforce/computers/capabilities", withAccount(async (_req, res) => {
    res.json({
      root: "isolated workspace per person and computer",
      isolation: "workspace-directory",
      terminal: terminalCapabilities(),
      browser: await browser.status(),
      note: "A workspace is not a virtual machine. For high-risk work, run this server in a container with a read-only base image and a per-tenant volume.",
    });
  }));

  router.get("/workforce/computers", withAccount(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_computers WHERE user_id = $1 ORDER BY created_at DESC", [account.id]);
    const computers = [];
    for (const row of rows) {
      const workspace = workspaceFor(row);
      const size = row.kind === "cloud" ? await usage(workspace).catch(() => ({ bytes: 0, files: 0 })) : { bytes: 0, files: 0 };
      computers.push(publicComputer(row, { usage: size, execution: row.kind === "local" ? "desktop-runtime" : "server-workspace" }));
    }
    res.json({ computers });
  }));

  router.post("/workforce/computers", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const name = clean(body.name, 80);
    const kind = String(body.kind || "cloud");
    if (!name) throw fail(400, "Give the computer a name.", "invalid");
    if (!KINDS.has(kind)) throw fail(400, "kind must be cloud or local.", "invalid");
    const bot = await botFor(db, account.id, body.botId);
    if (bot && !bot.user_id) throw fail(400, "Choose a teammate you can use.", "invalid");
    const permissions = {
      terminal: body.permissions?.terminal !== false,
      browser: body.permissions?.browser !== false,
      downloads: body.permissions?.downloads !== false,
      network: ["public", "allowlist", "none"].includes(body.permissions?.network) ? body.permissions.network : "public",
      localMode: ["ask", "allow", "never"].includes(body.permissions?.localMode) ? body.permissions.localMode : "ask",
    };
    const limits = {
      storageMb: Math.min(10_000, Math.max(16, Number(body.limits?.storageMb) || DEFAULT_STORAGE_MB)),
      commandTimeoutMs: Math.min(60_000, Math.max(1000, Number(body.limits?.commandTimeoutMs) || 15_000)),
      browserMinutesPerDay: Math.min(1440, Math.max(1, Number(body.limits?.browserMinutesPerDay) || 120)),
    };
    const at = Date.now();
    const computerId = id("cmp");
    const workspaceKey = computerId;
    await db.query(
      `INSERT INTO hannah_computers (user_id, id, bot_id, team_id, name, kind, status, workspace_key, image, risk, permissions, limits, retention_days, created_at, updated_at, last_started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, NULL)`,
      [account.id, computerId, bot?.id || null, bot?.team_id || null, name, kind, kind === "local" ? "not-connected" : "stopped", workspaceKey,
        clean(body.image, 120) || "hannah-workspace", clean(body.risk, 30) || "standard", JSON.stringify(permissions), JSON.stringify(limits),
        body.retentionDays === undefined ? 30 : Math.min(3650, Math.max(1, Number(body.retentionDays) || 30)), at],
    );
    const row = (await db.query("SELECT * FROM hannah_computers WHERE user_id = $1 AND id = $2", [account.id, computerId])).rows[0];
    if (kind === "cloud") await ensureWorkspace(row);
    await recordEvent(db, account.id, "computer.created", { botId: bot?.id || null, computerId, detail: { name, kind } });
    res.status(201).json({ computer: publicComputer(row, { usage: { bytes: 0, files: 0 }, execution: kind === "local" ? "desktop-runtime" : "server-workspace" }) });
  }));

  router.get("/workforce/computers/:id", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    const workspace = workspaceFor(row);
    const size = row.kind === "cloud" ? await usage(workspace).catch(() => ({ bytes: 0, files: 0 })) : { bytes: 0, files: 0 };
    const sessions = (await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND computer_id = $2 ORDER BY started_at DESC LIMIT 20", [account.id, row.id])).rows.map(publicSession);
    const data = await fsp.readdir(workspace).catch(() => []);
    res.json({
      computer: publicComputer(row, { usage: size, execution: row.kind === "local" ? "desktop-runtime" : "server-workspace", files: data.filter((name) => !HIDDEN.has(name)).slice(0, 100) }),
      sessions,
      terminal: row.kind === "cloud" ? terminalCapabilities() : null,
      browser: row.kind === "cloud" ? await browser.status() : null,
    });
  }));

  router.delete("/workforce/computers/:id", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    await browser.closeComputer(account.id, row.id).catch(() => {});
    const workspace = workspaceFor(row);
    const purge = req.query.purge === "true";
    if (purge) await fsp.rm(workspace, { recursive: true, force: true });
    await db.query("DELETE FROM hannah_computer_sessions WHERE user_id = $1 AND computer_id = $2", [account.id, row.id]);
    await db.query("DELETE FROM hannah_computers WHERE user_id = $1 AND id = $2", [account.id, row.id]);
    await recordEvent(db, account.id, "computer.deleted", { computerId: row.id, detail: { name: row.name, purged: purge } });
    res.json({ ok: true, removed: true, purged: purge });
  }));

  router.post("/workforce/computers/:id/start", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind === "local") throw fail(400, "A local computer runs in the desktop app; start it there.", "local-runtime");
    await ensureWorkspace(row);
    await db.query("UPDATE hannah_computers SET status = 'running', last_started_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, row.id]);
    await recordEvent(db, account.id, "computer.started", { computerId: row.id });
    res.json({ computer: publicComputer((await db.query("SELECT * FROM hannah_computers WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0], { execution: "server-workspace" }) });
  }));

  router.post("/workforce/computers/:id/stop", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    await browser.closeComputer(account.id, row.id).catch(() => {});
    await db.query("UPDATE hannah_computers SET status = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [row.kind === "local" ? "not-connected" : "stopped", Date.now(), account.id, row.id]);
    await recordEvent(db, account.id, "computer.stopped", { computerId: row.id });
    res.json({ ok: true, stopped: true });
  }));

  // ----- files

  router.get("/workforce/computers/:id/files", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "Local files are read by the desktop app, not this server.", "local-runtime");
    const workspace = await ensureWorkspace(row);
    const target = await safePath(workspace, req.query.path || "", { allowMissing: true });
    const entries = await fsp.readdir(target.absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) throw fail(404, "That folder doesn't exist.", "not-found");
    const files = [];
    for (const entry of entries.slice(0, MAX_LIST)) {
      if (HIDDEN.has(entry.name)) continue;
      const info = await fsp.lstat(path.join(target.absolute, entry.name)).catch(() => null);
      if (!info) continue;
      files.push({ name: entry.name, path: target.relative === "." ? entry.name : `${target.relative}/${entry.name}`, type: entry.isDirectory() ? "folder" : "file", size: info.size, modifiedAt: info.mtimeMs });
    }
    files.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
    res.json({ path: target.relative, files });
  }));

  router.get("/workforce/computers/:id/files/content", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "Local files are read by the desktop app, not this server.", "local-runtime");
    const workspace = await ensureWorkspace(row);
    const target = await safePath(workspace, req.query.path || "");
    if (target.relative === ".") throw fail(400, "Name a file.", "invalid");
    const info = await fsp.stat(target.absolute).catch(() => null);
    if (!info?.isFile()) throw fail(404, "That file doesn't exist.", "not-found");
    if (info.size > MAX_READ_BYTES) throw fail(413, "Files over 2 MB are downloaded, not opened here.", "too-large");
    const buffer = await fsp.readFile(target.absolute);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    const binary = text.includes("\uFFFD") || text.includes("\u0000");
    res.json({ path: target.relative, size: info.size, modifiedAt: info.mtimeMs, encoding: binary ? "base64" : "utf8", content: binary ? buffer.toString("base64") : text });
  }));

  router.put("/workforce/computers/:id/files", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "Local files are written by the desktop app, not this server.", "local-runtime");
    const body = readBody(req);
    if (body.botId) await assertBotComputerAccess(db, account.id, await botFor(db, account.id, body.botId), row.id);
    if (body.botId) await assertAction(db, account.id, { bot: await botFor(db, account.id, body.botId), action: "file.write", target: clean(body.path, 300), title: `Write ${clean(body.path, 300)}`, payload: { expected: "Creates or replaces a file in the workspace.", reversible: true } });
    const workspace = await ensureWorkspace(row);
    const target = await safePath(workspace, body.path, { allowMissing: true });
    if (target.relative === ".") throw fail(400, "Name a file.", "invalid");
    const encoding = body.encoding === "base64" ? "base64" : "utf8";
    const buffer = Buffer.from(String(body.content ?? ""), encoding);
    if (buffer.length > MAX_FILE_BYTES) throw fail(413, "Files written here are limited to 8 MB. Use an artifact upload for larger files.", "too-large");
    const sizes = await usage(workspace);
    const quota = Number(parse(row.limits, {}).storageMb || DEFAULT_STORAGE_MB) * 1024 * 1024;
    if (sizes.bytes + buffer.length > quota) throw fail(413, `This computer's ${Math.round(quota / 1024 / 1024)} MB storage limit would be exceeded.`, "quota");
    await fsp.mkdir(path.dirname(target.absolute), { recursive: true });
    await fsp.writeFile(target.absolute, buffer);
    await recordEvent(db, account.id, "file.written", { computerId: row.id, botId: clean(body.botId, 80) || null, detail: { path: target.relative, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") } });
    res.json({ ok: true, path: target.relative, size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") });
  }));

  router.post("/workforce/computers/:id/folders", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "Local folders are managed by the desktop app.", "local-runtime");
    const workspace = await ensureWorkspace(row);
    const target = await safePath(workspace, readBody(req).path, { allowMissing: true });
    if (target.relative === ".") throw fail(400, "Name a folder.", "invalid");
    await fsp.mkdir(target.absolute, { recursive: true });
    await recordEvent(db, account.id, "folder.created", { computerId: row.id, detail: { path: target.relative } });
    res.status(201).json({ ok: true, path: target.relative });
  }));

  router.delete("/workforce/computers/:id/files", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "Local files are deleted by the desktop app.", "local-runtime");
    const bot = await botFor(db, account.id, req.query.botId);
    if (bot) await assertBotComputerAccess(db, account.id, bot, row.id);
    if (bot) await assertAction(db, account.id, { bot, action: "file.delete", target: clean(req.query.path, 300), title: `Delete ${clean(req.query.path, 300)}`, payload: { expected: "Removes the file or folder from the workspace.", reversible: false } });
    const workspace = await ensureWorkspace(row);
    const target = await safePath(workspace, req.query.path || "");
    if (target.relative === ".") throw fail(400, "The workspace root can't be deleted.", "invalid");
    const recursive = req.query.recursive === "true";
    const info = await fsp.lstat(target.absolute).catch(() => null);
    if (!info) throw fail(404, "That path doesn't exist.", "not-found");
    if (info.isDirectory() && !recursive) throw fail(409, "That's a folder. Set recursive=true to remove it and everything in it.", "recursive-required");
    await fsp.rm(target.absolute, { recursive, force: false });
    await recordEvent(db, account.id, "file.deleted", { computerId: row.id, botId: bot?.id || null, detail: { path: target.relative, recursive } });
    res.json({ ok: true, removed: true });
  }));

  // ----- terminal

  router.post("/workforce/computers/:id/terminal", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "Local commands run in the desktop app, with its own permission prompt.", "local-runtime");
    if (!parse(row.permissions, {}).terminal) throw fail(403, "The terminal is turned off for this computer.", "terminal-off");
    const body = readBody(req);
    const workspace = await ensureWorkspace(row);
    const bot = await botFor(db, account.id, body.botId);
    if (bot) {
      await assertBotComputerAccess(db, account.id, bot, row.id);
      const preview = await validateCommand(workspace, body.command, body.args).catch((error) => { throw error; });
      await assertAction(db, account.id, {
        bot, action: preview.readOnly ? "terminal.read" : "terminal.run", target: `${preview.name} ${preview.list.join(" ")}`.slice(0, 300),
        title: `Run ${preview.name} in ${row.name}`, payload: { inputs: { command: preview.name, args: preview.list }, expected: "Runs inside this computer's workspace only.", reversible: true, detail: { readOnly: preview.readOnly } },
      });
    }
    const result = await runTerminal(workspace, { command: body.command, args: body.args, cwd: body.cwd, timeoutMs: Number(parse(row.limits, {}).commandTimeoutMs) || 15_000 });
    await recordEvent(db, account.id, "terminal.command", { computerId: row.id, botId: bot?.id || null, detail: { command: result.command, args: result.args.slice(0, 20), exitCode: result.exitCode, timedOut: result.timedOut, readOnly: result.readOnly } });
    res.json({ result });
  }));

  // ----- sessions and browser

  router.get("/workforce/computers/:id/sessions", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    const { rows } = await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND computer_id = $2 ORDER BY started_at DESC LIMIT 50", [account.id, row.id]);
    res.json({ sessions: rows.map(publicSession) });
  }));

  router.post("/workforce/computers/:id/sessions", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    const body = readBody(req);
    const bot = await botFor(db, account.id, body.botId);
    if (bot) await assertBotComputerAccess(db, account.id, bot, row.id);
    if (row.kind === "local") throw fail(400, "A local computer session is started in the desktop app.", "local-runtime");
    await ensureWorkspace(row);
    const sessionId = id("ses");
    const at = Date.now();
    await db.query(
      "INSERT INTO hannah_computer_sessions (user_id, id, computer_id, bot_id, task_id, status, url, tabs, checkpoint, activity, started_at, updated_at, ended_at) VALUES ($1, $2, $3, $4, $5, 'active', '', '[]', '{}', '[]', $6, $6, NULL)",
      [account.id, sessionId, row.id, bot?.id || null, clean(body.taskId, 80) || null, at],
    );
    await db.query("UPDATE hannah_computers SET status = 'running', last_started_at = COALESCE(last_started_at, $1), updated_at = $1 WHERE user_id = $2 AND id = $3", [at, account.id, row.id]);
    await recordEvent(db, account.id, "computer.session_started", { botId: bot?.id || null, computerId: row.id, detail: { sessionId } });
    res.status(201).json({ session: publicSession((await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND id = $2", [account.id, sessionId])).rows[0]) });
  }));

  router.post("/workforce/sessions/:id/checkpoint", withAccount(async (req, res, db, account) => {
    const session = await loadSession(db, account.id, req.params.id);
    const body = readBody(req);
    const checkpoint = asObject(body.checkpoint);
    const activity = parse(session.activity, []);
    activity.push({ at: Date.now(), kind: "checkpoint", note: clean(body.note, 300) });
    await db.query("UPDATE hannah_computer_sessions SET checkpoint = $1, activity = $2, status = $3, updated_at = $4 WHERE user_id = $5 AND id = $6",
      [JSON.stringify({ ...parse(session.checkpoint, {}), ...checkpoint }).slice(0, 50_000), JSON.stringify(activity.slice(-200)), clean(body.status, 30) || session.status, Date.now(), account.id, session.id]);
    res.json({ session: publicSession((await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND id = $2", [account.id, session.id])).rows[0]) });
  }));

  router.post("/workforce/sessions/:id/end", withAccount(async (req, res, db, account) => {
    const session = await loadSession(db, account.id, req.params.id);
    const at = Date.now();
    await db.query("UPDATE hannah_computer_sessions SET status = 'ended', ended_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, account.id, session.id]);
    await recordEvent(db, account.id, "computer.session_ended", { botId: session.bot_id, computerId: session.computer_id, detail: { sessionId: session.id } });
    res.json({ ok: true, ended: true });
  }));

  router.post("/workforce/computers/:id/browser", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    if (row.kind !== "cloud") throw fail(400, "A local browser is driven by the desktop runtime, not this server.", "local-runtime");
    if (!parse(row.permissions, {}).browser) throw fail(403, "The browser is turned off for this computer.", "browser-off");
    const body = readBody(req);
    const session = body.sessionId ? await loadSession(db, account.id, body.sessionId) : null;
    if (session && session.computer_id !== row.id) throw fail(400, "That session belongs to another computer.", "invalid");
    if (session && session.status === "ended") throw fail(409, "That session has ended.", "ended");
    const bot = await botFor(db, account.id, body.botId || session?.bot_id);
    if (bot) await assertBotComputerAccess(db, account.id, bot, row.id);
    const action = asObject(body.action);
    const kind = clean(action.action || action.type, 40);
    const risk = ["fill", "click", "select", "download", "upload", "press"].includes(kind) ? "medium" : "low";
    const declared = action.submit === true ? "browser.submit" : `browser.${kind}`;
    if (bot) {
      await assertAction(db, account.id, {
        bot, action: declared, risk: kind === "click" && action.submit === true ? "high" : risk,
        target: clean(action.url || action.selector || row.name, 300), taskId: session?.task_id || null,
        title: `Browser ${kind}${action.url ? `: ${clean(action.url, 120)}` : action.selector ? `: ${clean(action.selector, 120)}` : ""}`,
        payload: { inputs: { action: kind, url: action.url || null, selector: action.selector || null }, expected: "Acts inside this computer's browser profile.", reversible: kind !== "download" },
      });
    }
    const workspace = await ensureWorkspace(row);
    let result;
    try {
      result = await browser.act({
        userId: account.id,
        computerId: row.id,
        workspace,
        action,
        secrets: {
          resolve: async (ref, { host } = {}) => {
            const secret = await resolveSecret(db, account.id, ref, { botId: bot?.id || session?.bot_id || null, host });
            await recordEvent(db, account.id, "secret.injected", { botId: bot?.id || null, computerId: row.id, detail: { secretId: String(ref).replace(/^secret:/, ""), host: clean(host, 200) } });
            return secret;
          },
        },
      });
    } catch (error) {
      if (session) await appendActivity(db, session, { kind: `browser.${kind}`, error: clean(error.message, 500), url: session.url });
      throw error;
    }
    if (action.secretRef) result.masked = true;
    if (session) {
      await appendActivity(db, session, {
        kind: `browser.${kind}`, url: result.url, tabs: result.tabs, checkpoint: { title: result.title, lastBrowserAction: kind, challenge: result.challenge || null },
        ...(result.download ? { download: result.download } : {}),
        ...(result.challenge ? { challenge: result.challenge } : {}),
      });
      if (result.challenge?.needed) await db.query("UPDATE hannah_computer_sessions SET status = 'waiting-human', updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, session.id]);
    }
    await recordEvent(db, account.id, "browser.action", { botId: bot?.id || null, computerId: row.id, taskId: session?.task_id || null, detail: { action: kind, url: result.url, masked: Boolean(result.masked), challenge: Boolean(result.challenge), download: result.download ? result.download.name : null } });
    res.json({ result, session: session ? publicSession((await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND id = $2", [account.id, session.id])).rows[0]) : null });
  }));

  router.get("/workforce/sessions/:id/screenshot", withAccount(async (req, res, db, account) => {
    const session = await loadSession(db, account.id, req.params.id);
    const row = await loadComputer(db, account.id, session.computer_id);
    const workspace = await ensureWorkspace(row);
    const image = await browser.latestScreenshot({ userId: account.id, computerId: row.id, workspace });
    if (!image) throw fail(404, "No screenshot has been taken yet.", "not-found");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.end(image);
  }));

  router.post("/workforce/computers/:id/handoff", withAccount(async (req, res, db, account) => {
    const row = await loadComputer(db, account.id, req.params.id);
    const body = readBody(req);
    const session = body.sessionId ? await loadSession(db, account.id, body.sessionId) : null;
    if (!session || session.computer_id !== row.id) throw fail(404, "Start a session before asking for takeover.", "not-found");
    const reason = clean(body.reason, 500) || "The task needs a person to complete a verification step.";
    const instructions = clean(body.instructions, 1000) || "Complete the step in the live preview, then choose Resume.";
    await db.query("UPDATE hannah_computer_sessions SET status = 'waiting-human', updated_at = $1, checkpoint = $2 WHERE user_id = $3 AND id = $4",
      [Date.now(), JSON.stringify({ ...parse(session.checkpoint, {}), handoff: { reason, instructions, at: Date.now() } }).slice(0, 50_000), account.id, session.id]);
    await appendActivity(db, session, { kind: "handoff", reason });
    await recordEvent(db, account.id, "computer.handoff", { botId: session.bot_id, computerId: row.id, detail: { sessionId: session.id, reason } });
    res.json({ ok: true, status: "waiting-human", reason, instructions });
  }));

  router.post("/workforce/sessions/:id/resume", withAccount(async (req, res, db, account) => {
    const session = await loadSession(db, account.id, req.params.id);
    if (session.status !== "waiting-human") throw fail(409, "That session isn't waiting for a person.", "not-waiting");
    await db.query("UPDATE hannah_computer_sessions SET status = 'active', updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, session.id]);
    await appendActivity(db, session, { kind: "resumed" });
    await recordEvent(db, account.id, "computer.resumed", { botId: session.bot_id, computerId: session.computer_id, detail: { sessionId: session.id } });
    res.json({ ok: true, session: publicSession((await db.query("SELECT * FROM hannah_computer_sessions WHERE user_id = $1 AND id = $2", [account.id, session.id])).rows[0]) });
  }));

  return router;
}

module.exports = {
  DEFAULT_STORAGE_MB, createComputersRouter, ensureWorkspace, publicComputer, publicSession,
  runTerminal, safePath, terminalCapabilities, usage, workspaceFor, workforceRoot,
};
