"use strict";

/**
 * Interoperability and hardware packages over HTTP (signed-in accounts).
 *
 *   GET    /api/interop                         adapters, the fleet (normalized), mission types, features
 *   GET    /api/interop/capabilities            every robot × every mission: supported or why not
 *   POST   /api/interop/vda5050                 register a VDA 5050 vehicle   (a signed-in person)
 *   DELETE /api/interop/vda5050/:id             (a signed-in person)
 *   POST   /api/interop/connect                 (re)connect to the account's MQTT brokers
 *   GET    /api/interop/robots/:id
 *   POST   /api/interop/robots/:id/assess       { mission, params } → the checks' answer; nothing is sent
 *   POST   /api/interop/robots/:id/missions     { mission, params } → action interop.mission (approval as usual)
 *   POST   /api/interop/robots/:id/assist       { reason } → action interop.request_assistance (never needs approval)
 *   GET    /api/interop/missions                ?robot=
 *   GET    /api/interop/missions/:id · POST /api/interop/missions/:id/cancel
 *
 *   GET    /api/hardware-packages               packages, installs
 *   POST   /api/hardware-packages               { manifest, files: { path: base64 } } → verification; stored only when it passes   (a signed-in person)
 *   POST   /api/hardware-packages/install       { packageId, version, target } → action packages.install (always asks)
 *   POST   /api/hardware-packages/rollback      { packageId, target } → action packages.rollback (always asks)
 *   POST   /api/hardware-packages/revoke        { packageId, version?, reason }   (a signed-in person)
 *   POST   /api/hardware-packages/uninstall     { packageId, target }   (a signed-in person)
 */
const express = require("express");
const { getDatabase } = require("../db");
const capability = require("./capability");
const hardware = require("../marketplace/hardware-packages");
const { outcomeText } = require("../actions/engine");

function respond(res, error, fallback) {
  if (res.headersSent) return undefined;
  if (!error.status) console.error(`Interop request failed (${error?.code || error?.name || "error"}).`);
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.reason ? { reason: error.reason } : {}), ...(error.violations ? { violations: error.violations } : {}), ...(error.problems ? { problems: error.problems } : {}) });
}

function createInteropRouter({ interop, vda, packages, engine }) {
  const router = express.Router();
  const json = express.json({ limit: "8mb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to use robots.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key can't.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "This needs the account database.", reason: "no-database" });
    try { return await handler(req, res, db, account); } catch (error) { return respond(res, error, "That didn't work on the server."); }
  };
  const anyAccount = guard();
  const person = guard({ session: true });
  const act = async (db, account, action, params, request) => {
    const record = await engine.run(db, account.id, { action, params, request, source: account.via === "session" ? "robots" : "api-key", agent: "" });
    return { ...record, outcome: outcomeText(record) };
  };
  const status = (record) => (record.status === "waiting-approval" ? 202 : record.status === "denied" ? 409 : 200);

  router.get("/interop", anyAccount(async (_req, res, db, account) => res.json({ adapters: interop.adapters(), robots: await interop.listRobots(db, account.id), missions: capability.MISSIONS, features: capability.FEATURES, errors: capability.ERRORS })));
  router.get("/interop/capabilities", anyAccount(async (_req, res, db, account) => res.json({ robots: await interop.capabilityMatrix(db, account.id) })));
  router.post("/interop/vda5050", json, person(async (req, res, db, account) => {
    const robot = await vda.register(db, account.id, req.body || {});
    await vda.connectAccount(db, account.id).catch(() => null);
    res.status(201).json({ robot });
  }));
  router.delete("/interop/vda5050/:id", person(async (req, res, db, account) => res.json(await vda.remove(db, account.id, req.params.id))));
  router.post("/interop/connect", anyAccount(async (_req, res, db, account) => res.json(await vda.connectAccount(db, account.id))));
  router.get("/interop/robots/:id", anyAccount(async (req, res, db, account) => res.json({ robot: (await interop.resolve(db, account.id, req.params.id)).robot })));
  router.post("/interop/robots/:id/assess", json, anyAccount(async (req, res, db, account) => res.json({ verdict: await interop.assess(db, account.id, req.params.id, String(req.body?.mission || ""), req.body?.params || {}) })));
  router.post("/interop/robots/:id/missions", json, anyAccount(async (req, res, db, account) => {
    const record = await act(db, account, "interop.mission", { robot: req.params.id, mission: req.body?.mission, params: req.body?.params || {} }, "Mission from the Interop panel");
    res.status(status(record)).json({ record });
  }));
  router.post("/interop/robots/:id/assist", json, anyAccount(async (req, res, db, account) => res.json({ record: await act(db, account, "interop.request_assistance", { robot: req.params.id, reason: req.body?.reason }, "Stop and ask for help pressed") })));
  router.get("/interop/missions", anyAccount(async (req, res, db, account) => res.json({ missions: await interop.listMissions(db, account.id, { robotId: req.query.robot || null, limit: Number(req.query.limit) || 30 }) })));
  router.get("/interop/missions/:id", anyAccount(async (req, res, db, account) => res.json({ mission: await interop.getMission(db, account.id, req.params.id) })));
  router.post("/interop/missions/:id/cancel", anyAccount(async (req, res, db, account) => res.json({ record: await act(db, account, "interop.cancel_mission", { mission: req.params.id }, "Cancel pressed") })));

  router.get("/hardware-packages", anyAccount(async (_req, res, db, account) => res.json({ packages: await packages.list(db, account.id), installs: await packages.listInstalls(db, account.id), kinds: hardware.KINDS, permissions: hardware.PERMISSIONS })));
  router.post("/hardware-packages", json, person(async (req, res, db, account) => { const report = await packages.upload(db, account.id, req.body || {}); res.status(report.stored ? 201 : 422).json(report); }));
  router.post("/hardware-packages/install", json, anyAccount(async (req, res, db, account) => { const record = await act(db, account, "packages.install", req.body || {}, "Install pressed"); res.status(status(record)).json({ record }); }));
  router.post("/hardware-packages/rollback", json, anyAccount(async (req, res, db, account) => { const record = await act(db, account, "packages.rollback", req.body || {}, "Roll back pressed"); res.status(status(record)).json({ record }); }));
  router.post("/hardware-packages/revoke", json, person(async (req, res, db, account) => res.json(await packages.revoke(db, account.id, req.body || {}))));
  router.post("/hardware-packages/uninstall", json, person(async (req, res, db, account) => res.json(await packages.uninstall(db, account.id, req.body || {}))));
  return router;
}

module.exports = { createInteropRouter };
