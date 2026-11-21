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
];

module.exports = { MIGRATIONS };
