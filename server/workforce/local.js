"use strict";

/**
 * Teammate work on the person's own computer, through the HANNAH desktop app.
 *
 * Nothing here runs on the person's computer. The server keeps a queue of
 * jobs; the desktop app (signed in, with "Run workflow tasks" on) claims one,
 * shows its own system dialog naming the teammate, runs it with the desktop
 * plugin's folder and address rules, and reports the result. The dialog and
 * the rules live in the desktop app's main process, so no model and no server
 * can skip them.
 *
 * Job kinds are the ones the desktop app already runs for workflows:
 *   browser  read a web page in HANNAH's desktop browser
 *   coding   a coding task in one shared folder
 *   open     open apps and links
 *   notify   a desktop notification
 *
 * Each local computer has its own rule for what may even be queued, separate
 * from any cloud computer's permissions:
 *   ask         any kind; the desktop asks every time (the default)
 *   tasks       only the kinds the person listed
 *   workspaces  only coding jobs in the shared folders the person listed
 *   never       nothing
 *
 * A job is created by a person: from a teammate's suggested step, or directly
 * from Agent Activity. A teammate's model never queues one by itself.
 */
const express = require("express");
const { asArray, asObject, canUseBot, clean, cleanMultiline, fail, id, parse, readBody, recordEvent, requireId, withAccount } = require("./common");

const KINDS = {
  browser: "Read a web page in HANNAH's desktop browser",
  coding: "A coding task in one shared folder",
  open: "Open apps and links",
  notify: "Show a desktop notification",
};
const MODES = new Set(["ask", "tasks", "workspaces", "never"]);
const JOB_TTL_MS = 24 * 60 * 60_000;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const ACTION_PREFIX = "local.";

function permissionsOf(computer) {
  const raw = parse(computer.permissions, {}) || {};
  const mode = MODES.has(raw.localMode) ? raw.localMode : raw.localMode === "allow" ? "tasks" : "ask";
  return {
    mode,
    kinds: asArray(raw.localKinds, 4).filter((kind) => Object.hasOwn(KINDS, kind)),
    folders: asArray(raw.localFolders, 20),
  };
}

/** Clean a job's input for its kind. Throws on what the desktop app would refuse anyway. */
function normalizeInput(kind, raw) {
  const input = asObject(raw);
  if (kind === "browser") {
    const url = clean(input.url, 2000);
    if (!/^https?:\/\//i.test(url)) throw fail(400, "A web page job needs an http(s) address.", "invalid");
    return { url, waitFor: clean(input.waitFor, 200), screenshot: input.screenshot === true };
  }
  if (kind === "coding") {
    const task = cleanMultiline(input.task, 4000);
    if (!task) throw fail(400, "Say what the coding task is.", "invalid");
    return { task, folder: clean(input.folder, 120), allowCommands: input.allowCommands !== false };
  }
  if (kind === "open") {
    const urls = (Array.isArray(input.urls) ? input.urls : []).map((url) => clean(url, 2000)).filter((url) => /^https?:\/\//i.test(url)).slice(0, 10);
    const app = clean(input.app, 120);
    if (!urls.length && !app) throw fail(400, "Name an app or at least one http(s) link to open.", "invalid");
    return { app, folder: clean(input.folder, 120), urls, notify: input.notify === true };
  }
  if (kind === "notify") {
    const title = clean(input.title, 120);
    if (!title) throw fail(400, "A notification needs a title.", "invalid");
    return { title, body: clean(input.body, 400) };
  }
  throw fail(400, `kind must be one of ${Object.keys(KINDS).join(", ")}.`, "invalid");
}

/** Whether this computer's rule lets the job be queued. The desktop still asks. */
function allowed(permissions, kind, input) {
  if (permissions.mode === "never") return { ok: false, reason: "This computer is set to never run teammate tasks." };
  if (permissions.mode === "tasks" && !permissions.kinds.includes(kind)) return { ok: false, reason: `This computer only takes ${permissions.kinds.length ? permissions.kinds.join(", ") : "no"} teammate tasks.` };
  if (permissions.mode === "workspaces") {
    if (kind !== "coding") return { ok: false, reason: "This computer only takes coding tasks in the shared folders you listed." };
    if (!permissions.folders.some((folder) => folder.toLowerCase() === String(input.folder || "").toLowerCase())) return { ok: false, reason: `The folder “${input.folder || "(none)"}” isn't one of this computer's allowed workspaces.` };
  }
  return { ok: true };
}

/** The local computers a teammate may use. */
async function localComputers(db, userId, bot) {
  const access = parse(bot.computer_access, {}) || {};
  const ids = asArray(access.computerIds, 20);
  if (!access.enabled || !ids.length) return [];
  const { rows } = await db.query(`SELECT * FROM hannah_computers WHERE user_id = $1 AND kind = 'local' AND id IN (${ids.map((_, index) => `$${index + 2}`).join(", ")})`, [userId, ...ids]);
  return rows;
}

/** Prompt text: the desktop jobs this teammate may suggest, or nothing. */
async function localContext(db, userId, bot) {
  const computers = await localComputers(db, userId, bot).catch(() => []);
  const usable = computers.map((row) => ({ row, permissions: permissionsOf(row) })).filter((item) => item.permissions.mode !== "never");
  if (!usable.length) return "";
  return [
    "THE PERSON'S OWN COMPUTER (through the HANNAH desktop app; you can suggest a job, a person sends it, and the desktop asks them before running it):",
    ...usable.map(({ row, permissions }) => `- "${row.name}": ${permissions.mode === "ask" ? "any job, asked every time" : permissions.mode === "tasks" ? `only ${permissions.kinds.join(", ") || "no"} jobs` : `coding only, in: ${permissions.folders.join(", ")}`}`),
    `To suggest one, add it to nextSteps as {"action": "local.<kind>", "title": "...", "reason": "...", "params": {...}} with kind one of: browser {url}, coding {task, folder}, open {app?, urls?}, notify {title, body}.`,
  ].join("\n");
}

const isLocalAction = (action) => typeof action === "string" && action.startsWith(ACTION_PREFIX) && Object.hasOwn(KINDS, action.slice(ACTION_PREFIX.length));

function publicJob(row, extra = {}) {
  return {
    id: row.id, taskId: row.task_id, botId: row.bot_id || null, computerId: row.computer_id, kind: row.kind, input: parse(row.input, {}),
    status: row.status === "pending" && Number(row.expires_at) <= Date.now() ? "expired" : row.status,
    device: row.device_name || null, result: parse(row.result, null), error: row.error || null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at), ...extra,
  };
}

function deviceOf(body) {
  const deviceId = String(body.deviceId || "");
  if (!DEVICE_ID.test(deviceId)) throw fail(400, "Send this device's id.", "bad-request");
  return { id: deviceId, name: clean(body.deviceName, 80) || "Desktop" };
}

async function queueJob(db, userId, { task, bot, computer, kind, input, stepIndex = null }) {
  const permissions = permissionsOf(computer);
  const normalized = normalizeInput(kind, input);
  const verdict = allowed(permissions, kind, normalized);
  if (!verdict.ok) throw fail(403, verdict.reason, "local-not-allowed");
  const at = Date.now();
  const jobId = id("lj");
  await db.query(
    `INSERT INTO hannah_workforce_local_jobs (user_id, id, task_id, bot_id, computer_id, kind, input, status, device_id, device_name, claimed_at, result, error, created_at, updated_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NULL, NULL, NULL, NULL, NULL, $8, $8, $9)`,
    [userId, jobId, task.id, bot.id, computer.id, kind, JSON.stringify({ ...normalized, teammate: bot.name, taskTitle: clean(task.title, 160), stepIndex }), at, at + JOB_TTL_MS],
  );
  await recordEvent(db, userId, "local.job_queued", { botId: bot.id, taskId: task.id, computerId: computer.id, detail: { jobId, kind, mode: permissions.mode } });
  return (await db.query("SELECT * FROM hannah_workforce_local_jobs WHERE user_id = $1 AND id = $2", [userId, jobId])).rows[0];
}

function createLocalRouter() {
  const router = express.Router();
  const personOnly = (account) => {
    if (account.via !== "session") throw fail(403, "Only a signed-in person can send work to their own computer.", "person-required");
  };

  /** Change what a local computer takes from teammates. */
  router.put("/workforce/computers/:id/local-permissions", withAccount(async (req, res, db, account) => {
    personOnly(account);
    const row = (await db.query("SELECT * FROM hannah_computers WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "computer")])).rows[0];
    if (!row) throw fail(404, "That computer doesn't exist.", "not-found");
    if (row.kind !== "local") throw fail(400, "Only a local computer has desktop permissions.", "not-local");
    const body = readBody(req);
    const mode = String(body.mode || "");
    if (!MODES.has(mode)) throw fail(400, "mode must be ask, tasks, workspaces or never.", "invalid");
    const kinds = asArray(body.kinds, 4).filter((kind) => Object.hasOwn(KINDS, kind));
    const folders = asArray(body.folders, 20);
    if (mode === "tasks" && !kinds.length) throw fail(400, "Choose at least one kind of task, or use never.", "invalid");
    if (mode === "workspaces" && !folders.length) throw fail(400, "Name at least one shared folder, or use never.", "invalid");
    const permissions = { ...(parse(row.permissions, {}) || {}), localMode: mode, localKinds: kinds, localFolders: folders };
    await db.query("UPDATE hannah_computers SET permissions = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(permissions), Date.now(), account.id, row.id]);
    await recordEvent(db, account.id, "local.permissions_changed", { computerId: row.id, detail: { mode, kinds, folders: folders.length } });
    res.json({ computerId: row.id, permissions: permissionsOf({ permissions: JSON.stringify(permissions) }), kinds: KINDS });
  }));

  /**
   * Send work to the person's computer for a task: a teammate's suggested
   * step ({ index }) or a job the person describes ({ computerId, kind, input }).
   */
  router.post("/workforce/tasks/:id/local-jobs", withAccount(async (req, res, db, account) => {
    personOnly(account);
    const task = (await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "task")])).rows[0];
    if (!task) throw fail(404, "That task doesn't exist.", "not-found");
    const bot = task.bot_id ? await canUseBot(db, account.id, task.bot_id) : null;
    if (!bot) throw fail(409, "The teammate behind this task is no longer available.", "bot-missing");
    const body = readBody(req);
    const computers = await localComputers(db, account.id, bot);
    let kind = String(body.kind || "");
    let input = asObject(body.input);
    let stepIndex = null;
    const result = parse(task.result, {}) || {};
    const steps = Array.isArray(result.nextSteps) ? result.nextSteps : [];
    if (body.index !== undefined) {
      stepIndex = Number(body.index);
      const step = Number.isInteger(stepIndex) ? steps[stepIndex] : null;
      if (!step) throw fail(404, "That suggested step doesn't exist.", "not-found");
      if (!isLocalAction(step.action)) throw fail(400, "That step isn't a job for your computer.", "not-local");
      if (step.localJobId) throw fail(409, "That step was already sent.", "already-sent");
      kind = step.action.slice(ACTION_PREFIX.length);
      input = asObject(step.params);
    }
    const computer = body.computerId ? computers.find((row) => row.id === clean(body.computerId, 80)) : computers[0];
    if (!computer) throw fail(400, `${bot.name} has no local computer. Add one in the Computer Center and give the teammate access to it.`, "no-local-computer");
    const job = await queueJob(db, account.id, { task, bot, computer, kind, input, stepIndex });
    if (stepIndex !== null) {
      steps[stepIndex] = { ...steps[stepIndex], localJobId: job.id, localStatus: "pending" };
      await db.query("UPDATE hannah_workforce_tasks SET result = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify({ ...result, nextSteps: steps }).slice(0, 200_000), Date.now(), account.id, task.id]);
    }
    res.status(201).json({ job: publicJob(job), note: `Queued for ${computer.name}. The desktop app asks you before it runs; it needs "Run workflow tasks" on in Settings → Desktop access.` });
  }));

  router.get("/workforce/tasks/:id/local-jobs", withAccount(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_workforce_local_jobs WHERE user_id = $1 AND task_id = $2 ORDER BY created_at DESC LIMIT 50", [account.id, requireId(req.params.id, "task")]);
    res.json({ jobs: rows.map((row) => publicJob(row)) });
  }));

  /** The desktop app's queue: pending, unexpired jobs. */
  router.get("/workforce/local-jobs", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_workforce_local_jobs WHERE user_id = $1 AND status = 'pending' AND expires_at > $2 ORDER BY created_at LIMIT 20", [account.id, Date.now()]);
    res.json({ jobs: rows.map((row) => publicJob(row)), kinds: KINDS });
  }));

  router.post("/workforce/local-jobs/:id/claim", withAccount(async (req, res, db, account) => {
    const device = deviceOf(readBody(req));
    const at = Date.now();
    const { rowCount } = await db.query(
      "UPDATE hannah_workforce_local_jobs SET status = 'claimed', device_id = $1, device_name = $2, claimed_at = $3, updated_at = $3 WHERE user_id = $4 AND id = $5 AND status = 'pending' AND expires_at > $3",
      [device.id, device.name, at, account.id, requireId(req.params.id, "job")],
    );
    if (rowCount !== 1) throw fail(409, "Another device took this job, or it was cancelled or expired.", "conflict");
    const row = (await db.query("SELECT * FROM hannah_workforce_local_jobs WHERE user_id = $1 AND id = $2", [account.id, req.params.id])).rows[0];
    res.json({ job: publicJob(row) });
  }));

  router.post("/workforce/local-jobs/:id/complete", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const device = deviceOf(body);
    const job = (await db.query("SELECT * FROM hannah_workforce_local_jobs WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "job")])).rows[0];
    if (!job) throw fail(404, "That job doesn't exist.", "not-found");
    if (job.status !== "claimed" || job.device_id !== device.id) throw fail(409, job.status === "claimed" ? "Another device is running this job." : `This job is ${job.status}.`, "conflict");
    const ok = body.ok === true;
    const output = ok && body.output && typeof body.output === "object" && !Array.isArray(body.output) ? body.output : null;
    if (output && JSON.stringify(output).length > 1_000_000) throw fail(413, "The result can be up to 1 MB.", "too-large");
    const error = ok ? null : clean(body.error, 1000) || "The desktop app couldn't do this job.";
    const at = Date.now();
    const { rowCount } = await db.query("UPDATE hannah_workforce_local_jobs SET status = $1, result = $2, error = $3, updated_at = $4 WHERE user_id = $5 AND id = $6 AND status = 'claimed' AND device_id = $7",
      [ok ? "done" : "failed", output ? JSON.stringify(output) : null, error, at, account.id, job.id, device.id]);
    if (rowCount !== 1) throw fail(409, "This job changed while it ran.", "conflict");

    // The task keeps a record of what ran where; a coding reply or page text becomes an artifact.
    const task = (await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, job.task_id])).rows[0];
    let artifact = null;
    const text = output ? String(output.reply || output.text || "").slice(0, 400_000) : "";
    if (task && text.trim()) {
      const { createArtifact } = require("./artifacts");
      const row = await createArtifact(db, account.id, { name: `${clean(task.title, 80)} — desktop ${job.kind}.md`, type: "text/markdown", content: `# ${task.title}\n\nRan on ${device.name} (${job.kind}).\n\n${text}`, taskId: task.id, botId: job.bot_id, source: "desktop-job" }).catch(() => null);
      if (row) artifact = { id: row.id, name: row.name };
    }
    if (task) {
      const result = parse(task.result, {}) || {};
      const input = parse(job.input, {}) || {};
      const steps = Array.isArray(result.nextSteps) ? result.nextSteps : [];
      if (Number.isInteger(input.stepIndex) && steps[input.stepIndex]?.localJobId === job.id) steps[input.stepIndex] = { ...steps[input.stepIndex], localStatus: ok ? "done" : "failed" };
      const localRuns = [...(Array.isArray(result.localRuns) ? result.localRuns : []), { jobId: job.id, kind: job.kind, ok, device: device.name, error, artifact, at }].slice(-20);
      await db.query("UPDATE hannah_workforce_tasks SET result = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify({ ...result, nextSteps: steps, localRuns }).slice(0, 200_000), at, account.id, task.id]);
    }
    await recordEvent(db, account.id, ok ? "local.job_done" : "local.job_failed", { botId: job.bot_id, taskId: job.task_id, computerId: job.computer_id, severity: ok ? "info" : "medium", detail: { jobId: job.id, kind: job.kind, device: device.name, ...(error ? { reason: error } : {}) } });
    res.json({ job: publicJob((await db.query("SELECT * FROM hannah_workforce_local_jobs WHERE user_id = $1 AND id = $2", [account.id, job.id])).rows[0]), artifact });
  }));

  router.post("/workforce/local-jobs/:id/cancel", withAccount(async (req, res, db, account) => {
    personOnly(account);
    const { rowCount } = await db.query("UPDATE hannah_workforce_local_jobs SET status = 'cancelled', updated_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'pending'", [Date.now(), account.id, requireId(req.params.id, "job")]);
    if (rowCount !== 1) throw fail(409, "Only a job that hasn't started can be cancelled.", "conflict");
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { KINDS, MODES, allowed, createLocalRouter, isLocalAction, localContext, normalizeInput, permissionsOf };
