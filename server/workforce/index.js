"use strict";

/**
 * The AI Workforce router and its background worker.
 *
 * Everything is mounted under /api/workforce. The worker is the same durable
 * pattern as HANNAH's workflow runtime: a long-running server schedules its own
 * ticks, while serverless deployments call POST /workforce/tick from a cron with
 * CRON_SECRET. A tick fires due routines, runs a few queued tasks and mirrors
 * their outcome into routine history.
 */
const express = require("express");
const { vaultConfigured } = require("../vault");
const { canUseBot, clean, parse, publicEvent, withAccount } = require("./common");
const { createBotsRouter } = require("./bots");
const { createTeamsRouter } = require("./teams");
const { createMemoryRouter } = require("./memory");
const { createApprovalsRouter } = require("./approvals");
const { createSecretsRouter } = require("./secrets");
const { createComputersRouter } = require("./computers");
const { createTasksRouter } = require("./tasks");
const { createSkillsRouter } = require("./skills");
const { createRoutinesRouter, tick } = require("./routines");
const { createArtifactsRouter } = require("./artifacts");
const { createProactiveRouter } = require("./proactive");
const { createMeetingsRouter } = require("./meetings");
const { createConversationsRouter } = require("./conversations");
const { createUsageRouter } = require("./usage");
const { createHardwareRouter, setOperator } = require("./hardware");
const { createNotificationsRouter, startNotifications } = require("./notify");
const { createLocalRouter } = require("./local");
const { createRoutineHooksRouter } = require("./routine-hooks");
const { modelTarget } = require("./runner");
const browser = require("./browser");

/**
 * `operator` is the server's shared robot registry, device registry and Action
 * Engine (or a function returning it), so teammates use the same hardware path
 * as everything else.
 */
function createWorkforceRouter({ operator = null } = {}) {
  const router = express.Router();
  if (operator) setOperator(operator);
  startNotifications();

  router.get("/workforce/overview", withAccount(async (_req, res, db, account) => {
    const counts = {};
    const count = async (key, sql, params = [account.id]) => {
      const { rows } = await db.query(sql, params);
      counts[key] = Number(rows[0]?.count || 0);
    };
    await Promise.all([
      count("bots", "SELECT COUNT(*) AS count FROM hannah_bots WHERE user_id = $1 AND archived_at IS NULL"),
      count("activeBots", "SELECT COUNT(*) AS count FROM hannah_bots WHERE user_id = $1 AND archived_at IS NULL AND status = 'active'"),
      count("tasks", "SELECT COUNT(*) AS count FROM hannah_workforce_tasks WHERE user_id = $1"),
      count("queuedTasks", "SELECT COUNT(*) AS count FROM hannah_workforce_tasks WHERE user_id = $1 AND status = 'queued'"),
      count("waitingTasks", "SELECT COUNT(*) AS count FROM hannah_workforce_tasks WHERE user_id = $1 AND status IN ('waiting-approval','blocked')"),
      count("pendingApprovals", "SELECT COUNT(*) AS count FROM hannah_workforce_approvals WHERE user_id = $1 AND status = 'pending'"),
      count("computers", "SELECT COUNT(*) AS count FROM hannah_computers WHERE user_id = $1"),
      count("runningComputers", "SELECT COUNT(*) AS count FROM hannah_computers WHERE user_id = $1 AND status = 'running'"),
      count("skills", "SELECT COUNT(*) AS count FROM hannah_workforce_skills WHERE user_id = $1 AND archived_at IS NULL"),
      count("routines", "SELECT COUNT(*) AS count FROM hannah_routines WHERE user_id = $1"),
      count("activeRoutines", "SELECT COUNT(*) AS count FROM hannah_routines WHERE user_id = $1 AND status = 'active'"),
      count("artifacts", "SELECT COUNT(*) AS count FROM hannah_artifacts WHERE user_id = $1"),
      count("secrets", "SELECT COUNT(*) AS count FROM hannah_workforce_secrets WHERE user_id = $1 AND revoked_at IS NULL"),
      count("proactiveOffers", "SELECT COUNT(*) AS count FROM hannah_proactive_offers WHERE user_id = $1 AND status = 'pending'"),
      count("meetings", "SELECT COUNT(*) AS count FROM hannah_meetings WHERE user_id = $1"),
      count("teams", "SELECT COUNT(*) AS count FROM hannah_team_members WHERE user_id = $1"),
    ]);
    const teamIds = (await db.query("SELECT team_id FROM hannah_team_members WHERE user_id = $1", [account.id])).rows.map((row) => row.team_id);
    let teamBots = 0;
    if (teamIds.length) {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS count FROM hannah_bots WHERE team_id IN (${teamIds.map((_, index) => `$${index + 2}`).join(", ")}) AND published_at IS NOT NULL AND archived_at IS NULL AND user_id <> $1`,
        [account.id, ...teamIds],
      );
      teamBots = Number(rows[0]?.count || 0);
    }
    const events = (await db.query("SELECT * FROM hannah_workforce_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15", [account.id])).rows.map(publicEvent);
    const probe = await modelTarget(db, account.id, null).catch(() => null);
    res.json({
      counts: { ...counts, teamBots },
      capabilities: {
        database: true,
        vault: vaultConfigured(),
        browser: (await browser.status()).available,
        model: probe ? { available: true, provider: probe.provider.label, model: probe.model, keySource: probe.keySource } : { available: false, reason: "No AI provider key is configured for this account." },
        meetings: { liveJoin: false, transcriptImport: true },
        tick: { configured: Boolean(process.env.CRON_SECRET), worker: process.env.WORKFORCE_WORKER !== "off" },
        isolation: "workspace-directory",
        computerIsolationNote: "A workspace is a directory under the server user, not a virtual machine. Run the server in a container for stronger isolation.",
      },
      events,
      serverTime: Date.now(),
    });
  }));

  router.get("/workforce/events", withAccount(async (req, res, db, account) => {
    const clauses = ["user_id = $1"];
    const params = [account.id];
    const push = (column, value) => { params.push(value); clauses.push(`${column} = $${params.length}`); };
    if (req.query.botId) push("bot_id", clean(req.query.botId, 80));
    if (req.query.taskId) push("task_id", clean(req.query.taskId, 80));
    if (req.query.kind) push("kind", clean(req.query.kind, 80));
    if (req.query.severity && ["low", "medium", "high", "critical"].includes(String(req.query.severity))) push("severity", String(req.query.severity));
    const since = Number(req.query.since);
    if (Number.isFinite(since) && since > 0) { params.push(since); clauses.push(`created_at >= $${params.length}`); }
    const { rows } = await db.query(`SELECT * FROM hannah_workforce_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ events: rows.map(publicEvent) });
  }));

  /**
   * A single teammate's durable status: the bot, its recent events and the
   * tasks that are waiting on it. Used by the detail panel so the screen never
   * has to guess.
   */
  router.get("/workforce/bots/:id/activity", withAccount(async (req, res, db, account) => {
    const bot = await canUseBot(db, account.id, clean(req.params.id, 80));
    if (!bot) return res.status(404).json({ error: "That teammate doesn't exist.", reason: "not-found" });
    const events = (await db.query("SELECT * FROM hannah_workforce_events WHERE user_id = $1 AND bot_id = $2 ORDER BY created_at DESC LIMIT 50", [account.id, bot.id])).rows.map(publicEvent);
    const tasks = (await db.query("SELECT id, title, status, priority, updated_at FROM hannah_workforce_tasks WHERE user_id = $1 AND bot_id = $2 ORDER BY updated_at DESC LIMIT 20", [account.id, bot.id])).rows
      .map((row) => ({ id: row.id, title: row.title, status: row.status, priority: row.priority, updatedAt: Number(row.updated_at) }));
    res.json({
      bot: { id: bot.id, name: bot.name, status: bot.status, autonomy: bot.autonomy, version: Number(bot.version) },
      events,
      tasks,
      autonomy: parse(bot.model_prefs, {}),
    });
  }));

  router.use(createBotsRouter());
  router.use(createTeamsRouter());
  router.use(createMemoryRouter());
  router.use(createApprovalsRouter());
  router.use(createSecretsRouter());
  router.use(createComputersRouter());
  router.use(createTasksRouter());
  router.use(createSkillsRouter());
  router.use(createRoutinesRouter());
  router.use(createArtifactsRouter());
  router.use(createProactiveRouter());
  router.use(createMeetingsRouter());
  router.use(createConversationsRouter());
  router.use(createUsageRouter());
  router.use(createHardwareRouter());
  router.use(createNotificationsRouter());
  router.use(createLocalRouter());
  router.use(createRoutineHooksRouter());

  return router;
}

let timer = null;
let ticking = false;

function startWorker({ intervalMs = Number(process.env.WORKFORCE_WORKER_INTERVAL_MS) || 60_000 } = {}) {
  if (timer || process.env.WORKFORCE_WORKER === "off") return;
  const run = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tick({ budgetMs: Math.min(90_000, Math.max(10_000, intervalMs * 2)) });
    } catch (error) {
      console.error(`Workforce worker tick failed (${error?.code || error?.name || "error"}).`);
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(() => { void run(); }, Math.max(15_000, intervalMs));
  timer.unref?.();
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { createWorkforceRouter, startWorker, stopWorker, tick };
