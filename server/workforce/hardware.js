"use strict";

/**
 * Hardware-aware teammates: robots and IoT devices through HANNAH's own
 * registries and Action Engine.
 *
 * What a teammate gets:
 *   - read: a snapshot of the account's registered robots (connection, mode,
 *     battery, current mission), active missions, edge hubs and devices with
 *     their latest readings. Each value says how old it is. A teammate sees
 *     robots only with the "robots" tool, and devices only with "devices".
 *   - suggest: a task result may name a robot or device action from the Action
 *     Engine catalog, with its parameters. It is a suggestion, nothing more.
 *   - submit, by a person: from Agent Activity, a person sends a suggested
 *     action to the Action Engine. The engine then does what it does for every
 *     caller: permission, approval, the robot's or hub's Safety Gateway,
 *     execution, verification and the record.
 *
 * What a teammate never gets: a motor command, a bypass of the Safety Gateway,
 * or an action that runs because a model wrote it. Physical execution stays in
 * the onboard runtime and the hub, which keep their own limits if this server,
 * the model provider or the client disconnects.
 */
const express = require("express");
const { asObject, canUseBot, clean, fail, parse, readBody, recordEvent, requireId, withAccount } = require("./common");

let operatorRef = null;

/** Wire the server's shared operator (robot registry, device registry, Action Engine). */
function setOperator(getter) {
  operatorRef = getter;
}

function operator() {
  const value = typeof operatorRef === "function" ? operatorRef() : operatorRef;
  return value && value.engine ? value : null;
}

/** Which hardware a teammate may read, from its tools. */
function hardwareAccess(bot) {
  const tools = new Set((parse(bot?.tools, []) || []).map((tool) => String(tool).toLowerCase()));
  return { robots: tools.has("robots") || tools.has("robot"), devices: tools.has("devices") || tools.has("iot") };
}

const HARDWARE_SERVICES = new Set(["robots", "hardware", "robot_os"]);

/** Hardware actions in the Action Engine that change something, for the prompt and for submission. */
function hardwareActions(access) {
  const op = operator();
  if (!op) return [];
  return op.engine.catalog()
    .filter((action) => HARDWARE_SERVICES.has(action.service) && action.kind !== "read")
    .filter((action) => (action.service === "hardware" ? access.devices : access.robots))
    .map((action) => ({ id: action.id, title: action.title, kind: action.kind, inputs: Object.keys(action.input?.properties || {}), required: action.input?.required || [] }));
}

const age = (at, now) => (at ? `${Math.max(0, Math.round((now - Number(at)) / 1000))} s ago` : "never");

/** A compact, read-only snapshot. Returns null when the teammate has no hardware tool. */
async function snapshot(db, userId, bot, now = Date.now()) {
  const access = hardwareAccess(bot);
  if (!access.robots && !access.devices) return null;
  const op = operator();
  if (!op) return { access, available: false, reason: "The robot and device registries aren't running on this server.", robots: [], missions: [], devices: [], hubs: [], readAt: now };
  const out = { access, available: true, robots: [], missions: [], devices: [], hubs: [], readAt: now };
  if (access.robots && op.robotics) {
    const robots = await op.robotics.listRobots(db, userId).catch(() => []);
    out.robots = robots.slice(0, 25).map((robot) => ({
      id: robot.id, name: robot.name, simulated: robot.simulated, connection: robot.connection, mode: robot.mode,
      battery: robot.state?.battery?.percent ?? robot.state?.batteryPercent ?? null,
      lastSeenAt: robot.lastSeenAt, stateAgeS: robot.stateAgeS, capabilities: (robot.capabilities || []).slice(0, 20),
      places: Object.keys(robot.places || {}).slice(0, 20), commissioning: robot.commissioning?.status || robot.commissioning?.state || null,
    }));
    const missions = await op.robotics.listMissions(db, userId, { active: true, limit: 20 }).catch(() => []);
    out.missions = missions.map((mission) => ({ id: mission.id, robotId: mission.robotId || mission.robot_id, title: mission.title, capability: mission.capability, status: mission.status, updatedAt: mission.updatedAt || mission.updated_at || null }));
  }
  if (access.devices && op.devices) {
    const [devices, hubs] = await Promise.all([op.devices.listDevices(db, userId).catch(() => []), op.devices.listHubs(db, userId).catch(() => [])]);
    out.hubs = hubs.slice(0, 20).map((hub) => ({ id: hub.id, name: hub.name, connection: hub.connection, lastSeenAt: hub.lastSeenAt || null }));
    out.devices = devices.slice(0, 40).map((device) => ({
      id: device.id, name: device.name, location: device.location, status: device.status, connection: device.connection,
      category: device.profile?.category || null, compatibility: device.compatibility?.level || null,
      readings: Object.fromEntries(Object.entries(device.points || {}).slice(0, 12).map(([key, point]) => [key, { value: point.value, unit: point.unit, ageS: point.ageS, live: point.live }])),
    }));
  }
  return out;
}

/** The snapshot as prompt text: data, labelled, with ages. */
function snapshotText(snap) {
  if (!snap) return "";
  if (!snap.available) return `HARDWARE: ${snap.reason}`;
  const lines = [`HARDWARE STATE (read at ${new Date(snap.readAt).toISOString()}; a reading is only as current as its age; never assume a robot or device state you can't see here):`];
  if (snap.access.robots) {
    if (!snap.robots.length) lines.push("- No robots are registered.");
    for (const robot of snap.robots) {
      lines.push(`- Robot "${robot.name}" (${robot.id}): ${robot.simulated ? "simulation" : "physical"}, ${robot.connection}, mode ${robot.mode}${robot.battery !== null && robot.battery !== undefined ? `, battery ${robot.battery}%` : ""}, last seen ${age(robot.lastSeenAt, snap.readAt)}${robot.places.length ? `, known places: ${robot.places.join(", ")}` : ""}${robot.capabilities.length ? `, can: ${robot.capabilities.map((item) => (typeof item === "string" ? item : item.id)).join(", ")}` : ""}`);
    }
    for (const mission of snap.missions) lines.push(`- Active mission "${mission.title || mission.capability}" (${mission.id}) on ${mission.robotId}: ${mission.status}`);
  }
  if (snap.access.devices) {
    if (!snap.devices.length) lines.push("- No devices are registered.");
    for (const hub of snap.hubs) lines.push(`- Hub "${hub.name}": ${hub.connection}, last seen ${age(hub.lastSeenAt, snap.readAt)}`);
    for (const device of snap.devices) {
      const readings = Object.entries(device.readings).map(([key, point]) => `${key}=${point.value}${point.unit ? ` ${point.unit}` : ""} (${point.ageS}s old${point.live ? "" : ", not live"})`).join(", ");
      lines.push(`- Device "${device.name}"${device.location ? ` in ${device.location}` : ""}: ${device.connection}${readings ? `; ${readings}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** Prompt text for a teammate: the snapshot and the actions it may suggest. Empty for teammates without hardware tools. */
async function hardwareContext(db, userId, bot) {
  const snap = await snapshot(db, userId, bot).catch(() => null);
  if (!snap) return "";
  const actions = hardwareActions(snap.access);
  return [
    snapshotText(snap),
    actions.length
      ? `HARDWARE ACTIONS YOU MAY SUGGEST (a person submits them; the Action Engine asks for approval and the Safety Gateway checks them; you never run them):\n${actions.map((action) => `- ${action.id}: ${action.title}. Inputs: ${action.inputs.join(", ") || "none"}${action.required.length ? ` (required: ${action.required.join(", ")})` : ""}`).join("\n")}\nTo suggest one, add it to nextSteps as {"action": "<id>", "title": "...", "reason": "...", "params": {...}}.`
      : "",
  ].filter(Boolean).join("\n\n");
}

function isHardwareAction(actionId) {
  const op = operator();
  const definition = op?.engine.definition?.(actionId) || op?.engine.catalog().find((action) => action.id === actionId);
  return definition && HARDWARE_SERVICES.has(definition.service) && definition.kind !== "read" ? definition : null;
}

function createHardwareRouter() {
  const router = express.Router();

  router.get("/workforce/bots/:id/hardware", withAccount(async (req, res, db, account) => {
    const bot = await canUseBot(db, account.id, clean(req.params.id, 80));
    if (!bot) throw fail(404, "That teammate doesn't exist.", "not-found");
    const snap = await snapshot(db, account.id, bot);
    if (!snap) return res.json({ access: hardwareAccess(bot), snapshot: null, actions: [], note: `${bot.name} has no "robots" or "devices" tool, so it can't see hardware.` });
    res.json({ access: snap.access, snapshot: snap, actions: hardwareActions(snap.access) });
  }));

  /**
   * A person sends one suggested hardware step of a finished task to the Action
   * Engine. The engine decides whether it needs approval and runs the safety
   * checks; this route only checks that it is a hardware action the teammate
   * was allowed to suggest, and records which request it became.
   */
  router.post("/workforce/tasks/:id/hardware-actions", withAccount(async (req, res, db, account) => {
    if (account.via !== "session") throw fail(403, "Only a signed-in person can send a teammate's hardware step for approval.", "person-required");
    const op = operator();
    if (!op) throw fail(503, "The robot and device registries aren't running on this server.", "hardware-unavailable");
    const task = (await db.query("SELECT * FROM hannah_workforce_tasks WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "task")])).rows[0];
    if (!task) throw fail(404, "That task doesn't exist.", "not-found");
    const bot = task.bot_id ? await canUseBot(db, account.id, task.bot_id) : null;
    if (!bot) throw fail(409, "The teammate behind this task is no longer available.", "bot-missing");
    const result = parse(task.result, {}) || {};
    const index = Number(readBody(req).index);
    const steps = Array.isArray(result.nextSteps) ? result.nextSteps : [];
    const step = Number.isInteger(index) ? steps[index] : null;
    if (!step) throw fail(404, "That suggested step doesn't exist.", "not-found");
    if (step.actionId) throw fail(409, "That step was already sent.", "already-sent");
    const definition = isHardwareAction(step.action);
    if (!definition) throw fail(400, "That step isn't a robot or device action.", "not-hardware");
    const access = hardwareAccess(bot);
    if (definition.service === "hardware" ? !access.devices : !access.robots) throw fail(403, `${bot.name} isn't allowed to suggest ${definition.service === "hardware" ? "device" : "robot"} actions.`, "tool-not-allowed");
    const record = await op.engine.run(db, account.id, {
      action: definition.id, params: asObject(step.params), request: clean(step.title, 1000), intent: clean(step.reason, 400),
      agent: clean(bot.name, 80), source: "workforce", taskId: task.id, idempotencyKey: `wf:${task.id}:${index}`,
    });
    steps[index] = { ...step, actionId: record.id, actionStatus: record.status, sentAt: Date.now() };
    await db.query("UPDATE hannah_workforce_tasks SET result = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify({ ...result, nextSteps: steps }).slice(0, 200_000), Date.now(), account.id, task.id]);
    await recordEvent(db, account.id, "hardware.action_requested", { botId: bot.id, taskId: task.id, severity: "high", detail: { action: definition.id, actionId: record.id, status: record.status } });
    const { outcomeText } = require("../actions/engine");
    res.status(201).json({ record, text: outcomeText(record) });
  }));

  return router;
}

module.exports = { HARDWARE_SERVICES, createHardwareRouter, hardwareAccess, hardwareActions, hardwareContext, isHardwareAction, setOperator, snapshot, snapshotText };
