"use strict";

/**
 * Durable routines: scheduled and event-triggered work that runs on the server.
 *
 * A routine is a saved trigger plus a teammate (and usually a skill). When it
 * fires, the server creates a persisted run and a real task, then the worker
 * runs that task. Nothing depends on a browser tab staying open. A serverless
 * deployment calls `POST /workforce/tick` from a cron, authenticated with
 * CRON_SECRET — the same pattern as workflows.
 *
 * Firing is claimed with a conditional UPDATE on `next_run_at`, so two servers
 * ticking at once can't create the same run twice.
 */
const express = require("express");
const { Cron } = require("croner");
const {
  asObject, canUseBot, clean, cleanMultiline, fail, id, parse, readBody, recordEvent, requireId, withAccount,
} = require("./common");
const { runQueuedTasks, runTask } = require("./runner");
const { publicTask } = require("./tasks");
const { scan: proactiveScan } = require("./proactive");

const MODES = new Set(["schedule", "event", "manual"]);
const STATUSES = new Set(["active", "paused"]);
const EVENT_KIND = /^[a-z][a-z0-9_.*-]{2,79}$/;
const MAX_RUNS_PER_TICK = 5;

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function checkCron(expression) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) throw fail(400, "A cron expression has 5 fields: minute hour day-of-month month day-of-week.", "invalid-schedule");
  if (fields[0] === "*" || /^\*\/[1-4]$/.test(fields[0])) throw fail(400, "A routine can run at most every 5 minutes.", "invalid-schedule");
  try {
    new Cron(expression, { paused: true }).stop();
  } catch (error) {
    throw fail(400, `That cron expression isn't valid: ${clean(error.message, 200)}`, "invalid-schedule");
  }
  return expression.trim();
}

function checkTimezone(zone) {
  const timezone = clean(zone, 80) || "UTC";
  if (!validTimezone(timezone)) throw fail(400, "That time zone isn't valid. Use a name like Europe/London.", "invalid-timezone");
  return timezone;
}

function nextScheduledRun(trigger, timezone, after) {
  if (trigger.type === "interval") return after + Math.max(5, Number(trigger.minutes)) * 60_000;
  const cron = new Cron(trigger.cron, { timezone: timezone || "UTC", paused: true });
  const next = cron.nextRun(new Date(after));
  cron.stop();
  return next ? next.getTime() : null;
}

function normalizeTrigger(mode, input) {
  const trigger = asObject(input);
  if (mode === "manual") return { type: "manual", inputs: asObject(trigger.inputs) };
  if (mode === "event") {
    const kind = clean(trigger.kind, 80);
    if (!EVENT_KIND.test(kind)) throw fail(400, "Name the event that starts this routine, for example task.completed or artifact.*.", "invalid-trigger");
    return { type: "event", kind, inputs: asObject(trigger.inputs) };
  }
  if (mode !== "schedule") throw fail(400, "mode must be schedule, event or manual.", "invalid");
  if (trigger.type === "interval") {
    const minutes = Number(trigger.minutes);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10080) throw fail(400, "Repeat every 5 to 10,080 minutes.", "invalid-schedule");
    return { type: "interval", minutes: Math.floor(minutes), inputs: asObject(trigger.inputs) };
  }
  const cron = checkCron(trigger.cron);
  return { type: "cron", cron, inputs: asObject(trigger.inputs) };
}

function publicRoutine(row) {
  return {
    id: row.id,
    botId: row.bot_id || null,
    teamId: row.team_id || null,
    name: row.name,
    description: row.description || "",
    skillId: row.skill_id || null,
    mode: row.mode,
    trigger: parse(row.trigger, {}),
    timezone: row.timezone || "UTC",
    status: row.status,
    nextRunAt: row.next_run_at === null || row.next_run_at === undefined ? null : Number(row.next_run_at),
    lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : Number(row.last_run_at),
    runCount: Number(row.run_count) || 0,
    failureCount: Number(row.failure_count) || 0,
    notifications: parse(row.notifications, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function publicRun(row) {
  return {
    id: row.id,
    routineId: row.routine_id,
    status: row.status,
    trigger: row.trigger || "schedule",
    plannedFor: row.planned_for === null || row.planned_for === undefined ? null : Number(row.planned_for),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    result: parse(row.result, null),
    error: row.error || null,
    taskId: row.task_id || null,
    createdAt: Number(row.created_at),
  };
}

async function loadRoutine(db, userId, routineId) {
  const row = (await db.query("SELECT * FROM hannah_routines WHERE user_id = $1 AND id = $2", [userId, requireId(routineId, "routine")])).rows[0];
  if (!row) throw fail(404, "That routine doesn't exist.", "not-found");
  return row;
}

async function assertBot(db, userId, botId) {
  const bot = await canUseBot(db, userId, clean(botId, 80));
  if (!bot) throw fail(404, "That teammate doesn't exist.", "not-found");
  return bot;
}

async function assertSkill(db, userId, skillId) {
  if (!skillId) return null;
  const row = (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2 AND archived_at IS NULL", [userId, clean(skillId, 80)])).rows[0];
  if (!row) throw fail(404, "That skill doesn't exist.", "not-found");
  return row;
}

async function fireRoutine(db, routine, { trigger = "schedule", plannedFor = Date.now(), eventId = null } = {}) {
  const at = Date.now();
  const skill = routine.skill_id ? (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2 AND archived_at IS NULL", [routine.user_id, routine.skill_id])).rows[0] : null;
  if (routine.skill_id && !skill) {
    await db.query("UPDATE hannah_routines SET status = 'paused', failure_count = failure_count + 1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, routine.user_id, routine.id]);
    await recordEvent(db, routine.user_id, "routine.skill_missing", { botId: routine.bot_id, severity: "medium", detail: { routineId: routine.id } });
    return null;
  }
  const runId = id("run");
  const taskId = id("task");
  const triggerConfig = parse(routine.trigger, {});
  const objective = skill
    ? `Run the approved skill "${skill.name}" exactly as reviewed. Use the stored inputs, stop at any step that asks for approval, and report every step and its evidence.`
    : cleanMultiline(routine.description, 8000) || `Complete the routine "${routine.name}" and report what was produced.`;
  await db.query(
    "INSERT INTO hannah_routine_runs (user_id, id, routine_id, status, trigger, planned_for, started_at, finished_at, result, error, task_id, created_at) VALUES ($1, $2, $3, 'queued', $4, $5, $6, NULL, NULL, NULL, $7, $5)",
    [routine.user_id, runId, routine.id, trigger, plannedFor, at, taskId],
  );
  await db.query(
    `INSERT INTO hannah_workforce_tasks (user_id, id, parent_id, bot_id, team_id, title, objective, status, depth, depends_on, inputs, deliverable, acceptance, deadline, priority, project, result, error, continuation, created_at, updated_at, started_at, finished_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, 'queued', 0, '[]', $7, $8, $9, NULL, 'normal', $10, NULL, NULL, NULL, $11, $11, NULL, NULL)`,
    [routine.user_id, taskId, routine.bot_id, routine.team_id, `${routine.name} — ${new Date(plannedFor).toISOString().slice(0, 16).replace("T", " ")}`,
      objective, JSON.stringify({ ...(skill ? { skillId: skill.id } : {}), values: asObject(triggerConfig.inputs), routineId: routine.id, eventId }),
      skill ? "A completed run with the recorded result and any output artifact." : "A completed work product with sources and next steps.",
      "Every step is recorded, nothing is fabricated, and risky steps waited for approval.", clean(routine.name, 80), at],
  );
  await db.query("UPDATE hannah_routines SET last_run_at = $1, run_count = run_count + 1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, routine.user_id, routine.id]);
  await recordEvent(db, routine.user_id, "routine.fired", { botId: routine.bot_id, taskId, detail: { routineId: routine.id, runId, trigger } });
  return { runId, taskId };
}

/** Schedule every due routine, then run queued tasks. Safe to call from several servers. */
async function tick({ budgetMs = 45_000, onlyUserId = null } = {}) {
  const { getDatabase } = require("../db");
  const db = await getDatabase();
  const at = Date.now();
  const fired = [];
  const due = await db.query(
    `SELECT * FROM hannah_routines WHERE status = 'active' AND mode = 'schedule' AND next_run_at IS NOT NULL AND next_run_at <= $1${onlyUserId ? " AND user_id = $2" : ""} ORDER BY next_run_at LIMIT 25`,
    onlyUserId ? [at, onlyUserId] : [at],
  );
  for (const routine of due.rows) {
    const trigger = parse(routine.trigger, {});
    let next = null;
    try {
      next = nextScheduledRun(trigger, routine.timezone, Math.max(at, Number(routine.next_run_at) || at));
    } catch {
      await db.query("UPDATE hannah_routines SET status = 'paused', updated_at = $1 WHERE id = $2", [at, routine.id]);
      continue;
    }
    const claimed = await db.query(
      "UPDATE hannah_routines SET next_run_at = $1, updated_at = $2 WHERE user_id = $3 AND id = $4 AND status = 'active' AND next_run_at = $5",
      [next, at, routine.user_id, routine.id, routine.next_run_at],
    );
    if (!claimed.rowCount) continue;
    try {
      const run = await fireRoutine(db, routine, { trigger: "schedule", plannedFor: Number(routine.next_run_at) });
      if (run) fired.push({ routineId: routine.id, ...run });
    } catch (error) {
      await db.query("UPDATE hannah_routines SET failure_count = failure_count + 1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, routine.user_id, routine.id]);
    }
  }

  // Event routines: one run per matching event since the last run, capped.
  const eventRoutines = await db.query(
    `SELECT * FROM hannah_routines WHERE status = 'active' AND mode = 'event'${onlyUserId ? " AND user_id = $1" : ""} LIMIT 100`,
    onlyUserId ? [onlyUserId] : [],
  );
  for (const routine of eventRoutines.rows) {
    const trigger = parse(routine.trigger, {});
    const since = Number(routine.last_run_at) || Number(routine.created_at);
    const rows = await db.query(
      `SELECT * FROM hannah_workforce_events WHERE user_id = $1 AND created_at > $2 ORDER BY created_at LIMIT 50`,
      [routine.user_id, since],
    );
    const matches = rows.rows.filter((event) => {
      if (trigger.kind.endsWith("*")) return event.kind.startsWith(trigger.kind.slice(0, -1));
      return event.kind === trigger.kind;
    }).slice(0, MAX_RUNS_PER_TICK);
    if (!matches.length) continue;
    for (const event of matches) {
      try {
        const run = await fireRoutine(db, routine, { trigger: `event:${event.kind}`, plannedFor: Number(event.created_at), eventId: event.id });
        if (run) fired.push({ routineId: routine.id, ...run });
      } catch {
        await db.query("UPDATE hannah_routines SET failure_count = failure_count + 1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, routine.user_id, routine.id]);
      }
    }
    await db.query("UPDATE hannah_routines SET last_run_at = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [Number(matches[matches.length - 1].created_at), at, routine.user_id, routine.id]);
  }

  const processed = await runQueuedTasks(db, { limit: Number(process.env.WORKFORCE_TICK_TASKS) || 2, budgetMs, userId: onlyUserId });
  // Honest, deterministic proactive suggestions at most every six hours.
  let proactive = 0;
  const watched = (await db.query("SELECT user_id, settings FROM hannah_proactive_settings" + (onlyUserId ? " WHERE user_id = $1" : "") + " LIMIT 25", onlyUserId ? [onlyUserId] : [])).rows;
  for (const row of watched) {
    const settings = parse(row.settings, {});
    if (settings.enabled !== true) continue;
    if (settings.lastScanAt && Date.now() - Number(settings.lastScanAt) < 6 * 3600_000) continue;
    const outcome = await proactiveScan(db, row.user_id).catch(() => null);
    if (outcome?.created?.length) proactive += outcome.created.length;
  }
  // Mirror task outcomes onto their runs, so the routine history is honest.
  for (const item of processed) {
    const task = (await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [item.userId, item.id]).catch(() => ({ rows: [] }))).rows[0];
    if (!task) continue;
    const run = (await db.query("SELECT * FROM hannah_routine_runs WHERE user_id = $1 AND task_id = $2", [task.user_id, task.id])).rows[0];
    if (!run) continue;
    const finished = ["completed", "failed", "cancelled", "blocked"].includes(task.status);
    await db.query("UPDATE hannah_routine_runs SET status = $1, result = $2, error = $3, finished_at = $4 WHERE user_id = $5 AND id = $6",
      [task.status, task.result, task.error, finished ? Date.now() : null, task.user_id, run.id]);
    if (task.status === "blocked") await db.query("UPDATE hannah_routines SET failure_count = failure_count + 1, updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), task.user_id, run.routine_id]);
  }
  return { at, fired: fired.length, processed, proactive };
}

function createRoutinesRouter() {
  const router = express.Router();

  router.get("/workforce/routines", withAccount(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_routines WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [account.id]);
    const upcoming = rows.filter((row) => row.status === "active" && row.next_run_at).map((row) => ({ id: row.id, name: row.name, nextRunAt: Number(row.next_run_at) }));
    res.json({ routines: rows.map(publicRoutine), upcoming, modes: [...MODES] });
  }));

  router.post("/workforce/routines", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const name = clean(body.name, 120);
    const mode = String(body.mode || "schedule");
    if (!name) throw fail(400, "Give the routine a name.", "invalid");
    if (!MODES.has(mode)) throw fail(400, "mode must be schedule, event or manual.", "invalid");
    const trigger = normalizeTrigger(mode, body.trigger);
    const bot = await assertBot(db, account.id, body.botId);
    const skill = await assertSkill(db, account.id, body.skillId);
    const timezone = checkTimezone(body.timezone);
    const status = body.status === "active" ? "active" : "paused";
    const at = Date.now();
    const routineId = id("rtn");
    const nextRunAt = status === "active" && mode === "schedule" ? nextScheduledRun(trigger, timezone, at) : null;
    await db.query(
      `INSERT INTO hannah_routines (user_id, id, bot_id, team_id, name, description, skill_id, mode, trigger, timezone, status, next_run_at, last_run_at, run_count, failure_count, notifications, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, 0, $14, $15, $15)`,
      [account.id, routineId, bot.id, bot.team_id || null, name, cleanMultiline(body.description, 2000), skill?.id || null, mode, JSON.stringify(trigger), timezone,
        status, nextRunAt, mode === "event" ? at : null, JSON.stringify(asObject(body.notifications)), at],
    );
    await recordEvent(db, account.id, "routine.created", { botId: bot.id, detail: { routineId, name, mode, status } });
    const row = (await db.query("SELECT * FROM hannah_routines WHERE user_id = $1 AND id = $2", [account.id, routineId])).rows[0];
    res.status(201).json({ routine: publicRoutine(row) });
  }));

  router.get("/workforce/routines/:id", withAccount(async (req, res, db, account) => {
    const row = await loadRoutine(db, account.id, req.params.id);
    const runs = (await db.query("SELECT * FROM hannah_routine_runs WHERE user_id = $1 AND routine_id = $2 ORDER BY created_at DESC LIMIT 50", [account.id, row.id])).rows.map(publicRun);
    res.json({ routine: publicRoutine(row), runs });
  }));

  router.patch("/workforce/routines/:id", withAccount(async (req, res, db, account) => {
    const row = await loadRoutine(db, account.id, req.params.id);
    const body = readBody(req);
    const name = body.name === undefined ? row.name : clean(body.name, 120);
    if (!name) throw fail(400, "Give the routine a name.", "invalid");
    const mode = body.mode === undefined ? row.mode : String(body.mode);
    if (!MODES.has(mode)) throw fail(400, "mode must be schedule, event or manual.", "invalid");
    const trigger = body.trigger === undefined ? parse(row.trigger, {}) : normalizeTrigger(mode, body.trigger);
    const bot = body.botId === undefined ? { id: row.bot_id, team_id: row.team_id } : await assertBot(db, account.id, body.botId);
    const skill = body.skillId === undefined ? { id: row.skill_id } : await assertSkill(db, account.id, body.skillId);
    const timezone = body.timezone === undefined ? row.timezone || "UTC" : checkTimezone(body.timezone);
    const status = body.status === undefined ? row.status : (STATUSES.has(String(body.status)) ? String(body.status) : null);
    if (!status) throw fail(400, "status must be active or paused.", "invalid");
    const at = Date.now();
    let nextRunAt = row.next_run_at;
    if (status !== "active" || mode !== "schedule") nextRunAt = null;
    else if (body.trigger !== undefined || body.timezone !== undefined || row.status !== "active") nextRunAt = nextScheduledRun(trigger, timezone, at);
    await db.query(
      `UPDATE hannah_routines SET name = $1, description = $2, bot_id = $3, team_id = $4, skill_id = $5, mode = $6, trigger = $7, timezone = $8, status = $9,
         next_run_at = $10, last_run_at = $11, notifications = $12, updated_at = $13 WHERE user_id = $14 AND id = $15`,
      [name, body.description === undefined ? row.description : cleanMultiline(body.description, 2000), bot.id, bot.team_id || null, skill.id || null, mode,
        JSON.stringify(trigger), timezone, status, nextRunAt, mode === "event" ? (row.last_run_at || at) : row.last_run_at,
        body.notifications === undefined ? row.notifications : JSON.stringify(asObject(body.notifications)), at, account.id, row.id],
    );
    await recordEvent(db, account.id, "routine.updated", { botId: bot.id, detail: { routineId: row.id, status } });
    const updated = (await db.query("SELECT * FROM hannah_routines WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0];
    res.json({ routine: publicRoutine(updated) });
  }));

  router.delete("/workforce/routines/:id", withAccount(async (req, res, db, account) => {
    const row = await loadRoutine(db, account.id, req.params.id);
    await db.query("DELETE FROM hannah_routines WHERE user_id = $1 AND id = $2", [account.id, row.id]);
    await recordEvent(db, account.id, "routine.deleted", { detail: { routineId: row.id, name: row.name } });
    res.json({ ok: true, deleted: true });
  }));

  router.post("/workforce/routines/:id/run", withAccount(async (req, res, db, account) => {
    const row = await loadRoutine(db, account.id, req.params.id);
    if (!row.bot_id) throw fail(400, "Assign a teammate before running this routine.", "no-bot");
    const run = await fireRoutine(db, row, { trigger: "manual", plannedFor: Date.now() });
    if (!run) throw fail(409, "The routine's skill is missing, so it was paused instead of run.", "skill-missing");
    const outcome = await runTask(db, account.id, run.taskId);
    const task = outcome.task;
    if (task) {
      await db.query("UPDATE hannah_routine_runs SET status = $1, result = $2, error = $3, finished_at = $4 WHERE user_id = $5 AND id = $6",
        [task.status, task.result, task.error, ["completed", "failed", "blocked", "cancelled"].includes(task.status) ? Date.now() : null, account.id, run.runId]);
    }
    res.status(202).json({
      run: publicRun((await db.query("SELECT * FROM hannah_routine_runs WHERE user_id = $1 AND id = $2", [account.id, run.runId])).rows[0]),
      task: task ? publicTask(task) : null,
    });
  }));

  router.get("/workforce/routines/:id/runs", withAccount(async (req, res, db, account) => {
    const row = await loadRoutine(db, account.id, req.params.id);
    const { rows } = await db.query("SELECT * FROM hannah_routine_runs WHERE user_id = $1 AND routine_id = $2 ORDER BY created_at DESC LIMIT 100", [account.id, row.id]);
    res.json({ runs: rows.map(publicRun) });
  }));

  /** Cron entry point for serverless hosting. Mirrors /workflows/tick. */
  const tickHandler = async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    if (!secret) return res.status(503).json({ error: "CRON_SECRET isn't set on the server, so the workforce tick is disabled.", reason: "cron-unconfigured" });
    const authorization = req.get("authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : (req.get("x-cron-secret") || "");
    const crypto = require("node:crypto");
    const expected = Buffer.from(secret);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: "The cron secret is missing or wrong.", reason: "unauthorized" });
    }
    try {
      const result = await tick({ budgetMs: Number(process.env.WORKFORCE_TICK_BUDGET_MS) || 45_000 });
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error(`Workforce tick failed (${error?.code || error?.name || "error"}).`);
      res.status(500).json({ error: "The workforce tick failed.", reason: "tick-failed" });
    }
  };
  router.get("/workforce/tick", tickHandler);
  router.post("/workforce/tick", tickHandler);

  return router;
}

module.exports = { MODES, checkCron, createRoutinesRouter, fireRoutine, nextScheduledRun, normalizeTrigger, publicRoutine, publicRun, tick };
