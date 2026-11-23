"use strict";

/**
 * Workforce memory, separate from conversational memory and from the vault.
 *
 * Boundaries:
 *   user     facts the person shares with their teammates
 *   bot      one teammate's private work log and context
 *   project  a project's context, shared across teammates working on it
 *   team     a team's shared context; readable by that team's members
 *   device   robotics and IoT context for a registered device
 *
 * Credentials never belong here. Obvious secret material is refused and the
 * person is pointed at the Secure Vault. Every record keeps where it came from,
 * how confident it is and when it was last verified, so stale memory can be
 * questioned instead of trusted blindly.
 */
const express = require("express");
const {
  canUseBot, clean, cleanMultiline, fail, id, membership, parse, readBody, recordEvent,
  requireId, withAccount,
} = require("./common");

const SCOPES = new Set(["user", "bot", "project", "team", "device"]);
const KINDS = new Set(["fact", "preference", "rule", "decision", "worklog", "context"]);
const SECRET_PATTERNS = [
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S{4,}/i,
  /\b(?:api[_-]?key|secret|token)\s*[:=]\s*[A-Za-z0-9_.-]{12,}/i,
  /\b(?:sk|pk|ghp|gho|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/,
  /\b\d{13,19}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function looksSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function publicMemory(row) {
  return {
    id: row.id,
    botId: row.bot_id || null,
    teamId: row.team_id || null,
    project: row.project || "",
    scope: row.scope,
    kind: row.kind,
    content: row.content,
    provenance: row.provenance || "",
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    source: row.source || "",
    verifiedAt: row.verified_at === null || row.verified_at === undefined ? null : Number(row.verified_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    sensitive: Boolean(Number(row.sensitive)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function scopesOf(bot) {
  const config = bot?.memoryConfig || parse(bot?.memory_config, {});
  const scopes = Array.isArray(config.scopes) ? config.scopes : ["user", "bot"];
  return scopes.filter((scope) => SCOPES.has(scope));
}

async function validateScope(db, userId, body, bot) {
  const scope = String(body.scope || "bot");
  if (!SCOPES.has(scope)) throw fail(400, `scope must be one of ${[...SCOPES].join(", ")}.`, "invalid");
  if (scope === "bot" || scope === "project") {
    if (!body.botId && scope === "bot") throw fail(400, "Bot memory needs the teammate it belongs to.", "invalid");
  }
  if (scope === "team") {
    if (!body.teamId) throw fail(400, "Team memory needs a team.", "invalid");
    if (!(await membership(db, body.teamId, userId))) throw fail(403, "You're not on that team.", "forbidden");
  }
  if (scope === "bot" && bot && !scopesOf(bot).includes("bot")) throw fail(400, `${bot.name} isn't allowed private bot memory.`, "scope-not-allowed");
  if (scope === "user" && bot && !scopesOf(bot).includes("user")) throw fail(400, `${bot.name} isn't allowed shared user memory.`, "scope-not-allowed");
  return scope;
}

function tokens(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g)?.slice(0, 200) || []);
}

function relevance(query, row) {
  const want = tokens(query);
  if (!want.size) return 0;
  const have = tokens(`${row.content} ${row.provenance} ${row.project}`);
  let hits = 0;
  for (const token of want) if (have.has(token)) hits += 1;
  return hits / want.size;
}

function createMemoryRouter() {
  const router = express.Router();

  router.get("/workforce/memory", withAccount(async (req, res, db, account) => {
    const clauses = ["user_id = $1"];
    const params = [account.id];
    const push = (column, value) => { params.push(value); clauses.push(`${column} = $${params.length}`); };
    const scope = clean(req.query.scope, 20);
    if (scope && SCOPES.has(scope)) push("scope", scope);
    if (req.query.botId) push("bot_id", clean(req.query.botId, 80));
    if (req.query.project) push("project", clean(req.query.project, 80));
    if (req.query.kind) push("kind", clean(req.query.kind, 30));
    const at = Date.now();
    if (req.query.includeExpired !== "true") clauses.push(`(expires_at IS NULL OR expires_at > ${at})`);
    const q = clean(req.query.q, 200);
    const { rows } = await db.query(`SELECT * FROM hannah_workforce_memory WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`, params);
    const filtered = q ? rows.filter((row) => relevance(q, row) > 0).sort((a, b) => relevance(q, b) - relevance(q, a)) : rows;
    res.json({ memories: filtered.map(publicMemory), scopes: [...SCOPES], kinds: [...KINDS] });
  }));

  router.post("/workforce/memory", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const content = cleanMultiline(body.content, 4000);
    if (content.length < 2) throw fail(400, "Write what should be remembered.", "invalid");
    if (looksSecret(content)) throw fail(400, "This looks like a credential. Store it in the Secure Vault; secrets never go into memory.", "secret-refused");
    const bot = body.botId ? await canUseBot(db, account.id, clean(body.botId, 80)) : null;
    if (body.botId && !bot) throw fail(404, "That teammate doesn't exist.", "not-found");
    const scope = await validateScope(db, account.id, body, bot);
    const kind = KINDS.has(String(body.kind)) ? String(body.kind) : "fact";
    const confidence = Number(body.confidence);
    const verifiedAt = body.verifiedAt ? Number(new Date(body.verifiedAt)) : null;
    const expiresAt = body.expiresAt ? Number(new Date(body.expiresAt)) : null;
    if (expiresAt !== null && !Number.isFinite(expiresAt)) throw fail(400, "The expiry date is invalid.", "invalid");
    const at = Date.now();
    const memoryId = id("mem");
    await db.query(
      `INSERT INTO hannah_workforce_memory (user_id, id, bot_id, team_id, project, scope, kind, content, provenance, confidence, source, verified_at, expires_at, sensitive, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [account.id, memoryId, scope === "user" || scope === "team" || scope === "device" ? null : clean(body.botId, 80), scope === "team" ? clean(body.teamId, 80) : null, clean(body.project, 80), scope, kind, content,
        clean(body.provenance, 500), Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null, clean(body.source, 200), Number.isFinite(verifiedAt) ? verifiedAt : null,
        Number.isFinite(expiresAt) ? expiresAt : null, body.sensitive === true ? 1 : 0, at],
    );
    await recordEvent(db, account.id, "memory.written", { botId: bot?.id || null, detail: { memoryId, scope, kind } });
    const row = (await db.query("SELECT * FROM hannah_workforce_memory WHERE user_id = $1 AND id = $2", [account.id, memoryId])).rows[0];
    res.status(201).json({ memory: publicMemory(row) });
  }));

  router.post("/workforce/memory/recall", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const query = clean(body.query, 500);
    if (!query) throw fail(400, "Ask what to recall.", "invalid");
    const botId = body.botId ? clean(body.botId, 80) : null;
    const bot = botId ? await canUseBot(db, account.id, botId) : null;
    if (botId && !bot) throw fail(404, "That teammate doesn't exist.", "not-found");
    const at = Date.now();
    const { rows } = await db.query("SELECT * FROM hannah_workforce_memory WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > $2) ORDER BY updated_at DESC LIMIT 500", [account.id, at]);
    const allowedScopes = bot ? new Set(scopesOf(bot)) : null;
    const ranked = rows
      .filter((row) => (row.scope !== "bot" || !botId || row.bot_id === botId))
      .filter((row) => !allowedScopes || allowedScopes.has(row.scope))
      .map((row) => ({ row, score: relevance(query, row) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Number(b.row.updated_at) - Number(a.row.updated_at))
      .slice(0, 20);
    res.json({ query, matches: ranked.map((item) => ({ ...publicMemory(item.row), score: Number(item.score.toFixed(3)) })), method: "keyword" });
  }));

  router.put("/workforce/memory/:id", withAccount(async (req, res, db, account) => {
    const memoryId = requireId(req.params.id, "memory");
    const current = (await db.query("SELECT * FROM hannah_workforce_memory WHERE user_id = $1 AND id = $2", [account.id, memoryId])).rows[0];
    if (!current) throw fail(404, "That memory doesn't exist.", "not-found");
    const body = readBody(req);
    const content = body.content === undefined ? current.content : cleanMultiline(body.content, 4000);
    if (content.length < 2) throw fail(400, "Memory needs content.", "invalid");
    if (looksSecret(content)) throw fail(400, "This looks like a credential. Use the Secure Vault instead.", "secret-refused");
    const confidence = body.confidence === undefined ? current.confidence : Number(body.confidence);
    const expiresAt = body.expiresAt === undefined ? current.expires_at : (body.expiresAt ? Number(new Date(body.expiresAt)) : null);
    await db.query(
      "UPDATE hannah_workforce_memory SET content = $1, kind = $2, project = $3, provenance = $4, confidence = $5, verified_at = $6, expires_at = $7, sensitive = $8, updated_at = $9 WHERE user_id = $10 AND id = $11",
      [content, KINDS.has(String(body.kind)) ? String(body.kind) : current.kind, clean(body.project, 80) || current.project, clean(body.provenance, 500) || current.provenance,
        confidence === null ? null : Math.min(1, Math.max(0, Number(confidence))), body.verifiedAt ? Number(new Date(body.verifiedAt)) : current.verified_at,
        expiresAt, body.sensitive === undefined ? current.sensitive : (body.sensitive ? 1 : 0), Date.now(), account.id, memoryId],
    );
    await recordEvent(db, account.id, "memory.updated", { detail: { memoryId } });
    const row = (await db.query("SELECT * FROM hannah_workforce_memory WHERE user_id = $1 AND id = $2", [account.id, memoryId])).rows[0];
    res.json({ memory: publicMemory(row) });
  }));

  router.delete("/workforce/memory/:id", withAccount(async (req, res, db, account) => {
    const memoryId = requireId(req.params.id, "memory");
    const result = await db.query("DELETE FROM hannah_workforce_memory WHERE user_id = $1 AND id = $2", [account.id, memoryId]);
    if (!result.rowCount) throw fail(404, "That memory doesn't exist.", "not-found");
    await recordEvent(db, account.id, "memory.deleted", { detail: { memoryId } });
    res.json({ ok: true, removed: true });
  }));

  router.get("/workforce/memory/export", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_workforce_memory WHERE user_id = $1 ORDER BY created_at", [account.id]);
    res.json({ format: "hannah-workforce-memory", version: 1, exportedAt: new Date().toISOString(), memories: rows.map(publicMemory) });
  }));

  return router;
}

module.exports = { KINDS, SCOPES, createMemoryRouter, looksSecret, publicMemory, relevance };
