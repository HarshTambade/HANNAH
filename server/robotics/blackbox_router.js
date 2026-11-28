"use strict";

/**
 * The black box over HTTP.
 *
 * The robot (createBlackBoxDeviceRouter; mounted before the app's JSON parser,
 * because its signature covers the exact body, like /robots/device/sync):
 *
 *   POST /api/robots/device/blackbox     signed; { clock, events: [...≤200], segment? }
 *                                        → { accepted, duplicates, refused, segment, policy, serverTime }
 *
 * The account (createBlackBoxAccountRouter):
 *
 *   GET    /api/robots/:id/blackbox/settings
 *   PUT    /api/robots/:id/blackbox/settings              (a signed-in person)
 *   GET    /api/robots/:id/blackbox/events                ?from &to &mission &source &type &severity &q &limit &server=0
 *   GET    /api/robots/:id/blackbox/segments
 *   GET    /api/robots/:id/blackbox/segments/:segment     the recording file (sensitive: a signed-in person)
 *   GET    /api/robots/:id/blackbox/export                ?from &to   everything, as one JSON download
 *   DELETE /api/robots/:id/blackbox                       ?from &to   (a signed-in person)
 *   GET    /api/robots/:id/blackbox/incident              ?mission &at   "why did it stop?"
 *   POST   /api/robots/:id/blackbox/incident/narrative    { mission?, at? } the report and a model-written summary
 *   POST   /api/robots/:id/blackbox/incident/scenario     { mission?, at? } a regression scenario for the simulator
 *   GET    /api/robots/:id/blackbox/missions/:mission/replay   the mission as playback
 */
const express = require("express");
const { getDatabase } = require("../db");
const incident = require("./incident");

function respond(res, error, fallback) {
  if (res.headersSent) return undefined;
  if (!error.status) console.error(`Black box request failed (${error?.code || error?.name || "error"}).`);
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.reason ? { reason: error.reason } : {}) });
}

function createBlackBoxDeviceRouter({ robotics, blackbox }) {
  const router = express.Router();
  const service = (value) => (typeof value === "function" ? value() : value);
  // A segment may be up to 16 MB; base64 makes it a third larger.
  const json = express.json({ limit: "24mb", verify: (req, _res, buffer) => { req.rawBody = buffer.toString("utf8"); } });
  const recent = new Map();
  const flooding = (robotId) => {
    const at = Date.now();
    const entry = recent.get(robotId) || { from: at, count: 0 };
    if (at - entry.from > 10_000) { entry.from = at; entry.count = 0; }
    entry.count += 1;
    recent.set(robotId, entry);
    if (recent.size > 5000) for (const [key, value] of recent) if (at - value.from > 10_000) recent.delete(key);
    return entry.count > Math.max(5, Number(process.env.HANNAH_RATE_LIMIT_ROBOT_BLACKBOX_PER_10S) || 30);
  };
  router.post("/robots/device/blackbox", json, async (req, res) => {
    if (flooding(String(req.get("x-hannah-robot") || "").slice(0, 40))) return res.status(429).json({ error: "Too many uploads from this robot.", reason: "rate-limited" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "The black box needs the account database.", reason: "no-database" });
    try {
      const { row } = await service(robotics).authenticate(db, {
        robotId: req.get("x-hannah-robot"), time: req.get("x-hannah-time"), counter: req.get("x-hannah-counter"), signature: req.get("x-hannah-signature"),
        method: req.method, path: req.baseUrl + req.path, body: req.rawBody || "",
      });
      return res.json(await service(blackbox).ingest(db, row, req.body || {}));
    } catch (error) {
      return respond(res, error, "The upload didn't work on the server.");
    }
  });
  return router;
}

function createBlackBoxAccountRouter({ blackbox, createAsk = null }) {
  const router = express.Router();
  const json = express.json({ limit: "64kb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to see a robot's black box.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key can't change or delete a robot's black box.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "The black box needs the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account, { session: account.via === "session" });
    } catch (error) {
      return respond(res, error, "That didn't work on the server.");
    }
  };
  const anyAccount = guard();
  const person = guard({ session: true });
  const target = (req) => ({ missionId: String(req.body?.mission || req.query.mission || "").slice(0, 80) || null, at: Number(req.body?.at || req.query.at) || null });

  router.get("/robots/:id/blackbox/settings", anyAccount(async (req, res, db, account) => res.json(await blackbox.settingsView(db, account.id, req.params.id))));
  router.put("/robots/:id/blackbox/settings", json, person(async (req, res, db, account) => res.json(await blackbox.updateSettings(db, account.id, req.params.id, req.body || {}))));
  router.get("/robots/:id/blackbox/events", anyAccount(async (req, res, db, account, viewer) => res.json(await blackbox.timeline(db, account.id, req.params.id, req.query, viewer))));
  router.get("/robots/:id/blackbox/segments", anyAccount(async (req, res, db, account, viewer) => res.json({ segments: await blackbox.segments(db, account.id, req.params.id, viewer) })));
  router.get("/robots/:id/blackbox/segments/:segment", anyAccount(async (req, res, db, account, viewer) => {
    const file = await blackbox.segmentContent(db, account.id, req.params.id, req.params.segment, viewer);
    res.set("Content-Type", "application/gzip").set("Content-Disposition", `attachment; filename="${file.name}"`).set("Cache-Control", "no-store").send(file.buffer);
  }));
  router.get("/robots/:id/blackbox/export", anyAccount(async (req, res, db, account, viewer) => {
    const data = await blackbox.exportData(db, account.id, req.params.id, { from: req.query.from, to: req.query.to }, viewer);
    res.set("Content-Disposition", `attachment; filename="blackbox-${data.robot.id}-${new Date(data.exportedAt).toISOString().slice(0, 10)}.json"`).set("Cache-Control", "no-store").json(data);
  }));
  router.delete("/robots/:id/blackbox", person(async (req, res, db, account) => res.json(await blackbox.deleteData(db, account.id, req.params.id, { from: req.query.from, to: req.query.to }))));
  router.get("/robots/:id/blackbox/incident", anyAccount(async (req, res, db, account, viewer) => res.json({ report: await blackbox.investigateRobot(db, account.id, req.params.id, { ...target(req), ...viewer }) })));
  router.post("/robots/:id/blackbox/incident/narrative", json, anyAccount(async (req, res, db, account, viewer) => {
    const report = await blackbox.investigateRobot(db, account.id, req.params.id, { ...target(req), ...viewer });
    if (!createAsk) return res.json({ report, narrative: { ok: false, text: null, problems: ["No model is configured on this server. The report above stands on its own."] } });
    let ask;
    try { ask = createAsk(req, res); } catch (error) { return res.json({ report, narrative: { ok: false, text: null, problems: [error.message || "No model is available for this request."] } }); }
    const narrative = await incident.narrate(report, ask).catch((error) => ({ ok: false, text: null, problems: [`The model didn't answer: ${error.message}`] }));
    return res.json({ report, narrative });
  }));
  router.post("/robots/:id/blackbox/incident/scenario", json, anyAccount(async (req, res, db, account, viewer) => res.json(await blackbox.scenarioFor(db, account.id, req.params.id, { ...target(req), ...viewer }))));
  router.get("/robots/:id/blackbox/missions/:mission/replay", anyAccount(async (req, res, db, account, viewer) => res.json({ replay: await blackbox.replayMission(db, account.id, req.params.id, req.params.mission, viewer) })));
  return router;
}

module.exports = { createBlackBoxAccountRouter, createBlackBoxDeviceRouter };
