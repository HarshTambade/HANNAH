"use strict";

/**
 * Robots over HTTP. Two kinds of caller, two routers.
 *
 * The robot itself (createRobotDeviceRouter; mounted before the app's JSON
 * parser because the signature covers the exact body):
 *
 *   POST /api/robots/enroll          { code, descriptor } → { robotId, secret, … }   once per code
 *   POST /api/robots/device/sync     signed; { state, reports, events } → { commands }
 *
 * Neither uses an account session. Enrollment is proven by the one-time code
 * (and limited per network address); every later request by the robot's
 * signature. Nothing else under /api/robots is reachable without an account.
 *
 * The account (createRobotAccountRouter):
 *
 *   GET    /api/robots                         the registry
 *   GET    /api/robots/contract                the capability contract, robot types, environments
 *   POST   /api/robots                         { name, simulated } → robot + one-time enrollment code   (a signed-in person)
 *   GET    /api/robots/missions                ?robot= &active=1 &limit=
 *   GET    /api/robots/missions/:id
 *   POST   /api/robots/missions/:id/cancel     never needs approval
 *   GET    /api/robots/events                  ?robot=
 *   GET    /api/robots/:id                     robot, its recent missions and events
 *   PATCH  /api/robots/:id                     { name?, limits?, disabled?, alwaysAsk? }   (a signed-in person; limits only tighten)
 *   POST   /api/robots/:id/enrollment          a new one-time code (replaces the robot's secret when used)   (a signed-in person)
 *   POST   /api/robots/:id/revoke              end the robot's access now   (a signed-in person)
 *   DELETE /api/robots/:id                     (a signed-in person)
 *   POST   /api/robots/:id/stop                { reason? } → the action's record and the stop mission; never needs approval
 *   GET    /api/robots/:id/telemetry           ?minutes=
 *
 * Starting a mission is not here: it is an action (POST /api/actions with
 * robots.navigate_to and so on), so it goes through the permission manager,
 * approval and the audit history like everything else HANNAH does.
 */
const express = require("express");
const { getDatabase } = require("../db");
const { vaultConfigured } = require("../vault");
const contract = require("./contract");
const safety = require("./safety");
const { missionText } = require("../actions/catalog/robots");
const { outcomeText } = require("../actions/engine");

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

function respond(res, error, fallback) {
  if (res.headersSent) return undefined;
  if (!error.status) console.error(`Robot request failed (${error?.code || error?.name || "error"}).`);
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.reason ? { reason: error.reason } : {}), ...(error.candidates ? { candidates: error.candidates } : {}) });
}

function createRobotDeviceRouter({ robotics, enrollLimiter = null }) {
  const router = express.Router();
  const json = express.json({ limit: "256kb", verify: (req, _res, buffer) => { req.rawBody = buffer.toString("utf8"); } });
  const service = () => (typeof robotics === "function" ? robotics() : robotics);
  const database = async (res) => {
    const db = await getDatabase().catch(() => null);
    if (!db) res.status(503).json({ error: "Robots need the account database.", reason: "no-database" });
    return db;
  };

  router.post("/robots/enroll", ...(enrollLimiter ? [enrollLimiter] : []), json, async (req, res) => {
    const db = await database(res);
    if (!db) return undefined;
    try {
      return res.status(201).json(await service().enroll(db, { code: req.body?.code, descriptor: req.body?.descriptor }));
    } catch (error) {
      return respond(res, error, "Enrollment didn't work on the server.");
    }
  });

  router.post("/robots/device/sync", json, async (req, res) => {
    const db = await database(res);
    if (!db) return undefined;
    try {
      const robot = await service().authenticate(db, {
        robotId: req.get("x-hannah-robot"), time: req.get("x-hannah-time"), counter: req.get("x-hannah-counter"), signature: req.get("x-hannah-signature"),
        method: req.method, path: req.baseUrl + req.path, body: req.rawBody || "",
      });
      return res.json(await service().sync(db, robot, req.body || {}));
    } catch (error) {
      return respond(res, error, "The sync didn't work on the server.");
    }
  });
  return router;
}

function createRobotAccountRouter({ robotics, engine }) {
  const router = express.Router();
  const json = express.json({ limit: "200kb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to use robots. A robot belongs to an account.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key can't enroll, reconfigure or remove a robot.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Robots need the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      return respond(res, error, "That didn't work on the server.");
    }
  };
  const anyAccount = guard();
  const person = guard({ session: true });
  const withText = async (db, userId, mission) => {
    const robot = await robotics.getRobot(db, userId, mission.robotId).catch(() => null);
    return { ...mission, robotName: robot?.name || null, summary: missionText(mission, robot?.name) };
  };
  const command = (req) => `python3 -m hannah_robot enroll --server ${req.protocol}://${req.get("host")} --code `;

  router.get("/robots", anyAccount(async (_req, res, db, account) => res.json({ robots: await robotics.listRobots(db, account.id), canEnroll: vaultConfigured(), onlineWithinS: safety.ONLINE_MS / 1000 })));
  router.get("/robots/contract", anyAccount(async (_req, res) => res.json({ capabilities: contract.publicContract(), robotTypes: contract.ROBOT_TYPES, categories: contract.CATEGORIES, risks: contract.RISK, preconditions: contract.PRECONDITIONS, environments: safety.ENVIRONMENTS })));
  router.post("/robots", json, person(async (req, res, db, account) => {
    const created = await robotics.createRobot(db, account.id, { name: req.body?.name, simulated: req.body?.simulated });
    res.status(201).json({ ...created, command: `${command(req)}${created.enrollment.code}` });
  }));

  router.get("/robots/missions", anyAccount(async (req, res, db, account) => {
    const missions = await robotics.listMissions(db, account.id, { robotId: req.query.robot, active: Boolean(req.query.active), limit: req.query.limit });
    res.json({ missions: await Promise.all(missions.map((mission) => withText(db, account.id, mission))) });
  }));
  router.get("/robots/missions/:id", anyAccount(async (req, res, db, account) => res.json({ mission: await withText(db, account.id, await robotics.getMission(db, account.id, req.params.id)) })));
  router.post("/robots/missions/:id/cancel", anyAccount(async (req, res, db, account) => res.json({ mission: await withText(db, account.id, await robotics.cancelMission(db, account.id, req.params.id)) })));
  router.get("/robots/events", anyAccount(async (req, res, db, account) => res.json({ events: await robotics.events(db, account.id, { robotId: req.query.robot, limit: req.query.limit }) })));

  router.get("/robots/:id", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const [missions, events] = await Promise.all([robotics.listMissions(db, account.id, { robotId: robot.id, limit: 25 }), robotics.events(db, account.id, { robotId: robot.id, limit: 40 })]);
    res.json({ robot, missions: missions.map((mission) => ({ ...mission, robotName: robot.name, summary: missionText(mission, robot.name) })), events });
  }));
  router.patch("/robots/:id", json, person(async (req, res, db, account) => res.json({ robot: await robotics.updateRobot(db, account.id, req.params.id, { name: req.body?.name, limits: req.body?.limits, disabled: req.body?.disabled, alwaysAsk: req.body?.alwaysAsk }) })));
  router.post("/robots/:id/enrollment", person(async (req, res, db, account) => {
    const issued = await robotics.issueCode(db, account.id, req.params.id);
    res.status(201).json({ ...issued, command: `${command(req)}${issued.enrollment.code}` });
  }));
  router.post("/robots/:id/revoke", person(async (req, res, db, account) => res.json({ robot: await robotics.revokeRobot(db, account.id, req.params.id) })));
  router.delete("/robots/:id", person(async (req, res, db, account) => {
    if (!(await robotics.removeRobot(db, account.id, req.params.id))) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    res.json({ removed: true });
  }));
  router.post("/robots/:id/stop", json, anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const record = await engine.run(db, account.id, { action: "robots.stop_motion", params: { robot: robot.id, reason: req.body?.reason }, request: "Stop pressed", source: account.via === "session" ? "robots" : "api-key", agent: "" });
    const missionId = record.response?.missionId;
    res.json({ record: { ...record, outcome: outcomeText(record) }, mission: missionId ? await withText(db, account.id, await robotics.getMission(db, account.id, missionId)) : null });
  }));
  router.get("/robots/:id/telemetry", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    res.json({ samples: await robotics.telemetry(db, account.id, robot.id, { sinceMs: (Number(req.query.minutes) || 15) * 60_000 }) });
  }));
  return router;
}

module.exports = { createRobotAccountRouter, createRobotDeviceRouter };
