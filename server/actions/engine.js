"use strict";

/**
 * The Action Engine: one way for HANNAH to do something in the world, whoever
 * asks (chat, voice, an agent, a workflow, an MCP host, a device).
 *
 *   understand → permission → (approval) → execute → verify → record
 *
 * An action is a definition (server/actions/catalog): what it is, what it
 * touches, how to show it before it runs, how to run it, and how to check
 * afterwards that it really happened. The engine does the rest, the same way
 * for all of them:
 *
 *   - asks the permission manager (permissions.js) with the account's current
 *     policy and grants, every time;
 *   - when approval is needed, stores the exact action with its preview and
 *     waits; any signed-in device may answer, once;
 *   - executes at most once: a row moves to "executing" with a conditional
 *     update, and a repeated request with the same idempotency key returns the
 *     first result instead of acting again;
 *   - verifies with the destination service and records what it found. Only
 *     "done" means executed and confirmed. "unverified" means the service
 *     accepted it and HANNAH couldn't confirm it; "failed" carries the
 *     service's error; an execution that was cut off is "unknown" and is never
 *     retried by itself;
 *   - keeps the whole record: the request, the agent, the permission decision,
 *     the approval, the response, the verification and the times.
 *
 * Actions a device has to perform itself (a file write, a command, a click in
 * the desktop browser) use the same records: the device asks for
 * authorization, acts when it is "authorized", and reports the outcome.
 */
const crypto = require("node:crypto");
const permissions = require("./permissions");

const APPROVAL_MS = 24 * 60 * 60_000;
const DEVICE_APPROVAL_MS = 30 * 60_000;
const UNKNOWN_AFTER_MS = 3 * 60_000;
const MAX_PARAMS = 400_000;
const MAX_RESPONSE = 24_000;
const KEEP_MS = 180 * 24 * 60 * 60_000;
const MAX_ROWS = 5000;
const FINAL = new Set(["done", "unverified", "failed", "denied", "declined", "expired", "cancelled", "suggested", "unknown"]);

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined) return fallback; try { return JSON.parse(text); } catch { return fallback; } };
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,120}$/;

function clip(value) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_RESPONSE) return text;
  return JSON.stringify({ shortened: true, text: text.slice(0, MAX_RESPONSE - 200) });
}

function publicRecord(row, now = Date.now()) {
  if (!row) return null;
  let status = row.status;
  const expiresAt = row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at);
  if (status === "waiting-approval" && expiresAt && expiresAt <= now) status = "expired";
  // A device was told it may act and never said what happened.
  if (status === "authorized" && expiresAt && expiresAt <= now) status = "unknown";
  if (status === "executing" && Number(row.updated_at) + UNKNOWN_AFTER_MS <= now) status = "unknown";
  return {
    id: row.id, action: row.action, service: row.service, kind: row.kind, status, executor: row.executor,
    request: row.request || "", intent: row.intent || "", agent: row.agent || "", source: row.source || "", taskId: row.task_id || null,
    resource: parse(row.resource), account: row.account || "",
    preview: parse(row.preview), permission: parse(row.permission), approval: parse(row.approval),
    response: parse(row.response), verification: parse(row.verification), error: row.error || null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), executedAt: row.executed_at ? Number(row.executed_at) : null, expiresAt,
    final: FINAL.has(status),
  };
}

/** One sentence that says what happened, and never more than what is known. */
function outcomeText(record) {
  const what = record.preview?.title || record.action;
  switch (record.status) {
    case "done": return `Done and confirmed: ${what}. ${record.verification?.evidence || ""}`.trim();
    case "unverified": return `${what}: the service accepted it, but HANNAH couldn't confirm the result. ${record.verification?.evidence || ""}`.trim();
    case "failed": return `Not done: ${what}. ${record.error || "The service returned an error."}`;
    case "waiting-approval": return `Waiting for your approval: ${what}.`;
    case "authorized": return `Approved; waiting for the device to do it: ${what}.`;
    case "suggested": return `Prepared, not submitted: ${what}. ${record.permission?.reason || ""}`.trim();
    case "denied": return `Not allowed: ${what}. ${record.permission?.reason || ""}`.trim();
    case "declined": return `You declined: ${what}. Nothing was changed.`;
    case "expired": return `The approval request expired: ${what}. Nothing was changed.`;
    case "cancelled": return `Cancelled: ${what}. Nothing was changed.`;
    case "unknown": return `Outcome unknown: ${what} was started and no result came back. Check the service before trying again.`;
    default: return `In progress: ${what}.`;
  }
}

function createActionEngine({ actions = [], now = () => Date.now(), services = {} } = {}) {
  const registry = new Map();
  for (const action of actions) {
    if (!action?.id || !permissions.SERVICES[action.service] || !permissions.KINDS[action.kind]) throw new Error(`Bad action definition: ${action?.id || "(no id)"}`);
    if (registry.has(action.id)) throw new Error(`Action defined twice: ${action.id}`);
    registry.set(action.id, { executor: "server", ...action });
  }
  const context = (db, userId, extra = {}) => ({ db, userId, now, services, ...extra });

  async function fetchRow(db, userId, id) {
    return (await db.query("SELECT * FROM hannah_actions WHERE user_id = $1 AND id = $2", [userId, String(id)])).rows[0] || null;
  }
  async function update(db, userId, id, fields, whereStatus) {
    const names = Object.keys(fields);
    const sets = names.map((name, index) => `${name} = $${index + 1}`);
    const values = names.map((name) => fields[name]);
    values.push(now(), userId, id);
    let sql = `UPDATE hannah_actions SET ${sets.join(", ")}, updated_at = $${names.length + 1} WHERE user_id = $${names.length + 2} AND id = $${names.length + 3}`;
    if (whereStatus) { values.push(whereStatus); sql += ` AND status = $${values.length}`; }
    return (await db.query(sql, values)).rowCount > 0;
  }
  async function usageToday(db, userId, grants) {
    const today = new Map();
    const active = grants.filter((grant) => grant.limits?.perDay);
    if (!active.length) return { today };
    const start = new Date(now()); start.setUTCHours(0, 0, 0, 0);
    for (const grant of active) {
      const { rows } = await db.query("SELECT COUNT(*) AS n FROM hannah_actions WHERE user_id = $1 AND created_at >= $2 AND permission LIKE $3", [userId, start.getTime(), `%"grantId":"${grant.id}"%`]);
      today.set(grant.id, Number(rows[0].n));
    }
    return { today };
  }
  async function decideFor(db, userId, definition, assessed) {
    const policy = await permissions.loadPolicy(db, userId);
    const grants = await permissions.listGrants(db, userId, { now: now(), activeOnly: true });
    const usage = await usageToday(db, userId, grants);
    return permissions.evaluate({ policy, grants, action: definition, call: assessed, now: now(), usage });
  }

  /** Run it, check it, record it. The row is already "executing". */
  async function perform(db, userId, definition, row, params) {
    const ctx = context(db, userId, { record: { id: row.id, taskId: row.task_id } });
    let response;
    try {
      response = await definition.execute(params, ctx);
    } catch (error) {
      const message = error?.status ? error.message : `${definition.title} failed (${error?.code || error?.name || "error"}).`;
      if (!error?.status) console.error(`Action ${definition.id} failed (${error?.code || error?.name || "error"}).`);
      await update(db, userId, row.id, { status: "failed", error: clean(message, 600), executed_at: now() });
      return;
    }
    let verification;
    try {
      verification = definition.verify ? await definition.verify(response, params, ctx) : { confirmed: false, evidence: "This action has no way to be checked afterwards." };
    } catch (error) {
      verification = { confirmed: false, evidence: `The check afterwards failed: ${clean(error?.message, 200) || "error"}.` };
    }
    const confirmed = verification?.confirmed === true;
    await update(db, userId, row.id, {
      status: confirmed ? "done" : "unverified", response: clip(response),
      verification: JSON.stringify({ confirmed, evidence: clean(verification?.evidence, 600), checkedAt: now() }), executed_at: now(),
    });
  }

  async function prune(db, userId) {
    await db.query("DELETE FROM hannah_actions WHERE user_id = $1 AND created_at < $2", [userId, now() - KEEP_MS]);
    const { rows } = await db.query("SELECT COUNT(*) AS n FROM hannah_actions WHERE user_id = $1", [userId]);
    if (Number(rows[0].n) > MAX_ROWS) {
      const cutoff = await db.query("SELECT created_at FROM hannah_actions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 OFFSET $2", [userId, MAX_ROWS - 1]);
      if (cutoff.rows[0]) await db.query("DELETE FROM hannah_actions WHERE user_id = $1 AND created_at < $2", [userId, Number(cutoff.rows[0].created_at)]);
    }
  }

  /**
   * Ask for an action. Returns its record: finished, waiting for approval,
   * prepared only, or refused. `input.approved` doesn't exist on purpose:
   * approval is only ever given through decide().
   */
  async function run(db, userId, input) {
    const definition = registry.get(String(input?.action || ""));
    if (!definition) throw fail(404, `HANNAH has no action called “${clean(input?.action, 80)}”.`, "unknown-action");
    const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null ? null : String(input.idempotencyKey);
    if (idempotencyKey !== null && !KEY_PATTERN.test(idempotencyKey)) throw fail(400, "The idempotency key must be 8 to 120 letters, digits or _ . : -", "bad-request");
    if (idempotencyKey) {
      const { rows } = await db.query("SELECT * FROM hannah_actions WHERE user_id = $1 AND idempotency_key = $2", [userId, idempotencyKey]);
      if (rows[0]) return { ...publicRecord(rows[0], now()), replayed: true };
    }
    const ctx = context(db, userId);
    const params = definition.normalize ? await definition.normalize(input.params || {}, ctx) : (input.params || {});
    const paramsText = JSON.stringify(params);
    if (paramsText.length > MAX_PARAMS) throw fail(413, "This action carries too much data.", "too-large");
    const assessed = (definition.assess ? await definition.assess(params, ctx) : null) || {};
    const decision = await decideFor(db, userId, definition, assessed);
    const preview = definition.preview ? await definition.preview(params, ctx, assessed) : { title: definition.title, lines: [] };
    const id = crypto.randomUUID();
    const at = now();
    const device = definition.executor === "device";
    const status = decision.outcome === "allow" ? (device ? "authorized" : "executing") : decision.outcome === "ask" ? "waiting-approval" : decision.outcome === "suggest" ? "suggested" : "denied";
    const expiresAt = status === "waiting-approval" ? at + (device ? DEVICE_APPROVAL_MS : APPROVAL_MS) : status === "authorized" ? at + DEVICE_APPROVAL_MS : null;
    try {
      await db.query(
        `INSERT INTO hannah_actions (user_id, id, idempotency_key, action, service, kind, status, executor, request, intent, agent, source, task_id, resource, account, params, preview, permission, approval, created_at, updated_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20, $21)`,
        [userId, id, idempotencyKey || id, definition.id, definition.service, definition.kind, status, definition.executor,
          clean(input.request, 1000), clean(input.intent, 400), clean(input.agent, 80), clean(input.source, 40) || "chat", input.taskId ? clean(input.taskId, 80) : null,
          assessed.resource ? JSON.stringify(assessed.resource) : null, clean(assessed.account, 200),
          paramsText, JSON.stringify(preview), JSON.stringify({ ...decision, flags: assessed.flags || [], evaluatedAt: at }),
          JSON.stringify({ status: decision.outcome === "ask" ? "waiting" : decision.outcome === "allow" ? "not-needed" : "not-asked" }), at, expiresAt],
      );
    } catch (error) {
      // Two requests with the same key at once: the first one in is the action.
      if (idempotencyKey) {
        const { rows } = await db.query("SELECT * FROM hannah_actions WHERE user_id = $1 AND idempotency_key = $2", [userId, idempotencyKey]);
        if (rows[0]) return { ...publicRecord(rows[0], now()), replayed: true };
      }
      throw error;
    }
    if (decision.outcome === "allow" && decision.grantId) await permissions.markGrantUsed(db, userId, decision.grantId, at);
    if (status === "executing") await perform(db, userId, definition, { id, task_id: input.taskId || null }, params);
    void prune(db, userId).catch(() => {});
    return publicRecord(await fetchRow(db, userId, id), now());
  }

  /** Approve or decline a waiting action. The first answer wins; an approved action runs now. */
  async function decide(db, userId, id, { approve, by = "" } = {}) {
    const row = await fetchRow(db, userId, id);
    if (!row) throw fail(404, "That action isn't in your history.", "not-found");
    const definition = registry.get(row.action);
    const at = now();
    if (row.status !== "waiting-approval") throw fail(409, `This action is already ${publicRecord(row, at).status}.`, "already-decided", { record: publicRecord(row, at) });
    if (row.expires_at && Number(row.expires_at) <= at) {
      await update(db, userId, row.id, { status: "expired" }, "waiting-approval");
      throw fail(409, "This approval request expired. Ask HANNAH again.", "expired");
    }
    const approval = JSON.stringify({ status: approve ? "approved" : "declined", by: clean(by, 80), at });
    if (!approve) {
      const won = await update(db, userId, row.id, { status: "declined", approval }, "waiting-approval");
      if (!won) throw fail(409, "This action was already answered.", "already-decided");
      return publicRecord(await fetchRow(db, userId, row.id), now());
    }
    if (!definition) {
      await update(db, userId, row.id, { status: "failed", error: "This action no longer exists in HANNAH." }, "waiting-approval");
      throw fail(410, "This action no longer exists in HANNAH.", "gone");
    }
    // Things may have changed while it waited: the stop switch, the level.
    const policy = await permissions.loadPolicy(db, userId);
    const level = policy.levels[definition.service];
    if (policy.stoppedAt || level < 3) {
      const reason = policy.stoppedAt ? "The emergency stop is on." : `${permissions.SERVICES[definition.service].label} is now set to ${permissions.LEVELS[level - 1].name}.`;
      await update(db, userId, row.id, { status: "denied", permission: JSON.stringify({ ...parse(row.permission, {}), outcome: "deny", code: policy.stoppedAt ? "stopped" : "level-lowered", reason }) }, "waiting-approval");
      return publicRecord(await fetchRow(db, userId, row.id), now());
    }
    const device = row.executor === "device";
    const won = await update(db, userId, row.id, { status: device ? "authorized" : "executing", approval, ...(device ? { expires_at: at + DEVICE_APPROVAL_MS } : {}) }, "waiting-approval");
    if (!won) throw fail(409, "This action was already answered.", "already-decided");
    if (!device) await perform(db, userId, definition, row, parse(row.params, {}));
    return publicRecord(await fetchRow(db, userId, row.id), now());
  }

  /** A device says what happened to an action it was authorized to perform. */
  async function report(db, userId, id, { ok, response, verification, error } = {}) {
    const row = await fetchRow(db, userId, id);
    if (!row) throw fail(404, "That action isn't in your history.", "not-found");
    if (row.executor !== "device") throw fail(400, "Only actions a device performs are reported this way.", "bad-request");
    if (row.status !== "authorized") throw fail(409, `This action is ${publicRecord(row, now()).status}; it wasn't authorized to run.`, "not-authorized");
    if (row.expires_at && Number(row.expires_at) <= now()) {
      await update(db, userId, row.id, { status: "expired" }, "authorized");
      throw fail(409, "The authorization expired before the device reported.", "expired");
    }
    const confirmed = ok === true && verification?.confirmed === true;
    const fields = ok === true
      ? { status: confirmed ? "done" : "unverified", response: clip(response), verification: JSON.stringify({ confirmed, evidence: clean(verification?.evidence, 600) || "The device didn't say how it checked.", checkedAt: now(), by: "device" }), executed_at: now() }
      : { status: "failed", error: clean(error, 600) || "The device reported a failure.", executed_at: now() };
    const won = await update(db, userId, row.id, fields, "authorized");
    if (!won) throw fail(409, "This action was already reported.", "already-reported");
    return publicRecord(await fetchRow(db, userId, row.id), now());
  }

  async function get(db, userId, id) {
    const row = await fetchRow(db, userId, id);
    if (!row) throw fail(404, "That action isn't in your history.", "not-found");
    return publicRecord(row, now());
  }

  async function list(db, userId, { status, service, taskId, limit = 50, before } = {}) {
    const where = ["user_id = $1"];
    const values = [userId];
    if (service && permissions.SERVICES[service]) { values.push(service); where.push(`service = $${values.length}`); }
    if (taskId) { values.push(String(taskId)); where.push(`task_id = $${values.length}`); }
    if (before) { values.push(Number(before)); where.push(`created_at < $${values.length}`); }
    if (status === "waiting") where.push("status IN ('waiting-approval', 'authorized')");
    else if (status === "changes") where.push("kind <> 'read'");
    values.push(Math.max(1, Math.min(200, Number(limit) || 50)));
    const { rows } = await db.query(`SELECT * FROM hannah_actions WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return rows.map((row) => publicRecord(row, now())).filter((record) => status !== "waiting" || !record.final);
  }

  /** The emergency stop: nothing but reading runs, and everything that was waiting is cancelled. */
  async function stop(db, userId) {
    const policy = await permissions.setStopped(db, userId, true, now());
    const cancelled = await db.query(
      "UPDATE hannah_actions SET status = 'cancelled', updated_at = $1, error = $2 WHERE user_id = $3 AND status IN ('waiting-approval', 'authorized')",
      [now(), "Cancelled by the emergency stop.", userId],
    );
    return { policy, cancelled: cancelled.rowCount || 0 };
  }
  const resume = (db, userId) => permissions.setStopped(db, userId, false, now());

  /** When each service was last used and how, for the permissions screen. */
  async function lastUsed(db, userId) {
    const out = {};
    for (const service of Object.keys(permissions.SERVICES)) {
      const { rows } = await db.query("SELECT action, status, created_at FROM hannah_actions WHERE user_id = $1 AND service = $2 ORDER BY created_at DESC LIMIT 1", [userId, service]);
      out[service] = rows[0] ? { action: rows[0].action, status: rows[0].status, at: Number(rows[0].created_at) } : null;
    }
    return out;
  }

  /** What exists, for tools, the permissions screen and the documentation. Availability is the caller's to add. */
  function catalog() {
    return [...registry.values()].map((action) => ({
      id: action.id, service: action.service, kind: action.kind, title: action.title, description: action.description || "",
      executor: action.executor, standing: action.kind === "destroy" || action.standing === false || (action.kind === "spend" && action.standing !== true) ? false : action.kind !== "read" && action.kind !== "prepare",
      input: action.input || { type: "object", properties: {} }, needs: action.needs || "",
    }));
  }

  return { catalog, decide, definition: (id) => registry.get(id) || null, get, lastUsed, list, policy: (db, userId) => permissions.loadPolicy(db, userId), registry, report, resume, run, stop };
}

module.exports = { FINAL, createActionEngine, outcomeText, publicRecord };
