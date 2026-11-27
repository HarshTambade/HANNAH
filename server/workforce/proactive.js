"use strict";

/**
 * Proactive intelligence.
 *
 * Suggestions are computed from the account's own durable records: overdue
 * work, approvals waiting on a person, failing routines, unverified results,
 * expiring memory and meetings that ended without notes. Nothing is invented
 * and no suggestion claims an action happened. Each one links to the screen
 * where the person can decide.
 *
 * The person controls frequency: categories, quiet hours and a daily cap. A
 * scan outside working preferences creates nothing.
 */
const express = require("express");
const { asObject, clean, cleanMultiline, fail, id, parse, readBody, recordEvent, requireId, withAccount } = require("./common");

const CATEGORIES = ["tasks", "approvals", "routines", "memory", "meetings", "artifacts"];
const DEFAULT_SETTINGS = {
  enabled: false,
  categories: CATEGORIES.slice(),
  maxPerDay: 3,
  quietHours: { start: "22:00", end: "07:00" },
  timezone: "UTC",
  lastScanAt: null,
};

function publicSettings(row, userId) {
  const stored = parse(row?.settings, {});
  return { userId, ...DEFAULT_SETTINGS, ...stored, quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(stored.quietHours || {}) } };
}

function minutesOf(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function inQuietHours(settings, now = new Date()) {
  const start = minutesOf(settings.quietHours?.start);
  const end = minutesOf(settings.quietHours?.end);
  if (start === null || end === null || start === end) return false;
  let minutes;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone || "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
    minutes = Number(parts.find((part) => part.type === "hour")?.value || 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value || 0);
  } catch {
    minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function startOfDay(now = new Date()) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function publicOffer(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body || "",
    source: row.source || "",
    status: row.status,
    action: parse(row.action, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function validTimezone(zone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

/** Deterministic signals from real rows. No model call, so a scan can't hallucinate a problem. */
async function collectSignals(db, userId, categories) {
  const now = Date.now();
  const signals = [];
  if (categories.includes("approvals")) {
    const { rows } = await db.query("SELECT id, title, risk, requested_at FROM hannah_workforce_approvals WHERE user_id = $1 AND status = 'pending' AND expires_at > $2 ORDER BY requested_at", [userId, now]);
    if (rows.length) {
      signals.push({
        kind: "approval", source: `approvals:${rows.length}`,
        title: `${rows.length} approval${rows.length === 1 ? "" : "s"} waiting for you`,
        body: `A teammate is paused until you decide. Oldest: "${clean(rows[0].title, 120)}" (${rows[0].risk} risk).`,
        action: { type: "open", screen: "approvals", ids: rows.slice(0, 5).map((row) => row.id) },
      });
    }
  }
  if (categories.includes("tasks")) {
    const overdue = (await db.query(
      "SELECT id, title, deadline FROM hannah_workforce_tasks WHERE user_id = $1 AND deadline IS NOT NULL AND deadline < $2 AND status NOT IN ('completed','cancelled','failed') ORDER BY deadline LIMIT 20",
      [userId, now],
    )).rows;
    if (overdue.length) {
      signals.push({
        kind: "overdue", source: `overdue:${overdue.length}`,
        title: `${overdue.length} task${overdue.length === 1 ? " is" : "s are"} past the deadline`,
        body: `Earliest: "${clean(overdue[0].title, 120)}" was due ${new Date(Number(overdue[0].deadline)).toISOString().slice(0, 10)}.`,
        action: { type: "open", screen: "tasks", ids: overdue.slice(0, 5).map((row) => row.id) },
      });
    }
    const unverified = (await db.query(
      "SELECT id, title, finished_at, result FROM hannah_workforce_tasks WHERE user_id = $1 AND status = 'completed' AND finished_at IS NOT NULL AND finished_at < $2 ORDER BY finished_at DESC LIMIT 40",
      [userId, now - 60 * 60_000],
    )).rows.filter((row) => !parse(row.result, {})?.verification);
    if (unverified.length) {
      signals.push({
        kind: "verification", source: `unverified:${unverified.length}`,
        title: `${unverified.length} completed task${unverified.length === 1 ? " has" : "s have"} no verification`,
        body: "A different teammate can review the evidence and record pass or fail.",
        action: { type: "open", screen: "tasks", ids: unverified.slice(0, 5).map((row) => row.id) },
      });
    }
  }
  if (categories.includes("routines")) {
    const { rows } = await db.query("SELECT id, name, failure_count, status, next_run_at FROM hannah_routines WHERE user_id = $1 AND (failure_count > 0 OR status = 'active') ORDER BY failure_count DESC LIMIT 20", [userId]);
    const failing = rows.filter((row) => Number(row.failure_count) > 0);
    if (failing.length) {
      signals.push({
        kind: "routine", source: `routine-failures:${failing.length}`,
        title: `${failing.length} routine${failing.length === 1 ? " needs" : "s need"} attention`,
        body: `"${clean(failing[0].name, 120)}" has ${failing[0].failure_count} failed run${Number(failing[0].failure_count) === 1 ? "" : "s"}. Open the run history for the exact reason.`,
        action: { type: "open", screen: "routines", ids: failing.slice(0, 5).map((row) => row.id) },
      });
    }
    const soon = rows.filter((row) => row.status === "active" && row.next_run_at && Number(row.next_run_at) > now && Number(row.next_run_at) < now + 60 * 60_000);
    if (soon.length) {
      signals.push({
        kind: "upcoming", source: `upcoming:${soon.length}`,
        title: `${soon.length} routine${soon.length === 1 ? "" : "s"} run within the hour`,
        body: `Next: "${clean(soon[0].name, 120)}" at ${new Date(Number(soon[0].next_run_at)).toISOString().slice(11, 16)} UTC.`,
        action: { type: "open", screen: "routines", ids: soon.slice(0, 5).map((row) => row.id) },
      });
    }
  }
  if (categories.includes("memory")) {
    const { rows } = await db.query("SELECT id, content, expires_at FROM hannah_workforce_memory WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at > $2 AND expires_at < $3 ORDER BY expires_at LIMIT 20", [userId, now, now + 7 * 24 * 3600_000]);
    if (rows.length) {
      signals.push({
        kind: "memory", source: `memory-expiring:${rows.length}`,
        title: `${rows.length} memor${rows.length === 1 ? "y expires" : "ies expire"} this week`,
        body: `"${clean(rows[0].content, 100)}" — verify it or let it expire.`,
        action: { type: "open", screen: "memory", ids: rows.slice(0, 5).map((row) => row.id) },
      });
    }
  }
  if (categories.includes("meetings")) {
    const { rows } = await db.query("SELECT id, title, ends_at FROM hannah_meetings WHERE user_id = $1 AND status = 'scheduled' AND ends_at IS NOT NULL AND ends_at < $2 LIMIT 20", [userId, now]);
    if (rows.length) {
      signals.push({
        kind: "meeting", source: `meetings-unfinished:${rows.length}`,
        title: `${rows.length} meeting${rows.length === 1 ? "" : "s"} ended without notes`,
        body: `Add the transcript and ask for a summary with action items. "${clean(rows[0].title, 100)}"`,
        action: { type: "open", screen: "meetings", ids: rows.slice(0, 5).map((row) => row.id) },
      });
    }
  }
  return signals;
}

async function scan(db, userId, { force = false } = {}) {
  const stored = (await db.query("SELECT * FROM hannah_proactive_settings WHERE user_id = $1", [userId])).rows[0];
  const settings = publicSettings(stored, userId);
  if (!settings.enabled) throw fail(409, "Proactive suggestions are off. Turn them on in the Proactive settings first.", "proactive-off");
  const categories = Array.isArray(settings.categories) ? settings.categories.filter((item) => CATEGORIES.includes(item)) : CATEGORIES;
  if (inQuietHours(settings) && !force) return { created: [], skipped: "quiet-hours", settings };
  const today = (await db.query("SELECT id FROM hannah_proactive_offers WHERE user_id = $1 AND created_at >= $2", [userId, startOfDay()])).rowCount;
  if (!force && today >= Math.max(1, Math.min(12, Number(settings.maxPerDay) || 3))) return { created: [], skipped: "daily-limit", settings, today };
  const outstanding = (await db.query("SELECT id, kind, source FROM hannah_proactive_offers WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 50", [userId])).rows;
  const signals = await collectSignals(db, userId, categories);
  const created = [];
  const now = Date.now();
  for (const signal of signals) {
    if (outstanding.some((offer) => offer.source === signal.source)) continue;
    if (!force && today + created.length >= Math.max(1, Math.min(12, Number(settings.maxPerDay) || 3))) break;
    if (outstanding.length + created.length >= 20) break;
    const offerId = id("off");
    await db.query(
      "INSERT INTO hannah_proactive_offers (user_id, id, kind, title, body, source, status, action, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $8)",
      [userId, offerId, signal.kind, clean(signal.title, 160), cleanMultiline(signal.body, 1000), signal.source, JSON.stringify(signal.action), now],
    );
    created.push(offerId);
  }
  const nextSettings = { ...settings, lastScanAt: now };
  delete nextSettings.userId;
  if (stored) await db.query("UPDATE hannah_proactive_settings SET settings = $1, updated_at = $2 WHERE user_id = $3", [JSON.stringify(nextSettings), now, userId]);
  else await db.query("INSERT INTO hannah_proactive_settings (user_id, settings, updated_at) VALUES ($1, $2, $3)", [userId, JSON.stringify(nextSettings), now]);
  if (created.length) await recordEvent(db, userId, "proactive.scan", { detail: { created: created.length, skipped: null } });
  return { created, skipped: created.length ? null : "nothing-new", settings: { ...settings, lastScanAt: now } };
}

function createProactiveRouter() {
  const router = express.Router();

  router.get("/workforce/proactive", withAccount(async (_req, res, db, account) => {
    const stored = (await db.query("SELECT * FROM hannah_proactive_settings WHERE user_id = $1", [account.id])).rows[0];
    const { rows } = await db.query("SELECT * FROM hannah_proactive_offers WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [account.id]);
    res.json({ settings: publicSettings(stored, account.id), categories: CATEGORIES, offers: rows.map(publicOffer) });
  }));

  router.put("/workforce/proactive/settings", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const stored = (await db.query("SELECT * FROM hannah_proactive_settings WHERE user_id = $1", [account.id])).rows[0];
    const current = publicSettings(stored, account.id);
    const next = { ...current };
    if (body.enabled !== undefined) next.enabled = body.enabled === true;
    if (body.categories !== undefined) {
      const categories = Array.isArray(body.categories) ? body.categories.filter((item) => CATEGORIES.includes(item)) : [];
      if (!categories.length) throw fail(400, "Choose at least one category.", "invalid");
      next.categories = [...new Set(categories)];
    }
    if (body.maxPerDay !== undefined) next.maxPerDay = Math.max(1, Math.min(12, Number(body.maxPerDay) || 3));
    if (body.timezone !== undefined) {
      if (!validTimezone(String(body.timezone))) throw fail(400, "That time zone isn't valid.", "invalid");
      next.timezone = String(body.timezone);
    }
    if (body.quietHours !== undefined) {
      const quiet = asObject(body.quietHours);
      if (minutesOf(quiet.start) === null || minutesOf(quiet.end) === null) throw fail(400, "Quiet hours need times like 22:00 and 07:00.", "invalid");
      next.quietHours = { start: quiet.start, end: quiet.end };
    }
    delete next.userId;
    const at = Date.now();
    if (stored) await db.query("UPDATE hannah_proactive_settings SET settings = $1, updated_at = $2 WHERE user_id = $3", [JSON.stringify(next), at, account.id]);
    else await db.query("INSERT INTO hannah_proactive_settings (user_id, settings, updated_at) VALUES ($1, $2, $3)", [account.id, JSON.stringify(next), at]);
    res.json({ settings: { ...next, userId: account.id } });
  }));

  router.post("/workforce/proactive/scan", withAccount(async (req, res, db, account) => {
    const result = await scan(db, account.id, { force: readBody(req).force === true });
    const offers = result.created.length
      ? (await db.query(`SELECT * FROM hannah_proactive_offers WHERE user_id = $1 AND id IN (${result.created.map((_, index) => `$${index + 2}`).join(", ")})`, [account.id, ...result.created])).rows.map(publicOffer)
      : [];
    res.json({ ...result, offers });
  }));

  router.get("/workforce/proactive/offers", withAccount(async (req, res, db, account) => {
    const status = clean(req.query.status, 20) || "pending";
    const { rows } = await db.query(
      status === "all" ? "SELECT * FROM hannah_proactive_offers WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200" : "SELECT * FROM hannah_proactive_offers WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 200",
      status === "all" ? [account.id] : [account.id, status],
    );
    res.json({ offers: rows.map(publicOffer) });
  }));

  router.post("/workforce/proactive/offers/:id/dismiss", withAccount(async (req, res, db, account) => {
    const offerId = requireId(req.params.id, "suggestion");
    const result = await db.query("UPDATE hannah_proactive_offers SET status = 'dismissed', updated_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'pending'", [Date.now(), account.id, offerId]);
    if (!result.rowCount) throw fail(404, "That suggestion doesn't exist or was already handled.", "not-found");
    res.json({ ok: true, dismissed: true });
  }));

  router.post("/workforce/proactive/offers/:id/act", withAccount(async (req, res, db, account) => {
    const offerId = requireId(req.params.id, "suggestion");
    const row = (await db.query("SELECT * FROM hannah_proactive_offers WHERE user_id = $1 AND id = $2", [account.id, offerId])).rows[0];
    if (!row) throw fail(404, "That suggestion doesn't exist.", "not-found");
    if (row.status !== "pending") throw fail(409, `That suggestion is already ${row.status}.`, "not-pending");
    const action = parse(row.action, {});
    if (action?.type !== "open" || !clean(action.screen, 40)) throw fail(409, "This suggestion has no safe action attached.", "invalid-action");
    await db.query("UPDATE hannah_proactive_offers SET status = 'accepted', updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, row.id]);
    await recordEvent(db, account.id, "proactive.accepted", { detail: { offerId: row.id, kind: row.kind, screen: action.screen } });
    res.json({ ok: true, open: { screen: clean(action.screen, 40), ids: Array.isArray(action.ids) ? action.ids.slice(0, 10) : [] } });
  }));

  return router;
}

module.exports = { CATEGORIES, DEFAULT_SETTINGS, collectSignals, createProactiveRouter, inQuietHours, publicOffer, publicSettings, scan };
