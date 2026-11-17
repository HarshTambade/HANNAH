"use strict";

/**
 * Account webhooks: HANNAH POSTs signed JSON to a URL the user chooses when
 * something happens in their account.
 *
 * Events: reminder.fired, team.completed (reported by the user's own app),
 * budget.exceeded and approval.requested (from the server), and webhook.test.
 *
 * Each delivery carries
 *   X-HANNAH-Event, X-HANNAH-Delivery, X-HANNAH-Timestamp and
 *   X-HANNAH-Signature: sha256=<hex HMAC of "<timestamp>.<body>" with the webhook secret>
 *
 * Only https URLs on public addresses are accepted: names that resolve to
 * loopback, private, link-local or metadata addresses are refused, and
 * redirects aren't followed, so webhooks can't be used to reach the server's
 * internal network.
 */

const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const { getDatabase } = require("./db");

const EVENTS = new Set(["reminder.fired", "team.completed", "budget.exceeded", "approval.requested", "workflow.completed", "workflow.failed", "workflow.notification", "webhook.test"]);
// In-process listeners (the workflow engine's event triggers) hear every event too.
const listeners = new Set();
function onUserEvent(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const CLIENT_EVENTS = new Set(["reminder.fired", "team.completed"]);
const MAX_HOOKS = 5;

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) return privateAddress(lower.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
}

/** Throws unless the URL is https on a public address. Exported for tests. */
async function assertPublicUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw Object.assign(new Error("Enter a valid URL."), { status: 400 });
  }
  if (url.protocol !== "https:") throw Object.assign(new Error("Webhook URLs must use https://."), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error("Don't put credentials in the URL; verify the signature instead."), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw Object.assign(new Error("That host name doesn't resolve."), { status: 400 });
  if (addresses.some((item) => privateAddress(item.address))) throw Object.assign(new Error("Webhooks can't point at private or local network addresses."), { status: 400 });
  return url.toString();
}

function sign(secret, timestamp, body) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function deliver(db, hook, event, data, { fetchImpl = fetch } = {}) {
  const body = JSON.stringify({ id: randomUUID(), event, createdAt: new Date().toISOString(), data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  let status = 0;
  try {
    await assertPublicUrl(hook.url);
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "HANNAH-Webhooks/1", "X-HANNAH-Event": event, "X-HANNAH-Delivery": randomUUID(), "X-HANNAH-Timestamp": timestamp, "X-HANNAH-Signature": sign(hook.secret, timestamp, body) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    status = response.status;
    await response.body?.cancel().catch(() => {});
  } catch {
    status = 0;
  }
  await db.query("UPDATE hannah_webhooks SET last_status = $1, last_delivery_at = $2 WHERE id = $3", [status, Date.now(), hook.id]).catch(() => {});
  return status;
}

/** Send an event to every matching webhook of a user. Never throws. */
async function emitUserEvent(userId, event, data, options) {
  for (const listener of listeners) Promise.resolve().then(() => listener(userId, event, data)).catch(() => {});
  try {
    const db = await getDatabase();
    if (!db) return [];
    const { rows } = await db.query("SELECT id, url, secret, events FROM hannah_webhooks WHERE user_id = $1", [userId]);
    const hooks = rows.filter((row) => JSON.parse(row.events).includes(event) || event === "webhook.test");
    return Promise.all(hooks.map((hook) => deliver(db, hook, event, data, options)));
  } catch (error) {
    console.error(`Webhook delivery failed (${error?.code || error?.name || "error"}).`);
    return [];
  }
}

function sanitizeData(value) {
  const text = JSON.stringify(value ?? {});
  if (text.length > 4000) return { truncated: true };
  return JSON.parse(text);
}

function createWebhookRouter({ fetchImpl } = {}) {
  const router = express.Router();
  const withUser = (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account || account.via !== "session") return res.status(401).json({ error: "Sign in to manage webhooks." });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Webhooks need the account database." });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : "The webhook request failed." });
    }
  };

  router.get("/account/webhooks", withUser(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT id, url, events, created_at, last_status, last_delivery_at FROM hannah_webhooks WHERE user_id = $1 ORDER BY created_at", [account.id]);
    res.json({ events: [...EVENTS].filter((event) => event !== "webhook.test"), webhooks: rows.map((row) => ({ id: row.id, url: row.url, events: JSON.parse(row.events), createdAt: Number(row.created_at), lastStatus: row.last_status === null ? null : Number(row.last_status), lastDeliveryAt: row.last_delivery_at === null ? null : Number(row.last_delivery_at) })) });
  }));

  router.post("/account/webhooks", withUser(async (req, res, db, account) => {
    const events = Array.isArray(req.body?.events) ? [...new Set(req.body.events.filter((event) => EVENTS.has(event) && event !== "webhook.test"))] : [];
    if (!events.length) return res.status(400).json({ error: "Choose at least one event." });
    const url = await assertPublicUrl(req.body?.url);
    const { rows } = await db.query("SELECT COUNT(*) AS count FROM hannah_webhooks WHERE user_id = $1", [account.id]);
    if (Number(rows[0]?.count) >= MAX_HOOKS) return res.status(400).json({ error: `Up to ${MAX_HOOKS} webhooks per account.` });
    const id = randomUUID();
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await db.query("INSERT INTO hannah_webhooks (id, user_id, url, secret, events, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, account.id, url, secret, JSON.stringify(events), Date.now()]);
    res.status(201).json({ id, url, events, secret, note: "Copy the signing secret now; it isn't shown again." });
  }));

  router.delete("/account/webhooks/:id", withUser(async (req, res, db, account) => {
    const result = await db.query("DELETE FROM hannah_webhooks WHERE id = $1 AND user_id = $2", [String(req.params.id), account.id]);
    res.json({ ok: true, removed: result.rowCount > 0 });
  }));

  router.post("/account/webhooks/:id/test", withUser(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT id, url, secret, events FROM hannah_webhooks WHERE id = $1 AND user_id = $2", [String(req.params.id), account.id]);
    if (!rows[0]) return res.status(404).json({ error: "Unknown webhook." });
    const status = await deliver(db, rows[0], "webhook.test", { message: "Test delivery from HANNAH." }, { fetchImpl });
    res.json({ ok: status >= 200 && status < 300, status });
  }));

  // The user's own app reports events that happen on the device.
  router.post("/account/events", withUser(async (req, res, _db, account) => {
    const event = String(req.body?.event || "");
    if (!CLIENT_EVENTS.has(event)) return res.status(400).json({ error: "Unknown event." });
    const statuses = await emitUserEvent(account.id, event, sanitizeData(req.body?.data), { fetchImpl });
    res.status(202).json({ delivered: statuses.filter((status) => status >= 200 && status < 300).length, attempted: statuses.length });
  }));

  return router;
}

module.exports = { assertPublicUrl, createWebhookRouter, emitUserEvent, onUserEvent, privateAddress, sign, EVENTS };
