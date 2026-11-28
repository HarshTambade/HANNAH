"use strict";

/**
 * A simulated AGV that speaks VDA 5050 2.0 over MQTT: HANNAH's test vehicle.
 * It is a simulation and says so in its factsheet; nothing it reports is a
 * measurement of hardware.
 *
 * It does what §6 asks of a vehicle: a last will of CONNECTIONBROKEN and a
 * retained ONLINE on `connection` (§6.14), its factsheet (§7), state reports
 * on change and at an interval (§6.10), orders checked against the order
 * schema and refused with validationError / orderError / orderUpdateError
 * (§6.6.4), node and edge traversal with actions run on arrival (§6.10.2,
 * §6.11), and the instant actions startPause, stopPause, cancelOrder and
 * stateRequest (§6.8.1, §6.9). Motion is straight lines at a fixed speed.
 */
const mqtt = require("./mqtt");
const schema = require("./schema");
const { header, topicFor } = require("./messages");

const DEFAULT_ACTIONS = [
  { actionType: "startPause", actionScopes: ["INSTANT"] },
  { actionType: "stopPause", actionScopes: ["INSTANT"] },
  { actionType: "cancelOrder", actionScopes: ["INSTANT"] },
  { actionType: "stateRequest", actionScopes: ["INSTANT"] },
  { actionType: "startCharging", actionScopes: ["INSTANT", "NODE"] },
  { actionType: "pick", actionScopes: ["NODE"], actionParameters: [{ key: "loadId", valueDataType: "STRING", isOptional: true }] },
  { actionType: "drop", actionScopes: ["NODE"], actionParameters: [{ key: "loadId", valueDataType: "STRING", isOptional: true }] },
  { actionType: "detectObject", actionScopes: ["NODE"] },
  { actionType: "hornBeep", actionDescription: "Vendor extension of the simulator: sound the horn.", actionScopes: ["INSTANT"] },
];

function createSimulatedAgv({ broker, manufacturer = "HANNAHSim", serialNumber = "AGV-001", interfaceName = "uagv", actions = DEFAULT_ACTIONS, speed = 2, tickMs = 40, stateEveryMs = 500, start = { x: 0, y: 0, theta: 0 }, mapId = "sim-floor", operatingMode = "AUTOMATIC", battery = 80, refuseActions = [] }) {
  const vehicle = { interfaceName, majorVersion: "v2", manufacturer, serialNumber };
  const ids = { state: 0, connection: 0, factsheet: 0 };
  const topic = (name) => topicFor(vehicle, name);
  const sim = {
    position: { ...start, mapId, positionInitialized: true }, operatingMode, battery, charging: false,
    order: null, nodeStates: [], edgeStates: [], lastNodeId: "", lastNodeSequenceId: 0, driving: false, paused: false,
    actionStates: [], errors: [], eStop: "NONE", fieldViolation: false, received: [], loads: [],
  };
  let client = null;
  let ticker = null;
  let reporter = null;

  const factsheet = () => ({
    ...header(vehicle, (ids.factsheet += 1)),
    typeSpecification: { seriesName: "HANNAH simulated AGV", seriesDescription: "Simulation: HANNAH's VDA 5050 test vehicle, not hardware.", agvKinematic: "DIFF", agvClass: "CARRIER", maxLoadMass: 50, localizationTypes: ["NATURAL"], navigationTypes: ["AUTONOMOUS"] },
    physicalParameters: { speedMin: 0.05, speedMax: speed, accelerationMax: 1, decelerationMax: 1, heightMax: 0.5, width: 0.6, length: 0.9 },
    protocolLimits: { maxStringLens: {}, maxArrayLens: {}, timing: { minOrderInterval: 0.1, minStateInterval: 0.1, defaultStateInterval: stateEveryMs / 1000 } },
    protocolFeatures: { optionalParameters: [], agvActions: actions },
    agvGeometry: {}, loadSpecification: {},
  });
  const supported = (type, scope) => actions.some((action) => action.actionType === type && (action.actionScopes || []).includes(scope));

  function state() {
    return {
      ...header(vehicle, (ids.state += 1)),
      orderId: sim.order?.orderId || "", orderUpdateId: sim.order?.orderUpdateId || 0,
      lastNodeId: sim.lastNodeId, lastNodeSequenceId: sim.lastNodeSequenceId,
      nodeStates: sim.nodeStates.map((node) => ({ nodeId: node.nodeId, sequenceId: node.sequenceId, released: node.released, ...(node.nodePosition ? { nodePosition: { x: node.nodePosition.x, y: node.nodePosition.y, theta: node.nodePosition.theta ?? 0, mapId: node.nodePosition.mapId } } : {}) })),
      edgeStates: sim.edgeStates.map((edge) => ({ edgeId: edge.edgeId, sequenceId: edge.sequenceId, released: edge.released })),
      driving: sim.driving, paused: sim.paused, operatingMode: sim.operatingMode,
      agvPosition: { x: round(sim.position.x), y: round(sim.position.y), theta: round(sim.position.theta), mapId: sim.position.mapId, positionInitialized: sim.position.positionInitialized },
      velocity: { vx: sim.driving ? speed : 0, vy: 0, omega: 0 },
      loads: sim.loads,
      actionStates: sim.actionStates.map((item) => ({ ...item })),
      batteryState: { batteryCharge: round(sim.battery), charging: sim.charging },
      errors: sim.errors.map((item) => ({ ...item })),
      information: [{ infoType: "simulation", infoLevel: "INFO", infoDescription: "This vehicle is simulated." }],
      safetyState: { eStop: sim.eStop, fieldViolation: sim.fieldViolation },
    };
  }
  const round = (value) => Math.round(value * 1000) / 1000;
  const publishState = () => client?.connected && client.publish(topic("state"), JSON.stringify(state())).catch(() => {});

  function reject(errorType, description, references = []) {
    sim.errors = sim.errors.filter((error) => !["validationError", "orderError", "orderUpdateError"].includes(error.errorType));
    sim.errors.push({ errorType, errorLevel: "WARNING", errorDescription: description, errorReferences: references });
    publishState();
  }

  function takeOrder(order) {
    const problems = schema.validate("order", order);
    if (problems.length) return reject("validationError", problems.slice(0, 3).join("; ")); // §6.6.4.1
    if (sim.order && order.orderId === sim.order.orderId) {
      if (order.orderUpdateId < sim.order.orderUpdateId) return reject("orderUpdateError", "orderUpdateId lower than the current one"); // §6.6.4.3
      if (order.orderUpdateId === sim.order.orderUpdateId) return undefined; // the same order again is ignored
    }
    if (["MANUAL", "SERVICE", "TEACHIN"].includes(sim.operatingMode)) return reject("orderError", `Not in a mode that takes orders (${sim.operatingMode}).`, [{ referenceKey: "operatingMode", referenceValue: sim.operatingMode }]);
    const unsupported = order.nodes.flatMap((node) => node.actions).find((action) => !supported(action.actionType, "NODE") || refuseActions.includes(action.actionType));
    if (unsupported) return reject("orderError", `Can't run ${unsupported.actionType} at a node.`, [{ referenceKey: "actionId", referenceValue: unsupported.actionId }]); // §6.6.4.2
    const first = order.nodes[0];
    if (Math.hypot(first.nodePosition.x - sim.position.x, first.nodePosition.y - sim.position.y) > (first.nodePosition.allowedDeviationXy || 0.5) + 1e-6) return reject("orderError", "The first node isn't where the vehicle stands.", [{ referenceKey: "nodeId", referenceValue: first.nodeId }]);
    sim.errors = sim.errors.filter((error) => !["validationError", "orderError", "orderUpdateError"].includes(error.errorType));
    sim.order = order;
    sim.lastNodeId = first.nodeId;
    sim.lastNodeSequenceId = first.sequenceId;
    sim.nodeStates = order.nodes.slice(1).map((node) => ({ ...node }));
    sim.edgeStates = order.edges.map((edge) => ({ ...edge }));
    sim.actionStates = order.nodes.flatMap((node) => node.actions.map((action) => ({ actionId: action.actionId, actionType: action.actionType, actionStatus: "WAITING" })));
    publishState();
    return undefined;
  }

  function runNodeActions(node) {
    for (const action of node.actions || []) {
      const entry = sim.actionStates.find((item) => item.actionId === action.actionId);
      if (!entry) continue;
      if (action.actionType === "pick") sim.loads = [{ loadId: action.actionParameters?.find((item) => item.key === "loadId")?.value || "load" }];
      if (action.actionType === "drop") sim.loads = [];
      if (action.actionType === "startCharging") sim.charging = true;
      if (sim.failAction === action.actionType) { entry.actionStatus = "FAILED"; entry.resultDescription = "Simulated failure."; } else { entry.actionStatus = "FINISHED"; }
    }
  }

  function tick() {
    if (!sim.order || sim.paused || sim.eStop !== "NONE" || !sim.nodeStates.length) { if (sim.driving) { sim.driving = false; publishState(); } return; }
    const next = sim.nodeStates[0];
    const dx = next.nodePosition.x - sim.position.x;
    const dy = next.nodePosition.y - sim.position.y;
    const distance = Math.hypot(dx, dy);
    const step = speed * (tickMs / 1000);
    sim.battery = Math.max(0, sim.battery - 0.001);
    if (distance <= step) {
      sim.position.x = next.nodePosition.x;
      sim.position.y = next.nodePosition.y;
      if (Number.isFinite(next.nodePosition.theta)) sim.position.theta = next.nodePosition.theta;
      sim.lastNodeId = next.nodeId;
      sim.lastNodeSequenceId = next.sequenceId;
      sim.nodeStates.shift();
      sim.edgeStates.shift();
      runNodeActions(next);
      sim.driving = sim.nodeStates.length > 0;
      publishState();
      return;
    }
    if (!sim.driving) { sim.driving = true; publishState(); }
    sim.position.x += (dx / distance) * step;
    sim.position.y += (dy / distance) * step;
    sim.position.theta = Math.atan2(dy, dx);
  }

  function instant(message) {
    const list = message.actions || message.instantActions || [];
    for (const action of list) {
      const type = action.actionType || action.actionName;
      const entry = { actionId: action.actionId, actionType: type, actionStatus: "FINISHED" };
      if (!supported(type, "INSTANT")) { entry.actionStatus = "FAILED"; entry.resultDescription = "Not supported."; }
      else if (type === "startPause") sim.paused = true;
      else if (type === "stopPause") sim.paused = false;
      else if (type === "cancelOrder") {
        // §6.6.3: stop, delete the order, cancel its actions.
        for (const item of sim.actionStates) if (["WAITING", "INITIALIZING", "RUNNING"].includes(item.actionStatus)) item.actionStatus = "FAILED";
        sim.nodeStates = []; sim.edgeStates = []; sim.driving = false;
      } else if (type === "startCharging") sim.charging = true;
      sim.actionStates.push(entry);
    }
    publishState();
  }

  async function connectToBroker() {
    client = await mqtt.connect({ ...broker, clientId: `${manufacturer}-${serialNumber}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 64), will: { topic: topic("connection"), payload: JSON.stringify({ ...header(vehicle, 0), connectionState: "CONNECTIONBROKEN" }), qos: 1, retain: true } });
    client.on("message", (name, payload) => {
      let message;
      try { message = JSON.parse(payload.toString("utf8")); } catch { return; }
      sim.received.push({ topic: name, message });
      if (name === topic("order")) takeOrder(message);
      else if (name === topic("instantActions")) instant(message);
    });
    await client.subscribe([{ topic: topic("order"), qos: 0 }, { topic: topic("instantActions"), qos: 0 }]);
    await client.publish(topic("connection"), JSON.stringify({ ...header(vehicle, (ids.connection += 1)), connectionState: "ONLINE" }), { qos: 1, retain: true });
    await client.publish(topic("factsheet"), JSON.stringify(factsheet()), { qos: 1, retain: true });
    await client.publish(topic("state"), JSON.stringify(state()));
  }

  return {
    vehicle, sim, factsheet, state,
    async start() {
      await connectToBroker();
      ticker = setInterval(tick, tickMs);
      reporter = setInterval(publishState, stateEveryMs);
    },
    /** Graceful: OFFLINE, then DISCONNECT (§6.14). */
    async stop() {
      clearInterval(ticker); clearInterval(reporter);
      if (client?.connected) {
        await client.publish(topic("connection"), JSON.stringify({ ...header(vehicle, (ids.connection += 1)), connectionState: "OFFLINE" }), { qos: 1, retain: true }).catch(() => {});
        await client.end();
      }
    },
    /** The link drops without a goodbye: the broker publishes the last will. */
    crash() { clearInterval(ticker); clearInterval(reporter); client?.destroy(); },
    set(change) { Object.assign(sim, change); publishState(); },
    publishState,
  };
}

module.exports = { DEFAULT_ACTIONS, createSimulatedAgv };
