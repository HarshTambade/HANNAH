"use strict";

/**
 * Predictive maintenance over HTTP, for one signed-in account.
 *
 *   GET    /api/maintenance                     ?asset= &refresh=0  the report: findings, precision, tasks, coverage
 *   POST   /api/maintenance/analyze             { asset? }          run the detectors now
 *   GET    /api/maintenance/series              ?asset= &component= &metric= &days=   the recorded buckets
 *   GET    /api/maintenance/findings            ?asset= &status=open|all|resolved|dismissed|cleared
 *   GET    /api/maintenance/findings/:id
 *   POST   /api/maintenance/findings/:id/feedback   { verdict: true-positive | false-positive | unsure, note? }   a signed-in person
 *   POST   /api/maintenance/findings/:id/confirm    { note }        a signed-in person, after inspecting
 *   POST   /api/maintenance/findings/:id/status     { status: open | acknowledged | resolved }
 *   GET    /api/maintenance/tasks                   ?asset= &status=
 *   POST   /api/maintenance/tasks                   { assetId, kind, title?, note?, dueAt?, component?, findingId?, remind? }
 *   POST   /api/maintenance/tasks/:id/complete      { note? }       goes into the service history
 *   POST   /api/maintenance/tasks/:id/cancel
 *   GET    /api/maintenance/history                 ?asset=
 *   PUT    /api/maintenance/limits                  { "<component>.<metric>": { warn?, critical? } }   a signed-in person
 *
 * A developer key (an agent) can read and ask for analysis. Only a person in
 * the app gives a verdict, confirms a fault, sets limits or closes a task, so
 * an agent can't mark its own findings correct or turn a guess into a fault.
 */
const express = require("express");
const { getDatabase } = require("../db");

function createMaintenanceRouter({ maintenance }) {
  const router = express.Router();
  const json = express.json({ limit: "64kb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to see maintenance. Robots and devices belong to an account.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key or an agent can't.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Maintenance needs the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (!error.status) console.error(`Maintenance request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "That didn't work on the server.", ...(error.reason ? { reason: error.reason } : {}) });
    }
  };
  const any = guard();
  const person = guard({ session: true });
  const assetOf = async (db, account, value) => (value ? (await maintenance.asset(db, account.id, value)).id : null);
  const who = (account) => (account.via === "session" ? "a signed-in person" : "a developer key");

  router.get("/maintenance", any(async (req, res, db, account) => res.json(await maintenance.report(db, account.id, { assetId: await assetOf(db, account, req.query.asset), refresh: req.query.refresh !== "0" }))));
  router.post("/maintenance/analyze", json, any(async (req, res, db, account) => res.json(await maintenance.analyze(db, account.id, { assetId: await assetOf(db, account, req.body?.asset) }))));
  router.get("/maintenance/series", any(async (req, res, db, account) => {
    const assetId = await assetOf(db, account, req.query.asset);
    if (!assetId) return res.status(400).json({ error: "Name the robot or device (?asset=).", reason: "bad-request" });
    if (!req.query.component || !req.query.metric) return res.json({ series: await maintenance.seriesKeys(db, account.id, assetId) });
    const days = Math.max(1, Math.min(180, Number(req.query.days) || 7));
    return res.json({ buckets: await maintenance.series(db, account.id, assetId, String(req.query.component), String(req.query.metric), { sinceMs: days * 86_400_000 }), bucketMs: maintenance.BUCKET_MS });
  }));
  router.get("/maintenance/findings", any(async (req, res, db, account) => res.json({ findings: await maintenance.listFindings(db, account.id, { assetId: await assetOf(db, account, req.query.asset), status: req.query.status || "open" }), precision: await maintenance.precision(db, account.id) })));
  router.get("/maintenance/findings/:id", any(async (req, res, db, account) => res.json({ finding: await maintenance.getFinding(db, account.id, req.params.id) })));
  router.post("/maintenance/findings/:id/feedback", json, person(async (req, res, db, account) => res.json({ finding: await maintenance.setFeedback(db, account.id, req.params.id, { verdict: req.body?.verdict, note: req.body?.note, by: who(account) }), precision: await maintenance.precision(db, account.id) })));
  router.post("/maintenance/findings/:id/confirm", json, person(async (req, res, db, account) => res.json({ finding: await maintenance.confirmFinding(db, account.id, req.params.id, { note: req.body?.note, by: who(account) }) })));
  router.post("/maintenance/findings/:id/status", json, any(async (req, res, db, account) => res.json({ finding: await maintenance.setStatus(db, account.id, req.params.id, String(req.body?.status || ""), { by: who(account) }) })));
  router.get("/maintenance/tasks", any(async (req, res, db, account) => res.json({ tasks: await maintenance.listTasks(db, account.id, { assetId: await assetOf(db, account, req.query.asset), status: req.query.status ? String(req.query.status) : null }) })));
  router.post("/maintenance/tasks", json, any(async (req, res, db, account) => res.status(201).json({ task: await maintenance.createTask(db, account.id, req.body || {}, { by: who(account) }) })));
  router.post("/maintenance/tasks/:id/complete", json, person(async (req, res, db, account) => res.json({ task: await maintenance.completeTask(db, account.id, req.params.id, { note: req.body?.note, by: who(account) }) })));
  router.post("/maintenance/tasks/:id/cancel", person(async (req, res, db, account) => res.json({ task: await maintenance.cancelTask(db, account.id, req.params.id, { by: who(account) }) })));
  router.get("/maintenance/history", any(async (req, res, db, account) => {
    const assetId = await assetOf(db, account, req.query.asset);
    if (!assetId) return res.status(400).json({ error: "Name the robot or device (?asset=).", reason: "bad-request" });
    return res.json({ history: await maintenance.history(db, account.id, assetId) });
  }));
  router.put("/maintenance/limits", json, person(async (req, res, db, account) => res.json({ limits: await maintenance.setLimits(db, account.id, req.body || {}, { by: who(account) }) })));
  return router;
}

module.exports = { createMaintenanceRouter };
