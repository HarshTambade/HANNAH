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
 *   GET    /api/robots/:id/resources           ?hours= &task= &context=   edge resources report, history, model advice
 *
 * Starting a mission is not here: it is an action (POST /api/actions with
 * robots.navigate_to and so on), so it goes through the permission manager,
 * approval and the audit history like everything else HANNAH does.
 */
const express = require("express");
const { getDatabase } = require("../db");
const { vaultConfigured } = require("../vault");
const contract = require("./contract");
const fleet = require("./fleet");
const plans = require("./plans");
const safety = require("./safety");
const { missionText } = require("../actions/catalog/robots");
const { outcomeText } = require("../actions/engine");
const { resourcesView } = require("../edge/view");

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

  // A robot exchanges about once a second. Far more than that from one robot id is a fault or an attack; it is refused before any work is done.
  const floodLimit = Math.max(10, Number(process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S) || 100);
  const recent = new Map();
  const flooding = (robotId) => {
    const at = Date.now();
    const entry = recent.get(robotId) || { from: at, count: 0 };
    if (at - entry.from > 5000) { entry.from = at; entry.count = 0; }
    entry.count += 1;
    recent.set(robotId, entry);
    if (recent.size > 5000) for (const [key, value] of recent) { if (at - value.from > 5000) recent.delete(key); }
    return entry.count > floodLimit;
  };
  router.post("/robots/device/sync", json, async (req, res) => {
    if (flooding(String(req.get("x-hannah-robot") || "").slice(0, 40))) return res.status(429).json({ error: "Too many requests from this robot.", reason: "rate-limited" });
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

function createRobotAccountRouter({ robotics, engine, robotOSEnvelopes = null, robotOSCommands = null, blackbox = null }) {
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

  const shown = ({ commissioningRecord: _record, ...robot }) => robot;
  router.get("/robots", anyAccount(async (_req, res, db, account) => res.json({ robots: (await robotics.listRobots(db, account.id)).map(shown), canEnroll: vaultConfigured(), onlineWithinS: safety.ONLINE_MS / 1000 })));
  router.get("/robots/fleet", anyAccount(async (_req, res, db, account) => {
    const [robots, active] = await Promise.all([robotics.listRobots(db, account.id), robotics.listMissions(db, account.id, { active: true, limit: 100 })]);
    res.json({ robots: fleet.overview(robots, active) });
  }));
  router.get("/robots/analytics", anyAccount(async (req, res, db, account) => res.json({ analytics: await robotics.analytics(db, account.id, { days: req.query.days }) })));
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
  // Pause never needs approval. Resume moves the robot again, so it is an action that may wait for one.
  const controlled = (action) => anyAccount(async (req, res, db, account) => {
    const record = await engine.run(db, account.id, { action, params: { mission: req.params.id }, request: action === "robots.resume_mission" ? "Resume pressed" : "Pause pressed", source: account.via === "session" ? "robots" : "api-key", agent: "" });
    res.status(record.status === "waiting-approval" ? 202 : 200).json({ record: { ...record, outcome: outcomeText(record) }, mission: await withText(db, account.id, await robotics.getMission(db, account.id, req.params.id)) });
  });
  router.post("/robots/missions/:id/pause", controlled("robots.pause_mission"));
  router.post("/robots/missions/:id/resume", controlled("robots.resume_mission"));
  // Plans: several steps under one approval. Starting one is an action (it may wait for approval); cancelling never does.
  const planView = async (db, userId, plan) => {
    const robot = await robotics.getRobot(db, userId, plan.robotId).catch(() => null);
    return { ...plan, robotName: robot?.name || null, summary: plans.planText(plan, robot?.name) };
  };
  router.get("/robots/plans", anyAccount(async (req, res, db, account) => {
    const found = await robotics.listPlans(db, account.id, { robotId: req.query.robot, active: Boolean(req.query.active), limit: req.query.limit });
    res.json({ plans: await Promise.all(found.map((plan) => planView(db, account.id, plan))) });
  }));
  router.get("/robots/plans/:id", anyAccount(async (req, res, db, account) => res.json({ plan: await planView(db, account.id, await robotics.getPlan(db, account.id, req.params.id)) })));
  router.post("/robots/plans/:id/cancel", anyAccount(async (req, res, db, account) => {
    const record = await engine.run(db, account.id, { action: "robots.cancel_plan", params: { plan: req.params.id }, request: "Cancel plan pressed", source: account.via === "session" ? "robots" : "api-key", agent: "" });
    res.json({ record: { ...record, outcome: outcomeText(record) }, plan: await planView(db, account.id, await robotics.getPlan(db, account.id, req.params.id)) });
  }));
  router.get("/robots/events", anyAccount(async (req, res, db, account) => res.json({ events: await robotics.events(db, account.id, { robotId: req.query.robot, limit: req.query.limit }) })));
  // Signed envelopes from onboard HANNAH Robot OS, scoped to this account.
  router.get("/robots/os/envelopes", anyAccount(async (req, res, db, account) => {
    if (!robotOSEnvelopes) return res.status(503).json({ error: "Robot OS envelope storage isn't available.", reason: "not-configured" });
    res.json({ envelopes: await robotOSEnvelopes.listEnvelopes(db, account.id, { robotId: req.query.robot, kind: req.query.kind, limit: req.query.limit }) });
  }));
  router.get("/robots/os/commands", anyAccount(async (req, res, db, account) => {
    if (!robotOSCommands) return res.status(503).json({ error: "Robot OS commands aren't available.", reason: "not-configured" });
    const rows = await db.query("SELECT id, robot_id, capability, status, ack_reason, issued_at, expires_at FROM hannah_robot_os_commands WHERE user_id = $1 ORDER BY issued_at DESC LIMIT $2", [account.id, Math.max(1, Math.min(200, Number(req.query.limit) || 50))]);
    res.json({ commands: (rows.rows || []).map((row) => ({ id: row.id, robotId: row.robot_id, capability: row.capability, status: row.status, ackReason: row.ack_reason || "", issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at) })) });
  }));

  router.get("/robots/:id", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const [missions, events] = await Promise.all([robotics.listMissions(db, account.id, { robotId: robot.id, limit: 25 }), robotics.events(db, account.id, { robotId: robot.id, limit: 40 })]);
    res.json({ robot: shown(robot), missions: missions.map((mission) => ({ ...mission, robotName: robot.name, summary: missionText(mission, robot.name) })), events });
  }));
  router.patch("/robots/:id", json, person(async (req, res, db, account) => res.json({ robot: await robotics.updateRobot(db, account.id, req.params.id, { name: req.body?.name, limits: req.body?.limits, disabled: req.body?.disabled, alwaysAsk: req.body?.alwaysAsk, camera: req.body?.camera }) })));
  router.post("/robots/:id/enrollment", person(async (req, res, db, account) => {
    const issued = await robotics.issueCode(db, account.id, req.params.id);
    res.status(201).json({ ...issued, command: `${command(req)}${issued.enrollment.code}` });
  }));
  router.post("/robots/:id/revoke", person(async (req, res, db, account) => res.json({ robot: await robotics.revokeRobot(db, account.id, req.params.id) })));
  router.delete("/robots/:id", person(async (req, res, db, account) => {
    if (!(await robotics.removeRobot(db, account.id, req.params.id))) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    // Its black box (events, recordings and their files) goes with it.
    if (blackbox) await blackbox.removeRobotData(db, account.id, req.params.id);
    res.json({ removed: true });
  }));
  router.post("/robots/:id/stop", json, anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const record = await engine.run(db, account.id, { action: "robots.stop_motion", params: { robot: robot.id, reason: req.body?.reason }, request: "Stop pressed", source: account.via === "session" ? "robots" : "api-key", agent: "" });
    const missionId = record.response?.missionId;
    res.json({ record: { ...record, outcome: outcomeText(record) }, mission: missionId ? await withText(db, account.id, await robotics.getMission(db, account.id, missionId)) : null });
  }));
  // Commissioning: the checks a physical robot passes before it may move. Only a signed-in person confirms a step.
  router.get("/robots/:id/commissioning", anyAccount(async (req, res, db, account) => res.json({ commissioning: await robotics.commissioningView(db, account.id, req.params.id) })));
  router.post("/robots/:id/commissioning/reset", json, person(async (req, res, db, account) => res.json({ commissioning: await robotics.resetCommissioning(db, account.id, req.params.id, req.body?.reason) })));
  router.post("/robots/:id/commissioning/:step", json, person(async (req, res, db, account) => res.json({ commissioning: await robotics.confirmCommissioning(db, account.id, req.params.id, req.params.step, { note: req.body?.note, attest: req.body?.attest }) })));
  // Destinations: a name is a place only once someone has defined or approved it for the robot's map.
  router.get("/robots/:id/destinations", anyAccount(async (req, res, db, account) => res.json(await robotics.listDestinations(db, account.id, req.params.id))));
  router.post("/robots/:id/destinations", json, person(async (req, res, db, account) => res.status(201).json(await robotics.addDestination(db, account.id, req.params.id, req.body || {}))));
  router.delete("/robots/:id/destinations/:destination", person(async (req, res, db, account) => res.json(await robotics.removeDestination(db, account.id, req.params.id, req.params.destination))));
  router.get("/robots/:id/diagnostics", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const [events, missions, maintenance] = await Promise.all([robotics.events(db, account.id, { robotId: robot.id, limit: 200 }), robotics.listMissions(db, account.id, { robotId: robot.id, limit: 30 }), robotics.maintenance(db, account.id, robot.id, 5)]);
    res.json({ diagnostics: fleet.diagnose(robot, { events, missions, maintenance }) });
  }));
  router.get("/robots/:id/maintenance", anyAccount(async (req, res, db, account) => res.json({ maintenance: await robotics.maintenance(db, account.id, (await robotics.getRobot(db, account.id, req.params.id)).id) })));
  router.post("/robots/:id/maintenance", json, person(async (req, res, db, account) => res.status(201).json({ maintenance: await robotics.addMaintenance(db, account.id, req.params.id, req.body || {}) })));
  // Pictures: the list carries no image data; opening one is written to the robot's events with who opened it.
  router.get("/robots/:id/images", anyAccount(async (req, res, db, account) => res.json(await robotics.listImages(db, account.id, req.params.id, req.query.limit))));
  router.get("/robots/:id/images/:image", anyAccount(async (req, res, db, account) => res.json({ image: await robotics.getImage(db, account.id, req.params.id, req.params.image, account.via === "session" ? "a signed-in person" : "a developer key") })));
  router.delete("/robots/:id/images/:image", person(async (req, res, db, account) => res.json(await robotics.deleteImage(db, account.id, req.params.id, req.params.image))));
  router.get("/robots/:id/templates", anyAccount(async (req, res, db, account) => res.json({ templates: plans.templatesFor(await robotics.getRobot(db, account.id, req.params.id)) })));
  router.post("/robots/:id/plans", json, anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    const record = await engine.run(db, account.id, { action: "robots.run_plan", params: { ...(req.body || {}), robot: robot.id }, request: "Plan started from the Robots screen", source: account.via === "session" ? "robots" : "api-key", agent: "" });
    const planId = record.response?.planId;
    res.status(record.status === "waiting-approval" ? 202 : 200).json({ record: { ...record, outcome: outcomeText(record) }, plan: planId ? await planView(db, account.id, await robotics.getPlan(db, account.id, planId)) : null });
  }));
  // What the robot's onboard Edge Resource Manager measured, its history, and model advice from those measurements.
  router.get("/robots/:id/resources", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    res.json(await resourcesView(db, robotics, account.id, robot, { task: req.query.task, contextTokens: req.query.context, hours: req.query.hours }));
  }));
  router.get("/robots/:id/telemetry", anyAccount(async (req, res, db, account) => {
    const robot = await robotics.getRobot(db, account.id, req.params.id);
    res.json({ samples: await robotics.telemetry(db, account.id, robot.id, { sinceMs: (Number(req.query.minutes) || 15) * 60_000 }) });
  }));
  return router;
}

module.exports = { createRobotAccountRouter, createRobotDeviceRouter };
