"use strict";

/**
 * Bring-your-own database.
 *
 * HANNAH stores accounts, the encrypted key vault, sync data, developer keys
 * and spending in a database the operator chooses with one DATABASE_URL:
 *
 *   postgres://…  or postgresql://…   Supabase, Neon, RDS, Cloud SQL, Azure,
 *                                       Railway, Render, self-hosted Postgres…
 *   sqlite:./data/hannah.db            A file on a self-hosted server or desktop
 *                                       (needs Node 22.5+; not for serverless)
 *
 * With no DATABASE_URL, HANNAH keeps working on-device only and account
 * features report themselves as unavailable.
 *
 * Queries use a portable SQL subset written with $1, $2… placeholders; the
 * SQLite adapter rewrites them to ?1, ?2….
 */

const path = require("node:path");
const fs = require("node:fs");
const { MIGRATIONS } = require("./migrations");

function redact(url) {
  return String(url).replace(/\/\/([^:@/]+)(:[^@/]*)?@/, "//$1:***@");
}

/** Which hosted provider a Postgres URL points at, for display only. */
function detectProvider(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "postgres";
  }
  if (host.endsWith(".supabase.co") || host.endsWith(".supabase.com") || host.includes("pooler.supabase")) return "supabase";
  if (host.endsWith(".neon.tech") || host.endsWith(".neon.build")) return "neon";
  if (host.endsWith(".rds.amazonaws.com")) return "aws-rds";
  if (host.endsWith(".postgres.database.azure.com")) return "azure";
  if (host.endsWith(".railway.app") || host.endsWith(".rlwy.net")) return "railway";
  if (host.endsWith(".render.com")) return "render";
  if (host.endsWith(".aivencloud.com")) return "aiven";
  if (host.endsWith(".cockroachlabs.cloud")) return "cockroachdb";
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return "local-postgres";
  return "postgres";
}

function parseDatabaseUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) return null;
  if (/^postgres(ql)?:\/\//i.test(url)) return { kind: "postgres", url, provider: detectProvider(url) };
  const sqlite = /^(sqlite|file):(.*)$/i.exec(url);
  if (sqlite) {
    const target = sqlite[2].replace(/^\/\//, "");
    return { kind: "sqlite", url, provider: "sqlite", file: target === ":memory:" || !target ? ":memory:" : target };
  }
  const error = new Error("DATABASE_URL must start with postgres://, postgresql:// or sqlite:.");
  error.code = "unsupported_database";
  throw error;
}

function postgresSsl(url) {
  const mode = String(process.env.DATABASE_SSL || "").trim().toLowerCase();
  const ca = process.env.DATABASE_CA_CERT ? process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n") : undefined;
  if (mode === "off" || mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (ca) return { rejectUnauthorized: true, ca };
  if (/[?&]sslmode=/i.test(url)) return undefined; // the driver reads sslmode from the URL
  const provider = detectProvider(url);
  return provider === "local-postgres" ? false : { rejectUnauthorized: true };
}

function createPostgres(config) {
  // Loaded lazily so deployments without a database never need the driver.
  const { Pool } = require("pg");
  const ssl = postgresSsl(config.url);
  const pool = new Pool({
    connectionString: config.url,
    ...(ssl === undefined ? {} : { ssl }),
    max: Math.max(1, Math.min(20, Number(process.env.DATABASE_POOL_MAX) || 3)),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  pool.on("error", (error) => console.error(`Database pool error (${error?.code || error?.name || "error"}).`));
  const run = (client) => async (sql, params = []) => {
    const result = await client.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  };
  return {
    kind: "postgres",
    provider: config.provider,
    query: run(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn(run(client), { lock: (key) => client.query("SELECT pg_advisory_xact_lock($1)", [key]) });
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function createSqlite(config) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    const error = new Error("SQLite needs Node.js 22.5 or newer. Use a Postgres DATABASE_URL instead.");
    error.code = "unsupported_database";
    throw error;
  }
  if (config.file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(config.file)), { recursive: true });
  const db = new DatabaseSync(config.file === ":memory:" ? ":memory:" : path.resolve(config.file));
  db.exec("PRAGMA foreign_keys = ON");
  if (config.file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  const toSqlite = (sql) => sql.replace(/\$(\d+)/g, "?$1");
  const query = async (sql, params = []) => {
    const statement = db.prepare(toSqlite(sql));
    const values = params.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value === undefined ? null : value));
    if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rows = statement.all(...values).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...values);
    return { rows: [], rowCount: Number(result.changes) };
  };
  // node:sqlite is synchronous, so one connection serializes everything; a
  // promise chain keeps transactions from interleaving.
  let tail = Promise.resolve();
  return {
    kind: "sqlite",
    provider: "sqlite",
    query,
    transaction(fn) {
      const next = tail.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const value = await fn(query, { lock: async () => {} });
          db.exec("COMMIT");
          return value;
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
          throw error;
        }
      });
      tail = next.catch(() => {});
      return next;
    },
    close: async () => db.close(),
  };
}

const MIGRATION_LOCK = 724_411;

async function migrate(db) {
  await db.query("CREATE TABLE IF NOT EXISTS hannah_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
  return db.transaction(async (query, { lock }) => {
    await lock(MIGRATION_LOCK);
    const { rows } = await query("SELECT version FROM hannah_migrations");
    const applied = new Set(rows.map((row) => Number(row.version)));
    const ran = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      for (const statement of migration.statements) await query(statement);
      await query("INSERT INTO hannah_migrations (version, name, applied_at) VALUES ($1, $2, $3)", [migration.version, migration.name, Date.now()]);
      ran.push(migration.version);
    }
    return { ran, version: Math.max(0, ...MIGRATIONS.map((item) => item.version)) };
  });
}

/** Open and migrate a database. Throws a coded error when it can't. */
async function openDatabase(rawUrl) {
  const config = parseDatabaseUrl(rawUrl);
  if (!config) return null;
  const db = config.kind === "postgres" ? createPostgres(config) : createSqlite(config);
  try {
    const result = await migrate(db);
    db.schemaVersion = result.version;
    return db;
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
}

let current = null;
let currentUrl = null;

/** The process-wide database from DATABASE_URL, opened once on first use. */
function getDatabase() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) return Promise.resolve(null);
  if (!current || currentUrl !== url) {
    currentUrl = url;
    current = openDatabase(url).catch((error) => {
      current = null;
      console.error(`Database unavailable at ${redact(url)} (${error?.code || error?.name || "error"}).`);
      throw error;
    });
  }
  return current;
}

function databaseConfigured() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

/** Connect, run SELECT 1 and close. For the operator's "Test connection" button. */
async function testDatabaseUrl(rawUrl) {
  const config = parseDatabaseUrl(rawUrl);
  if (!config) throw Object.assign(new Error("Enter a database URL."), { code: "missing_url" });
  const db = config.kind === "postgres" ? createPostgres(config) : createSqlite(config);
  const startedAt = Date.now();
  try {
    await db.query("SELECT 1 AS ok");
    return { ok: true, kind: config.kind, provider: config.provider, latencyMs: Date.now() - startedAt };
  } finally {
    await db.close().catch(() => {});
  }
}

/** A short, credential-free reason for a database failure. */
function describeDatabaseError(error) {
  const code = String(error?.code || "");
  if (code === "unsupported_database" || code === "missing_url") return error.message;
  if (code === "28P01" || code === "28000") return "The database rejected the user name or password.";
  if (code === "3D000") return "That database doesn't exist on the server.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "The database host name couldn't be found.";
  if (code === "ECONNREFUSED") return "The database refused the connection. Check the host and port.";
  if (code === "ETIMEDOUT" || /timeout/i.test(String(error?.message))) return "The database didn't answer in time. Check the host, port and firewall or IP allow-list.";
  if (/self[- ]signed|certificate/i.test(String(error?.message))) return "The database's TLS certificate couldn't be verified. Set DATABASE_CA_CERT, or DATABASE_SSL=no-verify if your provider requires it.";
  if (/SSL|ssl/.test(String(error?.message))) return "The database requires a different TLS setting. Add ?sslmode=require to the URL or set DATABASE_SSL.";
  return "Couldn't connect to the database.";
}

/**
 * Use an already-open adapter ({ kind, provider, query, transaction, close })
 * for DATABASE_URL, after migrating it. Tests use this to run the Postgres
 * dialect on an embedded engine.
 */
async function useDatabase(db) {
  const result = await migrate(db);
  db.schemaVersion = result.version;
  currentUrl = String(process.env.DATABASE_URL || "").trim();
  current = Promise.resolve(db);
  return db;
}

/** Test hook: forget the cached connection. */
async function resetDatabase() {
  const pending = current;
  current = null;
  currentUrl = null;
  if (pending) await pending.then((db) => db?.close()).catch(() => {});
}

module.exports = { databaseConfigured, describeDatabaseError, detectProvider, getDatabase, migrate, openDatabase, parseDatabaseUrl, redact, resetDatabase, testDatabaseUrl, useDatabase };
