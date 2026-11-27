"use strict";

/**
 * Workforce usage limits.
 *
 * Two kinds of work are counted over a rolling 24 hours:
 *   tasks     every task created for a teammate (by a person, a plan, a
 *             delegation, a routine or a meeting action)
 *   messages  every conversation message that asks the teammate's model to answer
 *
 * The account has a ceiling set by the operator (environment). A teammate's own
 * limits can only be lower, never higher: a value above the ceiling is clamped
 * when the teammate is saved. Counts come from the durable rows themselves, so
 * there is no separate counter that could drift or reset on restart.
 */
const express = require("express");
const { asObject, fail, parse, withAccount } = require("./common");

const WINDOW_MS = 24 * 60 * 60_000;
const KEYS = ["tasksPerDay", "messagesPerDay"];

function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The operator's ceiling for one account. Read on every call so tests and operators can change it. */
function accountLimits() {
  return {
    tasksPerDay: envLimit("WORKFORCE_ACCOUNT_TASKS_PER_DAY", 300),
    messagesPerDay: envLimit("WORKFORCE_ACCOUNT_MESSAGES_PER_DAY", 600),
  };
}

/** The default for a teammate that sets nothing. */
function defaultBotLimits() {
  const ceiling = accountLimits();
  return {
    tasksPerDay: Math.min(ceiling.tasksPerDay, envLimit("WORKFORCE_BOT_TASKS_PER_DAY", 60)),
    messagesPerDay: Math.min(ceiling.messagesPerDay, envLimit("WORKFORCE_BOT_MESSAGES_PER_DAY", 200)),
  };
}

/**
 * Clean a teammate's `limits` before it is saved. Known keys become integers
 * between 1 and the account ceiling; unknown keys are kept as they were so a
 * client's own notes aren't lost, but they are never enforced.
 */
function normalizeLimits(input) {
  const raw = asObject(input);
  const ceiling = accountLimits();
  const out = { ...raw };
  for (const key of KEYS) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === "") { delete out[key]; continue; }
    const value = Math.floor(Number(raw[key]));
    if (!Number.isFinite(value) || value < 1) throw fail(400, `${key} must be a whole number of at least 1.`, "invalid");
    out[key] = Math.min(value, ceiling[key]);
  }
  return out;
}

/** What a teammate may use, with defaults filled in. */
function botLimits(bot) {
  const ceiling = accountLimits();
  const defaults = defaultBotLimits();
  const raw = parse(bot?.limits, {}) || {};
  const result = {};
  for (const key of KEYS) {
    const value = Math.floor(Number(raw[key]));
    result[key] = Number.isFinite(value) && value >= 1 ? Math.min(value, ceiling[key]) : defaults[key];
  }
  return result;
}

const run = (db) => (typeof db === "function" ? db : db.query.bind(db));

async function countTasks(db, userId, botId, since) {
  const sql = botId
    ? "SELECT COUNT(*) AS count FROM hannah_workforce_tasks WHERE user_id = $1 AND bot_id = $2 AND created_at > $3"
    : "SELECT COUNT(*) AS count FROM hannah_workforce_tasks WHERE user_id = $1 AND created_at > $2";
  const { rows } = await run(db)(sql, botId ? [userId, botId, since] : [userId, since]);
  return Number(rows[0]?.count || 0);
}

// Messages are counted from the event log, not the conversation table: clearing a
// conversation deletes its messages, and that must not reset the limit.
async function countMessages(db, userId, botId, since) {
  const sql = botId
    ? "SELECT COUNT(*) AS count FROM hannah_workforce_events WHERE user_id = $1 AND bot_id = $2 AND kind = 'conversation.message' AND created_at > $3"
    : "SELECT COUNT(*) AS count FROM hannah_workforce_events WHERE user_id = $1 AND kind = 'conversation.message' AND created_at > $2";
  const { rows } = await run(db)(sql, botId ? [userId, botId, since] : [userId, since]);
  return Number(rows[0]?.count || 0);
}

function limitError(what, scope, used, limit, name) {
  const who = scope === "account" ? "Your account" : name;
  return fail(429, `${who} reached its limit of ${limit} ${what} in 24 hours (${used} used). Raise the limit in the teammate's settings or try again later.`, "usage-limit", {
    details: { kind: what, scope, used, limit },
  });
}

/**
 * Throw when creating `count` more tasks for this teammate would pass a limit.
 * `db` may be the database or a transaction's query function.
 */
async function assertTaskAllowance(db, userId, bot, count = 1, at = Date.now()) {
  const since = at - WINDOW_MS;
  const ceiling = accountLimits();
  const own = botLimits(bot);
  const accountUsed = await countTasks(db, userId, null, since);
  if (accountUsed + count > ceiling.tasksPerDay) throw limitError("tasks", "account", accountUsed, ceiling.tasksPerDay);
  const botUsed = await countTasks(db, userId, bot.id, since);
  if (botUsed + count > own.tasksPerDay) throw limitError("tasks", "bot", botUsed, own.tasksPerDay, bot.name);
}

/** Throw when one more model-backed message would pass a limit. */
async function assertMessageAllowance(db, userId, bot, at = Date.now()) {
  const since = at - WINDOW_MS;
  const ceiling = accountLimits();
  const own = botLimits(bot);
  const accountUsed = await countMessages(db, userId, null, since);
  if (accountUsed + 1 > ceiling.messagesPerDay) throw limitError("messages", "account", accountUsed, ceiling.messagesPerDay);
  const botUsed = await countMessages(db, userId, bot.id, since);
  if (botUsed + 1 > own.messagesPerDay) throw limitError("messages", "bot", botUsed, own.messagesPerDay, bot.name);
}

async function messagesUsed(db, userId, botId, at = Date.now()) {
  return countMessages(db, userId, botId, at - WINDOW_MS);
}

async function usageFor(db, userId, bots, at = Date.now()) {
  const since = at - WINDOW_MS;
  const ceiling = accountLimits();
  const account = {
    tasks: { used: await countTasks(db, userId, null, since), limit: ceiling.tasksPerDay },
    messages: { used: await countMessages(db, userId, null, since), limit: ceiling.messagesPerDay },
  };
  const perBot = [];
  for (const bot of bots) {
    const limits = botLimits(bot);
    perBot.push({
      botId: bot.id,
      name: bot.name,
      tasks: { used: await countTasks(db, userId, bot.id, since), limit: limits.tasksPerDay },
      messages: { used: await countMessages(db, userId, bot.id, since), limit: limits.messagesPerDay },
    });
  }
  return { window: "24h", since, account, bots: perBot, defaults: defaultBotLimits() };
}

function createUsageRouter() {
  const router = express.Router();

  router.get("/workforce/usage", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200", [account.id]);
    res.json(await usageFor(db, account.id, rows));
  }));

  return router;
}

module.exports = {
  WINDOW_MS, accountLimits, assertMessageAllowance, assertTaskAllowance, botLimits, createUsageRouter, messagesUsed, defaultBotLimits, normalizeLimits, usageFor,
};
