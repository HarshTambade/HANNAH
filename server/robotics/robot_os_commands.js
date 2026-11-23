"use strict";

const crypto = require("node:crypto");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const newNonce = () => crypto.randomBytes(12).toString("hex");

function commandMessage(command) {
  return [
    command.id,
    command.robotId,
    command.capability,
    String(command.issuedAt),
    String(command.expiresAt),
    command.nonce,
    sha256(JSON.stringify(command.params ?? {})),
  ].join("\n");
}

function signCommand(secret, command) {
  return crypto.createHmac("sha256", Buffer.from(String(secret))).update(commandMessage(command)).digest("hex");
}

function createRobotOSCommandService({ secrets = {}, now = () => Date.now(), ttlMs = 120_000 } = {}) {
  async function secretFor(db, robotId) {
    if (secrets[robotId]) return secrets[robotId];
    const row = (await db.query("SELECT ciphertext FROM hannah_robots WHERE id = $1 AND status = 'enrolled'", [robotId])).rows[0];
    return row?.ciphertext || null;
  }

  async function issue(db, { userId, robotId, capability, params = {}, secret = null }) {
    const key = secret || await secretFor(db, robotId);
    if (!key) throw Object.assign(new Error("No enrolled key for this Robot OS instance."), { status: 422, reason: "no-secret" });
    const at = now();
    const command = {
      id: `rosc_${crypto.randomBytes(10).toString("hex")}`,
      robotId: String(robotId),
      capability: String(capability),
      params,
      issuedAt: at,
      expiresAt: at + ttlMs,
      nonce: newNonce(),
      signature: "",
      status: "pending",
    };
    command.signature = signCommand(key, command);
    await db.query(
      `INSERT INTO hannah_robot_os_commands
        (id, user_id, robot_id, capability, params, issued_at, expires_at, nonce, signature, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [command.id, userId || null, command.robotId, command.capability, JSON.stringify(params), command.issuedAt, command.expiresAt, command.nonce, command.signature, "pending", at, at],
    );
    return command;
  }

  async function pending(db, robotId) {
    const at = now();
    const rows = await db.query(
      `SELECT id, robot_id, capability, params, issued_at, expires_at, nonce, signature, status
         FROM hannah_robot_os_commands
        WHERE robot_id = $1 AND status = 'pending' AND expires_at > $2
        ORDER BY issued_at ASC LIMIT 20`,
      [robotId, at],
    );
    return (rows.rows || []).map((row) => ({
      id: row.id,
      robotId: row.robot_id,
      capability: row.capability,
      params: (() => { try { return JSON.parse(row.params); } catch { return {}; } })(),
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
      nonce: row.nonce,
      signature: row.signature,
    }));
  }

  async function ack(db, { robotId, commandId, ok, reason = "" }) {
    const result = await db.query(
      `UPDATE hannah_robot_os_commands SET status = $1, ack_reason = $2, updated_at = $3
        WHERE id = $4 AND robot_id = $5 AND status = 'pending'`,
      [ok ? "acked" : "failed", String(reason || "").slice(0, 500), now(), String(commandId || ""), String(robotId || "")],
    );
    return Number(result?.rowCount || 0) > 0;
  }

  async function waitFor(db, userId, commandId, { timeoutMs = 4000, sleep = null, nowFn = now } = {}) {
    const deadline = nowFn() + timeoutMs;
    const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (;;) {
      const command = await get(db, userId, commandId);
      if (!command || command.status !== "pending" || nowFn() >= deadline) return command;
      await pause(Math.min(250, Math.max(1, deadline - nowFn())));
    }
  }

  async function get(db, userId, commandId) {
    const rows = await db.query(
      `SELECT id, robot_id, capability, params, issued_at, expires_at, status, ack_reason
         FROM hannah_robot_os_commands WHERE id = $1 AND user_id = $2`,
      [commandId, userId],
    );
    const row = rows.rows?.[0];
    if (!row) return null;
    return { id: row.id, robotId: row.robot_id, capability: row.capability, status: row.status, ackReason: row.ack_reason || "", expiresAt: Number(row.expires_at) };
  }

  return { issue, pending, ack, get, waitFor, secretFor, signCommand };
}

module.exports = { commandMessage, signCommand, createRobotOSCommandService };
