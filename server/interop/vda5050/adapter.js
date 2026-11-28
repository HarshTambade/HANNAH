"use strict";

/**
 * Interop adapter #2: vehicles that speak VDA 5050 2.0 over MQTT.
 *
 * HANNAH acts as the VDA 5050 master control for the vehicles a person
 * registers (manufacturer + serial number on a broker). It subscribes to their
 * state, connection and factsheet topics (§6.5), keeps the last of each, and
 * reads them into the normalized interface (../capability.js). Every message
 * in either direction is checked against the published 2.0.0 JSON schemas; a
 * message that fails is never sent and, received, never used.
 *
 * Missions become orders (§6.6, §6.7) or instant actions (§6.9). Before an
 * order goes out the adapter checks, from the vehicle's own last report: it is
 * registered, connected and reporting, in AUTOMATIC or SEMIAUTOMATIC mode
 * (§6.10.6), emergency stop not engaged and no protective field violated, no
 * fatal error, localized on the expected map, not already on an order,
 * battery above the owner's minimum, the goal inside the owner's workspace
 * (a physical vehicle has to have one), the speed under both the owner's and
 * the factsheet's limit, and the factsheet offers every action the mission
 * needs at the right scope. A refusal says which of these failed.
 *
 * A vehicle seen on the broker that nobody registered is handed to the trust
 * service, which quarantines or rejects it by the account's policy. Nothing is
 * ever sent to it.
 *
 * What this needs: a server process that stays up (an MQTT subscription has
 * to be held open). On serverless hosting the connector isn't running and
 * vehicles show as not reporting; that is shown, not hidden.
 */
const crypto = require("node:crypto");
const capability = require("../capability");
const mqtt = require("./mqtt");
const schema = require("./schema");
const messages = require("./messages");
const { decryptSecret, encryptSecret, vaultConfigured } = require("../../vault");

const FINAL = new Set(["succeeded", "unverified", "failed", "cancelled", "rejected", "expired", "lost"]);
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { try { return text ? JSON.parse(text) ?? fallback : fallback; } catch { return fallback; } };
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const pointOf = (value) => (value && finite(value.x) && finite(value.y) ? { x: value.x, y: value.y, ...(finite(value.theta) ? { theta: value.theta } : {}), ...(value.nodeId ? { nodeId: clean(value.nodeId, 60) } : {}) } : null);

function createVda5050Adapter({ trust = null, now = () => Date.now(), connect = mqtt.connect, stateTimeoutMs = 30_000, sendTimeoutMs = 15_000, log = () => {} } = {}) {
  const connections = new Map(); // `${userId}|${host}:${port}|${interfaceName}` → { client, ready }
  const headerIds = new Map();
  const nextHeader = (robotId, topic) => { const key = `${robotId}|${topic}`; const value = (headerIds.get(key) || 0) + 1; headerIds.set(key, value); return value; };

  // ---------- registry ----------
  function configOf(input = {}) {
    const broker = input.broker || {};
    const host = clean(broker.host, 120);
    if (!/^[A-Za-z0-9.\-:]{1,120}$/.test(host)) throw fail(400, "Give the MQTT broker's address.", "bad-request");
    const port = Number(broker.port) || (broker.tls ? 8883 : 1883);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, "The broker port is 1 to 65535.", "bad-request");
    const manufacturer = clean(input.manufacturer, 64);
    const serialNumber = clean(input.serialNumber, 64);
    try { messages.topicFor({ interfaceName: input.interfaceName || "uagv", manufacturer, serialNumber }, "state"); } catch (error) { throw fail(400, error.message, "bad-request"); }
    const stations = {};
    for (const [name, value] of Object.entries(input.stations || {}).slice(0, 60)) { const point = pointOf(value); if (point && /^[\w .-]{1,60}$/.test(name)) stations[name] = point; }
    const limits = input.limits || {};
    const workspace = limits.workspace && ["minX", "maxX", "minY", "maxY"].every((key) => finite(limits.workspace[key])) && limits.workspace.minX < limits.workspace.maxX && limits.workspace.minY < limits.workspace.maxY ? { minX: limits.workspace.minX, maxX: limits.workspace.maxX, minY: limits.workspace.minY, maxY: limits.workspace.maxY } : null;
    return {
      interfaceName: clean(input.interfaceName, 64) || "uagv", majorVersion: "v2", manufacturer, serialNumber, mapId: clean(input.mapId, 80) || null,
      broker: { host, port, username: broker.username ? clean(broker.username, 120) : null, tls: broker.tls ? { ca: typeof broker.tls.ca === "string" ? broker.tls.ca.slice(0, 20_000) : null, cert: typeof broker.tls.cert === "string" ? broker.tls.cert.slice(0, 20_000) : null, servername: broker.tls.servername ? clean(broker.tls.servername, 120) : null } : null },
      stations, dock: pointOf(input.dock), inspectAction: clean(input.inspectAction, 60) || "detectObject",
      limits: { maxSpeed: finite(limits.maxSpeed) && limits.maxSpeed > 0 ? limits.maxSpeed : null, minBatteryPercent: finite(limits.minBatteryPercent) ? Math.max(0, Math.min(100, limits.minBatteryPercent)) : 20, workspace },
    };
  }
  const vehicleOf = (config) => ({ interfaceName: config.interfaceName, majorVersion: config.majorVersion, manufacturer: config.manufacturer, serialNumber: config.serialNumber });

  async function register(db, userId, input = {}) {
    const name = clean(input.name, 60);
    if (!name) throw fail(400, "Give the vehicle a name.", "bad-request");
    if (typeof input.simulated !== "boolean") throw fail(400, "Say whether this vehicle is a simulation or physical.", "bad-request");
    const config = configOf(input);
    const secrets = {};
    if (input.broker?.password || input.broker?.tls?.key) {
      if (!vaultConfigured()) throw fail(503, "This server has no key vault to keep the broker password or client key in.", "vault-unconfigured");
      if (input.broker.password) secrets.password = String(input.broker.password).slice(0, 400);
      if (input.broker.tls?.key) secrets.key = String(input.broker.tls.key).slice(0, 20_000);
    }
    const id = `ia_${crypto.randomBytes(9).toString("hex")}`;
    const at = now();
    const existing = (await db.query("SELECT id, config FROM hannah_interop_robots WHERE user_id = $1 AND adapter = 'vda5050'", [userId])).rows;
    if (existing.some((row) => { const other = parse(row.config, {}); return other.manufacturer === config.manufacturer && other.serialNumber === config.serialNumber && other.interfaceName === config.interfaceName; })) throw fail(409, "That vehicle is already registered.", "exists");
    if (Object.keys(secrets).length) config.sealed = encryptSecret(JSON.stringify(secrets), { userId, providerId: `interop:${id}` });
    await db.query("INSERT INTO hannah_interop_robots (user_id, id, adapter, name, simulated, status, config, created_at, updated_at) VALUES ($1, $2, 'vda5050', $3, $4, 'registered', $5, $6, $6)", [userId, id, name, input.simulated ? 1 : 0, JSON.stringify(config), at]);
    // A vehicle that was quarantined as unknown is now known.
    if (trust) await db.query("DELETE FROM hannah_device_identities WHERE user_id = $1 AND device_id = $2 AND status = 'quarantined'", [userId, deviceIdOf(config)]).catch(() => {});
    return getRobot(db, userId, id);
  }
  const deviceIdOf = (config) => `vda5050:${config.manufacturer}:${config.serialNumber}`.slice(0, 80);
  async function remove(db, userId, id) {
    const removed = await db.query("DELETE FROM hannah_interop_robots WHERE user_id = $1 AND id = $2 AND adapter = 'vda5050'", [userId, String(id)]);
    if (!Number(removed.rowCount)) throw fail(404, "No such vehicle.", "not-found");
    return { removed: true };
  }

  // ---------- normalized view ----------
  function view(row, at = now(), active = null) {
    const config = parse(row.config, {});
    const factsheet = parse(row.factsheet);
    const state = parse(row.state);
    const lastAt = row.last_state_at ? Number(row.last_state_at) : null;
    const fresh = Boolean(state && lastAt && at - lastAt <= stateTimeoutMs);
    const linkState = row.connection_state || null;
    const connection = linkState === "CONNECTIONBROKEN" ? "link-broken" : linkState === "OFFLINE" ? "offline" : fresh ? "online" : state ? "stale" : "never-connected";
    const pose = state?.agvPosition || null;
    return {
      id: row.id, adapter: "vda5050", name: row.name, kind: Number(row.simulated) ? "simulation" : "physical",
      identity: { manufacturer: config.manufacturer, model: factsheet?.typeSpecification?.seriesName || null, serialNumber: config.serialNumber, protocol: "VDA 5050", protocolVersion: state?.version || factsheet?.version || null, interfaceName: config.interfaceName, broker: `${config.broker?.host}:${config.broker?.port}${config.broker?.tls ? " (TLS)" : ""}` },
      state: { connection, online: connection === "online", lastReportAt: lastAt, ageS: lastAt ? Math.round((at - lastAt) / 100) / 10 : null, stale: !fresh },
      battery: state?.batteryState ? { percent: state.batteryState.batteryCharge, charging: Boolean(state.batteryState.charging) } : null,
      pose: pose ? { x: pose.x, y: pose.y, theta: pose.theta, mapId: pose.mapId, localized: Boolean(pose.positionInitialized), localizationScore: pose.localizationScore ?? null } : null,
      navigation: state ? { driving: Boolean(state.driving), paused: Boolean(state.paused), orderId: state.orderId || null, lastNodeId: state.lastNodeId || null, remainingNodes: (state.nodeStates || []).length } : null,
      mission: active ? { id: active.id, type: active.mission, status: active.status } : null,
      diagnostics: state ? messages.diagnosticsOf(state) : { errors: [], estop: { engaged: null, kind: null }, fieldViolation: null },
      mode: state ? { normalized: messages.MODES[state.operatingMode] || "unknown", vendor: state.operatingMode, acceptsMissions: messages.CONTROLLABLE_MODES.has(state.operatingMode) } : { normalized: "unknown", vendor: null, acceptsMissions: false },
      functions: factsheet ? messages.featuresOf(factsheet, config) : ["status.continuous"],
      maintenance: { supported: false, note: "VDA 5050 2.0 carries no maintenance data; record service under Robots → maintenance." },
      extensions: messages.extensionsOf(factsheet, state),
      config: { stations: Object.keys(config.stations || {}), dock: config.dock || null, limits: config.limits, mapId: config.mapId, inspectAction: config.inspectAction },
      hasFactsheet: Boolean(factsheet), status: row.status, createdAt: Number(row.created_at),
    };
  }
  async function rows(db, userId) { return (await db.query("SELECT * FROM hannah_interop_robots WHERE user_id = $1 AND adapter = 'vda5050' ORDER BY created_at", [userId])).rows; }
  async function activeMission(db, userId, robotId) {
    await settle(db, userId, robotId);
    return (await db.query("SELECT * FROM hannah_interop_missions WHERE user_id = $1 AND robot_id = $2 AND status IN ('sent', 'accepted', 'paused') ORDER BY created_at DESC LIMIT 1", [userId, robotId])).rows[0] || null;
  }
  async function listRobots(db, userId) {
    const out = [];
    for (const row of await rows(db, userId)) out.push(view(row, now(), await activeMission(db, userId, row.id)));
    return out;
  }
  async function getRobot(db, userId, id) {
    const row = (await db.query("SELECT * FROM hannah_interop_robots WHERE user_id = $1 AND id = $2 AND adapter = 'vda5050'", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "No such vehicle in your account.", "not-found");
    return view(row, now(), await activeMission(db, userId, row.id));
  }
  const rowOf = async (db, userId, id) => (await db.query("SELECT * FROM hannah_interop_robots WHERE user_id = $1 AND id = $2 AND adapter = 'vda5050'", [userId, String(id || "")])).rows[0] || null;

  // ---------- MQTT ----------
  function brokerOptions(userId, row, config) {
    let secrets = {};
    if (config.sealed) { try { secrets = parse(decryptSecret(config.sealed, { userId, providerId: `interop:${row.id}` }).secret, {}); } catch { secrets = {}; } }
    return {
      host: config.broker.host, port: config.broker.port, username: config.broker.username || undefined, password: secrets.password || undefined,
      ...(config.broker.tls ? { tls: { ca: config.broker.tls.ca || undefined, cert: config.broker.tls.cert || undefined, key: secrets.key || undefined, servername: config.broker.tls.servername || undefined } } : {}),
    };
  }
  /** Connect to every broker the account's vehicles are on and subscribe to their topics. Safe to call often. */
  async function connectAccount(db, userId) {
    const list = await rows(db, userId);
    for (const row of list) {
      const config = parse(row.config, {});
      const key = `${userId}|${config.broker.host}:${config.broker.port}|${config.interfaceName}`;
      if (connections.get(key)?.client?.connected) continue;
      const ready = (async () => {
        const client = await connect({ ...brokerOptions(userId, row, config), clientId: `hannah-${crypto.randomBytes(6).toString("hex")}`, keepalive: 15 });
        client.on("message", (topic, payload) => { ingest(db, userId, key, topic, payload).catch((error) => log(`VDA 5050 message not used: ${error?.message || error}`)); });
        client.on("close", () => { if (connections.get(key)?.client === client) connections.delete(key); });
        const base = `${config.interfaceName}/${config.majorVersion}/+/+`;
        await client.subscribe([{ topic: `${base}/state`, qos: 0 }, { topic: `${base}/connection`, qos: 1 }, { topic: `${base}/factsheet`, qos: 1 }]);
        return client;
      })();
      connections.set(key, { ready });
      try { connections.set(key, { client: await ready }); } catch (error) { connections.delete(key); log(`VDA 5050 broker ${config.broker.host}:${config.broker.port} not reachable: ${error.message}`); }
    }
    return { brokers: [...connections.keys()].filter((key) => key.startsWith(`${userId}|`)).length };
  }
  async function clientFor(db, userId, row) {
    const config = parse(row.config, {});
    const key = `${userId}|${config.broker.host}:${config.broker.port}|${config.interfaceName}`;
    if (!connections.get(key)?.client?.connected) await connectAccount(db, userId);
    const client = connections.get(key)?.client;
    if (!client?.connected) throw fail(503, `HANNAH can't reach the vehicle's MQTT broker at ${config.broker.host}:${config.broker.port}.`, "broker-unreachable");
    return client;
  }

  /** A message from the broker. Unknown vehicles go to the trust service; invalid messages are not used. */
  async function ingest(db, userId, key, topic, payload) {
    const parts = messages.parseTopic(topic);
    if (!parts || !["state", "connection", "factsheet"].includes(parts.topic)) return;
    const candidates = await rows(db, userId);
    const row = candidates.find((item) => { const config = parse(item.config, {}); return config.manufacturer === parts.manufacturer && config.serialNumber === parts.serialNumber && key === `${userId}|${config.broker.host}:${config.broker.port}|${config.interfaceName}`; });
    if (!row) {
      if (trust) await trust.observeUnregistered(db, userId, { deviceId: `vda5050:${parts.manufacturer}:${parts.serialNumber}`.slice(0, 80), kind: "agv", source: `VDA 5050 broker ${key.split("|")[1]}`, detail: { topic } });
      return;
    }
    let message;
    try { message = JSON.parse(payload.toString("utf8")); } catch { message = null; }
    const problems = message ? schema.validate(parts.topic, message) : ["not JSON"];
    if (problems.length) {
      if (trust) await trust.audit(db, { userId, deviceId: row.id, kind: "vda5050-message", decision: "refused", reason: `A ${parts.topic} message failed the VDA 5050 2.0.0 schema and was not used: ${problems.slice(0, 3).join("; ")}` });
      return;
    }
    if (message.manufacturer !== parts.manufacturer || message.serialNumber !== parts.serialNumber) {
      if (trust) await trust.audit(db, { userId, deviceId: row.id, kind: "vda5050-message", decision: "refused", reason: "A message's header names another vehicle than its topic." });
      return;
    }
    const at = now();
    if (parts.topic === "state") {
      await db.query("UPDATE hannah_interop_robots SET state = $1, last_state_at = $2, connection_state = CASE WHEN connection_state IS NULL OR connection_state = 'CONNECTIONBROKEN' OR connection_state = 'OFFLINE' THEN 'ONLINE' ELSE connection_state END, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(message), at, userId, row.id]);
      await settle(db, userId, row.id);
    } else if (parts.topic === "connection") {
      await db.query("UPDATE hannah_interop_robots SET connection_state = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [message.connectionState, at, userId, row.id]);
    } else {
      await db.query("UPDATE hannah_interop_robots SET factsheet = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(message), at, userId, row.id]);
    }
  }

  // ---------- missions ----------
  /** Bring this vehicle's open missions up to date with its last state. */
  async function settle(db, userId, robotId) {
    const row = await rowOf(db, userId, robotId);
    if (!row) return;
    const state = parse(row.state);
    const lastAt = row.last_state_at ? Number(row.last_state_at) : 0;
    const at = now();
    const open = (await db.query("SELECT * FROM hannah_interop_missions WHERE user_id = $1 AND robot_id = $2 AND status IN ('sent', 'accepted', 'paused')", [userId, robotId])).rows;
    for (const mission of open) {
      const detail = parse(mission.detail, {});
      if (!detail.order) continue;
      let progress = messages.missionProgress(detail.order, lastAt >= Number(mission.created_at) ? state : null);
      if (progress.status === "sent" && at - Number(mission.created_at) > sendTimeoutMs) progress = { status: "expired", evidence: "The vehicle didn't take the order in time. Nothing was run." };
      if (["accepted", "paused"].includes(progress.status) && at - lastAt > stateTimeoutMs) progress = { status: "lost", evidence: "The vehicle stopped reporting while working on the order. Its outcome is unknown." };
      if (progress.status === mission.status && !progress.progress) continue;
      const final = FINAL.has(progress.status);
      await db.query("UPDATE hannah_interop_missions SET status = $1, detail = $2, error = $3, updated_at = $4, finished_at = $5 WHERE user_id = $6 AND id = $7 AND status = $8",
        [progress.status, JSON.stringify({ ...detail, evidence: progress.evidence, progress: progress.progress || null }), ["failed", "rejected", "expired", "lost", "unverified"].includes(progress.status) ? clean(progress.evidence, 600) : null, at, final ? at : null, userId, mission.id, mission.status]);
    }
  }

  /** The Safety Gateway's answer for a VDA 5050 vehicle: every reason it can't take this mission now. */
  async function assess(db, userId, robotId, missionType, params = {}) {
    const definition = capability.MISSIONS[missionType];
    const row = await rowOf(db, userId, robotId);
    if (!row) throw fail(404, "No such vehicle in your account.", "not-found");
    const robot = view(row, now(), await activeMission(db, userId, row.id));
    const config = parse(row.config, {});
    const factsheet = parse(row.factsheet);
    const state = parse(row.state);
    const violations = [];
    const warnings = [];
    const add = (code, message) => violations.push({ code, message });
    if (!definition) return { ok: false, robot, violations: [{ code: "unknown-mission", message: capability.negotiate([], missionType).explanation }], warnings, negotiation: capability.negotiate([], missionType) };
    for (const problem of capability.checkInput(missionType, params)) add("bad-input", problem);
    const negotiation = capability.negotiate(robot.functions, missionType);
    if (!factsheet) add("no-factsheet", "The vehicle hasn't published its factsheet (VDA 5050 2.0 §7), so HANNAH doesn't know what it can do.");
    else {
      if (!negotiation.supported) add("unsupported", negotiation.explanation);
      for (const reason of messages.vdaReasons(factsheet, config, missionType, params)) if (!violations.some((item) => item.message === reason.message)) add(reason.code, reason.message);
    }
    if (!robot.state.online) add("not-reporting", robot.state.connection === "never-connected" ? "The vehicle has never reported." : `The vehicle isn't reporting (${robot.state.connection}${robot.state.ageS !== null ? `, last report ${robot.state.ageS} s ago` : ""}).`);
    if (missionType === "report_status" || missionType === "request_assistance") return { ok: violations.length === 0, robot, violations, warnings, negotiation, flags: [] };
    if (state) {
      if (!messages.CONTROLLABLE_MODES.has(state.operatingMode)) add("mode", `The vehicle is in ${state.operatingMode} mode; master control may send orders only in AUTOMATIC or SEMIAUTOMATIC (VDA 5050 2.0 §6.10.6).`);
      if (state.safetyState?.eStop && state.safetyState.eStop !== "NONE") add("estop", `The vehicle's emergency stop is engaged (${state.safetyState.eStop}).`);
      if (state.safetyState?.fieldViolation) add("field-violation", "A protective field of the vehicle is violated.");
      const fatal = (state.errors || []).find((error) => error.errorLevel === "FATAL");
      if (fatal) add("fatal-error", `The vehicle reports a fatal error: ${fatal.errorType}${fatal.errorDescription ? ` (${fatal.errorDescription})` : ""}.`);
      if (!state.agvPosition?.positionInitialized) add("not-localized", "The vehicle doesn't report an initialized position.");
      if ((state.nodeStates || []).length || state.driving || robot.mission) add("busy", `The vehicle is working on order ${state.orderId || robot.mission?.id}. Cancel it or wait.`);
      if (missionType !== "dock" && finite(state.batteryState?.batteryCharge) && state.batteryState.batteryCharge < config.limits.minBatteryPercent) add("battery", `Battery ${Math.round(state.batteryState.batteryCharge)}%, below the ${config.limits.minBatteryPercent}% minimum for a mission.`);
    }
    // Where it is going.
    const mapId = clean(params.mapId, 80) || config.mapId || state?.agvPosition?.mapId || null;
    if (state?.agvPosition && mapId && state.agvPosition.mapId !== mapId) add("wrong-map", `The vehicle is on map “${state.agvPosition.mapId}”, not “${mapId}”.`);
    const resolve = (value) => {
      if (!value) return null;
      if (value.place) return config.stations?.[value.place] ? { ...config.stations[value.place], description: `Station ${value.place}` } : null;
      return pointOf(value);
    };
    let points = [];
    const nodeActions = {};
    if (missionType === "navigate") points = [resolve(params.place ? { place: params.place } : params)];
    if (missionType === "inspect") { points = (Array.isArray(params.waypoints) ? params.waypoints.slice(0, 20) : []).map(resolve); points.forEach((_point, index) => { nodeActions[index] = [{ type: config.inspectAction, blocking: "HARD" }]; }); if (!points.length) add("bad-input", "An inspection needs at least one waypoint."); }
    if (missionType === "deliver") {
      points = [resolve(params.from), resolve(params.to)];
      const load = [...(params.loadId ? [{ key: "loadId", value: clean(params.loadId, 60) }] : []), ...(params.loadType ? [{ key: "loadType", value: clean(params.loadType, 60) }] : [])];
      nodeActions[0] = [{ type: "pick", blocking: "HARD", parameters: load }];
      nodeActions[1] = [{ type: "drop", blocking: "HARD", parameters: load }];
    }
    if (missionType === "dock") { points = [config.dock ? { ...config.dock, description: "Dock" } : null]; if (params.charge !== false && config.dock) nodeActions[0] = [{ type: "startCharging", blocking: "HARD" }]; }
    if (points.some((point) => !point)) add("bad-goal", "A place in this mission isn't a position or a configured station.");
    const workspace = config.limits.workspace;
    if (!workspace && robot.kind === "physical") add("no-workspace", "A physical vehicle needs a workspace (the area it may be sent within) before HANNAH sends it anywhere.");
    for (const point of points.filter(Boolean)) {
      if (workspace && (point.x < workspace.minX || point.x > workspace.maxX || point.y < workspace.minY || point.y > workspace.maxY)) add("outside-workspace", `(${point.x}, ${point.y}) is outside the vehicle's workspace.`);
      if (finite(point.theta) && Math.abs(point.theta) > Math.PI) add("bad-goal", "A heading must be between -π and π.");
    }
    if (finite(params.tolerance) && points[0]) points[points.length - 1].tolerance = Math.max(0.05, Math.min(1, params.tolerance));
    const factsheetMax = factsheet?.physicalParameters?.speedMax;
    const caps = [config.limits.maxSpeed, factsheetMax, finite(params.maxSpeed) ? params.maxSpeed : null].filter(finite);
    const maxSpeed = caps.length ? Math.min(...caps) : null;
    if (finite(params.maxSpeed) && maxSpeed < params.maxSpeed) warnings.push(`Speed capped at ${maxSpeed} m/s by the vehicle's and the owner's limits.`);
    const flags = robot.kind === "physical" ? ["a physical vehicle will move"] : [];
    return { ok: violations.length === 0, robot, violations, warnings, negotiation, flags, plan: { mapId, points, nodeActions, maxSpeed } };
  }

  async function publish(db, userId, row, topic, message) {
    const problems = schema.validate(topic, message);
    if (problems.length) throw fail(500, `HANNAH built a ${topic} message that fails the VDA 5050 2.0.0 schema, and didn't send it: ${problems.slice(0, 3).join("; ")}`, "schema-invalid");
    const client = await clientFor(db, userId, row);
    const config = parse(row.config, {});
    await client.publish(messages.topicFor(vehicleOf(config), topic), JSON.stringify(message), { qos: 0 }); // §6.2: QoS 0 for order
  }

  /** Send a motion mission as an order. Call only after approval; the checks run again here. */
  async function submit(db, userId, robotId, missionType, params = {}, { actionId = null } = {}) {
    const verdict = await assess(db, userId, robotId, missionType, params);
    if (!verdict.ok) throw fail(409, `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`, "refused", { violations: verdict.violations });
    const row = await rowOf(db, userId, robotId);
    const config = parse(row.config, {});
    const state = parse(row.state);
    const id = `im_${crypto.randomBytes(9).toString("hex")}`;
    const order = messages.buildOrder({ vehicle: vehicleOf(config), headerId: nextHeader(row.id, "order"), at: now(), orderId: `hannah-${id}`, state, mapId: verdict.plan.mapId || state.agvPosition.mapId, points: verdict.plan.points, maxSpeed: verdict.plan.maxSpeed, nodeActions: verdict.plan.nodeActions });
    const at = now();
    await db.query("INSERT INTO hannah_interop_missions (user_id, id, robot_id, adapter, mission, params, status, vendor_ref, action_id, detail, created_at, updated_at) VALUES ($1, $2, $3, 'vda5050', $4, $5, 'sent', $6, $7, $8, $9, $9)",
      [userId, id, row.id, missionType, JSON.stringify(params), order.orderId, actionId, JSON.stringify({ order }), at]);
    try { await publish(db, userId, row, "order", order); } catch (error) {
      await db.query("UPDATE hannah_interop_missions SET status = 'failed', error = $1, finished_at = $2, updated_at = $2 WHERE user_id = $3 AND id = $4", [clean(error.message, 600), now(), userId, id]);
      throw error;
    }
    return getMission(db, userId, id);
  }

  async function instant(db, userId, row, actions) {
    const config = parse(row.config, {});
    await publish(db, userId, row, "instantActions", messages.buildInstantActions({ vehicle: vehicleOf(config), headerId: nextHeader(row.id, "instantActions"), at: now(), actions }));
  }
  /** Hold the vehicle (§6.8.1 startPause) and record that a person is needed. Never needs approval: it only stops motion. */
  async function requestAssistance(db, userId, robotId, { reason = "" } = {}) {
    const row = await rowOf(db, userId, robotId);
    if (!row) throw fail(404, "No such vehicle in your account.", "not-found");
    const actionId = `hannah-assist-${crypto.randomBytes(6).toString("hex")}`;
    await instant(db, userId, row, [{ id: actionId, type: "startPause" }]);
    const id = `im_${crypto.randomBytes(9).toString("hex")}`;
    const at = now();
    await db.query("INSERT INTO hannah_interop_missions (user_id, id, robot_id, adapter, mission, params, status, vendor_ref, detail, created_at, updated_at, finished_at) VALUES ($1, $2, $3, 'vda5050', 'request_assistance', $4, 'succeeded', $5, $6, $7, $7, $7)",
      [userId, id, row.id, JSON.stringify({ reason: clean(reason, 300) }), actionId, JSON.stringify({ evidence: "startPause sent; the vehicle confirms it in its actionStates." }), at]);
    return { missionId: id, sent: "startPause", actionId, note: `${row.name} was asked to hold (startPause). A person is needed: ${clean(reason, 300) || "no reason given"}.` };
  }
  async function cancel(db, userId, missionId) {
    const mission = (await db.query("SELECT * FROM hannah_interop_missions WHERE user_id = $1 AND id = $2 AND adapter = 'vda5050'", [userId, String(missionId)])).rows[0];
    if (!mission) throw fail(404, "No such mission.", "not-found");
    if (FINAL.has(mission.status)) return getMission(db, userId, mission.id);
    const row = await rowOf(db, userId, mission.robot_id);
    await instant(db, userId, row, [{ id: `hannah-cancel-${crypto.randomBytes(6).toString("hex")}`, type: "cancelOrder" }]); // §6.6.3
    const at = now();
    await db.query("UPDATE hannah_interop_missions SET status = 'cancelled', error = $1, finished_at = $2, updated_at = $2 WHERE user_id = $3 AND id = $4", ["Cancelled by HANNAH with cancelOrder (VDA 5050 2.0 §6.6.3). The vehicle stops as soon as it can.", at, userId, mission.id]);
    return getMission(db, userId, mission.id);
  }
  /** The latest state, after asking for a fresh one (§6.8.1 stateRequest) when the vehicle offers it. */
  async function reportStatus(db, userId, robotId, { waitMs = 1500 } = {}) {
    const row = await rowOf(db, userId, robotId);
    if (!row) throw fail(404, "No such vehicle in your account.", "not-found");
    const before = Number(row.last_state_at) || 0;
    const robot = view(row);
    if (robot.functions.includes("status.on-request") && robot.state.connection !== "never-connected") {
      try {
        await instant(db, userId, row, [{ id: `hannah-state-${crypto.randomBytes(6).toString("hex")}`, type: "stateRequest" }]);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && Number((await rowOf(db, userId, robotId)).last_state_at || 0) <= before) await new Promise((resolve) => setTimeout(resolve, 50));
      } catch { /* the stored state is returned with its age */ }
    }
    return getRobot(db, userId, robotId);
  }

  function publicMission(row) {
    const detail = parse(row.detail, {});
    return { id: row.id, robotId: row.robot_id, adapter: "vda5050", mission: row.mission, title: capability.MISSIONS[row.mission]?.title || row.mission, params: parse(row.params, {}), status: row.status, final: FINAL.has(row.status), vendorRef: row.vendor_ref, actionId: row.action_id || null, evidence: detail.evidence || null, progress: detail.progress || null, error: row.error || null, createdAt: Number(row.created_at), finishedAt: row.finished_at ? Number(row.finished_at) : null };
  }
  async function getMission(db, userId, id) {
    const found = (await db.query("SELECT robot_id FROM hannah_interop_missions WHERE user_id = $1 AND id = $2", [userId, String(id)])).rows[0];
    if (!found) throw fail(404, "No such mission.", "not-found");
    await settle(db, userId, found.robot_id);
    return publicMission((await db.query("SELECT * FROM hannah_interop_missions WHERE user_id = $1 AND id = $2", [userId, String(id)])).rows[0]);
  }
  async function listMissions(db, userId, { robotId = null, limit = 30 } = {}) {
    const values = [userId, "vda5050"];
    let where = "user_id = $1 AND adapter = $2";
    if (robotId) { values.push(String(robotId)); where += ` AND robot_id = $${values.length}`; }
    values.push(Math.max(1, Math.min(200, Number(limit) || 30)));
    return (await db.query(`SELECT * FROM hannah_interop_missions WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values)).rows.map(publicMission);
  }

  async function close() {
    for (const entry of connections.values()) await entry.client?.end().catch(() => {});
    connections.clear();
  }

  return {
    id: "vda5050", label: "VDA 5050 2.0 over MQTT",
    protocol: { name: "VDA 5050", version: messages.VERSION, transport: "MQTT 3.1.1", verifiedWith: "The published VDA 5050 2.0.0 JSON schemas, and HANNAH's simulated VDA 5050 vehicle over an in-process MQTT broker. Not yet tested against a vendor's vehicle or fleet manager." },
    assess, cancel, close, connectAccount, getMission, getRobot, ingest, listMissions, listRobots, register, remove, reportStatus, requestAssistance, settle, submit,
  };
}

module.exports = { createVda5050Adapter };
