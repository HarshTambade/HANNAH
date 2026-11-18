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
  {
    version: 7,
    name: "workflow trigger state",
    // Polling triggers (new email) keep their cursor here: what they've already seen.
    statements: ["ALTER TABLE hannah_workflow_triggers ADD COLUMN state TEXT"],
  },
  {
    version: 8,
    name: "workflow desktop jobs",
    // A step that runs on the user's desktop app: the server queues it here, a
    // signed-in desktop app claims it, runs it (asking the user there) and
    // reports back, which resumes the waiting execution.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_workflow_device_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        device_id TEXT,
        device_name TEXT,
        claimed_at BIGINT,
        result TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workflow_device_jobs_user ON hannah_workflow_device_jobs (user_id, status, created_at)",
    ],
  },
  {
    version: 9,
    name: "phone bridge",
    // A phone paired to the account with its own key; one-time pairing codes;
    // and short-lived commands (call, SMS, contact lookup) a computer sends it.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_paired_phones (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        paired_by TEXT,
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT,
        revoked_at BIGINT
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_paired_phones_user ON hannah_paired_phones (user_id)",
      `CREATE TABLE IF NOT EXISTS hannah_phone_pairing_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        created_by TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at BIGINT,
        phone_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_phone_commands (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        phone_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        nonce TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        delivered_at BIGINT,
        finished_at BIGINT,
        result TEXT
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_phone_commands_phone ON hannah_phone_commands (phone_id, status, created_at)",
      "CREATE INDEX IF NOT EXISTS hannah_phone_commands_user ON hannah_phone_commands (user_id, created_at)",
    ],
  },
  {
    version: 10,
    name: "workflow pause and recovery count",
    // pause_requested: the person asked to pause a running execution; the worker
    // stops before the next step. recoveries: how many times a stalled run was put
    // back in the queue after its worker disappeared (attempts also counts normal
    // resumes after waits, so it can't be used for dead-lettering).
    statements: [
      "ALTER TABLE hannah_workflow_executions ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE hannah_workflow_executions ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 11,
    name: "chat channels",
    // A chat app (Telegram) that reaches HANNAH for one account. The bot token is
    // sealed by the vault; the webhook secret and pairing code are kept as hashes.
    // Only the paired chat gets answers; history keeps the last few turns.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_channels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        secret_key_id TEXT NOT NULL,
        secret_wrapped TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        webhook_secret_hash TEXT NOT NULL,
        pairing_code_hash TEXT,
        pairing_expires_at BIGINT,
        paired_chat_id TEXT,
        paired_name TEXT,
        history TEXT,
        last_update_id BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_channels_user ON hannah_channels (user_id)",
    ],
  },
];

module.exports = { MIGRATIONS };
