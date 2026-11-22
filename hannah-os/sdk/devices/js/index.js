/**
 * HANNAH's device API client and declarative SDK helpers. No dependencies.
 *
 * Profile validation is performed by the server's authoritative validator.
 * Device writes go through the Action Engine and return its action record; a
 * caller must inspect its status and verification before claiming success.
 * Workflow helpers only build definitions: the server validates, stores,
 * publishes and executes them. Adapter manifests describe a contract only;
 * this SDK cannot install or execute driver code on a hub.
 */
export class HannahDevicesError extends Error {
  constructor(message, { status, reason, body } = {}) {
    super(message);
    this.name = "HannahDevicesError";
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
}

const id = (value) => encodeURIComponent(String(value));
const query = (values) => {
  const params = new URLSearchParams(Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)]));
  return params.size ? "?" + params.toString() : "";
};

export class HannahDevices {
  constructor({ baseUrl, apiKey, fetch: fetchImpl, timeoutMs = 30_000, agent = "Device SDK" } = {}) {
    if (!baseUrl) throw new HannahDevicesError("baseUrl is required, for example https://your-hannah");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey || "";
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.agent = agent;
    if (typeof this.fetch !== "function") throw new HannahDevicesError("No fetch available; pass one in the options.");
  }

  async request(method, path, body, options = {}) {
    const response = await this.fetch(this.baseUrl + "/api" + path, {
      method,
      credentials: "include",
      headers: {
        ...(this.apiKey ? { Authorization: "Bearer " + this.apiKey } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: options.signal || AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      throw new HannahDevicesError(data?.error || "HANNAH answered " + response.status, {
        status: response.status,
        reason: data?.reason,
        body: data,
      });
    }
    return data;
  }

  // Profiles: validation is a read-only preflight; saving is person-only.
  async profiles({ hub } = {}) { return (await this.request("GET", "/devices/profiles" + query({ hub }))).profiles; }
  validateProfile(profile) { return this.request("POST", "/devices/profiles/validate", { profile }); }
  async saveProfile(profile) { return (await this.request("POST", "/devices/profiles", { profile })).profile; }

  // Devices: changes are Action Engine records and can wait for approval.
  async devices() { return (await this.request("GET", "/devices")).devices; }
  async device(deviceId) { return (await this.request("GET", "/devices/" + id(deviceId))).device; }
  async addDevice(input) { return (await this.request("POST", "/devices", input)).device; }
  async setPoint(deviceId, point, value) {
    const result = await this.request("POST", "/devices/" + id(deviceId) + "/set", { point, value });
    return result.record;
  }

  // Workflows remain server-owned: validation and execution use the workflow API.
  async workflows() { return (await this.request("GET", "/workflows")).workflows; }
  async workflowCatalog() { return this.request("GET", "/workflows/catalog"); }
  async createWorkflow(name, definition) {
    return this.request("POST", "/workflows", { name, ...(definition ? { definition } : {}) });
  }
  workflow(workflowId) { return this.request("GET", "/workflows/" + id(workflowId)); }
  saveWorkflow(workflowId, { baseVersion, name, description, definition }) {
    return this.request("PUT", "/workflows/" + id(workflowId), { baseVersion, name, description, definition });
  }
  validateWorkflow(workflowId, definition) {
    return this.request("POST", "/workflows/" + id(workflowId) + "/validate", { definition });
  }
  publishWorkflow(workflowId) { return this.request("POST", "/workflows/" + id(workflowId) + "/publish", {}); }
  activateWorkflow(workflowId, approvedPermissions) {
    return this.request("POST", "/workflows/" + id(workflowId) + "/activate", { approvedPermissions });
  }
  deactivateWorkflow(workflowId) { return this.request("POST", "/workflows/" + id(workflowId) + "/deactivate", {}); }
  runWorkflow(workflowId, options = {}) {
    return this.request("POST", "/workflows/" + id(workflowId) + "/run", options);
  }
  async executions({ workflowId, status, limit } = {}) {
    return (await this.request("GET", "/workflows/executions" + query({ workflowId, status, limit }))).executions;
  }
  async execution(executionId) {
    return (await this.request("GET", "/workflows/executions/" + id(executionId))).execution;
  }

  // Action Engine. A returned record is not proof the physical device changed.
  async action(action, params = {}, { request = "Asked through the device SDK" } = {}) {
    return (await this.request("POST", "/actions", { action, params, request, agent: this.agent })).record;
  }
  async actionRecord(actionId) {
    return (await this.request("GET", "/actions/" + id(actionId))).record;
  }
}

const ADAPTER_KEYS = new Set(["format", "version", "id", "name", "protocol", "connection", "points", "permissions", "constraints", "documentation"]);
const TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;
const REVERSE_DOMAIN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

/** Return a checked declarative manifest; executable or unknown keys are rejected. */
export function defineAdapterManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new HannahDevicesError("An adapter manifest must be an object.");
  const extra = Object.keys(manifest).filter((key) => !ADAPTER_KEYS.has(key));
  if (extra.length) throw new HannahDevicesError("Unknown adapter manifest field: " + extra.join(", ") + ". Manifests cannot contain executable driver code.");
  if (manifest.format !== "hannah-adapter" || manifest.version !== 1) throw new HannahDevicesError("Adapter manifests must use format hannah-adapter, version 1.");
  if (!REVERSE_DOMAIN.test(String(manifest.id || ""))) throw new HannahDevicesError("Adapter id must be a reverse-domain name, such as com.example.mqtt-bridge.");
  if (!shortText(manifest.name, 80) || !TOKEN.test(String(manifest.protocol || ""))) throw new HannahDevicesError("Adapter name and protocol are required.");
  if (!manifest.connection || typeof manifest.connection !== "object" || Object.keys(manifest.connection).some((key) => key !== "fields") || !Array.isArray(manifest.connection.fields) || manifest.connection.fields.length > 24) {
    throw new HannahDevicesError("Adapter connection must declare at most 24 fields and no executable entry point.");
  }
  const fieldIds = new Set();
  for (const field of manifest.connection.fields) {
    if (!field || typeof field !== "object" || Object.keys(field).some((key) => !["id", "label", "type", "required", "help", "choices"].includes(key)) || !TOKEN.test(String(field.id || "")) || fieldIds.has(field.id) || !shortText(field.label, 60) || !["text", "number", "secret", "toggle", "choice"].includes(field.type) || (field.type === "choice" && (!Array.isArray(field.choices) || !field.choices.length || field.choices.length > 30 || field.choices.some((choice) => typeof choice !== "string")))) {
      throw new HannahDevicesError("Adapter connection fields need unique ids, labels and supported input types.");
    }
    fieldIds.add(field.id);
  }
  if (!Array.isArray(manifest.points) || manifest.points.length < 1 || manifest.points.length > 64) throw new HannahDevicesError("An adapter must declare 1 to 64 named points.");
  const pointIds = new Set();
  for (const point of manifest.points) {
    if (!point || typeof point !== "object" || Object.keys(point).some((key) => !["id", "name", "type", "direction", "unit", "range"].includes(key)) || !TOKEN.test(String(point.id || "")) || pointIds.has(point.id) || !shortText(point.name, 60) || !["boolean", "number", "enum", "text"].includes(point.type) || !["read", "write", "read-write"].includes(point.direction)) {
      throw new HannahDevicesError("Adapter points need unique ids, names, value types and read/write directions.");
    }
    if (point.direction !== "read" && point.type === "text") throw new HannahDevicesError("Free text cannot be declared writable by an adapter manifest.");
    if (point.range !== undefined && (!Array.isArray(point.range) || point.range.length !== 2 || !point.range.every(Number.isFinite) || point.range[0] >= point.range[1])) throw new HannahDevicesError("Adapter point ranges must be an increasing pair of finite numbers.");
    if (point.direction !== "read" && point.type === "number" && !point.range) throw new HannahDevicesError("A writable numeric adapter point needs an explicit range.");
    pointIds.add(point.id);
  }
  const allowedPermissions = ["network-local", "network-internet"];
  if (!Array.isArray(manifest.permissions) || manifest.permissions.some((permission) => !allowedPermissions.includes(permission))) throw new HannahDevicesError("Adapter permissions must be listed explicitly as network-local or network-internet.");
  if (!Array.isArray(manifest.constraints) || manifest.constraints.some((item) => !shortText(item, 300)) || !shortText(manifest.documentation, 2000)) throw new HannahDevicesError("Adapter constraints and documentation must be plain text lists.");
  return structuredClone(manifest);
}

function shortText(value, max) { return typeof value === "string" && value.trim().length > 0 && value.length <= max; }

/** Typed construction helper. Full format and safety checks happen at validateProfile(). */
export function defineProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new HannahDevicesError("A device profile must be an object.");
  return structuredClone(profile);
}

export function workflowNode(idValue, name, type, params = {}, position = { x: 0, y: 0 }, settings) {
  return { id: idValue, name, type, params, position, ...(settings ? { settings } : {}) };
}

export function manualTriggerNode(idValue = "manual", name = "When I run it") {
  return workflowNode(idValue, name, "trigger.manual");
}

export function scheduledTriggerNode(idValue = "schedule", options = {}) {
  const mode = options.mode || "daily";
  const params = { mode };
  if (mode === "interval") params.minutes = options.minutes ?? 60;
  if (mode === "weekly") { params.time = options.time || "08:00"; params.days = options.days || [1, 2, 3, 4, 5]; }
  if (mode === "daily") params.time = options.time || "08:00";
  if (mode === "cron") params.cron = options.cron || "0 8 * * 1-5";
  if (options.missed) params.missed = options.missed;
  return workflowNode(idValue, options.name || "On a schedule", "trigger.schedule", params);
}

export function hardwareActionNode({ id: nodeId, name = "Change device", device, point, value, waitIsOk = true }) {
  if (!nodeId || !device || !point) throw new HannahDevicesError("A hardware action node needs its own id, device id and point id.");
  const isSwitch = typeof value === "boolean";
  const params = { action: isSwitch ? "hardware.switch" : "hardware.set_value", params: { device, point, [isSwitch ? "on" : "value"]: value }, waitIsOk };
  return workflowNode(nodeId, name, "action.run", params);
}

export function workflowConnection(source, target, { sourceOutput = "main", targetInput = "main", id: connectionId } = {}) {
  return { ...(connectionId ? { id: connectionId } : {}), source, target, sourceOutput, targetInput };
}

export function workflowDefinition({ nodes, connections, timezone = "UTC", timeoutMs } = {}) {
  return {
    format: "hannah-workflow",
    version: 2,
    nodes: nodes || [],
    connections: connections || [],
    settings: { timezone, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  };
}

export default HannahDevices;
