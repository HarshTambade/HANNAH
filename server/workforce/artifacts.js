"use strict";

/**
 * Artifacts: the files a teammate produces (reports, drafts, datasets,
 * screenshots). Bytes live on disk under the workforce root, keyed by owner;
 * the database holds metadata only. Every read and write is account-scoped, and
 * a version chain keeps earlier copies instead of overwriting them.
 *
 * Content is either UTF-8 text or base64. Uploads are capped at 16 MB because
 * this store is for work products, not bulk media.
 */
const express = require("express");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { canUseBot, clean, fail, id, readBody, recordEvent, requireId, sha256, withAccount } = require("./common");
const { workforceRoot } = require("./computers");

const MAX_BYTES = 16 * 1024 * 1024;
const TYPES = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,80}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,80}$/;
const EXTENSIONS = {
  "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "text/html": "html", "application/json": "json",
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg",
  "application/zip": "zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function artifactRoot(userId) {
  return path.join(workforceRoot(), "artifacts", sha256(userId).slice(0, 24));
}

function guessType(name) {
  const ext = path.extname(String(name || "")).toLowerCase().replace(".", "");
  for (const [type, suffix] of Object.entries(EXTENSIONS)) if (suffix === ext) return type;
  if (["md", "markdown"].includes(ext)) return "text/markdown";
  if (["txt", "log"].includes(ext)) return "text/plain";
  if (["csv", "tsv"].includes(ext)) return "text/csv";
  if (ext === "json") return "application/json";
  return "text/plain";
}

/** A filename that can't escape a directory and keeps its extension. */
function safeName(input, type) {
  const raw = String(input || "").replace(/\\/g, "/").split("/").pop() || "artifact";
  const base = raw.replace(/[^A-Za-z0-9._ ()-]/g, "_").replace(/^\.+/, "").trim().slice(0, 140) || "artifact";
  return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : `${base}.${EXTENSIONS[type] || "txt"}`;
}

async function createArtifact(db, userId, { name, type = "", content = "", encoding = "utf8", taskId = null, botId = null, teamId = null, source = "workforce" }) {
  const resolvedType = TYPES.test(String(type)) ? String(type) : guessType(name);
  const filename = safeName(name, resolvedType);
  const buffer = encoding === "base64" ? Buffer.from(String(content), "base64") : Buffer.from(String(content), "utf8");
  if (!buffer.length) throw fail(400, "An artifact can't be empty.", "invalid");
  if (buffer.length > MAX_BYTES) throw fail(413, "Artifacts are limited to 16 MB.", "too-large");
  const artifactId = id("art");
  const dir = artifactRoot(userId);
  await fsp.mkdir(dir, { recursive: true });
  const storageKey = path.join(sha256(userId).slice(0, 24), artifactId);
  const file = path.join(dir, artifactId);
  await fsp.writeFile(file, buffer, { mode: 0o600 });
  const at = Date.now();
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  await db.query(
    `INSERT INTO hannah_artifacts (user_id, id, team_id, task_id, bot_id, name, type, size, sha256, storage_key, version, parent_artifact_id, source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, NULL, $11, $12, $12)`,
    [userId, artifactId, teamId, taskId, botId, filename, resolvedType, buffer.length, digest, storageKey, clean(source, 60), at],
  );
  await recordEvent(db, userId, "artifact.created", { botId, taskId, detail: { artifactId, name: filename, size: buffer.length, type: resolvedType } });
  return (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [userId, artifactId])).rows[0];
}

function publicArtifact(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type || "application/octet-stream",
    size: Number(row.size) || 0,
    sha256: row.sha256 || "",
    version: Number(row.version),
    parentArtifactId: row.parent_artifact_id || null,
    taskId: row.task_id || null,
    botId: row.bot_id || null,
    teamId: row.team_id || null,
    source: row.source || "",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    downloadUrl: `/api/workforce/artifacts/${row.id}/content`,
  };
}

function createArtifactsRouter() {
  const router = express.Router();

  router.get("/workforce/artifacts", withAccount(async (req, res, db, account) => {
    const clauses = ["user_id = $1"];
    const params = [account.id];
    const push = (column, value) => { params.push(value); clauses.push(`${column} = $${params.length}`); };
    if (req.query.taskId) push("task_id", clean(req.query.taskId, 80));
    if (req.query.botId) push("bot_id", clean(req.query.botId, 80));
    const { rows } = await db.query(`SELECT * FROM hannah_artifacts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ artifacts: rows.map(publicArtifact), maxBytes: MAX_BYTES });
  }));

  router.post("/workforce/artifacts", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const bot = body.botId ? await canUseBot(db, account.id, clean(body.botId, 80)) : null;
    if (body.botId && !bot) throw fail(404, "That teammate doesn't exist.", "not-found");
    if (body.taskId) {
      const task = (await db.query("SELECT id FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, clean(body.taskId, 80)])).rows[0];
      if (!task) throw fail(404, "That task doesn't exist.", "not-found");
    }
    const row = await createArtifact(db, account.id, {
      name: clean(body.name, 160), type: clean(body.type, 120), content: body.content, encoding: body.encoding === "base64" ? "base64" : "utf8",
      taskId: body.taskId ? clean(body.taskId, 80) : null, botId: bot?.id || null, teamId: bot?.team_id || null, source: clean(body.source, 60) || "manual",
    });
    res.status(201).json({ artifact: publicArtifact(row) });
  }));

  router.get("/workforce/artifacts/:id", withAccount(async (req, res, db, account) => {
    const row = (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "artifact")])).rows[0];
    if (!row) throw fail(404, "That artifact doesn't exist.", "not-found");
    const root = row.parent_artifact_id || row.id;
    const versions = (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND (id = $2 OR parent_artifact_id = $2) ORDER BY version", [account.id, root])).rows.map(publicArtifact);
    res.json({ artifact: publicArtifact(row), versions });
  }));

  router.get("/workforce/artifacts/:id/content", withAccount(async (req, res, db, account) => {
    const row = (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "artifact")])).rows[0];
    if (!row) throw fail(404, "That artifact doesn't exist.", "not-found");
    const file = path.join(artifactRoot(account.id), row.id);
    const buffer = await fsp.readFile(file).catch(() => null);
    if (!buffer) throw fail(410, "The stored file is missing; the metadata is kept for the audit trail.", "file-missing");
    const type = TYPES.test(row.type || "") ? row.type : "application/octet-stream";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const disposition = req.query.download === "true" || !/^(text\/|image\/|application\/(json|pdf|xml))/.test(type) ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(row.name)}"`);
    res.end(buffer);
  }));

  router.post("/workforce/artifacts/:id/versions", withAccount(async (req, res, db, account) => {
    const parent = (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "artifact")])).rows[0];
    if (!parent) throw fail(404, "That artifact doesn't exist.", "not-found");
    const body = readBody(req);
    const rootId = parent.parent_artifact_id || parent.id;
    const latest = (await db.query("SELECT MAX(version) AS version FROM hannah_artifacts WHERE user_id = $1 AND (id = $2 OR parent_artifact_id = $2)", [account.id, rootId])).rows[0];
    const version = Number(latest?.version || parent.version) + 1;
    const artifactId = id("art");
    const type = TYPES.test(String(body.type)) ? String(body.type) : parent.type;
    const buffer = body.encoding === "base64" ? Buffer.from(String(body.content ?? ""), "base64") : Buffer.from(String(body.content ?? ""), "utf8");
    if (!buffer.length) throw fail(400, "A new version can't be empty.", "invalid");
    if (buffer.length > MAX_BYTES) throw fail(413, "Artifacts are limited to 16 MB.", "too-large");
    const dir = artifactRoot(account.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, artifactId), buffer, { mode: 0o600 });
    const at = Date.now();
    await db.query(
      `INSERT INTO hannah_artifacts (user_id, id, team_id, task_id, bot_id, name, type, size, sha256, storage_key, version, parent_artifact_id, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
      [account.id, artifactId, parent.team_id, parent.task_id, parent.bot_id, safeName(body.name || parent.name, type), type, buffer.length,
        crypto.createHash("sha256").update(buffer).digest("hex"), path.join(sha256(account.id).slice(0, 24), artifactId), version, rootId, clean(body.source, 60) || "revision", at],
    );
    await recordEvent(db, account.id, "artifact.versioned", { botId: parent.bot_id, taskId: parent.task_id, detail: { artifactId, rootId, version } });
    const row = (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [account.id, artifactId])).rows[0];
    res.status(201).json({ artifact: publicArtifact(row) });
  }));

  router.delete("/workforce/artifacts/:id", withAccount(async (req, res, db, account) => {
    const artifactId = requireId(req.params.id, "artifact");
    const row = (await db.query("SELECT * FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [account.id, artifactId])).rows[0];
    if (!row) throw fail(404, "That artifact doesn't exist.", "not-found");
    await fsp.rm(path.join(artifactRoot(account.id), artifactId), { force: true });
    await db.query("DELETE FROM hannah_artifacts WHERE user_id = $1 AND id = $2", [account.id, artifactId]);
    await recordEvent(db, account.id, "artifact.deleted", { botId: row.bot_id, taskId: row.task_id, detail: { artifactId, name: row.name } });
    res.json({ ok: true, removed: true });
  }));

  return router;
}

module.exports = { MAX_BYTES, artifactRoot, createArtifact, createArtifactsRouter, guessType, publicArtifact, safeName };
