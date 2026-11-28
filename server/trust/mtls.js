"use strict";

/**
 * Mutual TLS for device links, where the deployment can terminate TLS itself.
 *
 * A serverless host (Vercel) terminates TLS in front of the app and never
 * shows it a client certificate, so mTLS there is not possible and is not
 * claimed. A server that listens itself can open a second, TLS-only listener
 * (HANNAH_DEVICE_MTLS_PORT with a server key and certificate) that asks every
 * client for a certificate. Accounts have their own CAs, so the listener does
 * not trust a fixed CA list: the handshake proves the client holds the
 * certificate's key, and requireClientCertificate() then checks the
 * certificate against the device's account CA, its dates, the revocation list
 * and the device's current certificate (trust/service.js).
 */
const https = require("node:https");

/**
 * Express middleware: the request must come over a TLS socket that presented
 * a client certificate HANNAH issued. Sets res.locals.device = { userId, deviceId, kind, serial }.
 * `matchHeader`: when set, a header (for example x-hannah-robot) that must name the same device.
 */
function requireClientCertificate({ trust, database, matchHeader = null }) {
  return async (req, res, next) => {
    const socket = req.socket;
    const peer = typeof socket?.getPeerX509Certificate === "function" ? socket.getPeerX509Certificate() : null;
    if (!peer) return res.status(401).json({ error: "This endpoint needs a client certificate.", reason: "no-certificate" });
    const db = await database().catch(() => null);
    if (!db) return res.status(503).json({ error: "Device links need the account database.", reason: "no-database" });
    try {
      const device = await trust.verifyClientCertificate(db, peer);
      if (matchHeader) {
        const claimed = String(req.get(matchHeader) || "");
        if (claimed && claimed !== device.deviceId) {
          await trust.audit(db, { userId: device.userId, deviceId: device.deviceId, kind: "mtls", decision: "refused", reason: `Certificate for ${device.deviceId} used to speak for ${claimed.slice(0, 80)}.` });
          return res.status(403).json({ error: "This certificate belongs to another device.", reason: "cross-device" });
        }
      }
      res.locals.device = device;
      return next();
    } catch (error) {
      return res.status(error.status || 401).json({ error: error.status ? error.message : "The client certificate wasn't accepted.", reason: error.reason || "bad-certificate" });
    }
  };
}

/** An HTTPS server that requests (and needs) a client certificate; trust is decided per request by requireClientCertificate. */
function createMtlsServer(app, { key, cert, minVersion = "TLSv1.3" }) {
  return https.createServer({ key, cert, requestCert: true, rejectUnauthorized: false, minVersion }, app);
}

module.exports = { createMtlsServer, requireClientCertificate };
