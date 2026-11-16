"use strict";

/**
 * Schema migrations, applied in order and recorded in hannah_migrations.
 * Statements use SQL that both Postgres and SQLite accept: TEXT ids, BIGINT
 * epoch milliseconds, JSON stored as TEXT. Never edit an applied migration;
 * add a new one.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: "accounts, vault, keys, sync, spend, audit",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        user_agent TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_sessions_user ON hannah_sessions (user_id)",
      `CREATE TABLE IF NOT EXISTS hannah_credentials (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        key_id TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        hint TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, provider_id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        last_used_at BIGINT,
        revoked_at BIGINT
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_api_keys_user ON hannah_api_keys (user_id)",
      `CREATE TABLE IF NOT EXISTS hannah_user_data (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, namespace)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_spend (
        credential_id TEXT NOT NULL,
        day TEXT NOT NULL,
        usd DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (credential_id, day)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_audit (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_audit_user ON hannah_audit (user_id, created_at)",
      `CREATE TABLE IF NOT EXISTS hannah_sync_blobs (
        sync_id TEXT PRIMARY KEY,
        blob TEXT NOT NULL,
        version BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: "webhooks",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_webhooks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        last_status INTEGER,
        last_delivery_at BIGINT
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_webhooks_user ON hannah_webhooks (user_id)",
    ],
  },
];

module.exports = { MIGRATIONS };
