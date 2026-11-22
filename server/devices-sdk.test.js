"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateWorkflow } = require("./workflows/engine");

test("the JavaScript device SDK creates a server-valid hardware workflow and safe declarative adapter manifest", async () => {
  const sdk = await import("../hannah-os/sdk/devices/js/index.js");
  const definition = sdk.workflowDefinition({
    timezone: "Asia/Kolkata",
    nodes: [
      sdk.manualTriggerNode(),
      sdk.hardwareActionNode({ id: "switch", device: "device-1", point: "power", value: true }),
    ],
    connections: [sdk.workflowConnection("manual", "switch")],
  });
  const validation = validateWorkflow(definition);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(validation.warnings, []);
  assert.equal(definition.nodes[1].params.action, "hardware.switch");
  assert.deepEqual(definition.nodes[1].params.params, { device: "device-1", point: "power", on: true });

  const manifest = sdk.defineAdapterManifest({
    format: "hannah-adapter",
    version: 1,
    id: "com.example.bridge",
    name: "Example bridge contract",
    protocol: "example-bridge",
    connection: { fields: [{ id: "host", label: "Bridge address", type: "text", required: true }] },
    points: [{ id: "power", name: "Power", type: "boolean", direction: "read-write" }],
    permissions: ["network-local"],
    constraints: ["The hub adapter implementation is not included in this manifest."],
    documentation: "Declarative metadata only.",
  });
  assert.equal(manifest.format, "hannah-adapter");
  assert.throws(() => sdk.defineAdapterManifest({ ...manifest, entrypoint: "./driver.js" }), /cannot contain executable driver code/);
  assert.throws(() => sdk.defineAdapterManifest({ ...manifest, points: [{ id: "level", name: "Level", type: "number", direction: "write" }] }), /needs an explicit range/);
});

test("profile SDK calls server preflight and routes device writes through the Action Engine API", async () => {
  const { HannahDevices } = await import("../hannah-os/sdk/devices/js/index.js");
  const requests = [];
  const client = new HannahDevices({
    baseUrl: "https://hannah.example/",
    apiKey: "sdk-test-key",
    fetch: async (url, options) => {
      requests.push({ url, options });
      const body = url.endsWith("/devices/profiles/validate")
        ? { valid: true, problems: [] }
        : { record: { id: "act-1", status: "waiting-approval", verification: null } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  assert.deepEqual(await client.validateProfile({ id: "example" }), { valid: true, problems: [] });
  const record = await client.setPoint("device id/1", "power", true);
  assert.equal(record.status, "waiting-approval");
  assert.equal(requests[0].url, "https://hannah.example/api/devices/profiles/validate");
  assert.equal(requests[1].url, "https://hannah.example/api/devices/device%20id%2F1/set");
  assert.equal(JSON.parse(requests[1].options.body).value, true);
  assert.equal(requests[1].options.headers.Authorization, "Bearer sdk-test-key");
});
