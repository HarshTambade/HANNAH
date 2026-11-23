"use strict";

/**
 * Workforce tasks and delegation.
 *
 * A task has one owner, one assigned teammate and an auditable parent. A parent
 * can delegate child tasks to other teammates; depth is capped at three and a
 * single parent at eight children, so delegation can't loop or fan out without
 * bound. Dependencies are explicit and may only point at tasks of the same
 * owner. Completing a task records what the teammate says it produced; a
 * different teammate can verify it, and both records are kept.
 */
const express = require("express");
const {
  TASK_STATUSES, asArray, asObject, canUseBot, clean, cleanMultiline, fail, id, parse, readBody,
  recordEvent, requireId, withAccount,
} = require("./common");

const MAX_DEPTH = 3;
const MAX_CHILDREN = 8;
const FINAL = new Set(["completed", "cancelled", "failed"]);
const TRANSITIONS = {
  queued: new Set(["running", "waiting-approval", "paused", "blocked", "cancelled", "failed"]),
  running: new Set(["waiting-approval", "paused", "blocked", "failed", "completed", "cancelled"]),
  "waiting-approval": new Set(["queued", "running", "paused", "blocked", "failed", "cancelled"]),
  paused: new Set(["queued", "running", "cancelled", "failed"]),
  blocked: new Set(["queued", "running", "failed", "cancelled"]),
  failed: new Set(["queued", "cancelled"]),
  completed: new Set([]),
  cancelled: new Set([]),
};

function publicTask(row, extra = {}) {
  return {
    id: row.id,
    parentId: row.parent_id || null,
    botId: row.bot_id || null,
    teamId: row.team_id || null,
    title: row.title,
    objective: row.objective,
    status: row.status,
    depth: Number(row.depth),
    dependsOn: parse(row.depends_on, []),
    inputs: parse(row.inputs, null),
    deliverable: row.deliverable || "",
    acceptance: row.acceptance || "",
    deadline: row.deadline === null || row.deadline === undefined ? null : Number(row.deadline),
    priority: row.priority || "normal",
    project: row.project || "",
    result: parse(row.result, null),
    error: row.error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    ...extra,
  };
}

async function loadTask(db, userId, taskId) {
  const row = (await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [userId, requireId(taskId, "task")])).rows[0];
  if (!row) throw fail(404, "That task doesn't exist.", "not-found");
  return row;
}

async function assertBot(db, userId, botId) {
  const bot = await canUseBot(db, userId, clean(botId, 80));
  if (!bot) throw fail(404, "That teammate doesn't exist.", "not-found");
  return bot;
}

function validateStatus(from, to) {
  if (!TASK_STATUSES.has(to)) throw fail(400, `status must be one of ${[...TASK_STATUSES].join(", ")}.`, "invalid");
  if (!TRANSITIONS[from]?.has(to)) throw fail(409, `A ${from} task can't become ${to}.`, "invalid-transition");
}

async function insertTask(db, userId, task, at) {
  const run = typeof db === "function" ? db : db.query.bind(db);
  await run(
    `INSERT INTO hannah_workforce_tasks (user_id, id, parent_id, bot_id, team_id, title, objective, status, depth, depends_on, inputs, deliverable, acceptance, deadline, priority, project, result, error, continuation, created_at, updated_at, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL, NULL, NULL, $17, $17, NULL, NULL)`,
    [userId, task.id, task.parentId, task.botId, task.teamId, task.title, task.objective, task.status || "queued", task.depth, JSON.stringify(task.dependsOn || []),
      task.inputs ? JSON.stringify(task.inputs).slice(0, 50_000) : null, task.deliverable || "", task.acceptance || "", task.deadline || null, task.priority || "normal", task.project || "", at],
  );
}

function createTasksRouter() {
  const router = express.Router();

  router.get("/workforce/tasks", withAccount(async (req, res, db, account) => {
    const clauses = ["user_id = $1"];
    const params = [account.id];
    const push = (column, value) => { params.push(value); clauses.push(`${column} = $${params.length}`); };
    const status = clean(req.query.status, 30);
    if (status && TASK_STATUSES.has(status)) push("status", status);
    if (req.query.botId) push("bot_id", clean(req.query.botId, 80));
    if (req.query.parentId) push("parent_id", clean(req.query.parentId, 80));
    if (req.query.project) push("project", clean(req.query.project, 80));
    const { rows } = await db.query(`SELECT * FROM hannah_workforce_tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`, params);
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    res.json({ tasks: rows.map((row) => publicTask(row)), counts });
  }));

  router.post("/workforce/tasks", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const title = clean(body.title, 160);
    const objective = cleanMultiline(body.objective, 8000);
    if (!title) throw fail(400, "Give the task a title.", "invalid");
    if (!objective) throw fail(400, "Describe the work to do.", "invalid");
    const bot = await assertBot(db, account.id, body.botId);
    let parent = null;
    if (body.parentId) {
      parent = await loadTask(db, account.id, body.parentId);
      if (FINAL.has(parent.status)) throw fail(409, "That parent task is already finished.", "parent-final");
      if (Number(parent.depth) >= MAX_DEPTH) throw fail(400, `Delegation is limited to ${MAX_DEPTH} levels.`, "depth-limit");
      const children = await db.query("SELECT COUNT(*) AS count FROM hannah_workforce_tasks WHERE user_id = $1 AND parent_id = $2", [account.id, parent.id]);
      if (Number(children.rows[0].count) >= MAX_CHILDREN) throw fail(400, `A task can delegate to ${MAX_CHILDREN} teammates at most.`, "fan-out-limit");
    }
    const dependsOn = asArray(body.dependsOn, 20);
    if (dependsOn.length) {
      const found = await db.query(`SELECT id FROM hannah_workforce_tasks WHERE user_id = $1 AND id IN (${dependsOn.map((_, index) => `$${index + 2}`).join(", ")})`, [account.id, ...dependsOn]);
      if (found.rows.length !== dependsOn.length) throw fail(400, "A dependency isn't one of your tasks.", "invalid-dependency");
    }
    const at = Date.now();
    const taskId = id("task");
    await insertTask(db, account.id, {
      id: taskId, parentId: parent?.id || null, botId: bot.id, teamId: bot.team_id || null, title, objective,
      depth: parent ? Number(parent.depth) + 1 : 0, dependsOn, inputs: asObject(body.inputs), deliverable: clean(body.deliverable, 1000),
      acceptance: clean(body.acceptance, 1000), deadline: body.deadline ? Number(new Date(body.deadline)) : null,
      priority: ["low", "normal", "high", "urgent"].includes(body.priority) ? body.priority : "normal", project: clean(body.project, 80),
    }, at);
    if (parent) {
      await db.query("INSERT INTO hannah_task_handoffs (user_id, id, task_id, from_bot_id, to_bot_id, note, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'created', $7)",
        [account.id, id("hnd"), taskId, parent.bot_id || null, bot.id, clean(body.note, 500), at]);
    }
    await recordEvent(db, account.id, parent ? "task.delegated" : "task.created", { botId: bot.id, taskId, detail: { title, parentId: parent?.id || null, depth: parent ? Number(parent.depth) + 1 : 0 } });
    res.status(201).json({ task: publicTask((await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, taskId])).rows[0]) });
  }));

  /** Create one parent task and a bounded set of delegated steps in one transaction. */
  router.post("/workforce/tasks/plan", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const title = clean(body.title, 160);
    const objective = cleanMultiline(body.objective, 8000);
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, MAX_CHILDREN) : [];
    if (!title || !objective) throw fail(400, "A plan needs a title and an objective.", "invalid");
    if (!steps.length) throw fail(400, "Add at least one step.", "invalid");
    const at = Date.now();
    const rootId = id("task");
    const resolvedBots = [];
    for (const step of steps) resolvedBots.push(await assertBot(db, account.id, step.botId));
    const plan = await db.transaction(async (query) => {
      await insertTask(query, account.id, { id: rootId, botId: null, title, objective, depth: 0, dependsOn: [], priority: "normal" }, at);
      const created = [];
      for (const [index, step] of steps.entries()) {
        const bot = resolvedBots[index];
        const stepId = id("task");
        const dependencies = asArray(step.dependsOn, 8).map((depIndex) => created[Number(depIndex)]?.id).filter(Boolean);
        await insertTask(query, account.id, {
          id: stepId, parentId: rootId, botId: bot.id, teamId: bot.team_id || null, title: clean(step.title, 160) || `${bot.name} step`,
          objective: cleanMultiline(step.objective, 6000), depth: 1, dependsOn: dependencies, inputs: asObject(step.inputs),
          deliverable: clean(step.deliverable, 1000), acceptance: clean(step.acceptance, 1000), deadline: step.deadline ? Number(new Date(step.deadline)) : null,
          priority: ["low", "normal", "high", "urgent"].includes(step.priority) ? step.priority : "normal", project: clean(body.project, 80),
        }, at);
        await query("INSERT INTO hannah_task_handoffs (user_id, id, task_id, from_bot_id, to_bot_id, note, status, created_at) VALUES ($1, $2, $3, NULL, $4, $5, 'created', $6)", [account.id, id("hnd"), stepId, bot.id, "Delegated by a plan", at]);
        created.push({ id: stepId, botId: bot.id });
      }
      return created;
    });
    await recordEvent(db, account.id, "task.plan_created", { taskId: rootId, detail: { steps: plan.length } });
    const { rows } = await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND (id = $2 OR parent_id = $2) ORDER BY created_at", [account.id, rootId]);
    res.status(201).json({ task: publicTask(rows.find((row) => row.id === rootId)), children: rows.filter((row) => row.parent_id === rootId).map((row) => publicTask(row)) });
  }));

  router.get("/workforce/tasks/:id", withAccount(async (req, res, db, account) => {
    const row = await loadTask(db, account.id, req.params.id);
    const children = (await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND parent_id = $2 ORDER BY created_at", [account.id, row.id])).rows.map((item) => publicTask(item));
    const handoffs = (await db.query("SELECT * FROM hannah_task_handoffs WHERE user_id = $1 AND task_id = $2 ORDER BY created_at", [account.id, row.id])).rows.map((item) => ({ id: item.id, fromBotId: item.from_bot_id, toBotId: item.to_bot_id, note: item.note || "", status: item.status, createdAt: Number(item.created_at) }));
    const events = (await db.query("SELECT * FROM hannah_workforce_events WHERE user_id = $1 AND task_id = $2 ORDER BY created_at DESC LIMIT 100", [account.id, row.id])).rows.map((item) => ({ id: item.id, kind: item.kind, severity: item.severity, botId: item.bot_id, detail: parse(item.detail, null), createdAt: Number(item.created_at) }));
    res.json({ task: publicTask(row), children, handoffs, events });
  }));

  router.post("/workforce/tasks/:id/status", withAccount(async (req, res, db, account) => {
    const row = await loadTask(db, account.id, req.params.id);
    const body = readBody(req);
    const status = String(body.status || "");
    validateStatus(row.status, status);
    if (status === "completed" && !String(body.result || "").trim() && !parse(row.result, null)) throw fail(400, "A completed task needs a result. Say what was produced and where it is.", "result-required");
    const at = Date.now();
    const result = body.result === undefined ? parse(row.result, null) : (typeof body.result === "string" ? { summary: cleanMultiline(body.result, 20_000) } : asObject(body.result));
    const startedAt = row.started_at === null || row.started_at === undefined ? (status === "running" ? at : null) : Number(row.started_at);
    const finishedAt = FINAL.has(status) ? at : null;
    await db.query("UPDATE hannah_workforce_tasks SET status = $1, result = $2, error = $3, updated_at = $4, started_at = $5, finished_at = $6 WHERE user_id = $7 AND id = $8",
      [status, result ? JSON.stringify(result).slice(0, 100_000) : null, body.error ? clean(body.error, 2000) : null, at, startedAt, finishedAt, account.id, row.id]);
    await recordEvent(db, account.id, `task.${status}`, { botId: row.bot_id, taskId: row.id, detail: { title: row.title, summary: result?.summary ? clean(result.summary, 300) : null } });
    res.json({ task: publicTask((await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0]) });
  }));

  router.post("/workforce/tasks/:id/delegate", withAccount(async (req, res, db, account) => {
    const parent = await loadTask(db, account.id, req.params.id);
    if (FINAL.has(parent.status)) throw fail(409, "That task is finished.", "parent-final");
    const body = readBody(req);
    if (Number(parent.depth) >= MAX_DEPTH) throw fail(400, `Delegation is limited to ${MAX_DEPTH} levels.`, "depth-limit");
    const bot = await assertBot(db, account.id, body.botId);
    const at = Date.now();
    const taskId = id("task");
    await insertTask(db, account.id, {
      id: taskId, parentId: parent.id, botId: bot.id, teamId: bot.team_id || null, title: clean(body.title, 160) || `${bot.name}: ${parent.title}`,
      objective: cleanMultiline(body.objective, 8000) || parent.objective, depth: Number(parent.depth) + 1, dependsOn: asArray(body.dependsOn, 10),
      inputs: asObject(body.inputs), deliverable: clean(body.deliverable, 1000), acceptance: clean(body.acceptance, 1000),
      deadline: body.deadline ? Number(new Date(body.deadline)) : null, priority: parent.priority, project: parent.project,
    }, at);
    await db.query("INSERT INTO hannah_task_handoffs (user_id, id, task_id, from_bot_id, to_bot_id, note, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'delegated', $7)",
      [account.id, id("hnd"), taskId, parent.bot_id || null, bot.id, clean(body.note, 500), at]);
    await recordEvent(db, account.id, "task.delegated", { botId: bot.id, taskId, detail: { parentId: parent.id, title: clean(body.title, 160) } });
    res.status(201).json({ task: publicTask((await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, taskId])).rows[0]) });
  }));

  router.post("/workforce/tasks/:id/handoff", withAccount(async (req, res, db, account) => {
    const row = await loadTask(db, account.id, req.params.id);
    if (FINAL.has(row.status)) throw fail(409, "That task is finished.", "task-final");
    const body = readBody(req);
    const bot = await assertBot(db, account.id, body.botId);
    if (bot.id === row.bot_id) throw fail(400, "That teammate already has this task.", "invalid");
    const at = Date.now();
    await db.query("UPDATE hannah_workforce_tasks SET bot_id = $1, team_id = $2, status = 'queued', updated_at = $3 WHERE user_id = $4 AND id = $5", [bot.id, bot.team_id || null, at, account.id, row.id]);
    await db.query("INSERT INTO hannah_task_handoffs (user_id, id, task_id, from_bot_id, to_bot_id, note, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'handed-off', $7)",
      [account.id, id("hnd"), row.id, row.bot_id || null, bot.id, clean(body.note, 500), at]);
    await recordEvent(db, account.id, "task.handed_off", { botId: bot.id, taskId: row.id, detail: { from: row.bot_id, to: bot.id } });
    res.json({ task: publicTask((await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0]) });
  }));

  router.post("/workforce/tasks/:id/verify", withAccount(async (req, res, db, account) => {
    const row = await loadTask(db, account.id, req.params.id);
    if (row.status !== "completed") throw fail(409, "Only a completed task can be verified.", "not-completed");
    const body = readBody(req);
    const reviewer = await assertBot(db, account.id, body.reviewerBotId);
    if (reviewer.id === row.bot_id) throw fail(400, "The teammate that did the work can't verify it. Choose a different teammate.", "self-verify");
    const verdict = String(body.verdict || "");
    if (!["pass", "fail"].includes(verdict)) throw fail(400, "verdict must be pass or fail.", "invalid");
    const result = parse(row.result, {}) || {};
    const verification = {
      verdict, reviewerBotId: reviewer.id, reviewerName: reviewer.name, checks: asArray(body.checks, 20), notes: cleanMultiline(body.notes, 3000),
      evidence: asArray(body.evidence, 20), at: Date.now(),
    };
    const next = { ...result, verification };
    await db.query("UPDATE hannah_workforce_tasks SET result = $1, status = $2, updated_at = $3 WHERE user_id = $4 AND id = $5",
      [JSON.stringify(next).slice(0, 100_000), verdict === "fail" ? "failed" : row.status, Date.now(), account.id, row.id]);
    await recordEvent(db, account.id, `task.verification_${verdict}`, { botId: reviewer.id, taskId: row.id, detail: { notes: verification.notes.slice(0, 300) } });
    res.json({ task: publicTask((await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0]) });
  }));

  router.post("/workforce/tasks/:id/run", withAccount(async (req, res, db, account) => {
    const row = await loadTask(db, account.id, req.params.id);
    if (["completed", "cancelled"].includes(row.status)) throw fail(409, "That task is already finished.", "finished");
    if (row.status === "running") throw fail(409, "That task is already running.", "already-running");
    if (row.status === "waiting-approval") throw fail(409, "That task is waiting for an approval. Decide it in Actions first.", "waiting-approval");
    await db.query("UPDATE hannah_workforce_tasks SET status = 'queued', error = NULL, updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, row.id]);
    const { runTask } = require("./runner");
    const outcome = await runTask(db, account.id, row.id);
    res.json({
      task: publicTask(outcome.task),
      outcome: outcome.outcome || null,
      note: outcome.task?.error || (outcome.task?.status === "waiting-approval" ? "The run stopped at an approval. Decide it in Actions, then run the task again." : null),
    });
  }));

  return router;
}

module.exports = { MAX_CHILDREN, MAX_DEPTH, createTasksRouter, publicTask };
