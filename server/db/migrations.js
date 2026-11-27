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
  {
    version: 12,
    name: "more chat channels",
    // Slack, Discord, Google Chat, Teams and WhatsApp (server/channel-drivers.js).
    // config: the platform's non-secret settings (app id, public key, phone number id …).
    // allowed: people the owner approved besides the paired chat; pending: who asked.
    // seen: recent event ids, so a platform's retries are answered once.
    statements: [
      "ALTER TABLE hannah_channels ADD COLUMN config TEXT",
      "ALTER TABLE hannah_channels ADD COLUMN allowed TEXT",
      "ALTER TABLE hannah_channels ADD COLUMN pending TEXT",
      "ALTER TABLE hannah_channels ADD COLUMN seen TEXT",
    ],
  },
  {
    version: 13,
    name: "phone requests from workflows",
    // A workflow step's phone request carries its execution and step, so the
    // phone's result resumes that run (and a retry doesn't send a second one).
    statements: [
      "ALTER TABLE hannah_phone_commands ADD COLUMN execution_id TEXT",
      "ALTER TABLE hannah_phone_commands ADD COLUMN node_id TEXT",
      "CREATE INDEX IF NOT EXISTS hannah_phone_commands_execution ON hannah_phone_commands (execution_id, node_id)",
    ],
  },
  {
    version: 14,
    name: "feedback and AI content reports in the database",
    // Serverless hosts have no writable disk, so reports kept only in a local
    // file were lost there. No account id, IP or chat text is stored.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_feedback (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        app_version TEXT,
        platform TEXT,
        inference_mode TEXT,
        mode_detail TEXT,
        diagnostics TEXT,
        created_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_feedback_created ON hannah_feedback (created_at)",
      `CREATE TABLE IF NOT EXISTS hannah_content_reports (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        app_version TEXT,
        platform TEXT,
        inference_mode TEXT,
        mode_detail TEXT,
        created_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_content_reports_created ON hannah_content_reports (created_at)",
    ],
  },
  {
    version: 15,
    name: "shared rate limits",
    // On serverless hosts each instance has its own memory, so per-address
    // limits for public write routes are counted here instead (one row per
    // limit and address, reset when its window ends).
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_rate_limits_reset ON hannah_rate_limits (reset_at)",
    ],
  },
  {
    version: 16,
    name: "generated documents and research history",
    // Files HANNAH made for an account (kept so they can be downloaded again,
    // revised, and produced by scheduled workflows) and the research behind
    // them. Bytes are stored as base64 text, which every supported database
    // takes. Rows are per user; expires_at is null for files the person keeps.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_documents (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        content TEXT NOT NULL,
        spec TEXT,
        summary TEXT,
        source TEXT NOT NULL,
        request TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_documents_recent ON hannah_documents (user_id, created_at)",
      `CREATE TABLE IF NOT EXISTS hannah_research (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        question TEXT NOT NULL,
        mode TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_research_recent ON hannah_research (user_id, created_at)",
    ],
  },
  {
    version: 17,
    name: "action engine, permissions, integrations and coding tasks",
    // One record per meaningful action HANNAH takes or asks to take for an
    // account (the audit trail and the approval queue are the same rows), the
    // account's permission policy and standing grants, token-based
    // integrations (GitHub) sealed with the vault, connected repositories and
    // durable coding tasks. Every row is per user.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_actions (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        action TEXT NOT NULL,
        service TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        executor TEXT NOT NULL,
        request TEXT,
        intent TEXT,
        agent TEXT,
        source TEXT,
        task_id TEXT,
        resource TEXT,
        account TEXT,
        params TEXT NOT NULL,
        preview TEXT,
        permission TEXT,
        approval TEXT,
        response TEXT,
        verification TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        executed_at BIGINT,
        expires_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS hannah_actions_once ON hannah_actions (user_id, idempotency_key)",
      "CREATE INDEX IF NOT EXISTS hannah_actions_recent ON hannah_actions (user_id, created_at)",
      "CREATE INDEX IF NOT EXISTS hannah_actions_waiting ON hannah_actions (user_id, status)",
      `CREATE TABLE IF NOT EXISTS hannah_permissions (
        user_id TEXT PRIMARY KEY REFERENCES hannah_users(id) ON DELETE CASCADE,
        policy TEXT NOT NULL,
        stopped_at BIGINT,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_grants (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        service TEXT NOT NULL,
        actions TEXT NOT NULL,
        resource TEXT,
        limits TEXT,
        note TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        revoked_at BIGINT,
        last_used_at BIGINT,
        uses INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_integrations (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        account TEXT,
        scopes TEXT,
        meta TEXT,
        key_id TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_ok_at BIGINT,
        last_error TEXT,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_repos (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        host TEXT NOT NULL,
        name TEXT NOT NULL,
        default_branch TEXT,
        settings TEXT NOT NULL,
        overview TEXT,
        indexed_ref TEXT,
        indexed_at BIGINT,
        checked_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_coding_tasks (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        state TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_coding_tasks_recent ON hannah_coding_tasks (user_id, updated_at)",
    ],
  },
  {
    version: 18,
    name: "robots, missions, telemetry and device events",
    // Robots a person enrolled (the registry), the missions HANNAH started on
    // them, a short telemetry history and the events a robot reported. A robot
    // authenticates as itself: its secret is sealed with the vault, and
    // `counter` is the last request number accepted from it (replay
    // protection). Every row is per user; a robot belongs to one account.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_robots (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        profile TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        safety TEXT NOT NULL,
        permissions TEXT NOT NULL,
        simulated INTEGER NOT NULL DEFAULT 0,
        simulator TEXT,
        state TEXT,
        mode TEXT,
        enroll_hash TEXT,
        enroll_expires_at BIGINT,
        key_id TEXT,
        wrapped_key TEXT,
        ciphertext TEXT,
        counter BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        enrolled_at BIGINT,
        last_seen_at BIGINT,
        revoked_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS hannah_robots_id ON hannah_robots (id)",
      "CREATE INDEX IF NOT EXISTS hannah_robots_enroll ON hannah_robots (enroll_hash)",
      `CREATE TABLE IF NOT EXISTS hannah_robot_missions (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL,
        action_id TEXT,
        requested_by TEXT,
        seq BIGINT NOT NULL,
        nonce TEXT NOT NULL,
        issued_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        deadline_at BIGINT NOT NULL,
        sent_at BIGINT,
        accepted_at BIGINT,
        finished_at BIGINT,
        cancel_requested_at BIGINT,
        progress TEXT,
        result TEXT,
        verification TEXT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_missions_robot ON hannah_robot_missions (robot_id, status, created_at)",
      "CREATE INDEX IF NOT EXISTS hannah_robot_missions_recent ON hannah_robot_missions (user_id, created_at)",
      `CREATE TABLE IF NOT EXISTS hannah_robot_telemetry (
        robot_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        sample TEXT NOT NULL,
        PRIMARY KEY (robot_id, at)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_robot_events (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_events_recent ON hannah_robot_events (robot_id, at)",
    ],
  },
  {
    version: 19,
    name: "robot commissioning, destinations, pause and resume, maintenance",
    // A physical robot's commissioning record, a configuration version that
    // goes up with every change a person makes, destinations a person defined
    // or approved (bound to the map they were made for), a mission's pause and
    // resume requests, and a maintenance log. Additive: existing rows keep
    // working, and existing robots are simply "not yet commissioned".
    statements: [
      "ALTER TABLE hannah_robots ADD COLUMN commissioning TEXT",
      "ALTER TABLE hannah_robots ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE hannah_robot_missions ADD COLUMN pause_requested_at BIGINT",
      "ALTER TABLE hannah_robot_missions ADD COLUMN resume_requested_at BIGINT",
      "ALTER TABLE hannah_robot_missions ADD COLUMN paused_at BIGINT",
      "ALTER TABLE hannah_robot_missions ADD COLUMN control_nonce TEXT",
      `CREATE TABLE IF NOT EXISTS hannah_robot_destinations (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        name TEXT NOT NULL,
        map TEXT NOT NULL,
        frame TEXT NOT NULL,
        x DOUBLE PRECISION NOT NULL,
        y DOUBLE PRECISION NOT NULL,
        yaw DOUBLE PRECISION,
        source TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_destinations_robot ON hannah_robot_destinations (robot_id)",
      `CREATE TABLE IF NOT EXISTS hannah_robot_maintenance (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_maintenance_robot ON hannah_robot_maintenance (robot_id, at)",
    ],
  },
  {
    version: 20,
    name: "robot plans",
    // A plan is several robot steps under one approval, run one at a time, with
    // each step's outcome kept as a checkpoint. A mission started by a plan
    // points back at it. Additive.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_robot_plans (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        title TEXT NOT NULL,
        template TEXT,
        steps TEXT NOT NULL,
        status TEXT NOT NULL,
        cursor INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 3,
        action_id TEXT,
        requested_by TEXT,
        error TEXT,
        start_by BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        started_at BIGINT,
        finished_at BIGINT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_plans_robot ON hannah_robot_plans (robot_id, status)",
      "ALTER TABLE hannah_robot_missions ADD COLUMN plan_id TEXT",
    ],
  },
  {
    version: 21,
    name: "robot camera images",
    // A picture a robot took on request: who owns it, which mission asked for
    // it, what the camera and the detector said about it, the image itself and
    // when it is deleted. Kept for a limited time only. Additive.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_robot_images (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        robot_id TEXT NOT NULL,
        mission_id TEXT,
        at BIGINT NOT NULL,
        meta TEXT NOT NULL,
        detections TEXT NOT NULL,
        data TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_images_robot ON hannah_robot_images (robot_id, at)",
    ],
  },
  {
    version: 22,
    name: "device hubs, devices, rules",
    // HANNAH OS: a hub is a computer next to the person's devices that speaks
    // their protocols; a device is one thing reached through a hub, described
    // by a profile; a rule is a simple automation the hub runs by itself.
    // A hub's key and a device's passwords are sealed in the vault. Additive.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_hubs (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        descriptor TEXT NOT NULL,
        enroll_hash TEXT,
        enroll_expires_at BIGINT,
        key_id TEXT,
        wrapped_key TEXT,
        ciphertext TEXT,
        counter BIGINT NOT NULL DEFAULT 0,
        seq BIGINT NOT NULL DEFAULT 0,
        config_version INTEGER NOT NULL DEFAULT 1,
        reported_config INTEGER NOT NULL DEFAULT 0,
        rules_suspended INTEGER NOT NULL DEFAULT 0,
        discovered TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        enrolled_at BIGINT,
        last_seen_at BIGINT,
        revoked_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS hannah_hubs_id ON hannah_hubs (id)",
      "CREATE INDEX IF NOT EXISTS hannah_hubs_enroll ON hannah_hubs (enroll_hash)",
      `CREATE TABLE IF NOT EXISTS hannah_devices (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        hub_id TEXT NOT NULL,
        name TEXT NOT NULL,
        location TEXT,
        status TEXT NOT NULL,
        profile_source TEXT NOT NULL,
        profile TEXT NOT NULL,
        settings TEXT NOT NULL,
        key_id TEXT,
        wrapped_key TEXT,
        ciphertext TEXT,
        writable TEXT NOT NULL,
        always_ask TEXT NOT NULL,
        verification TEXT,
        state TEXT,
        last_seen_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_devices_hub ON hannah_devices (hub_id)",
      `CREATE TABLE IF NOT EXISTS hannah_device_commands (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        hub_id TEXT NOT NULL,
        device_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        seq BIGINT NOT NULL,
        action_id TEXT,
        requested_by TEXT,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        sent_at BIGINT,
        finished_at BIGINT,
        result TEXT,
        error TEXT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_device_commands_hub ON hannah_device_commands (hub_id, status)",
      `CREATE TABLE IF NOT EXISTS hannah_device_rules (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        hub_id TEXT NOT NULL,
        name TEXT NOT NULL,
        spec TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT,
        action_id TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_device_events (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        hub_id TEXT,
        device_id TEXT,
        rule_id TEXT,
        at BIGINT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_device_events_at ON hannah_device_events (user_id, at)",
      `CREATE TABLE IF NOT EXISTS hannah_device_readings (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        point TEXT NOT NULL,
        at BIGINT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (user_id, device_id, point, at)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_device_profiles (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        source TEXT NOT NULL,
        profile TEXT NOT NULL,
        evidence TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
    ],
  },
  {
    version: 23,
    name: "publisher keys for signed profiles",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_publisher_keys (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        key_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        public_key TEXT NOT NULL,
        revoked_at BIGINT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, key_id)
      )`,
    ],
  },
  {
    version: 24,
    name: "hub update status",
    statements: [
      "ALTER TABLE hannah_hubs ADD COLUMN update_status TEXT",
    ],
  },
  {
    version: 25,
    name: "staged hub update rollouts",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_update_rollouts (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        url TEXT NOT NULL,
        cohort_size INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'update',
        rollback_to TEXT,
        status TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_update_rollout_targets (
        user_id TEXT NOT NULL,
        rollout_id TEXT NOT NULL,
        hub_id TEXT NOT NULL,
        hub_name TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        command_id TEXT,
        detail TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, rollout_id, hub_id),
        FOREIGN KEY (user_id, rollout_id) REFERENCES hannah_update_rollouts(user_id, id) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_update_rollout_targets_order ON hannah_update_rollout_targets (user_id, rollout_id, ordinal)",
      "CREATE INDEX IF NOT EXISTS hannah_update_rollouts_status ON hannah_update_rollouts (user_id, status, updated_at)",
    ],
  },
  {
    version: 26,
    name: "AI workforce: bots, teams, computers, memory, skills, routines, approvals, artifacts",
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_teams (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_team_members (
        team_id TEXT NOT NULL REFERENCES hannah_teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_org_policies (
        team_id TEXT PRIMARY KEY REFERENCES hannah_teams(id) ON DELETE CASCADE,
        rules TEXT,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_bots (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        team_id TEXT,
        name TEXT NOT NULL,
        avatar TEXT,
        description TEXT,
        role TEXT,
        template TEXT,
        personality TEXT,
        instructions TEXT,
        responsibilities TEXT,
        skills TEXT,
        apps TEXT,
        tools TEXT,
        memory_config TEXT,
        model_prefs TEXT,
        computer_access TEXT,
        file_access TEXT,
        permissions TEXT,
        autonomy TEXT NOT NULL DEFAULT 'approval',
        notifications TEXT,
        limits TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        visibility TEXT NOT NULL DEFAULT 'private',
        version INTEGER NOT NULL DEFAULT 1,
        config_hash TEXT,
        published_at BIGINT,
        archived_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_bots_team ON hannah_bots (team_id, visibility)",
      `CREATE TABLE IF NOT EXISTS hannah_bot_versions (
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        config TEXT NOT NULL,
        author_user_id TEXT,
        note TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, bot_id, version)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_memory (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        bot_id TEXT,
        team_id TEXT,
        project TEXT,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance TEXT,
        confidence REAL,
        source TEXT,
        verified_at BIGINT,
        expires_at BIGINT,
        sensitive INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_memory_lookup ON hannah_workforce_memory (user_id, bot_id, scope, updated_at)",
      `CREATE TABLE IF NOT EXISTS hannah_computers (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        bot_id TEXT,
        team_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        image TEXT,
        risk TEXT,
        permissions TEXT,
        limits TEXT,
        retention_days INTEGER,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_started_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_computer_sessions (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        computer_id TEXT NOT NULL,
        bot_id TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        url TEXT,
        tabs TEXT,
        checkpoint TEXT,
        activity TEXT,
        started_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        ended_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_tasks (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        parent_id TEXT,
        bot_id TEXT,
        team_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        depends_on TEXT,
        inputs TEXT,
        deliverable TEXT,
        acceptance TEXT,
        deadline BIGINT,
        priority TEXT,
        project TEXT,
        result TEXT,
        error TEXT,
        continuation TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        started_at BIGINT,
        finished_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_tasks_status ON hannah_workforce_tasks (user_id, status, updated_at)",
      `CREATE TABLE IF NOT EXISTS hannah_task_handoffs (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_bot_id TEXT,
        to_bot_id TEXT NOT NULL,
        note TEXT,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_skills (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        team_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        when_to_use TEXT,
        inputs TEXT,
        apps TEXT,
        permissions TEXT,
        steps TEXT,
        decision_rules TEXT,
        outputs TEXT,
        failure_handling TEXT,
        safety TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        tests TEXT,
        published_at BIGINT,
        archived_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_skill_versions (
        user_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        definition TEXT NOT NULL,
        note TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, skill_id, version)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_teach_sessions (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        bot_id TEXT,
        computer_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        consent TEXT,
        events TEXT,
        skill_id TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        ended_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_routines (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        bot_id TEXT,
        team_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        skill_id TEXT,
        mode TEXT NOT NULL,
        trigger TEXT,
        timezone TEXT,
        status TEXT NOT NULL,
        next_run_at BIGINT,
        last_run_at BIGINT,
        run_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        notifications TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_routines_due ON hannah_routines (status, next_run_at)",
      `CREATE TABLE IF NOT EXISTS hannah_routine_runs (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT,
        planned_for BIGINT,
        started_at BIGINT,
        finished_at BIGINT,
        result TEXT,
        error TEXT,
        task_id TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_secrets (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        application TEXT,
        kind TEXT NOT NULL,
        key_id TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        hint TEXT,
        scopes TEXT,
        bot_ids TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        last_used_at BIGINT,
        revoked_at BIGINT,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_approvals (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        bot_id TEXT,
        task_id TEXT,
        team_id TEXT,
        action TEXT NOT NULL,
        title TEXT NOT NULL,
        target TEXT,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT,
        decision TEXT,
        reason TEXT,
        requested_at BIGINT NOT NULL,
        decided_at BIGINT,
        expires_at BIGINT,
        decided_by TEXT,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_approvals_open ON hannah_workforce_approvals (user_id, status, requested_at)",
      `CREATE TABLE IF NOT EXISTS hannah_workforce_policies (
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        rules TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (scope_kind, scope_id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_artifacts (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        team_id TEXT,
        task_id TEXT,
        bot_id TEXT,
        name TEXT NOT NULL,
        type TEXT,
        size BIGINT,
        sha256 TEXT,
        storage_key TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        parent_artifact_id TEXT,
        source TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_artifacts_task ON hannah_artifacts (user_id, task_id, created_at)",
      `CREATE TABLE IF NOT EXISTS hannah_proactive_settings (
        user_id TEXT PRIMARY KEY REFERENCES hannah_users(id) ON DELETE CASCADE,
        settings TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_proactive_offers (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        source TEXT,
        status TEXT NOT NULL,
        action TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_meetings (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        team_id TEXT,
        bot_id TEXT,
        provider TEXT,
        title TEXT NOT NULL,
        starts_at BIGINT,
        ends_at BIGINT,
        status TEXT NOT NULL,
        consent TEXT,
        participants TEXT,
        transcript TEXT,
        notes TEXT,
        actions TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_events (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        bot_id TEXT,
        task_id TEXT,
        computer_id TEXT,
        severity TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_events_recent ON hannah_workforce_events (user_id, created_at)",
    ],
  },
  {
    version: 27,
    name: "robot os bridge envelopes",
    // Onboard HANNAH Robot OS sends signed envelopes (telemetry, events, acks).
    // Each envelope id is accepted once; an owner is linked when the robot is
    // registered or configured explicitly. Additive; no existing row is changed.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_robot_os_envelopes (
        envelope_id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES hannah_users(id) ON DELETE CASCADE,
        robot_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ts_ms BIGINT NOT NULL,
        received_at BIGINT NOT NULL,
        signature TEXT NOT NULL,
        payload TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_os_envelopes_owner ON hannah_robot_os_envelopes (user_id, received_at)",
      "CREATE INDEX IF NOT EXISTS hannah_robot_os_envelopes_robot ON hannah_robot_os_envelopes (robot_id, received_at)",
    ],
  },
  {
    version: 28,
    name: "robot os signed commands",
    // Parent HANNAH -> onboard Robot OS commands. Every command is signed,
    // expires, and carries a one-time nonce. Only an approved action queues one.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_robot_os_commands (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES hannah_users(id) ON DELETE CASCADE,
        robot_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        params TEXT NOT NULL,
        issued_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        nonce TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL,
        ack_reason TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_robot_os_commands_pending ON hannah_robot_os_commands (robot_id, status, expires_at)",
      "CREATE INDEX IF NOT EXISTS hannah_robot_os_commands_owner ON hannah_robot_os_commands (user_id, created_at)",
    ],
  },
  {
    version: 29,
    name: "AI workforce: teammate conversations",
    // One person's conversation with one teammate. Rows are keyed by the person,
    // so a published team teammate never shows one member's chat to another.
    // Additive; no existing row is changed.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_workforce_messages (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        task_id TEXT,
        reply_to TEXT,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        data TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_messages_thread ON hannah_workforce_messages (user_id, bot_id, created_at)",
      "CREATE INDEX IF NOT EXISTS hannah_workforce_messages_task ON hannah_workforce_messages (user_id, task_id, created_at)",
    ],
  },
  {
    version: 30,
    name: "AI workforce: notifications, their delivery log, and desktop jobs",
    // Where a person wants workforce notifications (chat apps, webhooks), a
    // record of every delivery attempt (including ones held for quiet hours),
    // and jobs a teammate sends to the person's desktop app, which asks there
    // before running each one. Additive; no existing row is changed.
    statements: [
      `CREATE TABLE IF NOT EXISTS hannah_workforce_notify_settings (
        user_id TEXT PRIMARY KEY REFERENCES hannah_users(id) ON DELETE CASCADE,
        settings TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS hannah_workforce_deliveries (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        event_id TEXT,
        event_kind TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_deliveries_recent ON hannah_workforce_deliveries (user_id, created_at)",
      `CREATE TABLE IF NOT EXISTS hannah_workforce_local_jobs (
        user_id TEXT NOT NULL REFERENCES hannah_users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        bot_id TEXT,
        computer_id TEXT NOT NULL,
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
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS hannah_workforce_local_jobs_pending ON hannah_workforce_local_jobs (user_id, status, expires_at)",
    ],
  },
  {
    version: 31,
    name: "Robots: a per-robot mission number counter",
    // A robot refuses a mission whose number isn't above every one it took.
    // Numbers came from the server's clock, so two instances in the same
    // millisecond, or a clock step back, could repeat one. Each number is now
    // claimed from this counter with a compare-and-swap. Additive; 0 means
    // "not used yet", and the first claim starts above every stored mission.
    statements: [
      "ALTER TABLE hannah_robots ADD COLUMN mission_seq BIGINT NOT NULL DEFAULT 0",
    ],
  },
];

module.exports = { MIGRATIONS };
