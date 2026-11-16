"use strict";

/**
 * Opaque encrypted memory sync.
 *
 * The server never decrypts payloads. Clients send end-to-end encrypted blobs
 * keyed by a sync ID; the server stores and returns them verbatim.
 */

const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const stores = new Map();

function validateSyncPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send a JSON object containing sync data." };
  }
  const syncId = typeof body.syncId === "string" ? body.syncId.trim() : "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(syncId)) {
    return { ok: false, error: "A valid syncId is required." };
  }
  if (typeof body.blob !== "string" || !body.blob) {
    return { ok: false, error: "An encrypted blob is required." };
  }
  const bytes = Buffer.byteLength(body.blob, "utf8");
  if (bytes > MAX_BLOB_BYTES) {
    return { ok: false, error: "Encrypted payload is too large." };
  }
  return { ok: true, value: { syncId, blob: body.blob, version: Number(body.version) || 0 } };
}

function createSyncHandler() {
  return async function syncHandler(req, res) {
    const validation = validateSyncPayload(req.body);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { syncId, blob, version } = validation.value;
    const existing = stores.get(syncId);
    if (existing && version > 0 && version <= existing.version) {
      return res.status(409).json({ error: "Stale sync version.", version: existing.version });
    }
    const record = { blob, version: version || (existing ? existing.version + 1 : 1), updatedAt: new Date().toISOString() };
    stores.set(syncId, record);
    return res.status(200).json({ ok: true, version: record.version, updatedAt: record.updatedAt });
  };
}

function createSyncFetchHandler() {
  return async function syncFetchHandler(req, res) {
    const syncId = String(req.query.syncId || "").trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(syncId)) {
      return res.status(400).json({ error: "A valid syncId is required." });
    }
    const record = stores.get(syncId);
    if (!record) return res.status(404).json({ error: "No synced memory found." });
    return res.status(200).json({ ok: true, blob: record.blob, version: record.version, updatedAt: record.updatedAt });
  };
}

module.exports = { createSyncHandler, createSyncFetchHandler, validateSyncPayload };
```<|end|><|start|>asset<|channel|>analysis<|message|>Mount routes in index.js. Need add require and app.post/get. Let's edit.<|end|><|start|>Assistant to=shell<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="command">
cd "/Users/harshtambade/Development/HANNAH - AI companion " && python3 - <<'PY'
p='server/index.js'
s=open(p).read()
s=s.replace('const { createContentReportHandler } = require("./content-reports");',
            'const { createContentReportHandler } = require("./content-reports");\nconst { createSyncHandler, createSyncFetchHandler } = require("./cloud-sync");')
# add POST route near feedback route
s=s.replace('app.post("/api/feedback", createFeedbackHandler());',
            'app.post("/api/feedback", createFeedbackHandler());\napp.post("/api/sync/memory", createSyncHandler());\napp.get("/api/sync/memory", createSyncFetchHandler());')
open(p,'w').write(s)
print('done')
PY
grep -n "cloud-sync\|sync/memory" server/index.js