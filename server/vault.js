"use strict";

/**
 * Envelope encryption for provider API keys stored in the database.
 *
 * Each secret gets its own random 256-bit data key (AES-256-GCM). The data key
 * is wrapped with the master key from HANNAH_VAULT_KEY (AES-256-GCM), so the
 * database alone never reveals a secret. The owning user and provider are
 * bound in as additional authenticated data, so a ciphertext copied to another
 * row fails to decrypt.
 *
 * Rotation: set the new key in HANNAH_VAULT_KEY and list previous keys in
 * HANNAH_VAULT_PREVIOUS_KEYS (comma-separated). Rows wrapped with an old key
 * still decrypt and are re-wrapped with the new key the next time they're read.
 *
 * Without HANNAH_VAULT_KEY, the master key is derived (HKDF-SHA256) from a
 * server secret that Vercel's Supabase integration adds to the project
 * (SUPABASE_JWT_SECRET, else SUPABASE_SECRET_KEY, else the legacy
 * SUPABASE_SERVICE_ROLE_KEY), so connecting Supabase there turns on key storage
 * with nothing to set. That secret is never stored in the database, so a copy
 * of the database alone still reveals nothing. Every key derived from a secret
 * that's present can decrypt, so setting HANNAH_VAULT_KEY later re-wraps rows
 * as they're read. Rotating the Supabase secret it was derived from makes rows
 * sealed with it unreadable (people re-enter those keys); set HANNAH_VAULT_KEY
 * for a key that never changes.
 */

const { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } = require("node:crypto");

/** Server secrets the master key can be derived from, most stable first. */
const DERIVED_FROM = ["SUPABASE_JWT_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

function keyFromBytes(bytes) {
  return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 12), bytes };
}

/** Keys derived from the server secrets present, in DERIVED_FROM order (one per distinct secret). */
function derivedKeys() {
  const seen = new Set();
  const keys = [];
  for (const name of DERIVED_FROM) {
    const secret = String(process.env[name] || "").trim();
    // Only real secrets: a short value isn't one.
    if (secret.length < 32 || seen.has(secret)) continue;
    seen.add(secret);
    keys.push({ ...keyFromBytes(Buffer.from(hkdfSync("sha256", secret, "hannah-vault", "HANNAH vault master key v1", 32))), source: name });
  }
  return keys;
}

function parseKey(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  let bytes = null;
  if (/^[0-9a-f]{64}$/i.test(value)) bytes = Buffer.from(value, "hex");
  else {
    try {
      const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (decoded.length === 32) bytes = decoded;
    } catch {
      bytes = null;
    }
  }
  if (!bytes || bytes.length !== 32) {
    throw new Error("HANNAH_VAULT_KEY must be 32 bytes as 64 hex characters or base64 (generate one with: openssl rand -hex 32).");
  }
  return keyFromBytes(bytes);
}

function loadKeys() {
  const explicit = parseKey(process.env.HANNAH_VAULT_KEY);
  const previous = String(process.env.HANNAH_VAULT_PREVIOUS_KEYS || "").split(",").map((item) => item.trim()).filter(Boolean).map(parseKey);
  const derived = derivedKeys();
  const primary = explicit ? { ...explicit, source: "HANNAH_VAULT_KEY" } : derived[0] || null;
  return { primary, byId: new Map([primary, ...previous, ...derived].filter(Boolean).map((key) => [key.id, key])) };
}

/** Which variable the vault's key comes from (a name, never a value), or null when key storage is off. */
function vaultSource() {
  try {
    return loadKeys().primary?.source || null;
  } catch {
    return null;
  }
}

function vaultConfigured() {
  try {
    return Boolean(loadKeys().primary);
  } catch {
    return false;
  }
}

function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

function open(key, sealed, aad) {
  const [version, iv, tag, body] = String(sealed).split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized vault record.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
}

/** Encrypt a secret for (userId, providerId). Returns the columns to store. */
function encryptSecret(secret, { userId, providerId }) {
  const { primary } = loadKeys();
  if (!primary) throw Object.assign(new Error("Key storage is off: set HANNAH_VAULT_KEY on the server."), { code: "vault_unconfigured" });
  const dataKey = randomBytes(32);
  const aad = `hannah:${userId}:${providerId}`;
  const ciphertext = seal(dataKey, Buffer.from(String(secret), "utf8"), aad);
  const wrappedKey = seal(primary.bytes, dataKey, `hannah-dek:${primary.id}:${aad}`);
  dataKey.fill(0);
  return { keyId: primary.id, wrappedKey, ciphertext };
}

/** Decrypt a stored secret. `rewrap` is set when it was sealed with an older master key. */
function decryptSecret(row, { userId, providerId }) {
  const { primary, byId } = loadKeys();
  const master = byId.get(row.key_id ?? row.keyId);
  if (!master) throw Object.assign(new Error("This key was encrypted with a vault key the server no longer has."), { code: "vault_key_missing" });
  const aad = `hannah:${userId}:${providerId}`;
  const dataKey = open(master.bytes, row.wrapped_key ?? row.wrappedKey, `hannah-dek:${master.id}:${aad}`);
  const secret = open(dataKey, row.ciphertext, aad).toString("utf8");
  dataKey.fill(0);
  return { secret, rewrap: Boolean(primary && master.id !== primary.id) };
}

/** A safe display hint such as "gsk_…9f2a". */
function secretHint(secret) {
  const value = String(secret);
  const prefix = /^[a-z]{2,8}[-_]/i.exec(value)?.[0] || "";
  return `${prefix}…${value.slice(-4)}`;
}

module.exports = { decryptSecret, encryptSecret, secretHint, vaultConfigured, vaultSource };
