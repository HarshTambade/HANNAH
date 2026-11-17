"use strict";

/**
 * Workflow HTTP API (mounted at /api).
 *
 * Signed-in accounts only (workflows need the account database), and every
 * query is scoped to the signed-in user, so one account can never read, run
 * or change another's workflows, executions or credentials.
 *
 *   GET    /workflows/catalog                     node and credential catalog (public)
 *   GET    /workflows                             your workflows
 *   POST   /workflows                             create a draft { name, definition? }
 *   POST   /workflows/import                      create a draft from an exported file
 *   POST   /workflows/from-text                   draft a workflow from a description (AI)
 *   GET    /workflows/:id                         draft, published version, validation, permissions, webhooks
 *   PUT    /workflows/:id                         save the draft { name, description, definition, baseVersion }
 *   DELETE /workflows/:id
 *   POST   /workflows/:id/validate
 *   POST   /workflows/:id/publish                 draft → new published version (must validate)
 *   POST   /workflows/:id/activate                { approvedPermissions } → triggers on
 *   POST   /workflows/:id/deactivate
 *   POST   /workflows/:id/run                     { draft?, triggerData?, triggerNodeId? }
 *   POST   /workflows/:id/test-node               { nodeId, items? }
 *   GET    /workflows/:id/versions                published history
 *   POST   /workflows/:id/versions/:v/restore     version → draft
 *   POST   /workflows/:id/webhooks/:nodeId/rotate new secret (shown once)
 *   GET    /workflows/:id/export
 *   GET    /workflows/executions                  ?workflowId&status&limit
 *   GET    /workflows/executions/:id              execution with every node's input and output
 *   POST   /workflows/executions/:id/cancel
 *   POST   /workflows/executions/:id/retry        { from: "failed" | "start" }
 *   POST   /workflows/executions/:id/resume       { approved } for approvals
 *   GET    /workflows/approvals                   runs waiting for you
 *   GET    /workflows/credentials                 names and types only, never values
 *   POST   /workflows/credentials                 { name, type, data }
 *   PUT    /workflows/credentials/:id
 *   DELETE /workflows/credentials/:id
 *   POST   /workflows/events                      { name, data } custom events for event triggers
 *   GET    /notifications                         ?since
 *   POST   /notifications/:id/read
 *   GET|POST /workflows/tick                      cron: Authorization: Bearer $CRON_SECRET
 *   ANY    /hooks/:triggerId                      public webhook (token or HMAC), see receiveWebhook
 *   POST   /hooks/resume/:token                   one-time resume URL for “Wait for webhook”
 */
const crypto = require("node:crypto");
const express = require("express");
const { databaseConfigured, getDatabase } = require("../db");
const { encryptSecret, secretHint, vaultConfigured, decryptSecret } = require("../vault");
const engine = require("./engine");
const { CREDENTIAL_TYPES, REGISTRY, catalog } = require("./nodes");
const { FINAL, sha256 } = require("./runtime");

const ID = /^[A-Za-z0-9_-]{6,80}$/;
const MAX_DEFINITION_BYTES = 512 * 1024;
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const parse = (text, fallback = null) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;

function starterDefinition() {
  return { format: engine.FORMAT, version: engine.VERSION, nodes: [{ id: "trigger", name: "When I run it", type: "trigger.manual", params: {}, position: { x: 80, y: 160 } }], connections: [], settings: { timezone: "UTC" } };
}

function checkDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw fail(400, "The workflow definition must be an object.", "bad-request");
  const text = JSON.stringify(definition);
  if (Buffer.byteLength(text, "utf8") > MAX_DEFINITION_BYTES) throw fail(413, "A workflow can be up to 512 KB.", "too-large");
  // Strip anything that isn't part of the format: an imported or AI-made file can't smuggle fields in.
  return {
    format: engine.FORMAT,
    version: engine.VERSION,
    nodes: (Array.isArray(definition.nodes) ? definition.nodes : []).slice(0, engine.LIMITS.nodes).map((node) => ({
      id: clean(node?.id, 64), name: clean(node?.name, 80), type: clean(node?.type, 40),
      params: node?.params && typeof node.params === "object" && !Array.isArray(node.params) ? node.params : {},
      position: { x: Number(node?.position?.x) || 0, y: Number(node?.position?.y) || 0 },
      ...(node?.credentialId ? { credentialId: clean(node.credentialId, 80) } : {}),
      ...(node?.disabled ? { disabled: true } : {}),
      ...(node?.notes ? { notes: clean(node.notes, 1000) } : {}),
      settings: {
        ...(Number.isInteger(node?.settings?.retries) ? { retries: node.settings.retries } : {}),
        ...(Number.isFinite(node?.settings?.retryDelayMs) ? { retryDelayMs: node.settings.retryDelayMs } : {}),
        ...(Number.isFinite(node?.settings?.timeoutMs) ? { timeoutMs: node.settings.timeoutMs } : {}),
        ...(node?.settings?.continueOnFail ? { continueOnFail: true } : {}),
      },
    })),
    connections: (Array.isArray(definition.connections) ? definition.connections : []).slice(0, engine.LIMITS.connections).map((connection) => ({
      id: clean(connection?.id, 120) || newId("c"), source: clean(connection?.source, 64), target: clean(connection?.target, 64),
      sourceOutput: clean(connection?.sourceOutput || "main", 40), targetInput: clean(connection?.targetInput || "main", 40),
    })),
    settings: {
      timezone: clean(definition.settings?.timezone || "UTC", 64),
      ...(Number.isFinite(definition.settings?.timeoutMs) ? { timeoutMs: definition.settings.timeoutMs } : {}),
    },
  };
}

function publicWorkflow(row, extra = {}) {
  return {
    id: row.id, name: row.name, description: row.description || "", active: Boolean(Number(row.active)),
    draftVersion: Number(row.draft_version), publishedVersion: row.published_version === null || row.published_version === undefined ? null : Number(row.published_version),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), ...extra,
  };
}

function publicExecution(row) {
  return {
    id: row.id, workflowId: row.workflow_id, workflowVersion: row.workflow_version === null ? null : Number(row.workflow_version), mode: row.mode, status: row.status,
    error: row.error || null, errorNode: row.error_node || null, attempts: Number(row.attempts),
    waiting: (() => { const waiting = parse(row.waiting, null); if (!waiting) return null; const { tokenHash: _hash, ...rest } = waiting; return rest; })(),
    retryOf: row.retry_of || null, cancelRequested: Boolean(Number(row.cancel_requested)),
    createdAt: Number(row.created_at), startedAt: row.started_at === null ? null : Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at), updatedAt: Number(row.updated_at),
  };
}

function manifestHash(manifest) {
  return sha256(JSON.stringify(manifest));
}

function createWorkflowRouter({ runtime, publicBaseUrl = () => "" }) {
  const router = express.Router();
  const json = express.json({ limit: "1mb" });

  const withAccount = (handler) => async (req, res) => {
    try {
      if (!databaseConfigured()) throw fail(503, "Server workflows need the account database. Set DATABASE_URL on the server, or use automations on this device.", "database-required");
      const account = res.locals.hannahAccount;
      if (!account) throw fail(401, "Sign in to use workflows.", "sign-in");
      const db = await getDatabase();
      await handler(req, res, db, account);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500 && !error.reason) console.error(`Workflow API error (${error?.code || error?.name || "error"}): ${error.message}`);
      res.status(status).json({ error: status >= 500 && !error.reason ? "Something went wrong on the server." : error.message, reason: error.reason, ...(error.validation ? { validation: error.validation } : {}) });
    }
  };

  async function loadWorkflow(db, userId, id) {
    if (!ID.test(id)) throw fail(404, "That workflow doesn't exist.", "not-found");
    const { rows: [row] } = await db.query("SELECT * FROM hannah_workflows WHERE user_id = $1 AND id = $2", [userId, id]);
    if (!row) throw fail(404, "That workflow doesn't exist.", "not-found");
    return row;
  }

  async function credentialTypes(db, userId) {
    const { rows } = await db.query("SELECT id, type FROM hannah_workflow_credentials WHERE user_id = $1", [userId]);
    return new Map(rows.map((row) => [row.id, row.type]));
  }

  async function webhooksFor(db, userId, workflowId, req) {
    const { rows } = await db.query("SELECT id, node_id, config, enabled, secret_ciphertext FROM hannah_workflow_triggers WHERE user_id = $1 AND workflow_id = $2 AND kind = 'webhook'", [userId, workflowId]);
    const base = publicBaseUrl(req);
    return rows.map((row) => ({ nodeId: row.node_id, triggerId: row.id, url: `${base}/api/hooks/${row.id}`, enabled: Boolean(Number(row.enabled)), auth: parse(row.config, {}).params?.auth || "token", hmacReady: Boolean(row.secret_ciphertext) }));
  }

  /** On serverless hosting nothing runs in the background: run this execution now, within a time budget. */
  async function drive(executionId, budgetMs = 20_000) {
    if (!SERVERLESS) return;
    await runtime.tick({ budgetMs, only: executionId }).catch(() => {});
  }

  // ----- catalog (public) -----
  router.get("/workflows/catalog", (_req, res) => res.json(catalog()));

  // ----- cron tick (CRON_SECRET) -----
  const tickHandler = async (req, res) => {
    const secret = process.env.CRON_SECRET || "";
    const given = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "")?.[1] || "";
    if (secret.length < 16 || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return res.status(401).json({ error: "Set CRON_SECRET (16+ characters) on the server and send it as a bearer token." });
    if (!databaseConfigured()) return res.status(503).json({ error: "Workflows need DATABASE_URL." });
    res.json(await runtime.tick({ budgetMs: 50_000 }));
  };
  router.get("/workflows/tick", tickHandler);
  router.post("/workflows/tick", tickHandler);

  // ----- workflows -----
  router.get("/workflows", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_workflows WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200", [account.id]);
    const { rows: last } = await db.query(
      `SELECT e.workflow_id, e.status, e.created_at, e.error FROM hannah_workflow_executions e
       JOIN (SELECT workflow_id, MAX(created_at) AS at FROM hannah_workflow_executions WHERE user_id = $1 AND mode <> 'test' GROUP BY workflow_id) latest
       ON latest.workflow_id = e.workflow_id AND latest.at = e.created_at WHERE e.user_id = $1`, [account.id]);
    const { rows: triggers } = await db.query("SELECT workflow_id, kind, next_run_at, enabled FROM hannah_workflow_triggers WHERE user_id = $1", [account.id]);
    const lastBy = new Map(last.map((row) => [row.workflow_id, { status: row.status, at: Number(row.created_at), error: row.error || null }]));
    res.json({
      workflows: rows.map((row) => {
        const draft = parse(row.draft, {});
        const own = triggers.filter((trigger) => trigger.workflow_id === row.id && Number(trigger.enabled));
        const nextRun = own.filter((trigger) => trigger.kind === "schedule" && trigger.next_run_at).map((trigger) => Number(trigger.next_run_at)).sort()[0] ?? null;
        return publicWorkflow(row, { nodes: (draft.nodes || []).length, triggers: [...new Set((draft.nodes || []).filter((node) => REGISTRY.get(node.type)?.category === "trigger").map((node) => node.type))], lastRun: lastBy.get(row.id) || null, nextRunAt: nextRun });
      }),
    });
  }));

  router.post("/workflows", json, withAccount(async (req, res, db, account) => {
    const { rows: [count] } = await db.query("SELECT COUNT(*) AS n FROM hannah_workflows WHERE user_id = $1", [account.id]);
    if (Number(count.n) >= 200) throw fail(400, "You can have up to 200 workflows.", "limit");
    const definition = req.body?.definition ? checkDefinition(req.body.definition) : starterDefinition();
    const id = newId("wf");
    const at = Date.now();
    const name = clean(req.body?.name, 120) || "Untitled workflow";
    await db.query("INSERT INTO hannah_workflows (user_id, id, name, description, draft, draft_version, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 0, $6, $6)", [account.id, id, name, clean(req.body?.description, 1000), JSON.stringify(definition), at]);
    res.status(201).json({ workflow: publicWorkflow({ id, name, description: clean(req.body?.description, 1000), active: 0, draft_version: 1, published_version: null, created_at: at, updated_at: at }), definition });
  }));

  router.post("/workflows/import", json, withAccount(async (req, res, db, account) => {
    const file = req.body?.file ?? req.body;
    if (!file || file.format !== engine.FORMAT) throw fail(400, "That isn't an exported HANNAH workflow.", "bad-request");
    const definition = checkDefinition(file.definition ?? file);
    // Credentials don't travel: references to ones this account doesn't have are dropped.
    const owned = await credentialTypes(db, account.id);
    for (const node of definition.nodes) if (node.credentialId && !owned.has(node.credentialId)) delete node.credentialId;
    const id = newId("wf");
    const at = Date.now();
    const name = clean(file.name || req.body?.name, 120) || "Imported workflow";
    await db.query("INSERT INTO hannah_workflows (user_id, id, name, description, draft, draft_version, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 0, $6, $6)", [account.id, id, name, clean(file.description, 1000), JSON.stringify(definition), at]);
    res.status(201).json({ workflow: publicWorkflow({ id, name, description: clean(file.description, 1000), active: 0, draft_version: 1, published_version: null, created_at: at, updated_at: at }), definition, validation: engine.validateWorkflow(definition, { credentials: owned }) });
  }));

  router.post("/workflows/from-text", json, withAccount(async (req, res, db, account) => {
    const description = clean(req.body?.description, 2000);
    if (description.length < 8) throw fail(400, "Describe the automation in a sentence or two.", "bad-request");
    const draft = await draftFromText(runtime.servicesFor(account.id), description, req.body?.timezone);
    const owned = await credentialTypes(db, account.id);
    const definition = checkDefinition(draft.definition);
    const id = newId("wf");
    const at = Date.now();
    await db.query("INSERT INTO hannah_workflows (user_id, id, name, description, draft, draft_version, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 0, $6, $6)", [account.id, id, draft.name, description, JSON.stringify(definition), at]);
    res.status(201).json({ workflow: publicWorkflow({ id, name: draft.name, description, active: 0, draft_version: 1, published_version: null, created_at: at, updated_at: at }), definition, validation: engine.validateWorkflow(definition, { credentials: owned }), notes: draft.notes });
  }));

  // ----- executions (before /workflows/:id so the paths don't collide) -----
  router.get("/workflows/executions", withAccount(async (req, res, db, account) => {
    const params = [account.id];
    const where = ["user_id = $1"];
    if (req.query.workflowId) { params.push(String(req.query.workflowId)); where.push(`workflow_id = $${params.length}`); }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`status = $${params.length}`); }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const { rows } = await db.query(`SELECT * FROM hannah_workflow_executions WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`, params);
    const names = new Map((await db.query("SELECT id, name FROM hannah_workflows WHERE user_id = $1", [account.id])).rows.map((row) => [row.id, row.name]));
    const counts = rows.length ? (await db.query(`SELECT execution_id, status, COUNT(*) AS n FROM hannah_workflow_node_runs WHERE execution_id IN (${rows.map((_, index) => `$${index + 1}`).join(",")}) GROUP BY execution_id, status`, rows.map((row) => row.id))).rows : [];
    res.json({
      executions: rows.map((row) => {
        const own = counts.filter((count) => count.execution_id === row.id);
        const tally = (statuses) => own.filter((count) => statuses.includes(count.status)).reduce((sum, count) => sum + Number(count.n), 0);
        return { ...publicExecution(row), workflowName: names.get(row.workflow_id) || "Deleted workflow", nodes: { done: tally(["done"]), failed: tally(["failed", "failed-continued"]), skipped: tally(["skipped"]), total: own.reduce((sum, count) => sum + Number(count.n), 0) } };
      }),
    });
  }));

  router.get("/workflows/approvals", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT e.*, w.name AS workflow_name FROM hannah_workflow_executions e JOIN hannah_workflows w ON w.user_id = e.user_id AND w.id = e.workflow_id WHERE e.user_id = $1 AND e.status = 'waiting-approval' ORDER BY e.updated_at DESC LIMIT 50", [account.id]);
    res.json({ approvals: rows.map((row) => ({ ...publicExecution(row), workflowName: row.workflow_name })) });
  }));

  router.get("/workflows/executions/:id", withAccount(async (req, res, db, account) => {
    const load = async () => (await db.query("SELECT * FROM hannah_workflow_executions WHERE id = $1 AND user_id = $2", [String(req.params.id), account.id])).rows[0];
    let row = await load();
    if (!row) throw fail(404, "That run doesn't exist.", "not-found");
    if (row.status === "queued") { await drive(row.id, 8_000); row = await load(); }
    const { rows: nodes } = await db.query("SELECT * FROM hannah_workflow_node_runs WHERE execution_id = $1", [row.id]);
    const definition = parse(row.definition, {});
    const order = new Map((definition.nodes || []).map((node, index) => [node.id, index]));
    const { rows: [workflowRow] } = await db.query("SELECT name FROM hannah_workflows WHERE user_id = $1 AND id = $2", [account.id, row.workflow_id]);
    res.json({
      execution: { ...publicExecution(row), workflowName: workflowRow?.name || "Deleted workflow", triggerData: engine.sanitize(parse(row.trigger_data, null)) },
      definition,
      nodes: nodes.sort((a, b) => (Number(a.started_at) || Infinity) - (Number(b.started_at) || Infinity) || (order.get(a.node_id) ?? 0) - (order.get(b.node_id) ?? 0)).map((node) => ({
        nodeId: node.node_id, name: node.node_name, status: node.status, attempts: Number(node.attempts),
        startedAt: node.started_at === null ? null : Number(node.started_at), finishedAt: node.finished_at === null ? null : Number(node.finished_at),
        durationMs: node.started_at && node.finished_at ? Number(node.finished_at) - Number(node.started_at) : null,
        input: parse(node.input, null), output: parse(node.output, null), error: node.error || null,
      })),
      resumeUrl: (() => { const waiting = parse(row.waiting, null); return waiting?.kind === "webhook" && waiting.token ? `${publicBaseUrl(req)}/api/hooks/resume/${waiting.token}` : null; })(),
    });
  }));

  router.post("/workflows/executions/:id/cancel", withAccount(async (req, res, _db, account) => res.json(await runtime.cancel(account.id, String(req.params.id)))));

  router.post("/workflows/executions/:id/resume", json, withAccount(async (req, res, _db, account) => {
    const result = await runtime.resume(account.id, String(req.params.id), { approved: req.body?.approved === true, nodeId: req.body?.nodeId });
    await drive(String(req.params.id));
    res.json(result);
  }));

  router.post("/workflows/executions/:id/retry", json, withAccount(async (req, res, db, account) => {
    const { rows: [row] } = await db.query("SELECT * FROM hannah_workflow_executions WHERE id = $1 AND user_id = $2", [String(req.params.id), account.id]);
    if (!row) throw fail(404, "That run doesn't exist.", "not-found");
    if (!FINAL.has(row.status) || row.status === "completed" && req.body?.from !== "start") throw fail(409, row.status === "completed" ? "This run completed; use “Run again” to start from the beginning." : "This run hasn't finished yet.", "not-final");
    let state = null;
    if (req.body?.from !== "start") {
      // From the failed step: keep finished nodes upstream of the failure, drop the failure and everything after it.
      const definition = parse(row.definition, {});
      const previous = parse(row.state, { nodes: {} });
      const downstream = new Set([row.error_node].filter(Boolean));
      let grew = true;
      while (grew) {
        grew = false;
        for (const connection of definition.connections || []) if (downstream.has(connection.source) && !downstream.has(connection.target)) { downstream.add(connection.target); grew = true; }
      }
      state = { nodes: Object.fromEntries(Object.entries(previous.nodes || {}).filter(([id, node]) => !downstream.has(id) && node.status === "done")) };
    }
    const queued = await runtime.enqueue({ userId: account.id, workflowId: row.workflow_id, definition: parse(row.definition, {}), version: row.workflow_version === null ? null : Number(row.workflow_version), mode: "retry", triggerNodeId: row.trigger_node_id, triggerData: parse(row.trigger_data, null), retryOf: row.id, state });
    await drive(queued.id);
    res.status(202).json({ executionId: queued.id });
  }));

  // ----- credentials -----
  router.get("/workflows/credentials", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT id, name, type, hint, created_at, updated_at FROM hannah_workflow_credentials WHERE user_id = $1 ORDER BY name", [account.id]);
    res.json({ vault: vaultConfigured(), credentials: rows.map((row) => ({ id: row.id, name: row.name, type: row.type, typeLabel: CREDENTIAL_TYPES[row.type]?.label || row.type, hint: row.hint, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) })) });
  }));

  function readCredential(body) {
    const type = String(body?.type || "");
    const spec = CREDENTIAL_TYPES[type];
    if (!spec) throw fail(400, "Unknown credential type.", "bad-request");
    const data = {};
    for (const field of spec.fields) {
      const value = body?.data?.[field.name];
      if (field.type === "keyValue") {
        data[field.name] = (Array.isArray(value) ? value : []).slice(0, 20).map((entry) => ({ name: clean(entry?.name, 100), value: String(entry?.value ?? "").slice(0, 4000) })).filter((entry) => entry.name);
        if (!data[field.name].length) throw fail(400, `${field.label}: add at least one.`, "bad-request");
      } else {
        const text = String(value ?? "").trim();
        if (!text && !(field.name === "headerName")) throw fail(400, `${field.label} is required.`, "bad-request");
        if (text.length > 8000) throw fail(400, `${field.label} is too long.`, "bad-request");
        data[field.name] = text;
      }
    }
    if ((type === "slackWebhook" && !/^https:\/\/hooks\.slack\.com\//.test(data.url)) || (type === "discordWebhook" && !/^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\//.test(data.url))) throw fail(400, "That webhook URL doesn't belong to the service.", "bad-request");
    if (type === "postgres" && !/^postgres(?:ql)?:\/\//.test(data.connectionString)) throw fail(400, "The connection string must start with postgres://.", "bad-request");
    const firstSecret = spec.fields.find((field) => field.secret && typeof data[field.name] === "string");
    return { type, data, hint: firstSecret ? secretHint(data[firstSecret.name]) : `${(data.headers || []).length} header${(data.headers || []).length === 1 ? "" : "s"}` };
  }

  router.post("/workflows/credentials", json, withAccount(async (req, res, db, account) => {
    if (!vaultConfigured()) throw fail(503, "Saving credentials needs the server's vault key (HANNAH_VAULT_KEY).", "vault-required");
    const { rows: [count] } = await db.query("SELECT COUNT(*) AS n FROM hannah_workflow_credentials WHERE user_id = $1", [account.id]);
    if (Number(count.n) >= 100) throw fail(400, "You can save up to 100 credentials.", "limit");
    const name = clean(req.body?.name, 80);
    if (!name) throw fail(400, "Give the credential a name.", "bad-request");
    const { type, data, hint } = readCredential(req.body);
    const id = newId("cred");
    const sealed = encryptSecret(JSON.stringify(data), { userId: account.id, providerId: `wfcred:${id}` });
    const at = Date.now();
    await db.query("INSERT INTO hannah_workflow_credentials (user_id, id, name, type, key_id, wrapped_key, ciphertext, hint, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)", [account.id, id, name, type, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, hint, at]);
    await db.query("INSERT INTO hannah_audit (user_id, event, detail, created_at) VALUES ($1, $2, $3, $4)", [account.id, "workflow.credential.created", JSON.stringify({ id, type }), at]).catch(() => {});
    res.status(201).json({ credential: { id, name, type, typeLabel: CREDENTIAL_TYPES[type].label, hint, createdAt: at, updatedAt: at } });
  }));

  router.put("/workflows/credentials/:id", json, withAccount(async (req, res, db, account) => {
    if (!vaultConfigured()) throw fail(503, "Saving credentials needs the server's vault key (HANNAH_VAULT_KEY).", "vault-required");
    const id = String(req.params.id);
    const { rows: [row] } = await db.query("SELECT type FROM hannah_workflow_credentials WHERE user_id = $1 AND id = $2", [account.id, id]);
    if (!row) throw fail(404, "That credential doesn't exist.", "not-found");
    const { type, data, hint } = readCredential({ ...req.body, type: row.type });
    const sealed = encryptSecret(JSON.stringify(data), { userId: account.id, providerId: `wfcred:${id}` });
    await db.query("UPDATE hannah_workflow_credentials SET name = COALESCE($1, name), key_id = $2, wrapped_key = $3, ciphertext = $4, hint = $5, updated_at = $6 WHERE user_id = $7 AND id = $8", [clean(req.body?.name, 80) || null, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, hint, Date.now(), account.id, id]);
    res.json({ credential: { id, type, hint } });
  }));

  router.delete("/workflows/credentials/:id", withAccount(async (req, res, db, account) => {
    await db.query("DELETE FROM hannah_workflow_credentials WHERE user_id = $1 AND id = $2", [account.id, String(req.params.id)]);
    res.json({ ok: true });
  }));

  // ----- events and notifications -----
  router.post("/workflows/events", json, withAccount(async (req, res, _db, account) => {
    const name = String(req.body?.name || "");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw fail(400, "An event name is 1–64 lowercase letters, digits, dots, dashes or underscores.", "bad-request");
    const data = req.body?.data ?? {};
    if (JSON.stringify(data).length > 100_000) throw fail(413, "Event data can be up to 100 KB.", "too-large");
    res.status(202).json({ started: await runtime.emitEvent(account.id, `custom:${name}`, data) });
  }));

  router.get("/notifications", withAccount(async (req, res, db, account) => {
    const since = Number(req.query.since) || 0;
    const { rows } = await db.query("SELECT id, title, body, source, created_at, read_at FROM hannah_notifications WHERE user_id = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 50", [account.id, since]);
    res.json({ notifications: rows.map((row) => ({ id: row.id, title: row.title, body: row.body, source: row.source, createdAt: Number(row.created_at), read: row.read_at !== null })) });
  }));

  router.post("/notifications/:id/read", withAccount(async (req, res, db, account) => {
    await db.query("UPDATE hannah_notifications SET read_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, String(req.params.id)]);
    res.json({ ok: true });
  }));

  // ----- one workflow -----
  router.get("/workflows/:id", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const draft = parse(row.draft, starterDefinition());
    const published = row.published_version ? parse((await db.query("SELECT definition FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2 AND version = $3", [account.id, row.id, row.published_version])).rows[0]?.definition, null) : null;
    const owned = await credentialTypes(db, account.id);
    const manifest = published ? engine.permissionManifest(published) : null;
    res.json({
      workflow: publicWorkflow(row),
      definition: draft,
      published,
      validation: engine.validateWorkflow(draft, { credentials: owned }),
      permissions: engine.permissionManifest(draft),
      publishedPermissions: manifest,
      approvedCurrent: Boolean(manifest && row.approved_manifest === manifestHash(manifest)),
      webhooks: await webhooksFor(db, account.id, row.id, req),
      unpublishedChanges: !published || JSON.stringify(published) !== JSON.stringify(draft),
    });
  }));

  router.put("/workflows/:id", json, withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const baseVersion = Number(req.body?.baseVersion);
    if (!Number.isInteger(baseVersion)) throw fail(400, "baseVersion is the draft version you started from.", "bad-request");
    const definition = req.body?.definition ? checkDefinition(req.body.definition) : parse(row.draft, starterDefinition());
    const name = req.body?.name !== undefined ? clean(req.body.name, 120) || row.name : row.name;
    const description = req.body?.description !== undefined ? clean(req.body.description, 1000) : row.description;
    const at = Date.now();
    const { rowCount } = await db.query("UPDATE hannah_workflows SET name = $1, description = $2, draft = $3, draft_version = draft_version + 1, updated_at = $4 WHERE user_id = $5 AND id = $6 AND draft_version = $7", [name, description, JSON.stringify(definition), at, account.id, row.id, baseVersion]);
    if (rowCount !== 1) throw fail(409, "This workflow changed in another window. Reload it to see the newer version.", "conflict", { version: Number(row.draft_version) });
    const owned = await credentialTypes(db, account.id);
    res.json({ workflow: publicWorkflow({ ...row, name, description, draft_version: baseVersion + 1, updated_at: at }), validation: engine.validateWorkflow(definition, { credentials: owned }), permissions: engine.permissionManifest(definition) });
  }));

  router.delete("/workflows/:id", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    await db.query("DELETE FROM hannah_workflow_triggers WHERE user_id = $1 AND workflow_id = $2", [account.id, row.id]);
    await db.query("DELETE FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2", [account.id, row.id]);
    await db.query("UPDATE hannah_workflow_executions SET cancel_requested = 1 WHERE user_id = $1 AND workflow_id = $2 AND status IN ('running', 'queued', 'waiting', 'waiting-approval')", [account.id, row.id]);
    await db.query("UPDATE hannah_workflow_executions SET status = 'cancelled', error = 'The workflow was deleted.', finished_at = $1, updated_at = $1 WHERE user_id = $2 AND workflow_id = $3 AND status IN ('queued', 'waiting', 'waiting-approval')", [Date.now(), account.id, row.id]);
    await db.query("DELETE FROM hannah_workflows WHERE user_id = $1 AND id = $2", [account.id, row.id]);
    res.json({ ok: true });
  }));

  router.post("/workflows/:id/validate", json, withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const definition = req.body?.definition ? checkDefinition(req.body.definition) : parse(row.draft, {});
    res.json({ validation: engine.validateWorkflow(definition, { credentials: await credentialTypes(db, account.id) }), permissions: engine.permissionManifest(definition) });
  }));

  router.post("/workflows/:id/publish", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const definition = parse(row.draft, {});
    const validation = engine.validateWorkflow(definition, { credentials: await credentialTypes(db, account.id) });
    if (validation.errors.length) throw fail(422, `Fix ${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"} before publishing.`, "invalid", { validation });
    const { rows: [latest] } = await db.query("SELECT MAX(version) AS v FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2", [account.id, row.id]);
    const version = (Number(latest?.v) || 0) + 1;
    const at = Date.now();
    await db.query("INSERT INTO hannah_workflow_versions (user_id, workflow_id, version, definition, created_at) VALUES ($1, $2, $3, $4, $5)", [account.id, row.id, version, JSON.stringify(definition), at]);
    const manifest = engine.permissionManifest(definition);
    // Publishing new permissions while active needs a fresh approval: the workflow pauses until you review them.
    const stillApproved = row.approved_manifest === manifestHash(manifest);
    const active = Number(row.active) && stillApproved ? 1 : 0;
    await db.query("UPDATE hannah_workflows SET published_version = $1, active = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [version, active, at, account.id, row.id]);
    const secrets = await runtime.syncTriggers(account.id, row.id, definition, Boolean(active));
    res.json({ version, active: Boolean(active), needsActivation: Boolean(Number(row.active)) && !stillApproved, permissions: manifest, webhookSecrets: secrets, validation });
  }));

  router.post("/workflows/:id/activate", json, withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    if (!row.published_version) throw fail(409, "Publish the workflow before activating it.", "not-published");
    const published = await (async () => parse((await db.query("SELECT definition FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2 AND version = $3", [account.id, row.id, row.published_version])).rows[0]?.definition, null))();
    const validation = engine.validateWorkflow(published, { credentials: await credentialTypes(db, account.id) });
    if (validation.errors.length) throw fail(422, "The published version has problems; fix and publish again.", "invalid", { validation });
    const manifest = engine.permissionManifest(published);
    // Consent: the client sends back exactly the permissions the user reviewed.
    if (manifestHash(Array.isArray(req.body?.approvedPermissions) ? req.body.approvedPermissions : []) !== manifestHash(manifest)) throw fail(409, "Review what this workflow may do, then activate it.", "approve-permissions", { permissions: manifest });
    const triggers = published.nodes.filter((node) => !node.disabled && ["trigger.schedule", "trigger.webhook", "trigger.event"].includes(node.type));
    if (!triggers.length) throw fail(409, "This workflow only has a manual trigger, so there's nothing to activate. Run it with Run.", "manual-only");
    const at = Date.now();
    await db.query("UPDATE hannah_workflows SET active = 1, approved_manifest = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [manifestHash(manifest), at, account.id, row.id]);
    const secrets = await runtime.syncTriggers(account.id, row.id, published, true);
    await db.query("INSERT INTO hannah_audit (user_id, event, detail, created_at) VALUES ($1, $2, $3, $4)", [account.id, "workflow.activated", JSON.stringify({ id: row.id, version: Number(row.published_version), permissions: manifest.map((entry) => entry.permission) }), at]).catch(() => {});
    res.json({ active: true, webhookSecrets: secrets, webhooks: await webhooksFor(db, account.id, row.id, req) });
  }));

  router.post("/workflows/:id/deactivate", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    await db.query("UPDATE hannah_workflows SET active = 0, updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, row.id]);
    await db.query("UPDATE hannah_workflow_triggers SET enabled = 0, next_run_at = NULL WHERE user_id = $1 AND workflow_id = $2", [account.id, row.id]);
    res.json({ active: false });
  }));

  router.post("/workflows/:id/run", json, withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const useDraft = req.body?.draft !== false;
    const definition = useDraft ? parse(row.draft, {}) : await (async () => {
      if (!row.published_version) throw fail(409, "Publish the workflow first, or run the draft.", "not-published");
      return parse((await db.query("SELECT definition FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2 AND version = $3", [account.id, row.id, row.published_version])).rows[0]?.definition, {});
    })();
    const validation = engine.validateWorkflow(definition, { credentials: await credentialTypes(db, account.id) });
    if (validation.errors.length) throw fail(422, `Fix ${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"} before running.`, "invalid", { validation });
    const triggers = definition.nodes.filter((node) => !node.disabled && REGISTRY.get(node.type)?.category === "trigger");
    const trigger = triggers.find((node) => node.id === req.body?.triggerNodeId) || triggers.find((node) => node.type === "trigger.manual") || triggers[0];
    const triggerData = req.body?.triggerData && typeof req.body.triggerData === "object" ? req.body.triggerData : null;
    if (triggerData && JSON.stringify(triggerData).length > 200_000) throw fail(413, "Test data can be up to 200 KB.", "too-large");
    const queued = await runtime.enqueue({ userId: account.id, workflowId: row.id, definition, version: useDraft ? null : Number(row.published_version), mode: useDraft ? "test" : "manual", triggerNodeId: trigger.id, triggerData });
    await drive(queued.id);
    res.status(202).json({ executionId: queued.id });
  }));

  router.post("/workflows/:id/test-node", json, withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const definition = req.body?.definition ? checkDefinition(req.body.definition) : parse(row.draft, {});
    const node = definition.nodes.find((item) => item.id === req.body?.nodeId);
    if (!node) throw fail(404, "That step isn't in the workflow.", "not-found");
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50).map((item) => ({ json: item && typeof item === "object" && !Array.isArray(item) ? item : { value: item } })) : [{ json: {} }];
    const result = await engine.executeSingleNode({ node, items, workflow: { id: row.id, name: row.name, timezone: definition.settings?.timezone || "UTC" }, services: runtime.servicesFor(account.id, { workflowId: row.id }) });
    res.json({
      status: result.status, error: result.error || null,
      output: result.outputs ? Object.fromEntries(Object.entries(result.outputs).map(([port, list]) => [port, { count: list.length, items: engine.sanitize(list.slice(0, 20).map((item) => item.json)) }])) : null,
      waiting: result.waiting ? { kind: result.waiting.kind, message: result.waiting.message || null } : null,
    });
  }));

  router.get("/workflows/:id/versions", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const { rows } = await db.query("SELECT version, created_at FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2 ORDER BY version DESC LIMIT 50", [account.id, row.id]);
    res.json({ versions: rows.map((version) => ({ version: Number(version.version), createdAt: Number(version.created_at), published: Number(version.version) === Number(row.published_version) })) });
  }));

  router.post("/workflows/:id/versions/:version/restore", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const { rows: [version] } = await db.query("SELECT definition FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2 AND version = $3", [account.id, row.id, Number(req.params.version)]);
    if (!version) throw fail(404, "That version doesn't exist.", "not-found");
    await db.query("UPDATE hannah_workflows SET draft = $1, draft_version = draft_version + 1, updated_at = $2 WHERE user_id = $3 AND id = $4", [version.definition, Date.now(), account.id, row.id]);
    res.json({ definition: parse(version.definition, {}), draftVersion: Number(row.draft_version) + 1 });
  }));

  router.post("/workflows/:id/webhooks/:nodeId/rotate", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const { rows: [trigger] } = await db.query("SELECT id FROM hannah_workflow_triggers WHERE user_id = $1 AND workflow_id = $2 AND node_id = $3 AND kind = 'webhook'", [account.id, row.id, String(req.params.nodeId)]);
    if (!trigger) throw fail(404, "Publish the workflow to create this webhook first.", "not-found");
    res.json(await runtime.rotateWebhookSecret(account.id, trigger.id, String(req.params.nodeId)));
  }));

  router.get("/workflows/:id/export", withAccount(async (req, res, db, account) => {
    const row = await loadWorkflow(db, account.id, String(req.params.id));
    const definition = parse(row.draft, {});
    res.json({ format: engine.FORMAT, version: engine.VERSION, name: row.name, description: row.description || "", exportedAt: new Date().toISOString(), definition, note: "Credentials aren't included: after importing, choose credentials for the steps that need them." });
  }));

  return router;
}

/** Public webhook receiver. Mounted with a raw body parser, so signatures cover the exact bytes. */
function createHookRouter({ runtime }) {
  const router = express.Router();
  const raw = express.raw({ type: () => true, limit: "1mb" });
  const hits = new Map();
  const limited = (key, limit = 60) => {
    const now = Date.now();
    const bucket = hits.get(key);
    if (!bucket || now - bucket.start > 60_000) { hits.set(key, { start: now, count: 1 }); if (hits.size > 10_000) hits.clear(); return false; }
    bucket.count += 1;
    return bucket.count > limit;
  };
  const SAFE_HEADERS = /^(content-type|user-agent|x-github-event|x-github-delivery|x-gitlab-event|x-hannah-delivery|x-request-id|x-event-type|stripe-signature-version)$/i;

  function readBody(req) {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const text = buffer.toString("utf8");
    const type = String(req.get("content-type") || "");
    if (!text) return { buffer, body: null };
    if (type.includes("json")) {
      try { return { buffer, body: JSON.parse(text) }; } catch { throw fail(400, "The body isn't valid JSON.", "bad-request"); }
    }
    if (type.includes("x-www-form-urlencoded")) return { buffer, body: Object.fromEntries(new URLSearchParams(text)) };
    return { buffer, body: text.slice(0, 200_000) };
  }

  router.post("/hooks/resume/:token", raw, async (req, res) => {
    try {
      if (!databaseConfigured() || limited(`resume:${req.ip}`, 30)) return res.status(429).json({ error: "Too many requests." });
      const db = await getDatabase();
      const tokenHash = sha256(String(req.params.token));
      const { rows } = await db.query("SELECT id, user_id, waiting FROM hannah_workflow_executions WHERE status = 'waiting' AND wait_until > $1 ORDER BY updated_at DESC LIMIT 500", [Date.now()]);
      const row = rows.find((candidate) => { const waiting = parse(candidate.waiting, {}); return waiting.kind === "webhook" && waiting.tokenHash && crypto.timingSafeEqual(Buffer.from(waiting.tokenHash), Buffer.from(tokenHash)); });
      if (!row) return res.status(404).json({ error: "This resume URL isn't valid any more." });
      const { body } = readBody(req);
      await runtime.resume(row.user_id, row.id, { data: { body, receivedAt: new Date().toISOString() } });
      if (SERVERLESS) await runtime.tick({ budgetMs: 20_000, only: row.id }).catch(() => {});
      res.status(202).json({ executionId: row.id, resumed: true });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : "The webhook couldn't be processed." });
    }
  });

  router.all("/hooks/:triggerId", raw, async (req, res) => {
    try {
      const triggerId = String(req.params.triggerId);
      if (!/^wh_[A-Za-z0-9_-]{8,40}$/.test(triggerId) || !databaseConfigured()) return res.status(404).json({ error: "Not found." });
      if (limited(`hook:${triggerId}`, 60) || limited(`ip:${req.ip}`, 120)) { res.setHeader("Retry-After", "60"); return res.status(429).json({ error: "Too many requests for this webhook. Try again in a minute." }); }
      const db = await getDatabase();
      const { rows: [trigger] } = await db.query("SELECT * FROM hannah_workflow_triggers WHERE id = $1 AND kind = 'webhook'", [triggerId]);
      if (!trigger || !Number(trigger.enabled)) return res.status(404).json({ error: "Not found, or the workflow isn't active." });
      const config = parse(trigger.config, {});
      const params = config.params || {};
      if (req.method !== (params.method || "POST")) return res.status(405).json({ error: `This webhook accepts ${params.method || "POST"}.` });
      const { buffer, body } = readBody(req);

      let deliveryId = clean(req.get("x-hannah-delivery") || req.get("x-github-delivery"), 120) || null;
      if (params.auth === "hmac") {
        if (!trigger.secret_ciphertext) return res.status(503).json({ error: "HMAC signing needs the server's vault key; use token authentication or ask the operator." });
        const timestamp = Number(req.get("x-hannah-timestamp"));
        const signature = String(req.get("x-hannah-signature") || "").replace(/^sha256=/, "");
        if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return res.status(401).json({ error: "X-Hannah-Timestamp is missing or more than 5 minutes off." });
        const secret = decryptSecret({ key_id: trigger.secret_key_id, wrapped_key: trigger.secret_wrapped, ciphertext: trigger.secret_ciphertext }, { userId: trigger.user_id, providerId: `wfhook:${trigger.id}` }).secret;
        const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(buffer).digest("hex");
        if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return res.status(401).json({ error: "The signature doesn't match." });
        deliveryId = deliveryId || `sig:${expected}`;
      } else {
        const given = String(req.get("x-hannah-token") || req.query.token || "");
        const hash = sha256(given);
        if (!given || !trigger.secret_hash || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(trigger.secret_hash))) return res.status(401).json({ error: "Send the webhook's secret in the X-Hannah-Token header." });
      }
      if (deliveryId) {
        try {
          await db.query("INSERT INTO hannah_workflow_deliveries (trigger_id, delivery_id, received_at) VALUES ($1, $2, $3)", [trigger.id, deliveryId, Date.now()]);
        } catch {
          return res.status(200).json({ duplicate: true, message: "This delivery was already received." });
        }
        await db.query("DELETE FROM hannah_workflow_deliveries WHERE trigger_id = $1 AND received_at < $2", [trigger.id, Date.now() - 7 * 86_400_000]).catch(() => {});
      }
      const workflow = await runtime.publishedDefinition(trigger.user_id, trigger.workflow_id);
      if (!workflow) return res.status(404).json({ error: "The workflow isn't active." });
      const query = Object.fromEntries(Object.entries(req.query || {}).filter(([key]) => key !== "token").map(([key, value]) => [key, String(value).slice(0, 1000)]));
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => SAFE_HEADERS.test(key)).map(([key, value]) => [key, String(value).slice(0, 300)]));
      const queued = await runtime.enqueue({
        userId: trigger.user_id, workflowId: trigger.workflow_id, definition: workflow.definition, version: workflow.version, mode: "webhook", triggerNodeId: trigger.node_id,
        triggerData: { body, query, headers, method: req.method, receivedAt: new Date().toISOString() },
        idempotencyKey: deliveryId ? `hook:${trigger.id}:${deliveryId}` : null,
      });
      if (SERVERLESS && !queued.duplicate) await runtime.tick({ budgetMs: 15_000, only: queued.id }).catch(() => {});
      res.status(202).json({ executionId: queued.id, ...(queued.duplicate ? { duplicate: true } : {}) });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : "The webhook couldn't be processed." });
    }
  });

  return router;
}

// ----- natural language → workflow draft -----

async function draftFromText(services, description, timezone) {
  const { nodes } = catalog();
  const available = nodes.filter((node) => node.status !== "upcoming").map((node) => `${node.type}: ${node.label} — ${node.description} Params: ${node.params.map((param) => `${param.name}${param.options ? ` (${param.options.map((option) => option.value).join("|")})` : ""}`).join(", ") || "none"}. Outputs: ${node.dynamicOutputs ? "dynamic" : node.outputs.join(", ")}.`).join("\n");
  const system = [
    "You design automations for HANNAH's workflow engine. Reply with one JSON object and nothing else:",
    '{"name": string, "notes": string, "nodes": [{"id": string, "name": string, "type": string, "params": object}], "connections": [{"source": id, "target": id, "sourceOutput": string, "targetInput": string}]}',
    "Rules: exactly one trigger first. Use only the node types listed. Node names are unique and short. Read data from earlier steps with expressions like {{ $json.field }} or {{ $node[\"Step name\"].json.field }}.",
    "Prefer email mode \"draft\" over \"send\". Never put credentials or secrets in params; steps that need a credential leave it unset. In notes, say in one or two sentences what the user must still set up (credentials, connected accounts).",
    "The description is the user's request: build what it asks, nothing more.",
  ].join(" ");
  const result = await services.ai({ model: "auto", json: true, temperature: 0.2, maxTokens: 2500, system, prompt: `Available nodes:\n${available}\n\nTime zone: ${timezone || "UTC"}\n\nDescription:\n"""${description}"""` });
  let draft;
  try {
    draft = JSON.parse(String(result.text).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw fail(502, "The AI didn't return a workflow. Try describing it differently, or build it in the editor.", "ai-invalid");
  }
  const allowed = new Set(nodes.filter((node) => node.status !== "upcoming").map((node) => node.type));
  const list = (Array.isArray(draft.nodes) ? draft.nodes : []).filter((node) => allowed.has(node?.type)).slice(0, 30);
  if (!list.length) throw fail(502, "The AI's workflow used no supported steps. Try again or build it in the editor.", "ai-invalid");
  list.forEach((node, index) => {
    node.id = /^[A-Za-z0-9_-]{1,64}$/.test(String(node.id)) ? node.id : `n${index + 1}`;
    node.position = { x: 80 + index * 280, y: 160 + (index % 2) * 40 };
    delete node.credentialId;
  });
  const ids = new Set(list.map((node) => node.id));
  return {
    name: clean(draft.name, 120) || "New automation",
    notes: clean(draft.notes, 600),
    definition: {
      format: engine.FORMAT, version: engine.VERSION, nodes: list,
      connections: (Array.isArray(draft.connections) ? draft.connections : []).filter((connection) => ids.has(connection?.source) && ids.has(connection?.target)),
      settings: { timezone: timezone || "UTC" },
    },
  };
}

module.exports = { createHookRouter, createWorkflowRouter, draftFromText };
