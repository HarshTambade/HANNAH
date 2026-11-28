"use strict";

/**
 * The adapter registry: one fleet across adapters. Each robot belongs to the
 * adapter that reaches it; the registry routes every call to that adapter and
 * returns the normalized shape (capability.js). Adapter #1 is HANNAH's own
 * robot link, #2 VDA 5050 over MQTT; another adapter registers the same way.
 */
const capability = require("./capability");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const REQUIRED = ["id", "label", "protocol", "listRobots", "getRobot", "assess", "submit", "getMission", "listMissions", "cancel", "requestAssistance", "reportStatus"];

function createInteropRegistry({ adapters = [] } = {}) {
  const byId = new Map();
  /** Robot and mission ids name their adapter by prefix, so a call never asks every adapter. */
  const prefixes = [];
  function register(adapter, { robotPrefix, missionPrefix }) {
    const missing = REQUIRED.filter((name) => adapter[name] === undefined);
    if (missing.length) throw new Error(`Interop adapter ${adapter.id || "(no id)"} is missing ${missing.join(", ")}`);
    if (byId.has(adapter.id)) throw new Error(`Interop adapter ${adapter.id} registered twice`);
    byId.set(adapter.id, adapter);
    prefixes.push({ adapter, robotPrefix, missionPrefix });
  }
  for (const entry of adapters) register(entry.adapter, entry);

  const adapterForRobot = (id) => prefixes.find((entry) => String(id || "").startsWith(entry.robotPrefix))?.adapter || null;
  const adapterForMission = (id) => prefixes.find((entry) => String(id || "").startsWith(entry.missionPrefix))?.adapter || null;

  async function listRobots(db, userId) {
    const lists = await Promise.all([...byId.values()].map((adapter) => adapter.listRobots(db, userId)));
    return lists.flat();
  }
  /** By id, or by name (exact, any case) across every adapter. */
  async function resolve(db, userId, reference) {
    const wanted = String(reference || "").trim();
    const direct = adapterForRobot(wanted);
    if (direct) return { adapter: direct, robot: await direct.getRobot(db, userId, wanted) };
    const all = await listRobots(db, userId);
    const matches = all.filter((robot) => robot.name.toLowerCase() === wanted.toLowerCase());
    if (matches.length === 1) return { adapter: byId.get(matches[0].adapter), robot: matches[0] };
    throw fail(matches.length ? 409 : 404, matches.length ? `More than one robot is called “${wanted}”. Use its id.` : `No robot called “${wanted.slice(0, 60)}” in your account.`, matches.length ? "ambiguous-robot" : "not-found", { candidates: all.map((robot) => ({ id: robot.id, name: robot.name, adapter: robot.adapter })) });
  }

  async function assess(db, userId, reference, missionType, params) {
    const { adapter, robot } = await resolve(db, userId, reference);
    return { adapter: adapter.id, ...(await adapter.assess(db, userId, robot.id, missionType, params)) };
  }
  async function submit(db, userId, reference, missionType, params, options) {
    const { adapter, robot } = await resolve(db, userId, reference);
    return adapter.submit(db, userId, robot.id, missionType, params, options);
  }
  async function requestAssistance(db, userId, reference, options) {
    const { adapter, robot } = await resolve(db, userId, reference);
    return adapter.requestAssistance(db, userId, robot.id, options);
  }
  async function reportStatus(db, userId, reference) {
    const { adapter, robot } = await resolve(db, userId, reference);
    return adapter.reportStatus(db, userId, robot.id);
  }
  const missionAdapter = (id) => { const adapter = adapterForMission(id); if (!adapter) throw fail(404, "No such mission.", "not-found"); return adapter; };
  const getMission = (db, userId, id) => missionAdapter(id).getMission(db, userId, id);
  const cancel = (db, userId, id) => missionAdapter(id).cancel(db, userId, id);
  async function listMissions(db, userId, { robotId = null, limit = 30 } = {}) {
    if (robotId) { const adapter = adapterForRobot(robotId); return adapter ? adapter.listMissions(db, userId, { robotId, limit }) : []; }
    const lists = await Promise.all([...byId.values()].map((adapter) => adapter.listMissions(db, userId, { limit })));
    return lists.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** For every robot and every mission: supported or not, and why. The capability table people read. */
  async function capabilityMatrix(db, userId) {
    const robots = await listRobots(db, userId);
    return robots.map((robot) => ({ id: robot.id, name: robot.name, adapter: robot.adapter, kind: robot.kind, functions: robot.functions, missions: Object.fromEntries(Object.keys(capability.MISSIONS).map((type) => [type, capability.negotiate(robot.functions, type)])) }));
  }

  return {
    adapters: () => [...byId.values()].map((adapter) => ({ id: adapter.id, label: adapter.label, protocol: adapter.protocol })),
    adapter: (id) => byId.get(id) || null,
    assess, cancel, capabilityMatrix, getMission, listMissions, listRobots, register, reportStatus, requestAssistance, resolve, submit,
  };
}

module.exports = { createInteropRegistry };
