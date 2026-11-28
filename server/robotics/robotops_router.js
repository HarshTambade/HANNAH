"use strict";

/**
 * Robot operations over HTTP (account only; see robotops.js).
 *
 *   GET    /api/robotops/simulator                       profiles, scenarios, whether the simulator runs here
 *   POST   /api/robotops/sim-runs                        { profile, scenarios?, overrides? } run the built-in simulator
 *   GET    /api/robotops/sim-runs                        ?deployment= &suite=
 *   GET    /api/robotops/sim-runs/:id                    with every scenario's result and the baseline diff
 *   POST   /api/robotops/sim-runs/:id/baseline           make it the suite's baseline
 *
 *   GET    /api/robotops/deployments                     ?robot=
 *   POST   /api/robotops/deployments                     { robotId, title, change }                    (person)
 *   GET    /api/robotops/deployments/:id                 the record, the lifecycle, the parity report
 *   POST   /api/robotops/deployments/:id/parity          load the simulation again and recompare
 *   POST   /api/robotops/deployments/:id/simulate        run its scenarios
 *   POST   /api/robotops/deployments/:id/inspect         { runId, attest }                            (person)
 *   POST   /api/robotops/deployments/:id/assumptions     { ids, attest }                              (person)
 *   POST   /api/robotops/deployments/:id/approve         { stage, robotIds?, attest, statement? }     (person)
 *   POST   /api/robotops/deployments/:id/observe         { outcome, note }                            (person)
 *   POST   /api/robotops/deployments/:id/rollback        { reason, robotIds? }                        (person)
 *
 *   GET    /api/robotops/keys                            pinned publisher keys
 *   POST   /api/robotops/keys                            { owner, publicKey }                         (person)
 *   POST   /api/robotops/keys/:keyId/revoke                                                           (person)
 *   GET    /api/robotops/packages
 *   POST   /api/robotops/packages                        { manifest }                                 (person)
 *   GET    /api/robotops/packages/:id                    with its validation for every robot
 *   GET    /api/robotops/rollouts
 *   POST   /api/robotops/rollouts                        { packageId, picked, allowAllAtOnce?, autoRollback? }  (person)
 *   GET    /api/robotops/rollouts/:id
 *   POST   /api/robotops/rollouts/:id/waves/:index/approve   { attest, statement? }                   (person)
 *   POST   /api/robotops/rollouts/:id/robots/:robot/rollback { reason }                               (person)
 *   POST   /api/robotops/rollouts/:id/cancel                                                          (person)
 *
 *   GET    /api/robotops/firmware
 *   POST   /api/robotops/firmware                        { robotId, packageId, request }              (person)
 *   GET    /api/robotops/firmware/:id
 *   POST   /api/robotops/firmware/:id/authorize          { confirmName, confirmSerial, atRobot }      (person)
 *   POST   /api/robotops/firmware/:id/cancel                                                          (person)
 *
 * "(person)" means a signed-in session; a developer key or an agent is refused.
 * Nothing in the Action Engine reaches these: a model can't approve a stage,
 * start a rollout or flash firmware.
 */
const express = require("express");
const { getDatabase } = require("../db");
const simtoreal = require("./simtoreal");

function createRobotOpsRouter({ robotops, simulator }) {
  const router = express.Router();
  const json = express.json({ limit: "400kb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to use robot operations.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key or an agent can't.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Robot operations need the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (res.headersSent) return undefined;
      if (!error.status) console.error(`Robot operations request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "That didn't work on the server.", ...(error.reason ? { reason: error.reason } : {}), ...(error.problems ? { problems: error.problems } : {}), ...(error.checks ? { checks: error.checks } : {}) });
    }
  };
  const any = guard();
  const person = guard({ session: true });
  const body = (req) => req.body || {};

  router.get("/robotops/simulator", any(async (_req, res) => res.json({ available: await simulator.available(), profiles: simulator.profiles(), scenarios: simulator.scenarios(), metrics: simtoreal.METRICS, environment: "HANNAH's built-in simulator. Not Gazebo, not hardware." })));
  router.post("/robotops/sim-runs", json, any(async (req, res, db, account) => res.status(201).json({ run: await robotops.runSimulation(db, account.id, account, { profile: body(req).profile, scenarios: Array.isArray(body(req).scenarios) ? body(req).scenarios : [], overrides: body(req).overrides }) })));
  router.get("/robotops/sim-runs", any(async (req, res, db, account) => res.json({ runs: await robotops.listRuns(db, account.id, { deploymentId: req.query.deployment, suite: req.query.suite, limit: req.query.limit }) })));
  router.get("/robotops/sim-runs/:id", any(async (req, res, db, account) => {
    const run = await robotops.getRun(db, account.id, req.params.id);
    if (!run) return res.status(404).json({ error: "No simulator run with that id.", reason: "not-found" });
    const baseline = await robotops.baselineFor(db, account.id, run.suite);
    return res.json({ run, baseline: baseline ? { id: baseline.id, summary: baseline.summary } : null, diff: simtoreal.regressionDiff(run, baseline) });
  }));
  router.post("/robotops/sim-runs/:id/baseline", any(async (req, res, db, account) => res.json({ baseline: await robotops.setBaseline(db, account.id, account, req.params.id) })));

  router.get("/robotops/deployments", any(async (req, res, db, account) => res.json({ deployments: await robotops.listDeployments(db, account.id, { robotId: req.query.robot }) })));
  router.post("/robotops/deployments", json, person(async (req, res, db, account) => res.status(201).json({ deployment: await robotops.createDeployment(db, account.id, account, body(req)) })));
  router.get("/robotops/deployments/:id", any(async (req, res, db, account) => res.json({ deployment: await robotops.getDeployment(db, account.id, req.params.id) })));
  router.post("/robotops/deployments/:id/parity", any(async (req, res, db, account) => { await robotops.loadSimulation(db, account.id, account, req.params.id); res.json({ deployment: await robotops.getDeployment(db, account.id, req.params.id) }); }));
  router.post("/robotops/deployments/:id/simulate", any(async (req, res, db, account) => res.json({ deployment: await robotops.simulateDeployment(db, account.id, account, req.params.id) })));
  router.post("/robotops/deployments/:id/inspect", json, person(async (req, res, db, account) => res.json({ deployment: await robotops.inspectRun(db, account.id, account, req.params.id, body(req)) })));
  router.post("/robotops/deployments/:id/assumptions", json, person(async (req, res, db, account) => res.json({ deployment: await robotops.acknowledgeAssumptions(db, account.id, account, req.params.id, { ids: Array.isArray(body(req).ids) ? body(req).ids : [], attest: body(req).attest }) })));
  router.post("/robotops/deployments/:id/approve", json, person(async (req, res, db, account) => res.json({ deployment: await robotops.approveStage(db, account.id, account, req.params.id, { stage: body(req).stage, robotIds: Array.isArray(body(req).robotIds) ? body(req).robotIds : [], attest: body(req).attest, statement: body(req).statement }) })));
  router.post("/robotops/deployments/:id/observe", json, person(async (req, res, db, account) => res.json({ deployment: await robotops.observe(db, account.id, account, req.params.id, body(req)) })));
  router.post("/robotops/deployments/:id/rollback", json, person(async (req, res, db, account) => res.json({ deployment: await robotops.rollbackDeployment(db, account.id, account, req.params.id, { reason: body(req).reason, robotIds: Array.isArray(body(req).robotIds) ? body(req).robotIds : null }) })));

  router.get("/robotops/keys", any(async (_req, res, db, account) => res.json({ keys: await robotops.listKeys(db, account.id) })));
  router.post("/robotops/keys", json, person(async (req, res, db, account) => res.status(201).json({ key: await robotops.addKey(db, account.id, account, body(req)) })));
  router.post("/robotops/keys/:keyId/revoke", person(async (req, res, db, account) => res.json({ key: await robotops.revokeKey(db, account.id, account, req.params.keyId) })));
  router.get("/robotops/packages", any(async (_req, res, db, account) => res.json({ packages: await robotops.listPackages(db, account.id) })));
  router.post("/robotops/packages", json, person(async (req, res, db, account) => res.status(201).json({ package: await robotops.uploadPackage(db, account.id, account, body(req).manifest) })));
  router.get("/robotops/packages/:id", any(async (req, res, db, account) => res.json(await robotops.validatePackage(db, account.id, req.params.id))));
  router.get("/robotops/rollouts", any(async (_req, res, db, account) => res.json({ rollouts: await robotops.listRollouts(db, account.id) })));
  router.post("/robotops/rollouts", json, person(async (req, res, db, account) => res.status(201).json({ rollout: await robotops.createRollout(db, account.id, account, body(req)) })));
  router.get("/robotops/rollouts/:id", any(async (req, res, db, account) => res.json({ rollout: await robotops.getRollout(db, account.id, req.params.id) })));
  router.post("/robotops/rollouts/:id/waves/:index/approve", json, person(async (req, res, db, account) => res.json({ rollout: await robotops.approveWave(db, account.id, account, req.params.id, req.params.index, body(req)) })));
  router.post("/robotops/rollouts/:id/robots/:robot/rollback", json, person(async (req, res, db, account) => res.json({ rollout: await robotops.rollbackTarget(db, account.id, account, req.params.id, req.params.robot, body(req)) })));
  router.post("/robotops/rollouts/:id/cancel", person(async (req, res, db, account) => res.json({ rollout: await robotops.cancelRollout(db, account.id, account, req.params.id) })));

  router.get("/robotops/firmware", any(async (_req, res, db, account) => res.json({ operations: await robotops.listFirmwareOps(db, account.id) })));
  router.post("/robotops/firmware", json, person(async (req, res, db, account) => res.status(201).json({ operation: await robotops.createFirmwareOp(db, account.id, account, body(req)) })));
  router.get("/robotops/firmware/:id", any(async (req, res, db, account) => res.json({ operation: await robotops.getFirmwareOp(db, account.id, req.params.id) })));
  router.post("/robotops/firmware/:id/authorize", json, person(async (req, res, db, account) => res.json({ operation: await robotops.authorizeFirmware(db, account.id, account, req.params.id, body(req)) })));
  router.post("/robotops/firmware/:id/cancel", person(async (req, res, db, account) => res.json({ operation: await robotops.cancelFirmwareOp(db, account.id, account, req.params.id) })));
  return router;
}

module.exports = { createRobotOpsRouter };
