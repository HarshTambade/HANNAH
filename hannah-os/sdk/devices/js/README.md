# HANNAH Devices SDK for JavaScript

No dependencies; Node.js 18+ or a browser with `fetch`. The package has TypeScript declarations and lives at `hannah-os/sdk/devices/js`.

```js
import { HannahDevices } from "./index.js";

const hannah = new HannahDevices({
  baseUrl: "https://your-hannah",
  apiKey: process.env.HANNAH_KEY,
});

const profiles = await hannah.profiles();
const preflight = await hannah.validateProfile(myProfile);
if (!preflight.valid) throw new Error(preflight.problems.join("\n"));
// Saving or installing a profile requires a signed-in person, not an API key.
```

`validateProfile()` calls the server's authoritative profile validator. An empty problem list means the description is well formed; it does not establish that a real device works. Profile compatibility comes from evidence, not from a field supplied by a caller.

## Device changes

```js
const record = await hannah.setPoint("device-id", "power", true);
if (record.status === "waiting-approval") {
  // A person must decide in HANNAH before the hub receives this change.
} else if (record.status !== "done" || !record.verification?.confirmed) {
  throw new Error(record.error || record.outcome || "The device change was not confirmed.");
}
```

The client sends changes through `/api/devices/:id/set`, which creates an Action Engine record. It does not connect to a device or report success based only on the request being accepted. Hardware confirmation comes from the hub's readback. `addDevice()` and saving profiles are person-only operations; an API key cannot enroll or reconfigure hardware.

## Workflows

Helpers produce ordinary server workflow definitions. Validation, permission review, publishing, activation and runs remain server operations:

```js
import {
  HannahDevices, hardwareActionNode, manualTriggerNode,
  workflowConnection, workflowDefinition,
} from "./index.js";

const definition = workflowDefinition({
  timezone: "Asia/Kolkata",
  nodes: [
    manualTriggerNode(),
    hardwareActionNode({ id: "switch", device: "device-id", point: "power", value: true }),
  ],
  connections: [workflowConnection("manual", "switch")],
});

const hannah = new HannahDevices({ baseUrl: "https://your-hannah", apiKey: process.env.HANNAH_KEY });
const created = await hannah.createWorkflow("Switch the fan", definition);
const workflowId = created.workflow.id;
const checked = await hannah.validateWorkflow(workflowId, definition);
if (checked.validation.errors.length) throw new Error("Fix workflow validation errors first.");
// Review checked.permissions with the account owner before publish/activation.
```

`hardwareActionNode()` builds `action.run` nodes for `hardware.switch` or `hardware.set_value`. The workflow engine and device Action Engine apply their normal permissions, approvals, error handling and readback rules. A workflow waiting for approval is not a completed hardware change.

## Adapter manifests

`defineAdapterManifest()` checks a declarative contract: named points, connection fields, network permissions, ranges for writable numeric points, and plain-text constraints. It rejects unknown fields, including executable entry points. A manifest does not load a driver, add a protocol to the server's supported list, or install anything on a hub. Hubs currently run only built-in adapters. Third-party driver execution requires a reviewed sandbox and is not provided by this SDK.

```js
import { defineAdapterManifest } from "./index.js";

const manifest = defineAdapterManifest({
  format: "hannah-adapter",
  version: 1,
  id: "com.example.local-bridge",
  name: "Example local bridge contract",
  protocol: "example-bridge",
  connection: { fields: [{ id: "host", label: "Bridge address", type: "text", required: true }] },
  points: [{ id: "temperature", name: "Temperature", type: "number", direction: "read", unit: "°C" }],
  permissions: ["network-local"],
  constraints: ["Read-only contract; no device command is declared."],
  documentation: "A sample contract only. It is not executable and is not installed on a hub.",
});
```

## API

- Profiles: `profiles`, `validateProfile`, `saveProfile`
- Devices: `devices`, `device`, `addDevice`, `setPoint`
- Workflows: `workflowCatalog`, `workflows`, `createWorkflow`, `workflow`, `saveWorkflow`, `validateWorkflow`, `publishWorkflow`, `activateWorkflow`, `deactivateWorkflow`, `runWorkflow`, `executions`, `execution`
- Action Engine: `action`, `actionRecord`
- Builders: `defineProfile`, `defineAdapterManifest`, `manualTriggerNode`, `scheduledTriggerNode`, `hardwareActionNode`, `workflowNode`, `workflowConnection`, `workflowDefinition`

Pass `apiKey` for developer-key access, or use the client in a same-site signed-in browser session. The person-only profile save, device onboarding and workflow activation calls require the signed-in account session. `HannahDevicesError` exposes `status`, `reason` and the parsed server `body` when an API request fails.
