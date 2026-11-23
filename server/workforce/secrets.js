"use strict";

/**
 * The Secure Vault for workforce credentials.
 *
 * Values are sealed with the existing envelope encryption in ../vault.js, bound
 * to the owning user and the secret id. The API never returns a value, and the
 * model never receives one: a bot references `secret:<id>` and the browser or a
 * connector injects it server-side. Every use writes an audit event without the
 * value. Revoking is immediate and leaves the audit trail in place.
 */
const express = require("express");
const { encryptSecret, decryptSecret, secretHint, vaultConfigured } = require("../vault");
const { asArray, clean, fail, id, parse, readBody, recordEvent, requireId, withAccount } = require("./common");

const KINDS = new Set(["password", "token", "oauth", "pin", "other"]);
const SECRET_REF = /^(?:secret:)?([A-Za-z0-9_-]{6,80})$/;

function publicSecret(row) {
  return {
    id: row.id,
    name: row.name,
    application: row.application || "",
    kind: row.kind,
    hint: row.hint || "",
    scopes: parse(row.scopes, []),
    botIds: parse(row.bot_ids, []),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
    revoked: Boolean(row.revoked_at),
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
  };
}

function requireVault() {
  if (!vaultConfigured()) throw fail(503, "The Secure Vault needs a master key. Set HANNAH_VAULT_KEY on the server (openssl rand -hex 32).", "vault-unconfigured");
}

/** Resolve a secret for server-side injection. The value is returned only to the caller that injects it. */
async function resolveSecret(db, userId, ref, { botId = null, host = null } = {}) {
  const match = SECRET_REF.exec(String(ref || ""));
  if (!match) throw fail(400, "That isn't a vault reference.", "invalid-reference");
  requireVault();
  const { rows } = await db.query("SELECT * FROM hannah_workforce_secrets WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL", [userId, match[1]]);
  const row = rows[0];
  if (!row) throw fail(404, "That vault entry doesn't exist or was revoked.", "not-found");
  const botIds = parse(row.bot_ids, []);
  if (botIds.length && (!botId || !botIds.includes(botId))) throw fail(403, "This credential isn't assigned to that teammate.", "not-assigned");
  const scopes = parse(row.scopes, []);
  const domains = scopes.filter((item) => /^[a-z0-9*.-]+\.[a-z]{2,}$/i.test(item) || item.startsWith("*."));
  if (domains.length) {
    const allowed = host && domains.some((domain) => (domain.startsWith("*.") ? host.endsWith(domain.slice(1)) || host === domain.slice(2) : host === domain));
    if (!allowed) throw fail(403, `This credential is limited to ${domains.join(", ")}.`, "outside-scope");
  }
  const { secret } = decryptSecret(row, { userId, providerId: `workforce:${row.id}` });
  await db.query("UPDATE hannah_workforce_secrets SET last_used_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), userId, row.id]);
  return secret;
}

function createSecretsRouter() {
  const router = express.Router();

  router.get("/workforce/vault/status", withAccount(async (_req, res) => {
    res.json({ configured: vaultConfigured(), note: "Secret values are never returned by this API. Teammates receive a reference and the server injects the value." });
  }));

  router.get("/workforce/secrets", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_workforce_secrets WHERE user_id = $1 AND revoked_at IS NULL ORDER BY updated_at DESC", [account.id]);
    res.json({ secrets: rows.map(publicSecret) });
  }));

  router.post("/workforce/secrets", withAccount(async (req, res, db, account) => {
    requireVault();
    const body = readBody(req);
    const name = clean(body.name, 100);
    const value = typeof body.value === "string" ? body.value : "";
    const kind = String(body.kind || "password");
    if (!name) throw fail(400, "Give the credential a name.", "invalid");
    if (!value || value.length > 20_000) throw fail(400, "Enter the credential value (up to 20,000 characters).", "invalid");
    if (!KINDS.has(kind)) throw fail(400, `kind must be one of ${[...KINDS].join(", ")}.`, "invalid");
    const secretId = id("sec");
    const sealed = encryptSecret(value, { userId: account.id, providerId: `workforce:${secretId}` });
    const at = Date.now();
    await db.query(
      `INSERT INTO hannah_workforce_secrets (user_id, id, name, application, kind, key_id, wrapped_key, ciphertext, hint, scopes, bot_ids, created_at, updated_at, last_used_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, NULL, NULL)`,
      [account.id, secretId, name, clean(body.application, 100), kind, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, secretHint(value), JSON.stringify(asArray(body.scopes, 20)), JSON.stringify(asArray(body.botIds, 20)), at],
    );
    await recordEvent(db, account.id, "secret.created", { detail: { secretId, application: clean(body.application, 100), kind } });
    res.status(201).json({ secret: publicSecret((await db.query("SELECT * FROM hannah_workforce_secrets WHERE user_id = $1 AND id = $2", [account.id, secretId])).rows[0]) });
  }));

  router.put("/workforce/secrets/:id", withAccount(async (req, res, db, account) => {
    requireVault();
    const secretId = requireId(req.params.id, "credential");
    const current = (await db.query("SELECT * FROM hannah_workforce_secrets WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL", [account.id, secretId])).rows[0];
    if (!current) throw fail(404, "That credential doesn't exist.", "not-found");
    const body = readBody(req);
    const at = Date.now();
    if (typeof body.value === "string" && body.value) {
      const sealed = encryptSecret(body.value, { userId: account.id, providerId: `workforce:${secretId}` });
      await db.query("UPDATE hannah_workforce_secrets SET key_id = $1, wrapped_key = $2, ciphertext = $3, hint = $4, updated_at = $5 WHERE user_id = $6 AND id = $7", [sealed.keyId, sealed.wrappedKey, sealed.ciphertext, secretHint(body.value), at, account.id, secretId]);
    }
    await db.query(
      "UPDATE hannah_workforce_secrets SET name = $1, application = $2, kind = $3, scopes = $4, bot_ids = $5, updated_at = $6 WHERE user_id = $7 AND id = $8",
      [clean(body.name, 100) || current.name, clean(body.application, 100), KINDS.has(String(body.kind)) ? String(body.kind) : current.kind, JSON.stringify(asArray(body.scopes, 20)), JSON.stringify(asArray(body.botIds, 20)), at, account.id, secretId],
    );
    await recordEvent(db, account.id, "secret.updated", { detail: { secretId } });
    res.json({ secret: publicSecret((await db.query("SELECT * FROM hannah_workforce_secrets WHERE user_id = $1 AND id = $2", [account.id, secretId])).rows[0]) });
  }));

  router.delete("/workforce/secrets/:id", withAccount(async (req, res, db, account) => {
    const secretId = requireId(req.params.id, "credential");
    const result = await db.query("UPDATE hannah_workforce_secrets SET revoked_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3 AND revoked_at IS NULL", [Date.now(), account.id, secretId]);
    if (!result.rowCount) throw fail(404, "That credential doesn't exist.", "not-found");
    await recordEvent(db, account.id, "secret.revoked", { detail: { secretId } });
    res.json({ ok: true, revoked: true });
  }));

  /**
   * Record that a tool used a credential, without revealing it. Injection itself
   * happens inside the browser driver or a connector; this route exists so an
   * integration can add its own audit entry.
   */
  router.post("/workforce/secrets/:id/use", withAccount(async (req, res, db, account) => {
    const secretId = requireId(req.params.id, "credential");
    const row = (await db.query("SELECT * FROM hannah_workforce_secrets WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL", [account.id, secretId])).rows[0];
    if (!row) throw fail(404, "That credential doesn't exist.", "not-found");
    await db.query("UPDATE hannah_workforce_secrets SET last_used_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, secretId]);
    await recordEvent(db, account.id, "secret.used", { detail: { secretId, purpose: clean(readBody(req).purpose, 200), target: clean(readBody(req).target, 300) } });
    res.json({ auditRecorded: true, hint: row.hint, injectedServerSide: true, note: "No secret value is returned. Use secret:<id> where a tool asks for a credential." });
  }));

  return router;
}

module.exports = { KINDS, createSecretsRouter, publicSecret, resolveSecret };
