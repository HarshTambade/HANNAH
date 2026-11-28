"use strict";

/**
 * Self-diagnostics over HTTP.
 *
 *   GET  /api/diagnostics                       ?auto=0   run the checks (and automatic low-risk recoveries) → subsystems and incidents
 *   GET  /api/diagnostics/incidents             ?status=open|all
 *   GET  /api/diagnostics/incidents/:id
 *   GET  /api/diagnostics/actions               every recovery action and its policy
 *   POST /api/diagnostics/recover               { incidentId?, action, params }   run, ask for approval, or refuse by policy
 *   GET  /api/diagnostics/audit                 the trail of incidents and recoveries
 *
 * An account sees its own robots, hubs and devices and the server-wide
 * checks. A server administrator is the operator token, or a signed-in
 * session whose email is listed in HANNAH_ADMIN_EMAILS; only they may run
 * administrator-only actions (switching the model provider for everyone).
 */
const express = require("express");
const { getDatabase } = require("../db");

function adminEmails() {
  return new Set(String(process.env.HANNAH_ADMIN_EMAILS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}
/** Who is asking, as the recovery policies see it. */
function actorOf(res) {
  const account = res.locals.hannahAccount;
  if (account) {
    const admin = account.via === "session" && adminEmails().has(String(account.email || "").toLowerCase());
    return { kind: account.via === "session" ? "person" : "agent", label: account.via === "session" ? (admin ? "a server administrator" : "a signed-in person") : "a developer key", admin, userId: account.id };
  }
  // The operator token: requireApiToken let it through without an account, and it isn't a visitor's key.
  if (res.locals.hannahApiTokenId && !res.locals.hannahByok && !res.locals.hannahGuest) return { kind: "person", label: "the server operator", admin: true, userId: null };
  return null;
}

function createDiagnosticsRouter({ diagnostics }) {
  const router = express.Router();
  const json = express.json({ limit: "32kb" });
  const handle = (handler) => async (req, res) => {
    const actor = actorOf(res);
    if (!actor) return res.status(401).json({ error: "Sign in to run diagnostics.", reason: "signin-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Diagnostics need the database to keep incidents.", reason: "no-database" });
    try {
      return await handler(req, res, db, actor);
    } catch (error) {
      if (!error.status) console.error(`Diagnostics request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "That didn't work on the server.", ...(error.reason ? { reason: error.reason } : {}), ...(error.recoveryId ? { recoveryId: error.recoveryId } : {}) });
    }
  };
  router.get("/diagnostics", handle(async (req, res, db, actor) => res.json({ ...(await diagnostics.diagnose(db, { userId: actor.userId, autoRecover: req.query.auto !== "0", includeServer: true })), you: { admin: actor.admin, kind: actor.kind } })));
  router.get("/diagnostics/incidents", handle(async (req, res, db, actor) => res.json({ incidents: await diagnostics.listIncidents(db, actor.userId, { status: req.query.status === "all" ? "all" : "open" }) })));
  router.get("/diagnostics/incidents/:id", handle(async (req, res, db, actor) => res.json({ incident: await diagnostics.getIncident(db, actor.userId, req.params.id) })));
  router.get("/diagnostics/actions", handle(async (_req, res) => res.json({ actions: diagnostics.actions() })));
  router.post("/diagnostics/recover", json, handle(async (req, res, db, actor) => {
    const recovery = await diagnostics.requestRecovery(db, { userId: actor.userId, incidentId: req.body?.incidentId || null, action: String(req.body?.action || ""), params: req.body?.params && typeof req.body.params === "object" ? req.body.params : {}, actor });
    res.status(recovery.status === "waiting-approval" ? 202 : 200).json({ recovery });
  }));
  router.get("/diagnostics/audit", handle(async (req, res, db, actor) => res.json({ audit: await diagnostics.auditTrail(db, actor.userId, { limit: req.query.limit }) })));
  return router;
}

module.exports = { actorOf, createDiagnosticsRouter };
