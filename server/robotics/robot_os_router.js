"use strict";

const express = require("express");
const { validateBridgeEnvelope } = require("./robot_os_bridge");

function createRobotOSBridgeRouter({ onEnvelope = null, auth = null, enabled = true, pendingCommands = null, onCommandAck = null } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));

  router.post("/robotos/bridge", async (req, res) => {
    if (!enabled) return res.status(404).json({ error: "Not found." });
    const { ok, errors } = validateBridgeEnvelope(req.body);
    if (!ok) return res.status(400).json({ ok: false, errors });
    if (auth) {
      const result = await auth.verify(req.body);
      if (!result.ok) return res.status(result.status || 401).json({ ok: false, reason: result.reason });
      req.robotId = result.robot_id;
    }
    if (onEnvelope) await onEnvelope(req.body, { robotId: req.robotId });
    if (onCommandAck && req.body.kind === "command_ack") {
      await onCommandAck(req.body, { robotId: req.robotId });
    }
    let commands = [];
    if (pendingCommands && ["sync_request", "heartbeat"].includes(req.body.kind)) {
      commands = await pendingCommands(req.robotId || req.body.robot_id);
    }
    return res.json({ ok: true, envelope_id: req.body.envelope_id, accepted: true, commands });
  });

  return router;
}

module.exports = { createRobotOSBridgeRouter };
