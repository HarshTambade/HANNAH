"use strict";

/**
 * Interop adapter #1: robots on HANNAH's own robot link (server/robotics).
 *
 * Nothing about those robots changes: their missions are the capability
 * contract's (robotics/contract.js), checked by the robotics Safety Gateway
 * (robotics/safety.js) and dispatched as signed commands, exactly as the
 * robots.* actions do. This adapter only translates: a robot's registry view
 * into the normalized interface, and a normalized mission into the contract
 * capability that does it.
 */
const capability = require("../capability");
const contract = require("../../robotics/contract");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const FINAL = new Set(["succeeded", "unverified", "failed", "cancelled", "rejected", "expired", "timed-out", "lost"]);

/** Which contract capabilities give which normalized features. */
function featuresOf(robot) {
  const offered = new Set((robot.capabilities || []).filter((id) => !(robot.disabled || []).includes(id)));
  const features = ["status.continuous", "control.cancel"];
  if (offered.has("navigate_to")) features.push("navigation.goto-point", ...(Object.keys(robot.places || {}).length ? ["navigation.goto-named-place"] : []));
  if (offered.has("inspect_area")) features.push("navigation.waypoints", "sensing.capture-at-point");
  if (offered.has("return_to_dock") && robot.dock) features.push("navigation.dock");
  if (offered.has("stop_motion") || robot.status === "enrolled") features.push("control.stop");
  if (offered.has("navigate_to") || offered.has("inspect_area")) features.push("control.pause");
  return [...new Set(features)];
}

/** The contract capability and its input for a normalized mission, or the reason there is none. */
function mapMission(robot, missionType, params = {}) {
  switch (missionType) {
    case "navigate": return { capability: "navigate_to", params: { ...(params.place ? { place: params.place } : { x: params.x, y: params.y }), ...(Number.isFinite(params.theta) ? { yaw: params.theta } : {}), ...(Number.isFinite(params.maxSpeed) ? { maxSpeed: params.maxSpeed } : {}), ...(Number.isFinite(params.tolerance) ? { tolerance: params.tolerance } : {}) } };
    case "inspect": return { capability: "inspect_area", params: { waypoints: (params.waypoints || []).map((point) => (point?.place ? { place: point.place } : { x: point?.x, y: point?.y })), ...(Number.isFinite(params.maxSpeed) ? { maxSpeed: params.maxSpeed } : {}) } };
    case "dock": return { capability: "return_to_dock", params: Number.isFinite(params.maxSpeed) ? { maxSpeed: params.maxSpeed } : {} };
    case "deliver": return { problem: "HANNAH's robot contract has no load-handling capability (no pick or drop), so a robot on the HANNAH link can't carry a load. Use a vehicle that offers pick and drop, such as a VDA 5050 AGV." };
    case "report_status": return { capability: "report_robot_state", params: {} };
    case "request_assistance": return { capability: "stop_motion", params: { reason: String(params.reason || "Assistance requested").slice(0, 200) } };
    default: return { problem: capability.negotiate([], missionType).explanation };
  }
}

function createHannahLinkAdapter({ robotics }) {
  function normalize(robot, active = null) {
    const state = robot.online ? robot.state || {} : robot.state || null;
    const faults = (state?.faults || []).map((fault) => capability.normalizedError(/estop/i.test(fault.code) ? "emergency-stop" : /sensor|lidar|camera/i.test(`${fault.code} ${fault.message}`) ? "sensor-fault" : /local/i.test(`${fault.code} ${fault.message}`) ? "localization" : /batter/i.test(`${fault.code} ${fault.message}`) ? "battery" : "hardware-fault", { severity: "error", message: fault.message, vendor: { protocol: "HANNAH robot link", code: fault.code, message: fault.message } }));
    if (state?.estop?.engaged) faults.unshift(capability.normalizedError("emergency-stop", { severity: "fatal", message: `Emergency stop engaged${state.estop.source ? ` (${state.estop.source})` : ""}.`, vendor: { protocol: "HANNAH robot link", field: "estop", value: state.estop } }));
    for (const [id, reading] of Object.entries(state?.sensors || {})) if (reading?.ok === false) faults.push(capability.normalizedError("sensor-fault", { severity: "error", message: `${id} not reporting${reading.problem ? `: ${reading.problem}` : ""}.`, vendor: { protocol: "HANNAH robot link", sensor: id } }));
    return {
      id: robot.id, adapter: "hannah-link", name: robot.name, kind: robot.simulated ? "simulation" : "physical",
      identity: { manufacturer: robot.manufacturer || null, model: robot.model || null, serialNumber: robot.serialNumber || null, protocol: "HANNAH robot link", protocolVersion: "1", runtime: robot.runtimeVersion || null, fingerprint: robot.fingerprint || null },
      state: { connection: robot.connection, online: robot.online, lastReportAt: robot.lastSeenAt, ageS: robot.stateAgeS, stale: !robot.online },
      battery: state?.battery ? { percent: state.battery.percent, charging: Boolean(state.battery.charging) } : null,
      pose: state?.pose ? { x: state.pose.x, y: state.pose.y, theta: state.pose.yaw ?? null, mapId: robot.mapName || null, localized: state.localized !== false } : null,
      navigation: state ? { driving: ["navigating"].includes(state.mode), paused: state.mode === "paused", goal: state.nav?.goal || null } : null,
      mission: active ? { id: active.id, type: active.capability, status: active.status } : null,
      diagnostics: { errors: faults, estop: { engaged: state ? Boolean(state.estop?.engaged) : null, kind: state?.estop?.source || null }, fieldViolation: null },
      mode: { normalized: robot.online ? robot.mode : "offline", vendor: robot.mode, acceptsMissions: robot.status === "enrolled" && robot.online },
      functions: featuresOf(robot),
      maintenance: { supported: true, commissioning: robot.commissioning || null, note: "Service history is under Robots → maintenance." },
      extensions: { capabilities: robot.capabilities, refusedCapabilities: robot.refusedCapabilities || [], places: Object.keys(robot.places || {}), simulator: robot.simulator || null },
      status: robot.status,
    };
  }

  async function listRobots(db, userId) {
    const robots = await robotics.listRobots(db, userId);
    const out = [];
    for (const robot of robots) out.push(normalize(robot, robot.status === "enrolled" ? await robotics.activeMotion(db, userId, robot.id) : null));
    return out;
  }
  async function getRobot(db, userId, id) {
    const robot = await robotics.getRobot(db, userId, id);
    return normalize(robot, await robotics.activeMotion(db, userId, robot.id));
  }

  /** Negotiate, then the robotics Safety Gateway on the mapped capability. */
  async function assess(db, userId, robotId, missionType, params = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const normalized = normalize(robot, await robotics.activeMotion(db, userId, robot.id));
    const negotiation = capability.negotiate(normalized.functions, missionType);
    const problems = capability.checkInput(missionType, params);
    const mapped = mapMission(robot, missionType, params);
    const violations = problems.map((message) => ({ code: "bad-input", message }));
    if (mapped.problem) violations.push({ code: "unsupported", message: mapped.problem });
    else if (!negotiation.supported) violations.push({ code: "unsupported", message: negotiation.explanation });
    if (violations.length) return { ok: false, robot: normalized, violations, warnings: [], negotiation, flags: [] };
    const verdict = await robotics.assess(db, userId, robot, mapped.capability, mapped.params);
    return { ok: verdict.ok, robot: normalized, violations: verdict.violations, warnings: verdict.warnings || [], negotiation, flags: verdict.flags || [], plan: { capability: mapped.capability, params: verdict.params || mapped.params, risk: contract.capability(mapped.capability)?.risk } };
  }

  async function submit(db, userId, robotId, missionType, params = {}, { actionId = null, identity = {} } = {}) {
    const verdict = await assess(db, userId, robotId, missionType, params);
    if (!verdict.ok) throw fail(409, `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`, "refused", { violations: verdict.violations });
    const robot = await robotics.getRobot(db, userId, robotId);
    // The command-validation chain again, at the moment it is sent, with the approved request behind it (robotics/chain.js).
    const chained = await robotics.assess(db, userId, robot, verdict.plan.capability, verdict.plan.params, { stage: "execute", identity, authorization: { kind: "action-record", recordId: actionId } });
    if (!chained.ok) throw fail(409, `Not sent. ${chained.violations.map((item) => item.message).join(" ")}`, "safety-refused", { violations: chained.violations });
    const mission = await robotics.dispatch(db, userId, { robot: chained.robot, capabilityId: verdict.plan.capability, params: chained.params, actionId, requestedBy: "interop", verdict: chained });
    return publicMission(await robotics.waitFor(db, userId, mission.id, (item) => item.status !== "queued" && item.status !== "sent"), missionType);
  }
  function publicMission(mission, missionType = null) {
    return { id: mission.id, robotId: mission.robotId, adapter: "hannah-link", mission: missionType || mission.capability, title: mission.title, params: mission.params, status: mission.status, final: FINAL.has(mission.status), vendorRef: mission.capability, actionId: mission.actionId, evidence: mission.verification?.evidence || null, error: mission.error, createdAt: mission.createdAt, finishedAt: mission.finishedAt };
  }
  async function getMission(db, userId, id) { return publicMission(await robotics.getMission(db, userId, id)); }
  async function listMissions(db, userId, { robotId = null, limit = 30 } = {}) { return (await robotics.listMissions(db, userId, { robotId, limit })).map((mission) => publicMission(mission)); }
  async function cancel(db, userId, id) { return publicMission(await robotics.cancelMission(db, userId, id)); }
  async function requestAssistance(db, userId, robotId, { reason = "" } = {}) {
    const stopped = await robotics.stop(db, userId, robotId, { reason: `Assistance requested: ${String(reason || "no reason given").slice(0, 160)}`, requestedBy: "interop" });
    await robotics.addMaintenance(db, userId, robotId, { kind: "note", note: `Assistance requested through interop: ${String(reason || "no reason given").slice(0, 300)}` }).catch(() => null);
    return { missionId: stopped?.id || null, sent: "stop_motion", note: "The robot was asked to stop and hold (a software stop, not an emergency stop). A person is needed." };
  }
  async function reportStatus(db, userId, robotId) { return getRobot(db, userId, robotId); }

  return {
    id: "hannah-link", label: "HANNAH robot link",
    protocol: { name: "HANNAH robot link", version: "1", transport: "HTTPS, robot-initiated, signed requests", verifiedWith: "HANNAH's robot runtime, its simulators and stand-in robots in the server's integration tests." },
    assess, cancel, getMission, getRobot, listMissions, listRobots, reportStatus, requestAssistance, submit,
  };
}

module.exports = { createHannahLinkAdapter, featuresOf, mapMission };
