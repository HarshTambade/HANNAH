"use strict";

/**
 * In-app feedback intake.
 *
 * Delivery is intentionally explicit: a private Discord webhook, a MongoDB
 * collection, or both. The handler never reads `req.ip`, never forwards the
 * User-Agent, and never writes the feedback text to the server console. The
 * only fields persisted are the allow-listed values returned by
 * `validateFeedbackPayload`.
 */

const { randomUUID } = require("node:crypto");

const MAX_MESSAGE_LENGTH = 4000;
const MAX_APP_VERSION_LENGTH = 64;
const PLATFORMS = new Set(["iOS", "Android", "Web", "Desktop"]);
const INFERENCE_MODES = new Set(["Cloud", "Local"]);
const CATEGORIES = new Set(["bug", "idea", "privacy", "other"]);
const MODE_DETAIL_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_DIAGNOSTIC_ENTRIES = 100;
const DIAGNOSTIC_LEVELS = new Set(["info", "warn", "error"]);
const DIAGNOSTIC_SOURCE_PATTERN = /^[a-z]{1,20}$/;
const MONGO_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;

const mongoClients = new Map();

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function validateFeedbackPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON object containing your feedback message." };
  }

  const message = cleanString(body.message, MAX_MESSAGE_LENGTH + 1);
  if (!message) return { ok: false, error: "Write a feedback message before submitting." };
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Feedback must be ${MAX_MESSAGE_LENGTH} characters or fewer.` };
  }

  const rawMode = cleanString(body.inferenceMode, 20).toLowerCase();
  const inferenceMode = rawMode === "cloud" ? "Cloud" : rawMode === "local" ? "Local" : "";
  if (!inferenceMode) return { ok: false, error: "Inference mode must be Cloud or Local." };

  const platform = cleanString(body.platform, 20);
  if (!PLATFORMS.has(platform)) return { ok: false, error: "Platform must be iOS, Android, Web, or Desktop." };

  const appVersion = cleanString(body.appVersion, MAX_APP_VERSION_LENGTH) || "unknown";
  const category = cleanString(body.category, 20).toLowerCase() || "other";
  if (!CATEGORIES.has(category)) return { ok: false, error: "Feedback category is invalid." };

  const modeDetail = cleanString(body.modeDetail, 40).toLowerCase() || null;
  if (modeDetail && !MODE_DETAIL_PATTERN.test(modeDetail)) {
    return { ok: false, error: "Inference mode detail is invalid." };
  }

  // A diagnostic report the user chose to attach: only the allow-listed shape
  // is kept, so a report can't carry conversation text or keys even by mistake.
  let diagnostics = null;
  if (body.diagnostics !== undefined && body.diagnostics !== null) {
    diagnostics = cleanDiagnostics(body.diagnostics);
    if (!diagnostics) return { ok: false, error: "The attached diagnostic report is invalid." };
  }

  return {
    ok: true,
    value: {
      message,
      appVersion,
      platform,
      inferenceMode,
      ...(modeDetail ? { modeDetail } : {}),
      category,
      ...(diagnostics ? { diagnostics } : {}),
    },
  };
}

function cleanDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format !== "hannah-diagnostics") return null;
  const entries = Array.isArray(raw.entries) ? raw.entries.slice(-MAX_DIAGNOSTIC_ENTRIES) : [];
  const kept = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return null;
    const level = cleanString(entry.level, 10);
    const source = cleanString(entry.source, 20);
    if (!DIAGNOSTIC_LEVELS.has(level) || !DIAGNOSTIC_SOURCE_PATTERN.test(source)) return null;
    const at = Number(entry.at);
    kept.push({ at: Number.isFinite(at) ? at : 0, level, source, message: cleanString(entry.message, 300), ...(entry.detail ? { detail: cleanString(entry.detail, 1200) } : {}) });
  }
  const memory = raw.memory && typeof raw.memory === "object" && Number.isFinite(raw.memory.usedMB) ? { usedMB: Number(raw.memory.usedMB), limitMB: Number(raw.memory.limitMB) || 0 } : null;
  const storage = raw.storage && typeof raw.storage === "object" ? { keys: Number(raw.storage.keys) || 0, approxKB: Number(raw.storage.approxKB) || 0 } : null;
  return {
    createdAt: cleanString(raw.createdAt, 40),
    app: cleanString(raw.app, MAX_APP_VERSION_LENGTH),
    platform: cleanString(raw.platform, 20),
    userAgent: cleanString(raw.userAgent, 300),
    online: raw.online !== false,
    ...(memory ? { memory } : {}),
    ...(storage ? { storage } : {}),
    entries: kept,
  };
}

function buildFeedbackDocument(payload, { id = randomUUID(), receivedAt = new Date() } = {}) {
  // No IP address, User-Agent, account identifier, or chat transcript here.
  return {
    schemaVersion: 1,
    id,
    receivedAt: receivedAt.toISOString(),
    message: payload.message,
    appVersion: payload.appVersion,
    platform: payload.platform,
    inferenceMode: payload.inferenceMode,
    ...(payload.modeDetail ? { modeDetail: payload.modeDetail } : {}),
    category: payload.category,
    ...(payload.diagnostics ? { diagnostics: payload.diagnostics } : {}),
    source: "in-app",
  };
}

/** The attached report's most useful lines, for a chat embed. */
function summarizeDiagnostics(diagnostics) {
  const errors = diagnostics.entries.filter((entry) => entry.level === "error").slice(-3);
  const lines = [
    `${diagnostics.entries.length} entries · ${diagnostics.userAgent ? diagnostics.userAgent.slice(0, 80) : "no user agent"}${diagnostics.memory ? ` · ${diagnostics.memory.usedMB} MB heap` : ""}`,
    ...errors.map((entry) => `[${entry.source}] ${entry.message}`),
  ];
  return lines.join("\n").slice(0, 1024);
}

function buildDiscordPayload(document) {
  return {
    username: "HANNAH Feedback",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "New in-app feedback",
      color: 0x7c3aed,
      description: document.message.slice(0, 4000),
      timestamp: document.receivedAt,
      footer: { text: `feedback ${document.id}` },
      fields: [
        { name: "App version", value: document.appVersion.slice(0, 1024), inline: true },
        { name: "Platform", value: document.platform, inline: true },
        { name: "Inference", value: `${document.inferenceMode}${document.modeDetail ? ` (${document.modeDetail})` : ""}`, inline: true },
        { name: "Category", value: document.category, inline: true },
        ...(document.diagnostics ? [{ name: "Diagnostics (attached by the user)", value: summarizeDiagnostics(document.diagnostics), inline: false }] : []),
      ],
    }],
  };
}

async function deliverToDiscord(document, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const webhookUrl = env.FEEDBACK_DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) return null;
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    const error = new Error("The feedback webhook URL is invalid.");
    error.statusCode = 503;
    throw error;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    const error = new Error("The feedback webhook must use an HTTPS URL without embedded credentials.");
    error.statusCode = 503;
    throw error;
  }

  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildDiscordPayload(document)),
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
  });
  if (!response.ok) {
    const error = new Error("The feedback webhook rejected the message.");
    error.statusCode = 502;
    error.webhookStatus = response.status;
    throw error;
  }
  return { channel: "discord" };
}

function mongoConfiguration(env) {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) return null;
  const dbName = env.MONGODB_DB?.trim() || "hannah";
  const collectionName = env.MONGODB_FEEDBACK_COLLECTION?.trim() || "feedback";
  if (!MONGO_NAME_PATTERN.test(dbName) || !MONGO_NAME_PATTERN.test(collectionName)) {
    const error = new Error("The MongoDB database or feedback collection name is invalid.");
    error.statusCode = 503;
    throw error;
  }
  return { uri, dbName, collectionName };
}

function getMongoClient(uri) {
  let cached = mongoClients.get(uri);
  if (cached) return cached;
  let MongoClient;
  try {
    ({ MongoClient } = require("mongodb"));
  } catch {
    const error = new Error("MongoDB feedback storage requires the mongodb package.");
    error.statusCode = 503;
    throw error;
  }
  cached = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    maxPoolSize: 5,
  });
  mongoClients.set(uri, cached);
  return cached;
}

async function deliverToMongo(document, { env = process.env } = {}) {
  const config = mongoConfiguration(env);
  if (!config) return null;
  const client = getMongoClient(config.uri);
  await client.connect();
  await client.db(config.dbName).collection(config.collectionName).insertOne({ ...document });
  return { channel: "mongodb" };
}

function createFeedbackHandler({ now = () => new Date(), idFactory = randomUUID, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function feedbackHandler(req, res) {
    const validation = validateFeedbackPayload(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const channels = [];
    if (env.FEEDBACK_DISCORD_WEBHOOK_URL?.trim()) channels.push("discord");
    if (env.MONGODB_URI?.trim()) channels.push("mongodb");
    if (channels.length === 0) {
      return res.status(503).json({ error: "Feedback delivery is not configured on this server." });
    }

    const document = buildFeedbackDocument(validation.value, { id: idFactory(), receivedAt: now() });
    const deliveries = [];
    if (channels.includes("discord")) deliveries.push(deliverToDiscord(document, { env, fetchImpl }));
    if (channels.includes("mongodb")) deliveries.push(deliverToMongo(document, { env }));
    const results = await Promise.allSettled(deliveries);
    const delivered = results.filter((result) => result.status === "fulfilled" && result.value).length;

    for (const result of results) {
      if (result.status !== "rejected") continue;
      // Log only the failure class/status. Never log the webhook URL, message,
      // database URI, or anything that could identify the reporter.
      const status = result.reason?.webhookStatus || result.reason?.statusCode;
      console.warn(`[feedback] Delivery failed${status ? ` (status ${status})` : ""}.`);
    }

    if (delivered === 0) {
      return res.status(502).json({ error: "Feedback could not be delivered. Please try again later." });
    }
    return res.status(202).json({ ok: true, id: document.id });
  };
}

async function closeFeedbackStores() {
  const clients = [...mongoClients.values()];
  mongoClients.clear();
  await Promise.allSettled(clients.map((client) => client.close()));
}

module.exports = {
  buildDiscordPayload,
  buildFeedbackDocument,
  closeFeedbackStores,
  createFeedbackHandler,
  validateFeedbackPayload,
};
