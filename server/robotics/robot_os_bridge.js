"use strict";

const ENVELOPE_KINDS = new Set(["telemetry", "event", "command_ack", "heartbeat", "sync_request"]);

function validateBridgeEnvelope(env) {
  const errors = [];
  if (!env || typeof env !== "object" || Array.isArray(env)) return { ok: false, errors: ["envelope must be object"] };
  for (const f of ["envelope_id", "robot_id", "ts_ms", "kind", "payload"]) {
    if (!(f in env)) errors.push(`missing field: ${f}`);
  }
  if ("kind" in env && !ENVELOPE_KINDS.has(env.kind)) errors.push("invalid kind");
  if ("ts_ms" in env && (!Number.isInteger(env.ts_ms) || env.ts_ms < 0)) errors.push("invalid ts_ms");
  if ("payload" in env && (!env.payload || typeof env.payload !== "object" || Array.isArray(env.payload))) errors.push("invalid payload");
  if ("envelope_id" in env && typeof env.envelope_id !== "string") errors.push("invalid envelope_id");
  if ("robot_id" in env && typeof env.robot_id !== "string") errors.push("invalid robot_id");
  return { ok: errors.length === 0, errors };
}

module.exports = { ENVELOPE_KINDS, validateBridgeEnvelope };
