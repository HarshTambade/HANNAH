"use strict";

/**
 * The Device Intelligence Graph over HTTP. Every route needs a signed-in
 * account; changes need the person in the app (an account session), so a
 * developer key or an agent can ask the graph questions but can't rewrite it.
 *
 *   GET    /api/graph                      ?type= &workspace= &project= &team= &asOf=   entities and relationships
 *   GET    /api/graph/schema               entity types and versioned relationship types
 *   POST   /api/graph/populate             derive entities from robots, hubs, devices, missions, maintenance, workflows   (session)
 *   POST   /api/graph/nodes                { type, name, props?, team?, workspace?, project? }   (session)
 *   GET    /api/graph/nodes/:id
 *   PATCH  /api/graph/nodes/:id            { name?, props? }   (session)
 *   DELETE /api/graph/nodes/:id            closes it (history is kept)   (session)
 *   GET    /api/graph/nodes/:id/history    every version and relationship it had
 *   GET    /api/graph/nodes/:id/neighbors  ?depth= (≤ 4) &types= &asOf=
 *   GET    /api/graph/nodes/:id/context    sensor → machine → place → robots → approved workflows, each checked live
 *   POST   /api/graph/edges                { type, from, to, props? }   (session)
 *   DELETE /api/graph/edges/:id            closes it   (session)
 *   POST   /api/graph/ask                  { entity, question: context | neighbors | history, depth? }
 */
const express = require("express");
const { getDatabase } = require("../db");

function createGraphRouter({ graph }) {
  const router = express.Router();
  const service = () => (typeof graph === "function" ? graph() : graph);
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to use the device graph.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can change the device graph. A developer key can read it.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "The device graph needs the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (!error.status) console.error(`Graph request failed (${error?.code || error?.name || "error"}): ${error?.message}`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "That didn't work on the server.", ...(error.reason ? { reason: error.reason } : {}), ...(error.candidates ? { candidates: error.candidates } : {}) });
    }
  };
  const read = guard();
  const write = guard({ session: true });
  const asOf = (value) => (value === undefined || value === "" ? null : Number(value));

  router.get("/graph", read(async (req, res, db, account) => res.json(await service().list(db, account.id, { type: req.query.type, workspace: req.query.workspace, project: req.query.project, team: req.query.team, asOf: req.query.asOf }))));
  router.get("/graph/schema", read(async (_req, res) => res.json(service().schema())));
  router.post("/graph/populate", write(async (_req, res, db, account) => res.json(await service().populate(db, account.id))));
  router.post("/graph/nodes", write(async (req, res, db, account) => res.status(201).json({ node: await service().createNode(db, account.id, req.body || {}) })));
  router.get("/graph/nodes/:id", read(async (req, res, db, account) => res.json({ node: await service().getNode(db, account.id, req.params.id) })));
  router.patch("/graph/nodes/:id", write(async (req, res, db, account) => res.json({ node: await service().updateNode(db, account.id, req.params.id, req.body || {}) })));
  router.delete("/graph/nodes/:id", write(async (req, res, db, account) => res.json(await service().closeNode(db, account.id, req.params.id))));
  router.get("/graph/nodes/:id/history", read(async (req, res, db, account) => res.json(await service().history(db, account.id, req.params.id))));
  router.get("/graph/nodes/:id/neighbors", read(async (req, res, db, account) => res.json(await service().traverse(db, account.id, req.params.id, { depth: req.query.depth, types: req.query.types, asOf: asOf(req.query.asOf) }))));
  router.get("/graph/nodes/:id/context", read(async (req, res, db, account) => res.json(await service().context(db, account.id, req.params.id))));
  router.post("/graph/edges", write(async (req, res, db, account) => {
    const edge = await service().createEdge(db, account.id, req.body || {});
    res.status(edge.existing ? 200 : 201).json({ edge });
  }));
  router.delete("/graph/edges/:id", write(async (req, res, db, account) => res.json(await service().closeEdge(db, account.id, req.params.id))));
  router.post("/graph/ask", read(async (req, res, db, account) => res.json(await service().ask(db, account.id, { entity: req.body?.entity, question: req.body?.question, depth: req.body?.depth, type: req.body?.type }))));
  return router;
}

module.exports = { createGraphRouter };
