"use strict";

/**
 * HANNAH Phone Bridge: a computer asks the user's own phone to place a call,
 * prepare an SMS or look up a contact. The phone's native apps do the
 * cellular work; nothing here calls or texts anyone.
 *
 * Pairing:
 * - A signed-in computer creates a one-time code (10 minutes, stored as a hash).
 * - The phone, signed in to the SAME account, sends the code with a P-256
 *   public key it generated and can't export the private half of, plus the
 *   capabilities the person allowed on the phone.
 * - Both screens show the key's fingerprint so the person can compare them.
 *
 * Commands:
 * - Expire 60 seconds after they're created. A phone that wasn't seen in the
 *   last 45 seconds is reported offline and gets nothing, so a call or SMS is
 *   never queued to happen later.
 * - The phone fetches and reports with requests signed by its device key
 *   (device id, time within 60 s, method, path, SHA-256 of the exact body).
 * - Each command carries a nonce that the phone checks and signs back with
 *   its result.
 * - A result is accepted once, from that phone, in a valid order.
 *
 * Refusals: emergency numbers, USSD and MMI codes (* and #), anything that
 * isn't a phone number, capabilities the phone didn't allow, and revoked phones.
 *
 * States are only what can be verified: sent to the phone, delivered,
 * dialer opened, composer opened, the person sent or cancelled (iOS reports
 * this for SMS), declined on the phone, failed or expired. "Call connected"
 * isn't one: the phone's dialer doesn't tell apps that.
 */
const crypto = require("node:crypto");
const express = require("express");
const { getDatabase } = require("./db");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60_000;
const COMMAND_TTL_MS = 60_000;
const RESULT_WINDOW_MS = 10 * 60_000;
const ONLINE_MS = 45_000;
const SIGNATURE_SKEW_MS = 60_000;
const CAPABILITIES = ["call", "sms", "contacts"];
const ACTIONS = { call: "call", sms: "sms", lookup: "contacts" };
const PLATFORMS = new Set(["android", "ios"]);
const ID = /^[A-Za-z0-9_-]{8,80}$/;
// Emergency and service numbers are never dialled for anyone: the person dials those themselves.
const EMERGENCY = new Set(["000", "08", "100", "101", "102", "103", "108", "110", "112", "113", "115", "118", "119", "122", "15", "17", "18", "911", "999", "1122", "1091", "1098", "181"]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString("hex")}`;
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const parse = (text, fallback = null) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

/** A number the phone may dial or text: digits with an optional leading +, no service codes. */
function normalizeNumber(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw fail(400, "Give a phone number.", "bad-number");
  if (/[*#]/.test(raw)) throw fail(400, "Codes with * or # aren't dialled by HANNAH.", "bad-number");
  if (!/^\+?[\d\s().-]{3,25}$/.test(raw)) throw fail(400, `“${raw.slice(0, 40)}” isn't a phone number.`, "bad-number");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 17) throw fail(400, `“${raw.slice(0, 40)}” isn't a phone number.`, "bad-number");
  // Also a country code in front of one (+1 911, 0112): short numbers ending in an emergency number.
  const emergency = EMERGENCY.has(digits) || (digits.length <= 5 && [...EMERGENCY].some((number) => number.length >= 3 && digits.endsWith(number)));
  if (emergency) throw fail(400, "HANNAH doesn't call or text emergency numbers. Dial it yourself on your phone.", "emergency");
  return `${raw.startsWith("+") ? "+" : ""}${digits}`;
}

function fingerprintOf(jwk) {
  const hex = sha256(`${jwk.x}.${jwk.y}`);
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12)].join(" ").toUpperCase();
}

function readPublicKey(input) {
  const jwk = input && typeof input === "object" ? input : null;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.d) throw fail(400, "The phone's key isn't a P-256 public key.", "bad-key");
  try {
    crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
  } catch {
    throw fail(400, "The phone's key isn't a valid P-256 public key.", "bad-key");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** What a phone signs for a request: id, time, method, path and the body's hash. */
function signedMessage({ phoneId, time, method, path, body }) {
  return `${phoneId}\n${time}\n${method.toUpperCase()}\n${path}\n${sha256(body || "")}`;
}

function verifySignature(jwk, message, signature) {
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    return crypto.verify("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(String(signature), "base64url"));
  } catch {
    return false;
  }
}

const publicPhone = (row, now) => ({
  id: row.id, name: row.name, platform: row.platform, fingerprint: row.fingerprint, capabilities: parse(row.capabilities, []),
  isDefault: Boolean(Number(row.is_default)), pairedBy: row.paired_by || null, createdAt: Number(row.created_at),
  lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
  online: row.last_seen_at !== null && now - Number(row.last_seen_at) < ONLINE_MS,
});

function publicCommand(row, now) {
  const status = row.status === "pending" && Number(row.expires_at) <= now ? "expired" : row.status === "delivered" && Number(row.delivered_at) + RESULT_WINDOW_MS <= now ? "no-report" : row.status;
  return {
    id: row.id, phoneId: row.phone_id, action: row.action, payload: parse(row.payload, {}), status, requestedBy: row.requested_by || null,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at), result: parse(row.result, null),
  };
}

// The results a phone may report, by action, and the order they may come in.
const RESULTS = {
  call: new Set(["dialer-opened", "declined", "failed"]),
  sms: new Set(["composer-opened", "sent", "cancelled", "declined", "failed"]),
  lookup: new Set(["resolved", "declined", "failed"]),
};
const FINAL = new Set(["declined", "failed", "sent", "cancelled", "resolved", "dialer-opened", "expired", "no-report"]);

/**
 * Queue one request for a paired phone, with every check: the action, the
 * phone (the given one, or the default), the capability the person allowed on
 * it, that it's online right now, and the number's rules. Used by the
 * computer's API and by workflow steps, so both follow the same rules.
 * A workflow step's request carries its execution and step, and the same
 * step's request that is still open is returned instead of a second one.
 */
async function createPhoneCommand(db, userId, input, { now = () => Date.now(), executionId = null, nodeId = null } = {}) {
  const action = String(input?.action || "");
  if (!ACTIONS[action]) throw fail(400, "The action must be call, sms or lookup.", "bad-request");
  if (executionId) {
    const { rows: [open] } = await db.query("SELECT * FROM hannah_phone_commands WHERE user_id = $1 AND execution_id = $2 AND node_id = $3 AND status IN ('pending', 'delivered', 'composer-opened') ORDER BY created_at DESC LIMIT 1", [userId, executionId, nodeId]);
    if (open && !(open.status === "pending" && Number(open.expires_at) <= now())) {
      const { rows: [phone] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1", [open.phone_id]);
      return { command: publicCommand(open, now()), phone: publicPhone(phone, now()), reused: true };
    }
  }
  const { rows: phones } = await db.query("SELECT * FROM hannah_paired_phones WHERE user_id = $1 AND revoked_at IS NULL ORDER BY is_default DESC, last_seen_at DESC", [userId]);
  if (!phones.length) throw fail(409, "No phone is paired. Pair one in Settings → Phone.", "no-phone");
  const wanted = input?.phoneId ? phones.find((phone) => phone.id === String(input.phoneId) || phone.name.toLowerCase() === String(input.phoneId).toLowerCase()) : phones[0];
  if (!wanted) throw fail(404, "That phone isn't paired.", "not-found");
  const capabilities = parse(wanted.capabilities, []);
  if (!capabilities.includes(ACTIONS[action])) throw fail(403, `${wanted.name} doesn't allow ${action === "lookup" ? "contact lookups" : action === "sms" ? "preparing SMS" : "calls"}. Turn it on in HANNAH on the phone (Settings → Phone).`, "not-allowed");
  const at = now();
  if (wanted.last_seen_at === null || at - Number(wanted.last_seen_at) >= ONLINE_MS) {
    throw fail(409, `${wanted.name} is offline: open HANNAH on it with “Use this phone from my computer” on, then try again. Nothing was sent.`, "phone-offline");
  }
  let payload;
  if (action === "lookup") {
    const query = clean(input?.query, 80);
    if (query.length < 2) throw fail(400, "Give at least two letters of the name.", "bad-request");
    payload = { query };
  } else {
    payload = { number: normalizeNumber(input?.number), name: clean(input?.name, 80) || null };
    if (action === "sms") {
      const body = clean(input?.body, 1000);
      if (!body) throw fail(400, "Write the message.", "bad-request");
      payload.body = body;
    }
  }
  const id = newId("pc");
  const nonce = crypto.randomBytes(16).toString("base64url");
  await db.query(
    "INSERT INTO hannah_phone_commands (id, user_id, phone_id, action, payload, nonce, status, requested_by, created_at, expires_at, execution_id, node_id) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11)",
    [id, userId, wanted.id, action, JSON.stringify(payload), nonce, clean(input?.deviceName, 80) || "A computer", at, at + COMMAND_TTL_MS, executionId, nodeId],
  );
  await db.query("DELETE FROM hannah_phone_commands WHERE user_id = $1 AND created_at < $2", [userId, at - 30 * 86_400_000]);
  const { rows: [row] } = await db.query("SELECT * FROM hannah_phone_commands WHERE id = $1", [id]);
  return { command: publicCommand(row, now()), phone: publicPhone(wanted, now()) };
}

/** The account's paired phones, as the dashboard shows them. */
async function listPhones(db, userId, now = Date.now()) {
  const { rows } = await db.query("SELECT * FROM hannah_paired_phones WHERE user_id = $1 AND revoked_at IS NULL ORDER BY is_default DESC, created_at", [userId]);
  return rows.map((row) => publicPhone(row, now));
}

/** When a request is over as far as HANNAH can tell (Android doesn't report a send after the composer opens). */
const settled = (command, platform) => FINAL.has(command.status) || (command.status === "composer-opened" && platform === "android");

function createPhoneBridgeRouter({ now = () => Date.now(), hooks = {} } = {}) {
  // A workflow step waiting on a request hears when the phone picks it up and when it's settled.
  const tell = async (event, row, phone) => {
    if (!row.execution_id || !hooks[event]) return;
    try {
      const { rows: [fresh] } = await (await getDatabase()).query("SELECT * FROM hannah_phone_commands WHERE id = $1", [row.id]);
      await hooks[event]({ userId: row.user_id, executionId: row.execution_id, nodeId: row.node_id, command: publicCommand(fresh || row, now()), platform: phone.platform, resultWindowMs: RESULT_WINDOW_MS });
    } catch (error) {
      console.error(`Phone bridge workflow hook failed (${error?.code || error?.name || "error"}).`);
    }
  };
  const router = express.Router();
  // The raw body is kept: a phone's signature covers its exact bytes.
  const json = express.json({ limit: "64kb", verify: (req, _res, buffer) => { req.rawBody = buffer.toString("utf8"); } });

  const withAccount = (handler) => async (req, res) => {
    try {
      const account = res.locals.hannahAccount;
      if (!account || account.via !== "session") throw fail(401, "Sign in to use your phone with HANNAH.", "signin-required");
      const db = await getDatabase().catch(() => null);
      if (!db) throw fail(503, "The phone bridge needs the account database.", "database-required");
      return await handler(req, res, db, account);
    } catch (error) {
      if (!error.status) console.error(`Phone bridge request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "The phone request failed.", reason: error.reason });
    }
  };

  /** Requests from a paired phone: the account session AND the phone's signature. */
  const withPhone = (handler) => withAccount(async (req, res, db, account) => {
    const phoneId = String(req.get("x-hannah-phone") || "");
    const time = Number(req.get("x-hannah-time"));
    const signature = String(req.get("x-hannah-signature") || "");
    if (!ID.test(phoneId) || !Number.isFinite(time) || !signature) throw fail(401, "This phone isn't paired.", "not-paired");
    const { rows: [phone] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1 AND user_id = $2", [phoneId, account.id]);
    if (!phone || phone.revoked_at !== null) throw fail(403, "This phone's pairing was removed. Pair it again from your computer.", "revoked");
    if (Math.abs(now() - time) > SIGNATURE_SKEW_MS) throw fail(401, "This phone's clock is off by more than a minute. Set it to automatic time.", "clock");
    const message = signedMessage({ phoneId, time, method: req.method, path: req.baseUrl + req.path, body: req.rawBody || "" });
    if (!verifySignature(parse(phone.public_key, {}), message, signature)) throw fail(401, "The phone's signature didn't match. Pair it again.", "bad-signature");
    await db.query("UPDATE hannah_paired_phones SET last_seen_at = $1 WHERE id = $2", [now(), phone.id]);
    return handler(req, res, db, account, phone);
  });

  // ----- the computer (or web app) -----

  router.post("/phone/pairing", json, withAccount(async (req, res, db, account) => {
    const at = now();
    await db.query("DELETE FROM hannah_phone_pairing_codes WHERE user_id = $1 AND (expires_at < $2 OR used_at IS NOT NULL)", [account.id, at - 86_400_000]);
    const { rows: [active] } = await db.query("SELECT COUNT(*) AS n FROM hannah_phone_pairing_codes WHERE user_id = $1 AND used_at IS NULL AND expires_at > $2", [account.id, at]);
    if (Number(active.n) >= 3) throw fail(429, "Three pairing codes are already waiting. Use one, or wait 10 minutes.", "too-many");
    const raw = Array.from(crypto.randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    await db.query("INSERT INTO hannah_phone_pairing_codes (code_hash, user_id, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)", [sha256(raw), account.id, clean(req.body?.deviceName, 80) || "A computer", at, at + CODE_TTL_MS]);
    res.status(201).json({ code, expiresAt: at + CODE_TTL_MS });
  }));

  router.post("/phone/pairing/status", json, withAccount(async (req, res, db, account) => {
    const raw = String(req.body?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const { rows: [row] } = await db.query("SELECT * FROM hannah_phone_pairing_codes WHERE code_hash = $1 AND user_id = $2", [sha256(raw), account.id]);
    if (!row) throw fail(404, "That pairing code doesn't exist.", "not-found");
    if (!row.phone_id) return res.json({ paired: false, expired: Number(row.expires_at) <= now() });
    const { rows: [phone] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1 AND user_id = $2", [row.phone_id, account.id]);
    res.json({ paired: true, phone: phone ? publicPhone(phone, now()) : null });
  }));

  router.get("/phone/devices", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_paired_phones WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at", [account.id]);
    res.json({ phones: rows.map((row) => publicPhone(row, now())) });
  }));

  router.put("/phone/devices/:id", json, withAccount(async (req, res, db, account) => {
    const { rows: [phone] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [String(req.params.id), account.id]);
    if (!phone) throw fail(404, "That phone isn't paired.", "not-found");
    if (req.body?.isDefault === true) {
      await db.query("UPDATE hannah_paired_phones SET is_default = 0 WHERE user_id = $1", [account.id]);
      await db.query("UPDATE hannah_paired_phones SET is_default = 1 WHERE id = $1", [phone.id]);
    }
    const name = clean(req.body?.name, 60);
    if (name) await db.query("UPDATE hannah_paired_phones SET name = $1 WHERE id = $2", [name, phone.id]);
    const { rows: [updated] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1", [phone.id]);
    res.json({ phone: publicPhone(updated, now()) });
  }));

  router.delete("/phone/devices/:id", withAccount(async (req, res, db, account) => {
    const { rowCount } = await db.query("UPDATE hannah_paired_phones SET revoked_at = $1, is_default = 0 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL", [now(), String(req.params.id), account.id]);
    if (!rowCount) throw fail(404, "That phone isn't paired.", "not-found");
    await db.query("UPDATE hannah_phone_commands SET status = 'expired', finished_at = $1 WHERE phone_id = $2 AND status IN ('pending', 'delivered')", [now(), String(req.params.id)]);
    res.json({ revoked: true });
  }));

  router.post("/phone/commands", json, withAccount(async (req, res, db, account) => {
    const { command, phone } = await createPhoneCommand(db, account.id, req.body || {}, { now });
    res.status(201).json({ command, phone });
  }));

  router.get("/phone/commands", withAccount(async (req, res, db, account) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const { rows } = await db.query(`SELECT * FROM hannah_phone_commands WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${limit}`, [account.id]);
    res.json({ commands: rows.map((row) => publicCommand(row, now())) });
  }));

  router.get("/phone/commands/:id", withAccount(async (req, res, db, account) => {
    const { rows: [row] } = await db.query("SELECT * FROM hannah_phone_commands WHERE id = $1 AND user_id = $2", [String(req.params.id), account.id]);
    if (!row) throw fail(404, "That phone request doesn't exist.", "not-found");
    res.json({ command: publicCommand(row, now()) });
  }));

  router.post("/phone/commands/:id/cancel", withAccount(async (req, res, db, account) => {
    const { rowCount } = await db.query("UPDATE hannah_phone_commands SET status = 'cancelled', finished_at = $1, result = $2 WHERE id = $3 AND user_id = $4 AND status = 'pending'", [now(), JSON.stringify({ by: "computer" }), String(req.params.id), account.id]);
    if (!rowCount) throw fail(409, "The phone already received this request; cancel it on the phone.", "already-delivered");
    res.json({ status: "cancelled" });
  }));

  // ----- the phone -----

  router.post("/phone/pair", json, withAccount(async (req, res, db, account) => {
    const raw = String(req.body?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const platform = String(req.body?.platform || "");
    if (!PLATFORMS.has(platform)) throw fail(400, "Pair from the HANNAH app on Android or iPhone.", "bad-platform");
    const publicKey = readPublicKey(req.body?.publicKey);
    const capabilities = [...new Set((Array.isArray(req.body?.capabilities) ? req.body.capabilities : []).filter((item) => CAPABILITIES.includes(item)))];
    const at = now();
    // The code must belong to this same account: a code can't pair a phone to someone else's.
    const { rows: [row] } = await db.query("SELECT * FROM hannah_phone_pairing_codes WHERE code_hash = $1 AND user_id = $2", [sha256(raw), account.id]);
    if (!row || row.used_at !== null || Number(row.expires_at) <= at) throw fail(400, "That code is wrong, used or expired. Make a new one on your computer, signed in to this same account.", "bad-code");
    const id = newId("ph");
    const { rowCount } = await db.query("UPDATE hannah_phone_pairing_codes SET used_at = $1, phone_id = $2 WHERE code_hash = $3 AND used_at IS NULL", [at, id, row.code_hash]);
    if (rowCount !== 1) throw fail(400, "That code was just used.", "bad-code");
    const { rows: [existing] } = await db.query("SELECT COUNT(*) AS n FROM hannah_paired_phones WHERE user_id = $1 AND revoked_at IS NULL", [account.id]);
    await db.query(
      "INSERT INTO hannah_paired_phones (id, user_id, name, platform, public_key, fingerprint, capabilities, is_default, paired_by, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)",
      [id, account.id, clean(req.body?.name, 60) || (platform === "ios" ? "iPhone" : "Android phone"), platform, JSON.stringify(publicKey), fingerprintOf(publicKey), JSON.stringify(capabilities), Number(existing.n) === 0 ? 1 : 0, row.created_by, at],
    );
    const { rows: [phone] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1", [id]);
    res.status(201).json({ phone: publicPhone(phone, now()) });
  }));

  router.post("/phone/me/heartbeat", json, withPhone(async (req, res, db, _account, phone) => {
    if (Array.isArray(req.body?.capabilities)) {
      const capabilities = [...new Set(req.body.capabilities.filter((item) => CAPABILITIES.includes(item)))];
      await db.query("UPDATE hannah_paired_phones SET capabilities = $1 WHERE id = $2", [JSON.stringify(capabilities), phone.id]);
    }
    const { rows: [updated] } = await db.query("SELECT * FROM hannah_paired_phones WHERE id = $1", [phone.id]);
    res.json({ phone: publicPhone(updated, now()), serverTime: now() });
  }));

  // Pending requests for this phone; fetching one marks it delivered, so it's handed out once.
  router.post("/phone/me/commands", json, withPhone(async (_req, res, db, _account, phone) => {
    const at = now();
    const { rows } = await db.query("SELECT * FROM hannah_phone_commands WHERE phone_id = $1 AND status = 'pending' AND expires_at > $2 ORDER BY created_at LIMIT 5", [phone.id, at]);
    const delivered = [];
    for (const row of rows) {
      const { rowCount } = await db.query("UPDATE hannah_phone_commands SET status = 'delivered', delivered_at = $1 WHERE id = $2 AND status = 'pending'", [at, row.id]);
      if (rowCount === 1) {
        delivered.push({ id: row.id, action: row.action, payload: parse(row.payload, {}), nonce: row.nonce, expiresAt: Number(row.expires_at), requestedBy: row.requested_by });
        await tell("delivered", row, phone);
      }
    }
    res.json({ commands: delivered, serverTime: at });
  }));

  router.post("/phone/me/commands/:id/result", json, withPhone(async (req, res, db, _account, phone) => {
    const { rows: [row] } = await db.query("SELECT * FROM hannah_phone_commands WHERE id = $1 AND phone_id = $2", [String(req.params.id), phone.id]);
    if (!row) throw fail(404, "That request isn't for this phone.", "not-found");
    if (String(req.body?.nonce || "") !== row.nonce) throw fail(400, "The request's nonce doesn't match.", "bad-nonce");
    const status = String(req.body?.status || "");
    if (!RESULTS[row.action]?.has(status)) throw fail(400, `“${status}” isn't a result for ${row.action}.`, "bad-status");
    const at = now();
    const result = { detail: clean(req.body?.detail, 300) || null };
    if (row.action === "lookup" && status === "resolved") {
      result.matches = (Array.isArray(req.body?.matches) ? req.body.matches : []).slice(0, 10).map((match) => ({
        name: clean(match?.name, 80),
        numbers: (Array.isArray(match?.numbers) ? match.numbers : []).slice(0, 6).map((number) => ({ label: clean(number?.label, 30) || null, number: clean(number?.number, 30) })).filter((number) => number.number),
      })).filter((match) => match.name && match.numbers.length);
    }
    // An SMS composer can be followed by the person's send or cancel (iOS reports it); everything else ends the request.
    const from = status === "sent" || status === "cancelled" ? ["delivered", "composer-opened"] : ["delivered"];
    if (Number(row.delivered_at) + RESULT_WINDOW_MS <= at) throw fail(409, "This request is too old to report on.", "too-late");
    const { rowCount } = await db.query(
      `UPDATE hannah_phone_commands SET status = $1, result = $2, finished_at = $3 WHERE id = $4 AND status IN (${from.map((_, index) => `$${index + 5}`).join(", ")})`,
      [status, JSON.stringify(result), FINAL.has(status) ? at : null, row.id, ...from],
    );
    if (rowCount !== 1) throw fail(409, `This request already ended (${row.status}).`, "final");
    if (settled({ status }, phone.platform)) await tell("settled", row, phone);
    res.json({ status });
  }));

  router.delete("/phone/me", withPhone(async (_req, res, db, _account, phone) => {
    await db.query("UPDATE hannah_paired_phones SET revoked_at = $1, is_default = 0 WHERE id = $2", [now(), phone.id]);
    res.json({ revoked: true });
  }));

  return router;
}

module.exports = { CAPABILITIES, COMMAND_TTL_MS, EMERGENCY, RESULT_WINDOW_MS, createPhoneBridgeRouter, createPhoneCommand, listPhones, settled, fingerprintOf, normalizeNumber, signedMessage, verifySignature };
