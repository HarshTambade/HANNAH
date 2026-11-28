"use strict";

const crypto = require("node:crypto");

const SKEW_MS = 60_000;
const REPLAY_TTL_MS = 5 * 60_000;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** Envelope signature: HMAC-SHA256 over the fields that matter, bound to a per-robot secret. */
function envelopeMessage(env) {
  const payload = JSON.stringify(env.payload ?? {});
  return [env.robot_id, String(env.ts_ms), String(env.envelope_id), String(env.kind), sha256(payload)].join("\n");
}

function signEnvelope(secret, env) {
  return crypto.createHmac("sha256", Buffer.from(String(secret))).update(envelopeMessage(env)).digest("hex");
}

function sameHex(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Verify a signed envelope.
 *   claim(scope, id, expiresAt)  optional durable replay store (trust.claimNonce over the database).
 *                                Without it the replay cache lives in this process only, so another
 *                                server instance, or this one after a restart, would accept a copy.
 *   onRefused({ robotId, envelopeId, reason })  optional: called for every refusal (the security audit)
 */
function createAuthenticator({ secrets = {}, resolveSecret = null, now = () => Date.now(), claim = null, onRefused = null } = {}) {
  const seen = new Map(); // envelope_id -> time, bounded below; used only without `claim`

  function prune(at) {
    for (const [id, stamp] of seen) if (at - stamp > REPLAY_TTL_MS) seen.delete(id);
  }
  async function refuse(env, status, reason) {
    if (onRefused) await Promise.resolve().then(() => onRefused({ robotId: String(env?.robot_id || "").slice(0, 80), envelopeId: String(env?.envelope_id || "").slice(0, 120), reason })).catch(() => {});
    return { ok: false, status, reason };
  }

  async function verify(env) {
    const at = now();
    const id = String(env.envelope_id || "");
    if (!id || !env.robot_id) return refuse(env, 401, "bad-signature");
    const ts = Number(env.ts_ms);
    if (!Number.isFinite(ts) || Math.abs(at - ts) > SKEW_MS) return refuse(env, 401, "clock-skew");
    prune(at);

    const secret = resolveSecret
      ? await resolveSecret(String(env.robot_id))
      : secrets[String(env.robot_id)];
    if (!secret) return refuse(env, 401, "unknown-robot");
    const expected = signEnvelope(secret, env);
    if (!sameHex(expected, env.signature)) return refuse(env, 401, "bad-signature");
    // Replay is checked only after the signature: a forged request must never
    // poison the seen cache or change the answer for a real later request.
    // Envelopes outside the skew window are refused above, so keeping an id
    // for skew + TTL covers every copy that could still arrive in time.
    if (claim) {
      if (!(await claim(`robotos:${String(env.robot_id)}`, id, at + SKEW_MS + REPLAY_TTL_MS))) return refuse(env, 409, "replayed");
    } else {
      if (seen.has(id)) return refuse(env, 409, "replayed");
      seen.set(id, at);
    }
    return { ok: true, robot_id: String(env.robot_id) };
  }

  return { verify };
}

module.exports = { SKEW_MS, REPLAY_TTL_MS, envelopeMessage, signEnvelope, createAuthenticator };
