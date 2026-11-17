"use strict";

/**
 * Accounts on the operator's own database (see db/index.js).
 *
 * - Email + password sign-in (scrypt), sessions as random tokens stored only as
 *   SHA-256 hashes. Web clients get an HttpOnly SameSite=Lax cookie; native
 *   clients ask for a bearer token instead.
 * - Provider API keys in an envelope-encrypted vault (vault.js), used for that
 *   user's requests and only sent to the provider's own HTTPS API.
 * - Developer API keys (hk_…) for /v1 and the API, shown once, stored hashed.
 * - Per-namespace sync documents with optimistic versioning.
 * - An audit log of security-relevant events, export and deletion.
 */

const express = require("express");
const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const { databaseConfigured, describeDatabaseError, getDatabase, parseDatabaseUrl, testDatabaseUrl } = require("./db");
const { decryptSecret, encryptSecret, secretHint, vaultConfigured } = require("./vault");
const { getProvider } = require("./providers/catalog");

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = "hannah_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const SYNC_NAMESPACES = new Set(["memories", "reminders", "communitySkills", "chatHistory", "settings", "automations", "automationSchedules"]);
const MAX_SYNC_BYTES = 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

function signupAllowed() {
  return String(process.env.HANNAH_ALLOW_SIGNUP ?? "true").trim().toLowerCase() !== "false";
}

function accountsUseServerKeys() {
  return String(process.env.HANNAH_ACCOUNTS_USE_SERVER_KEYS || "").trim().toLowerCase() === "true";
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

// Used when no account matches, so a wrong email costs as much time as a wrong password.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);

async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, expected] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const expectedBytes = Buffer.from(expected, "base64url");
  const actual = await scryptAsync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expectedBytes.length || SCRYPT.keylen, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return expectedBytes.length === actual.length && timingSafeEqual(expectedBytes, actual);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookies.
    }
  }
  return cookies;
}

function secureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production";
}

function sessionCookie(req, token, maxAgeMs) {
  return [
    `${SESSION_COOKIE}=${token ? encodeURIComponent(token) : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secureRequest(req) ? ["Secure"] : []),
  ].join("; ");
}

function credentialFromRequest(req) {
  const authorization = req.get("authorization") || "";
  const match = /^Bearer\s+((?:hs|hk)_[A-Za-z0-9_-]{20,200})$/i.exec(authorization);
  if (match) return match[1];
  // An operator token in the header wins over a browser session cookie.
  if (authorization) return null;
  const cookie = parseCookies(req.get("cookie"))[SESSION_COOKIE];
  return cookie && /^hs_[A-Za-z0-9_-]{20,200}$/.test(cookie) ? cookie : null;
}

async function audit(db, userId, event, detail = null) {
  try {
    await db.query("INSERT INTO hannah_audit (id, user_id, event, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), userId, event, detail ? JSON.stringify(detail).slice(0, 2000) : null, Date.now()]);
  } catch (error) {
    console.error(`Audit write failed (${error?.code || error?.name || "error"}).`);
  }
}

/** Decrypt every stored provider key for a user. Re-wraps keys sealed with a retired master key. */
async function loadAccountKeys(db, userId) {
  const keys = new Map();
  if (!vaultConfigured()) return keys;
  const { rows } = await db.query("SELECT provider_id, key_id, wrapped_key, ciphertext FROM hannah_credentials WHERE user_id = $1", [userId]);
  for (const row of rows) {
    try {
      const { secret, rewrap } = decryptSecret(row, { userId, providerId: row.provider_id });
      keys.set(row.provider_id, secret);
      if (rewrap) {
        const sealed = encryptSecret(secret, { userId, providerId: row.provider_id });
        await db.query("UPDATE hannah_credentials SET key_id = $1, wrapped_key = $2, ciphertext = $3, updated_at = $4 WHERE user_id = $5 AND provider_id = $6", [sealed.keyId, sealed.wrappedKey, sealed.ciphertext, Date.now(), userId, row.provider_id]);
      }
    } catch (error) {
      console.error(`A stored ${row.provider_id} key couldn't be decrypted (${error?.code || "vault error"}).`);
    }
  }
  return keys;
}

/**
 * Recognize a signed-in user from a session cookie, a session bearer token
 * (hs_…) or a developer API key (hk_…). Runs before requireApiToken.
 */
function accountAuth() {
  return async function accountAuthMiddleware(req, res, next) {
    const token = credentialFromRequest(req);
    if (!token) return next();
    if (!databaseConfigured()) {
      res.locals.hannahAccountInvalid = "Accounts aren't enabled on this server.";
      return next();
    }
    try {
      const db = await getDatabase();
      const now = Date.now();
      let user;
      let via;
      if (token.startsWith("hk_")) {
        const { rows } = await db.query("SELECT k.id AS key_id, u.id, u.email, u.display_name FROM hannah_api_keys k JOIN hannah_users u ON u.id = k.user_id WHERE k.id = $1 AND k.revoked_at IS NULL", [sha256(token)]);
        user = rows[0];
        via = "api-key";
        if (user) await db.query("UPDATE hannah_api_keys SET last_used_at = $1 WHERE id = $2", [now, user.key_id]);
      } else {
        const sessionId = sha256(token);
        const { rows } = await db.query("SELECT s.id AS session_id, s.last_seen_at, s.expires_at, u.id, u.email, u.display_name FROM hannah_sessions s JOIN hannah_users u ON u.id = s.user_id WHERE s.id = $1", [sessionId]);
        user = rows[0] && Number(rows[0].expires_at) > now ? rows[0] : null;
        via = "session";
        if (user && now - Number(user.last_seen_at) > 60 * 60 * 1000) {
          await db.query("UPDATE hannah_sessions SET last_seen_at = $1, expires_at = $2 WHERE id = $3", [now, now + SESSION_TTL_MS, sessionId]);
        }
      }
      if (!user) {
        res.locals.hannahAccountInvalid = via === "api-key" ? "That HANNAH API key was revoked or doesn't exist." : "Your session has ended. Sign in again.";
        return next();
      }
      res.locals.hannahAccount = {
        id: user.id,
        email: user.email,
        displayName: user.display_name || "",
        via,
        sessionId: via === "session" ? sha256(token) : null,
        keys: await loadAccountKeys(db, user.id),
      };
      res.locals.hannahApiTokenId = `user:${user.id}`;
      return next();
    } catch (error) {
      console.error(`Account lookup failed (${error?.code || error?.name || "error"}).`);
      return res.status(503).json({ error: "The account database is unavailable right now.", reason: "database-unavailable" });
    }
  };
}

/** Simple fixed-window limiter for sign-in attempts. */
function attemptLimiter(limit, windowMs) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (buckets.size > 10_000) for (const [name, item] of buckets) if (now >= item.resetAt) buckets.delete(name);
    bucket.count += 1;
    return bucket.count <= limit ? 0 : Math.ceil((bucket.resetAt - now) / 1000);
  };
}

function publicUser(row) {
  return { id: row.id, email: row.email, displayName: row.display_name || row.displayName || "" };
}

function storableProvider(providerId) {
  const provider = typeof providerId === "string" ? getProvider(providerId) : null;
  if (!provider || provider.local || provider.id === "custom") return null;
  return provider;
}

async function databaseStatus() {
  if (!databaseConfigured()) return { configured: false, ready: false, kind: null, provider: null };
  let config;
  try {
    config = parseDatabaseUrl(process.env.DATABASE_URL);
  } catch (error) {
    return { configured: true, ready: false, kind: null, provider: null, error: describeDatabaseError(error) };
  }
  try {
    const db = await getDatabase();
    return { configured: true, ready: true, kind: db.kind, provider: db.provider, schemaVersion: db.schemaVersion };
  } catch (error) {
    return { configured: true, ready: false, kind: config.kind, provider: config.provider, error: describeDatabaseError(error) };
  }
}

/**
 * Routes under /api. `isOperator(res)` says whether the request carried the
 * operator token; `verifyProviderKey(provider, key)` returns false when the
 * provider rejects a key.
 */
function createAccountRouter({ isOperator, verifyProviderKey }) {
  const router = express.Router();
  const signInLimit = attemptLimiter(10, 15 * 60 * 1000);
  const ipLimit = attemptLimiter(60, 15 * 60 * 1000);

  const withDb = (handler) => async (req, res) => {
    if (!databaseConfigured()) return res.status(503).json({ error: "Accounts need a database. The operator can connect one in Integrations → Database.", reason: "database-unconfigured" });
    let db;
    try {
      db = await getDatabase();
    } catch (error) {
      return res.status(503).json({ error: describeDatabaseError(error), reason: "database-unavailable" });
    }
    try {
      return await handler(req, res, db);
    } catch (error) {
      console.error(`Account request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "The account request couldn't be completed." });
    }
  };
  const requireUser = (handler) => withDb(async (req, res, db) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to use your account.", reason: "signin-required" });
    return handler(req, res, db, account);
  });
  const requireSession = (handler) => requireUser(async (req, res, db, account) => {
    // Developer API keys can call the model API, not manage the account.
    if (account.via !== "session") return res.status(403).json({ error: "Manage your account from the app, not with an API key." });
    return handler(req, res, db, account);
  });

  async function startSession(req, res, db, user) {
    const token = `hs_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    await db.query("INSERT INTO hannah_sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES ($1, $2, $3, $4, $5, $6)", [sha256(token), user.id, now, now + SESSION_TTL_MS, now, String(req.get("user-agent") || "").slice(0, 200)]);
    res.setHeader("Set-Cookie", sessionCookie(req, token, SESSION_TTL_MS));
    const wantsBearer = req.get("x-hannah-session") === "bearer";
    return res.json({ user: publicUser(user), ...(wantsBearer ? { sessionToken: token, expiresAt: now + SESSION_TTL_MS } : {}) });
  }

  router.get("/db/status", async (_req, res) => {
    res.json({ database: await databaseStatus(), vault: vaultConfigured() });
  });

  router.post("/db/test", async (req, res) => {
    if (!isOperator(res)) return res.status(403).json({ error: "Only the server operator can test database connections." });
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url || url.length > 2048) return res.status(400).json({ ok: false, error: "Enter a database URL." });
    try {
      return res.json(await testDatabaseUrl(url));
    } catch (error) {
      return res.status(200).json({ ok: false, error: describeDatabaseError(error) });
    }
  });

  router.get("/account/status", async (_req, res) => {
    const database = await databaseStatus();
    const account = res.locals.hannahAccount;
    res.json({
      accounts: { enabled: database.ready, signup: database.ready && signupAllowed(), serverKeys: accountsUseServerKeys() },
      database,
      vault: vaultConfigured(),
      user: account ? { id: account.id, email: account.email, displayName: account.displayName, via: account.via, providers: [...account.keys.keys()] } : null,
      ...(res.locals.hannahAccountInvalid ? { sessionError: res.locals.hannahAccountInvalid } : {}),
    });
  });

  router.post("/account/register", withDb(async (req, res, db) => {
    if (!signupAllowed()) return res.status(403).json({ error: "New sign-ups are closed on this server." });
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim().replace(/[\r\n]+/g, " ").slice(0, 60) : "";
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: "Use a password of at least 10 characters." });
    if (ipLimit(`ip:${req.ip}`)) return res.status(429).json({ error: "Too many attempts. Try again later." });
    const existing = await db.query("SELECT id FROM hannah_users WHERE email = $1", [email]);
    if (existing.rows.length) return res.status(409).json({ error: "An account with that email already exists. Sign in instead." });
    const now = Date.now();
    const user = { id: randomUUID(), email, display_name: displayName };
    await db.query("INSERT INTO hannah_users (id, email, password_hash, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [user.id, email, await hashPassword(password), displayName || null, now, now]);
    await audit(db, user.id, "account.created");
    return startSession(req, res, db, user);
  }));

  router.post("/account/login", withDb(async (req, res, db) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password || password.length > 200) return res.status(400).json({ error: "Enter your email and password." });
    const wait = signInLimit(`email:${email}`) || ipLimit(`ip:${req.ip}`);
    if (wait) {
      res.setHeader("Retry-After", String(wait));
      return res.status(429).json({ error: "Too many sign-in attempts. Wait a few minutes and try again." });
    }
    const { rows } = await db.query("SELECT id, email, display_name, password_hash FROM hannah_users WHERE email = $1", [email]);
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
    if (!user || !ok) {
      if (user) await audit(db, user.id, "signin.failed");
      return res.status(401).json({ error: "That email and password don't match an account." });
    }
    await audit(db, user.id, "signin", { userAgent: String(req.get("user-agent") || "").slice(0, 120) });
    return startSession(req, res, db, user);
  }));

  router.post("/account/logout", withDb(async (req, res, db) => {
    const account = res.locals.hannahAccount;
    if (account?.sessionId) await db.query("DELETE FROM hannah_sessions WHERE id = $1", [account.sessionId]);
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    res.json({ ok: true });
  }));

  router.post("/account/logout-all", requireSession(async (req, res, db, account) => {
    await db.query("DELETE FROM hannah_sessions WHERE user_id = $1", [account.id]);
    await audit(db, account.id, "signout.all");
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    res.json({ ok: true });
  }));

  // Provider keys -------------------------------------------------------------
  router.get("/account/credentials", requireSession(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT provider_id, hint, updated_at FROM hannah_credentials WHERE user_id = $1 ORDER BY provider_id", [account.id]);
    res.json({ vault: vaultConfigured(), credentials: rows.map((row) => ({ providerId: row.provider_id, label: getProvider(row.provider_id)?.label || row.provider_id, hint: row.hint, updatedAt: Number(row.updated_at) })) });
  }));

  router.put("/account/credentials/:providerId", requireSession(async (req, res, db, account) => {
    const provider = storableProvider(req.params.providerId);
    if (!provider) return res.status(400).json({ error: "Keys can be saved for hosted providers only." });
    if (!vaultConfigured()) return res.status(503).json({ error: "Key storage is off on this server. The operator needs to set HANNAH_VAULT_KEY.", reason: "vault-unconfigured" });
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) return res.status(400).json({ error: "That doesn't look like an API key." });
    const verdict = await verifyProviderKey(provider, apiKey).catch(() => null);
    if (verdict === false) return res.status(400).json({ error: `${provider.label} didn't accept that key.` });
    const sealed = encryptSecret(apiKey, { userId: account.id, providerId: provider.id });
    const now = Date.now();
    await db.query(
      `INSERT INTO hannah_credentials (user_id, provider_id, key_id, wrapped_key, ciphertext, hint, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (user_id, provider_id) DO UPDATE SET key_id = excluded.key_id, wrapped_key = excluded.wrapped_key, ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`,
      [account.id, provider.id, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, secretHint(apiKey), now],
    );
    await audit(db, account.id, "credential.saved", { providerId: provider.id });
    res.json({ ok: true, providerId: provider.id, hint: secretHint(apiKey), verified: verdict === true });
  }));

  router.delete("/account/credentials/:providerId", requireSession(async (req, res, db, account) => {
    const result = await db.query("DELETE FROM hannah_credentials WHERE user_id = $1 AND provider_id = $2", [account.id, String(req.params.providerId)]);
    if (result.rowCount) await audit(db, account.id, "credential.removed", { providerId: String(req.params.providerId).slice(0, 40) });
    res.json({ ok: true, removed: result.rowCount > 0 });
  }));

  // Developer API keys ----------------------------------------------------------
  router.get("/account/api-keys", requireSession(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT id, name, prefix, created_at, last_used_at FROM hannah_api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC", [account.id]);
    res.json({ keys: rows.map((row) => ({ id: row.id.slice(0, 16), name: row.name, prefix: row.prefix, createdAt: Number(row.created_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at) })) });
  }));

  router.post("/account/api-keys", requireSession(async (req, res, db, account) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/[\r\n]+/g, " ").slice(0, 60) : "";
    if (!name) return res.status(400).json({ error: "Give the key a name so you can recognize it later." });
    const { rows } = await db.query("SELECT COUNT(*) AS count FROM hannah_api_keys WHERE user_id = $1 AND revoked_at IS NULL", [account.id]);
    if (Number(rows[0]?.count) >= 20) return res.status(400).json({ error: "You can have up to 20 active API keys. Revoke one first." });
    const key = `hk_${randomBytes(32).toString("base64url")}`;
    const id = sha256(key);
    await db.query("INSERT INTO hannah_api_keys (id, user_id, name, prefix, created_at) VALUES ($1, $2, $3, $4, $5)", [id, account.id, name, `${key.slice(0, 7)}…${key.slice(-4)}`, Date.now()]);
    await audit(db, account.id, "apikey.created", { name });
    res.status(201).json({ key, id: id.slice(0, 16), name, note: "Copy this key now. HANNAH stores only a hash and can't show it again." });
  }));

  router.delete("/account/api-keys/:id", requireSession(async (req, res, db, account) => {
    const prefix = String(req.params.id || "");
    if (!/^[0-9a-f]{16}$/.test(prefix)) return res.status(400).json({ error: "Unknown key." });
    const { rows } = await db.query("SELECT id, name FROM hannah_api_keys WHERE user_id = $1 AND revoked_at IS NULL", [account.id]);
    const match = rows.find((row) => row.id.startsWith(prefix));
    if (!match) return res.status(404).json({ error: "Unknown key." });
    await db.query("UPDATE hannah_api_keys SET revoked_at = $1 WHERE id = $2", [Date.now(), match.id]);
    await audit(db, account.id, "apikey.revoked", { name: match.name });
    res.json({ ok: true });
  }));

  // Sync ------------------------------------------------------------------------
  router.get("/account/data/:namespace", requireSession(async (req, res, db, account) => {
    const namespace = String(req.params.namespace);
    if (!SYNC_NAMESPACES.has(namespace)) return res.status(404).json({ error: "Unknown sync namespace." });
    const { rows } = await db.query("SELECT value, version, updated_at FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [account.id, namespace]);
    if (!rows[0]) return res.json({ namespace, value: null, version: 0, updatedAt: null });
    res.json({ namespace, value: JSON.parse(rows[0].value), version: Number(rows[0].version), updatedAt: Number(rows[0].updated_at) });
  }));

  router.put("/account/data/:namespace", requireSession(async (req, res, db, account) => {
    const namespace = String(req.params.namespace);
    if (!SYNC_NAMESPACES.has(namespace)) return res.status(404).json({ error: "Unknown sync namespace." });
    const baseVersion = Number(req.body?.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return res.status(400).json({ error: "baseVersion must be the version you last read (0 for new)." });
    const serialized = JSON.stringify(req.body?.value ?? null);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SYNC_BYTES) return res.status(413).json({ error: "This data is over the 1 MB sync limit." });
    const now = Date.now();
    const result = await db.transaction(async (query) => {
      const { rows } = await query("SELECT version FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [account.id, namespace]);
      const current = rows[0] ? Number(rows[0].version) : 0;
      if (current !== baseVersion) return { conflict: current };
      if (rows[0]) await query("UPDATE hannah_user_data SET value = $1, version = $2, updated_at = $3 WHERE user_id = $4 AND namespace = $5", [serialized, current + 1, now, account.id, namespace]);
      else await query("INSERT INTO hannah_user_data (user_id, namespace, value, version, updated_at) VALUES ($1, $2, $3, 1, $4)", [account.id, namespace, serialized, now]);
      return { version: current + 1 };
    });
    if (result.conflict !== undefined) return res.status(409).json({ error: "This changed on another device. Pull and merge first.", version: result.conflict });
    res.json({ namespace, version: result.version, updatedAt: now });
  }));

  // Audit, export, delete ---------------------------------------------------------
  router.get("/account/audit", requireSession(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT event, detail, created_at FROM hannah_audit WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100", [account.id]);
    res.json({ events: rows.map((row) => ({ event: row.event, detail: row.detail ? JSON.parse(row.detail) : null, at: Number(row.created_at) })) });
  }));

  router.get("/account/export", requireSession(async (_req, res, db, account) => {
    const [user, data, credentials, keys, events, tasks, connections, runs] = await Promise.all([
      db.query("SELECT id, email, display_name, created_at FROM hannah_users WHERE id = $1", [account.id]),
      db.query("SELECT namespace, value, version, updated_at FROM hannah_user_data WHERE user_id = $1", [account.id]),
      db.query("SELECT provider_id, hint, updated_at FROM hannah_credentials WHERE user_id = $1", [account.id]),
      db.query("SELECT name, prefix, created_at, last_used_at, revoked_at FROM hannah_api_keys WHERE user_id = $1", [account.id]),
      db.query("SELECT event, detail, created_at FROM hannah_audit WHERE user_id = $1 ORDER BY created_at", [account.id]),
      db.query("SELECT id, kind, title, detail, status, device_name, created_at, updated_at, decided_by FROM hannah_device_tasks WHERE user_id = $1 ORDER BY created_at", [account.id]),
      db.query("SELECT provider, account_email, scopes, created_at FROM hannah_connections WHERE user_id = $1", [account.id]),
      db.query("SELECT id, kind, title, status, record, last_device_name, created_at, updated_at, finished_at FROM hannah_task_runs WHERE user_id = $1 ORDER BY created_at", [account.id]),
    ]);
    await audit(db, account.id, "account.exported");
    res.setHeader("Content-Disposition", "attachment; filename=\"hannah-account-export.json\"");
    res.json({
      exportedAt: new Date().toISOString(),
      user: { id: user.rows[0]?.id, email: user.rows[0]?.email, displayName: user.rows[0]?.display_name || "", createdAt: Number(user.rows[0]?.created_at) },
      data: Object.fromEntries(data.rows.map((row) => [row.namespace, { value: JSON.parse(row.value), version: Number(row.version), updatedAt: Number(row.updated_at) }])),
      providerKeys: credentials.rows.map((row) => ({ providerId: row.provider_id, hint: row.hint, updatedAt: Number(row.updated_at), note: "Key values are never exported." })),
      apiKeys: keys.rows.map((row) => ({ name: row.name, prefix: row.prefix, createdAt: Number(row.created_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at) })),
      audit: events.rows.map((row) => ({ event: row.event, detail: row.detail ? JSON.parse(row.detail) : null, at: Number(row.created_at) })),
      deviceTasks: tasks.rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, detail: row.detail || "", status: row.status, device: row.device_name, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), decidedBy: row.decided_by || null })),
      connections: connections.rows.map((row) => ({ provider: row.provider, email: row.account_email, scopes: row.scopes, connectedAt: Number(row.created_at), note: "Sign-in tokens are never exported." })),
      taskRuns: runs.rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, status: row.status, record: JSON.parse(row.record), lastDevice: row.last_device_name, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at) })),
    });
  }));

  router.delete("/account", requireSession(async (req, res, db, account) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const { rows } = await db.query("SELECT password_hash FROM hannah_users WHERE id = $1", [account.id]);
    if (!rows[0] || !(await verifyPassword(password, rows[0].password_hash))) return res.status(401).json({ error: "Enter your password to delete your account." });
    // Child rows go with ON DELETE CASCADE; spend rows are keyed by credential, not user.
    await db.query("DELETE FROM hannah_users WHERE id = $1", [account.id]);
    await db.query("DELETE FROM hannah_spend WHERE credential_id = $1", [`user:${account.id}`]);
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    res.json({ ok: true, deleted: true });
  }));

  return router;
}

/** Database-backed spend store for gateway budgets. */
function createSpendStore() {
  return {
    async load(credentialId, day) {
      const db = await getDatabase();
      if (!db) return 0;
      const { rows } = await db.query("SELECT usd FROM hannah_spend WHERE credential_id = $1 AND day = $2", [credentialId, day]);
      return rows[0] ? Number(rows[0].usd) : 0;
    },
    async add(credentialId, day, usd) {
      const db = await getDatabase();
      if (!db) return;
      await db.query("INSERT INTO hannah_spend (credential_id, day, usd) VALUES ($1, $2, $3) ON CONFLICT (credential_id, day) DO UPDATE SET usd = hannah_spend.usd + excluded.usd", [credentialId, day, usd]);
    },
  };
}

/** Database-backed store for the end-to-end encrypted /api/sync/memory blobs. */
function createSyncBlobStore() {
  return {
    async get(syncId) {
      const db = await getDatabase();
      const { rows } = await db.query("SELECT blob, version, updated_at FROM hannah_sync_blobs WHERE sync_id = $1", [syncId]);
      return rows[0] ? { blob: rows[0].blob, version: Number(rows[0].version), updatedAt: new Date(Number(rows[0].updated_at)).toISOString() } : null;
    },
    async set(syncId, record) {
      const db = await getDatabase();
      await db.query("INSERT INTO hannah_sync_blobs (sync_id, blob, version, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (sync_id) DO UPDATE SET blob = excluded.blob, version = excluded.version, updated_at = excluded.updated_at", [syncId, record.blob, record.version, Date.parse(record.updatedAt)]);
    },
  };
}

module.exports = { accountAuth, accountsUseServerKeys, createAccountRouter, createSpendStore, createSyncBlobStore, hashPassword, parseCookies, verifyPassword, SYNC_NAMESPACES };
