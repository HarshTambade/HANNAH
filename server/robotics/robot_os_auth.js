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

function createAuthenticator({ secrets = {}, resolveSecret = null, now = () => Date.now() } = {}) {
  const seen = new Map(); // envelope_id -> time, bounded below

  function prune(at) {
    for (const [id, stamp] of seen) if (at - stamp > REPLAY_TTL_MS) seen.delete(id);
  }

  async function verify(env) {
    const at = now();
    const id = String(env.envelope_id || "");
    if (!id || !env.robot_id) return { ok: false, status: 401, reason: "bad-signature" };
    const ts = Number(env.ts_ms);
    if (!Number.isFinite(ts) || Math.abs(at - ts) > SKEW_MS) return { ok: false, status: 401, reason: "clock-skew" };
    prune(at);

    const secret = resolveSecret
      ? await resolveSecret(String(env.robot_id))
      : secrets[String(env.robot_id)];
    if (!secret) return { ok: false, status: 401, reason: "unknown-robot" };
    const expected = signEnvelope(secret, env);
    if (!sameHex(expected, env.signature)) return { ok: false, status: 401, reason: "bad-signature" };
    // Replay is checked only after the signature: a forged request must never
    // poison the seen cache or change the answer for a real later request.
    if (seen.has(id)) return { ok: false, status: 409, reason: "replayed" };

    seen.set(id, at);
    return { ok: true, robot_id: String(env.robot_id) };
  }

  return { verify };
}

module.exports = { SKEW_MS, REPLAY_TTL_MS, envelopeMessage, signEnvelope, createAuthenticator };
