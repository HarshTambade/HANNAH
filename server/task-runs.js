"use strict";

/**
 * Durable task runs (brief Phase 4, roadmap M12).
 *
 * A device that runs a long task (an agent team run today) saves a checkpoint
 * here after every change: the plan, each step's status and result. The work
 * runs on a device, never on this server; the server keeps the record and
 * decides who may write it.
 *
 * - Ownership: rows are keyed by (user, id) and every query filters by the
 *   signed-in user, so one account can never see or touch another's runs.
 * - Lease: one device runs a task at a time. Saving a "running" checkpoint
 *   holds a short lease, renewed by heartbeats. When the device pauses, fails
 *   or disappears (the lease runs out), any of the user's devices can claim the
 *   run and continue from the last checkpoint. Finished steps stay finished.
 * - Versions: every write names the version it builds on. A device that was
 *   offline while another took over can't overwrite the newer state.
 * - Idempotency: every write carries a write id. Repeating a write (a retry
 *   after a lost response) returns the stored result instead of failing.
 * - Cancel: any device may cancel. The running device learns at its next
 *   checkpoint or heartbeat and stops. Cancelled and completed runs are final.
 *
 * Statuses follow the brief: queued, running, waiting-approval, paused,
 * failed, completed, cancelled.
 */

const express = require("express");
const { getDatabase } = require("./db");

const STATUSES = new Set(["queued", "running", "waiting-approval", "paused", "failed", "completed", "cancelled"]);
/** Statuses in which a device is actively working on the run and holds the lease. */
const LEASED = new Set(["running", "waiting-approval"]);
const FINAL = new Set(["completed", "cancelled"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const KIND_PATTERN = /^[a-z][a-z-]{0,19}$/;
const LEASE_MS = 90_000;
const MAX_RECORD_CHARS = 200_000;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_ROWS_PER_USER = 100;
const LIST_LIMIT = 20;

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });

function leaseActive(row, now) {
  return Boolean(row.lease_device_id) && row.lease_expires_at !== null && Number(row.lease_expires_at) > now;
}

function publicRun(row, now = Date.now()) {
  let record = null;
  try {
    record = JSON.parse(row.record);
  } catch {
    record = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    version: Number(row.version),
    record,
    lease: leaseActive(row, now) ? { deviceId: row.lease_device_id, deviceName: row.lease_device_name, expiresAt: Number(row.lease_expires_at) } : null,
    lastDevice: row.last_device_name,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  };
}

function readDevice(body) {
  const id = String(body?.deviceId || "");
  if (!DEVICE_ID_PATTERN.test(id)) throw fail(400, "deviceId must be 8–64 letters, digits, - or _.", "bad-request");
  return { id, name: clean(body?.deviceName, 60) || "Another device" };
}

/** Why a conditional update didn't apply, as a 409 the client can act on. */
function conflict(row, device, now) {
  if (!row) return fail(404, "This task no longer exists.", "not-found");
  const run = publicRun(row, now);
  if (row.status === "cancelled") return fail(409, `This task was cancelled from ${row.last_device_name}.`, "cancelled", { run });
  if (row.status === "completed") return fail(409, "This task already finished.", "final", { run });
  if (leaseActive(row, now) && row.lease_device_id !== device.id) return fail(409, `This task is running on ${row.lease_device_name} right now.`, "lease-held", { run });
  return fail(409, `This task was changed on ${row.last_device_name} since this device last saved it.`, "stale", { run });
}

function createTaskRunRouter({ now = () => Date.now(), leaseMs = LEASE_MS } = {}) {
  const router = express.Router();
  const withUser = (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account || account.via !== "session") return res.status(401).json({ error: "Sign in to keep tasks in your account.", reason: "signin-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Saved tasks need the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (!error.status) console.error(`Task run request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "The task request failed.", ...(error.reason ? { reason: error.reason } : {}), ...(error.run ? { run: error.run } : {}) });
    }
  };
  const runId = (req) => {
    const id = String(req.params.id || "");
    if (!ID_PATTERN.test(id)) throw fail(404, "This task no longer exists.", "not-found");
    return id;
  };
  const load = async (db, userId, id) => (await db.query("SELECT * FROM hannah_task_runs WHERE user_id = $1 AND id = $2", [userId, id])).rows[0];

  router.get("/account/runs", withUser(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_task_runs WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2", [account.id, LIST_LIMIT]);
    const at = now();
    res.json({ runs: rows.map((row) => publicRun(row, at)), serverTime: at });
  }));

  router.get("/account/runs/:id", withUser(async (req, res, db, account) => {
    const row = await load(db, account.id, runId(req));
    if (!row) throw fail(404, "This task no longer exists.", "not-found");
    res.json({ run: publicRun(row, now()) });
  }));

  // Save a checkpoint. Creates the run on the first write.
  router.put("/account/runs/:id", withUser(async (req, res, db, account) => {
    const id = runId(req);
    const device = readDevice(req.body);
    const status = String(req.body?.status || "");
    if (!STATUSES.has(status)) throw fail(400, `status must be one of ${[...STATUSES].join(", ")}.`, "bad-request");
    const writeId = String(req.body?.writeId || "");
    if (!ID_PATTERN.test(writeId)) throw fail(400, "writeId must be 8–80 letters, digits, - or _.", "bad-request");
    const record = req.body?.record;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw fail(400, "record must be an object.", "bad-request");
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_RECORD_CHARS) throw fail(413, "This task's checkpoint is too large to save.", "too-large");
    const title = clean(req.body?.title, 140);
    const kind = String(req.body?.kind || "team");
    if (!KIND_PATTERN.test(kind)) throw fail(400, "kind must be a short lowercase name.", "bad-request");
    const baseVersion = req.body?.baseVersion === null || req.body?.baseVersion === undefined ? null : Number(req.body.baseVersion);
    if (baseVersion !== null && !Number.isInteger(baseVersion)) throw fail(400, "baseVersion must be a whole number.", "bad-request");
    const at = now();
    const leased = LEASED.has(status);
    const finishedAt = FINAL.has(status) || status === "failed" ? at : null;
    const existing = await load(db, account.id, id);

    if (!existing) {
      // A device that saved this run before expected it to exist: it was deleted elsewhere.
      if (baseVersion !== null) throw fail(404, "This task was removed on another device.", "not-found");
      if (!title) throw fail(400, "Give the task a title.", "bad-request");
      await prune(db, account.id, at);
      await db.query(
        `INSERT INTO hannah_task_runs (user_id, id, kind, title, status, record, version, last_write_id, lease_device_id, lease_device_name, lease_expires_at, last_device_name, created_at, updated_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12, $12, $13)`,
        [account.id, id, kind, title, status, serialized, writeId, leased ? device.id : null, leased ? device.name : null, leased ? at + leaseMs : null, device.name, at, finishedAt],
      );
      return res.status(201).json({ run: publicRun(await load(db, account.id, id), at) });
    }

    // The same write again (a retry after a lost response): already applied.
    if (existing.last_write_id === writeId) return res.json({ run: publicRun(existing, at), replayed: true });
    if (FINAL.has(existing.status) || baseVersion !== Number(existing.version) || (leaseActive(existing, at) && existing.lease_device_id !== device.id)) {
      throw conflict(existing, device, at);
    }
    const result = await db.query(
      `UPDATE hannah_task_runs SET title = $1, status = $2, record = $3, version = version + 1, last_write_id = $4,
         lease_device_id = $5, lease_device_name = $6, lease_expires_at = $7, last_device_name = $8, updated_at = $9, finished_at = $10
       WHERE user_id = $11 AND id = $12 AND version = $13 AND status NOT IN ('completed', 'cancelled')
         AND (lease_device_id IS NULL OR lease_device_id = $14 OR lease_expires_at <= $9)`,
      [title || existing.title, status, serialized, writeId, leased ? device.id : null, leased ? device.name : null, leased ? at + leaseMs : null, device.name, at, finishedAt, account.id, id, baseVersion, device.id],
    );
    if (!result.rowCount) throw conflict(await load(db, account.id, id), device, at);
    res.json({ run: publicRun(await load(db, account.id, id), at) });
  }));

  // Take over a run to continue it on this device: allowed when nobody else is working on it.
  router.post("/account/runs/:id/claim", withUser(async (req, res, db, account) => {
    const id = runId(req);
    const device = readDevice(req.body);
    const at = now();
    const result = await db.query(
      `UPDATE hannah_task_runs SET status = 'running', version = version + 1, lease_device_id = $1, lease_device_name = $2, lease_expires_at = $3,
         last_device_name = $2, updated_at = $4, finished_at = NULL
       WHERE user_id = $5 AND id = $6 AND status NOT IN ('completed', 'cancelled')
         AND (lease_device_id IS NULL OR lease_device_id = $1 OR lease_expires_at <= $4)`,
      [device.id, device.name, at + leaseMs, at, account.id, id],
    );
    if (!result.rowCount) throw conflict(await load(db, account.id, id), device, at);
    res.json({ run: publicRun(await load(db, account.id, id), at) });
  }));

  // The running device is still alive. Fails once the run was cancelled or taken over.
  router.post("/account/runs/:id/heartbeat", withUser(async (req, res, db, account) => {
    const id = runId(req);
    const device = readDevice(req.body);
    const at = now();
    const result = await db.query(
      "UPDATE hannah_task_runs SET lease_expires_at = $1 WHERE user_id = $2 AND id = $3 AND lease_device_id = $4 AND status IN ('running', 'waiting-approval')",
      [at + leaseMs, account.id, id, device.id],
    );
    if (!result.rowCount) {
      const row = await load(db, account.id, id);
      if (row && !FINAL.has(row.status) && row.lease_device_id !== device.id && !leaseActive(row, at)) {
        throw fail(409, "This device no longer holds this task.", "lease-lost", { run: publicRun(row, at) });
      }
      throw conflict(row, device, at);
    }
    res.json({ ok: true, leaseExpiresAt: at + leaseMs });
  }));

  // Stop a run from any device. The device running it stops at its next checkpoint.
  router.post("/account/runs/:id/cancel", withUser(async (req, res, db, account) => {
    const id = runId(req);
    const device = readDevice(req.body);
    const at = now();
    const result = await db.query(
      `UPDATE hannah_task_runs SET status = 'cancelled', version = version + 1, lease_device_id = NULL, lease_device_name = NULL, lease_expires_at = NULL,
         last_device_name = $1, updated_at = $2, finished_at = $2
       WHERE user_id = $3 AND id = $4 AND status NOT IN ('completed', 'cancelled')`,
      [device.name, at, account.id, id],
    );
    if (!result.rowCount) throw conflict(await load(db, account.id, id), device, at);
    res.json({ run: publicRun(await load(db, account.id, id), at) });
  }));

  // Remove a run's record. Not while another device is working on it: cancel it first.
  router.delete("/account/runs/:id", withUser(async (req, res, db, account) => {
    const id = runId(req);
    const deviceId = String(req.query.deviceId || "");
    const at = now();
    const result = await db.query(
      "DELETE FROM hannah_task_runs WHERE user_id = $1 AND id = $2 AND (lease_device_id IS NULL OR lease_device_id = $3 OR lease_expires_at <= $4)",
      [account.id, id, deviceId, at],
    );
    if (!result.rowCount) {
      const row = await load(db, account.id, id);
      if (row) throw fail(409, `This task is running on ${row.lease_device_name} right now. Stop it first.`, "lease-held", { run: publicRun(row, at) });
    }
    res.json({ ok: true, removed: result.rowCount > 0 });
  }));

  return router;
}

async function prune(db, userId, at) {
  await db.query("DELETE FROM hannah_task_runs WHERE user_id = $1 AND updated_at < $2 AND (lease_expires_at IS NULL OR lease_expires_at <= $3)", [userId, at - KEEP_MS, at]);
  const { rows } = await db.query("SELECT COUNT(*) AS count FROM hannah_task_runs WHERE user_id = $1", [userId]);
  const extra = Number(rows[0]?.count) - MAX_ROWS_PER_USER + 1;
  if (extra > 0) {
    await db.query(
      "DELETE FROM hannah_task_runs WHERE user_id = $1 AND id IN (SELECT id FROM hannah_task_runs WHERE user_id = $1 AND (lease_expires_at IS NULL OR lease_expires_at <= $2) ORDER BY updated_at ASC LIMIT $3)",
      [userId, at, extra],
    );
  }
}

module.exports = { createTaskRunRouter, publicRun, STATUSES: [...STATUSES], LEASE_MS };
