"use strict";

/**
 * The robot registry and mission service.
 *
 * Enrollment:
 *   - A signed-in person creates a robot record and gets a one-time code
 *     (15 minutes, stored as a hash). They say whether it is a simulation.
 *   - The robot's runtime sends the code with its descriptor: what it is, its
 *     sensors and actuators, the capabilities it offers and its own limits.
 *     A runtime that says "physical" for a record created as a simulation (or
 *     the reverse) is refused.
 *   - The server answers once with a 256-bit secret, sealed in the vault here
 *     and stored by the robot. Two keys are derived from it: one signs the
 *     robot's requests, one signs the commands sent to it. The secret itself
 *     never travels again.
 *
 * The connection is always opened by the robot (HTTPS, outbound): it reports
 * its state and what happened to its missions, and receives signed commands
 * in the answer. Each request is signed over robot id, time, a counter that
 * must increase, method, path and the body's hash, so a recorded request
 * can't be replayed and nothing but the enrolled robot can speak for it.
 *
 * A command names the robot, a mission, a sequence number that only goes up,
 * a nonce, and when it expires (seconds). The robot checks all of that, then
 * its own safety limits, before it moves; a command that isn't accepted in
 * time expires and is never run later.
 *
 * A mission's states are only what was observed:
 *   queued → sent → accepted → succeeded | unverified | failed | cancelled | timed-out
 *                 ↘ rejected (the robot's own checks refused it)
 *   expired   it was never accepted in time
 *   lost      it was accepted and the robot stopped reporting; the outcome is unknown
 * "succeeded" means the robot reported success AND its reported state matches
 * the goal. A success report that the state doesn't support is "unverified".
 */
const crypto = require("node:crypto");
const { decryptSecret, encryptSecret, vaultConfigured } = require("../vault");
const contract = require("./contract");
const safety = require("./safety");
const commissioning = require("./commissioning");
const plans = require("./plans");
const fleet = require("./fleet");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60_000;
const SKEW_MS = 60_000;
const LOST_GRACE_MS = 20_000;
const SYNC_INTERVAL_MS = 1000;
// Joint speed (rad/s) an arm may use during its supervised commissioning trial.
const TRIAL_JOINT_SPEED = 0.3;
const TELEMETRY_EVERY_MS = 3000;
const TELEMETRY_KEEP_MS = 2 * 60 * 60_000;
const EVENTS_KEEP_MS = 30 * 24 * 60 * 60_000;
const MISSIONS_KEEP_MS = 180 * 24 * 60 * 60_000;
const MAX_STATE = 24_000;
const MAX_ROBOTS = 20;
const FINAL = new Set(["succeeded", "unverified", "failed", "cancelled", "rejected", "expired", "timed-out", "lost"]);
const PLAN_OPEN = "('queued', 'running')";
const MODES = new Set(["idle", "navigating", "manipulating", "paused", "holding", "stopping", "docked", "estopped", "fault", "starting"]);
const MAX_DESTINATIONS = 60;
const IMAGE_MAX_BYTES = 200_000;
const IMAGE_RETENTION_H = { default: 24, max: 720 };
const IMAGES_PER_ROBOT = 40;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RESUME_TTL_MS = 20_000;
const AUTH_LABEL = "hannah-robot-auth-v1";
const COMMAND_LABEL = "hannah-robot-command-v1";

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const slug = (value, max = 40) => String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max);

const deriveKey = (secret, label) => crypto.createHmac("sha256", Buffer.from(String(secret), "base64url")).update(label).digest();
const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
/** What a robot signs for a request. */
const requestMessage = ({ robotId, time, counter, method, path, body }) => `${robotId}\n${time}\n${counter}\n${String(method).toUpperCase()}\n${path}\n${sha256(body || "")}`;
const signRequest = (secret, parts) => hmac(deriveKey(secret, AUTH_LABEL), requestMessage(parts));
const signCommand = (secret, payload) => hmac(deriveKey(secret, COMMAND_LABEL), payload);
function sameHex(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function newCode() {
  const bytes = crypto.randomBytes(10);
  const text = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${text.slice(0, 5)}-${text.slice(5)}`;
}
/** A short fingerprint of a robot's secret, shown on both sides so a person can check which device enrolled. */
const fingerprintOf = (secret) => sha256(`hannah-robot-fingerprint-v1:${secret}`).slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
const codeHash = (code) => sha256(`hannah-robot-enroll:${String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")}`);

/** Keep what a robot sent to a safe shape and size: plain data, bounded depth, lists and text. */
function tidy(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : null;
  if (typeof value === "string") return clean(value, 300);
  if (depth >= 6) return null;
  if (Array.isArray(value)) return value.slice(0, 400).map((item) => tidy(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) { if (/^[\w.-]{1,40}$/.test(key)) out[key] = tidy(item, depth + 1); }
    return out;
  }
  return null;
}
function cleanState(input, now) {
  if (!input || typeof input !== "object") return null;
  const state = tidy(input);
  state.mode = MODES.has(state.mode) ? state.mode : "unknown";
  state.receivedAt = now;
  for (const drop of [["nav", "path"], ["sensors", "lidar", "ranges"], ["map"], ["nav"], ["sensors"]]) {
    if (JSON.stringify(state).length <= MAX_STATE) break;
    let target = state;
    for (const key of drop.slice(0, -1)) target = target?.[key];
    if (target && typeof target === "object") delete target[drop.at(-1)];
  }
  return JSON.stringify(state).length <= MAX_STATE ? state : { mode: state.mode, receivedAt: now, truncated: true };
}

const pointOf = (input) => (finite(input?.x) && finite(input?.y) ? { x: round(input.x, 3), y: round(input.y, 3), ...(finite(input.yaw) ? { yaw: round(input.yaw, 4) } : {}) } : null);
/** A sensor or actuator as registered: what it is, and for a sensor its frame, rate, resolution, message type and calibration when the robot gives them. */
const partList = (input) => (Array.isArray(input) ? input.slice(0, 24).map((item) => ({
  id: slug(item?.id), type: clean(item?.type, 40), description: clean(item?.description, 160),
  ...Object.fromEntries(["manufacturer", "model", "frame", "resolution", "messageType", "calibration", "topic"].map((key) => [key, clean(item?.[key], 120)]).filter(([, value]) => value)),
  ...(finite(item?.rateHz) && item.rateHz >= 0 ? { rateHz: round(item.rateHz, 2) } : {}),
})).filter((item) => item.id) : []);

/** What a robot says about itself, checked. Throws when it isn't a robot HANNAH can register. */
function normalizeDescriptor(input) {
  if (!input || typeof input !== "object") throw fail(400, "The robot didn't describe itself.", "bad-descriptor");
  if (!Object.hasOwn(contract.ROBOT_TYPES, input.robotType)) throw fail(400, `Unknown robot type. Known types: ${Object.keys(contract.ROBOT_TYPES).join(", ")}.`, "bad-descriptor");
  const places = {};
  for (const [name, value] of Object.entries(input.places && typeof input.places === "object" ? input.places : {}).slice(0, 40)) {
    const point = pointOf(value);
    const label = clean(name, 60);
    if (point && label) places[label] = point;
  }
  const world = input.world && typeof input.world === "object" ? {
    name: clean(input.world.name, 60),
    bounds: ["minX", "minY", "maxX", "maxY"].every((key) => finite(input.world.bounds?.[key])) ? { minX: input.world.bounds.minX, minY: input.world.bounds.minY, maxX: input.world.bounds.maxX, maxY: input.world.bounds.maxY } : null,
    obstacles: (Array.isArray(input.world.obstacles) ? input.world.obstacles : []).slice(0, 200).map((item) => (["x", "y", "w", "h"].every((key) => finite(item?.[key])) ? { x: round(item.x, 3), y: round(item.y, 3), w: round(item.w, 3), h: round(item.h, 3) } : null)).filter(Boolean),
  } : null;
  const registered = contract.registerCapabilities(input.robotType, input.capabilities);
  return {
    profile: {
      manufacturer: clean(input.manufacturer, 80), model: clean(input.model, 80), robotType: input.robotType, category: contract.ROBOT_TYPES[input.robotType].category,
      os: clean(input.os, 80), compute: clean(input.compute, 80), rosDistro: clean(input.rosDistro, 30), protocols: (Array.isArray(input.protocols) ? input.protocols : []).slice(0, 10).map((item) => clean(item, 40)).filter(Boolean),
      serialNumber: clean(input.serialNumber, 60), softwareVersion: clean(input.softwareVersion, 40), firmwareVersion: clean(input.firmwareVersion, 40), runtimeVersion: clean(input.runtimeVersion, 40), adapter: clean(input.adapter, 40), hostname: clean(input.hostname, 80),
      sensors: partList(input.sensors), actuators: partList(input.actuators),
      devices: (Array.isArray(input.devices) ? input.devices : []).slice(0, 12).map((item) => slug(item)).filter(Boolean),
      places, dock: pointOf(input.dock), world,
      network: { transport: "https, opened by the robot", syncIntervalMs: SYNC_INTERVAL_MS },
      refusedCapabilities: registered.refused,
    },
    capabilities: registered.accepted,
    reported: safety.normalizeLimits(input.limits),
    simulation: input.simulation && typeof input.simulation === "object" ? { kind: clean(input.simulation.kind, 40) || "simulation", note: clean(input.simulation.note, 200) } : null,
  };
}

const ALERTS = new Set(["estop-engaged", "fault", "link-lost", "commissioning-reset", "revoked"]);

function createRoboticsService({ now = () => Date.now(), ackWaitMs = Number(process.env.HANNAH_ROBOT_ACK_WAIT_MS) || 6000, pollMs = 150, emit = null } = {}) {
  /**
   * Tell the account's webhooks and workflows that something happened. Never
   * waited for: a robot's exchange must not depend on someone else's server
   * answering. So a delivery is best effort, and the record in the database
   * is what counts.
   */
  const announce = (userId, event, data) => { if (emit) Promise.resolve().then(() => emit(userId, event, data)).catch(() => {}); };
  const lastSample = new Map();
  let housekeeping = 0;

  // ---------- rows and views ----------
  function effectiveMissionStatus(row, at) {
    if ((row.status === "queued" || row.status === "sent") && Number(row.expires_at) <= at) return "expired";
    if (row.status === "accepted" && Number(row.deadline_at) + LOST_GRACE_MS <= at) return "lost";
    return row.status;
  }
  function publicMission(row, at = now()) {
    if (!row) return null;
    const status = effectiveMissionStatus(row, at);
    return {
      id: row.id, robotId: row.robot_id, capability: row.capability, title: contract.capability(row.capability)?.title || row.capability, params: parse(row.params, {}), status, final: FINAL.has(status),
      actionId: row.action_id || null, planId: row.plan_id || null, requestedBy: row.requested_by || "", createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), deadlineAt: Number(row.deadline_at),
      sentAt: row.sent_at ? Number(row.sent_at) : null, acceptedAt: row.accepted_at ? Number(row.accepted_at) : null, finishedAt: row.finished_at ? Number(row.finished_at) : null,
      cancelRequestedAt: row.cancel_requested_at ? Number(row.cancel_requested_at) : null, pauseRequestedAt: row.pause_requested_at ? Number(row.pause_requested_at) : null, resumeRequestedAt: row.resume_requested_at ? Number(row.resume_requested_at) : null, pausedAt: row.paused_at ? Number(row.paused_at) : null,
      progress: parse(row.progress), result: parse(row.result), verification: parse(row.verification),
      error: row.error || (status === "expired" ? "The robot didn't accept the command before it expired. Nothing was run." : status === "lost" ? "The robot accepted the mission and then stopped reporting. Its outcome is unknown; a robot that loses its link to HANNAH stops by itself." : null),
    };
  }
  /** The registry's working view of a robot: what the Safety Gateway and the app need. Never the secret. */
  function view(row, at = now(), destinations = []) {
    if (!row) return null;
    const profile = parse(row.profile, {});
    const simulated = Boolean(Number(row.simulated));
    const mapName = profile.world?.name || "";
    const frame = parse(row.safety, {}).reported?.workspace?.frame || "map";
    // Names HANNAH may navigate to. A simulation may use the places its runtime reported; a physical
    // robot only the destinations a person defined or approved. Either way a destination made for
    // another map is not used: a name is not a coordinate until someone has said so for this map.
    const places = {};
    if (simulated) for (const [name, point] of Object.entries(profile.places || {})) places[name] = { ...point, source: "robot", map: mapName, frame };
    const staleDestinations = [];
    for (const item of destinations.filter((entry) => entry.robot_id === row.id)) {
      const destination = { id: item.id, name: item.name, x: Number(item.x), y: Number(item.y), ...(item.yaw === null || item.yaw === undefined ? {} : { yaw: Number(item.yaw) }), source: item.source, map: item.map, frame: item.frame };
      if (mapName && item.map !== mapName) staleDestinations.push(destination);
      else places[item.name] = destination;
    }
    const record = parse(row.commissioning);
    const access = parse(row.permissions, {});
    const lastSeenAt = row.last_seen_at ? Number(row.last_seen_at) : null;
    const online = row.status === "enrolled" && lastSeenAt !== null && at - lastSeenAt <= safety.ONLINE_MS;
    const state = parse(row.state);
    const robotSafety = parse(row.safety, {});
    return {
      id: row.id, name: row.name, status: row.status, simulated, simulator: row.simulator || null,
      connection: row.status === "pending" ? "awaiting-enrollment" : row.status === "revoked" ? "revoked" : online ? "online" : lastSeenAt ? "offline" : "never-connected",
      online, lastSeenAt, mode: online ? (row.mode || "unknown") : "offline",
      ...profile, devices: Object.fromEntries((profile.devices || []).map((id) => [id, true])), places, reportedPlaces: profile.places || {}, staleDestinations, mapName, sensors: profile.sensors || [], actuators: profile.actuators || [],
      configVersion: Number(row.config_version) || 1, commissioning: commissioning.summary({ simulated }, record), commissioningRecord: record,
      capabilities: parse(row.capabilities, []), disabled: access.disabled || [], alwaysAsk: access.alwaysAsk || [],
      camera: { enabled: access.camera?.enabled === true, retentionHours: Math.max(1, Math.min(IMAGE_RETENTION_H.max, Number(access.camera?.retentionHours) || IMAGE_RETENTION_H.default)), cameras: (profile.sensors || []).filter((sensor) => /camera/.test(sensor.type || "")).map((sensor) => sensor.id) },
      safety: robotSafety, limits: safety.effectiveLimits(robotSafety),
      state, stateAgeS: state?.receivedAt ? Math.max(0, Math.round((at - state.receivedAt) / 100) / 10) : null,
      owner: "you", createdAt: Number(row.created_at), enrolledAt: row.enrolled_at ? Number(row.enrolled_at) : null, revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
      enrollmentExpiresAt: row.enroll_hash && row.enroll_expires_at ? Number(row.enroll_expires_at) : null,
    };
  }
  async function robotRow(db, userId, id) {
    return (await db.query("SELECT * FROM hannah_robots WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  }
  const destinationRows = async (db, userId) => (await db.query("SELECT * FROM hannah_robot_destinations WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
  async function getRobot(db, userId, id) {
    const row = await robotRow(db, userId, id);
    if (!row) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    return view(row, now(), await destinationRows(db, userId));
  }
  async function listRobots(db, userId) {
    const { rows } = await db.query("SELECT * FROM hannah_robots WHERE user_id = $1 ORDER BY created_at", [userId]);
    const destinations = rows.length ? await destinationRows(db, userId) : [];
    return rows.map((row) => view(row, now(), destinations));
  }
  /** Find a robot by id or by name (exact, any case). An ambiguous or unknown name is an error that lists the choices. */
  async function resolveRobot(db, userId, reference) {
    const robots = await listRobots(db, userId);
    const wanted = clean(reference, 80);
    if (!wanted) {
      const usable = robots.filter((robot) => robot.status === "enrolled");
      if (usable.length === 1) return usable[0];
      throw fail(400, usable.length ? `Which robot? You have: ${usable.map((robot) => robot.name).join(", ")}.` : "You have no enrolled robot. Add one under Robots.", usable.length ? "ambiguous-robot" : "no-robot", { candidates: usable.map((robot) => ({ id: robot.id, name: robot.name })) });
    }
    const byId = robots.find((robot) => robot.id === wanted);
    if (byId) return byId;
    const named = robots.filter((robot) => robot.name.toLowerCase() === wanted.toLowerCase());
    if (named.length === 1) return named[0];
    throw fail(named.length ? 400 : 404, named.length ? `More than one robot is called “${wanted}”. Use its id.` : `You have no robot called “${wanted}”${robots.length ? ` (you have: ${robots.map((robot) => robot.name).join(", ")})` : ""}.`, named.length ? "ambiguous-robot" : "not-found", { candidates: robots.map((robot) => ({ id: robot.id, name: robot.name })) });
  }
  async function addEvent(db, userId, robotId, { type, severity = "info", message, source = "server", at = now() }) {
    await db.query("INSERT INTO hannah_robot_events (user_id, id, robot_id, at, type, severity, message, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [userId, crypto.randomUUID(), robotId, at, clean(type, 40) || "event", ["info", "warning", "error"].includes(severity) ? severity : "info", clean(message, 400), source]).catch(() => {});
  }

  // ---------- registry (a signed-in person) ----------
  async function createRobot(db, userId, { name, simulated } = {}) {
    const label = clean(name, 60);
    if (!label) throw fail(400, "Give the robot a name.", "bad-request");
    if (typeof simulated !== "boolean") throw fail(400, "Say whether this is a simulated robot or a physical one.", "bad-request");
    if (!vaultConfigured()) throw fail(503, "This server can't enroll robots yet: it has no key vault to store a robot's secret in.", "vault-unconfigured");
    const existing = await listRobots(db, userId);
    if (existing.length >= MAX_ROBOTS) throw fail(400, `You have ${MAX_ROBOTS} robots. Remove one first.`, "too-many");
    if (existing.some((robot) => robot.name.toLowerCase() === label.toLowerCase())) throw fail(409, `You already have a robot called “${label}”.`, "duplicate-name");
    const id = `rb_${crypto.randomBytes(9).toString("hex")}`;
    const code = newCode();
    const at = now();
    await db.query(
      `INSERT INTO hannah_robots (user_id, id, name, status, profile, capabilities, safety, permissions, simulated, simulator, enroll_hash, enroll_expires_at, counter, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', '{}', '[]', '{}', '{}', $4, NULL, $5, $6, 0, $7, $7)`,
      [userId, id, label, simulated ? 1 : 0, codeHash(code), at + CODE_TTL_MS, at],
    );
    await addEvent(db, userId, id, { type: "created", message: `Created as a ${simulated ? "simulated" : "physical"} robot. Waiting for its runtime to enroll.` });
    return { robot: await getRobot(db, userId, id), enrollment: { code, expiresAt: at + CODE_TTL_MS } };
  }
  /** A new one-time code. For an enrolled robot this is how its secret is replaced: the old one stops working when the new enrollment completes. */
  async function issueCode(db, userId, id) {
    const row = await robotRow(db, userId, id);
    if (!row) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    if (!vaultConfigured()) throw fail(503, "This server has no key vault to store a robot's secret in.", "vault-unconfigured");
    const code = newCode();
    const at = now();
    await db.query("UPDATE hannah_robots SET enroll_hash = $1, enroll_expires_at = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [codeHash(code), at + CODE_TTL_MS, at, userId, row.id]);
    await addEvent(db, userId, row.id, { type: "enrollment-code", message: "A new enrollment code was created." });
    return { robot: await getRobot(db, userId, row.id), enrollment: { code, expiresAt: at + CODE_TTL_MS } };
  }
  async function updateRobot(db, userId, id, change = {}) {
    const row = await robotRow(db, userId, id);
    if (!row) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    const robot = view(row);
    const fields = {};
    if (change.name !== undefined) {
      const label = clean(change.name, 60);
      if (!label) throw fail(400, "Give the robot a name.", "bad-request");
      const others = (await listRobots(db, userId)).filter((item) => item.id !== row.id);
      if (others.some((item) => item.name.toLowerCase() === label.toLowerCase())) throw fail(409, `You already have a robot called “${label}”.`, "duplicate-name");
      fields.name = label;
    }
    if (change.limits !== undefined) {
      // A person can only tighten: a looser number than the robot's own has no effect (effectiveLimits takes the stricter).
      const owner = safety.normalizeLimits(change.limits || {});
      delete owner.environment; delete owner.estop; delete owner.robotRadius;
      fields.safety = JSON.stringify({ ...robot.safety, owner });
    }
    if (change.disabled !== undefined || change.alwaysAsk !== undefined) {
      const known = (list) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((item) => contract.capability(item));
      // Stopping can't be switched off or made to ask.
      const disabled = change.disabled !== undefined ? known(change.disabled).filter((item) => !contract.capability(item).deescalates) : robot.disabled;
      const alwaysAsk = change.alwaysAsk !== undefined ? known(change.alwaysAsk).filter((item) => !contract.capability(item).deescalates) : robot.alwaysAsk;
      fields.permissions = JSON.stringify({ ...parse(row.permissions, {}), disabled, alwaysAsk });
    }
    if (change.camera !== undefined) {
      // Camera use is off until a person switches it on for this robot. Switching it off deletes nothing; pictures still expire.
      const before = parse(fields.permissions ?? row.permissions, {});
      const camera = { enabled: change.camera?.enabled === undefined ? robot.camera.enabled : change.camera.enabled === true, retentionHours: Math.max(1, Math.min(IMAGE_RETENTION_H.max, Math.round(Number(change.camera?.retentionHours) || robot.camera.retentionHours))) };
      if (camera.enabled && !robot.camera.cameras.length) throw fail(409, `${robot.name} has no camera registered.`, "no-camera");
      fields.permissions = JSON.stringify({ ...before, camera });
      if (camera.enabled !== robot.camera.enabled) await addEvent(db, userId, row.id, { type: camera.enabled ? "camera-enabled" : "camera-disabled", severity: "warning", message: camera.enabled ? `Camera use was switched on. Pictures are kept for ${camera.retentionHours} hours.` : "Camera use was switched off." });
    }
    const names = Object.keys(fields);
    if (names.length) {
      await db.query(`UPDATE hannah_robots SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")}, config_version = config_version + 1, updated_at = $${names.length + 1} WHERE user_id = $${names.length + 2} AND id = $${names.length + 3}`, [...names.map((name) => fields[name]), now(), userId, row.id]);
      await addEvent(db, userId, row.id, { type: "configured", message: `Changed: ${names.map((name) => (name === "safety" ? "limits" : name)).join(", ")}.` });
    }
    return getRobot(db, userId, row.id);
  }
  /** End a robot's access now. Its missions can no longer be reported, so unfinished ones become "lost". */
  async function revokeRobot(db, userId, id) {
    const row = await robotRow(db, userId, id);
    if (!row) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    const at = now();
    await db.query("UPDATE hannah_robots SET status = 'revoked', key_id = NULL, wrapped_key = NULL, ciphertext = NULL, enroll_hash = NULL, enroll_expires_at = NULL, revoked_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, userId, row.id]);
    await db.query("UPDATE hannah_robot_missions SET status = 'cancelled', error = $1, finished_at = $2, updated_at = $2 WHERE user_id = $3 AND robot_id = $4 AND status = 'queued'", ["Cancelled: the robot's credentials were revoked before the command was delivered.", at, userId, row.id]);
    await db.query("UPDATE hannah_robot_missions SET status = 'lost', error = $1, finished_at = $2, updated_at = $2 WHERE user_id = $3 AND robot_id = $4 AND status IN ('sent', 'accepted', 'paused')", ["The robot's credentials were revoked while this was running. It can no longer report; a robot that loses its link to HANNAH stops by itself.", at, userId, row.id]);
    await addEvent(db, userId, row.id, { type: "revoked", severity: "warning", message: "Credentials revoked. The robot can no longer connect." });
    return getRobot(db, userId, row.id);
  }
  async function removeRobot(db, userId, id) {
    const row = await robotRow(db, userId, id);
    if (!row) return false;
    if (row.status === "enrolled") await revokeRobot(db, userId, row.id);
    for (const table of ["hannah_robot_telemetry", "hannah_robot_events", "hannah_robot_missions", "hannah_robot_plans", "hannah_robot_images", "hannah_robot_destinations", "hannah_robot_maintenance"]) await db.query(`DELETE FROM ${table} WHERE user_id = $1 AND robot_id = $2`, [userId, row.id]);
    return (await db.query("DELETE FROM hannah_robots WHERE user_id = $1 AND id = $2", [userId, row.id])).rowCount > 0;
  }

  // ---------- the robot itself ----------
  /** Exchange a one-time code for the robot's secret. Not an account request: the code is the proof. */
  async function enroll(db, { code, descriptor } = {}) {
    const hash = codeHash(code);
    const row = (await db.query("SELECT * FROM hannah_robots WHERE enroll_hash = $1", [hash])).rows[0];
    const at = now();
    if (!row || !row.enroll_expires_at || Number(row.enroll_expires_at) <= at) throw fail(403, "That enrollment code isn't valid or has expired. Create a new one under Robots.", "bad-code");
    if (!vaultConfigured()) throw fail(503, "This server has no key vault to store a robot's secret in.", "vault-unconfigured");
    const described = normalizeDescriptor(descriptor);
    const declaredSimulated = Boolean(Number(row.simulated));
    if (Boolean(described.simulation) !== declaredSimulated) {
      await addEvent(db, row.user_id, row.id, { type: "enrollment-refused", severity: "warning", message: declaredSimulated ? "A runtime driving physical hardware tried to enroll as this simulated robot." : "A simulator tried to enroll as this physical robot." });
      throw fail(409, declaredSimulated ? "This record was created for a simulated robot, and this runtime drives physical hardware. Create a physical robot record instead." : "This record was created for a physical robot, and this runtime is a simulator. Create a simulated robot record instead.", "kind-mismatch");
    }
    if (!described.capabilities.length) throw fail(400, "The robot offered no capability HANNAH can use.", "no-capabilities");
    const secret = crypto.randomBytes(32).toString("base64url");
    const sealed = encryptSecret(secret, { userId: row.user_id, providerId: `robot:${row.id}` });
    described.profile.fingerprint = fingerprintOf(secret);
    const won = await db.query(
      `UPDATE hannah_robots SET status = 'enrolled', profile = $1, capabilities = $2, safety = $3, simulator = $4, key_id = $5, wrapped_key = $6, ciphertext = $7,
         enroll_hash = NULL, enroll_expires_at = NULL, counter = 0, enrolled_at = $8, updated_at = $8, revoked_at = NULL, state = NULL, mode = NULL, last_seen_at = NULL, commissioning = NULL
       WHERE id = $9 AND enroll_hash = $10`,
      [JSON.stringify(described.profile), JSON.stringify(described.capabilities), JSON.stringify({ ...parse(row.safety, {}), reported: described.reported, reportedAt: at }), described.simulation?.kind || null, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, at, row.id, hash],
    );
    if (!won.rowCount) throw fail(403, "That enrollment code was just used.", "bad-code");
    await addEvent(db, row.user_id, row.id, { type: "enrolled", message: `Enrolled: ${described.profile.manufacturer || "unknown maker"} ${described.profile.model || ""} (${described.simulation ? `simulation: ${described.simulation.kind}` : "physical"}), ${described.capabilities.length} capabilities${described.profile.refusedCapabilities.length ? `, ${described.profile.refusedCapabilities.length} refused` : ""}.` });
    return { robotId: row.id, name: row.name, secret, fingerprint: described.profile.fingerprint, serverTime: at, intervalMs: SYNC_INTERVAL_MS, capabilities: described.capabilities, refused: described.profile.refusedCapabilities };
  }

  /** Is this request really from that robot, now, and not a copy of an earlier one? Returns its row. */
  async function authenticate(db, { robotId, time, counter, signature, method, path, body }) {
    const refused = (reason) => fail(401, "The robot's request wasn't accepted.", reason);
    const id = String(robotId || "");
    if (!/^rb_[0-9a-f]{18}$/.test(id) || !/^[0-9a-f]{64}$/.test(String(signature || ""))) throw refused("bad-signature");
    const row = (await db.query("SELECT * FROM hannah_robots WHERE id = $1", [id])).rows[0];
    if (!row || row.status !== "enrolled" || !row.ciphertext) throw refused(row?.status === "revoked" ? "revoked" : "bad-signature");
    let secret;
    try { secret = decryptSecret(row, { userId: row.user_id, providerId: `robot:${row.id}` }).secret; } catch { throw fail(503, "The server can't read this robot's key.", "vault-key-missing"); }
    const stamp = Number(time);
    const count = Number(counter);
    if (!sameHex(signRequest(secret, { robotId: id, time: String(time), counter: String(counter), method, path, body }), signature)) throw refused("bad-signature");
    // Only the robot gets this far, so these two answers tell nobody else anything.
    if (!Number.isFinite(stamp) || Math.abs(now() - stamp) > SKEW_MS) throw fail(401, "The robot's clock is more than a minute away from the server's. Set the robot's clock.", "clock-skew");
    if (!Number.isSafeInteger(count) || count <= 0) throw refused("replayed");
    const advanced = await db.query("UPDATE hannah_robots SET counter = $1 WHERE id = $2 AND counter < $1 AND status = 'enrolled'", [count, id]);
    if (!advanced.rowCount) throw refused("replayed");
    return { row, secret };
  }

  /**
   * The signed mission. Its limits are every limit in force (the robot's own,
   * tightened by the owner's), so the robot can apply them: before, only the
   * two speeds went, and an owner's lower acceleration, joint speed or link
   * timeout was shown but never applied. In the commissioning trial the robot
   * also gets the trial's caps, not just a lower requested speed.
   */
  function commandFor(row, robotLimits, commissioned = null) {
    const params = parse(row.params, {});
    const limits = {};
    for (const name of ["maxLinearSpeed", "maxAngularSpeed", "maxLinearAccel", "maxJointSpeed", "linkTimeoutS"]) {
      if (finite(robotLimits[name])) limits[name] = robotLimits[name];
    }
    if (commissioned?.status === "trial") {
      if (finite(commissioned.trialSpeed)) limits.maxLinearSpeed = finite(limits.maxLinearSpeed) ? Math.min(limits.maxLinearSpeed, commissioned.trialSpeed) : commissioned.trialSpeed;
      limits.maxJointSpeed = finite(limits.maxJointSpeed) ? Math.min(limits.maxJointSpeed, TRIAL_JOINT_SPEED) : TRIAL_JOINT_SPEED;
    }
    return JSON.stringify({
      v: 1, type: "mission", robotId: row.robot_id, missionId: row.id, seq: Number(row.seq), nonce: row.nonce, capability: row.capability, params,
      issuedAt: Number(row.issued_at), expiresAt: Number(row.expires_at), timeoutS: Math.round((Number(row.deadline_at) - Number(row.expires_at)) / 1000),
      limits,
    });
  }

  /** Did what the robot reports match what the mission asked for? */
  function verifyMission(mission, report, state, robot) {
    const params = parse(mission.params, {});
    const pose = state?.pose;
    const speed = Math.abs(Number(state?.velocity?.linear) || 0);
    const turning = Math.abs(Number(state?.velocity?.angular) || 0);
    const still = speed <= 0.03 && turning <= 0.08;
    const source = pose?.source ? ` (${pose.source})` : "";
    if (mission.capability === "navigate_to" || mission.capability === "return_to_dock") {
      if (!finite(pose?.x) || !finite(pose?.y)) return { confirmed: false, evidence: "The robot reported success but sent no position to check it against." };
      const tolerance = (params.tolerance ?? 0.25) + 0.03;
      const distance = Math.hypot(pose.x - params.x, pose.y - params.y);
      const truth = robot.simulated ? state?.sim?.truth : null;
      const truthDistance = finite(truth?.x) && finite(truth?.y) ? Math.hypot(truth.x - params.x, truth.y - params.y) : null;
      const where = `The robot's localization${source} reports (${round(pose.x)}, ${round(pose.y)}), ${round(distance)} m from the goal (${round(params.x)}, ${round(params.y)})`;
      if (distance > tolerance) return { confirmed: false, evidence: `${where}: further than the ${round(tolerance - 0.03)} m allowed.` };
      if (!still) return { confirmed: false, evidence: `${where}, but it is still moving at ${round(speed)} m/s.` };
      if (truthDistance !== null && truthDistance > tolerance + 0.15) return { confirmed: false, evidence: `${where}, but the simulator's ground truth is ${round(truthDistance)} m from the goal: the robot's position estimate has drifted.` };
      return { confirmed: true, evidence: `${where}, standing still.${truthDistance !== null ? ` Simulator ground truth: ${round(truthDistance)} m from the goal.` : ""}` };
    }
    if (mission.capability === "stop_motion") {
      return still ? { confirmed: true, evidence: `The robot's measured speed is ${round(speed)} m/s and it reports ${state?.mode || "no mode"}.` } : { confirmed: false, evidence: `The robot reported it stopped, but its measured speed is ${round(speed)} m/s.` };
    }
    if (mission.capability === "inspect_area") {
      const visited = Array.isArray(report.result?.visited) ? report.result.visited : [];
      const wanted = params.waypoints || [];
      const tolerance = (params.tolerance ?? 0.3) + 0.03;
      const missed = wanted.findIndex((point, index) => !(visited[index]?.reached === true && finite(visited[index]?.pose?.x) && Math.hypot(visited[index].pose.x - point.x, visited[index].pose.y - point.y) <= tolerance));
      return missed === -1 && still ? { confirmed: true, evidence: `All ${wanted.length} points were reached within ${round(tolerance - 0.03)} m, by the robot's reported position at each.` } : { confirmed: false, evidence: missed === -1 ? "Every point was reached but the robot is still moving." : `Point ${missed + 1} wasn't reached within ${round(tolerance - 0.03)} m.` };
    }
    if (mission.capability === "move_robot_arm") {
      if (!finite(pose?.x) || !finite(pose?.y)) return { confirmed: false, evidence: "The robot reported success but sent no tool position to check it against." };
      const distance = Math.hypot(pose.x - params.x, pose.y - params.y);
      const where = `The tool position from the measured joint angles${source} is (${round(pose.x, 3)}, ${round(pose.y, 3)}), ${round(distance * 100, 1)} cm from the target (${round(params.x, 3)}, ${round(params.y, 3)})`;
      if (distance > 0.02) return { confirmed: false, evidence: `${where}: further than the 2 cm allowed.` };
      return turning <= 0.02 ? { confirmed: true, evidence: `${where}, joints still.` } : { confirmed: false, evidence: `${where}, but the joints are still moving.` };
    }
    if (mission.capability === "grasp_object") {
      const holding = state?.gripper?.holding ?? null;
      return holding === params.object ? { confirmed: true, evidence: `The gripper reports it is holding ${holding}.` } : { confirmed: false, evidence: `The robot reported a grasp, but its gripper reports ${holding ? `holding ${holding}` : "holding nothing"}.` };
    }
    if (mission.capability === "release_object") {
      const gripper = state?.gripper;
      return gripper && gripper.open === true && !gripper.holding ? { confirmed: true, evidence: "The gripper reports open and holding nothing." } : { confirmed: false, evidence: `The robot reported a release, but its gripper reports ${gripper?.holding ? `holding ${gripper.holding}` : gripper?.open === false ? "closed" : "nothing"}.` };
    }
    if (mission.capability === "capture_image") {
      const image = report.image;
      if (!image) return { confirmed: false, evidence: report.imageProblem || "The robot reported a picture, but no valid image arrived with the report. Nothing was stored." };
      const when = new Date(image.capturedAt).toISOString().slice(11, 19);
      const found = Array.isArray(report.result?.detections) ? report.result.detections.length : 0;
      return { confirmed: true, evidence: `A ${image.width}×${image.height} image from the ${image.sensor} (frame ${image.frame}, taken ${when} UTC, ${robot.simulated ? "simulated camera" : "physical camera"}) arrived and is stored as ${image.id} until ${new Date(image.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC. The detector found ${found} coloured region${found === 1 ? "" : "s"}.` };
    }
    if (mission.capability === "set_supported_device_state") {
      const actual = state?.devices?.[params.device];
      return actual === params.state ? { confirmed: true, evidence: `The robot's state report shows ${params.device} ${actual}.` } : { confirmed: false, evidence: `The robot's state report shows ${params.device} ${actual ?? "unknown"}, not ${params.state}.` };
    }
    return { confirmed: false, evidence: "This capability has no check defined." };
  }

  async function applyReport(db, robot, report, state, at) {
    const id = String(report?.missionId || "");
    const row = (await db.query("SELECT * FROM hannah_robot_missions WHERE user_id = $1 AND id = $2 AND robot_id = $3", [robot.userId, id, robot.id])).rows[0];
    if (!row || FINAL.has(row.status)) return;
    const set = async (fields, from) => {
      const names = Object.keys(fields);
      const marks = from.map((_, index) => `$${names.length + 4 + index}`).join(", ");
      return (await db.query(`UPDATE hannah_robot_missions SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")}, updated_at = $${names.length + 1} WHERE user_id = $${names.length + 2} AND id = $${names.length + 3} AND status IN (${marks})`, [...names.map((name) => fields[name]), at, robot.userId, id, ...from])).rowCount > 0;
    };
    const reason = clean(report.reason, 400);
    const result = report.result && typeof report.result === "object" ? JSON.stringify(tidy(report.result)).slice(0, 12_000) : null;
    const ended = async () => {
      const mission = publicMission((await db.query("SELECT * FROM hannah_robot_missions WHERE user_id = $1 AND id = $2", [robot.userId, id])).rows[0], at);
      if (mission?.final && mission.capability !== "stop_motion") announce(robot.userId, "robot.mission.finished", { robotId: robot.id, robot: robot.name, kind: robot.simulated ? "simulation" : "physical", missionId: mission.id, planId: mission.planId, capability: mission.capability, status: mission.status, verified: mission.verification?.confirmed === true, evidence: mission.verification?.evidence || null, error: mission.error });
    };
    switch (report.status) {
      case "accepted":
        await set({ status: "accepted", accepted_at: at }, ["queued", "sent"]);
        break;
      case "rejected":
        if (await set({ status: "rejected", error: reason || "The robot's own checks refused the command.", finished_at: at }, ["queued", "sent"])) { await addEvent(db, robot.userId, robot.id, { type: "command-rejected", severity: "warning", message: `The robot refused ${row.capability}: ${reason || "no reason given"}.`, source: "robot", at }); await ended(); }
        break;
      case "progress":
        if (report.progress && typeof report.progress === "object") await set({ progress: JSON.stringify(tidy(report.progress)).slice(0, 4000) }, ["accepted"]);
        break;
      case "paused":
        await set({ status: "paused", paused_at: at, pause_requested_at: null }, ["accepted"]);
        break;
      case "resumed":
        // The time it stood paused doesn't count against the mission's time limit.
        await set({ status: "accepted", resume_requested_at: null, control_nonce: null, paused_at: null, deadline_at: Number(row.deadline_at) + Math.max(0, at - Number(row.paused_at || at)) }, ["paused"]);
        break;
      case "resume-refused":
        if (await set({ resume_requested_at: null, control_nonce: null, error: reason || "The robot refused to resume." }, ["paused"])) await addEvent(db, robot.userId, robot.id, { type: "resume-refused", severity: "warning", message: `The robot refused to resume ${row.capability}: ${reason || "no reason given"}.`, source: "robot", at });
        break;
      case "succeeded": {
        if (row.capability === "capture_image") report.image = await storeImage(db, robot, row, report, at).catch(() => null);
        const stored = report.image ? JSON.stringify({ ...tidy(report.result || {}), imageId: report.image.id, expiresAt: report.image.expiresAt }).slice(0, 12_000) : result;
        const verification = verifyMission(row, report, state, robot);
        if (report.image) { if (await set({ status: verification.confirmed ? "succeeded" : "unverified", accepted_at: row.accepted_at || at, result: stored, verification: JSON.stringify({ ...verification, checkedAt: at }), finished_at: at }, ["queued", "sent", "accepted"])) await ended(); break; }
        if (await set({ status: verification.confirmed ? "succeeded" : "unverified", accepted_at: row.accepted_at || at, result, verification: JSON.stringify({ ...verification, checkedAt: at }), finished_at: at }, ["queued", "sent", "accepted"])) await ended();
        break;
      }
      case "failed": case "cancelled": case "timed-out":
        if (await set({ status: report.status, error: reason || (report.status === "cancelled" ? "Cancelled." : report.status === "timed-out" ? "The mission ran out of time; the robot stopped." : "The robot reported a failure."), result, finished_at: at }, ["queued", "sent", "accepted", "paused"])) await ended();
        break;
      default:
    }
  }

  /** One exchange with a robot: take its state and reports, hand back its signed commands. */
  async function sync(db, { row, secret }, body = {}) {
    const at = now();
    const robot = { ...view(row, at), userId: row.user_id };
    const fields = { last_seen_at: at };
    if (body.descriptor) {
      const described = normalizeDescriptor(body.descriptor);
      if (Boolean(described.simulation) !== robot.simulated) throw fail(409, "A robot can't change between simulated and physical. Enroll it again as a new robot.", "kind-mismatch");
      const before = parse(row.profile, {});
      described.profile.fingerprint = before.fingerprint;
      fields.profile = JSON.stringify(described.profile);
      fields.capabilities = JSON.stringify(described.capabilities);
      fields.safety = JSON.stringify({ ...robot.safety, reported: described.reported, reportedAt: at });
      fields.simulator = described.simulation?.kind || null;
      // What it was commissioned as has changed: the checks were made against something else.
      if (!robot.simulated && row.commissioning && commissioning.signature(before, robot.safety.reported || {}, robot.capabilities) !== commissioning.signature(described.profile, described.reported, described.capabilities)) {
        fields.commissioning = JSON.stringify({ steps: {}, resetReason: "The robot now reports different sensors, actuators, capabilities or limits than it was commissioned with." });
        await addEvent(db, row.user_id, row.id, { type: "commissioning-reset", severity: "warning", message: "The robot's reported hardware or limits changed. It has to be commissioned again before it may move." });
      }
    }
    const state = cleanState(body.state, at);
    if (state) { fields.state = JSON.stringify(state); fields.mode = state.mode; }
    for (const event of Array.isArray(body.events) ? body.events.slice(0, 20) : []) {
      await addEvent(db, row.user_id, row.id, { type: event?.type, severity: event?.severity, message: event?.message, source: "robot", at: finite(event?.at) && Math.abs(at - event.at) < 86_400_000 ? Math.round(event.at) : at });
      if (ALERTS.has(String(event?.type))) announce(row.user_id, "robot.alert", { robotId: row.id, robot: row.name, kind: robot.simulated ? "simulation" : "physical", type: String(event.type), severity: clean(event?.severity, 20) || "warning", message: clean(event?.message, 300), source: "robot" });
    }
    for (const report of Array.isArray(body.reports) ? body.reports.slice(0, 40) : []) await applyReport(db, robot, report || {}, state, at);
    const names = Object.keys(fields);
    await db.query(`UPDATE hannah_robots SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")}, updated_at = $${names.length + 1} WHERE id = $${names.length + 2}`, [...names.map((name) => fields[name]), at, row.id]);

    if (state && finite(state.pose?.x) && at - (lastSample.get(row.id) || 0) >= TELEMETRY_EVERY_MS) {
      lastSample.set(row.id, at);
      const sample = { x: state.pose.x, y: state.pose.y, yaw: state.pose.yaw ?? null, v: state.velocity?.linear ?? null, w: state.velocity?.angular ?? null, battery: state.battery?.percent ?? null, mode: state.mode, estop: Boolean(state.estop?.engaged) };
      await db.query("INSERT INTO hannah_robot_telemetry (robot_id, at, user_id, sample) VALUES ($1, $2, $3, $4)", [row.id, at, row.user_id, JSON.stringify(sample)]).catch(() => {});
      if ((housekeeping += 1) % 100 === 0) {
        await db.query("DELETE FROM hannah_robot_telemetry WHERE robot_id = $1 AND at < $2", [row.id, at - TELEMETRY_KEEP_MS]).catch(() => {});
        await db.query("DELETE FROM hannah_robot_events WHERE robot_id = $1 AND at < $2", [row.id, at - EVENTS_KEEP_MS]).catch(() => {});
        await db.query("DELETE FROM hannah_robot_missions WHERE robot_id = $1 AND created_at < $2", [row.id, at - MISSIONS_KEEP_MS]).catch(() => {});
      }
    }

    // What the robot should hear: missions not yet accepted and still valid, and cancellations.
    await advancePlans(db, row.user_id, row.id, at).catch((error) => addEvent(db, row.user_id, row.id, { type: "plan-error", severity: "warning", message: `A plan could not be advanced: ${clean(error?.message, 200)}` }).catch(() => {}));
    await db.query("UPDATE hannah_robot_missions SET status = 'expired', finished_at = $1, updated_at = $1 WHERE robot_id = $2 AND status IN ('queued', 'sent') AND expires_at <= $1", [at, row.id]);
    const open = (await db.query("SELECT * FROM hannah_robot_missions WHERE robot_id = $1 AND status IN ('queued', 'sent', 'accepted', 'paused') ORDER BY seq", [row.id])).rows;
    const commands = [];
    const signed = (command) => { const payload = JSON.stringify({ v: 1, robotId: row.id, ...command }); commands.push({ payload, sig: signCommand(secret, payload) }); };
    for (const mission of open) {
      if (mission.cancel_requested_at && mission.status !== "queued") {
        signed({ type: "cancel", missionId: mission.id, issuedAt: Number(mission.cancel_requested_at) });
        continue;
      }
      if (mission.status === "accepted" && mission.pause_requested_at) { signed({ type: "pause", missionId: mission.id, issuedAt: Number(mission.pause_requested_at) }); continue; }
      if (mission.status === "paused") {
        const asked = mission.resume_requested_at ? Number(mission.resume_requested_at) : null;
        // A resume starts motion again, so unlike a pause it expires and can be used once.
        if (asked && at - asked < RESUME_TTL_MS) signed({ type: "resume", missionId: mission.id, nonce: mission.control_nonce, issuedAt: asked, expiresAt: asked + RESUME_TTL_MS });
        else if (asked) await db.query("UPDATE hannah_robot_missions SET resume_requested_at = NULL, control_nonce = NULL, error = $1, updated_at = $2 WHERE robot_id = $3 AND id = $4 AND status = 'paused'", ["The robot didn't take the resume in time. It is still paused.", at, row.id, mission.id]);
        continue;
      }
      if (mission.status === "accepted") continue;
      if (mission.status === "queued") {
        const delivered = await db.query("UPDATE hannah_robot_missions SET status = 'sent', sent_at = $1, updated_at = $1 WHERE robot_id = $2 AND id = $3 AND status = 'queued'", [at, row.id, mission.id]);
        if (!delivered.rowCount) continue; // cancelled a moment ago
      }
      const payload = commandFor(mission, robot.limits, robot.commissioning);
      commands.push({ payload, sig: signCommand(secret, payload) });
    }
    return { serverTime: at, intervalMs: SYNC_INTERVAL_MS, commands };
  }

  // ---------- missions (the Action Engine calls these) ----------
  let lastSeq = 0;
  function nextSeq() {
    // Only ever goes up, across restarts and server instances: milliseconds, then a counter.
    lastSeq = Math.max(lastSeq + 1, now() * 1000);
    return lastSeq;
  }
  async function activeMotion(db, userId, robotId) {
    const at = now();
    const { rows } = await db.query("SELECT * FROM hannah_robot_missions WHERE user_id = $1 AND robot_id = $2 AND status IN ('queued', 'sent', 'accepted', 'paused') ORDER BY seq", [userId, robotId]);
    const live = rows.filter((row) => !FINAL.has(effectiveMissionStatus(row, at)) && contract.capability(row.capability)?.motion);
    return live[0] ? publicMission(live[0], at) : null;
  }
  /** The Safety Gateway's answer for this robot and command, with the robot's current state. */
  async function assess(db, userId, robotRef, capabilityId, params, { planId = null } = {}) {
    const robot = typeof robotRef === "object" && robotRef ? robotRef : await resolveRobot(db, userId, robotRef);
    const moves = Boolean(contract.capability(capabilityId)?.motion);
    const active = moves ? await activeMotion(db, userId, robot.id) : null;
    const verdict = { robot, ...safety.check({ robot, capabilityId, params, now: now(), active }) };
    // A robot working through a plan is busy for anything else that would move it, also between two steps.
    if (moves && !planId && robot?.id) {
      const running = (await db.query("SELECT id, title FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status = 'running'", [userId, robot.id])).rows[0];
      if (running && !verdict.violations.some((item) => item.code === "precondition:no-active-motion")) {
        verdict.violations.push({ code: "busy-plan", message: `${robot.name} is working through the plan “${running.title}”. Cancel the plan or wait for it to finish.` });
        verdict.ok = false;
      }
    }
    return verdict;
  }
  async function dispatch(db, userId, { robot, capabilityId, params, actionId = null, requestedBy = "", planId = null, id: givenId = null }) {
    const definition = contract.capability(capabilityId);
    const at = now();
    const ttl = Math.round((definition.deescalates ? 15 : robot.limits.commandTtlS) * 1000);
    const timeoutS = Math.min(definition.timeoutS.max, definition.timeoutS.default);
    const id = givenId || `ms_${crypto.randomBytes(9).toString("hex")}`;
    await db.query(
      `INSERT INTO hannah_robot_missions (user_id, id, robot_id, capability, params, status, action_id, requested_by, seq, nonce, issued_at, expires_at, deadline_at, created_at, updated_at, plan_id)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11, $12, $10, $10, $13)`,
      [userId, id, robot.id, definition.id, JSON.stringify(params), actionId, clean(requestedBy, 80), nextSeq(), crypto.randomBytes(16).toString("hex"), at, at + ttl, at + ttl + timeoutS * 1000, planId],
    );
    return getMission(db, userId, id);
  }
  async function getMission(db, userId, id) {
    const row = (await db.query("SELECT * FROM hannah_robot_missions WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "That mission isn't in your history.", "not-found");
    return publicMission(row);
  }
  async function listMissions(db, userId, { robotId, active = false, limit = 30 } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (robotId) { values.push(String(robotId)); where += ` AND robot_id = $${values.length}`; }
    if (active) where += " AND status IN ('queued', 'sent', 'accepted', 'paused')";
    values.push(Math.max(1, Math.min(100, Number(limit) || 30)));
    const { rows } = await db.query(`SELECT * FROM hannah_robot_missions WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    const at = now();
    return rows.map((row) => publicMission(row, at)).filter((mission) => !active || !mission.final);
  }
  /** Wait a short time for a mission to reach a state. Returns it as it is when the wait ends. */
  async function waitFor(db, userId, id, until, ms = ackWaitMs) {
    const end = Date.now() + ms;
    for (;;) {
      const mission = await getMission(db, userId, id);
      if (until(mission) || mission.final || Date.now() >= end) return mission;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  /** Cancel one mission: at once if the robot never got it, otherwise by telling the robot. */
  async function cancelMission(db, userId, id) {
    const mission = await getMission(db, userId, id);
    if (mission.final) return mission;
    const at = now();
    const dropped = await db.query("UPDATE hannah_robot_missions SET status = 'cancelled', error = $1, finished_at = $2, updated_at = $2 WHERE user_id = $3 AND id = $4 AND status = 'queued'", ["Cancelled before it was sent to the robot.", at, userId, mission.id]);
    if (!dropped.rowCount) await db.query("UPDATE hannah_robot_missions SET cancel_requested_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3 AND status IN ('sent', 'accepted', 'paused') AND cancel_requested_at IS NULL", [at, userId, mission.id]);
    return getMission(db, userId, mission.id);
  }
  /** Stop a robot: cancel everything it has and send a stop. Never needs approval. */
  async function stop(db, userId, robotRef, { reason = "", actionId = null, requestedBy = "" } = {}) {
    const robot = typeof robotRef === "object" && robotRef ? robotRef : await resolveRobot(db, userId, robotRef);
    if (robot.status !== "enrolled") throw fail(409, `${robot.name} isn't enrolled, so there is nothing to stop.`, "not-enrolled");
    // A stop ends the robot's plan and drops every plan waiting behind it, so nothing starts again by itself.
    for (const row of (await db.query(`SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status IN ${PLAN_OPEN}`, [userId, robot.id])).rows) {
      await endPlan(db, row, "cancelled", row.status === "running" ? "The robot was stopped." : "The robot was stopped before this plan started.", now());
    }
    for (const mission of await listMissions(db, userId, { robotId: robot.id, active: true, limit: 100 })) {
      if (mission.capability !== "stop_motion") await cancelMission(db, userId, mission.id);
    }
    const mission = await dispatch(db, userId, { robot, capabilityId: "stop_motion", params: reason ? { reason: clean(reason, 200) } : {}, actionId, requestedBy });
    await addEvent(db, userId, robot.id, { type: "stop-requested", severity: "warning", message: `Stop requested${reason ? `: ${clean(reason, 160)}` : ""}.` });
    return mission;
  }
  /** The account's emergency stop reaches every robot that could be moving. */
  async function stopAll(db, userId, reason = "The account's emergency stop was pressed.") {
    let stopped = 0;
    for (const robot of await listRobots(db, userId)) {
      if (robot.status !== "enrolled") continue;
      const busy = (await listMissions(db, userId, { robotId: robot.id, active: true, limit: 5 })).length > 0;
      if (!busy && !robot.online) continue;
      await stop(db, userId, robot, { reason, requestedBy: "emergency stop" }).catch(() => {});
      stopped += 1;
    }
    return stopped;
  }

  /** Ask the robot to pause a running mission: it holds where it is and keeps the mission. Never needs approval. */
  async function pauseMission(db, userId, id) {
    const mission = await getMission(db, userId, id);
    if (mission.status === "paused") return mission;
    if (mission.status !== "accepted") throw fail(409, mission.final ? "That mission is already over." : "That mission hasn't started yet; cancel it instead.", "not-running");
    await db.query("UPDATE hannah_robot_missions SET pause_requested_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'accepted' AND pause_requested_at IS NULL", [now(), userId, mission.id]);
    return getMission(db, userId, mission.id);
  }
  /** Ask the robot to carry on with a paused mission. This starts motion, so the caller has been through permission and the Safety Gateway. */
  async function resumeMission(db, userId, id) {
    const mission = await getMission(db, userId, id);
    if (mission.status !== "paused") throw fail(409, mission.final ? "That mission is already over." : "That mission isn't paused.", "not-paused");
    await db.query("UPDATE hannah_robot_missions SET resume_requested_at = $1, control_nonce = $2, error = NULL, updated_at = $1 WHERE user_id = $3 AND id = $4 AND status = 'paused'", [now(), crypto.randomBytes(16).toString("hex"), userId, mission.id]);
    return getMission(db, userId, mission.id);
  }

  // ---------- camera images: kept for a limited time, every viewing logged ----------
  const imageView = (row) => ({ id: row.id, robotId: row.robot_id, missionId: row.mission_id || null, at: Number(row.at), bytes: Number(row.bytes), expiresAt: Number(row.expires_at), ...parse(row.meta, {}), detections: parse(row.detections, []) });
  /** Keep the image a capture reported, if it is what it says it is. Returns its record, or null. */
  async function storeImage(db, robot, mission, report, at) {
    const sent = report.attachment;
    if (!sent || sent.kind !== "image" || sent.encoding !== "png" || typeof sent.data !== "string" || sent.data.length > IMAGE_MAX_BYTES * 1.4) return null;
    const bytes = Buffer.from(sent.data, "base64");
    // A PNG, of the size it claims, and not larger than a picture from a robot's camera needs to be.
    if (bytes.length < 33 || bytes.length > IMAGE_MAX_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (width !== sent.width || height !== sent.height || width > 4096 || height > 4096) return null;
    if (!robot.camera?.cameras?.includes(sent.sensor) || !finite(sent.capturedAt)) return null;
    // A picture from before it was asked for is not the picture that was asked for.
    if (sent.capturedAt < Number(mission.issued_at) - SKEW_MS) { report.imageProblem = `The image that arrived was taken at ${new Date(sent.capturedAt).toISOString().slice(11, 19)} UTC, before this picture was asked for. It was not stored.`; return null; }
    // Switched off while the command was on its way: the picture is not kept.
    if (!robot.camera.enabled) return null;
    const id = `im_${crypto.randomBytes(9).toString("hex")}`;
    const meta = { sensor: clean(sent.sensor, 40), frame: finite(sent.frame) ? sent.frame : null, capturedAt: Math.round(sent.capturedAt), width, height, fovDeg: finite(sent.fovDeg) ? sent.fovDeg : null, source: clean(sent.source, 120), depth: sent.depth ? clean(sent.depth, 80) : null, pose: sent.pose && finite(sent.pose.x) && finite(sent.pose.y) ? { x: sent.pose.x, y: sent.pose.y, yaw: finite(sent.pose.yaw) ? sent.pose.yaw : null, frame: clean(sent.pose.frame, 20) || "map" } : null, kind: robot.simulated ? "simulation" : "physical", detector: tidy(report.result?.detector || null) };
    const detections = (Array.isArray(report.result?.detections) ? report.result.detections : []).slice(0, 12).map((item) => tidy(item));
    const expiresAt = at + robot.camera.retentionHours * 3_600_000;
    await db.query("INSERT INTO hannah_robot_images (user_id, id, robot_id, mission_id, at, meta, detections, data, bytes, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [robot.userId, id, robot.id, mission.id, at, JSON.stringify(meta), JSON.stringify(detections).slice(0, 12_000), bytes.toString("base64"), bytes.length, expiresAt]);
    await sweepImages(db, robot.userId, robot.id, at);
    await addEvent(db, robot.userId, robot.id, { type: "image-stored", message: `A picture from the ${meta.sensor} (frame ${meta.frame ?? "?"}) was stored as ${id}. It is deleted after ${robot.camera.retentionHours} hours.`, at });
    return { id, expiresAt, ...meta };
  }
  /** Delete what has expired, and the oldest beyond the number kept per robot. */
  async function sweepImages(db, userId, robotId, at) {
    await db.query("DELETE FROM hannah_robot_images WHERE user_id = $1 AND robot_id = $2 AND expires_at <= $3", [userId, robotId, at]);
    const extra = (await db.query("SELECT id FROM hannah_robot_images WHERE user_id = $1 AND robot_id = $2 ORDER BY at DESC", [userId, robotId])).rows.slice(IMAGES_PER_ROBOT);
    for (const row of extra) await db.query("DELETE FROM hannah_robot_images WHERE user_id = $1 AND id = $2", [userId, row.id]);
  }
  /** A robot's pictures, newest first, without the image data. Reading the list is not logged; opening a picture is. */
  async function listImages(db, userId, robotId, limit = 12) {
    const robot = await getRobot(db, userId, robotId);
    await sweepImages(db, userId, robot.id, now());
    const { rows } = await db.query("SELECT user_id, id, robot_id, mission_id, at, meta, detections, bytes, expires_at FROM hannah_robot_images WHERE user_id = $1 AND robot_id = $2 ORDER BY at DESC LIMIT $3", [userId, robot.id, Math.max(1, Math.min(IMAGES_PER_ROBOT, Number(limit) || 12))]);
    return { camera: robot.camera, images: rows.map(imageView) };
  }
  /** One picture with its data. Every call is written to the robot's events: who opened it and when. */
  async function getImage(db, userId, robotId, imageId, viewer = "a signed-in person") {
    const robot = await getRobot(db, userId, robotId);
    const row = (await db.query("SELECT * FROM hannah_robot_images WHERE user_id = $1 AND robot_id = $2 AND id = $3 AND expires_at > $4", [userId, robot.id, String(imageId || ""), now()])).rows[0];
    if (!row) throw fail(404, "That picture doesn't exist or has been deleted.", "not-found");
    await addEvent(db, userId, robot.id, { type: "image-viewed", message: `Picture ${row.id} was opened by ${clean(viewer, 80)}.` });
    return { ...imageView(row), dataUrl: `data:image/png;base64,${row.data}` };
  }
  async function deleteImage(db, userId, robotId, imageId) {
    const robot = await getRobot(db, userId, robotId);
    const gone = await db.query("DELETE FROM hannah_robot_images WHERE user_id = $1 AND robot_id = $2 AND id = $3", [userId, robot.id, String(imageId || "")]);
    if (!gone.rowCount) throw fail(404, "That picture doesn't exist or has been deleted.", "not-found");
    await addEvent(db, userId, robot.id, { type: "image-deleted", message: `Picture ${clean(imageId, 40)} was deleted by a signed-in person.` });
    return listImages(db, userId, robot.id);
  }

  // ---------- plans: several steps under one approval ----------
  function publicPlan(row) {
    const steps = parse(row.steps, []);
    const plan = {
      id: row.id, robotId: row.robot_id, title: row.title, template: row.template || null, status: row.status, final: plans.FINAL.has(row.status), cursor: Number(row.cursor), priority: Number(row.priority),
      actionId: row.action_id || null, requestedBy: row.requested_by || "", error: row.error || null, startBy: Number(row.start_by), createdAt: Number(row.created_at),
      startedAt: row.started_at ? Number(row.started_at) : null, finishedAt: row.finished_at ? Number(row.finished_at) : null,
      steps: steps.map((step, index) => ({ n: index + 1, capability: step.capability, title: contract.capability(step.capability)?.title || step.capability, text: plans.stepText(step), kind: step.kind, status: step.status, params: step.sent || step.params, missionId: step.missionId || null, startedAt: step.startedAt || null, finishedAt: step.finishedAt || null, output: step.output ?? null, evidence: step.evidence || null, error: step.error || null })),
    };
    return plan;
  }
  /** Close a plan: the step in hand takes the outcome, the steps after it are marked as not run. */
  async function endPlan(db, row, status, error, at, { stepStatus = status === "succeeded" ? "succeeded" : status === "expired" ? "skipped" : status } = {}) {
    const steps = parse(row.steps, []);
    const cursor = Number(row.cursor);
    steps.forEach((step, index) => {
      if (index === cursor && (step.status === "running" || step.status === "pending") && status !== "succeeded") Object.assign(step, { status: step.status === "pending" && status !== "failed" ? "skipped" : stepStatus, error: step.error || error, finishedAt: at });
      else if (index > cursor && step.status === "pending") step.status = "skipped";
    });
    const done = await db.query(`UPDATE hannah_robot_plans SET status = $1, error = $2, steps = $3, finished_at = $4, updated_at = $4 WHERE user_id = $5 AND id = $6 AND status IN ${PLAN_OPEN}`, [status, error ? clean(error, 500) : null, JSON.stringify(steps), at, row.user_id, row.id]);
    if (!done.rowCount) return false;
    announce(row.user_id, "robot.plan.finished", { robotId: row.robot_id, planId: row.id, title: row.title, template: row.template || null, status, error: error ? clean(error, 300) : null, steps: steps.length, stepsSucceeded: steps.filter((step) => step.status === "succeeded").length, stoppedAtStep: status === "succeeded" ? null : Math.min(cursor + 1, steps.length) });
    if (status !== "succeeded") {
      await addEvent(db, row.user_id, row.robot_id, { type: `plan-${status}`, severity: status === "failed" ? "warning" : "info", message: `Plan “${clean(row.title, 80)}” ${status === "expired" ? "never started" : status}: ${clean(error, 300) || "no reason recorded"}`, at }).catch(() => {});
      // Work queued behind a plan that didn't finish is not started: whatever stopped this one hasn't been looked at.
      if (row.status === "running" && status === "failed") {
        for (const queued of (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status = 'queued'", [row.user_id, row.robot_id])).rows) {
          await endPlan(db, queued, "cancelled", `The plan before it (“${clean(row.title, 60)}”) failed, so this one was not started.`, at);
        }
      }
    }
    return true;
  }
  /**
   * Move a robot's plans along. Called in every exchange with that robot, after
   * its reports were applied, so the state used here is seconds old at most.
   * With `mayDispatch` false (a person reading a plan while the robot is away)
   * it only records what is already over; it never starts anything.
   */
  async function advancePlans(db, userId, robotId, at, { mayDispatch = true } = {}) {
    const open = (await db.query(`SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status IN ${PLAN_OPEN} ORDER BY priority DESC, created_at`, [userId, robotId])).rows;
    if (!open.length) return;
    for (const row of open.filter((item) => item.status === "queued" && Number(item.start_by) <= at)) {
      await endPlan(db, row, "expired", "The robot wasn't free in time, so the plan was dropped. Nothing was run.", at);
    }
    let row = open.find((item) => item.status === "running") || null;
    if (!row) {
      if (!mayDispatch) return;
      row = open.find((item) => item.status === "queued" && Number(item.start_by) > at) || null;
      if (!row) return;
      // A queued plan starts only when the robot has nothing else that moves it.
      if (await activeMotion(db, userId, robotId)) return;
      if (!(await db.query("UPDATE hannah_robot_plans SET status = 'running', started_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'queued'", [at, userId, row.id])).rowCount) return;
      row = { ...row, status: "running", started_at: at };
    }
    const steps = parse(row.steps, []);
    let cursor = Number(row.cursor);
    const save = () => db.query("UPDATE hannah_robot_plans SET steps = $1, cursor = $2, updated_at = $3 WHERE user_id = $4 AND id = $5 AND status = 'running'", [JSON.stringify(steps), cursor, at, userId, row.id]);
    for (let guard = 0; guard <= steps.length; guard += 1) {
      const step = steps[cursor];
      if (!step) {
        await save();
        await endPlan(db, { ...row, steps: JSON.stringify(steps), cursor }, "succeeded", null, at);
        return advancePlans(db, userId, robotId, at, { mayDispatch }); // the next one in the queue, if any
      }
      if (step.status === "running" && step.missionId) {
        const mission = await getMission(db, userId, step.missionId).catch(() => null);
        if (mission && !mission.final) return;
        if (mission?.status === "succeeded") {
          Object.assign(step, { status: "succeeded", finishedAt: mission.finishedAt || at, evidence: mission.verification?.evidence || "Verified from the robot's reported state.", output: mission.result ?? null });
          cursor += 1;
          continue;
        }
        const reason = !mission ? "Its mission record is gone." : mission.status === "unverified" ? `The robot reported success, but its state doesn't confirm it. ${mission.verification?.evidence || ""}`.trim() : mission.error || `The step ended as ${mission.status}.`;
        Object.assign(step, { status: mission?.status === "cancelled" ? "cancelled" : "failed", error: reason, finishedAt: at });
        await endPlan(db, { ...row, steps: JSON.stringify(steps), cursor }, mission?.status === "cancelled" ? "cancelled" : "failed", reason, at);
        return;
      }
      if (!mayDispatch) return;
      const robot = await getRobot(db, userId, robotId);
      if (step.kind === "observation") {
        const seen = plans.observe(step, robot, at);
        if (!seen.ok) {
          Object.assign(step, { status: "failed", error: seen.error, finishedAt: at });
          await endPlan(db, { ...row, steps: JSON.stringify(steps), cursor }, "failed", seen.error, at);
          return;
        }
        Object.assign(step, { status: "succeeded", startedAt: at, finishedAt: at, output: tidy(seen.output), evidence: seen.evidence });
        cursor += 1;
        continue;
      }
      // A step that moves the robot: the Safety Gateway again, against the robot as it is now.
      const verdict = await assess(db, userId, robot, step.capability, step.params, { planId: row.id });
      if (!verdict.ok) {
        const reason = `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`;
        Object.assign(step, { status: "failed", error: reason, finishedAt: at });
        await endPlan(db, { ...row, steps: JSON.stringify(steps), cursor }, "failed", reason, at);
        return;
      }
      const missionId = `ms_${crypto.randomBytes(9).toString("hex")}`;
      Object.assign(step, { status: "running", missionId, startedAt: at, sent: verdict.params });
      // The plan records the step first; only the exchange that wins this write sends the command.
      if (!(await save()).rowCount) return;
      await dispatch(db, userId, { robot, capabilityId: step.capability, params: verdict.params, actionId: row.action_id, requestedBy: row.requested_by || "", planId: row.id, id: missionId });
      return;
    }
  }
  /** Check every step of a plan against the robot as it is now. The first step must be ready; later ones may depend on earlier ones. */
  async function assessPlan(db, userId, robotRef, steps) {
    const robot = typeof robotRef === "object" && robotRef ? robotRef : await resolveRobot(db, userId, robotRef);
    const violations = [];
    const warnings = new Set();
    const flags = new Set();
    const checked = [];
    let risk = "none";
    const order = ["none", "low", "moderate", "high", "critical"];
    // Plans are for simulated robots until there is evidence from supervised hardware runs: a physical robot's every movement is approved by itself.
    const moving = steps.filter((step) => contract.capability(step.capability)?.motion);
    if (!robot.simulated && moving.length) violations.push({ code: "physical-plan", message: `${robot.name} is a physical robot. Each of its movements has to be approved by itself; plans of several steps run on simulated robots only.` });
    for (const [index, step] of steps.entries()) {
      // A busy robot doesn't refuse a plan: the plan waits its turn. Everything else is checked now.
      const verdict = safety.check({ robot, capabilityId: step.capability, params: step.params, now: now(), active: null });
      for (const item of verdict.violations) {
        if (index > 0 && plans.DEPENDS_ON_EARLIER.has(item.code)) continue;
        violations.push({ code: item.code, message: `Step ${index + 1} (${plans.stepText(step)}): ${item.message}` });
      }
      verdict.warnings.forEach((item) => warnings.add(item));
      verdict.flags.forEach((item) => flags.add(item));
      if (order.indexOf(verdict.risk) > order.indexOf(risk)) risk = verdict.risk;
      checked.push({ ...step, kind: plans.stepKind(step.capability), sent: verdict.params, risk: verdict.risk });
    }
    // An arm or a gripper always asks, in simulation too; a plan that contains one asks as a whole.
    if (risk === "high" || risk === "critical") flags.add("this plan moves an arm or a gripper");
    const waiting = (await db.query("SELECT COUNT(*) AS n FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status = 'queued'", [userId, robot.id])).rows[0];
    if (Number(waiting?.n || 0) >= plans.MAX_QUEUED) violations.push({ code: "queue-full", message: `${robot.name} already has ${plans.MAX_QUEUED} plans waiting. Cancel one or wait.` });
    const busyWith = moving.length ? (await activeMotion(db, userId, robot.id))?.title || (await db.query("SELECT title FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status = 'running'", [userId, robot.id])).rows[0]?.title || null : null;
    return { robot, ok: violations.length === 0, violations, warnings: [...warnings], flags: [...flags], risk, steps: checked, waitsFor: busyWith };
  }
  async function createPlan(db, userId, { robot, title, template = null, steps, priority = 3, startWithinMin = plans.START_WITHIN_MIN.default, actionId = null, requestedBy = "" }) {
    const at = now();
    const id = `pl_${crypto.randomBytes(9).toString("hex")}`;
    const within = Math.max(1, Math.min(plans.START_WITHIN_MIN.max, Number(startWithinMin) || plans.START_WITHIN_MIN.default));
    const stored = steps.map((step) => ({ capability: step.capability, params: step.params, kind: plans.stepKind(step.capability), status: "pending" }));
    await db.query(
      `INSERT INTO hannah_robot_plans (user_id, id, robot_id, title, template, steps, status, cursor, priority, action_id, requested_by, start_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', 0, $7, $8, $9, $10, $11, $11)`,
      [userId, id, robot.id, clean(title, 120) || "Plan", template, JSON.stringify(stored), Math.max(1, Math.min(5, Math.round(Number(priority) || 3))), actionId, clean(requestedBy, 80), at + within * 60_000, at],
    );
    return getPlan(db, userId, id);
  }
  async function getPlan(db, userId, id) {
    let row = (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "That plan isn't in your history.", "not-found");
    if (!plans.FINAL.has(row.status)) {
      // Record what is already over (a step whose robot went away, a start that came too late). Starts nothing.
      await advancePlans(db, userId, row.robot_id, now(), { mayDispatch: false });
      row = (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND id = $2", [userId, row.id])).rows[0];
    }
    return publicPlan(row);
  }
  async function listPlans(db, userId, { robotId, active = false, limit = 20 } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (robotId) { values.push(String(robotId)); where += ` AND robot_id = $${values.length}`; }
    if (active) where += ` AND status IN ${PLAN_OPEN}`;
    values.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const { rows } = await db.query(`SELECT * FROM hannah_robot_plans WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    const stale = new Set(rows.filter((row) => !plans.FINAL.has(row.status)).map((row) => row.robot_id));
    if (!stale.size) return rows.map(publicPlan);
    for (const id of stale) await advancePlans(db, userId, id, now(), { mayDispatch: false });
    return (await db.query(`SELECT * FROM hannah_robot_plans WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values)).rows.map(publicPlan);
  }
  /** Cancel a plan: one that is waiting is dropped; one that is running has its current step cancelled on the robot. Never needs approval. */
  async function cancelPlan(db, userId, id) {
    const plan = await getPlan(db, userId, id);
    if (plan.final) return plan;
    const row = (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND id = $2", [userId, plan.id])).rows[0];
    const current = plan.steps[plan.cursor];
    await endPlan(db, row, "cancelled", plan.status === "queued" ? "Cancelled before it started." : "Cancelled.", now());
    if (current?.missionId) await cancelMission(db, userId, current.missionId);
    return getPlan(db, userId, plan.id);
  }
  async function waitForPlan(db, userId, id, until, ms = ackWaitMs) {
    const end = Date.now() + ms;
    for (;;) {
      const plan = await getPlan(db, userId, id);
      if (until(plan) || plan.final || Date.now() >= end) return plan;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // ---------- commissioning (physical robots) ----------
  async function commissioningContext(db, userId, robot) {
    return { events: await events(db, userId, { robotId: robot.id, limit: 200 }), missions: await listMissions(db, userId, { robotId: robot.id, limit: 50 }) };
  }
  async function commissioningView(db, userId, id) {
    const robot = await getRobot(db, userId, id);
    return commissioning.view(robot, robot.commissioningRecord, await commissioningContext(db, userId, robot));
  }
  async function confirmCommissioning(db, userId, id, stepId, { note, attest } = {}) {
    const robot = await getRobot(db, userId, id);
    if (robot.status !== "enrolled") throw fail(409, `${robot.name} isn't enrolled.`, "not-enrolled");
    const record = commissioning.confirm(robot, robot.commissioningRecord, stepId, { note, attest, now: now(), ...(await commissioningContext(db, userId, robot)) });
    await db.query("UPDATE hannah_robots SET commissioning = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(record), now(), userId, robot.id]);
    const step = commissioning.STEPS.find((item) => item.id === stepId);
    await addEvent(db, userId, robot.id, { type: stepId === "approval" ? "commissioned" : "commissioning-step", message: stepId === "approval" ? "Approved for operation. Each movement still needs approval." : `Commissioning: “${step.title}” confirmed.` });
    return commissioningView(db, userId, robot.id);
  }
  async function resetCommissioning(db, userId, id, reason = "") {
    const robot = await getRobot(db, userId, id);
    await db.query("UPDATE hannah_robots SET commissioning = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify({ steps: {}, resetReason: clean(reason, 200) || "Withdrawn by you." }), now(), userId, robot.id]);
    await addEvent(db, userId, robot.id, { type: "commissioning-reset", severity: "warning", message: `Commissioning withdrawn${reason ? `: ${clean(reason, 160)}` : ""}. The robot may not move until it is commissioned again.` });
    return commissioningView(db, userId, robot.id);
  }

  // ---------- destinations ----------
  /** The destinations a robot can be sent to by name, what its runtime reported, and any made for another map. */
  async function listDestinations(db, userId, id) {
    const robot = await getRobot(db, userId, id);
    return {
      map: robot.mapName || null,
      destinations: Object.entries(robot.places).map(([name, point]) => ({ name, ...point })),
      reported: Object.entries(robot.reportedPlaces).map(([name, point]) => ({ name, ...point, usable: Boolean(robot.places[name]) })),
      stale: robot.staleDestinations,
      rule: robot.simulated ? "A simulated robot may use the places its runtime reported, and any you add." : "A physical robot goes by name only to destinations you defined or approved.",
    };
  }
  /** Define a destination, or approve one of the places the robot reported. It is checked against the robot's limits and bound to its current map. */
  async function addDestination(db, userId, id, input = {}) {
    const robot = await getRobot(db, userId, id);
    if (robot.status !== "enrolled") throw fail(409, `${robot.name} isn't enrolled.`, "not-enrolled");
    if (!robot.mapName) throw fail(409, `${robot.name} didn't say which map it uses, so a destination can't be tied to one.`, "no-map");
    const reported = input.fromPlace ? robot.reportedPlaces[String(input.fromPlace)] : null;
    if (input.fromPlace && !reported) throw fail(404, `${robot.name} didn't report a place called “${clean(input.fromPlace, 60)}”.`, "not-found");
    const name = clean(input.name || input.fromPlace, 60);
    const point = reported || { x: Number(input.x), y: Number(input.y), ...(input.yaw === undefined || input.yaw === null || input.yaw === "" ? {} : { yaw: Number(input.yaw) }) };
    if (!name) throw fail(400, "Give the destination a name.", "bad-request");
    if (!finite(point.x) || !finite(point.y) || (point.yaw !== undefined && !finite(point.yaw))) throw fail(400, "A destination needs x and y in metres on the robot's map.", "bad-request");
    const owned = (await destinationRows(db, userId)).filter((row) => row.robot_id === robot.id);
    if (owned.some((row) => row.name.toLowerCase() === name.toLowerCase() && row.map === robot.mapName)) throw fail(409, `${robot.name} already has a destination called “${name}”.`, "duplicate-name");
    if (owned.length >= MAX_DESTINATIONS) throw fail(400, `A robot can have ${MAX_DESTINATIONS} destinations.`, "too-many");
    const problems = safety.pointProblems(point, robot.limits, "That point");
    for (const rect of robot.world?.obstacles || []) {
      const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
      const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
      if (Math.hypot(dx, dy) < (robot.limits.robotRadius || 0.2)) problems.push({ code: "in-obstacle", message: `That point is inside or touching an obstacle on the robot's map${rect.name ? ` (${rect.name})` : ""}.` });
    }
    if (problems.length) throw fail(400, problems.map((item) => item.message).join(" "), "invalid-destination");
    const destinationId = `ds_${crypto.randomBytes(8).toString("hex")}`;
    const frame = robot.limits.workspaces[0]?.frame || "map";
    await db.query("INSERT INTO hannah_robot_destinations (user_id, id, robot_id, name, map, frame, x, y, yaw, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [userId, destinationId, robot.id, name, robot.mapName, frame, round(point.x, 3), round(point.y, 3), point.yaw === undefined ? null : round(point.yaw, 4), reported ? "robot-profile" : "owner", now()]);
    await db.query("UPDATE hannah_robots SET config_version = config_version + 1 WHERE user_id = $1 AND id = $2", [userId, robot.id]);
    await addEvent(db, userId, robot.id, { type: "destination-added", message: `Destination “${name}” at (${round(point.x)}, ${round(point.y)}) on map ${robot.mapName}${reported ? ", approved from the robot's own list" : ""}.` });
    return listDestinations(db, userId, robot.id);
  }
  async function removeDestination(db, userId, id, destinationId) {
    const robot = await getRobot(db, userId, id);
    const removed = await db.query("DELETE FROM hannah_robot_destinations WHERE user_id = $1 AND robot_id = $2 AND id = $3", [userId, robot.id, String(destinationId)]);
    if (!removed.rowCount) throw fail(404, "That destination doesn't exist.", "not-found");
    await db.query("UPDATE hannah_robots SET config_version = config_version + 1 WHERE user_id = $1 AND id = $2", [userId, robot.id]);
    return listDestinations(db, userId, robot.id);
  }

  // ---------- maintenance ----------
  async function addMaintenance(db, userId, id, { kind, note } = {}) {
    const robot = await getRobot(db, userId, id);
    const text = clean(note, 500);
    if (!text) throw fail(400, "Say what was done or found.", "bad-request");
    await db.query("INSERT INTO hannah_robot_maintenance (user_id, id, robot_id, at, kind, note) VALUES ($1, $2, $3, $4, $5, $6)", [userId, crypto.randomUUID(), robot.id, now(), ["inspection", "repair", "replacement", "calibration", "note"].includes(kind) ? kind : "note", text]);
    return maintenance(db, userId, robot.id);
  }
  async function maintenance(db, userId, robotId, limit = 50) {
    const { rows } = await db.query("SELECT * FROM hannah_robot_maintenance WHERE user_id = $1 AND robot_id = $2 ORDER BY at DESC LIMIT $3", [userId, String(robotId), Math.max(1, Math.min(200, Number(limit) || 50))]);
    return rows.map((row) => ({ id: row.id, at: Number(row.at), kind: row.kind, note: row.note }));
  }

  async function telemetry(db, userId, robotId, { sinceMs = 15 * 60_000, limit = 400 } = {}) {
    const { rows } = await db.query("SELECT at, sample FROM hannah_robot_telemetry WHERE user_id = $1 AND robot_id = $2 AND at >= $3 ORDER BY at DESC LIMIT $4", [userId, String(robotId), now() - Math.min(TELEMETRY_KEEP_MS, Math.max(10_000, Number(sinceMs) || 0)), Math.max(1, Math.min(1000, Number(limit) || 400))]);
    return rows.reverse().map((row) => ({ at: Number(row.at), ...parse(row.sample, {}) }));
  }
  async function events(db, userId, { robotId, limit = 50 } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (robotId) { values.push(String(robotId)); where += ` AND robot_id = $${values.length}`; }
    values.push(Math.max(1, Math.min(200, Number(limit) || 50)));
    const { rows } = await db.query(`SELECT * FROM hannah_robot_events WHERE ${where} ORDER BY at DESC LIMIT $${values.length}`, values);
    return rows.map((row) => ({ id: row.id, robotId: row.robot_id, at: Number(row.at), type: row.type, severity: row.severity, message: row.message, source: row.source }));
  }

  /** Fleet figures from stored records. See fleet.analytics for what each one means. */
  async function analytics(db, userId, { days = 7 } = {}) {
    const at = now();
    const windowMs = Math.max(1, Math.min(30, Number(days) || 7)) * 86_400_000;
    const since = at - windowMs;
    const robots = await listRobots(db, userId);
    const missions = (await db.query("SELECT * FROM hannah_robot_missions WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 5000", [userId, since])).rows.map((row) => publicMission(row, at));
    const planRows = (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 2000", [userId, since])).rows.map(publicPlan);
    const events = (await db.query("SELECT robot_id, type, COUNT(*) AS n FROM hannah_robot_events WHERE user_id = $1 AND at >= $2 GROUP BY robot_id, type", [userId, since])).rows.map((row) => ({ robotId: row.robot_id, type: row.type, count: Number(row.n) }));
    const telemetryOf = {};
    for (const robot of robots) {
      const from = at - TELEMETRY_KEEP_MS;
      const count = Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_telemetry WHERE user_id = $1 AND robot_id = $2 AND at >= $3", [userId, robot.id, from])).rows[0]?.n || 0);
      if (!count) continue;
      const edge = async (order) => { const row = (await db.query(`SELECT at, sample FROM hannah_robot_telemetry WHERE user_id = $1 AND robot_id = $2 AND at >= $3 ORDER BY at ${order} LIMIT 1`, [userId, robot.id, from])).rows[0]; return row ? { at: Number(row.at), battery: parse(row.sample, {}).battery ?? null } : null; };
      telemetryOf[robot.id] = { samples: count, everyMs: TELEMETRY_EVERY_MS, first: await edge("ASC"), last: await edge("DESC") };
    }
    return fleet.analytics({ robots, missions, plans: planRows, events, telemetry: telemetryOf, now: at, windowMs });
  }

  return { activeMotion, addDestination, analytics, deleteImage, getImage, listImages, addMaintenance, assess, assessPlan, authenticate, cancelMission, cancelPlan, createPlan, getPlan, listPlans, waitForPlan, commissioningView, confirmCommissioning, createRobot, dispatch, enroll, events, getMission, getRobot, issueCode, listDestinations, listMissions, listRobots, maintenance, pauseMission, removeDestination, removeRobot, resetCommissioning, resolveRobot, revokeRobot, resumeMission, stop, stopAll, sync, telemetry, updateRobot, waitFor };
}

module.exports = { AUTH_LABEL, COMMAND_LABEL, CODE_TTL_MS, FINAL, SKEW_MS, createRoboticsService, deriveKey, fingerprintOf, normalizeDescriptor, requestMessage, signCommand, signRequest };
