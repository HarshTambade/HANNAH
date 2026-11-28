"use strict";

/**
 * The audit trail for maintenance and diagnostics: every incident opened or
 * cleared, every recovery attempted (and refused), every verdict, confirmation
 * and maintenance task. Rows are append-only. Server-wide entries (incidents
 * on the server itself) have no user_id and are shown only to an administrator.
 */
const crypto = require("node:crypto");

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

async function audit(db, { userId = null, area, subjectId = null, actor, event, detail = null, at = Date.now() }) {
  await db.query("INSERT INTO hannah_ops_audit (id, user_id, at, area, subject_id, actor, event, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    crypto.randomUUID(), userId, at, clean(area, 40), subjectId ? clean(subjectId, 120) : null, clean(actor, 120) || "unknown", clean(event, 80), detail ? JSON.stringify(detail).slice(0, 8000) : null,
  ]);
}

async function list(db, { userId = null, includeServer = false, area = null, subjectId = null, limit = 100 } = {}) {
  const where = [];
  const values = [];
  if (userId && includeServer) { values.push(userId); where.push(`(user_id = $${values.length} OR user_id IS NULL)`); } else if (userId) { values.push(userId); where.push(`user_id = $${values.length}`); } else where.push("user_id IS NULL");
  if (area) { values.push(area); where.push(`area = $${values.length}`); }
  if (subjectId) { values.push(subjectId); where.push(`subject_id = $${values.length}`); }
  values.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  const { rows } = await db.query(`SELECT * FROM hannah_ops_audit WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT $${values.length}`, values);
  return rows.map((row) => ({ id: row.id, at: Number(row.at), area: row.area, subjectId: row.subject_id, actor: row.actor, event: row.event, detail: parse(row.detail), server: row.user_id === null }));
}

module.exports = { audit, list };
