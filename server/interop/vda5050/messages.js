"use strict";

/**
 * VDA 5050 2.0 messages: building what master control sends (order,
 * instantActions) and reading what a vehicle sends (state, connection,
 * factsheet) into HANNAH's normalized interface. Section numbers refer to
 * VDA 5050 2.0.0 (VDA5050_EN at tag 2.0.0 of github.com/VDA5050/VDA5050).
 */
const capability = require("../capability");

const VERSION = "2.0.0";
/** §6.8.1 predefined actions. Anything else in a factsheet is a vendor extension. */
const PREDEFINED_ACTIONS = new Set(["startPause", "stopPause", "startCharging", "stopCharging", "initPosition", "stateRequest", "logReport", "pick", "drop", "detectObject", "finePositioning", "waitForTrigger", "cancelOrder"]);
/** §6.10.6 operating modes. Master control is in control only in the first two. */
const MODES = { AUTOMATIC: "autonomous", SEMIAUTOMATIC: "semi-autonomous", MANUAL: "manual", SERVICE: "service", TEACHIN: "teach-in" };
const CONTROLLABLE_MODES = new Set(["AUTOMATIC", "SEMIAUTOMATIC"]);
/** §6.3: topic levels may not contain "/" or "$"; the serial number is A-Z a-z 0-9 _ . : - */
const SERIAL = /^[A-Za-z0-9_.:-]{1,64}$/;
const LEVEL = /^[^/$#+\s]{1,64}$/;

/** §6.3: interfaceName/majorVersion/manufacturer/serialNumber/topic, e.g. uagv/v2/KIT/0001/order */
function topicFor({ interfaceName = "uagv", majorVersion = "v2", manufacturer, serialNumber }, topic) {
  if (!LEVEL.test(interfaceName) || !LEVEL.test(majorVersion) || !LEVEL.test(manufacturer) || !SERIAL.test(serialNumber)) throw new Error("A VDA 5050 topic level may not contain / $ # + or spaces, and a serial number is A-Z a-z 0-9 _ . : -");
  return `${interfaceName}/${majorVersion}/${manufacturer}/${serialNumber}/${topic}`;
}
function parseTopic(topic) {
  const parts = String(topic).split("/");
  if (parts.length !== 5) return null;
  const [interfaceName, majorVersion, manufacturer, serialNumber, name] = parts;
  return { interfaceName, majorVersion, manufacturer, serialNumber, topic: name };
}

/** §6.4 protocol header. headerId counts per topic. */
function header(vehicle, headerId, at = Date.now()) {
  return { headerId, timestamp: new Date(at).toISOString(), version: VERSION, manufacturer: vehicle.manufacturer, serialNumber: vehicle.serialNumber };
}

/** The actions a factsheet offers, by type, with their scopes (§7.1.3 protocolFeatures.agvActions). */
function actionsOf(factsheet) {
  const out = new Map();
  for (const action of factsheet?.protocolFeatures?.agvActions || []) {
    if (action && typeof action.actionType === "string") out.set(action.actionType, { scopes: new Set(action.actionScopes || []), parameters: action.actionParameters || [], description: action.actionDescription || "" });
  }
  return out;
}
const offers = (actions, type, scope) => Boolean(actions.get(type)?.scopes.has(scope));

/** Which normalized features a vehicle offers, from its factsheet and what its owner configured. */
function featuresOf(factsheet, config = {}) {
  const actions = actionsOf(factsheet);
  const features = ["status.continuous"]; // §6.5: state is mandatory
  if ((factsheet?.typeSpecification?.navigationTypes || []).length) features.push("navigation.goto-point", "navigation.waypoints");
  if (Object.keys(config.stations || {}).length) features.push("navigation.goto-named-place");
  if (config.dock) features.push("navigation.dock");
  if (offers(actions, "startCharging", "NODE")) features.push("charging.start");
  if (offers(actions, config.inspectAction || "detectObject", "NODE")) features.push("sensing.capture-at-point");
  if (offers(actions, "pick", "NODE")) features.push("load.pick");
  if (offers(actions, "drop", "NODE")) features.push("load.drop");
  if (offers(actions, "startPause", "INSTANT")) features.push("control.pause", "control.stop");
  if (offers(actions, "cancelOrder", "INSTANT")) features.push("control.cancel");
  if (offers(actions, "stateRequest", "INSTANT")) features.push("status.on-request");
  return features;
}

/** VDA 5050 reasons a mission can't be sent, beyond missing features: the factsheet said exactly what is missing. */
function vdaReasons(factsheet, config, missionType, params = {}) {
  const actions = actionsOf(factsheet);
  const reasons = [];
  const need = (type, scope, why) => { if (!offers(actions, type, scope)) reasons.push({ code: "vda5050:action-missing", message: `The vehicle's factsheet lists no “${type}” action with scope ${scope} (VDA 5050 2.0 §6.8.1, §7.1.3), so it can't ${why}.` }); };
  if (missionType === "inspect") need(config.inspectAction || "detectObject", "NODE", "record anything at the points");
  if (missionType === "deliver") { need("pick", "NODE", "pick up a load"); need("drop", "NODE", "put a load down"); }
  if (missionType === "dock" && !config.dock) reasons.push({ code: "vda5050:no-dock", message: "No dock or charger position is configured for this vehicle. Add one before asking it to dock." });
  if (missionType === "dock" && params.charge !== false && config.dock && !offers(actions, "startCharging", "NODE")) reasons.push({ code: "vda5050:action-missing", message: "The vehicle's factsheet lists no startCharging action at a node (§6.8.1), so it can drive to the dock but not start charging. Ask with charge: false to only drive there." });
  if (missionType === "request_assistance" && !offers(actions, "startPause", "INSTANT")) reasons.push({ code: "vda5050:action-missing", message: "The vehicle's factsheet lists no instant startPause action (§6.8.1), so HANNAH can't make it hold. Use the vehicle's own stop." });
  if (params.place && !config.stations?.[params.place]) reasons.push({ code: "unknown-place", message: `No station called “${String(params.place).slice(0, 40)}” is configured for this vehicle.` });
  return reasons;
}

/** Map a vendor error (§6.10.5) to a normalized one, keeping the original. */
function normalizeVdaError(error) {
  const type = String(error?.errorType || "");
  const text = `${type} ${error?.errorDescription || ""}`;
  const severity = error?.errorLevel === "FATAL" ? "fatal" : "warning";
  const references = Array.isArray(error?.errorReferences) ? error.errorReferences : [];
  let code = "unknown";
  if (["validationError", "orderError", "orderUpdateError"].includes(type)) code = "order-rejected"; // §6.6.4
  else if (/obstacle|block/i.test(text)) code = "navigation-blocked";
  else if (/no.?route|no.?path|path.?not/i.test(text)) code = "no-route";
  else if (/locali[sz]|position|lost/i.test(text)) code = "localization";
  else if (/batter|charg/i.test(text)) code = "battery";
  else if (/load|pick|drop|fork|lhd/i.test(text)) code = "load-handling";
  else if (/sensor|lidar|scanner|camera/i.test(text)) code = "sensor-fault";
  else if (/motor|drive|hardware|controller|brake/i.test(text)) code = "hardware-fault";
  else if (/comm|connect|network|mqtt/i.test(text)) code = "communication";
  else if (references.some((item) => item?.referenceKey === "actionId")) code = "action-failed";
  return capability.normalizedError(code, { severity, message: error?.errorDescription || type, vendor: { protocol: "VDA 5050 2.0", errorType: type, errorLevel: error?.errorLevel || null, errorDescription: error?.errorDescription || null, errorReferences: references } });
}

/** Everything wrong with a vehicle, normalized: its errors, the emergency stop, safety fields, failed actions. */
function diagnosticsOf(state) {
  const errors = (state?.errors || []).map(normalizeVdaError);
  const estop = state?.safetyState?.eStop;
  if (estop && estop !== "NONE") errors.unshift(capability.normalizedError("emergency-stop", { severity: "fatal", message: `Emergency stop engaged (${estop}).`, vendor: { protocol: "VDA 5050 2.0", field: "safetyState.eStop", value: estop } }));
  if (state?.safetyState?.fieldViolation) errors.push(capability.normalizedError("safety-field", { severity: "warning", message: "A protective field is violated.", vendor: { protocol: "VDA 5050 2.0", field: "safetyState.fieldViolation", value: true } }));
  for (const action of state?.actionStates || []) if (action.actionStatus === "FAILED") errors.push(capability.normalizedError("action-failed", { severity: "warning", message: `${action.actionType || "action"} ${action.actionId} failed${action.resultDescription ? `: ${action.resultDescription}` : ""}.`, vendor: { protocol: "VDA 5050 2.0", actionId: action.actionId, actionType: action.actionType || null, resultDescription: action.resultDescription || null } }));
  return { errors, estop: { engaged: Boolean(estop && estop !== "NONE"), kind: estop || null }, fieldViolation: Boolean(state?.safetyState?.fieldViolation) };
}

/** The extensions a vehicle offers or reported, kept as they came. */
function extensionsOf(factsheet, state) {
  const vendorActions = [...actionsOf(factsheet)].filter(([type]) => !PREDEFINED_ACTIONS.has(type)).map(([type, item]) => ({ actionType: type, scopes: [...item.scopes], parameters: item.parameters, description: item.description }));
  const known = new Set(["headerId", "timestamp", "version", "manufacturer", "serialNumber", "orderId", "orderUpdateId", "zoneSetId", "lastNodeId", "lastNodeSequenceId", "driving", "paused", "newBaseRequest", "distanceSinceLastNode", "operatingMode", "nodeStates", "edgeStates", "agvPosition", "velocity", "loads", "actionStates", "batteryState", "errors", "information", "safetyState"]);
  const extraStateFields = Object.fromEntries(Object.entries(state || {}).filter(([key]) => !known.has(key)));
  return { vendorActions, information: state?.information || [], extraStateFields, optionalParameters: factsheet?.protocolFeatures?.optionalParameters || [] };
}

/** Build an order (§6.6, §6.7) for a normalized mission. Nodes get even sequence ids, edges odd (§6.6.2). */
function buildOrder({ vehicle, headerId, at = Date.now(), orderId, state, mapId, points, maxSpeed = null, startDeviation = 0.5, nodeActions = {} }) {
  const position = state?.agvPosition;
  const nodes = [{
    // §6.6.3.1: the first node is a temporary node where the vehicle stands, so it is trivially reachable.
    nodeId: `${orderId}-start`, sequenceId: 0, released: true, nodeDescription: "Where the vehicle stands when HANNAH sends the order",
    nodePosition: { x: position.x, y: position.y, ...(Number.isFinite(position.theta) ? { theta: position.theta } : {}), allowedDeviationXy: startDeviation, mapId },
    actions: [],
  }];
  const edges = [];
  points.forEach((point, index) => {
    const nodeId = point.nodeId || `${orderId}-n${index + 1}`;
    const previous = nodes[nodes.length - 1];
    edges.push({ edgeId: `${orderId}-e${index + 1}`, sequenceId: previous.sequenceId + 1, released: true, startNodeId: previous.nodeId, endNodeId: nodeId, ...(maxSpeed ? { maxSpeed } : {}), actions: [] });
    nodes.push({
      nodeId, sequenceId: previous.sequenceId + 2, released: true, ...(point.description ? { nodeDescription: point.description } : {}),
      nodePosition: { x: point.x, y: point.y, ...(Number.isFinite(point.theta) ? { theta: point.theta } : {}), allowedDeviationXy: point.tolerance ?? 0.25, mapId },
      actions: (nodeActions[index] || []).map((action, number) => ({ actionId: `${orderId}-a${index + 1}-${number + 1}`, actionType: action.type, blockingType: action.blocking || "HARD", ...(action.description ? { actionDescription: action.description } : {}), ...(action.parameters?.length ? { actionParameters: action.parameters } : {}) })),
    });
  });
  return { ...header(vehicle, headerId, at), orderId, orderUpdateId: 0, nodes, edges };
}

/** instantActions (§6.9). Both actionType (the specification) and actionName (the published 2.0.0 schema): see schemas/NOTICE.md. */
function buildInstantActions({ vehicle, headerId, at = Date.now(), actions }) {
  return { ...header(vehicle, headerId, at), actions: actions.map((action) => ({ actionId: action.id, actionType: action.type, actionName: action.type, blockingType: action.blocking || "NONE", ...(action.parameters?.length ? { actionParameters: action.parameters } : {}) })) };
}

/**
 * Where a mission stands, from the vehicle's state. Only what the state shows:
 *   sent        the vehicle hasn't taken the order (its orderId is another)
 *   rejected    it reported an order error (§6.6.4) instead of taking it
 *   accepted    it is working through the order; paused when §6.8 startPause is active
 *   succeeded   no nodes or edges left, standing still, at the last node within its tolerance, every action finished
 *   unverified  it says it is done but its position isn't at the goal
 *   failed      an action of the order failed, or a fatal error
 */
function missionProgress(order, state) {
  if (!state) return { status: "sent", evidence: "No state report from the vehicle yet." };
  const ours = state.orderId === order.orderId;
  const orderErrors = (state.errors || []).filter((error) => ["validationError", "orderError", "orderUpdateError"].includes(error.errorType));
  if (!ours) return orderErrors.length ? { status: "rejected", evidence: `The vehicle reported ${orderErrors.map((error) => `${error.errorType}${error.errorDescription ? ` (${error.errorDescription})` : ""}`).join(", ")} (VDA 5050 2.0 §6.6.4).` } : { status: "sent", evidence: `The vehicle's current order is “${state.orderId || "none"}”, not this one.` };
  const actionIds = new Set(order.nodes.flatMap((node) => node.actions.map((action) => action.actionId)));
  const mine = (state.actionStates || []).filter((action) => actionIds.has(action.actionId));
  const failed = mine.find((action) => action.actionStatus === "FAILED");
  if (failed) return { status: "failed", evidence: `Action ${failed.actionType || failed.actionId} failed${failed.resultDescription ? `: ${failed.resultDescription}` : ""}.` };
  const fatal = (state.errors || []).find((error) => error.errorLevel === "FATAL");
  if (fatal) return { status: "failed", evidence: `The vehicle reported a fatal error: ${fatal.errorType}${fatal.errorDescription ? ` (${fatal.errorDescription})` : ""}.` };
  const last = order.nodes[order.nodes.length - 1];
  const remaining = (state.nodeStates || []).length + (state.edgeStates || []).length;
  const actionsDone = [...actionIds].every((id) => mine.some((action) => action.actionId === id && action.actionStatus === "FINISHED"));
  if (remaining === 0 && !state.driving && state.lastNodeId === last.nodeId && actionsDone) {
    const pose = state.agvPosition;
    const distance = pose ? Math.hypot(pose.x - last.nodePosition.x, pose.y - last.nodePosition.y) : null;
    const within = distance !== null && distance <= (last.nodePosition.allowedDeviationXy || 0.25) + 1e-9;
    return within
      ? { status: "succeeded", evidence: `The vehicle reports the last node ${last.nodeId} reached, nothing left in the order, standing still, ${distance.toFixed(2)} m from the goal by its own position.` }
      : { status: "unverified", evidence: `The vehicle reports the order done, but its position is ${distance === null ? "unknown" : `${distance.toFixed(2)} m`} from the goal.` };
  }
  return { status: state.paused ? "paused" : "accepted", evidence: `${remaining} node${remaining === 1 ? "" : "s"} and edges left; last node ${state.lastNodeId || "none"}${state.driving ? ", driving" : ""}${state.paused ? ", paused" : ""}.`, progress: { lastNodeId: state.lastNodeId, remaining, driving: Boolean(state.driving) } };
}

module.exports = { CONTROLLABLE_MODES, MODES, PREDEFINED_ACTIONS, VERSION, actionsOf, buildInstantActions, buildOrder, diagnosticsOf, extensionsOf, featuresOf, header, missionProgress, normalizeVdaError, offers, parseTopic, topicFor, vdaReasons };
