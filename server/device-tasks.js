"use strict";

/**
 * Tasks across devices.
 *
 * A signed-in user's devices report what they're working on (agent team runs,
 * automations) and ask for approvals here, so the user can follow a task
 * started on the laptop and approve or deny its next action from the phone.
 *
 * - The device that runs a task owns it: it creates and updates the row. The
 *   work itself never runs on the server.
 * - Approvals are rows of kind "approval" with status "waiting". Any of the
 *   user's signed-in devices can decide one, once: the decision is a single
 *   conditional UPDATE, so two devices answering at the same time can't both
 *   win, and an expired request can't be approved.
 * - Rows are visible only to the account that created them, and old rows are
 *   pruned after a week.
 */

const express = require("express");
const { getDatabase } = require("./db");
const { emitUserEvent } = require("./webhooks");

const TASK_STATUSES = new Set(["running", "done", "failed", "stopped", "needs-attention"]);
const APPROVAL_FINAL = new Set(["approved", "denied", "expired", "cancelled"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_APPROVAL_MS = 30 * 60_000;
const DEFAULT_APPROVAL_MS = 10 * 60_000;
const KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_ROWS_PER_USER = 300;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);

function publicTask(row, now = Date.now()) {
  const expired = row.kind === "approval" && row.status === "waiting" && row.expires_at !== null && Number(row.expires_at) <= now;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail || "",
    status: expired ? "expired" : row.status,
    device: { id: row.device_id, name: row.device_name },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    decidedBy: row.decided_by || null,
  };
}

function readDevice(body) {
  const id = String(body?.deviceId || "");
  if (!DEVICE_ID_PATTERN.test(id)) throw Object.assign(new Error("deviceId must be 8–64 letters, digits, - or _."), { status: 400 });
  return { id, name: clean(body?.deviceName, 60) || "Another device" };
}

function createDeviceTaskRouter({ now = () => Date.now(), emit = emitUserEvent } = {}) {
  const router = express.Router();
  const withUser = (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account || account.via !== "session") return res.status(401).json({ error: "Sign in to see tasks across your devices.", reason: "signin-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Tasks across devices need the account database." });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (!error.status) console.error(`Device task request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "The task request failed." });
    }
  };
  const taskId = (req) => {
    const id = String(req.params.id || "");
    if (!ID_PATTERN.test(id)) throw Object.assign(new Error("Unknown task."), { status: 404 });
    return id;
  };
  const load = async (db, userId, id) => (await db.query("SELECT * FROM hannah_device_tasks WHERE id = $1 AND user_id = $2", [id, userId])).rows[0];

  router.get("/account/tasks", withUser(async (req, res, db, account) => {
    const since = Number(req.query.since);
    const from = Number.isFinite(since) && since > 0 ? since : now() - 24 * 60 * 60_000;
    const { rows } = await db.query("SELECT * FROM hannah_device_tasks WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at DESC LIMIT 50", [account.id, from]);
    const at = now();
    res.json({ tasks: rows.map((row) => publicTask(row, at)), serverTime: at });
  }));

  router.get("/account/tasks/:id", withUser(async (req, res, db, account) => {
    const row = await load(db, account.id, taskId(req));
    if (!row) return res.status(404).json({ error: "Unknown task." });
    res.json({ task: publicTask(row, now()) });
  }));

  // The device running a task creates and updates it; an approval is created once.
  router.put("/account/tasks/:id", withUser(async (req, res, db, account) => {
    const id = taskId(req);
    const device = readDevice(req.body);
    const kind = req.body?.kind === "approval" ? "approval" : "task";
    const title = clean(req.body?.title, 140);
    const detail = clean(req.body?.detail, 2000);
    const at = now();
    const existing = await load(db, account.id, id);

    if (kind === "approval") {
      if (existing) {
        // The asking device may withdraw its own request (for example after the
        // user answered on that device); nothing else changes an approval here.
        if (req.body?.status !== "cancelled") return res.status(409).json({ error: "This approval already exists.", task: publicTask(existing, at) });
        await db.query("UPDATE hannah_device_tasks SET status = 'cancelled', updated_at = $1 WHERE id = $2 AND user_id = $3 AND status = 'waiting'", [at, id, account.id]);
        return res.json({ task: publicTask(await load(db, account.id, id), at) });
      }
      if (!title) return res.status(400).json({ error: "Say what needs approval." });
      const ttl = Math.min(MAX_APPROVAL_MS, Math.max(60_000, Number(req.body?.expiresInMs) || DEFAULT_APPROVAL_MS));
      await prune(db, account.id, at);
      await db.query(
        "INSERT INTO hannah_device_tasks (id, user_id, device_id, device_name, kind, title, detail, status, created_at, updated_at, expires_at) VALUES ($1, $2, $3, $4, 'approval', $5, $6, 'waiting', $7, $7, $8)",
        [id, account.id, device.id, device.name, title, detail, at, at + ttl],
      );
      // Lets the user forward approval requests to a phone (ntfy, Slack…) with a webhook.
      void emit(account.id, "approval.requested", { id, title, device: device.name, expiresAt: new Date(at + ttl).toISOString() });
      return res.status(201).json({ task: publicTask(await load(db, account.id, id), at) });
    }

    const status = String(req.body?.status || "running");
    if (!TASK_STATUSES.has(status)) return res.status(400).json({ error: `status must be one of ${[...TASK_STATUSES].join(", ")}.` });
    if (existing) {
      if (existing.kind !== "task" || existing.device_id !== device.id) return res.status(409).json({ error: "Only the device running this task can update it." });
      await db.query("UPDATE hannah_device_tasks SET title = $1, detail = $2, status = $3, updated_at = $4 WHERE id = $5 AND user_id = $6", [title || existing.title, detail, status, at, id, account.id]);
      return res.json({ task: publicTask(await load(db, account.id, id), at) });
    }
    if (!title) return res.status(400).json({ error: "Give the task a title." });
    await prune(db, account.id, at);
    await db.query(
      "INSERT INTO hannah_device_tasks (id, user_id, device_id, device_name, kind, title, detail, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'task', $5, $6, $7, $8, $8)",
      [id, account.id, device.id, device.name, title, detail, status, at],
    );
    res.status(201).json({ task: publicTask(await load(db, account.id, id), at) });
  }));

  // Approve or deny from any signed-in device. First answer wins.
  router.post("/account/tasks/:id/decision", withUser(async (req, res, db, account) => {
    const id = taskId(req);
    const device = readDevice(req.body);
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve must be true or false." });
    const at = now();
    const status = req.body.approve ? "approved" : "denied";
    const result = await db.query(
      "UPDATE hannah_device_tasks SET status = $1, decided_at = $2, decided_by = $3, updated_at = $2 WHERE id = $4 AND user_id = $5 AND kind = 'approval' AND status = 'waiting' AND expires_at > $2",
      [status, at, device.name, id, account.id],
    );
    const row = await load(db, account.id, id);
    if (!row) return res.status(404).json({ error: "Unknown task." });
    if (!result.rowCount) {
      const current = publicTask(row, at);
      const message = current.status === "expired" ? "This request expired before anyone answered." : APPROVAL_FINAL.has(current.status) ? `This was already ${current.status}${current.decidedBy ? ` on ${current.decidedBy}` : ""}.` : "This task doesn't take approvals.";
      return res.status(409).json({ error: message, task: current });
    }
    res.json({ task: publicTask(row, at) });
  }));

  router.delete("/account/tasks/:id", withUser(async (req, res, db, account) => {
    const result = await db.query("DELETE FROM hannah_device_tasks WHERE id = $1 AND user_id = $2 AND NOT (kind = 'approval' AND status = 'waiting')", [taskId(req), account.id]);
    res.json({ ok: true, removed: result.rowCount > 0 });
  }));

  return router;
}

async function prune(db, userId, at) {
  await db.query("DELETE FROM hannah_device_tasks WHERE user_id = $1 AND updated_at < $2", [userId, at - KEEP_MS]);
  const { rows } = await db.query("SELECT COUNT(*) AS count FROM hannah_device_tasks WHERE user_id = $1", [userId]);
  const extra = Number(rows[0]?.count) - MAX_ROWS_PER_USER + 1;
  if (extra > 0) {
    await db.query("DELETE FROM hannah_device_tasks WHERE id IN (SELECT id FROM hannah_device_tasks WHERE user_id = $1 AND NOT (kind = 'approval' AND status = 'waiting') ORDER BY updated_at ASC LIMIT $2)", [userId, extra]);
  }
}

module.exports = { createDeviceTaskRouter, publicTask };
