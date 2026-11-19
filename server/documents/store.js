"use strict";

/**
 * Where an account's generated files and research live.
 *
 * - Every query names the user: one account can't list, read, change or
 *   delete another's rows, whatever id it sends.
 * - Retention: a file expires 30 days after it was made unless the person
 *   keeps it; expired rows are removed whenever the account's list is read
 *   or written. Research history keeps the latest 60 entries.
 * - Limits per account: 200 files and 250 MB; the oldest files the person
 *   didn't choose to keep make room for new ones.
 * - Versions: a revised document shares its family id with the one it
 *   revises and takes the next version number. Nothing is overwritten.
 */
const { randomBytes } = require("node:crypto");

const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_RESEARCH = 60;
const ID = /^[a-z]_[a-f0-9]{16,32}$/;
const newId = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

function publicDocument(row) {
  let summary = null;
  try { summary = row.summary ? JSON.parse(row.summary) : null; } catch { summary = null; }
  return { id: row.id, familyId: row.family_id, version: Number(row.version), name: row.name, format: row.format, mime: row.mime, bytes: Number(row.bytes), source: row.source, request: row.request || "", summary, createdAt: Number(row.created_at), expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at) };
}

async function prune(db, userId, now) {
  await db.query("DELETE FROM hannah_documents WHERE user_id = $1 AND expires_at IS NOT NULL AND expires_at < $2", [userId, now]);
}

/** Save a generated file. `file` is what createDocument returned. Resolves to its public record. */
async function saveDocument(db, userId, { file, spec = null, source = "chat", request = "", revises = null, now = Date.now() }) {
  if (file.bytes > MAX_FILE_BYTES) throw fail(413, `Files up to ${MAX_FILE_BYTES / 1024 / 1024} MB can be kept in your account. This one is still yours to download now.`, "too-large");
  await prune(db, userId, now);
  let familyId = newId("f");
  let version = 1;
  if (revises && ID.test(String(revises))) {
    const { rows } = await db.query("SELECT family_id FROM hannah_documents WHERE user_id = $1 AND id = $2", [userId, revises]);
    if (rows[0]) {
      familyId = rows[0].family_id;
      const latest = await db.query("SELECT MAX(version) AS version FROM hannah_documents WHERE user_id = $1 AND family_id = $2 AND format = $3", [userId, familyId, file.format]);
      version = (Number(latest.rows[0]?.version) || 0) + 1;
    }
  }
  // Make room: the oldest files the person didn't keep go first.
  const { rows: existing } = await db.query("SELECT id, bytes, expires_at FROM hannah_documents WHERE user_id = $1 ORDER BY created_at ASC", [userId]);
  let count = existing.length;
  let total = existing.reduce((sum, row) => sum + Number(row.bytes), 0);
  for (const row of existing) {
    if (count < MAX_FILES && total + file.bytes <= MAX_TOTAL_BYTES) break;
    if (row.expires_at === null || row.expires_at === undefined) continue;
    await db.query("DELETE FROM hannah_documents WHERE user_id = $1 AND id = $2", [userId, row.id]);
    count -= 1;
    total -= Number(row.bytes);
  }
  if (count >= MAX_FILES || total + file.bytes > MAX_TOTAL_BYTES) throw fail(507, "Your account's file space is full of files you chose to keep. Delete some in Files, then try again.", "quota");
  const id = newId("d");
  const specText = spec ? JSON.stringify(spec) : null;
  await db.query(
    "INSERT INTO hannah_documents (user_id, id, family_id, version, name, format, mime, bytes, content, spec, summary, source, request, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
    [userId, id, familyId, version, file.name, file.format, file.mime, file.bytes, file.buffer.toString("base64"), specText && specText.length <= 1_500_000 ? specText : null, JSON.stringify(file.summary || null).slice(0, 20_000), String(source).slice(0, 40), String(request || "").slice(0, 2000), now, now + KEEP_MS],
  );
  return publicDocument({ id, family_id: familyId, version, name: file.name, format: file.format, mime: file.mime, bytes: file.bytes, source, request, summary: JSON.stringify(file.summary || null), created_at: now, expires_at: now + KEEP_MS });
}

async function listDocuments(db, userId, now = Date.now()) {
  await prune(db, userId, now);
  const { rows } = await db.query("SELECT id, family_id, version, name, format, mime, bytes, source, request, summary, created_at, expires_at FROM hannah_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200", [userId]);
  return rows.map(publicDocument);
}

/** One of the user's documents with its bytes and description, or null. Expired files are gone. */
async function getDocument(db, userId, id, now = Date.now()) {
  if (!ID.test(String(id))) return null;
  const { rows } = await db.query("SELECT * FROM hannah_documents WHERE user_id = $1 AND id = $2 AND (expires_at IS NULL OR expires_at >= $3)", [userId, id, now]);
  if (!rows[0]) return null;
  let spec = null;
  try { spec = rows[0].spec ? JSON.parse(rows[0].spec) : null; } catch { spec = null; }
  return { ...publicDocument(rows[0]), buffer: Buffer.from(rows[0].content, "base64"), spec };
}

async function setKept(db, userId, id, keep, now = Date.now()) {
  if (!ID.test(String(id))) return null;
  const result = await db.query("UPDATE hannah_documents SET expires_at = $3 WHERE user_id = $1 AND id = $2", [userId, id, keep ? null : now + KEEP_MS]);
  return (result.rowCount ?? result.changes ?? 0) > 0 ? (await listDocuments(db, userId, now)).find((item) => item.id === id) || null : null;
}

async function deleteDocument(db, userId, id) {
  if (!ID.test(String(id))) return false;
  const result = await db.query("DELETE FROM hannah_documents WHERE user_id = $1 AND id = $2", [userId, id]);
  return (result.rowCount ?? result.changes ?? 0) > 0;
}

async function saveResearch(db, userId, result) {
  const text = JSON.stringify(result);
  if (text.length > 1_500_000) return null;
  await db.query("INSERT INTO hannah_research (user_id, id, question, mode, result, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [userId, result.id, String(result.question).slice(0, 2000), result.mode, text, result.createdAt]);
  const { rows } = await db.query("SELECT id FROM hannah_research WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
  for (const row of rows.slice(MAX_RESEARCH)) await db.query("DELETE FROM hannah_research WHERE user_id = $1 AND id = $2", [userId, row.id]);
  return result.id;
}

async function listResearch(db, userId) {
  const { rows } = await db.query("SELECT id, question, mode, created_at FROM hannah_research WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60", [userId]);
  return rows.map((row) => ({ id: row.id, question: row.question, mode: row.mode, createdAt: Number(row.created_at) }));
}

async function getResearch(db, userId, id) {
  if (!ID.test(String(id))) return null;
  const { rows } = await db.query("SELECT result FROM hannah_research WHERE user_id = $1 AND id = $2", [userId, id]);
  try { return rows[0] ? JSON.parse(rows[0].result) : null; } catch { return null; }
}

async function deleteResearch(db, userId, id) {
  if (!ID.test(String(id))) return false;
  const result = await db.query("DELETE FROM hannah_research WHERE user_id = $1 AND id = $2", [userId, id]);
  return (result.rowCount ?? result.changes ?? 0) > 0;
}

module.exports = { KEEP_MS, MAX_FILE_BYTES, deleteDocument, deleteResearch, getDocument, getResearch, listDocuments, listResearch, saveDocument, saveResearch, setKept };
