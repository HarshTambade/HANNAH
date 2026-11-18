"use strict";

/**
 * Metadata-only AI content reports.
 *
 * Google Play requires a way to flag AI-generated content. The client sends the
 * assistant message id and a reason; the assistant's text is deliberately never
 * accepted by this endpoint. Reports are appended to a JSONL file so operators
 * can review them without turning the log into a second conversation store.
 */

const { randomUUID } = require("node:crypto");
const { appendFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

const MAX_APP_VERSION_LENGTH = 64;
const MAX_REPORTS = new Set(["harmful", "sexual", "misinformation", "other"]);
const PLATFORMS = new Set(["iOS", "Android", "Web", "Desktop"]);
const MODE_DETAIL_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function validateContentReportPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON object containing the content report." };
  }

  const messageId = cleanString(body.messageId, 129);
  if (!messageId || !MESSAGE_ID_PATTERN.test(messageId)) {
    return { ok: false, error: "A valid message id is required." };
  }

  const reason = cleanString(body.reason, 32).toLowerCase();
  if (!MAX_REPORTS.has(reason)) {
    return { ok: false, error: "The report reason is invalid." };
  }

  const rawMode = cleanString(body.inferenceMode, 20).toLowerCase();
  const inferenceMode = rawMode === "cloud" ? "Cloud" : rawMode === "local" ? "Local" : "";
  if (!inferenceMode) {
    return { ok: false, error: "Inference mode must be Cloud or Local." };
  }

  const platform = cleanString(body.platform, 20);
  if (!PLATFORMS.has(platform)) {
    return { ok: false, error: "Platform must be iOS, Android, Web, or Desktop." };
  }

  const appVersion = cleanString(body.appVersion, MAX_APP_VERSION_LENGTH) || "unknown";
  const modeDetail = cleanString(body.modeDetail, 40).toLowerCase() || null;
  if (modeDetail && !MODE_DETAIL_PATTERN.test(modeDetail)) {
    return { ok: false, error: "Inference mode detail is invalid." };
  }

  return {
    ok: true,
    value: {
      messageId,
      reason,
      appVersion,
      platform,
      inferenceMode,
      ...(modeDetail ? { modeDetail } : {}),
    },
  };
}

function buildContentReportDocument(payload, { id = randomUUID(), receivedAt = new Date() } = {}) {
  // No message text, IP address, User-Agent, account id, or transcript here.
  return {
    schemaVersion: 1,
    id,
    receivedAt: receivedAt.toISOString(),
    messageId: payload.messageId,
    reason: payload.reason,
    appVersion: payload.appVersion,
    platform: payload.platform,
    inferenceMode: payload.inferenceMode,
    ...(payload.modeDetail ? { modeDetail: payload.modeDetail } : {}),
    source: "in-app-ai-content-report",
  };
}

function defaultContentReportLogPath() {
  return path.resolve(process.env.CONTENT_REPORT_LOG?.trim() || path.join(process.cwd(), "logs", "content_reports.jsonl"));
}

async function appendContentReport(document, { logPath = defaultContentReportLogPath() } = {}) {
  const resolved = path.resolve(logPath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await appendFile(resolved, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
  return resolved;
}

/** HANNAH's own database, when the server has one: serverless hosts can't keep a local file. */
async function saveContentReport(document) {
  const { getDatabase } = require("./db");
  const db = await getDatabase();
  await db.query(
    "INSERT INTO hannah_content_reports (id, message_id, reason, app_version, platform, inference_mode, mode_detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [document.id, document.messageId, document.reason, document.appVersion, document.platform, document.inferenceMode, document.modeDetail || null, Date.parse(document.receivedAt) || Date.now()],
  );
}

function createContentReportHandler({ logPath, useDatabase = () => require("./db").databaseConfigured() } = {}) {
  return async function contentReportHandler(req, res) {
    const validated = validateContentReportPayload(req.body);
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const document = buildContentReportDocument(validated.value);
    try {
      // A log file the operator chose wins; otherwise the database; otherwise the default file.
      const chosenFile = Boolean(logPath || process.env.CONTENT_REPORT_LOG?.trim());
      if (!chosenFile && useDatabase()) await saveContentReport(document);
      else if (!chosenFile && process.env.VERCEL) {
        // A serverless host has no lasting disk: say so instead of losing the report.
        return res.status(503).json({ error: "Reporting needs this server's database. The operator can connect one in Settings → Account." });
      } else await appendContentReport(document, { logPath });
      return res.status(202).json({ ok: true, id: document.id });
    } catch {
      // Never log the report body or a user identifier. The operator alert is
      // the failed write itself, not the content of the report.
      console.error("HANNAH content report could not be written.");
      return res.status(500).json({ error: "The content report could not be saved. Please try again later." });
    }
  };
}

module.exports = {
  appendContentReport,
  buildContentReportDocument,
  createContentReportHandler,
  defaultContentReportLogPath,
  validateContentReportPayload,
};
