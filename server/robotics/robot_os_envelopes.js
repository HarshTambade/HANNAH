"use strict";

/** Durable, account-scoped storage for signed envelopes from onboard HANNAH Robot OS. */

function ownerFromRegistry(rows) {
  return rows?.[0]?.user_id || null;
}

async function resolveOwner(db, robotId, ownerMap = {}) {
  if (ownerMap[robotId]) return String(ownerMap[robotId]);
  const found = await db.query("SELECT user_id FROM hannah_robots WHERE id = $1", [robotId]);
  return ownerFromRegistry(found.rows);
}

async function saveEnvelope(db, envelope, { ownerMap = {}, now = () => Date.now() } = {}) {
  const robotId = String(envelope.robot_id || "");
  const envelopeId = String(envelope.envelope_id || "");
  const owner = await resolveOwner(db, robotId, ownerMap);
  const at = now();
  const inserted = await db.query(
    `INSERT INTO hannah_robot_os_envelopes
      (envelope_id, user_id, robot_id, kind, ts_ms, received_at, signature, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (envelope_id) DO NOTHING`,
    [envelopeId, owner, robotId, String(envelope.kind || ""), Number(envelope.ts_ms) || 0, at, String(envelope.signature || ""), JSON.stringify(envelope.payload ?? {})],
  );
  return { stored: Number(inserted?.rowCount ?? 0) > 0, owner };
}

async function listEnvelopes(db, userId, { robotId = null, kind = null, limit = 100 } = {}) {
  const clauses = ["user_id = $1"];
  const params = [userId];
  if (robotId) { params.push(String(robotId)); clauses.push(`robot_id = $${params.length}`); }
  if (kind) { params.push(String(kind)); clauses.push(`kind = $${params.length}`); }
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  const rows = await db.query(
    `SELECT envelope_id, user_id, robot_id, kind, ts_ms, received_at, signature, payload
       FROM hannah_robot_os_envelopes WHERE ${clauses.join(" AND ")}
      ORDER BY received_at DESC LIMIT $${params.length}`,
    params,
  );
  return (rows.rows || []).map((row) => ({
    envelopeId: row.envelope_id,
    robotId: row.robot_id,
    kind: row.kind,
    tsMs: Number(row.ts_ms),
    receivedAt: Number(row.received_at),
    hasSignature: Boolean(row.signature),
    payload: (() => { try { return JSON.parse(row.payload); } catch { return {}; } })(),
  }));
}

module.exports = { resolveOwner, saveEnvelope, listEnvelopes };
