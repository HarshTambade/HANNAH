"use strict";

/**
 * Device profiles: how HANNAH knows what a device is.
 *
 * A profile is data, not code. It says who made the device, how to reach it
 * (which protocol, which settings a person has to enter), and its POINTS: the
 * named things that can be read ("temperature") or changed ("power"), each
 * with a type, a unit, a range and a binding that only the hub ever uses (an
 * MQTT topic, a Modbus register, an HTTP path).
 *
 * Everything above the hub works with point names. The model never sees a
 * binding, and there is no way to address a device except through a point its
 * profile lists.
 *
 * What a profile can't do:
 *   - name a protocol the hub has no adapter for and still be usable (it is
 *     listed as "developer required", with what is missing);
 *   - make a number writable without a range;
 *   - expose firmware, factory reset, passwords or pairing as a point;
 *   - call itself tested on hardware without evidence.
 *
 * compatibility() turns a profile into one of the levels people see:
 * plug-and-play, guided, experimental, simulation, developer required,
 * unsupported. The level is computed from evidence in the profile, never
 * declared by it.
 */
const crypto = require("node:crypto");
const { canonical, keyIdOf } = require("../robotics/packages");

const FORMAT = 1;
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const POINT_ID = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_ID = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const JSON_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,7}$/;
const FORBIDDEN_POINT = /firmware|flash|factory|reset|reboot|password|passwd|pairing|ota\b|bootloader/i;

const CATEGORIES = {
  sensor: "Sensor", light: "Light", switch: "Switch or plug", fan: "Fan", thermostat: "Thermostat", appliance: "Appliance", "energy-meter": "Energy meter",
  environment: "Environment monitor", camera: "Camera", lock: "Lock or door", "industrial-sensor": "Industrial sensor", plc: "PLC or controller",
  actuator: "Actuator or motor", gateway: "Gateway", board: "Development board", other: "Other",
};
const DOMAINS = ["iot", "industrial", "embedded"];
/** Categories where a wrong write can hurt someone or let someone in. Every write asks, and no rule may write. */
const HIGH_RISK_CATEGORIES = new Set(["lock", "plc", "actuator"]);
const RISKS = ["low", "elevated", "high"];

/** The protocols HANNAH's hub can speak today, and the settings each needs. */
const ADAPTERS = {
  mqtt: { label: "MQTT", needs: ["host"], settings: ["host", "port", "username", "password", "tls"] },
  "modbus-tcp": { label: "Modbus TCP", needs: ["host"], settings: ["host", "port", "unit", "pollS"] },
  http: { label: "HTTP on the local network", needs: ["url"], settings: ["url", "username", "password", "pollS"] },
};
/** Protocols people will ask for that the hub cannot speak yet, with what each needs. A profile may name one; it can't be used. */
const NOT_BUILT = {
  matter: "Matter commissioning needs a Matter controller stack and a Thread or Wi-Fi radio on the hub. Not built.",
  zigbee: "Zigbee needs a coordinator radio on the hub and its driver. Not built. A Zigbee device behind a bridge that publishes to MQTT can be added as an MQTT device.",
  zwave: "Z-Wave needs a controller radio on the hub and its driver. Not built.",
  ble: "Bluetooth Low Energy needs a radio and a Bluetooth library on the hub. Not built.",
  opcua: "OPC UA needs a client library with certificate handling on the hub, and a server to test against. Not built.",
  "modbus-rtu": "Modbus over a serial line needs a serial library on the hub. Not built. A Modbus TCP gateway in front of the device works today.",
  coap: "CoAP is not built.",
  can: "CAN belongs below a robot's or machine's own controller. HANNAH does not write to a CAN bus.",
  serial: "A raw serial protocol needs a driver written for that device. Not built.",
  usb: "A USB device needs a driver written for that device. Not built.",
  gpio: "GPIO, I2C and SPI need a driver on the hub's own board. Not built.",
  ros2: "Robots are added under Robots, with HANNAH's robot runtime.",
};
const FIELD_TYPES = ["text", "number", "secret", "toggle", "choice"];
const PERMISSIONS = { "network-local": "Talk to devices on the hub's own network", "network-internet": "Reach the internet from the hub" };
const TEST_LEVELS = ["unit", "simulation", "hardware-in-the-loop", "physical"];
const LEVELS = {
  "plug-and-play": "Plug and play", guided: "Guided setup", experimental: "Experimental", simulation: "Simulation",
  "developer-required": "Developer required", unsupported: "Unsupported",
};

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const placeholders = (template) => [...String(template || "").matchAll(PLACEHOLDER)].map((match) => match[1]);

function templateProblems(template, fields, what, { topic = false } = {}) {
  const problems = [];
  if (!text(template, 200)) return [`${what} is missing.`];
  for (const name of placeholders(template)) {
    const field = fields.get(name);
    if (!field) problems.push(`${what} uses {${name}}, which isn't one of the connection settings.`);
    else if (field.type === "secret" || field.type === "toggle") problems.push(`${what} can't use the ${field.type} setting {${name}}.`);
  }
  const literal = String(template).replace(PLACEHOLDER, "x");
  if (topic && /[+#\s\u0000-\u001f]/.test(literal)) problems.push(`${what} must be one exact topic: no wildcards or spaces.`);
  return problems;
}

function bindingProblems(adapter, point, fields) {
  const problems = [];
  const name = `Point “${point.id}”`;
  const binding = point.binding || {};
  const writes = point.access === "read-write";
  if (adapter === "mqtt") {
    if (!binding.state && !binding.command) problems.push(`${name} has no topic.`);
    if (point.kind === "sensor" && !binding.state) problems.push(`${name} is a sensor and has no topic to read.`);
    if (writes && !binding.command) problems.push(`${name} is writable and has no command topic.`);
    if (binding.state) {
      problems.push(...templateProblems(binding.state.topic, fields, `${name}: the state topic`, { topic: true }));
      if (binding.state.json !== undefined && !JSON_PATH.test(String(binding.state.json))) problems.push(`${name}: the JSON field must be a dotted path such as sensor.temperature.`);
      if (binding.state.scale !== undefined && (!isNumber(binding.state.scale) || binding.state.scale === 0)) problems.push(`${name}: scale must be a number other than 0.`);
    }
    if (binding.command) problems.push(...templateProblems(binding.command.topic, fields, `${name}: the command topic`, { topic: true }));
  } else if (adapter === "modbus-tcp") {
    const register = binding.register;
    if (!register) return [`${name} has no register.`];
    const bits = ["coil", "discrete"].includes(register.table);
    if (!["coil", "discrete", "holding", "input"].includes(register.table)) problems.push(`${name}: table must be coil, discrete, holding or input.`);
    if (!Number.isInteger(register.address) || register.address < 0 || register.address > 65535) problems.push(`${name}: address must be 0 to 65535.`);
    const type = register.type || (bits ? "bool" : "uint16");
    if (bits ? type !== "bool" : !["uint16", "int16", "uint32", "int32", "float32"].includes(type)) problems.push(`${name}: type doesn't fit the ${register.table} table.`);
    if (bits !== (point.type === "boolean")) problems.push(`${name}: a ${register.table} ${bits ? "is on or off, so the point must be boolean" : "holds a number, so the point must be a number"}.`);
    if (register.wordOrder !== undefined && !["big", "little"].includes(register.wordOrder)) problems.push(`${name}: wordOrder must be big or little.`);
    if (register.scale !== undefined && (!isNumber(register.scale) || register.scale === 0)) problems.push(`${name}: scale must be a number other than 0.`);
    if (register.offset !== undefined && !isNumber(register.offset)) problems.push(`${name}: offset must be a number.`);
    if (writes && !["coil", "holding"].includes(register.table)) problems.push(`${name} is writable, and ${register.table} registers can only be read.`);
  } else if (adapter === "http") {
    const path = (value, what) => { if (!text(value, 200) || !String(value).startsWith("/") || /:\/\/|\.\.|[\s\u0000-\u001f]/.test(String(value))) problems.push(`${name}: ${what} must be a path on the device, starting with /.`); else problems.push(...templateProblems(value, fields, `${name}: ${what}`)); };
    if (!binding.state && !binding.command) problems.push(`${name} has no path.`);
    if (point.kind === "sensor" && !binding.state) problems.push(`${name} is a sensor and has no path to read.`);
    if (writes && !binding.command) problems.push(`${name} is writable and has no command.`);
    if (binding.state) { path(binding.state.path, "the state path"); if (binding.state.json !== undefined && binding.state.json !== "" && !JSON_PATH.test(String(binding.state.json))) problems.push(`${name}: the JSON field must be a dotted path.`); }
    if (binding.command) {
      path(binding.command.path, "the command path");
      if (!["POST", "PUT", "GET"].includes(binding.command.method || "POST")) problems.push(`${name}: the command method must be POST, PUT or GET.`);
      for (const part of ["query", "body"]) {
        const value = binding.command[part];
        if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value) || Object.values(value).some((item) => item !== null && typeof item === "object"))) problems.push(`${name}: the command ${part} must be a flat object.`);
      }
    }
  }
  return problems;
}

/** Everything wrong with a profile, as sentences. An empty list means it is well-formed; it says nothing about whether the device works. */
function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return ["The profile isn't an object."];
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  need(profile.format === FORMAT, `format must be ${FORMAT}.`);
  need(ID.test(String(profile.id || "")) && String(profile.id).length <= 120, "id must be a reverse-domain name such as com.example.temperature-sensor.");
  need(SEMVER.test(String(profile.version || "")), "version must be an exact version such as 1.0.0.");
  need(text(profile.name, 80), "name is required.");
  need(text(profile.author, 80), "author is required.");
  need(text(profile.manufacturer, 80), "manufacturer is required.");
  need(text(profile.model, 80), "model is required.");
  need(Object.hasOwn(CATEGORIES, profile.category), `category must be one of: ${Object.keys(CATEGORIES).join(", ")}.`);
  need(DOMAINS.includes(profile.domain), `domain must be one of: ${DOMAINS.join(", ")}.`);
  const adapter = profile.protocol?.adapter;
  const built = Object.hasOwn(ADAPTERS, adapter || "");
  need(built || Object.hasOwn(NOT_BUILT, adapter || ""), `protocol.adapter must name a protocol HANNAH knows: ${[...Object.keys(ADAPTERS), ...Object.keys(NOT_BUILT)].join(", ")}.`);
  const fields = new Map();
  const list = profile.connection?.fields;
  if (!Array.isArray(list) || list.length > 24) problems.push("connection.fields must list the settings a person enters (at most 24).");
  else for (const field of list) {
    if (!FIELD_ID.test(String(field?.id || "")) || fields.has(field.id)) { problems.push(`A connection setting has a missing or repeated id (${String(field?.id).slice(0, 40)}).`); continue; }
    fields.set(field.id, field);
    need(text(field.label, 60), `Setting “${field.id}” needs a label.`);
    need(FIELD_TYPES.includes(field.type), `Setting “${field.id}” must be one of: ${FIELD_TYPES.join(", ")}.`);
    if (field.type === "choice") need(Array.isArray(field.choices) && field.choices.length > 0 && field.choices.length <= 30 && field.choices.every((item) => typeof item === "string"), `Setting “${field.id}” needs its choices.`);
  }
  need(Array.isArray(profile.connection?.instructions) && profile.connection.instructions.length > 0 && profile.connection.instructions.every((line) => text(line, 300)), "connection.instructions must say, in plain sentences, how to connect the device.");
  if (built) for (const name of ADAPTERS[adapter].needs) need(fields.has(name), `A ${ADAPTERS[adapter].label} device needs the connection setting “${name}”.`);
  const points = profile.points;
  if (!Array.isArray(points) || !points.length || points.length > 64) problems.push("points must list 1 to 64 things the device can report or do.");
  else {
    const seen = new Set();
    for (const point of points) {
      const id = String(point?.id || "");
      if (!POINT_ID.test(id) || seen.has(id)) { problems.push(`A point has a missing, malformed or repeated id (${id.slice(0, 40)}).`); continue; }
      seen.add(id);
      const name = `Point “${id}”`;
      need(text(point.name, 60), `${name} needs a name.`);
      if (FORBIDDEN_POINT.test(id) || FORBIDDEN_POINT.test(String(point.name || ""))) problems.push(`${name}: firmware, resets, passwords and pairing can't be exposed as points.`);
      need(["sensor", "actuator"].includes(point.kind), `${name}: kind must be sensor or actuator.`);
      need(["boolean", "number", "enum", "text"].includes(point.type), `${name}: type must be boolean, number, enum or text.`);
      need(["read", "read-write"].includes(point.access), `${name}: access must be read or read-write.`);
      if (point.unit !== undefined) need(typeof point.unit === "string" && point.unit.length <= 12, `${name}: unit must be short text.`);
      if (point.risk !== undefined) need(RISKS.includes(point.risk), `${name}: risk must be low, elevated or high.`);
      const range = point.range;
      if (range !== undefined) need(Array.isArray(range) && range.length === 2 && isNumber(range[0]) && isNumber(range[1]) && range[0] < range[1], `${name}: range must be [lowest, highest].`);
      if (point.step !== undefined) need(isNumber(point.step) && point.step > 0, `${name}: step must be a positive number.`);
      if (point.type === "enum") need(Array.isArray(point.choices) && point.choices.length > 0 && point.choices.length <= 30 && point.choices.every((item) => typeof item === "string" && item.length <= 40), `${name}: an enum needs its choices.`);
      if (point.access === "read-write") {
        need(point.kind === "actuator", `${name}: only an actuator can be writable.`);
        need(point.type !== "text", `${name}: free text can't be written to a device.`);
        if (point.type === "number") need(Array.isArray(range), `${name}: a writable number needs a range. Without one nothing limits what is sent.`);
      }
      if (built) problems.push(...bindingProblems(adapter, point, fields));
    }
  }
  if (profile.availability !== undefined) {
    if (adapter !== "mqtt") problems.push("availability is for MQTT devices.");
    else { problems.push(...templateProblems(profile.availability.topic, fields, "The availability topic", { topic: true })); need(text(String(profile.availability.online ?? ""), 40) && text(String(profile.availability.offline ?? ""), 40), "availability needs the online and offline messages."); }
  }
  need(Array.isArray(profile.constraints) && profile.constraints.every((line) => text(line, 300)), "constraints is required (an empty list when there are none).");
  need(Array.isArray(profile.permissions) && profile.permissions.every((item) => Object.hasOwn(PERMISSIONS, item)), `permissions must be a list from: ${Object.keys(PERMISSIONS).join(", ")}.`);
  need(Array.isArray(profile.dependencies), "dependencies is required (an empty list when there are none).");
  const tests = profile.tests;
  need(tests && TEST_LEVELS.includes(tests.level) && Number.isInteger(tests.passed) && Number.isInteger(tests.total) && tests.passed <= tests.total && typeof tests.evidence === "string", `tests must give level (${TEST_LEVELS.join(", ")}), passed, total and evidence.`);
  need(text(profile.documentation, 2000), "documentation is required.");
  if (profile.simulated && tests && ["hardware-in-the-loop", "physical"].includes(tests.level)) problems.push("A simulated device can't claim hardware tests.");
  if (HIGH_RISK_CATEGORIES.has(profile.category) || profile.domain === "industrial") need(Array.isArray(profile.constraints) && profile.constraints.length > 0, "A lock, an actuator, a controller or industrial equipment must state its safety constraints.");
  return problems;
}

/** The risk of writing to a point: the profile's own word, raised by what kind of device it is. Never lowered. */
function riskOf(profile, point) {
  const own = RISKS.indexOf(point.risk || "low");
  const floor = HIGH_RISK_CATEGORIES.has(profile.category) ? 2 : profile.domain === "industrial" ? 1 : 0;
  return RISKS[Math.max(own, floor)];
}

/** Check the settings a person entered against the profile. Returns { problems, plain, secret }. */
function checkSettings(profile, input = {}) {
  const problems = [];
  const plain = {};
  const secret = {};
  const used = new Set();
  for (const point of profile.points || []) for (const part of Object.values(point.binding || {})) for (const key of ["topic", "path"]) placeholders(part?.[key]).forEach((name) => used.add(name));
  placeholders(profile.availability?.topic).forEach((name) => used.add(name));
  for (const field of profile.connection?.fields || []) {
    let value = input[field.id];
    if (value === undefined || value === null || value === "") value = field.default;
    if (value === undefined || value === null || value === "") { if (field.required || used.has(field.id)) problems.push({ field: field.id, message: `${field.label} is needed.` }); continue; }
    if (field.type === "number") {
      const number = typeof value === "string" ? Number(value) : value;
      if (!isNumber(number) || (isNumber(field.min) && number < field.min) || (isNumber(field.max) && number > field.max)) { problems.push({ field: field.id, message: `${field.label} must be a number${isNumber(field.min) && isNumber(field.max) ? ` from ${field.min} to ${field.max}` : ""}.` }); continue; }
      plain[field.id] = number;
    } else if (field.type === "toggle") plain[field.id] = value === true || value === "true";
    else if (field.type === "choice") { if (!field.choices.includes(value)) { problems.push({ field: field.id, message: `${field.label} must be one of: ${field.choices.join(", ")}.` }); continue; } plain[field.id] = value; }
    else {
      const string = String(value);
      if (string.length > 200 || /[\u0000-\u001f\u007f]/.test(string)) { problems.push({ field: field.id, message: `${field.label} is too long or has characters that can't be used.` }); continue; }
      if (used.has(field.id) && !/^[A-Za-z0-9_.:\-/]{1,120}$/.test(string)) { problems.push({ field: field.id, message: `${field.label} may only use letters, digits and . _ - : /` }); continue; }
      if (field.id === "host" && !/^[A-Za-z0-9.\-:]{1,120}$/.test(string)) { problems.push({ field: field.id, message: `${field.label} must be a network address such as 192.168.1.20.` }); continue; }
      if (field.id === "url") {
        let parsed = null;
        try { parsed = new URL(string); } catch { parsed = null; }
        if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) { problems.push({ field: field.id, message: `${field.label} must start with http:// or https:// and carry no password.` }); continue; }
      }
      (field.type === "secret" ? secret : plain)[field.id] = string;
    }
  }
  return { problems, plain, secret };
}

/**
 * The level people see for a profile, with the reasons.
 *   source        "builtin" | "studio" (a person built it) | "manual" (proposed from a document) | "upload"
 *   hubAdapters   the adapters the chosen hub reported, when known
 *   signedBy      who signed it, when a trusted signature was verified
 */
function compatibility(profile, { source = "builtin", hubAdapters = null, signedBy = null } = {}) {
  const adapter = profile.protocol?.adapter;
  const out = (level, reasons) => ({ level, label: LEVELS[level], reasons });
  if (profile.unsupported) return out("unsupported", [String(profile.unsupported).slice(0, 300)]);
  if (Object.hasOwn(NOT_BUILT, adapter)) return out("developer-required", [NOT_BUILT[adapter]]);
  if (!Object.hasOwn(ADAPTERS, adapter)) return out("unsupported", ["HANNAH doesn't know this protocol."]);
  if (hubAdapters && !hubAdapters.includes(adapter)) return out("developer-required", [`That hub's software has no ${ADAPTERS[adapter].label} adapter. Update the hub.`]);
  if (profile.simulated) return out("simulation", ["A simulated device. It proves nothing about any product."]);
  if (source === "manual") return out("experimental", ["Proposed from a document. Every value needs checking against the device before it is trusted."]);
  if (source === "studio") return out("guided", ["You described this device yourself. HANNAH checks the connection and what it hears, not whether the description is right."]);
  const hardware = ["hardware-in-the-loop", "physical"].includes(profile.tests?.level) && profile.tests.passed === profile.tests.total && profile.tests.total > 0 && Boolean(profile.tests.evidence);
  if (hardware && signedBy) return out("plug-and-play", [`Tested on the device itself (${profile.tests.passed} of ${profile.tests.total} tests) and signed by ${signedBy}.`]);
  return out("experimental", [hardware ? "It reports hardware tests, but isn't signed by a publisher you trust." : "Written from the maker's documentation. It has not been tested on the device itself."]);
}

/** A profile as the app shows it: no bindings, nothing a model could use as an address. */
function publicProfile(profile) {
  return {
    id: profile.id, version: profile.version, name: profile.name, author: profile.author, manufacturer: profile.manufacturer, model: profile.model, revisions: profile.revisions || [],
    category: profile.category, categoryLabel: CATEGORIES[profile.category] || profile.category, domain: profile.domain, simulated: Boolean(profile.simulated),
    protocol: { adapter: profile.protocol?.adapter, label: ADAPTERS[profile.protocol?.adapter]?.label || profile.protocol?.adapter, version: profile.protocol?.version || null },
    connection: { instructions: profile.connection?.instructions || [], fields: (profile.connection?.fields || []).map(({ id, label, type, required, default: preset, help, min, max, choices }) => ({ id, label, type, required: Boolean(required), ...(preset !== undefined && type !== "secret" ? { default: preset } : {}), ...(help ? { help } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(choices ? { choices } : {}) })) },
    points: (profile.points || []).map((point) => ({ id: point.id, name: point.name, kind: point.kind, type: point.type, unit: point.unit || null, range: point.range || null, step: point.step || null, choices: point.choices || null, access: point.access, risk: point.access === "read-write" ? riskOf(profile, point) : null })),
    constraints: profile.constraints || [], permissions: (profile.permissions || []).map((id) => ({ id, meaning: PERMISSIONS[id] })),
    tests: profile.tests ? { level: profile.tests.level, passed: profile.tests.passed, total: profile.tests.total } : null,
    documentation: profile.documentation || "", sources: (profile.sources || []).slice(0, 8),
  };
}

const signedPart = (profile) => { const { signature: _signature, ...rest } = profile; return Buffer.from(canonical(rest), "utf8"); };
/** Sign a profile (publisher side). */
function signProfile(profile, privateKey, keyId) {
  const { signature: _old, ...rest } = profile;
  return { ...rest, signature: { algorithm: "ed25519", keyId, value: crypto.sign(null, signedPart(rest), privateKey).toString("base64") } };
}
/**
 * Check a profile someone published before a person decides about it.
 *   trustedKeys   [{ keyId, publicKey (PEM), owner, revokedAt? }]
 * Returns { ok, problems, signedBy, review }. `review` is what a person reads: what it can change, at what risk.
 */
function verifyProfile(profile, { trustedKeys = [] } = {}) {
  const problems = validateProfile(profile);
  const result = { ok: false, problems, signedBy: null, review: null };
  if (problems.length) return result;
  const signature = profile.signature;
  if (!signature || signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") problems.push("It isn't signed. An unsigned profile can be used only as your own draft.");
  else {
    const key = trustedKeys.find((item) => item.keyId === signature.keyId);
    if (!key) problems.push(`Signed with a key you don't trust (${signature.keyId.slice(0, 16)}).`);
    else if (key.revokedAt) problems.push(`Signed with a key that was revoked on ${new Date(key.revokedAt).toISOString().slice(0, 10)}.`);
    else {
      let valid = false;
      try { valid = crypto.verify(null, signedPart(profile), key.publicKey, Buffer.from(signature.value, "base64")); } catch { valid = false; }
      if (valid) result.signedBy = key.owner || key.keyId;
      else problems.push("The signature doesn't match: the profile was changed after signing, or signed with another key.");
    }
  }
  const writable = profile.points.filter((point) => point.access === "read-write");
  result.review = {
    ...publicProfile(profile),
    canChange: writable.map((point) => ({ id: point.id, name: point.name, risk: riskOf(profile, point), range: point.range || null })),
    risk: writable.some((point) => riskOf(profile, point) === "high") ? "high" : writable.some((point) => riskOf(profile, point) === "elevated") ? "elevated" : writable.length ? "low" : "read only",
    warnings: [
      ...(["hardware-in-the-loop", "physical"].includes(profile.tests.level) ? [] : ["Its tests did not run on the device itself."]),
      ...(profile.tests.passed < profile.tests.total ? [`${profile.tests.total - profile.tests.passed} of its own tests fail.`] : []),
      ...(profile.protocol.adapter === "modbus-tcp" ? ["Modbus has no sign-in or encryption: anything on the device's network can write to it."] : []),
    ],
  };
  result.ok = problems.length === 0;
  return result;
}

/** What the hub needs for one device: the points with their bindings, nothing descriptive. */
function hubProfile(profile) {
  return {
    id: profile.id, version: profile.version, protocol: { adapter: profile.protocol.adapter },
    ...(profile.availability ? { availability: profile.availability } : {}),
    points: profile.points.map(({ id, name, kind, type, unit, range, step, choices, access, binding }) => ({ id, name, kind, type, ...(unit ? { unit } : {}), ...(range ? { range } : {}), ...(step ? { step } : {}), ...(choices ? { choices } : {}), access, binding })),
  };
}

let builtinCache = null;
/** The profiles that ship with HANNAH (server/devices/catalog.json, generated from hannah-os/profiles). */
function builtin() {
  if (!builtinCache) builtinCache = require("./catalog.json");
  return builtinCache;
}

module.exports = { ADAPTERS, CATEGORIES, DOMAINS, FORMAT, HIGH_RISK_CATEGORIES, LEVELS, NOT_BUILT, PERMISSIONS, POINT_ID, RISKS, TEST_LEVELS, builtin, checkSettings, compatibility, hubProfile, keyIdOf, publicProfile, riskOf, signProfile, validateProfile, verifyProfile };
