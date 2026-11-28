"use strict";

// The graph's population from hubs and devices, and its live check of them,
// against the real schema with stand-in device and robot services.
const assert = require("node:assert/strict");
const test = require("node:test");
const { openDatabase } = require("./db");
const { createGraphService } = require("./graph/service");

test("hubs and devices become entities with CONNECTED_TO and LOCATED_IN, and their live state is checked", async () => {
  const db = await openDatabase("sqlite::memory:");
  const at = Date.now();
  await db.query("INSERT INTO hannah_users (id, email, password_hash, created_at, updated_at) VALUES ('u_dev', 'dev@example.com', 'x', $1, $1)", [at]);
  let connection = "online";
  const hub = { id: "hub_1", name: "Garage hub", status: "enrolled", online: true, connection: "online", software: "hub 1.0" };
  const device = () => ({ id: "dev_1", name: "Freezer temperature", location: "Garage", connection, connectionDetail: connection === "online" ? "" : "its hub isn't connected", hub: { id: "hub_1", name: "Garage hub", online: connection === "online" }, profile: { category: "sensor", manufacturer: "Acme", model: "T1", simulated: false, points: [{ id: "temperature" }] } });
  const devices = {
    listHubs: async () => [hub],
    listDevices: async () => [device()],
    getDevice: async (_db, userId, id) => { assert.equal(userId, "u_dev"); if (id !== "dev_1") throw Object.assign(new Error("gone"), { status: 404 }); return device(); },
    getHub: async () => hub,
  };
  const graph = createGraphService({ devices, robotics: null });
  const filled = await graph.populate(db, "u_dev");
  assert.equal(filled.nodes, 3, "hub, device and its room");
  const view = await graph.list(db, "u_dev");
  const sensor = view.nodes.find((node) => node.ref === "device:dev_1");
  assert.equal(sensor.type, "sensor");
  const room = view.nodes.find((node) => node.type === "room");
  assert.equal(room.name, "Garage");
  assert.ok(view.edges.some((edge) => edge.type === "CONNECTED_TO" && edge.from === sensor.id));
  assert.ok(view.edges.some((edge) => edge.type === "LOCATED_IN" && edge.from === sensor.id && edge.to === room.id));

  let ctx = await graph.context(db, "u_dev", sensor.id);
  assert.equal(ctx.start.label, "current");
  assert.match(ctx.start.live.detail, /reporting through Garage hub/);
  assert.deepEqual(ctx.places.map((place) => place.name), ["Garage"]);
  connection = "hub-offline";
  ctx = await graph.context(db, "u_dev", sensor.id);
  assert.equal(ctx.start.label, "not current");
  assert.match(ctx.start.live.detail, /last known, not live/);

  // The device is removed: its entity and relationships are closed, never deleted.
  devices.listDevices = async () => [];
  const after = await graph.populate(db, "u_dev");
  assert.equal(after.closedNodes, 2, "the device and the room only it was in");
  assert.ok(!(await graph.list(db, "u_dev")).nodes.some((node) => node.ref === "device:dev_1"));
  const history = await graph.history(db, "u_dev", sensor.id);
  assert.ok(history.node.validTo !== null);
  assert.ok(history.edges.every((edge) => edge.validTo !== null));
  await db.close();
});
