"use strict";

/**
 * Workforce notifications.
 *
 * Three kinds of event are worth telling a person about:
 *   approvals    a teammate is waiting for a decision
 *   completions  a task finished
 *   failures     a task is blocked or failed, or a routine couldn't run
 *
 * Where they go:
 *   - in the app, always: Agent Activity and the notification feed read the
 *     event log (GET /workforce/notifications);
 *   - account webhooks, as workforce.approval.requested,
 *     workforce.task.completed and workforce.task.failed (signed like every
 *     HANNAH webhook; workflows can trigger on them too);
 *   - chat apps the person chose (Telegram, Slack, Microsoft Teams, WhatsApp),
 *     to the chat they paired. An approval notice names the request so the
 *     owner can answer "approve apv_…" or "deny apv_…" there.
 *
 * The person controls categories and destinations; a teammate's own
 * notification settings can mute it; quiet hours (from Proactive settings)
 * hold chat and webhook messages, which stay in the app. Every attempt is
 * logged with its outcome: sent, failed with the platform's reason, or held.
 * Notification text never includes a secret or the content of a document.
 */
const express = require("express");
const { asArray, canUseBot, clean, fail, id, onWorkforceEvent, parse, publicEvent, readBody, withAccount } = require("./common");

const CATEGORY_FOR = {
  "approval.requested": "approvals",
  "task.completed": "completions",
  "task.blocked": "failures",
  "task.failed": "failures",
  "task.verification_fail": "failures",
  "routine.limit_reached": "failures",
  "routine.skill_missing": "failures",
  "local.job_failed": "failures",
};
const WEBHOOK_EVENT = { approvals: "workforce.approval.requested", completions: "workforce.task.completed", failures: "workforce.task.failed" };
const CATEGORIES = ["approvals", "completions", "failures"];
const DEFAULTS = { categories: { approvals: true, completions: true, failures: true }, channelIds: [], webhooks: true, quietHours: true };
const MAX_CHANNELS = 5;

const pending = new Set();

/** Settle every notification still being delivered (tests, and graceful shutdown). */
async function flush() {
  while (pending.size) await Promise.allSettled([...pending]);
}

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  // On a serverless platform, keep the function alive until delivery finishes.
  const context = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (typeof context?.waitUntil === "function") context.waitUntil(promise.catch(() => {}));
  return promise;
}

function normalizeSettings(input, base = DEFAULTS) {
  const raw = input && typeof input === "object" ? input : {};
  const categories = { ...base.categories };
  for (const key of CATEGORIES) if (typeof raw.categories?.[key] === "boolean") categories[key] = raw.categories[key];
  return {
    categories,
    channelIds: raw.channelIds === undefined ? base.channelIds : asArray(raw.channelIds, MAX_CHANNELS),
    webhooks: typeof raw.webhooks === "boolean" ? raw.webhooks : base.webhooks,
    quietHours: typeof raw.quietHours === "boolean" ? raw.quietHours : base.quietHours,
  };
}

async function loadSettings(db, userId) {
  const row = (await db.query("SELECT settings FROM hannah_workforce_notify_settings WHERE user_id = $1", [userId])).rows[0];
  return normalizeSettings(parse(row?.settings, {}), DEFAULTS);
}

async function logDelivery(db, userId, event, target, status, detail = null) {
  await db.query(
    "INSERT INTO hannah_workforce_deliveries (user_id, id, event_id, event_kind, target, status, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [userId, id("dlv"), event.id || null, clean(event.kind, 80), clean(target, 120), status, detail ? JSON.stringify(detail).slice(0, 2000) : null, Date.now()],
  ).catch(() => {});
}

function publicBase() {
  return String(process.env.HANNAH_PUBLIC_URL || "").trim().replace(/\/+$/, "");
}

/** The words for one event. Names and titles only; never task inputs, documents or secrets. */
async function compose(db, userId, event, bot) {
  const detail = event.detail || {};
  const task = event.taskId ? (await db.query("SELECT title FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [userId, event.taskId])).rows[0] : null;
  const who = bot?.name || "A teammate";
  const what = task?.title ? `"${clean(task.title, 120)}"` : "a task";
  const link = publicBase() ? `\n${publicBase()}/activity` : "";
  switch (event.kind) {
    case "approval.requested": {
      const approval = detail.approvalId ? (await db.query("SELECT title, risk FROM hannah_workforce_approvals WHERE user_id = $1 AND id = $2", [userId, detail.approvalId])).rows[0] : null;
      return `${who} needs your approval for ${what}: ${clean(approval?.title || detail.action, 160)} (${detail.risk || approval?.risk || "medium"} risk).\nReply "approve ${detail.approvalId}" or "deny ${detail.approvalId}", or decide in Agent Activity.${link ? `${link}#approvals` : ""}`;
    }
    case "task.completed":
      return `${who} finished ${what}.${detail.summary ? ` ${clean(detail.summary, 240)}` : ""}${link ? `${link}#tasks` : ""}`;
    case "task.blocked":
    case "task.failed":
      return `${what} is ${event.kind === "task.blocked" ? "blocked" : "failed"}${detail.reason ? `: ${clean(detail.reason, 240)}` : "."}${link ? `${link}#tasks` : ""}`;
    case "task.verification_fail":
      return `A review of ${what} failed${detail.notes ? `: ${clean(detail.notes, 200)}` : "."}${link ? `${link}#tasks` : ""}`;
    case "routine.limit_reached":
      return `A routine didn't run: ${who} reached its daily task limit (${detail.used ?? "?"} of ${detail.limit ?? "?"}).${link}`;
    case "local.job_failed":
      return `A ${clean(detail.kind, 20) || "desktop"} job for ${what} didn't run on ${clean(detail.device, 80) || "your computer"}${detail.reason ? `: ${clean(detail.reason, 200)}` : "."}${link ? `${link}#tasks` : ""}`;
    case "routine.skill_missing":
      return `A routine was paused because its skill is missing.${link}`;
    default:
      return `${who}: ${event.kind}`;
  }
}

async function deliver(db, userId, event) {
  const category = CATEGORY_FOR[event.kind];
  if (!category) return;
  const settings = await loadSettings(db, userId);
  if (!settings.categories[category]) return;
  const bot = event.botId ? await canUseBot(db, userId, event.botId) : null;
  if (bot && parse(bot.notifications, {})?.[category] === false) {
    await logDelivery(db, userId, event, `teammate:${bot.id}`, "muted", { reason: `${bot.name}'s notification settings turn ${category} off.` });
    return;
  }
  const targets = [...(settings.webhooks ? ["webhooks"] : []), ...settings.channelIds.map((channelId) => `channel:${channelId}`)];
  if (!targets.length) return;
  if (settings.quietHours) {
    const { inQuietHours, publicSettings } = require("./proactive");
    const row = (await db.query("SELECT * FROM hannah_proactive_settings WHERE user_id = $1", [userId])).rows[0];
    if (row && inQuietHours(publicSettings(row, userId))) {
      for (const target of targets) await logDelivery(db, userId, event, target, "held-quiet-hours");
      return;
    }
  }
  const text = await compose(db, userId, event, bot);

  if (settings.webhooks) {
    const { emitUserEvent } = require("../webhooks");
    const statuses = await emitUserEvent(userId, WEBHOOK_EVENT[category], { kind: event.kind, botId: event.botId, botName: bot?.name || null, taskId: event.taskId, eventId: event.id, text, approvalId: event.detail?.approvalId || null, at: event.createdAt }).catch(() => []);
    if (statuses.length) await logDelivery(db, userId, event, "webhooks", statuses.every((status) => status >= 200 && status < 300) ? "sent" : "failed", { statuses });
  }
  for (const channelId of settings.channelIds) {
    const row = (await db.query("SELECT * FROM hannah_channels WHERE id = $1 AND user_id = $2", [channelId, userId])).rows[0];
    if (!row) {
      await logDelivery(db, userId, event, `channel:${channelId}`, "failed", { reason: "That chat app is no longer connected." });
      continue;
    }
    try {
      const { sendToChannelOwner } = require("../channels");
      await sendToChannelOwner(db, row, text);
      await logDelivery(db, userId, event, `channel:${channelId}`, "sent", { kind: row.kind });
    } catch (error) {
      await logDelivery(db, userId, event, `channel:${channelId}`, "failed", { kind: row.kind, reason: clean(error.message, 300) });
    }
  }
}

let unsubscribe = null;

/** Start listening to workforce events. Idempotent. */
function startNotifications() {
  if (unsubscribe) return;
  unsubscribe = onWorkforceEvent((db, userId, event) => {
    if (!CATEGORY_FOR[event.kind]) return;
    track(deliver(db, userId, event).catch((error) => console.error(`Workforce notification failed (${error?.code || error?.name || "error"}).`)));
  });
}

function publicChannel(row) {
  const config = parse(row.config, {});
  const { PROACTIVE } = require("../channels");
  return {
    id: row.id, kind: row.kind, name: row.name, paired: Boolean(row.paired_chat_id), pairedName: row.paired_name || null,
    canNotify: PROACTIVE.has(row.kind), reachable: Boolean(row.paired_chat_id && config.ownerTarget?.chatId),
    teammateId: config.workforceBotId || null,
  };
}

function createNotificationsRouter() {
  const router = express.Router();

  router.get("/workforce/notifications/settings", withAccount(async (_req, res, db, account) => {
    const channels = (await db.query("SELECT * FROM hannah_channels WHERE user_id = $1 ORDER BY created_at", [account.id])).rows.map(publicChannel);
    res.json({ settings: await loadSettings(db, account.id), channels, categories: CATEGORIES, webhookEvents: Object.values(WEBHOOK_EVENT) });
  }));

  router.put("/workforce/notifications/settings", withAccount(async (req, res, db, account) => {
    const next = normalizeSettings(readBody(req), await loadSettings(db, account.id));
    if (next.channelIds.length) {
      const { rows } = await db.query(`SELECT id, kind FROM hannah_channels WHERE user_id = $1 AND id IN (${next.channelIds.map((_, index) => `$${index + 2}`).join(", ")})`, [account.id, ...next.channelIds]);
      if (rows.length !== next.channelIds.length) throw fail(400, "A chosen chat app isn't one of yours.", "invalid-channel");
      const { PROACTIVE } = require("../channels");
      const unsupported = rows.find((row) => !PROACTIVE.has(row.kind));
      if (unsupported) throw fail(400, `${unsupported.kind} can't take messages HANNAH starts, so it can't carry notifications.`, "not-proactive");
    }
    const at = Date.now();
    const updated = await db.query("UPDATE hannah_workforce_notify_settings SET settings = $1, updated_at = $2 WHERE user_id = $3", [JSON.stringify(next), at, account.id]);
    if (!updated.rowCount) await db.query("INSERT INTO hannah_workforce_notify_settings (user_id, settings, updated_at) VALUES ($1, $2, $3)", [account.id, JSON.stringify(next), at]);
    res.json({ settings: next });
  }));

  /** Recent notification-worthy events for the in-app feed, newest first, with delivery outcomes. */
  router.get("/workforce/notifications", withAccount(async (req, res, db, account) => {
    const since = Number(req.query.since);
    const kinds = Object.keys(CATEGORY_FOR);
    const params = [account.id, ...kinds];
    let sql = `SELECT * FROM hannah_workforce_events WHERE user_id = $1 AND kind IN (${kinds.map((_, index) => `$${index + 2}`).join(", ")})`;
    if (Number.isFinite(since) && since > 0) { params.push(since); sql += ` AND created_at > $${params.length}`; }
    const events = (await db.query(`${sql} ORDER BY created_at DESC LIMIT 50`, params)).rows.map(publicEvent);
    const deliveries = (await db.query("SELECT * FROM hannah_workforce_deliveries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [account.id])).rows
      .map((row) => ({ id: row.id, eventId: row.event_id, eventKind: row.event_kind, target: row.target, status: row.status, detail: parse(row.detail, null), createdAt: Number(row.created_at) }));
    const items = [];
    for (const event of events) {
      const bot = event.botId ? await canUseBot(db, account.id, event.botId) : null;
      items.push({ ...event, category: CATEGORY_FOR[event.kind], text: await compose(db, account.id, event, bot), deliveries: deliveries.filter((item) => item.eventId === event.id) });
    }
    res.json({ notifications: items, deliveries, serverTime: Date.now() });
  }));

  /** Send a test message to one chosen chat app, so a person can see it arrives. */
  router.post("/workforce/notifications/test", withAccount(async (req, res, db, account) => {
    const channelId = clean(readBody(req).channelId, 80);
    const row = (await db.query("SELECT * FROM hannah_channels WHERE id = $1 AND user_id = $2", [channelId, account.id])).rows[0];
    if (!row) throw fail(404, "That chat app isn't connected.", "not-found");
    const { sendToChannelOwner } = require("../channels");
    const event = { id: null, kind: "notification.test" };
    try {
      await sendToChannelOwner(db, row, "HANNAH workforce notifications reach this chat.");
      await logDelivery(db, account.id, event, `channel:${row.id}`, "sent", { kind: row.kind });
      res.json({ ok: true });
    } catch (error) {
      await logDelivery(db, account.id, event, `channel:${row.id}`, "failed", { kind: row.kind, reason: clean(error.message, 300) });
      throw fail(error.status && error.status < 500 ? error.status : 502, error.message, error.reason || "send-failed");
    }
  }));

  /** Bind a chat app to a teammate: the paired owner then talks to that teammate there. null unbinds. */
  router.put("/workforce/channels/:id/teammate", withAccount(async (req, res, db, account) => {
    if (account.via !== "session") throw fail(403, "Only a signed-in person can connect a chat app to a teammate.", "person-required");
    const row = (await db.query("SELECT * FROM hannah_channels WHERE id = $1 AND user_id = $2", [clean(req.params.id, 80), account.id])).rows[0];
    if (!row) throw fail(404, "That chat app isn't connected.", "not-found");
    const botId = readBody(req).botId;
    let bot = null;
    if (botId) {
      bot = await canUseBot(db, account.id, clean(botId, 80));
      if (!bot) throw fail(404, "That teammate doesn't exist.", "not-found");
    }
    const config = parse(row.config, {});
    if (bot) config.workforceBotId = bot.id;
    else delete config.workforceBotId;
    await db.query("UPDATE hannah_channels SET config = $1, updated_at = $2 WHERE id = $3 AND user_id = $4", [JSON.stringify(config), Date.now(), row.id, account.id]);
    const fresh = (await db.query("SELECT * FROM hannah_channels WHERE id = $1", [row.id])).rows[0];
    res.json({ channel: publicChannel(fresh), note: bot ? `Your messages in ${row.name} now go to ${bot.name}. Anyone else you approved there still talks to HANNAH.` : `${row.name} talks to HANNAH again.` });
  }));

  return router;
}

module.exports = { CATEGORY_FOR, DEFAULTS, compose, createNotificationsRouter, deliver, flush, loadSettings, normalizeSettings, startNotifications };
