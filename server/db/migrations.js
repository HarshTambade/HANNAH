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
  {
    version: 3,
    name: "tasks across devices",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_device_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at BIGINT,
        decided_at BIGINT,
        decided_by TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_device_tasks_user ON hannah_device_tasks (user_id, updated_at)",
    ],
  },
  {
    version: 4,
    name: "calendar and email connections",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_connections (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        account_email TEXT,
        scopes TEXT NOT NULL,
        key_id TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, provider)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_oauth_states (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        key_id TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        return_to TEXT,
        expires_at BIGINT NOT NULL
      )`,
    ],
  },
  {
    version: 5,
    name: "durable task runs",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_task_runs (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        record TEXT NOT NULL,
        version INTEGER NOT NULL,
        last_write_id TEXT,
        lease_device_id TEXT,
        lease_device_name TEXT,
        lease_expires_at BIGINT,
        last_device_name TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        finished_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_task_runs_user ON hannah_task_runs (user_id, updated_at)",
    ],
  },
  {
    version: 6,
    name: "workflow engine",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_workflows (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        draft TEXT NOT NULL,
        draft_version INTEGER NOT NULL,
        published_version INTEGER,
        active INTEGER NOT NULL DEFAULT 0,
        approved_manifest TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workflow_versions (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, workflow_id, version)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workflow_executions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL,
        workflow_version INTEGER,
        definition TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_node_id TEXT NOT NULL,
        trigger_data TEXT,
        state TEXT,
        error TEXT,
        error_node TEXT,
        waiting TEXT,
        wait_until BIGINT,
        resume TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        retry_of TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at BIGINT,
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        finished_at BIGINT,
        updated_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_wf_exec_user ON hannah_workflow_executions (user_id, created_at)",
      "CREATE INDEX IF NOT EXISTS hannah_wf_exec_status ON hannah_workflow_executions (status, wait_until)",
      "CREATE UNIQUE INDEX IF NOT EXISTS hannah_wf_exec_idem ON hannah_workflow_executions (user_id, idempotency_key)",
      `CREATE TABLE IF NOT EXISTS hannah_workflow_node_runs (
        execution_id TEXT NOT NULL REFERENCES hannah_workflow_executions(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        node_name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at BIGINT,
        finished_at BIGINT,
        input TEXT,
        output TEXT,
        error TEXT,
        PRIMARY KEY (execution_id, node_id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workflow_triggers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        config TEXT NOT NULL,
        secret_hash TEXT,
        secret_key_id TEXT,
        secret_wrapped TEXT,
        secret_ciphertext TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        next_run_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS hannah_wf_trigger_node ON hannah_workflow_triggers (user_id, workflow_id, node_id)",
      "CREATE INDEX IF NOT EXISTS hannah_wf_trigger_due ON hannah_workflow_triggers (kind, enabled, next_run_at)",
      `CREATE TABLE IF NOT EXISTS hannah_workflow_deliveries (
        trigger_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        received_at BIGINT NOT NULL,
        PRIMARY KEY (trigger_id, delivery_id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workflow_credentials (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        key_id TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        hint TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_notifications (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT,
        created_at BIGINT NOT NULL,
        read_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_notifications_user ON hannah_notifications (user_id, created_at)",
    ],
  },
];

module.exports = { MIGRATIONS };
