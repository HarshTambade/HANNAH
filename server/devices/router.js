"use strict";

/**
 * Devices over HTTP.
 *
 * For a hub (authenticated by its own signature, no account session):
 *   POST /api/hubs/enroll                { code, descriptor } → { hubId, secret, … }   once per code
 *   POST /api/hubs/device/sync           signed; reports in, configuration and commands out
 *
 * For the account (session or developer key; "person" = a signed-in person only):
 *   GET    /api/devices/overview         hubs, devices and automations in one answer
 *   GET    /api/devices/profiles         ?hub=   the device profiles available, each with its compatibility level
 *   POST   /api/devices/profiles         { profile }  save a description built in the Hardware Studio   (person)
 *   DELETE /api/devices/profiles/:id                                                                    (person)
 *   GET    /api/devices/protocols        what the hub can speak, and what is not built
 *   GET    /api/devices/events           ?device= &hub=
 *   GET    /api/devices/automations
 *   POST   /api/devices/automations      { name, when, then, otherwise? } → the action's record (asks for approval)
 *   PATCH  /api/devices/automations/:id  { enabled }
 *   DELETE /api/devices/automations/:id
 *   POST   /api/devices/automations/pause | resume     every automation of the account                  (person)
 *   POST   /api/devices                  { hub?, profileId, name, location?, settings }                  (person)
 *   GET    /api/devices/:id              the device, its recent events and changes
 *   PATCH  /api/devices/:id              { name?, location?, settings?, writable?, alwaysAsk?, disabled? } (person)
 *   DELETE /api/devices/:id                                                                             (person)
 *   POST   /api/devices/:id/test         ask the hub to connect and listen; records what it found       (person)
 *   POST   /api/devices/:id/activate     { writable, acceptPartial? }  switch it on                     (person)
 *   POST   /api/devices/:id/set          { point, value } → the action's record
 *   GET    /api/devices/:id/history      ?point= &minutes=
 *   GET    /api/hubs · POST /api/hubs { name } (person) · GET /api/hubs/:id
 *   POST   /api/hubs/:id/enrollment (person) · POST /api/hubs/:id/revoke (person) · DELETE /api/hubs/:id (person)
 *   POST   /api/hubs/:id/discover        { kind: "mqtt" | "serial", settings }  look, with your say-so   (person)
 *
 * Changing a device is an action (hardware.switch, hardware.set_value), so it
 * goes through the permission manager, approval and the audit history.
 */
const express = require("express");
const { getDatabase } = require("../db");
const { vaultConfigured } = require("../vault");
const { outcomeText } = require("../actions/engine");
const { validateProfile } = require("./profiles");

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

function respond(res, error, fallback) {
  if (res.headersSent) return undefined;
  if (!error.status) console.error(`Device request failed (${error?.code || error?.name || "error"}).`);
  return res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.reason ? { reason: error.reason } : {}), ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.fields ? { fields: error.fields } : {}), ...(error.problems ? { problems: error.problems } : {}) });
}

function createHubDeviceRouter({ devices, enrollLimiter = null }) {
  const router = express.Router();
  const json = express.json({ limit: "512kb", verify: (req, _res, buffer) => { req.rawBody = buffer.toString("utf8"); } });
  const service = () => (typeof devices === "function" ? devices() : devices);
  const database = async (res) => {
    const db = await getDatabase().catch(() => null);
    if (!db) res.status(503).json({ error: "Devices need the account database.", reason: "no-database" });
    return db;
  };
  router.post("/hubs/enroll", ...(enrollLimiter ? [enrollLimiter] : []), json, async (req, res) => {
    const db = await database(res);
    if (!db) return undefined;
    try { return res.status(201).json(await service().enrollHub(db, { code: req.body?.code, descriptor: req.body?.descriptor })); } catch (error) { return respond(res, error, "Enrollment didn't work on the server."); }
  });
  // A hub exchanges every couple of seconds. Far more than that from one hub id is a fault or an attack.
  const floodLimit = Math.max(10, Number(process.env.HANNAH_RATE_LIMIT_HUB_SYNC_PER_5S) || 40);
  const recent = new Map();
  const flooding = (hubId) => {
    const at = Date.now();
    const entry = recent.get(hubId) || { from: at, count: 0 };
    if (at - entry.from > 5000) { entry.from = at; entry.count = 0; }
    entry.count += 1;
    recent.set(hubId, entry);
    if (recent.size > 5000) for (const [key, value] of recent) { if (at - value.from > 5000) recent.delete(key); }
    return entry.count > floodLimit;
  };
  router.post("/hubs/device/sync", json, async (req, res) => {
    if (flooding(String(req.get("x-hannah-hub") || "").slice(0, 40))) return res.status(429).json({ error: "Too many requests from this hub.", reason: "rate-limited" });
    const db = await database(res);
    if (!db) return undefined;
    try {
      const hub = await service().authenticate(db, { hubId: req.get("x-hannah-hub"), time: req.get("x-hannah-time"), counter: req.get("x-hannah-counter"), signature: req.get("x-hannah-signature"), method: req.method, path: req.baseUrl + req.path, body: req.rawBody || "" });
      return res.json(await service().sync(db, hub, req.body || {}));
    } catch (error) { return respond(res, error, "The sync didn't work on the server."); }
  });
  return router;
}

function createDeviceAccountRouter({ devices, engine, manuals = null }) {
  const router = express.Router();
  const json = express.json({ limit: "300kb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to use devices. A device belongs to an account.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key can't add, reconfigure or remove a hub or a device.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Devices need the account database.", reason: "no-database" });
    try { return await handler(req, res, db, account); } catch (error) { return respond(res, error, "That didn't work on the server."); }
  };
  const anyAccount = guard();
  const person = guard({ session: true });
  const source = (account) => (account.via === "session" ? "devices" : "api-key");
  const command = (req) => `python3 -m hannah_edge enroll --server ${req.protocol}://${req.get("host")} --code `;
  const run = async (req, res, db, account, action, params, request) => {
    const record = await engine.run(db, account.id, { action, params, request, source: source(account), agent: "" });
    res.status(record.status === "waiting-approval" ? 202 : 200).json({ record: { ...record, outcome: outcomeText(record) } });
  };

  router.get("/devices/overview", anyAccount(async (_req, res, db, account) => res.json({ ...(await devices.overview(db, account.id)), canEnroll: vaultConfigured() })));
  router.get("/devices/profiles", anyAccount(async (req, res, db, account) => res.json({ profiles: await devices.listProfiles(db, account.id, { hub: req.query.hub ? await devices.resolveHub(db, account.id, req.query.hub) : null }) })));
  // Validation is a side-effect-free preflight. Saving or installing remains a separate, person-only operation.
  router.post("/devices/profiles/validate", json, anyAccount(async (req, res) => {
    const problems = validateProfile(req.body?.profile);
    res.json({ valid: problems.length === 0, problems });
  }));
  router.post("/devices/profiles", json, person(async (req, res, db, account) => res.status(201).json({ profile: await devices.saveProfile(db, account.id, req.body?.profile, { source: "studio" }) })));
  router.delete("/devices/profiles/:id", person(async (req, res, db, account) => res.json(await devices.deleteProfile(db, account.id, req.params.id))));
  router.get("/devices/protocols", anyAccount(async (_req, res) => res.json(devices.protocols())));
  router.get("/devices/events", anyAccount(async (req, res, db, account) => res.json({ events: await devices.events(db, account.id, { deviceId: req.query.device || null, hubId: req.query.hub || null, limit: req.query.limit }) })));
  router.get("/devices/automations", anyAccount(async (_req, res, db, account) => res.json({ automations: await devices.listRules(db, account.id) })));
  router.post("/devices/automations/pause", person(async (_req, res, db, account) => res.json({ paused: true, hubs: await devices.suspendRules(db, account.id, true) })));
  router.post("/devices/automations/resume", person(async (_req, res, db, account) => res.json({ paused: false, hubs: await devices.suspendRules(db, account.id, false) })));
  router.post("/devices/automations", json, anyAccount(async (req, res, db, account) => run(req, res, db, account, "hardware.create_automation", req.body || {}, "Automation created from the Devices screen")));
  router.patch("/devices/automations/:id", json, anyAccount(async (req, res, db, account) => run(req, res, db, account, req.body?.enabled ? "hardware.enable_automation" : "hardware.disable_automation", { automation: req.params.id }, "Automation changed from the Devices screen")));
  router.delete("/devices/automations/:id", anyAccount(async (req, res, db, account) => run(req, res, db, account, "hardware.delete_automation", { automation: req.params.id }, "Automation removed from the Devices screen")));
  if (manuals) manuals(router, { json, person, anyAccount });
  router.get("/devices", anyAccount(async (_req, res, db, account) => res.json({ devices: await devices.listDevices(db, account.id) })));
  router.post("/devices", json, person(async (req, res, db, account) => res.status(201).json({ device: await devices.addDevice(db, account.id, req.body || {}) })));
  router.get("/devices/:id", anyAccount(async (req, res, db, account) => {
    const device = await devices.getDevice(db, account.id, req.params.id);
    res.json({ device, events: await devices.events(db, account.id, { deviceId: device.id, limit: 40 }), changes: await devices.commands(db, account.id, { deviceId: device.id, limit: 20 }) });
  }));
  router.patch("/devices/:id", json, person(async (req, res, db, account) => res.json({ device: await devices.updateDevice(db, account.id, req.params.id, req.body || {}) })));
  router.delete("/devices/:id", person(async (req, res, db, account) => {
    if (!(await devices.removeDevice(db, account.id, req.params.id))) throw fail(404, "That device isn't in your account.", "not-found");
    res.json({ removed: true });
  }));
  router.post("/devices/:id/test", person(async (req, res, db, account) => res.json(await devices.testDevice(db, account.id, req.params.id, { requestedBy: "a signed-in person" }))));
  router.post("/devices/:id/activate", json, person(async (req, res, db, account) => res.json({ device: await devices.activateDevice(db, account.id, req.params.id, req.body || {}) })));
  router.post("/devices/:id/set", json, anyAccount(async (req, res, db, account) => {
    const device = await devices.getDevice(db, account.id, req.params.id);
    const value = req.body?.value;
    return run(req, res, db, account, typeof value === "boolean" ? "hardware.switch" : "hardware.set_value", typeof value === "boolean" ? { device: device.id, point: req.body?.point, on: value } : { device: device.id, point: req.body?.point, value }, "Changed from the Devices screen");
  }));
  router.get("/devices/:id/history", anyAccount(async (req, res, db, account) => {
    const device = await devices.getDevice(db, account.id, req.params.id);
    res.json({ samples: await devices.history(db, account.id, device.id, req.query.point, { minutes: req.query.minutes }) });
  }));

  router.get("/hubs", anyAccount(async (_req, res, db, account) => res.json({ hubs: await devices.listHubs(db, account.id), canEnroll: vaultConfigured() })));
  router.get("/hubs/rollouts", anyAccount(async (_req, res, db, account) => res.json({ rollouts: await devices.listRollouts(db, account.id) })));
  router.get("/hubs/updates", anyAccount(async (_req, res, db, account) => res.json({ hubs: (await devices.listHubs(db, account.id)).map((hub) => ({ id: hub.id, name: hub.name, software: hub.software, updateStatus: hub.updateStatus })) })));
  router.post("/hubs/rollouts", json, person(async (req, res, db, account) => res.status(201).json(await devices.createRollout(db, account.id, req.body || {}))));
  router.post("/hubs/rollouts/:id/pause", person(async (req, res, db, account) => res.json({ rollout: await devices.setRolloutPaused(db, account.id, req.params.id, true) })));
  router.post("/hubs/rollouts/:id/resume", person(async (req, res, db, account) => res.json({ rollout: await devices.setRolloutPaused(db, account.id, req.params.id, false) })));
  router.post("/hubs/rollouts/:id/rollback", person(async (req, res, db, account) => res.status(201).json({ rollout: await devices.rollbackRollout(db, account.id, req.params.id) })));
  router.post("/hubs", json, person(async (req, res, db, account) => { const created = await devices.createHub(db, account.id, req.body || {}); res.status(201).json({ ...created, command: command(req) + created.enrollment.code }); }));
  router.get("/hubs/:id", anyAccount(async (req, res, db, account) => { const hub = await devices.getHub(db, account.id, req.params.id); res.json({ hub, events: await devices.events(db, account.id, { hubId: hub.id, limit: 40 }) }); }));
  router.post("/hubs/:id/enrollment", person(async (req, res, db, account) => { const issued = await devices.issueHubCode(db, account.id, req.params.id); res.json({ ...issued, command: command(req) + issued.enrollment.code }); }));
  router.post("/hubs/:id/revoke", person(async (req, res, db, account) => res.json({ hub: await devices.revokeHub(db, account.id, req.params.id) })));
  router.delete("/hubs/:id", person(async (req, res, db, account) => {
    if (!(await devices.removeHub(db, account.id, req.params.id))) throw fail(404, "That hub isn't in your account.", "not-found");
    res.json({ removed: true });
  }));
  router.post("/hubs/:id/discover", json, person(async (req, res, db, account) => res.json(await devices.discover(db, account.id, req.params.id, req.body || {}, { requestedBy: "a signed-in person" }))));
  router.get("/devices/publishers", anyAccount(async (_req, res, db, account) => res.json({ keys: await devices.listPublisherKeys(db, account.id) })));
  router.post("/devices/publishers", json, person(async (req, res, db, account) => res.status(201).json(await devices.addPublisherKey(db, account.id, req.body || {}))));
  router.delete("/devices/publishers/:keyId", person(async (req, res, db, account) => res.json(await devices.revokePublisherKey(db, account.id, req.params.keyId))));
  router.post("/devices/profiles/install", json, person(async (req, res, db, account) => res.status(201).json(await devices.installSignedProfile(db, account.id, req.body?.profile))));

  router.post("/hubs/:id/update", json, person(async (req, res, db, account) => {
    const hub = await devices.getHub(db, account.id, req.params.id);
    const commandId = await devices.issueUpdate(db, account.id, hub.id, { version: req.body?.version, size: Number(req.body?.size), sha256: req.body?.sha256, url: req.body?.url, requestedBy: "a signed-in person" });
    const command = await devices.waitForCommand(db, account.id, commandId, { ms: 2000 });
    const failed = command.final && command.status !== "done";
    res.status(failed ? 409 : 202).json({ commandId, command, ...(failed ? { error: command.error || command.result?.message || "The hub couldn't apply this update." } : {}) });
  }));
  return router;
}

module.exports = { createDeviceAccountRouter, createHubDeviceRouter };
