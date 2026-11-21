"use strict";

/**
 * The Robotics Safety Gateway, server side.
 *
 * Every robot command passes through check() twice: when it is asked for (so
 * a command that can't be valid is refused before anyone is asked to approve
 * it) and again at the moment it is sent (a robot's state changes while an
 * approval waits). It answers three questions, in this order:
 *
 *   1. Is this a valid command for this robot? (registered capability, input
 *      that matches the contract, a goal inside the workspace and outside
 *      keep-out zones, a speed no higher than the robot's limit)
 *   2. Is the robot in a state to take it? (reporting, emergency stop
 *      released, motors enabled, no fault, localized, battery, nothing else
 *      moving it)
 *   3. How risky is it, and does a person have to approve it?
 *
 * What this is not: a safety function. It runs on a server that the robot must
 * be safe without. The robot's own runtime repeats these checks against its
 * local limits before it moves, its controller enforces speed and
 * acceleration, and an emergency stop is hardware on the robot. Limits flow
 * one way: the robot reports its limits, a person may tighten them here, and
 * nothing here can loosen what the robot enforces.
 */
const { capability: capabilityOf, validate, PRECONDITIONS } = require("./contract");

const ONLINE_MS = 12_000;
const ENVIRONMENTS = {
  simulation: "Simulation",
  "enclosed-no-people": "Physical, in a space people can't enter while it runs",
  "shared-with-people": "Physical, in a space shared with people",
};

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > point.y) !== (yj > point.y) && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cleanPolygon(input) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 64) return null;
  const points = input.map((pair) => (Array.isArray(pair) && finite(pair[0]) && finite(pair[1]) ? [round(pair[0], 3), round(pair[1], 3)] : null));
  return points.every(Boolean) ? points : null;
}

function cleanZones(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((zone) => ({ name: String(zone?.name || "zone").replace(/[^\w .-]/g, "").slice(0, 40) || "zone", polygon: cleanPolygon(zone?.polygon) })).filter((zone) => zone.polygon);
}

/** Limits as a robot reports them (or a person tightens them): known fields only, in range. */
function normalizeLimits(input) {
  const out = {};
  const bounded = (name, min, max) => { const value = Number(input?.[name]); if (input?.[name] !== undefined && input?.[name] !== null && Number.isFinite(value) && value >= min && value <= max) out[name] = value; };
  bounded("maxLinearSpeed", 0.01, 20);
  bounded("maxAngularSpeed", 0.01, 20);
  bounded("maxLinearAccel", 0.01, 50);
  bounded("minBatteryPercent", 0, 100);
  bounded("linkTimeoutS", 1, 600);
  bounded("commandTtlS", 2, 300);
  bounded("robotRadius", 0.01, 5);
  const polygon = cleanPolygon(input?.workspace?.polygon);
  if (polygon) out.workspace = { frame: String(input.workspace.frame || "map").slice(0, 20), polygon };
  const zones = cleanZones(input?.keepOut);
  if (zones.length) out.keepOut = zones;
  if (Object.hasOwn(ENVIRONMENTS, input?.environment)) out.environment = input.environment;
  if (input?.estop && typeof input.estop === "object") out.estop = { hardware: input.estop.hardware === true, description: String(input.estop.description || "").slice(0, 200) };
  if (typeof input?.motionRequiresApproval === "boolean") out.motionRequiresApproval = input.motionRequiresApproval;
  return out;
}

/**
 * The limits in force: the robot's own, tightened by the owner's. For a
 * number, the stricter of the two. Workspaces intersect (a goal must be inside
 * both). Keep-out zones add up. The environment is the robot's to declare.
 */
function effectiveLimits(safety) {
  const reported = safety?.reported || {};
  const owner = safety?.owner || {};
  const stricter = (name, pick) => (finite(reported[name]) && finite(owner[name]) ? pick(reported[name], owner[name]) : finite(reported[name]) ? reported[name] : finite(owner[name]) ? owner[name] : undefined);
  return {
    maxLinearSpeed: stricter("maxLinearSpeed", Math.min),
    maxAngularSpeed: stricter("maxAngularSpeed", Math.min),
    maxLinearAccel: stricter("maxLinearAccel", Math.min),
    minBatteryPercent: stricter("minBatteryPercent", Math.max),
    linkTimeoutS: stricter("linkTimeoutS", Math.min),
    commandTtlS: stricter("commandTtlS", Math.min) ?? 20,
    robotRadius: reported.robotRadius,
    workspaces: [reported.workspace, owner.workspace].filter(Boolean),
    keepOut: [...(reported.keepOut || []), ...(owner.keepOut || [])],
    environment: reported.environment || null,
    estop: reported.estop || null,
    motionRequiresApproval: owner.motionRequiresApproval === true,
  };
}

/** Turn a goal given as a place name or as x and y into a point, or say why not. */
function resolvePoint(input, places, label) {
  if (input?.place !== undefined && input?.place !== null && input.place !== "") {
    if (finite(input.x) || finite(input.y)) return { problem: `${label}: give a place or x and y, not both` };
    const wanted = String(input.place).trim().toLowerCase();
    const match = Object.entries(places || {}).find(([name]) => name.toLowerCase() === wanted);
    if (!match) return { problem: `${label}: the robot has no place called “${String(input.place).slice(0, 60)}”${Object.keys(places || {}).length ? ` (it has: ${Object.keys(places).slice(0, 12).join(", ")})` : ""}` };
    return { point: { x: match[1].x, y: match[1].y, ...(finite(match[1].yaw) ? { yaw: match[1].yaw } : {}), place: match[0] } };
  }
  if (!finite(input?.x) || !finite(input?.y)) return { problem: `${label}: give a place name, or x and y in metres` };
  return { point: { x: input.x, y: input.y, ...(finite(input.yaw) ? { yaw: input.yaw } : {}) } };
}

function pointProblems(point, limits, label) {
  const problems = [];
  for (const workspace of limits.workspaces) {
    if (!pointInPolygon(point, workspace.polygon)) problems.push({ code: "outside-workspace", message: `${label} (${round(point.x)}, ${round(point.y)}) is outside the robot's allowed workspace.` });
  }
  for (const zone of limits.keepOut) {
    if (pointInPolygon(point, zone.polygon)) problems.push({ code: "keep-out", message: `${label} (${round(point.x)}, ${round(point.y)}) is inside the keep-out zone “${zone.name}”.` });
  }
  return problems;
}

/**
 * Check one command.
 *   robot    the registry's view: { status, simulated, capabilities, disabled, alwaysAsk, safety, places, dock, devices, sensors, state, lastSeenAt }
 *   active   the robot's unfinished motion mission, if any
 * Returns { ok, violations: [{ code, message }], warnings, risk, flags, params, limits }.
 * `params` is what would be sent: places resolved to points, defaults filled, speed capped.
 */
function check({ robot, capabilityId, params = {}, now = Date.now(), active = null }) {
  const definition = capabilityOf(capabilityId);
  const violations = [];
  const warnings = [];
  const flags = [];
  const refuse = (code, message) => violations.push({ code, message });
  if (!definition) return { ok: false, violations: [{ code: "unknown-capability", message: `“${String(capabilityId).slice(0, 60)}” isn't a robot capability.` }], warnings, flags, risk: "high", params: {}, limits: null };
  if (!robot) return { ok: false, violations: [{ code: "unknown-robot", message: "That robot isn't enrolled in your account." }], warnings, flags, risk: definition.risk, params: {}, limits: null };
  const limits = effectiveLimits(robot.safety);
  const out = { risk: definition.risk, limits };

  // 1. Is it a valid command for this robot?
  if (robot.status === "revoked") refuse("revoked", `${robot.name}'s credentials were revoked. Enroll it again to use it.`);
  else if (robot.status !== "enrolled") refuse("not-enrolled", `${robot.name} hasn't finished enrolling.`);
  if (!robot.capabilities.includes(definition.id)) refuse("unsupported", `${robot.name} doesn't offer “${definition.title}”.`);
  else if ((robot.disabled || []).includes(definition.id)) refuse("disabled", `“${definition.title}” is switched off for ${robot.name}.`);
  for (const problem of validate(definition.input, params)) refuse("invalid-input", problem.replace(/^input\.?/, "") || problem);

  const sent = {};
  if (!violations.some((item) => item.code === "invalid-input")) {
    if (definition.id === "navigate_to") {
      const { point, problem } = resolvePoint(params, robot.places, "Goal");
      if (problem) refuse("invalid-input", problem);
      else { Object.assign(sent, point, { tolerance: params.tolerance ?? 0.25 }); violations.push(...pointProblems(point, limits, "The goal")); }
    } else if (definition.id === "return_to_dock") {
      if (!robot.dock || !finite(robot.dock.x) || !finite(robot.dock.y)) refuse("dock-configured", `${robot.name} has no dock position.`);
      else { Object.assign(sent, { x: robot.dock.x, y: robot.dock.y, ...(finite(robot.dock.yaw) ? { yaw: robot.dock.yaw } : {}), place: "dock", tolerance: 0.25 }); violations.push(...pointProblems(robot.dock, limits, "The dock")); }
    } else if (definition.id === "inspect_area") {
      sent.waypoints = [];
      (params.waypoints || []).forEach((item, index) => {
        const { point, problem } = resolvePoint(item, robot.places, `Point ${index + 1}`);
        if (problem) return refuse("invalid-input", problem);
        sent.waypoints.push(point);
        return violations.push(...pointProblems(point, limits, `Point ${index + 1}`));
      });
      sent.tolerance = params.tolerance ?? 0.3;
    } else if (definition.id === "set_supported_device_state") {
      if (!Object.hasOwn(robot.devices || {}, params.device)) refuse("unknown-device", `${robot.name} has no switchable device called “${params.device}”${Object.keys(robot.devices || {}).length ? ` (it has: ${Object.keys(robot.devices).join(", ")})` : ""}.`);
      Object.assign(sent, { device: params.device, state: params.state });
    } else if (definition.id === "read_sensor") {
      if (!(robot.sensors || []).some((sensor) => sensor.id === params.sensor)) refuse("unknown-sensor", `${robot.name} has no sensor called “${params.sensor}”${(robot.sensors || []).length ? ` (it has: ${robot.sensors.map((sensor) => sensor.id).join(", ")})` : ""}.`);
      sent.sensor = params.sensor;
    } else if (definition.id === "stop_motion") {
      if (params.reason) sent.reason = params.reason;
    }
    if (definition.motion) {
      if (finite(params.maxSpeed)) {
        if (finite(limits.maxLinearSpeed) && params.maxSpeed > limits.maxLinearSpeed) refuse("over-speed", `The requested speed ${params.maxSpeed} m/s is above ${robot.name}'s limit of ${limits.maxLinearSpeed} m/s.`);
        else sent.maxSpeed = params.maxSpeed;
      } else if (finite(limits.maxLinearSpeed)) sent.maxSpeed = limits.maxLinearSpeed;
      if (!finite(limits.maxLinearSpeed)) refuse("no-speed-limit", `${robot.name} didn't report a speed limit, so HANNAH won't move it.`);
      if (!limits.workspaces.length) refuse("no-workspace", `${robot.name} didn't report a workspace, so HANNAH won't move it.`);
    }
  }

  // 2. Is the robot in a state to take it?
  const state = robot.state || null;
  const age = robot.lastSeenAt ? now - robot.lastSeenAt : Infinity;
  const online = age <= ONLINE_MS;
  const needs = (id) => definition.preconditions.includes(id);
  const unmet = (id, detail) => refuse(`precondition:${id}`, detail || PRECONDITIONS[id]);
  if (robot.status === "enrolled") {
    if (needs("online") && !online) unmet("online", robot.lastSeenAt ? `${robot.name} last reported ${Math.round(age / 1000)} seconds ago; it is offline.` : `${robot.name} has never connected.`);
    else if (needs("online") && state) {
      if (needs("estop-released") && state.estop?.engaged) unmet("estop-released", `${robot.name}'s emergency stop is engaged. It has to be released at the robot.`);
      if (needs("motors-enabled") && state.motorsEnabled === false) unmet("motors-enabled", `${robot.name}'s motors are disabled.`);
      if (needs("no-fault") && Array.isArray(state.faults) && state.faults.length) unmet("no-fault", `${robot.name} reports a fault: ${String(state.faults[0]?.message || state.faults[0]?.code || "unknown").slice(0, 120)}.`);
      if (needs("localized") && state.localized === false) unmet("localized", `${robot.name} doesn't know where it is on its map.`);
      if (needs("battery-ok") && finite(limits.minBatteryPercent) && finite(state.battery?.percent) && state.battery.percent < limits.minBatteryPercent && definition.id !== "return_to_dock") unmet("battery-ok", `${robot.name}'s battery is at ${Math.round(state.battery.percent)}%, below its ${limits.minBatteryPercent}% minimum for starting a mission.`);
    } else if (needs("online") && !state) unmet("online", `${robot.name} hasn't reported its state yet.`);
    if (needs("no-active-motion") && active) unmet("no-active-motion", `${robot.name} is already on a mission (${active.capability}). Stop it or wait for it to finish.`);
  }

  // 3. Risk, and whether a person has to approve.
  if (definition.motion) {
    if (!robot.simulated) {
      out.risk = limits.environment === "shared-with-people" || !limits.environment ? "high" : "moderate";
      flags.push("this is a physical robot and it will move");
      warnings.push("HANNAH's stop is a software request to the robot. Keep the robot's own emergency stop within reach.");
      if (!limits.estop?.hardware) warnings.push(`${robot.name} didn't report a hardware emergency stop.`);
    }
    if (limits.motionRequiresApproval) flags.push(`you set ${robot.name} to ask before every movement`);
  }
  if ((robot.alwaysAsk || []).includes(definition.id) && !definition.deescalates) flags.push(`you set “${definition.title}” on ${robot.name} to always ask`);

  return { ok: violations.length === 0, violations, warnings, flags, params: sent, ...out };
}

module.exports = { ENVIRONMENTS, ONLINE_MS, check, effectiveLimits, normalizeLimits, pointInPolygon };
