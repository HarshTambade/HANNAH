"use strict";

/**
 * Zero-trust device identity: who a device is, how it proves it, and for how
 * long.
 *
 * What it is built from (and what it is not):
 *   - Each account has its own certificate authority: an ECDSA P-256 key,
 *     sealed with the vault, and a self-signed X.509 certificate made with
 *     node:crypto (x509.js). Real X.509, not Ed25519 attestations: OpenSSL
 *     verifies the certificates, TLS uses them for mutual authentication, and
 *     the same code signs the SROS 2 keystore.
 *   - A device is registered by a signed-in person first. Registration gives a
 *     one-time code (15 minutes, stored as a hash) and may name the hardware
 *     id the device must present (a serial number, a TPM endorsement key hash).
 *   - The device makes its own key pair; its private key never leaves it. It
 *     enrolls with the code, its public key and a signature with that key over
 *     the code (proof of possession). It gets a certificate for that key,
 *     valid for the account's certificateDays (default 7).
 *   - For everything else it asks for a short-lived credential (default 15
 *     minutes), signing a fresh nonce with its key. The nonce is claimed in a
 *     durable store, so a replayed request is refused on every server
 *     instance. Only the credential's hash is stored.
 *   - Rotation: a new key, signed for by the old one, gets a new certificate;
 *     the old certificate is revoked as superseded and its credentials end.
 *   - Revocation ends a device's certificate and credentials at once.
 *   - A device nobody registered is quarantined or rejected, by the account's
 *     policy. A quarantined device gets nothing; a person decides about it.
 *   - Every refusal and every change is written to the security audit.
 */
const crypto = require("node:crypto");
const { decryptSecret, encryptSecret, vaultConfigured } = require("../vault");
const x509 = require("./x509");

const DAY = 86_400_000;
const CODE_TTL_MS = 15 * 60_000;
const SKEW_MS = 60_000;
const CA_YEARS = 10;
const DEFAULT_POLICY = Object.freeze({
  unknownDevices: "quarantine",
  certificateDays: 7,
  credentialMinutes: 15,
  robotSecretMaxAgeDays: null,
  requireMtlsForRobotLink: false,
});
const KINDS = new Set(["robot", "hub", "agv", "sensor", "controller", "gateway", "other"]);
const ENROLL_LABEL = "hannah-trust-enroll-v1";
const CREDENTIAL_LABEL = "hannah-trust-credential-v1";
const ROTATE_LABEL = "hannah-trust-rotate-v1";
const DEVICE_URN = "urn:hannah:device:";

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { try { return text ? JSON.parse(text) ?? fallback : fallback; } catch { return fallback; } };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const ID = /^[A-Za-z0-9_.:-]{3,80}$/;
const codeHash = (code) => sha256(`hannah-trust-code:${String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")}`);
const tokenHash = (token) => sha256(`hannah-trust-token:${token}`);
const newCode = () => { const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; const bytes = crypto.randomBytes(10); const text = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join(""); return `${text.slice(0, 5)}-${text.slice(5)}`; };

/** The exact bytes a device signs, so both sides build them the same way. */
const enrollMessage = ({ deviceId, code, publicKey }) => `${ENROLL_LABEL}\n${deviceId}\n${String(code).toUpperCase()}\n${sha256(String(publicKey).trim())}`;
const credentialMessage = ({ deviceId, time, nonce, scope }) => `${CREDENTIAL_LABEL}\n${deviceId}\n${time}\n${nonce}\n${scope}`;
const rotateMessage = ({ deviceId, time, nonce, publicKey }) => `${ROTATE_LABEL}\n${deviceId}\n${time}\n${nonce}\n${sha256(String(publicKey).trim())}`;

function readPublicKey(pem) {
  let key;
  try { key = crypto.createPublicKey(String(pem || "")); } catch { throw fail(400, "The public key isn't a PEM public key.", "bad-key"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw fail(400, "Device keys are ECDSA P-256 (prime256v1).", "bad-key");
  return key;
}
function verifySignature(key, message, signature) {
  try { return crypto.verify("sha256", Buffer.from(message, "utf8"), key, Buffer.from(String(signature || ""), "base64")); } catch { return false; }
}

function createTrustService({ now = () => Date.now() } = {}) {
  let sweeps = 0;

  // ---------- audit ----------
  async function audit(db, { userId = null, deviceId = null, kind, decision, reason = "", detail = null }) {
    await db.query("INSERT INTO hannah_security_audit (id, user_id, at, device_id, kind, decision, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [`sa_${crypto.randomBytes(9).toString("hex")}`, userId, now(), deviceId ? clean(deviceId, 120) : null, clean(kind, 60), clean(decision, 20), clean(reason, 400), detail ? JSON.stringify(detail).slice(0, 4000) : null]);
  }
  async function listAudit(db, userId, { limit = 100, deviceId = null } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (deviceId) { values.push(String(deviceId)); where += ` AND device_id = $${values.length}`; }
    values.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    const { rows } = await db.query(`SELECT * FROM hannah_security_audit WHERE ${where} ORDER BY at DESC LIMIT $${values.length}`, values);
    return rows.map((row) => ({ id: row.id, at: Number(row.at), deviceId: row.device_id, kind: row.kind, decision: row.decision, reason: row.reason || "", detail: parse(row.detail) }));
  }

  // ---------- replay protection ----------
  /** Claim a nonce once in `scope` until `expiresAt`. False when it was already used: a replay. Works across server instances. */
  async function claimNonce(db, scope, nonce, expiresAt) {
    const value = String(nonce || "");
    if (!value || value.length > 200) return false;
    if ((sweeps += 1) % 200 === 0) await db.query("DELETE FROM hannah_nonces WHERE expires_at < $1", [now()]).catch(() => {});
    const inserted = await db.query("INSERT INTO hannah_nonces (scope, nonce, expires_at) VALUES ($1, $2, $3) ON CONFLICT (scope, nonce) DO NOTHING", [clean(scope, 120), value, Math.round(Number(expiresAt) || now() + 10 * 60_000)]);
    return Number(inserted.rowCount || 0) > 0;
  }

  // ---------- policy ----------
  async function getPolicy(db, userId) {
    const row = (await db.query("SELECT policy FROM hannah_device_policy WHERE user_id = $1", [userId])).rows[0];
    return { ...DEFAULT_POLICY, ...parse(row?.policy, {}) };
  }
  async function setPolicy(db, userId, change = {}) {
    const policy = await getPolicy(db, userId);
    const next = { ...policy };
    if (change.unknownDevices !== undefined) {
      if (!["quarantine", "reject"].includes(change.unknownDevices)) throw fail(400, "Unknown devices are either quarantined or rejected.", "bad-request");
      next.unknownDevices = change.unknownDevices;
    }
    if (change.certificateDays !== undefined) {
      const days = Number(change.certificateDays);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw fail(400, "Certificates last 1 to 90 days.", "bad-request");
      next.certificateDays = days;
    }
    if (change.credentialMinutes !== undefined) {
      const minutes = Number(change.credentialMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw fail(400, "Credentials last 1 to 60 minutes.", "bad-request");
      next.credentialMinutes = minutes;
    }
    if (change.robotSecretMaxAgeDays !== undefined) {
      const days = change.robotSecretMaxAgeDays === null ? null : Number(change.robotSecretMaxAgeDays);
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 730)) throw fail(400, "A robot's secret may be kept 1 to 730 days, or without limit.", "bad-request");
      next.robotSecretMaxAgeDays = days;
    }
    if (change.requireMtlsForRobotLink !== undefined) next.requireMtlsForRobotLink = change.requireMtlsForRobotLink === true;
    await db.query("INSERT INTO hannah_device_policy (user_id, policy, updated_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = EXCLUDED.updated_at", [userId, JSON.stringify(next), now()]);
    await audit(db, { userId, kind: "policy-changed", decision: "changed", reason: "Device security policy changed by a signed-in person.", detail: { before: policy, after: next } });
    return next;
  }

  // ---------- the account's CA ----------
  /** The account's CA for `purpose`, made on first use. Returns { certPem, certificate, privateKey }. */
  async function ensureCA(db, userId, purpose = "devices", { commonName = "HANNAH device CA" } = {}) {
    const found = (await db.query("SELECT * FROM hannah_account_ca WHERE user_id = $1 AND purpose = $2", [userId, purpose])).rows[0];
    if (found) {
      let keyPem;
      try { keyPem = decryptSecret(found, { userId, providerId: `ca:${purpose}` }).secret; } catch { throw fail(503, "The server can't read this account's certificate authority key.", "vault-key-missing"); }
      return { certPem: found.cert_pem, certificate: new crypto.X509Certificate(found.cert_pem), privateKey: crypto.createPrivateKey(keyPem) };
    }
    if (!vaultConfigured()) throw fail(503, "This server has no key vault to keep a certificate authority key in.", "vault-unconfigured");
    const pair = x509.newKeyPair();
    const at = now();
    const made = x509.createCertificate({ subject: { CN: commonName, O: "HANNAH", OU: `account ${String(userId).slice(0, 12)}` }, publicKey: pair.publicKey, signingKey: pair.privateKey, notBefore: at - 60_000, notAfter: at + CA_YEARS * 365 * DAY, ca: true, pathLength: 0, keyUsage: ["digitalSignature", "keyCertSign", "cRLSign"] });
    const sealed = encryptSecret(x509.privatePem(pair.privateKey), { userId, providerId: `ca:${purpose}` });
    const inserted = await db.query("INSERT INTO hannah_account_ca (user_id, purpose, cert_pem, key_id, wrapped_key, ciphertext, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, purpose) DO NOTHING", [userId, purpose, made.pem, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, at]);
    if (!Number(inserted.rowCount)) return ensureCA(db, userId, purpose, { commonName }); // another request made it first
    await audit(db, { userId, kind: "ca-created", decision: "created", reason: `Certificate authority “${purpose}” created.`, detail: { fingerprint: made.certificate.fingerprint256 } });
    return { certPem: made.pem, certificate: made.certificate, privateKey: pair.privateKey };
  }

  async function issueCertificate(db, userId, { deviceId, publicKey, hardwareId = null, days }) {
    const ca = await ensureCA(db, userId);
    const at = now();
    return x509.createCertificate({
      subject: { CN: deviceId, O: "HANNAH device", ...(hardwareId ? { serialNumber: hardwareId } : {}) },
      issuer: subjectOf(ca.certificate), publicKey, signingKey: ca.privateKey, issuerPublicKey: ca.certificate.publicKey,
      notBefore: at - 60_000, notAfter: at + days * DAY, keyUsage: ["digitalSignature"], extKeyUsage: ["clientAuth"], uris: [`${DEVICE_URN}${deviceId}`],
    });
  }

  // ---------- identities ----------
  function view(row, at = now()) {
    if (!row) return null;
    const notAfter = row.cert_not_after ? Number(row.cert_not_after) : null;
    const certificate = row.status === "active" && notAfter ? (notAfter <= at ? "expired" : "valid") : row.cert_serial ? "none-current" : "none";
    return {
      deviceId: row.device_id, kind: row.kind, status: row.status, hardwareId: row.hardware_id || null, keyFingerprint: row.key_fingerprint || null,
      certificate: { state: certificate, serial: row.cert_serial || null, notAfter, pem: row.status === "active" ? row.cert_pem : null },
      reason: row.reason || null, firstSeenAt: row.first_seen_at ? Number(row.first_seen_at) : null, lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
      enrolledAt: row.enrolled_at ? Number(row.enrolled_at) : null, enrollmentExpiresAt: row.challenge_hash && row.challenge_expires_at ? Number(row.challenge_expires_at) : null, createdAt: Number(row.created_at),
    };
  }
  const identityRow = async (db, userId, deviceId) => (await db.query("SELECT * FROM hannah_device_identities WHERE user_id = $1 AND device_id = $2", [userId, String(deviceId || "")])).rows[0] || null;
  async function listIdentities(db, userId) {
    const { rows } = await db.query("SELECT * FROM hannah_device_identities WHERE user_id = $1 ORDER BY created_at", [userId]);
    return rows.map((row) => view(row));
  }
  async function getIdentity(db, userId, deviceId) {
    const row = await identityRow(db, userId, deviceId);
    if (!row) throw fail(404, "No device with that id is registered in your account.", "not-found");
    return view(row);
  }

  /** A signed-in person registers a device they expect. Returns its one-time enrollment code. */
  async function registerDevice(db, userId, { deviceId, kind = "other", hardwareId = null } = {}) {
    const id = clean(deviceId, 80);
    if (!ID.test(id)) throw fail(400, "A device id is 3 to 80 letters, digits or _ . : -", "bad-request");
    if (!KINDS.has(kind)) throw fail(400, `kind must be one of: ${[...KINDS].join(", ")}.`, "bad-request");
    const taken = (await db.query("SELECT user_id, status FROM hannah_device_identities WHERE device_id = $1", [id])).rows;
    if (taken.some((row) => row.user_id !== userId && row.status !== "quarantined")) throw fail(409, "That device id is registered to another account.", "taken");
    const mine = taken.find((row) => row.user_id === userId);
    if (mine && !["quarantined", "revoked"].includes(mine.status)) throw fail(409, "That device is already registered. Revoke it first to enroll it again.", "exists");
    const code = newCode();
    const at = now();
    const hardware = hardwareId ? clean(hardwareId, 120) : null;
    if (mine) {
      await db.query("UPDATE hannah_device_identities SET status = 'pending', kind = $1, hardware_id = COALESCE($2, hardware_id), challenge_hash = $3, challenge_expires_at = $4, reason = NULL, public_key = NULL, key_fingerprint = NULL, cert_serial = NULL, cert_pem = NULL, cert_not_after = NULL, updated_at = $5 WHERE user_id = $6 AND device_id = $7",
        [kind, hardware, codeHash(code), at + CODE_TTL_MS, at, userId, id]);
    } else {
      await db.query("INSERT INTO hannah_device_identities (user_id, device_id, kind, status, hardware_id, challenge_hash, challenge_expires_at, created_at, updated_at) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $7)", [userId, id, kind, hardware, codeHash(code), at + CODE_TTL_MS, at]);
    }
    await audit(db, { userId, deviceId: id, kind: "registered", decision: "allowed", reason: mine ? `Re-registered from ${mine.status} by a signed-in person.` : "Registered by a signed-in person." });
    return { identity: await getIdentity(db, userId, id), enrollment: { code, expiresAt: at + CODE_TTL_MS } };
  }

  /**
   * A device presents its code, its public key and a signature with that key.
   * Not an account request: the code is the proof that a person registered it.
   */
  async function enroll(db, { deviceId, code, publicKey, hardwareId = null, signature }) {
    const id = clean(deviceId, 80);
    const row = (await db.query("SELECT * FROM hannah_device_identities WHERE device_id = $1 AND challenge_hash = $2", [id, codeHash(code)])).rows[0];
    const at = now();
    if (!row || row.status !== "pending" || !row.challenge_expires_at || Number(row.challenge_expires_at) <= at) {
      const owner = (await db.query("SELECT user_id FROM hannah_device_identities WHERE device_id = $1", [id])).rows[0]?.user_id || null;
      await audit(db, { userId: owner, deviceId: id, kind: "enroll", decision: "refused", reason: "Enrollment code unknown, used or expired." });
      throw fail(403, "That enrollment code isn't valid for this device or has expired.", "bad-code");
    }
    const key = readPublicKey(publicKey);
    if (!verifySignature(key, enrollMessage({ deviceId: id, code, publicKey }), signature)) {
      await audit(db, { userId: row.user_id, deviceId: id, kind: "enroll", decision: "refused", reason: "The signature doesn't prove possession of the presented key." });
      throw fail(401, "The enrollment signature doesn't match the key.", "bad-signature");
    }
    if (row.hardware_id && clean(hardwareId, 120) !== row.hardware_id) {
      await audit(db, { userId: row.user_id, deviceId: id, kind: "enroll", decision: "refused", reason: "The hardware id doesn't match the one registered.", detail: { presented: clean(hardwareId, 120) || null } });
      throw fail(403, "This hardware isn't the device that was registered.", "hardware-mismatch");
    }
    const policy = await getPolicy(db, row.user_id);
    const keyPem = x509.publicPem(key);
    const certificate = await issueCertificate(db, row.user_id, { deviceId: id, publicKey: key, hardwareId: row.hardware_id || clean(hardwareId, 120) || null, days: policy.certificateDays });
    const won = await db.query(
      "UPDATE hannah_device_identities SET status = 'active', public_key = $1, key_fingerprint = $2, cert_serial = $3, cert_pem = $4, cert_not_after = $5, challenge_hash = NULL, challenge_expires_at = NULL, enrolled_at = $6, last_seen_at = $6, hardware_id = COALESCE(hardware_id, $7), updated_at = $6 WHERE user_id = $8 AND device_id = $9 AND challenge_hash = $10",
      [keyPem, sha256(x509.spkiOf(key)).slice(0, 32), certificate.serialHex, certificate.pem, new Date(certificate.certificate.validTo).getTime(), at, clean(hardwareId, 120) || null, row.user_id, id, row.challenge_hash],
    );
    if (!Number(won.rowCount)) throw fail(403, "That enrollment code was just used.", "bad-code");
    await audit(db, { userId: row.user_id, deviceId: id, kind: "enroll", decision: "allowed", reason: `Certificate ${certificate.serialHex} issued until ${certificate.certificate.validTo}.` });
    const ca = await ensureCA(db, row.user_id);
    return { deviceId: id, certificate: certificate.pem, serial: certificate.serialHex, notAfter: new Date(certificate.certificate.validTo).getTime(), caCertificate: ca.certPem, serverTime: at };
  }

  /** Is this device allowed to act now? Throws with the reason, and audits it, when not. */
  async function activeIdentity(db, deviceId, { action }) {
    // A device id is registered to one account; another account may only hold a quarantine record of it.
    const row = (await db.query("SELECT * FROM hannah_device_identities WHERE device_id = $1 ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'revoked' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END", [clean(deviceId, 80)])).rows[0];
    const at = now();
    const refuse = async (status, message, reason) => {
      await audit(db, { userId: row?.user_id || null, deviceId: clean(deviceId, 80), kind: action, decision: "refused", reason: message });
      throw fail(status, message, reason);
    };
    if (!row) return refuse(401, "This device isn't registered.", "unknown-device");
    if (row.status === "quarantined") return refuse(403, "This device is quarantined until a person decides about it.", "quarantined");
    if (row.status === "revoked") return refuse(401, "This device's identity was revoked.", "revoked");
    if (row.status !== "active") return refuse(401, "This device hasn't enrolled.", "not-enrolled");
    if (!row.cert_not_after || Number(row.cert_not_after) <= at) return refuse(401, "This device's certificate has expired. It has to be enrolled again.", "certificate-expired");
    if (await isRevoked(db, row.user_id, row.cert_serial)) return refuse(401, "This device's certificate was revoked.", "revoked");
    return row;
  }

  /** A device signs a fresh nonce with its key and gets a credential that expires in minutes. */
  async function issueCredential(db, { deviceId, time, nonce, scope = "device", signature, hardwareId = null }) {
    const row = await activeIdentity(db, deviceId, { action: "credential" });
    const stamp = Number(time);
    const at = now();
    const refuse = async (status, message, reason) => { await audit(db, { userId: row.user_id, deviceId: row.device_id, kind: "credential", decision: "refused", reason: message }); throw fail(status, message, reason); };
    if (!/^[a-z0-9:_-]{1,40}$/.test(String(scope))) return refuse(400, "Bad credential scope.", "bad-request");
    if (!verifySignature(crypto.createPublicKey(row.public_key), credentialMessage({ deviceId: row.device_id, time: String(time), nonce, scope }), signature)) return refuse(401, "The request isn't signed by this device's key.", "bad-signature");
    if (!Number.isFinite(stamp) || Math.abs(at - stamp) > SKEW_MS) return refuse(401, "The device's clock is more than a minute off.", "clock-skew");
    if (row.hardware_id && hardwareId !== null && clean(hardwareId, 120) !== row.hardware_id) return refuse(403, "The hardware id doesn't match the one registered.", "hardware-mismatch");
    if (!(await claimNonce(db, `credential:${row.device_id}`, nonce, at + 2 * SKEW_MS))) return refuse(409, "That request was already used.", "replayed");
    const policy = await getPolicy(db, row.user_id);
    const token = `hdc_${crypto.randomBytes(32).toString("base64url")}`;
    const id = `cred_${crypto.randomBytes(9).toString("hex")}`;
    const expiresAt = Math.min(at + policy.credentialMinutes * 60_000, Number(row.cert_not_after));
    await db.query("INSERT INTO hannah_device_credentials (id, user_id, device_id, token_hash, scope, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, row.user_id, row.device_id, tokenHash(token), scope, at, expiresAt]);
    await db.query("UPDATE hannah_device_identities SET last_seen_at = $1 WHERE user_id = $2 AND device_id = $3", [at, row.user_id, row.device_id]);
    return { credentialId: id, token, scope, expiresAt };
  }

  /**
   * Check a credential. `deviceId`, when given, must be the device it was
   * issued to: one device's credential never acts for another.
   */
  async function authenticate(db, token, { deviceId = null, scope = null } = {}) {
    const row = (await db.query("SELECT * FROM hannah_device_credentials WHERE token_hash = $1", [tokenHash(String(token || ""))])).rows[0];
    const at = now();
    const refuse = async (status, message, reason, owner = row?.user_id || null) => { await audit(db, { userId: owner, deviceId: row?.device_id || deviceId, kind: "credential-use", decision: "refused", reason: message, detail: deviceId && row && row.device_id !== deviceId ? { claimedDevice: deviceId } : null }); throw fail(status, message, reason); };
    if (!row) return refuse(401, "Unknown credential.", "bad-credential");
    if (row.revoked_at) return refuse(401, "This credential was revoked.", "revoked");
    if (Number(row.expires_at) <= at) return refuse(401, "This credential has expired. Ask for a new one.", "expired");
    if (deviceId && row.device_id !== deviceId) return refuse(403, "This credential belongs to another device.", "cross-device");
    if (scope && row.scope !== scope) return refuse(403, `This credential is for “${row.scope}”, not “${scope}”.`, "wrong-scope");
    const identity = await activeIdentity(db, row.device_id, { action: "credential-use" });
    return { userId: row.user_id, deviceId: row.device_id, kind: identity.kind, scope: row.scope, expiresAt: Number(row.expires_at) };
  }

  /** A new key for an enrolled device, signed for by its current key and proven by the new one. */
  async function rotate(db, { deviceId, time, nonce, publicKey, signature, newKeySignature }) {
    const row = await activeIdentity(db, deviceId, { action: "rotate" });
    const at = now();
    const refuse = async (status, message, reason) => { await audit(db, { userId: row.user_id, deviceId: row.device_id, kind: "rotate", decision: "refused", reason: message }); throw fail(status, message, reason); };
    const next = readPublicKey(publicKey);
    const message = rotateMessage({ deviceId: row.device_id, time: String(time), nonce, publicKey });
    if (!verifySignature(crypto.createPublicKey(row.public_key), message, signature)) return refuse(401, "The rotation isn't signed by the device's current key.", "bad-signature");
    if (!verifySignature(next, message, newKeySignature)) return refuse(401, "The rotation doesn't prove possession of the new key.", "bad-signature");
    if (!Number.isFinite(Number(time)) || Math.abs(at - Number(time)) > SKEW_MS) return refuse(401, "The device's clock is more than a minute off.", "clock-skew");
    if (!(await claimNonce(db, `rotate:${row.device_id}`, nonce, at + 2 * SKEW_MS))) return refuse(409, "That request was already used.", "replayed");
    const policy = await getPolicy(db, row.user_id);
    const certificate = await issueCertificate(db, row.user_id, { deviceId: row.device_id, publicKey: next, hardwareId: row.hardware_id, days: policy.certificateDays });
    await db.query("INSERT INTO hannah_cert_revocations (user_id, serial, device_id, reason, revoked_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, serial) DO NOTHING", [row.user_id, row.cert_serial, row.device_id, "superseded", at]);
    await db.query("UPDATE hannah_device_credentials SET revoked_at = $1 WHERE user_id = $2 AND device_id = $3 AND revoked_at IS NULL", [at, row.user_id, row.device_id]);
    await db.query("UPDATE hannah_device_identities SET public_key = $1, key_fingerprint = $2, cert_serial = $3, cert_pem = $4, cert_not_after = $5, last_seen_at = $6, updated_at = $6 WHERE user_id = $7 AND device_id = $8",
      [x509.publicPem(next), sha256(x509.spkiOf(next)).slice(0, 32), certificate.serialHex, certificate.pem, new Date(certificate.certificate.validTo).getTime(), at, row.user_id, row.device_id]);
    await audit(db, { userId: row.user_id, deviceId: row.device_id, kind: "rotate", decision: "allowed", reason: `Key rotated; certificate ${row.cert_serial} superseded by ${certificate.serialHex}.` });
    return { deviceId: row.device_id, certificate: certificate.pem, serial: certificate.serialHex, notAfter: new Date(certificate.certificate.validTo).getTime() };
  }

  /** A signed-in person ends a device's identity now: certificate and every credential. */
  async function revoke(db, userId, deviceId, reason = "Revoked by a signed-in person.") {
    const row = await identityRow(db, userId, deviceId);
    if (!row) throw fail(404, "No device with that id is registered in your account.", "not-found");
    const at = now();
    if (row.cert_serial) await db.query("INSERT INTO hannah_cert_revocations (user_id, serial, device_id, reason, revoked_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, serial) DO NOTHING", [userId, row.cert_serial, row.device_id, clean(reason, 200), at]);
    await db.query("UPDATE hannah_device_credentials SET revoked_at = $1 WHERE user_id = $2 AND device_id = $3 AND revoked_at IS NULL", [at, userId, row.device_id]);
    await db.query("UPDATE hannah_device_identities SET status = 'revoked', reason = $1, challenge_hash = NULL, challenge_expires_at = NULL, updated_at = $2 WHERE user_id = $3 AND device_id = $4", [clean(reason, 200), at, userId, row.device_id]);
    await audit(db, { userId, deviceId: row.device_id, kind: "revoke", decision: "changed", reason: clean(reason, 200) });
    return getIdentity(db, userId, row.device_id);
  }

  async function isRevoked(db, userId, serial) {
    if (!serial) return false;
    return Boolean((await db.query("SELECT serial FROM hannah_cert_revocations WHERE user_id = $1 AND serial = $2", [userId, String(serial).toUpperCase()])).rows[0]);
  }
  async function revocations(db, userId) {
    const { rows } = await db.query("SELECT serial, device_id, reason, revoked_at FROM hannah_cert_revocations WHERE user_id = $1 ORDER BY revoked_at DESC", [userId]);
    return rows.map((row) => ({ serial: row.serial, deviceId: row.device_id, reason: row.reason, revokedAt: Number(row.revoked_at) }));
  }

  /**
   * A device nobody registered showed up (a robot, an AGV on the account's
   * broker, a hub's discovery). By policy it is quarantined (recorded, given
   * nothing, shown to a person) or rejected (only audited). A known device is
   * never downgraded by this.
   */
  async function observeUnregistered(db, userId, { deviceId, kind = "other", hardwareId = null, source, detail = null }) {
    const id = clean(deviceId, 80);
    const policy = userId ? await getPolicy(db, userId) : { unknownDevices: "reject" };
    const existing = userId ? await identityRow(db, userId, id) : null;
    const at = now();
    if (existing && existing.status !== "quarantined") return { decision: "known", identity: view(existing) };
    if (policy.unknownDevices === "reject" || !ID.test(id)) {
      await audit(db, { userId, deviceId: id, kind: "unregistered-device", decision: "rejected", reason: `Unregistered device seen via ${clean(source, 60)}; rejected by policy.`, detail });
      return { decision: "rejected" };
    }
    if (existing) await db.query("UPDATE hannah_device_identities SET last_seen_at = $1, updated_at = $1 WHERE user_id = $2 AND device_id = $3", [at, userId, id]);
    else {
      await db.query("INSERT INTO hannah_device_identities (user_id, device_id, kind, status, hardware_id, reason, first_seen_at, last_seen_at, created_at, updated_at) VALUES ($1, $2, $3, 'quarantined', $4, $5, $6, $6, $6, $6) ON CONFLICT (user_id, device_id) DO NOTHING",
        [userId, id, KINDS.has(kind) ? kind : "other", hardwareId ? clean(hardwareId, 120) : null, `Seen via ${clean(source, 60)} without being registered.`, at]);
      await audit(db, { userId, deviceId: id, kind: "unregistered-device", decision: "quarantined", reason: `Unregistered device seen via ${clean(source, 60)}; quarantined by policy.`, detail });
    }
    return { decision: "quarantined", identity: view(await identityRow(db, userId, id)) };
  }
  /** A person throws away a quarantined record (it can show up again). */
  async function dismissQuarantined(db, userId, deviceId) {
    const removed = await db.query("DELETE FROM hannah_device_identities WHERE user_id = $1 AND device_id = $2 AND status = 'quarantined'", [userId, String(deviceId)]);
    if (!Number(removed.rowCount)) throw fail(404, "No quarantined device with that id.", "not-found");
    await audit(db, { userId, deviceId, kind: "quarantine-dismissed", decision: "changed", reason: "Dismissed by a signed-in person." });
    return { dismissed: true };
  }

  /**
   * Check a TLS client certificate: issued by this account's CA, in date, the
   * device's current certificate, not revoked, and the device active. Returns
   * { userId, deviceId } or throws. The TLS handshake already proved the
   * client holds the certificate's private key.
   */
  async function verifyClientCertificate(db, presented) {
    let certificate;
    try { certificate = presented instanceof crypto.X509Certificate ? presented : new crypto.X509Certificate(presented); } catch { throw fail(401, "No readable client certificate.", "no-certificate"); }
    const uri = x509.sanUris(certificate).find((item) => item.startsWith(DEVICE_URN));
    if (!uri) throw fail(401, "The client certificate names no HANNAH device.", "no-device");
    const deviceId = uri.slice(DEVICE_URN.length);
    const row = await activeIdentity(db, deviceId, { action: "mtls" });
    const ca = (await db.query("SELECT cert_pem FROM hannah_account_ca WHERE user_id = $1 AND purpose = 'devices'", [row.user_id])).rows[0];
    const refuse = async (message, reason) => { await audit(db, { userId: row.user_id, deviceId, kind: "mtls", decision: "refused", reason: message }); throw fail(401, message, reason); };
    if (!ca) return refuse("The account has no device CA.", "no-ca");
    const authority = new crypto.X509Certificate(ca.cert_pem);
    if (!certificate.checkIssued(authority) || !certificate.verify(authority.publicKey)) return refuse("The client certificate wasn't issued by this account's CA.", "wrong-issuer");
    const at = now();
    if (new Date(certificate.validFrom).getTime() > at + SKEW_MS || new Date(certificate.validTo).getTime() <= at) return refuse("The client certificate isn't valid now.", "certificate-expired");
    if (certificate.serialNumber.toUpperCase() !== String(row.cert_serial).toUpperCase() || (await isRevoked(db, row.user_id, certificate.serialNumber.toUpperCase()))) return refuse("The client certificate was replaced or revoked.", "revoked");
    return { userId: row.user_id, deviceId, kind: row.kind, serial: row.cert_serial };
  }

  async function caCertificate(db, userId) {
    return (await ensureCA(db, userId)).certPem;
  }

  return { DEFAULT_POLICY, activeIdentity, audit, authenticate, caCertificate, claimNonce, dismissQuarantined, enroll, ensureCA, getIdentity, getPolicy, isRevoked, issueCredential, listAudit, listIdentities, observeUnregistered, registerDevice, revocations, revoke, rotate, setPolicy, verifyClientCertificate };
}

/** The issuer fields of a parsed certificate, to name it as the issuer of another. */
function subjectOf(certificate) {
  const fields = {};
  for (const line of String(certificate.subject).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

module.exports = { DEFAULT_POLICY, DEVICE_URN, createTrustService, credentialMessage, enrollMessage, rotateMessage, subjectOf };
