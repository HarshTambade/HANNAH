"use strict";

/**
 * Zero-trust device identity over HTTP.
 *
 * The device itself (no account session; see trust/service.js for each proof):
 *   POST /api/trust/device/enroll       { deviceId, code, publicKey, hardwareId?, signature } → certificate
 *   POST /api/trust/device/credential   { deviceId, time, nonce, scope?, signature } → short-lived credential
 *   POST /api/trust/device/rotate       { deviceId, time, nonce, publicKey, signature, newKeySignature } → new certificate
 *   GET  /api/trust/device/whoami       Authorization: Bearer <credential>; X-Hannah-Device must match
 *
 * The account:
 *   GET    /api/trust/devices                   identities, policy, revocations
 *   POST   /api/trust/devices                   { deviceId, kind, hardwareId? } → one-time code   (a signed-in person)
 *   POST   /api/trust/devices/:id/revoke        (a signed-in person)
 *   DELETE /api/trust/devices/:id/quarantine    dismiss a quarantined device   (a signed-in person)
 *   GET    /api/trust/audit                     ?device=
 *   GET    /api/trust/policy · PUT (a signed-in person)
 *   GET    /api/trust/ca                        the account's device CA certificate
 *   POST   /api/trust/robots/:id/sros2          { enclavePublicKeys?, days? } → SROS 2 keystore files   (a signed-in person)
 *   GET    /api/trust/robots/:id/dds-network    firewall policy and exposure findings
 */
const express = require("express");
const { getDatabase } = require("../db");
const sros2 = require("./sros2");
const dds = require("./dds-network");

function respond(res, error, fallback) {
  if (res.headersSent) return undefined;
  if (!error.status) console.error(`Trust request failed (${error?.code || error?.name || "error"}).`);
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.reason ? { reason: error.reason } : {}) });
}

function createTrustRouter({ trust, robotics, deviceLimiter = null }) {
  const router = express.Router();
  const json = express.json({ limit: "64kb" });
  const limited = deviceLimiter ? [deviceLimiter] : [];
  const database = async (res) => {
    const db = await getDatabase().catch(() => null);
    if (!db) res.status(503).json({ error: "Device identity needs the account database.", reason: "no-database" });
    return db;
  };
  const device = (handler) => async (req, res) => {
    const db = await database(res);
    if (!db) return undefined;
    try { return await handler(req, res, db); } catch (error) { return respond(res, error, "That didn't work on the server."); }
  };
  router.post("/trust/device/enroll", ...limited, json, device(async (req, res, db) => res.status(201).json(await trust.enroll(db, req.body || {}))));
  router.post("/trust/device/credential", ...limited, json, device(async (req, res, db) => res.status(201).json(await trust.issueCredential(db, req.body || {}))));
  router.post("/trust/device/rotate", ...limited, json, device(async (req, res, db) => res.json(await trust.rotate(db, req.body || {}))));
  router.get("/trust/device/whoami", ...limited, device(async (req, res, db) => {
    const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const who = await trust.authenticate(db, token, { deviceId: req.get("x-hannah-device") || null });
    res.json({ deviceId: who.deviceId, kind: who.kind, scope: who.scope, expiresAt: who.expiresAt });
  }));

  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to manage device identities.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key can't register, revoke or reconfigure devices.", reason: "session-required" });
    const db = await database(res);
    if (!db) return undefined;
    try { return await handler(req, res, db, account); } catch (error) { return respond(res, error, "That didn't work on the server."); }
  };
  const anyAccount = guard();
  const person = guard({ session: true });

  router.get("/trust/devices", anyAccount(async (_req, res, db, account) => res.json({ identities: await trust.listIdentities(db, account.id), policy: await trust.getPolicy(db, account.id), revocations: await trust.revocations(db, account.id) })));
  router.post("/trust/devices", json, person(async (req, res, db, account) => res.status(201).json(await trust.registerDevice(db, account.id, req.body || {}))));
  router.post("/trust/devices/:id/revoke", json, person(async (req, res, db, account) => res.json({ identity: await trust.revoke(db, account.id, req.params.id, req.body?.reason || undefined) })));
  router.delete("/trust/devices/:id/quarantine", person(async (req, res, db, account) => res.json(await trust.dismissQuarantined(db, account.id, req.params.id))));
  router.get("/trust/audit", anyAccount(async (req, res, db, account) => res.json({ audit: await trust.listAudit(db, account.id, { deviceId: req.query.device || null, limit: req.query.limit }) })));
  router.get("/trust/policy", anyAccount(async (_req, res, db, account) => res.json({ policy: await trust.getPolicy(db, account.id) })));
  router.put("/trust/policy", json, person(async (req, res, db, account) => res.json({ policy: await trust.setPolicy(db, account.id, req.body || {}) })));
  router.get("/trust/ca", anyAccount(async (_req, res, db, account) => res.json({ certificate: await trust.caCertificate(db, account.id) })));

  router.post("/trust/robots/:id/sros2", json, person(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const ca = await trust.ensureCA(db, account.id, `dds:${robot.id}`, { commonName: "sros2CA" });
    const days = Math.max(1, Math.min(3650, Number(req.body?.days) || 365));
    const keys = req.body?.enclavePublicKeys && typeof req.body.enclavePublicKeys === "object" ? req.body.enclavePublicKeys : {};
    const keystore = sros2.generateKeystore(sros2.profileFromRobot(robot), { ca, enclavePublicKeys: keys, days });
    await trust.audit(db, { userId: account.id, deviceId: robot.id, kind: "sros2-keystore", decision: "created", reason: `SROS 2 keystore generated: ${keystore.enclaves.length} enclaves, ${keystore.enclaves.filter((item) => item.certificate.keyGenerated).length} with keys made by the server.` });
    res.status(201).json({ robot: { id: robot.id, name: robot.name, simulated: robot.simulated }, ...keystore, network: dds.rosEnvironment({ rosDistro: robot.rosDistro }) });
  }));
  router.get("/trust/robots/:id/dds-network", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const profile = sros2.profileFromRobot(robot);
    const reported = robot.state?.network || null;
    res.json({
      domainId: profile.domainId, ports: dds.ddsPorts(profile.domainId), environment: dds.rosEnvironment({ rosDistro: robot.rosDistro }),
      firewall: dds.nftablesPolicy({ domainId: profile.domainId, lanSubnets: Array.isArray(robot.network?.lanSubnets) ? robot.network.lanSubnets : [] }),
      exposure: reported && Array.isArray(reported.listeners) ? dds.checkExposure({ domainId: profile.domainId, listeners: reported.listeners, interfaces: reported.interfaces || [] }) : { exposed: null, findings: [], basis: "The robot hasn't reported what it listens on." },
      rule: "DDS is never exposed to the internet: the robot link to HANNAH is outbound HTTPS, and DDS stays on the robot and its private network.",
    });
  }));
  return router;
}

module.exports = { createTrustRouter };
