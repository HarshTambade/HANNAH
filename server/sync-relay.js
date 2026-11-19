/**
 * A self-hosted relay for HANNAH's device-to-device sync (client/src/services/
 * SyncService.ts and CRDTSyncProvider.ts). It only ever holds envelopes the
 * devices encrypted with your sync passphrase (AES-256-GCM); it can't read them.
 *
 *   POST /sync               { deviceId, envelope }  → { stored: true }
 *   GET  /sync/<deviceId>                            → { envelopes: [...] } from the other devices
 *
 * Run it with `node server/sync-relay.js` (SYNC_RELAY_PORT, default 8787).
 * Envelopes are kept in memory: the newest 100 per device, 1,000 devices,
 * 1 MB per envelope.
 */
const http = require("http");

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PER_DEVICE = 100;
const MAX_DEVICES = 1000;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function createRelayServer() {
  /** deviceId → envelopes it sent, oldest first. */
  const store = new Map();

  const send = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      // Browsers call the relay from HANNAH's own origin; the payloads are encrypted.
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  return http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    if (req.method === "OPTIONS") return send(res, 204);

    if (req.method === "POST" && path === "/sync") {
      let size = 0;
      const chunks = [];
      let tooLarge = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { tooLarge = true; req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) return;
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(res, 400, { error: "Send JSON: { deviceId, envelope }." });
        }
        const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
        const envelope = body?.envelope;
        if (!DEVICE_ID.test(deviceId)) return send(res, 400, { error: "deviceId is missing or invalid." });
        if (!envelope || typeof envelope !== "object" || typeof envelope.ciphertext !== "string") return send(res, 400, { error: "envelope must be an encrypted envelope." });
        if (!store.has(deviceId) && store.size >= MAX_DEVICES) {
          // Make room: forget the device that synced least recently.
          store.delete(store.keys().next().value);
        }
        const list = store.get(deviceId) ?? [];
        store.delete(deviceId);
        list.push(envelope);
        store.set(deviceId, list.slice(-MAX_PER_DEVICE));
        send(res, 200, { stored: true });
      });
      req.on("close", () => { if (tooLarge && !res.headersSent) send(res, 413, { error: "The envelope is larger than 1 MB." }); });
      return;
    }

    if (req.method === "GET" && path.startsWith("/sync/")) {
      const deviceId = decodeURIComponent(path.slice("/sync/".length));
      if (!DEVICE_ID.test(deviceId)) return send(res, 400, { error: "deviceId is invalid." });
      const envelopes = [];
      for (const [id, list] of store) if (id !== deviceId) envelopes.push(...list);
      return send(res, 200, { envelopes: envelopes.slice(-500) });
    }

    send(res, 404, { error: "Not found." });
  });
}

if (require.main === module) {
  const port = Number(process.env.SYNC_RELAY_PORT || 8787);
  createRelayServer().listen(port, () => {
    console.log(`Sync relay listening on ${port}; it stores encrypted envelopes only.`);
  });
}

module.exports = { createRelayServer };
