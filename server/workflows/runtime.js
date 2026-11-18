"use strict";

/**
 * Workflow runtime: the durable queue, the worker, the scheduler and the
 * services nodes use, on top of the account database.
 *
 * Queue. An execution row is the job. Workers claim a queued row with a
 * conditional update (status queued → running, with a lease), so two workers
 * never run the same execution. A running worker renews its lease every 15
 * seconds and checks for a cancel request at the same time.
 *
 * Recovery. A row whose lease ran out (the worker crashed or the serverless
 * function was frozen) goes back to the queue and continues from its last
 * checkpoint. After 3 such restarts it's dead-lettered: marked failed with the
 * reason, never retried silently.
 *
 * Where it runs. A long-running server (self-hosted, desktop dev) runs the
 * worker loop every few seconds. On serverless hosting (Vercel) there's no
 * background process: the cron endpoint (/api/workflows/tick, authenticated by
 * CRON_SECRET) drives schedules and the queue, a webhook runs its execution in
 * the request before answering, and an open execution page drives its own
 * execution while you watch.
 *
 * Limits per user: concurrent executions, executions per day, and the engine's
 * own node and workflow time limits.
 */
const crypto = require("node:crypto");
const { getDatabase } = require("../db");
const { encryptSecret, decryptSecret, vaultConfigured } = require("../vault");
const { loadAccountKeys, accountsUseServerKeys } = require("../accounts");
const { getProvider, listProviders, providerKey, defaultModelFor } = require("../providers/catalog");
const { requestWithProviderFallback } = require("../providers/runtime");
const { addressBlocked } = require("./http");
const engine = require("./engine");
const { REGISTRY, looksSecret } = require("./nodes");
const { tokens: memoryTokens } = require("./text");

// A running execution's lease; a worker that disappears loses it after this long and the run is recovered.
// WORKFLOW_LEASE_MS can shorten it (at least 5 seconds), for example in restart tests.
const LEASE_MS = Math.max(5_000, Number(process.env.WORKFLOW_LEASE_MS) || 60_000);
const HEARTBEAT_MS = Math.round(LEASE_MS / 4);
const MAX_RECOVERIES = 3;
const USER_CONCURRENCY = Math.max(1, Number(process.env.WORKFLOW_USER_CONCURRENCY) || 3);
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKFLOW_WORKER_CONCURRENCY) || 4);
const DAILY_EXECUTIONS = Math.max(10, Number(process.env.WORKFLOW_DAILY_EXECUTIONS) || 500);
const KEEP_EXECUTIONS_MS = 30 * 86_400_000;
// Serverless requests should end quickly, so rate-limit waits there park the run sooner (see engine.execute).
const INLINE_WAIT_MS = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? 5_000 : 20_000;
const AUTO_ORDER = ["groq", "openai", "anthropic", "gemini", "openrouter", "mistral", "deepseek", "together", "cerebras", "xai", "fireworks"];

const workerId = `w-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const parse = (text, fallback = null) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });

const FINAL = new Set(["completed", "failed", "cancelled", "timed-out"]);

/**
 * A provider's error as something a person can act on. Rate limits keep the
 * provider's Retry-After (as `retryAfterMs`) and are marked `rateLimited`;
 * rejected keys and over-size requests are permanent (retrying won't help).
 * Exported for tests.
 */
function explainProviderError(error, provider) {
  const status = Number(error?.status) || 0;
  const label = provider?.label || "The AI provider";
  if (status === 429) {
    const seconds = Number(error.retryAfter);
    return Object.assign(new Error(`${label} is rate-limiting your key right now (too many requests or tokens per minute).`), {
      status, rateLimited: true, retryable: true, provider: label, ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.min(300, seconds) * 1000 } : {}),
    });
  }
  if (status === 401 || status === 403) return Object.assign(new Error(`${label} rejected the API key saved in your account. Check it in Settings → Account → Provider keys.`), { status, retryable: false, provider: label });
  if (status === 413) return Object.assign(new Error(`This step sends ${label} more text than your plan accepts in one request. Send less (use Limit, Map fields or a shorter prompt) or choose a model with a bigger limit.`), { status, retryable: false, provider: label });
  if (status >= 500) return Object.assign(new Error(`${label} had a problem on its side (HTTP ${status}).`), { status, retryable: true, provider: label });
  return error;
}

function createRuntime({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), db: injectedDb, emit = async () => {}, connections = require("../connections") } = {}) {
  const database = async () => injectedDb || getDatabase();
  const running = new Map(); // execution id → AbortController, in this process

  // ---------- services for one user ----------

  function servicesFor(userId, { executionId, workflowId } = {}) {
    let keysPromise;
    const keys = () => (keysPromise ??= database().then((db) => loadAccountKeys(db, userId)));

    /** The providers to try, in order: the chosen one, or (Auto) every provider with a key. */
    async function pickProviders(modelChoice) {
      const userKeys = await keys();
      const keyFor = (provider) => userKeys.get(provider.id) || (accountsUseServerKeys() ? providerKey(provider) : "");
      const choice = String(modelChoice || "auto");
      if (choice !== "auto") {
        const [providerId, ...rest] = choice.split(":");
        const provider = getProvider(providerId);
        if (!provider) throw fail(400, `Unknown AI provider “${providerId}”.`, "bad-model", { retryable: false });
        const apiKey = keyFor(provider);
        if (!apiKey && !provider.local) throw fail(400, `No ${provider.label} key is saved in your account. Add it in Settings → Account, or choose Auto.`, "no-key", { retryable: false });
        return [{ provider, apiKey, model: rest.join(":") || defaultModelFor(provider) }];
      }
      const known = new Set(listProviders().map((item) => item.id));
      const chosen = [];
      for (const id of new Set([...AUTO_ORDER, ...userKeys.keys()])) {
        if (!known.has(id)) continue;
        const provider = getProvider(id);
        const apiKey = provider && keyFor(provider);
        if (apiKey) chosen.push({ provider, apiKey, model: defaultModelFor(provider) });
      }
      if (!chosen.length) throw fail(400, "No AI provider key is saved in your account, so AI steps can't run on the server. Save your Groq key (free) in Settings → Account → Provider keys.", "no-key", { retryable: false });
      return chosen;
    }

    return {
      /**
       * One AI answer. In Auto, a provider that is rate-limiting or failing
       * hands over to the next provider with a key. Provider errors become
       * messages that say what happened; a rate limit carries `rateLimited`
       * and `retryAfterMs`, so the engine waits and tries again instead of
       * failing the run.
       */
      async ai({ model, system, prompt, temperature = 0.3, json = false, maxTokens = 1200 }) {
        const candidates = await pickProviders(model);
        let busy = null;
        let lastError = null;
        for (const { provider, apiKey, model: chosen } of candidates) {
          try {
            const message = await requestWithProviderFallback({
              provider, apiKey, requestedModel: chosen, singleModel: model !== "auto",
              messages: [{ role: "user", content: String(prompt).slice(0, 60_000) }],
              tools: [], systemPrompt: `${system || ""}${json ? " Respond with JSON only." : ""}`.trim(),
              timeoutMs: 60_000, maxTokens, temperature,
            });
            const text = typeof message?.content === "string" ? message.content : "";
            if (!text.trim()) throw Object.assign(new Error(`${provider.label} returned an empty answer.`), { retryable: true });
            return { text, provider: provider.label, model: message.model || chosen, usage: message.usage || null };
          } catch (error) {
            lastError = explainProviderError(error, provider);
            if (lastError.rateLimited && (!busy || (lastError.retryAfterMs ?? Infinity) < (busy.retryAfterMs ?? Infinity))) busy = lastError;
          }
        }
        // Every provider failed. If any was only busy, say so: the engine waits for it and tries again.
        throw busy || lastError;
      },

      async notify({ title, body }) {
        const db = await database();
        const id = newId("n");
        await db.query("INSERT INTO hannah_notifications (user_id, id, title, body, source, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [userId, id, title, body, workflowId ? `workflow:${workflowId}` : "workflow", now()]);
        await db.query("DELETE FROM hannah_notifications WHERE user_id = $1 AND created_at < $2", [userId, now() - KEEP_EXECUTIONS_MS]);
        await emit(userId, "workflow.notification", { title, body, workflowId, executionId });
        return { id };
      },

      async mail({ mode, provider, to, subject, body, query, max, ...extra }) {
        const db = await database();
        const providerId = provider === "google" || provider === "microsoft" ? provider : await connectedProvider(db, userId);
        const token = await connections.accessTokenFor(db, userId, providerId, { fetchImpl, now });
        if (mode === "search") return { messages: await connections.searchMail(fetchImpl, providerId, token, { query: query || "", max: max || 10 }) };
        if (mode === "needs-reply" || mode === "reply-draft") {
          const { rows } = await db.query("SELECT account_email FROM hannah_connections WHERE user_id = $1 AND provider = $2", [userId, providerId]);
          const me = rows[0]?.account_email || "";
          const comms = require("../communications");
          if (mode === "needs-reply") return { messages: await comms.needsReply(fetchImpl, providerId, token, { days: extra.days, max: max || 15, me }) };
          return comms.replyDraft(fetchImpl, providerId, token, { id: String(extra.id || ""), body, replyAll: extra.replyAll === true, me });
        }
        const message = { to: connections.recipients(to), cc: [], subject: String(subject).slice(0, 300), body: String(body).slice(0, 100_000) };
        return mode === "send" ? connections.sendMail(fetchImpl, providerId, token, message) : connections.saveDraft(fetchImpl, providerId, token, message);
      },

      /** Queue a job for the user's desktop app; idempotent per execution and step. */
      async createDeviceJob({ nodeId, kind, input, expiresAt }) {
        if (!executionId) throw fail(400, "Desktop steps need a whole workflow run.", "bad-request", { retryable: false });
        const db = await database();
        const id = `dj_${sha256(`${executionId}:${nodeId}`).slice(0, 32)}`;
        const at = now();
        const { rows } = await db.query("SELECT id, expires_at FROM hannah_workflow_device_jobs WHERE id = $1 AND user_id = $2", [id, userId]);
        if (rows[0]) {
          // A retry of the run: start the job again for this attempt.
          await db.query("UPDATE hannah_workflow_device_jobs SET input = $1, status = 'pending', device_id = NULL, device_name = NULL, claimed_at = NULL, result = NULL, error = NULL, updated_at = $2, expires_at = $3 WHERE id = $4", [JSON.stringify(input), at, expiresAt, id]);
        } else {
          await db.query("INSERT INTO hannah_workflow_device_jobs (id, user_id, workflow_id, execution_id, node_id, kind, input, status, created_at, updated_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8, $9)", [id, userId, workflowId, executionId, nodeId, kind, JSON.stringify(input), at, expiresAt]);
        }
        return { id, expiresAt };
      },

      /** The account's paired phones and whether each is online now (the Phone Bridge's own view). */
      async phones() {
        const db = await database();
        return require("../phone-bridge").listPhones(db, userId, now());
      },

      /** A request for the user's paired phone, through the Phone Bridge's own checks; one per execution and step. */
      async phoneCommand({ nodeId, ...input }) {
        if (!executionId) throw fail(400, "Phone steps need a whole workflow run.", "bad-request", { retryable: false });
        const db = await database();
        try {
          return await require("../phone-bridge").createPhoneCommand(db, userId, { ...input, deviceName: "A workflow" }, { now, executionId, nodeId });
        } catch (error) {
          // Offline phones and missing permissions are the person's to fix; retries follow the step's own retry setting.
          throw Object.assign(error, { retryable: error.reason === "phone-offline" });
        }
      },

      /** Google Chat as the user: read a space, or post (the step asks for approval on every run). */
      async chat({ operation, space, max, text, thread }) {
        const db = await database();
        const { rows } = await db.query("SELECT scopes FROM hannah_connections WHERE user_id = $1 AND provider = 'google'", [userId]);
        const comms = require("../communications");
        if (!rows[0]) throw fail(404, "Google isn't connected. Connect it in Settings → Calendar and email.", "not-connected", { retryable: false });
        if (!comms.hasChatScopes(rows[0].scopes)) throw fail(403, "Google Chat isn't connected. In Settings → Calendar and email, choose “Also connect Google Chat”.", "scope-missing", { retryable: false });
        const token = await connections.accessTokenFor(db, userId, "google", { fetchImpl, now });
        if (operation === "spaces") return { spaces: await comms.chatSpaces(fetchImpl, token) };
        if (operation === "send") return comms.chatSend(fetchImpl, token, space, { text, thread });
        return { messages: await comms.chatMessages(fetchImpl, token, space, { max }) };
      },

      async readMail({ provider, id }) {
        const db = await database();
        const providerId = provider === "google" || provider === "microsoft" ? provider : await connectedProvider(db, userId);
        const token = await connections.accessTokenFor(db, userId, providerId, { fetchImpl, now });
        return connections.readMessage(fetchImpl, providerId, token, id);
      },

      async calendar({ operation, from, to, event }) {
        const db = await database();
        const providerId = await connectedProvider(db, userId);
        const token = await connections.accessTokenFor(db, userId, providerId, { fetchImpl, now });
        if (operation === "create") return connections.createEvent(fetchImpl, providerId, token, event);
        return { events: await connections.listEvents(fetchImpl, providerId, token, { from, to, max: 50 }) };
      },

      async appendAccountItem(namespace, fields) {
        const db = await database();
        const at = now();
        const iso = new Date(at).toISOString();
        const item = namespace === "memories"
          ? { id: crypto.randomUUID(), layer: "long_term", tier: "semantic", content: fields.content, weight: 1, decay: 0, lastAccessed: iso, accessCount: 0, createdAt: iso, updatedAt: iso, category: fields.category || "other", source: { kind: "automation", detail: workflowId ? `Workflow ${workflowId}` : "Workflow" }, sensitivity: "normal" }
          : { id: crypto.randomUUID(), text: fields.text, dueAt: fields.dueAt, createdAt: at, status: "scheduled" };
        await db.transaction(async (query) => {
          const { rows } = await query("SELECT value, version FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, namespace]);
          const list = Array.isArray(parse(rows[0]?.value, [])) ? parse(rows[0]?.value, []) : [];
          const limit = namespace === "memories" ? 500 : 200;
          const next = JSON.stringify([...list, item].slice(-limit));
          if (rows[0]) await query("UPDATE hannah_user_data SET value = $1, version = $2, updated_at = $3 WHERE user_id = $4 AND namespace = $5", [next, Number(rows[0].version) + 1, at, userId, namespace]);
          else await query("INSERT INTO hannah_user_data (user_id, namespace, value, version, updated_at) VALUES ($1, $2, $3, 1, $4)", [userId, namespace, next, at]);
        });
        return namespace === "memories" ? { id: item.id, content: item.content, category: item.category } : { id: item.id, text: item.text, dueAt: new Date(item.dueAt).toISOString() };
      },

      async readAccountList(namespace) {
        const db = await database();
        const { rows } = await db.query("SELECT value FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, namespace]);
        const list = parse(rows[0]?.value, []);
        return Array.isArray(list) ? list : [];
      },

      async searchMemories(query, limit = 5) {
        const db = await database();
        const { rows } = await db.query("SELECT value FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, "memories"]);
        const memories = (parse(rows[0]?.value, []) || []).filter((memory) => memory && typeof memory.content === "string" && memory.sensitivity !== "sensitive");
        const words = new Set(memoryTokens(query));
        if (!words.size) return [];
        return memories
          .map((memory) => ({ memory, score: memoryTokens(memory.content).filter((word) => words.has(word)).length }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map(({ memory }) => ({ content: memory.content, category: memory.category || "other" }));
      },

      async credential(id) {
        const db = await database();
        const { rows } = await db.query("SELECT id, type, key_id, wrapped_key, ciphertext FROM hannah_workflow_credentials WHERE user_id = $1 AND id = $2", [userId, id]);
        if (!rows[0]) return null;
        const { secret } = decryptSecret(rows[0], { userId, providerId: `wfcred:${id}` });
        return { id, type: rows[0].type, data: parse(secret, {}) };
      },

      async postgres({ connectionString, sql, values, readOnly }) {
        const { Client } = require("pg");
        let host;
        try {
          host = new URL(connectionString).hostname;
        } catch {
          throw fail(400, "The Postgres connection string isn't valid.", "bad-credential", { retryable: false });
        }
        const resolved = await require("node:dns").promises.lookup(host, { all: true }).catch(() => []);
        if (!resolved.length || resolved.some((entry) => addressBlocked(entry.address))) throw Object.assign(new Error(`${host} is on an internal network, which workflows can't reach.`), { code: "request-blocked" });
        const client = new Client({ connectionString, statement_timeout: 15_000, connectionTimeoutMillis: 8000, ssl: /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: false } });
        await client.connect();
        try {
          if (readOnly) await client.query("BEGIN READ ONLY");
          const result = await client.query(sql, values);
          if (readOnly) await client.query("COMMIT");
          return (result.rows || []).slice(0, 1000);
        } finally {
          await client.end().catch(() => {});
        }
      },
    };
  }

  async function connectedProvider(db, userId) {
    const { rows } = await db.query("SELECT provider FROM hannah_connections WHERE user_id = $1 ORDER BY created_at", [userId]);
    if (!rows.length) throw fail(400, "No Google or Microsoft account is connected. Connect one in Settings → Calendar and email.", "not-connected", { retryable: false });
    return rows[0].provider;
  }

  // ---------- enqueueing ----------

  async function enqueue({ userId, workflowId, definition, version = null, mode, triggerNodeId, triggerData = null, idempotencyKey = null, retryOf = null, state = null }) {
    const db = await database();
    const at = now();
    const dayStart = at - (at % 86_400_000);
    const { rows: [count] } = await db.query("SELECT COUNT(*) AS n FROM hannah_workflow_executions WHERE user_id = $1 AND created_at >= $2", [userId, dayStart]);
    if (Number(count.n) >= DAILY_EXECUTIONS) throw fail(429, `You've reached today's limit of ${DAILY_EXECUTIONS} workflow runs.`, "quota");
    if (idempotencyKey) {
      const { rows } = await db.query("SELECT id, status FROM hannah_workflow_executions WHERE user_id = $1 AND idempotency_key = $2", [userId, idempotencyKey]);
      if (rows[0]) return { id: rows[0].id, status: rows[0].status, duplicate: true };
    }
    const id = newId("ex");
    try {
      await db.query(
        `INSERT INTO hannah_workflow_executions (id, user_id, workflow_id, workflow_version, definition, mode, status, trigger_node_id, trigger_data, state, attempts, idempotency_key, retry_of, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, 0, $10, $11, $12, $12)`,
        [id, userId, workflowId, version, JSON.stringify(definition), mode, triggerNodeId, triggerData === null ? null : JSON.stringify(triggerData), state ? JSON.stringify(state) : null, idempotencyKey, retryOf, at],
      );
    } catch (error) {
      if (idempotencyKey && /unique|constraint/i.test(String(error.message))) {
        const { rows } = await db.query("SELECT id, status FROM hannah_workflow_executions WHERE user_id = $1 AND idempotency_key = $2", [userId, idempotencyKey]);
        if (rows[0]) return { id: rows[0].id, status: rows[0].status, duplicate: true };
      }
      throw error;
    }
    await db.query("DELETE FROM hannah_workflow_executions WHERE user_id = $1 AND created_at < $2 AND status IN ('completed', 'failed', 'cancelled', 'timed-out')", [userId, at - KEEP_EXECUTIONS_MS]);
    return { id, status: "queued", duplicate: false };
  }

  // ---------- running ----------

  async function claim(id) {
    const db = await database();
    const at = now();
    const { rowCount } = await db.query(
      "UPDATE hannah_workflow_executions SET status = 'running', lease_owner = $1, lease_expires_at = $2, started_at = COALESCE(started_at, $3), attempts = attempts + 1, updated_at = $3 WHERE id = $4 AND status = 'queued'",
      [workerId, at + LEASE_MS, at, id],
    );
    return rowCount === 1;
  }

  /** Run a claimed execution. yieldAt (a time): hand it back as queued before the next step after then. */
  async function runClaimed(id, { yieldAt = null } = {}) {
    const db = await database();
    const { rows } = await db.query("SELECT * FROM hannah_workflow_executions WHERE id = $1", [id]);
    const row = rows[0];
    if (!row) return null;
    const { rows: [workflowRow] } = await db.query("SELECT name FROM hannah_workflows WHERE user_id = $1 AND id = $2", [row.user_id, row.workflow_id]);
    const definition = parse(row.definition, {});
    const controller = new AbortController();
    running.set(id, controller);
    const heartbeat = setInterval(async () => {
      try {
        const { rows: [current] } = await db.query("SELECT cancel_requested FROM hannah_workflow_executions WHERE id = $1", [id]);
        if (Number(current?.cancel_requested)) controller.abort(new Error("Cancelled by you."));
        await db.query("UPDATE hannah_workflow_executions SET lease_expires_at = $1 WHERE id = $2 AND lease_owner = $3", [now() + LEASE_MS, id, workerId]);
      } catch {
        // The next heartbeat tries again; the lease covers a missed one.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const nodeNames = new Map((definition.nodes || []).map((node) => [node.id, node.name]));
    const resume = parse(row.resume, null);
    let result;
    try {
      if (Number(row.cancel_requested)) controller.abort(new Error("Cancelled by you."));
      result = await engine.execute({
        definition,
        execution: { id, mode: row.mode, triggerNodeId: row.trigger_node_id, triggerData: parse(row.trigger_data, null), state: parse(row.state, null) },
        workflow: { id: row.workflow_id, name: workflowRow?.name || "Workflow", timezone: definition.settings?.timezone || "UTC" },
        services: servicesFor(row.user_id, { executionId: id, workflowId: row.workflow_id }),
        now,
        signal: controller.signal,
        resume: resume || undefined,
        inlineWaitMs: INLINE_WAIT_MS,
        shouldPause: async () => Number((await db.query("SELECT pause_requested FROM hannah_workflow_executions WHERE id = $1", [id])).rows[0]?.pause_requested) === 1,
        shouldYield: () => yieldAt !== null && now() >= yieldAt,
        onCheckpoint: async (state, event) => {
          const at = now();
          await db.query("UPDATE hannah_workflow_executions SET state = $1, updated_at = $2, resume = NULL WHERE id = $3", [JSON.stringify(state), at, id]);
          if (!event?.nodeId) return;
          const nodeState = state.nodes[event.nodeId] || {};
          const input = event.input ? JSON.stringify({ count: event.input.length, items: engine.sanitize(event.input.slice(0, 20).map((item) => item.json)) }) : null;
          const output = event.output ? JSON.stringify(Object.fromEntries(Object.entries(event.output).map(([port, items]) => [port, { count: items.length, items: engine.sanitize(items.slice(0, 20).map((item) => item.json)) }]))) : null;
          await db.query(
            `INSERT INTO hannah_workflow_node_runs (execution_id, node_id, node_name, status, attempts, started_at, finished_at, input, output, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (execution_id, node_id) DO UPDATE SET status = excluded.status, attempts = excluded.attempts,
               started_at = COALESCE(hannah_workflow_node_runs.started_at, excluded.started_at), finished_at = excluded.finished_at,
               input = COALESCE(excluded.input, hannah_workflow_node_runs.input), output = COALESCE(excluded.output, hannah_workflow_node_runs.output), error = excluded.error`,
            [id, event.nodeId, nodeNames.get(event.nodeId) || event.nodeId, event.status, Number(nodeState.attempts) || 0, nodeState.startedAt || null, ["done", "failed", "skipped", "cancelled", "failed-continued", "denied"].includes(event.status) ? at : null, input, output, event.error || nodeState.error || null],
          );
        },
      });
    } catch (error) {
      result = { status: "failed", error: error.message || "The run failed.", state: parse(row.state, null) };
    } finally {
      clearInterval(heartbeat);
      running.delete(id);
    }
    return finish(row, result);
  }

  async function finish(row, result) {
    const db = await database();
    const at = now();
    const waiting = result.waiting ? { ...result.waiting } : null;
    if (waiting?.kind === "webhook") {
      waiting.token = crypto.randomBytes(24).toString("base64url");
      waiting.tokenHash = sha256(waiting.token);
    }
    const status = result.status;
    // The checkpoint holds every step's full, unmasked data so a run can resume
    // or be retried from its failed step. A completed run can only be run again
    // from the start, so keep just each step's status and masked logs.
    const state = status === "completed" && result.state?.nodes
      ? { nodes: Object.fromEntries(Object.entries(result.state.nodes).map(([nodeId, node]) => [nodeId, { status: node?.status, ...(Array.isArray(node?.logs) ? { logs: engine.sanitize(node.logs) } : {}) }])) }
      : result.state || {};
    await db.query(
      `UPDATE hannah_workflow_executions SET status = $1, state = $2, error = $3, error_node = $4, waiting = $5, wait_until = $6,
         lease_owner = NULL, lease_expires_at = NULL, finished_at = $7, updated_at = $8 WHERE id = $9`,
      [status, JSON.stringify(state), result.error || null, result.errorNode || null, waiting ? JSON.stringify(waiting) : null, waiting?.until ?? null, FINAL.has(status) ? at : null, at, row.id],
    );
    // A pause request is used up when the run pauses (or ends before it could).
    if (FINAL.has(status) || waiting?.kind === "paused") await db.query("UPDATE hannah_workflow_executions SET pause_requested = 0 WHERE id = $1", [row.id]);
    if (FINAL.has(status) && row.mode !== "test") {
      const event = status === "completed" ? "workflow.completed" : status === "cancelled" ? null : "workflow.failed";
      // $depth stops workflows that trigger each other from looping (see emitEvent).
      if (event) await emit(row.user_id, event, { workflowId: row.workflow_id, executionId: row.id, status, error: result.error || null, $depth: Number(parse(row.trigger_data, {})?.$depth) || 0 }).catch(() => {});
    }
    if (status === "waiting-approval") await emit(row.user_id, "approval.requested", { workflowId: row.workflow_id, executionId: row.id, message: waiting?.message }).catch(() => {});
    return { id: row.id, status };
  }

  /**
   * Recover expired leases, wake due waits, fire due schedules, then run queued executions.
   * budgetMs limits which runs start. preempt (serverless hosting, where the function is stopped
   * at its time limit) also makes runs hand themselves back, as queued with their checkpoint, before
   * the next step once the budget is used, instead of being cut off mid-step and counted as a crash.
   */
  async function tick({ budgetMs = 25_000, only = null, preempt = false } = {}) {
    const db = await database();
    const started = now();
    const report = { recovered: 0, deadLettered: 0, woke: 0, expired: 0, scheduled: 0, mail: 0, ran: [] };

    // 1. Executions whose worker disappeared.
    // Only recoveries count towards dead-lettering: attempts also counts normal resumes after waits and approvals.
    const { rows: stale } = await db.query("SELECT id, recoveries FROM hannah_workflow_executions WHERE status = 'running' AND lease_expires_at < $1 LIMIT 50", [now()]);
    for (const row of stale) {
      if (running.has(row.id)) continue;
      if (Number(row.recoveries) >= MAX_RECOVERIES) {
        const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'failed', error = $1, lease_owner = NULL, lease_expires_at = NULL, finished_at = $2, updated_at = $2 WHERE id = $3 AND status = 'running'", [`Dead-lettered: the worker stopped ${Number(row.recoveries) + 1} times while running this. It won't be retried automatically; retry it from the execution page after checking the failed step.`, now(), row.id]);
        report.deadLettered += rowCount;
      } else {
        const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'queued', recoveries = recoveries + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = $1 WHERE id = $2 AND status = 'running' AND lease_expires_at < $1", [now(), row.id]);
        report.recovered += rowCount;
      }
    }

    // 2. Waits that are due: timed waits continue; approvals and webhook waits expire.
    const { rows: due } = await db.query("SELECT id, status, waiting FROM hannah_workflow_executions WHERE status IN ('waiting', 'waiting-approval') AND wait_until <= $1 LIMIT 50", [now()]);
    for (const row of due) {
      const waiting = parse(row.waiting, {});
      if (row.status === "waiting" && waiting.kind === "phone" && waiting.commandId) {
        // The phone may have answered before this run was saved as waiting: use its answer instead of timing out.
        const { rows: [command] } = await db.query("SELECT * FROM hannah_phone_commands WHERE id = $1", [waiting.commandId]);
        const bridge = require("../phone-bridge");
        const status = command?.status;
        if (command && bridge.settled({ status }, waiting.platform)) {
          const data = { ok: true, command: { id: command.id, status, result: parse(command.result, null), payload: parse(command.payload, {}) } };
          const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'queued', resume = $1, waiting = NULL, wait_until = NULL, updated_at = $2 WHERE id = $3 AND status = 'waiting'", [JSON.stringify({ nodeId: waiting.nodeId, data }), now(), row.id]);
          report.woke += rowCount;
          continue;
        }
      }
      if (row.status === "waiting" && waiting.kind === "time") {
        const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'queued', resume = $1, waiting = NULL, wait_until = NULL, updated_at = $2 WHERE id = $3 AND status = 'waiting'", [JSON.stringify({ nodeId: waiting.nodeId }), now(), row.id]);
        report.woke += rowCount;
      } else {
        const reason = waiting.kind === "approval" ? "Nobody answered the approval in time." : waiting.kind === "phone" ? "Your phone didn't pick up or report on the request in time, so it was dropped. Nothing will happen on the phone later. Keep HANNAH open on the phone with “Use this phone from my computer” on." : waiting.kind === "device" ? "No desktop app finished the task in time. Open the desktop app signed in to this account, with “Run workflow tasks” on in Settings → Desktop access." : "The resume URL wasn't called in time.";
        const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'timed-out', error = $1, finished_at = $2, updated_at = $2 WHERE id = $3 AND status = $4", [reason, now(), row.id, row.status]);
        if (rowCount && waiting.kind === "phone") await db.query("UPDATE hannah_phone_commands SET status = 'expired', finished_at = $1 WHERE execution_id = $2 AND status = 'pending'", [now(), row.id]);
        if (rowCount && waiting.kind === "device") await db.query("UPDATE hannah_workflow_device_jobs SET status = 'expired', updated_at = $1 WHERE execution_id = $2 AND status IN ('pending', 'claimed')", [now(), row.id]);
        report.expired += rowCount;
      }
    }

    // 3. Schedules.
    if (!only) report.scheduled = await fireSchedules();
    if (!only) report.mail = await pollMailboxes({ budgetMs: Math.max(2000, budgetMs / 2) });

    // 4. Run queued executions, oldest first, within limits.
    const { rows: queued } = await db.query(
      `SELECT id, user_id FROM hannah_workflow_executions WHERE status = 'queued' ${only ? "AND id = $1" : ""} ORDER BY created_at LIMIT ${WORKER_CONCURRENCY * 4}`,
      only ? [only] : [],
    );
    const active = [];
    for (const row of queued) {
      if (active.length >= WORKER_CONCURRENCY || now() - started > budgetMs) break;
      const { rows: [load] } = await db.query("SELECT COUNT(*) AS n FROM hannah_workflow_executions WHERE user_id = $1 AND status = 'running'", [row.user_id]);
      if (Number(load.n) >= USER_CONCURRENCY) continue;
      if (!(await claim(row.id))) continue;
      active.push(runClaimed(row.id, { yieldAt: preempt ? started + budgetMs : null }).then((done) => report.ran.push(done)).catch((error) => report.ran.push({ id: row.id, status: "failed", error: error.message })));
    }
    await Promise.all(active);
    return report;
  }

  async function fireSchedules() {
    const db = await database();
    const at = now();
    let fired = 0;
    const { rows } = await db.query("SELECT * FROM hannah_workflow_triggers WHERE kind = 'schedule' AND enabled = 1 AND next_run_at <= $1 ORDER BY next_run_at LIMIT 50", [at]);
    for (const trigger of rows) {
      const config = parse(trigger.config, {});
      const slot = Number(trigger.next_run_at);
      let next;
      try {
        next = engine.nextScheduledRun(config.params, config.timezone, Math.max(at, slot));
      } catch {
        next = null;
      }
      // Claim this slot: only one worker moves next_run_at forward.
      const { rowCount } = await db.query("UPDATE hannah_workflow_triggers SET next_run_at = $1, updated_at = $2 WHERE id = $3 AND next_run_at = $4", [next, at, trigger.id, slot]);
      if (rowCount !== 1) continue;
      const missedBy = at - slot;
      if (missedBy > 10 * 60_000 && config.params?.missed === "skip") continue;
      const workflow = await publishedDefinition(trigger.user_id, trigger.workflow_id);
      if (!workflow) continue;
      try {
        await enqueue({ userId: trigger.user_id, workflowId: trigger.workflow_id, definition: workflow.definition, version: workflow.version, mode: "schedule", triggerNodeId: trigger.node_id, triggerData: { scheduledFor: new Date(slot).toISOString(), late: missedBy > 60_000 }, idempotencyKey: `sched:${trigger.id}:${slot}` });
        fired += 1;
      } catch (error) {
        console.error(`A scheduled workflow couldn't be queued (${error.reason || error.code || "error"}).`);
      }
    }
    return fired;
  }

  /**
   * New-email triggers: check each mailbox that's due and queue one execution
   * per message that arrived since the last check.
   *
   * The trigger's state is the cursor: the newest arrival time seen, plus the
   * ids of recent messages. The first check after activation only records
   * where the mailbox is, so old mail never starts a run. Each message's
   * execution has the idempotency key mail:<trigger>:<message id>, so two
   * overlapping checks can't run it twice.
   */
  async function pollMailboxes({ budgetMs = 10_000 } = {}) {
    const db = await database();
    const at = now();
    let queued = 0;
    const { rows } = await db.query("SELECT * FROM hannah_workflow_triggers WHERE kind = 'email' AND enabled = 1 AND next_run_at <= $1 ORDER BY next_run_at LIMIT 25", [at]);
    for (const trigger of rows) {
      if (now() - at > budgetMs) break;
      const config = parse(trigger.config, {});
      const params = config.params || {};
      const slot = Number(trigger.next_run_at);
      const every = Math.max(5, Math.min(1440, Number(params.minutes) || 5)) * 60_000;
      const { rowCount } = await db.query("UPDATE hannah_workflow_triggers SET next_run_at = $1, updated_at = $2 WHERE id = $3 AND next_run_at = $4", [at + every, at, trigger.id, slot]);
      if (rowCount !== 1) continue;
      const workflow = await publishedDefinition(trigger.user_id, trigger.workflow_id);
      if (!workflow) continue;
      const state = parse(trigger.state, null);
      let next;
      try {
        const services = servicesFor(trigger.user_id, { workflowId: trigger.workflow_id });
        const provider = params.provider === "google" || params.provider === "microsoft" ? params.provider : undefined;
        const { messages } = await services.mail({ mode: "search", provider, query: String(params.query || ""), max: 20 });
        const arrived = (message) => Date.parse(message.date) || 0;
        const newest = messages.reduce((latest, message) => Math.max(latest, arrived(message)), 0);
        if (!state?.since) {
          next = { since: Math.max(newest, at - 60_000), seen: messages.map((message) => message.id).slice(0, 200), checkedAt: at, lastError: null };
        } else {
          const seen = new Set(state.seen || []);
          // A minute of grace for clock differences; the seen list catches repeats.
          const fresh = messages.filter((message) => !seen.has(message.id) && arrived(message) > Number(state.since) - 60_000).sort((a, b) => arrived(a) - arrived(b)).slice(0, 10);
          for (const message of fresh) {
            const full = params.includeBody === false ? message : { ...message, ...(await services.readMail({ provider: message.provider, id: message.id })) };
            await enqueue({ userId: trigger.user_id, workflowId: trigger.workflow_id, definition: workflow.definition, version: workflow.version, mode: "email", triggerNodeId: trigger.node_id, triggerData: { message: full }, idempotencyKey: `mail:${trigger.id}:${message.id}` });
            queued += 1;
          }
          next = { since: Math.max(Number(state.since), newest), seen: [...fresh.map((message) => message.id), ...(state.seen || [])].slice(0, 200), checkedAt: at, lastError: null };
        }
      } catch (error) {
        // Keep the cursor; show why the check failed on the workflow.
        next = { ...(state || {}), checkedAt: at, lastError: String(error.message || error).slice(0, 300) };
      }
      await db.query("UPDATE hannah_workflow_triggers SET state = $1 WHERE id = $2", [JSON.stringify(next), trigger.id]);
    }
    return queued;
  }

  async function publishedDefinition(userId, workflowId) {
    const db = await database();
    const { rows: [workflow] } = await db.query("SELECT published_version, active FROM hannah_workflows WHERE user_id = $1 AND id = $2", [userId, workflowId]);
    if (!workflow || !Number(workflow.active) || !workflow.published_version) return null;
    const { rows: [version] } = await db.query("SELECT definition FROM hannah_workflow_versions WHERE user_id = $1 AND workflow_id = $2 AND version = $3", [userId, workflowId, workflow.published_version]);
    return version ? { definition: parse(version.definition, {}), version: Number(workflow.published_version) } : null;
  }

  /** Start every active workflow whose HANNAH-event trigger matches. */
  async function emitEvent(userId, name, data, { sourceWorkflowId = null, depth = 0 } = {}) {
    if (depth >= 3) return 0;
    const db = await database();
    const { rows } = await db.query("SELECT * FROM hannah_workflow_triggers WHERE user_id = $1 AND kind = 'event' AND enabled = 1", [userId]);
    let started = 0;
    for (const trigger of rows) {
      const config = parse(trigger.config, {});
      const wanted = config.params?.event === "custom" ? `custom:${config.params.customName}` : config.params?.event;
      if (wanted !== name) continue;
      if (sourceWorkflowId && trigger.workflow_id === sourceWorkflowId) continue;
      const workflow = await publishedDefinition(userId, trigger.workflow_id);
      if (!workflow) continue;
      await enqueue({ userId, workflowId: trigger.workflow_id, definition: workflow.definition, version: workflow.version, mode: "event", triggerNodeId: trigger.node_id, triggerData: { event: name, data, at: new Date(now()).toISOString(), $depth: depth + 1 } }).then(() => { started += 1; }).catch(() => {});
    }
    return started;
  }

  // ---------- activation ----------

  /** Create, enable or disable the trigger rows for a workflow's published version. Returns new webhook secrets (shown once). */
  async function syncTriggers(userId, workflowId, definition, enabled, { timezone } = {}) {
    const db = await database();
    const at = now();
    const secrets = [];
    const { rows: existing } = await db.query("SELECT * FROM hannah_workflow_triggers WHERE user_id = $1 AND workflow_id = $2", [userId, workflowId]);
    const byNode = new Map(existing.map((row) => [row.node_id, row]));
    const keep = new Set();
    for (const node of definition.nodes || []) {
      const kind = { "trigger.schedule": "schedule", "trigger.webhook": "webhook", "trigger.event": "event", "trigger.email": "email", "trigger.file": "file" }[node.type] || null;
      if (!kind || node.disabled) continue;
      keep.add(node.id);
      const params = engine.withDefaults(REGISTRY.get(node.type), node.params);
      const config = JSON.stringify({ params, timezone: timezone || definition.settings?.timezone || "UTC" });
      // Schedules fire at their next slot; mailboxes are checked right away (the first check only records where the mailbox is).
      const nextRun = !enabled ? null : kind === "schedule" ? engine.nextScheduledRun(params, timezone || definition.settings?.timezone || "UTC", at) : kind === "email" ? at : null;
      const row = byNode.get(node.id);
      if (row) {
        // Re-activating a mailbox trigger starts from now, not from where it stopped.
        const restart = kind === "email" && (enabled && !Number(row.enabled) || row.config !== config);
        await db.query(`UPDATE hannah_workflow_triggers SET kind = $1, config = $2, enabled = $3, next_run_at = $4, updated_at = $5${restart ? ", state = NULL" : ""} WHERE id = $6`, [kind, config, enabled ? 1 : 0, nextRun, at, row.id]);
        if (kind === "webhook" && !row.secret_hash) secrets.push(await rotateWebhookSecret(userId, row.id, node.id));
        else if (kind === "webhook" && params.auth === "hmac" && !row.secret_ciphertext) secrets.push(await rotateWebhookSecret(userId, row.id, node.id));
      } else {
        const id = kind === "webhook" ? `wh_${crypto.randomBytes(12).toString("base64url")}` : newId("tr");
        await db.query("INSERT INTO hannah_workflow_triggers (id, user_id, workflow_id, node_id, kind, config, enabled, next_run_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)", [id, userId, workflowId, node.id, kind, config, enabled ? 1 : 0, nextRun, at]);
        if (kind === "webhook") secrets.push(await rotateWebhookSecret(userId, id, node.id));
      }
    }
    for (const row of existing) if (!keep.has(row.node_id)) await db.query("UPDATE hannah_workflow_triggers SET enabled = 0, next_run_at = NULL, updated_at = $1 WHERE id = $2", [at, row.id]);
    return secrets;
  }

  async function rotateWebhookSecret(userId, triggerId, nodeId) {
    const db = await database();
    const secret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
    let sealed = { keyId: null, wrappedKey: null, ciphertext: null };
    if (vaultConfigured()) sealed = encryptSecret(secret, { userId, providerId: `wfhook:${triggerId}` });
    await db.query("UPDATE hannah_workflow_triggers SET secret_hash = $1, secret_key_id = $2, secret_wrapped = $3, secret_ciphertext = $4, updated_at = $5 WHERE id = $6 AND user_id = $7", [sha256(secret), sealed.keyId, sealed.wrappedKey, sealed.ciphertext, now(), triggerId, userId]);
    return { nodeId, triggerId, secret };
  }

  /** Ask a running execution to stop (here or on another worker). */
  async function cancel(userId, executionId) {
    const db = await database();
    const { rows: [row] } = await db.query("SELECT status FROM hannah_workflow_executions WHERE id = $1 AND user_id = $2", [executionId, userId]);
    if (!row) throw fail(404, "That run doesn't exist.", "not-found");
    if (FINAL.has(row.status)) throw fail(409, `This run already ${row.status === "completed" ? "completed" : row.status}.`, "final");
    if (row.status === "running") {
      await db.query("UPDATE hannah_workflow_executions SET cancel_requested = 1, updated_at = $1 WHERE id = $2", [now(), executionId]);
      running.get(executionId)?.abort(new Error("Cancelled by you."));
      return { status: "cancelling" };
    }
    await db.query("UPDATE hannah_workflow_executions SET status = 'cancelled', cancel_requested = 1, error = 'Cancelled by you.', waiting = NULL, wait_until = NULL, finished_at = $1, updated_at = $1 WHERE id = $2 AND status = $3", [now(), executionId, row.status]);
    await db.query("UPDATE hannah_workflow_device_jobs SET status = 'cancelled', updated_at = $1 WHERE execution_id = $2 AND status IN ('pending', 'claimed')", [now(), executionId]);
    return { status: "cancelled" };
  }

  /**
   * Pause a run. A queued run pauses at once; a running one stops before its next step
   * (the step in progress finishes first). Resume continues from there; finished steps never run again.
   */
  async function pause(userId, executionId) {
    const db = await database();
    const { rows: [row] } = await db.query("SELECT status FROM hannah_workflow_executions WHERE id = $1 AND user_id = $2", [executionId, userId]);
    if (!row) throw fail(404, "That run doesn't exist.", "not-found");
    if (row.status === "queued") {
      const waiting = { kind: "paused", message: "Paused by you before it started. Resume to run it." };
      const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'waiting', waiting = $1, wait_until = NULL, updated_at = $2 WHERE id = $3 AND status = 'queued'", [JSON.stringify(waiting), now(), executionId]);
      if (rowCount) return { status: "paused" };
    }
    if (row.status === "running" || row.status === "queued") {
      await db.query("UPDATE hannah_workflow_executions SET pause_requested = 1, updated_at = $1 WHERE id = $2 AND status IN ('queued', 'running')", [now(), executionId]);
      return { status: "pausing" };
    }
    throw fail(409, FINAL.has(row.status) ? "This run has already finished." : "This run is already waiting.", "not-running");
  }

  /** Answer an approval or deliver a webhook resume: the execution goes back to the queue. */
  async function resume(userId, executionId, { approved, data, nodeId }) {
    const db = await database();
    const { rows: [row] } = await db.query("SELECT status, waiting FROM hannah_workflow_executions WHERE id = $1 AND user_id = $2", [executionId, userId]);
    if (!row) throw fail(404, "That run doesn't exist.", "not-found");
    const waiting = parse(row.waiting, null);
    if (!waiting || !["waiting", "waiting-approval"].includes(row.status)) throw fail(409, "This run isn't waiting for anything.", "not-waiting");
    if (nodeId && nodeId !== waiting.nodeId) throw fail(409, "This run is waiting at a different step.", "not-waiting");
    // A run paused before it started has no step to resume at: it simply starts.
    const payload = waiting.kind === "paused" && !waiting.nodeId ? null : waiting.kind === "approval" ? { nodeId: waiting.nodeId, approved: Boolean(approved) } : { nodeId: waiting.nodeId, data: data ?? null };
    const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET status = 'queued', resume = $1, waiting = NULL, wait_until = NULL, updated_at = $2 WHERE id = $3 AND status = $4", [payload ? JSON.stringify(payload) : null, now(), executionId, row.status]);
    if (rowCount !== 1) throw fail(409, "Someone answered first.", "conflict");
    return { status: "queued" };
  }

  /** A waiting step's deadline moves (a phone picked up its request and has a while to report). Never shortens it. */
  async function extendWait(userId, executionId, until) {
    const db = await database();
    const { rowCount } = await db.query("UPDATE hannah_workflow_executions SET wait_until = $1, updated_at = $2 WHERE id = $3 AND user_id = $4 AND status = 'waiting' AND (wait_until IS NULL OR wait_until < $1)", [until, now(), executionId, userId]);
    return rowCount === 1;
  }

  let loop = null;
  function startWorker({ intervalMs = 5000 } = {}) {
    if (loop) return loop;
    let busy = false;
    loop = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await tick({ budgetMs: intervalMs * 4 });
      } catch (error) {
        console.error(`Workflow worker tick failed (${error?.code || error?.name || "error"}).`);
      } finally {
        busy = false;
      }
    }, intervalMs);
    loop.unref?.();
    return loop;
  }
  function stopWorker() {
    if (loop) clearInterval(loop);
    loop = null;
  }

  return { cancel, claim, pause, emitEvent, enqueue, extendWait, publishedDefinition, resume, rotateWebhookSecret, runClaimed, servicesFor, startWorker, stopWorker, syncTriggers, tick, workerId };
}

module.exports = { FINAL, createRuntime, explainProviderError, sha256 };
