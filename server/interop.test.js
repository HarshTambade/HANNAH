"use strict";

// Robot interoperability: the normalized interface, the HANNAH robot link
// (adapter #1) and VDA 5050 2.0 over MQTT (adapter #2) in one fleet. The VDA
// 5050 side runs against HANNAH's simulated AGV on an in-process MQTT broker
// (aedes). Simulation and integration tests only: no vendor vehicle is used.
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;
const { testDatabase } = require("./test-fixtures/trust-db");
const { descriptor, state: robotState } = require("./test-fixtures/robot-client");
const capability = require("./interop/capability");
const schema = require("./interop/vda5050/schema");
const messages = require("./interop/vda5050/messages");
const { createSimulatedAgv, DEFAULT_ACTIONS } = require("./interop/vda5050/sim-agv");
const { createVda5050Adapter } = require("./interop/vda5050/adapter");
const { createHannahLinkAdapter } = require("./interop/adapters/hannah");
const { createInteropRegistry } = require("./interop/registry");
const { createRoboticsService } = require("./robotics/service");
const { createTrustService } = require("./trust/service");
const mqtt = require("./interop/vda5050/mqtt");

let broker;
let server;
let port;
let db;
let trust;
let vda;
let robotics;
let fleet;
const agvs = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, { timeoutMs = 6000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(40);
  }
}
const WORKSPACE = { minX: -20, maxX: 20, minY: -20, maxY: 20 };
async function vehicle(serialNumber, options = {}) {
  const agv = createSimulatedAgv({ broker: { host: "127.0.0.1", port }, serialNumber, ...options });
  agvs.push(agv);
  await agv.start();
  const registered = await vda.register(db, "u_asha", { name: options.name || serialNumber, simulated: true, manufacturer: "HANNAHSim", serialNumber, broker: { host: "127.0.0.1", port }, stations: { shelf: { x: 3, y: 0 }, packing: { x: 0, y: 2 } }, dock: { x: -1, y: 0 }, limits: { workspace: WORKSPACE, maxSpeed: 1.5, minBatteryPercent: 20 }, ...(options.register || {}) });
  await vda.connectAccount(db, "u_asha");
  await until(async () => (await vda.getRobot(db, "u_asha", registered.id)).state.online && (await vda.getRobot(db, "u_asha", registered.id)).hasFactsheet, { what: `${serialNumber} to report` });
  return { agv, id: registered.id };
}

before(async () => {
  const { Aedes } = await import("aedes");
  broker = await Aedes.createBroker();
  server = net.createServer(broker.handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  db = await testDatabase();
  trust = createTrustService();
  vda = createVda5050Adapter({ trust, sendTimeoutMs: 4000 });
  robotics = createRoboticsService({ ackWaitMs: 300 });
  fleet = createInteropRegistry({ adapters: [
    { adapter: createHannahLinkAdapter({ robotics }), robotPrefix: "rb_", missionPrefix: "ms_" },
    { adapter: vda, robotPrefix: "ia_", missionPrefix: "im_" },
  ] });
});

after(async () => {
  for (const agv of agvs) await agv.stop().catch(() => {});
  await vda.close();
  await new Promise((resolve) => broker.close(resolve));
  server.close();
});

test("the published 2.0.0 schemas: HANNAH's orders and instant actions validate, broken messages don't", () => {
  const vehicleId = { interfaceName: "uagv", majorVersion: "v2", manufacturer: "KIT", serialNumber: "0001" };
  assert.equal(messages.topicFor(vehicleId, "order"), "uagv/v2/KIT/0001/order", "§6.3 topic levels");
  assert.throws(() => messages.topicFor({ ...vehicleId, serialNumber: "a/b" }, "order"));
  const order = messages.buildOrder({ vehicle: vehicleId, headerId: 1, orderId: "o-1", state: { agvPosition: { x: 0, y: 0, theta: 0, mapId: "m" } }, mapId: "m", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], maxSpeed: 1, nodeActions: { 1: [{ type: "drop" }] } });
  assert.deepEqual(schema.validate("order", order), []);
  assert.deepEqual(order.nodes.map((node) => node.sequenceId), [0, 2, 4], "§6.6.2: nodes even");
  assert.deepEqual(order.edges.map((edge) => edge.sequenceId), [1, 3], "edges odd");
  const instant = messages.buildInstantActions({ vehicle: vehicleId, headerId: 1, actions: [{ id: "a1", type: "startPause" }] });
  assert.deepEqual(schema.validate("instantActions", instant), []);
  assert.equal(instant.actions[0].actionType, "startPause");
  assert.equal(instant.actions[0].actionName, "startPause", "the 2.0.0 schema's field, see schemas/NOTICE.md");
  assert.ok(schema.validate("order", { ...order, orderUpdateId: -1 }).length);
  assert.ok(schema.validate("state", { headerId: 1 }).some((problem) => problem.includes("batteryState")));
  const sim = createSimulatedAgv({ broker: { host: "127.0.0.1", port: 1 } });
  assert.deepEqual(schema.validate("state", sim.state()), []);
  assert.deepEqual(schema.validate("factsheet", sim.factsheet()), []);
  // The published factsheet defines its fields at the top level; they are enforced anyway.
  const { typeSpecification: _dropped, ...noType } = sim.factsheet();
  assert.ok(schema.validate("factsheet", noType).some((problem) => problem.includes("typeSpecification")));
  assert.ok(schema.validate("factsheet", { ...sim.factsheet(), typeSpecification: { ...sim.factsheet().typeSpecification, agvKinematic: "HOVER" } }).length);
});

test("vendor errors are normalized and the original is kept", () => {
  const cases = [
    [{ errorType: "orderError", errorLevel: "WARNING", errorReferences: [{ referenceKey: "actionId", referenceValue: "x" }] }, "order-rejected", "warning"],
    [{ errorType: "LIDAR_FAILURE", errorLevel: "FATAL", errorDescription: "front scanner dirty" }, "sensor-fault", "fatal"],
    [{ errorType: "E042", errorLevel: "WARNING", errorDescription: "obstacle in path" }, "navigation-blocked", "warning"],
    [{ errorType: "batteryLow", errorLevel: "WARNING" }, "battery", "warning"],
    [{ errorType: "VENDOR_X", errorLevel: "FATAL" }, "unknown", "fatal"],
  ];
  for (const [error, code, severity] of cases) {
    const normalized = messages.normalizeVdaError(error);
    assert.equal(normalized.code, code, error.errorType);
    assert.equal(normalized.severity, severity);
    assert.equal(normalized.vendor.errorType, error.errorType, "the vendor's own code survives");
  }
  const diagnostics = messages.diagnosticsOf({ errors: [], safetyState: { eStop: "MANUAL", fieldViolation: true }, actionStates: [{ actionId: "a", actionType: "pick", actionStatus: "FAILED" }] });
  assert.deepEqual(diagnostics.errors.map((item) => item.code), ["emergency-stop", "safety-field", "action-failed"]);
  assert.equal(diagnostics.errors[0].needsPerson, true);
});

test("negotiation explains what is missing; vendor actions are exposed as extensions", () => {
  const sim = createSimulatedAgv({ broker: { host: "127.0.0.1", port: 1 }, actions: DEFAULT_ACTIONS.filter((item) => !["pick", "drop"].includes(item.actionType)) });
  const features = messages.featuresOf(sim.factsheet(), { stations: {}, dock: null });
  assert.ok(features.includes("navigation.goto-point"));
  const deliver = capability.negotiate(features, "deliver");
  assert.equal(deliver.supported, false);
  assert.match(deliver.explanation, /pick up a load/);
  const reasons = messages.vdaReasons(sim.factsheet(), {}, "deliver");
  assert.match(reasons[0].message, /no “pick” action with scope NODE \(VDA 5050 2\.0 §6\.8\.1/);
  assert.equal(capability.negotiate(features, "fly").supported, false);
  const extensions = messages.extensionsOf(sim.factsheet(), sim.state());
  assert.deepEqual(extensions.vendorActions.map((item) => item.actionType), ["hornBeep"], "not stripped");
  assert.equal(extensions.information[0].infoType, "simulation");
});

test("VDA 5050: a simulated AGV over MQTT is read into the normalized interface and drives a mission to a verified end", async () => {
  const { agv, id } = await vehicle("AGV-001");
  const robot = await fleet.resolve(db, "u_asha", id).then((found) => found.robot);
  assert.equal(robot.adapter, "vda5050");
  assert.equal(robot.kind, "simulation");
  assert.equal(robot.identity.protocol, "VDA 5050");
  assert.equal(robot.identity.protocolVersion, "2.0.0");
  assert.equal(robot.mode.vendor, "AUTOMATIC");
  assert.equal(robot.mode.normalized, "autonomous");
  assert.equal(robot.battery.percent, 80);
  assert.equal(robot.pose.mapId, "sim-floor");
  for (const feature of ["navigation.goto-point", "navigation.goto-named-place", "navigation.dock", "load.pick", "load.drop", "sensing.capture-at-point", "control.pause", "control.cancel", "status.on-request"]) assert.ok(robot.functions.includes(feature), feature);

  const verdict = await fleet.assess(db, "u_asha", id, "navigate", { place: "shelf", maxSpeed: 5 });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  assert.equal(verdict.plan.maxSpeed, 1.5, "capped by the owner's limit");
  const mission = await fleet.submit(db, "u_asha", id, "navigate", { place: "shelf" });
  assert.equal(mission.status, "sent");
  const order = (await until(() => agv.sim.received.find((item) => item.topic.endsWith("/order")), { what: "the order to arrive" })).message;
  assert.deepEqual(schema.validate("order", order), [], "what went over the wire validates");
  assert.equal(order.nodes[0].nodePosition.x, 0, "§6.6.3.1: the first node is where the vehicle stands");
  const done = await until(async () => { const item = await fleet.getMission(db, "u_asha", mission.id); return item.final ? item : null; }, { what: "the navigate mission to end" });
  assert.equal(done.status, "succeeded", done.evidence);
  assert.match(done.evidence, /last node .* reached/);

  // Deliver: pick at one station, drop at another, both verified by the vehicle's action states.
  const delivery = await fleet.submit(db, "u_asha", id, "deliver", { from: { place: "packing" }, to: { place: "shelf" }, loadId: "box-7" });
  const delivered = await until(async () => { const item = await fleet.getMission(db, "u_asha", delivery.id); return item.final ? item : null; }, { what: "the delivery" });
  assert.equal(delivered.status, "succeeded", delivered.evidence);
  const deliverOrder = agv.sim.received.filter((item) => item.topic.endsWith("/order")).at(-1).message;
  assert.deepEqual(deliverOrder.nodes.slice(1).map((node) => node.actions[0].actionType), ["pick", "drop"]);

  // Status on request (§6.8.1 stateRequest).
  const before = agv.sim.received.length;
  await fleet.reportStatus(db, "u_asha", id);
  await until(() => agv.sim.received.slice(before).some((item) => item.topic.endsWith("/instantActions") && item.message.actions[0].actionType === "stateRequest"), { what: "stateRequest to arrive" });
});

test("VDA 5050: unsafe or unsupported missions are refused before anything is sent, with the reason", async () => {
  const { agv, id } = await vehicle("AGV-002", { actions: DEFAULT_ACTIONS.filter((item) => item.actionType !== "detectObject") });
  const sentBefore = agv.sim.received.filter((item) => item.topic.endsWith("/order")).length;
  const inspect = await fleet.assess(db, "u_asha", id, "inspect", { waypoints: [{ x: 1, y: 1 }] });
  assert.equal(inspect.ok, false);
  assert.ok(inspect.violations.some((item) => /detectObject/.test(item.message)));
  const outside = await fleet.assess(db, "u_asha", id, "navigate", { x: 50, y: 0 });
  assert.ok(outside.violations.some((item) => item.code === "outside-workspace"));
  agv.set({ operatingMode: "MANUAL" });
  await until(async () => (await vda.getRobot(db, "u_asha", id)).mode.vendor === "MANUAL", { what: "manual mode" });
  const manual = await fleet.assess(db, "u_asha", id, "navigate", { x: 1, y: 0 });
  assert.ok(manual.violations.some((item) => item.code === "mode" && /§6\.10\.6/.test(item.message)));
  await assert.rejects(fleet.submit(db, "u_asha", id, "navigate", { x: 1, y: 0 }), { reason: "refused" });
  agv.set({ operatingMode: "AUTOMATIC", eStop: "MANUAL", errors: [{ errorType: "MOTOR_OVERTEMP", errorLevel: "FATAL", errorDescription: "drive motor hot" }] });
  await until(async () => (await vda.getRobot(db, "u_asha", id)).diagnostics.estop.engaged, { what: "the emergency stop" });
  const robot = await vda.getRobot(db, "u_asha", id);
  assert.deepEqual(robot.diagnostics.errors.map((item) => item.code), ["emergency-stop", "hardware-fault"]);
  assert.equal(robot.diagnostics.errors[1].vendor.errorType, "MOTOR_OVERTEMP");
  const stopped = await fleet.assess(db, "u_asha", id, "navigate", { x: 1, y: 0 });
  assert.ok(stopped.violations.some((item) => item.code === "estop"));
  assert.ok(stopped.violations.some((item) => item.code === "fatal-error"));
  assert.equal(agv.sim.received.filter((item) => item.topic.endsWith("/order")).length, sentBefore, "nothing was sent");
  // A physical vehicle with no workspace configured is never sent anywhere.
  const physical = await vda.register(db, "u_asha", { name: "Real one", simulated: false, manufacturer: "Acme", serialNumber: "R-1", broker: { host: "127.0.0.1", port } });
  const unbounded = await fleet.assess(db, "u_asha", physical.id, "navigate", { x: 1, y: 0 });
  assert.ok(unbounded.violations.some((item) => item.code === "no-workspace"));
});

test("VDA 5050: the vehicle's own refusal, a cancellation, a request for assistance and a broken link are reported as they happened", async () => {
  const { agv, id } = await vehicle("AGV-003", { refuseActions: ["pick"], speed: 0.5 });
  const refused = await fleet.submit(db, "u_asha", id, "deliver", { from: { place: "packing" }, to: { place: "shelf" } });
  const outcome = await until(async () => { const item = await fleet.getMission(db, "u_asha", refused.id); return item.final ? item : null; }, { what: "the refusal" });
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.evidence, /orderError.*§6\.6\.4/);
  const rejection = (await vda.getRobot(db, "u_asha", id)).diagnostics.errors.find((item) => item.vendor?.errorType === "orderError");
  assert.equal(rejection.code, "order-rejected");

  const long = await fleet.submit(db, "u_asha", id, "navigate", { x: 15, y: 0 });
  await until(async () => (await fleet.getMission(db, "u_asha", long.id)).status === "accepted", { what: "the order to start" });
  const assistance = await fleet.requestAssistance(db, "u_asha", id, { reason: "pallet looks unstable" });
  assert.equal(assistance.sent, "startPause");
  await until(async () => (await vda.getRobot(db, "u_asha", id)).navigation.paused, { what: "the pause" });
  assert.equal((await fleet.getMission(db, "u_asha", long.id)).status, "paused");
  const cancelled = await fleet.cancel(db, "u_asha", long.id);
  assert.equal(cancelled.status, "cancelled");
  await until(() => agv.sim.received.some((item) => item.topic.endsWith("/instantActions") && item.message.actions[0].actionType === "cancelOrder"), { what: "cancelOrder to arrive" });

  agv.crash();
  await until(async () => (await vda.getRobot(db, "u_asha", id)).state.connection === "link-broken", { what: "the last will" });
});

test("VDA 5050: an unregistered vehicle on the broker is quarantined; a message that fails the schema isn't used", async () => {
  const stranger = createSimulatedAgv({ broker: { host: "127.0.0.1", port }, manufacturer: "Rogue", serialNumber: "X-9" });
  agvs.push(stranger);
  await stranger.start();
  await until(async () => (await trust.listIdentities(db, "u_asha")).find((item) => item.deviceId === "vda5050:Rogue:X-9"), { what: "the quarantine record" });
  const quarantined = (await trust.listIdentities(db, "u_asha")).find((item) => item.deviceId === "vda5050:Rogue:X-9");
  assert.equal(quarantined.status, "quarantined");
  assert.equal((await fleet.listRobots(db, "u_asha")).some((robot) => robot.identity.serialNumber === "X-9"), false, "it is not in the fleet");
  // A broken state message from a registered vehicle.
  const { id } = await vehicle("AGV-004");
  const writer = await mqtt.connect({ host: "127.0.0.1", port, clientId: "test-writer" });
  await writer.publish("uagv/v2/HANNAHSim/AGV-004/state", JSON.stringify({ headerId: 1, orderId: "fake" }));
  await until(async () => (await trust.listAudit(db, "u_asha")).some((item) => item.kind === "vda5050-message" && item.decision === "refused"), { what: "the audit entry" });
  assert.notEqual((await vda.getRobot(db, "u_asha", id)).navigation.orderId, "fake");
  await writer.end();
});

test("two adapters, one fleet: a HANNAH-link robot and a VDA 5050 vehicle side by side, each negotiated by what it offers", async () => {
  const created = await robotics.createRobot(db, "u_asha", { name: "Rover", simulated: true });
  const enrolled = await robotics.enroll(db, { code: created.enrollment.code, descriptor: descriptor() });
  const row = (await db.query("SELECT * FROM hannah_robots WHERE id = $1", [enrolled.robotId])).rows[0];
  await robotics.sync(db, { row, secret: enrolled.secret }, { state: robotState() });
  const robots = await fleet.listRobots(db, "u_asha");
  assert.ok(robots.some((robot) => robot.adapter === "hannah-link" && robot.name === "Rover"));
  assert.ok(robots.some((robot) => robot.adapter === "vda5050"));
  for (const robot of robots) for (const part of ["identity", "state", "battery", "pose", "navigation", "mission", "diagnostics", "mode", "functions", "maintenance", "extensions"]) assert.ok(part in robot, `${robot.name}: ${part}`);
  const matrix = await fleet.capabilityMatrix(db, "u_asha");
  const rover = matrix.find((item) => item.name === "Rover");
  const agv = matrix.find((item) => item.name === "AGV-001");
  assert.equal(rover.missions.navigate.supported, true);
  assert.equal(rover.missions.deliver.supported, false);
  assert.equal(agv.missions.deliver.supported, true);
  const deliver = await fleet.assess(db, "u_asha", "Rover", "deliver", { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
  assert.equal(deliver.ok, false);
  assert.match(deliver.violations[0].message, /no load-handling capability/);
  // A HANNAH-link mission goes through the robotics Safety Gateway unchanged.
  const outside = await fleet.assess(db, "u_asha", "Rover", "navigate", { x: 40, y: 0 });
  assert.equal(outside.ok, false);
  const inside = await fleet.assess(db, "u_asha", "Rover", "navigate", { place: "workbench" });
  assert.equal(inside.ok, true, JSON.stringify(inside.violations));
  assert.equal(inside.plan.capability, "navigate_to");
  // Another account sees neither.
  assert.equal((await fleet.listRobots(db, "u_bo")).length, 0);
  await assert.rejects(fleet.resolve(db, "u_bo", agv.id), { reason: "not-found" });
});
