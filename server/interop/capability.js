"use strict";

/**
 * The normalized robot interface: one shape for every robot, whatever adapter
 * reaches it (HANNAH's own robot link, VDA 5050 over MQTT, …).
 *
 * A normalized robot has ten parts:
 *   identity      who it is: manufacturer, model, serial, protocol and version
 *   state         connection, how old the last report is, simulation or physical
 *   battery       charge and charging, or null when the robot doesn't report it
 *   pose          position on its map, map id, whether it is localized
 *   navigation    driving, paused, current goal
 *   mission       the mission it is working on, if any
 *   diagnostics   errors (normalized, with the vendor's original), emergency stop, safety fields
 *   mode          normalized operating mode, with the vendor's own value
 *   functions     the capability features it offers (FEATURES below)
 *   maintenance   what the adapter knows about service state, or null
 * plus `extensions`: everything vendor-specific the adapter received, kept as
 * it came (custom actions in a factsheet, information messages), never dropped.
 *
 * Missions are normalized too: navigate, inspect, deliver, dock, report
 * status, request assistance. negotiate() says whether a robot can do one,
 * from the features it offers, and explains what is missing. An adapter adds
 * its own protocol-specific reasons (a VDA 5050 factsheet that lacks an action
 * at the needed scope, a vehicle not in automatic mode).
 */

const FEATURES = {
  "navigation.goto-point": "Drive to a position on its map",
  "navigation.goto-named-place": "Drive to a place it knows by name",
  "navigation.waypoints": "Drive through several points in order",
  "navigation.dock": "Drive to its dock or charger",
  "charging.start": "Start charging at a charger",
  "sensing.capture-at-point": "Record what its sensors see at a point",
  "load.pick": "Pick up a load",
  "load.drop": "Put down a load",
  "control.stop": "Stop and hold position",
  "control.pause": "Pause the current mission and keep it",
  "control.cancel": "Cancel the current mission",
  "status.continuous": "Report its state continuously",
  "status.on-request": "Send a state report when asked",
};

/**
 * Each mission: what it needs (all of `requires`, and at least one of each
 * group in `anyOf`), whether it moves the robot, and its input.
 */
const MISSIONS = {
  navigate: {
    title: "Drive to a place", motion: true, requires: [], anyOf: [["navigation.goto-point", "navigation.goto-named-place"]],
    input: { x: "number", y: "number", theta: "number", place: "string", mapId: "string", maxSpeed: "number", tolerance: "number" },
  },
  inspect: {
    title: "Visit points and record", motion: true, requires: ["navigation.waypoints", "sensing.capture-at-point"], anyOf: [],
    input: { waypoints: "array", maxSpeed: "number", mapId: "string" },
  },
  deliver: {
    title: "Carry a load from one place to another", motion: true, requires: ["navigation.waypoints", "load.pick", "load.drop"], anyOf: [],
    input: { from: "object", to: "object", loadId: "string", loadType: "string", mapId: "string", maxSpeed: "number" },
  },
  dock: { title: "Go to the dock or charger", motion: true, requires: ["navigation.dock"], anyOf: [], input: { charge: "boolean", maxSpeed: "number" } },
  report_status: { title: "Report status", motion: false, read: true, requires: [], anyOf: [["status.continuous", "status.on-request"]], input: {} },
  request_assistance: { title: "Stop and ask a person for help", motion: false, deescalates: true, requires: [], anyOf: [["control.stop", "control.pause"]], input: { reason: "string" } },
};

/** Normalized error codes. Every vendor error maps to one, and keeps the original. */
const ERRORS = {
  "emergency-stop": { title: "Emergency stop engaged", needsPerson: true },
  "safety-field": { title: "A safety field was violated", needsPerson: false },
  "localization": { title: "The robot doesn't know where it is", needsPerson: true },
  "navigation-blocked": { title: "The way is blocked", needsPerson: false },
  "no-route": { title: "No route to the goal", needsPerson: false },
  "battery": { title: "Battery problem", needsPerson: false },
  "hardware-fault": { title: "Hardware fault", needsPerson: true },
  "sensor-fault": { title: "Sensor fault", needsPerson: true },
  "communication": { title: "Communication problem", needsPerson: false },
  "order-rejected": { title: "The robot refused the mission", needsPerson: false },
  "action-failed": { title: "An action failed", needsPerson: false },
  "load-handling": { title: "Load handling problem", needsPerson: true },
  "mode": { title: "The robot isn't in a mode that takes missions", needsPerson: true },
  "unknown": { title: "Vendor error", needsPerson: true },
};

/** A normalized error. `vendor` keeps exactly what the robot sent. */
function normalizedError(code, { severity = "error", message = "", vendor = null } = {}) {
  const known = ERRORS[code] ? code : "unknown";
  return { code: known, title: ERRORS[known].title, severity, needsPerson: severity === "fatal" || ERRORS[known].needsPerson, message: String(message || ERRORS[known].title).slice(0, 400), vendor };
}

/** Can a robot offering `functions` do `mission`? Returns { supported, missing: [{ feature, title }], explanation }. */
function negotiate(functions, missionType) {
  const definition = MISSIONS[missionType];
  if (!definition) return { supported: false, missing: [], explanation: `“${String(missionType).slice(0, 40)}” isn't a normalized mission. Missions are: ${Object.keys(MISSIONS).join(", ")}.` };
  const offered = new Set(functions || []);
  const missing = definition.requires.filter((feature) => !offered.has(feature)).map((feature) => ({ feature, title: FEATURES[feature] }));
  for (const group of definition.anyOf) if (!group.some((feature) => offered.has(feature))) missing.push({ feature: group.join(" | "), title: group.map((feature) => FEATURES[feature]).join(", or ") });
  return {
    supported: missing.length === 0, missing,
    explanation: missing.length ? `This robot can't ${definition.title.toLowerCase()}: it doesn't offer ${missing.map((item) => item.title.toLowerCase()).join("; ")}.` : `Supported: it offers what “${definition.title}” needs.`,
  };
}

/** Check a mission's input shape (types only; ranges are the adapter's and the safety checks' business). */
function checkInput(missionType, params = {}) {
  const definition = MISSIONS[missionType];
  if (!definition) return [`Unknown mission ${missionType}`];
  const problems = [];
  for (const [key, value] of Object.entries(params || {})) {
    const wanted = definition.input[key];
    if (!wanted) { problems.push(`${key} isn't an input of “${definition.title}”.`); continue; }
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actual !== wanted || (wanted === "number" && !Number.isFinite(value))) problems.push(`${key} must be ${wanted === "array" ? "a list" : `a ${wanted}`}.`);
  }
  return problems;
}

module.exports = { ERRORS, FEATURES, MISSIONS, checkInput, negotiate, normalizedError };
