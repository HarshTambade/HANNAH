"use strict";

/**
 * The server side of a robot's black box: its event timeline.
 *
 * A robot keeps its own recording (robotics/runtime/hannah_robot/blackbox,
 * robot-os/src/hannah_robot_os/blackbox). What reaches HANNAH:
 *
 *   - event summaries, uploaded over the robot's signed link (or as Robot OS
 *     bridge envelopes). Each is stored once, keyed by the robot's own event
 *     id, with the robot's timestamp and how sure the robot was of its clock;
 *   - raw recording segments, only when the robot's owner switched that on.
 *     Their bytes go to file storage (blackbox_store.js); a row holds only
 *     where they are, their checksum and what they cover.
 *
 * The timeline a person or an agent sees merges those with what HANNAH itself
 * recorded about the robot: missions (issued, accepted, how they ended),
 * actions an agent or a person asked for with their permission and approval,
 * and the events the robot sent with its regular exchanges. Each item says
 * where it came from, and whether its time is from a synchronised clock.
 *
 * Every read is scoped to the account that owns the robot. A developer key
 * can read the timeline but never a sensitive item's details or a sensitive
 * segment; settings, export of sensitive data and deletion need a signed-in
 * person. Everything expires: events after the robot's retention (30 days by
 * default), sensitive events and segments sooner.
 */
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { readSegment } = require("./blackbox_format");
const { createBlackBoxStore } = require("./blackbox_store");
const incident = require("./incident");
const replay = require("./blackbox_replay");

const DAY = 86_400_000;
const SOURCES = ["motor", "sensor", "navigation", "ai", "os", "safety", "link", "mission", "server"];
const SEVERITIES = ["debug", "info", "warning", "error", "critical"];
const DEFAULTS = { enabled: true, retentionDays: 30, sensitiveRetentionDays: 1, acceptSegments: false, acceptSensitive: false, segmentRetentionDays: 7, maxSegmentMB: 4 };
const RANGES = { retentionDays: [1, 365], sensitiveRetentionDays: [1, 30], segmentRetentionDays: [1, 90], maxSegmentMB: [1, 16] };
const MAX_EVENTS_PER_UPLOAD = 200;
const MAX_FUTURE_MS = DAY;

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const RAW_KEYS = new Set(["data", "pixels", "image", "audio", "samples", "pcm", "bytes", "raw", "frame_data", "png", "jpeg"]);

/** JSON that is small, plain and holds no raw sensor payloads. */
function tidy(value, depth = 0) {
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => tidy(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (RAW_KEYS.has(String(key).toLowerCase())) { out[`${clean(key, 40)}Omitted`] = true; continue; }
      out[clean(key, 60)] = tidy(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return clean(value, 400);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  return null;
}

function sourceOfRobotEvent(type) {
  if (/^estop/.test(type)) return "safety";
  if (type === "fault") return "motor";
  if (/^link-|^revoked/.test(type)) return "link";
  if (/^command-|^resume-|^mission/.test(type)) return "mission";
  if (/^camera/.test(type)) return "sensor";
  return "os";
}

function createBlackBoxService({ robotics, store = createBlackBoxStore(), now = () => Date.now() } = {}) {
  let ingests = 0;

  // ---------- settings ----------
  async function getSettings(db, userId, robotId) {
    const row = (await db.query("SELECT settings FROM hannah_robot_blackbox_settings WHERE user_id = $1 AND robot_id = $2", [userId, robotId])).rows[0];
    return { ...DEFAULTS, ...parse(row?.settings, {}) };
  }
  const policyOf = (settings) => ({
    enabled: settings.enabled, acceptSegments: settings.enabled && settings.acceptSegments && store.durable, acceptSensitive: settings.enabled && settings.acceptSegments && settings.acceptSensitive && store.durable,
    maxSegmentBytes: settings.maxSegmentMB * 1024 * 1024, ...(settings.acceptSegments && !store.durable ? { segmentsRefused: "This server has no durable file storage for recordings." } : {}),
  });
  async function settingsView(db, userId, robotId) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const settings = await getSettings(db, userId, robot.id);
    return { robotId: robot.id, settings, storage: { kind: store.kind, durable: store.durable }, policy: policyOf(settings) };
  }
  async function updateSettings(db, userId, robotId, change = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const settings = await getSettings(db, userId, robot.id);
    for (const key of ["enabled", "acceptSegments", "acceptSensitive"]) {
      if (change[key] === undefined) continue;
      if (typeof change[key] !== "boolean") throw fail(400, `${key} must be true or false.`, "invalid");
      settings[key] = change[key];
    }
    for (const [key, [low, high]] of Object.entries(RANGES)) {
      if (change[key] === undefined) continue;
      const value = Number(change[key]);
      if (!Number.isInteger(value) || value < low || value > high) throw fail(400, `${key} must be a whole number from ${low} to ${high}.`, "invalid");
      settings[key] = value;
    }
    const at = now();
    const text = JSON.stringify(settings);
    const updated = await db.query("UPDATE hannah_robot_blackbox_settings SET settings = $1, updated_at = $2 WHERE user_id = $3 AND robot_id = $4", [text, at, userId, robot.id]);
    if (!updated.rowCount) await db.query("INSERT INTO hannah_robot_blackbox_settings (user_id, robot_id, settings, updated_at) VALUES ($1, $2, $3, $4)", [userId, robot.id, text, at]);
    // A new retention applies to what is already stored, then expired rows go at once.
    await db.query("UPDATE hannah_robot_blackbox_events SET expires_at = at + $1 WHERE user_id = $2 AND robot_id = $3 AND sensitivity = 'normal'", [settings.retentionDays * DAY, userId, robot.id]);
    await db.query("UPDATE hannah_robot_blackbox_events SET expires_at = at + $1 WHERE user_id = $2 AND robot_id = $3 AND sensitivity = 'sensitive'", [Math.min(settings.sensitiveRetentionDays, settings.retentionDays) * DAY, userId, robot.id]);
    await db.query("UPDATE hannah_robot_blackbox_segments SET expires_at = uploaded_at + $1 WHERE user_id = $2 AND robot_id = $3", [settings.segmentRetentionDays * DAY, userId, robot.id]);
    await sweep(db, { userId });
    return settingsView(db, userId, robot.id);
  }

  // ---------- ingestion (the robot) ----------
  function clockOf(item, fallback) {
    const clock = item && typeof item === "object" ? item : fallback && typeof fallback === "object" ? fallback : {};
    const offset = finite(clock.offMs) ? clock.offMs : finite(clock.offsetMs) ? clock.offsetMs : null;
    const uncertainty = finite(clock.uncMs) ? clock.uncMs : finite(clock.uncertaintyMs) ? clock.uncertaintyMs : null;
    const synced = clock.synced === true && offset !== null && uncertainty !== null;
    return { synced, offset: synced ? Math.round(offset) : 0, uncertainty: synced ? Math.max(0, Math.round(uncertainty)) : null };
  }

  async function storeEvent(db, robot, item, settings, { origin, fallbackClock, at }) {
    const id = clean(item?.id, 64);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return { refused: "bad-id" };
    if (!finite(item.at)) return { refused: "no-time" };
    const clock = clockOf(item.clock, fallbackClock);
    const when = Math.round(item.at + clock.offset);
    if (when > at + MAX_FUTURE_MS) return { id, refused: "time-in-the-future" };
    const sensitive = item.sensitivity === "sensitive";
    const keepMs = (sensitive ? Math.min(settings.sensitiveRetentionDays, settings.retentionDays) : settings.retentionDays) * DAY;
    if (when + keepMs <= at) return { id, refused: "older-than-retention" };
    const details = sensitive && !settings.acceptSensitive ? { withheld: "Sensitive: details are not kept on the server." } : tidy(item.details && typeof item.details === "object" ? item.details : {});
    const refs = Array.isArray(item.refs) ? item.refs.slice(0, 8).map((ref) => ({ segment: clean(ref?.segment, 64), stream: clean(ref?.stream, 60), fromMs: finite(ref?.fromMs) ? ref.fromMs : null, toMs: finite(ref?.toMs) ? ref.toMs : null })).filter((ref) => ref.segment) : [];
    const result = await db.query(
      `INSERT INTO hannah_robot_blackbox_events (user_id, id, robot_id, robot_event_id, device_id, at, received_at, clock_synced, clock_uncertainty_ms, source, type, mission_id, severity, summary, details, data_refs, sensitivity, simulated, origin, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) ON CONFLICT (user_id, robot_id, robot_event_id) DO NOTHING`,
      [robot.userId, `bbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, robot.id, id, clean(item.device, 80) || null, when, at, clock.synced ? 1 : 0, clock.uncertainty,
        SOURCES.includes(item.source) ? item.source : "os", clean(item.type, 60) || "event", clean(item.mission, 80) || null, SEVERITIES.includes(item.severity) ? item.severity : "info",
        clean(item.summary, 400) || clean(item.type, 60) || "event", JSON.stringify(details).slice(0, 8000), JSON.stringify(refs), sensitive ? "sensitive" : "normal", robot.simulated ? 1 : 0, origin, when + keepMs],
    );
    return result.rowCount ? { id, stored: true } : { id, duplicate: true };
  }

  async function storeSegment(db, robot, segment, settings, at) {
    const policy = policyOf(settings);
    const id = clean(segment?.id, 64);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return { stored: false, reason: "bad-id" };
    if (!policy.acceptSegments) return { stored: false, reason: store.durable ? "not-allowed" : "no-durable-storage" };
    if (segment.sensitivity === "sensitive" && !policy.acceptSensitive) return { stored: false, reason: "sensitive-not-allowed" };
    const raw = Buffer.from(String(segment.content || ""), "base64");
    if (!raw.length || raw.length > policy.maxSegmentBytes) return { stored: false, reason: raw.length ? "too-large" : "empty" };
    let parsed;
    try { parsed = readSegment(raw); } catch (error) { return { stored: false, reason: "bad-segment", detail: error.message }; }
    const { header, records, info } = parsed;
    if (header.segment !== id) return { stored: false, reason: "id-mismatch" };
    if (header.robotId !== robot.id) return { stored: false, reason: "wrong-robot" };
    // A recording says whether it came from a simulation. It must agree with what this robot is registered as.
    if (Boolean(header.simulated) !== robot.simulated) return { stored: false, reason: "kind-mismatch" };
    const sensitive = header.sensitivity === "sensitive" || segment.sensitivity === "sensitive";
    if (sensitive && !policy.acceptSensitive) return { stored: false, reason: "sensitive-not-allowed" };
    const times = records.map((item) => Number(item.t)).filter(Number.isFinite);
    const compressed = raw[0] === 0x1f && raw[1] === 0x8b ? raw : zlib.gzipSync(raw);
    const key = `${sha256(robot.userId).slice(0, 24)}/${robot.id}/${id}.hbx.gz`;
    const existing = (await db.query("SELECT id FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND id = $2", [robot.userId, id])).rows[0];
    if (existing) return { stored: "duplicate" };
    await store.put(key, compressed);
    await db.query(
      `INSERT INTO hannah_robot_blackbox_segments (user_id, id, robot_id, stream, topics, from_at, to_at, records, bytes, sha256, storage_key, sensitivity, simulated, verified, uploaded_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [robot.userId, id, robot.id, clean(header.stream, 60) || "unknown", JSON.stringify([...new Set(records.map((item) => clean(item.topic, 80)))].slice(0, 60)), times.length ? Math.min(...times) : null, times.length ? Math.max(...times) : null,
        records.length, compressed.length, sha256(compressed), key, sensitive ? "sensitive" : "normal", robot.simulated ? 1 : 0, info.verified ? 1 : 0, at, at + settings.segmentRetentionDays * DAY],
    );
    return { stored: true, verified: info.verified };
  }

  /** One upload from a robot: { clock, events: [...], segment? }. `row` is the authenticated robot's registry row. */
  async function ingest(db, row, body = {}, { origin = "robot-blackbox" } = {}) {
    const at = now();
    const robot = { id: row.id, userId: row.user_id, simulated: Boolean(Number(row.simulated)) };
    const settings = await getSettings(db, robot.userId, robot.id);
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length > MAX_EVENTS_PER_UPLOAD) throw fail(413, `At most ${MAX_EVENTS_PER_UPLOAD} events per upload.`, "too-many");
    const answer = { accepted: [], duplicates: [], refused: [], segment: null, policy: policyOf(settings), serverTime: at };
    if (!settings.enabled) {
      answer.refused = events.map((item) => ({ id: clean(item?.id, 64), reason: "recording-off" }));
      if (body.segment) answer.segment = { stored: false, reason: "recording-off" };
      return answer;
    }
    for (const item of events) {
      const result = await storeEvent(db, robot, item || {}, settings, { origin, fallbackClock: body.clock, at });
      if (result.refused) answer.refused.push({ id: result.id || clean(item?.id, 64), reason: result.refused });
      else if (result.duplicate) answer.duplicates.push(result.id);
      else answer.accepted.push(result.id);
    }
    if (body.segment) answer.segment = await storeSegment(db, robot, body.segment, settings, at);
    if ((ingests += 1) % 50 === 0) await sweep(db).catch(() => {});
    return answer;
  }

  /** A Robot OS bridge envelope of kind "event" that carries a black box event. */
  async function ingestEnvelope(db, ownerId, envelope) {
    const item = envelope?.payload?.blackbox;
    if (!ownerId || !item || typeof item !== "object") return null;
    const row = (await db.query("SELECT id, user_id, simulated FROM hannah_robots WHERE id = $1 AND user_id = $2", [String(envelope.robot_id || ""), ownerId])).rows[0];
    if (!row) return null;
    return ingest(db, row, { events: [item] }, { origin: "robot-os" });
  }

  // ---------- reading ----------
  const publicEvent = (row, { session }) => {
    const sensitive = row.sensitivity === "sensitive";
    const synced = Boolean(Number(row.clock_synced));
    const uncertainty = row.clock_uncertainty_ms === null || row.clock_uncertainty_ms === undefined ? null : Number(row.clock_uncertainty_ms);
    return {
      id: row.id, robotId: row.robot_id, robotEventId: row.robot_event_id, deviceId: row.device_id || null, at: Number(row.at), receivedAt: Number(row.received_at),
      clock: { synced, uncertaintyMs: uncertainty, note: synced ? `Robot clock, synchronised with HANNAH to within ${uncertainty} ms.` : "Robot clock, not synchronised with HANNAH: its time and its order against HANNAH's own records are uncertain." },
      source: row.source, type: row.type, missionId: row.mission_id || null, severity: row.severity, summary: row.summary,
      details: sensitive && !session ? { withheld: "Sensitive: only a signed-in person can see these details." } : parse(row.details, {}), dataRefs: parse(row.data_refs, []),
      sensitivity: row.sensitivity, simulated: Boolean(Number(row.simulated)), origin: row.origin,
    };
  };

  /** What HANNAH itself recorded about the robot, as timeline items. Times are the server's clock. */
  async function serverEvents(db, userId, robotId, { from, to }) {
    const serverClock = { synced: true, uncertaintyMs: 0, note: "HANNAH's server clock." };
    const out = [];
    const base = { robotId, deviceId: null, clock: serverClock, dataRefs: [], sensitivity: "normal" };
    const robotEvents = (await db.query("SELECT * FROM hannah_robot_events WHERE user_id = $1 AND robot_id = $2 AND at >= $3 AND at <= $4 ORDER BY at", [userId, robotId, from, to])).rows;
    for (const row of robotEvents) {
      const fromRobot = row.source === "robot";
      out.push({ ...base, id: `rev_${row.id}`, at: Number(row.at), receivedAt: Number(row.at), source: fromRobot ? sourceOfRobotEvent(row.type) : "server", type: row.type, missionId: null, severity: row.severity, summary: row.message, details: {},
        origin: fromRobot ? "robot-sync" : "server", ...(fromRobot ? { clock: { synced: false, uncertaintyMs: null, note: "Sent with the robot's regular exchange; stamped by the robot within a day of the server's clock." } } : {}) });
    }
    const missions = (await db.query("SELECT * FROM hannah_robot_missions WHERE user_id = $1 AND robot_id = $2 AND created_at <= $3 AND (finished_at IS NULL OR finished_at >= $4) ORDER BY created_at", [userId, robotId, to, from])).rows;
    for (const row of missions) {
      const params = parse(row.params, {});
      const mission = robotics.publicMission ? robotics.publicMission(row) : null;
      const status = mission?.status || row.status;
      const phases = [{ phase: "issued", at: Number(row.created_at), severity: "info", summary: `Mission ${row.id} issued: ${row.capability}${row.requested_by ? ` (requested by ${row.requested_by})` : ""}.`, details: { capability: row.capability, params, actionId: row.action_id || null, planId: row.plan_id || null } }];
      if (row.accepted_at) phases.push({ phase: "accepted", at: Number(row.accepted_at), severity: "info", summary: `The robot accepted mission ${row.id}.`, details: {} });
      const finishedAt = row.finished_at ? Number(row.finished_at) : null;
      if (finishedAt || ["expired", "lost"].includes(status)) {
        const verification = parse(row.verification);
        phases.push({ phase: "finished", at: finishedAt || Number(row.deadline_at || row.expires_at), severity: status === "succeeded" ? "info" : ["failed", "lost", "timed-out", "unverified"].includes(status) ? "error" : "warning",
          summary: `Mission ${row.id} ended ${status}${row.error || mission?.error ? `: ${row.error || mission.error}` : "."}`, details: { status, capability: row.capability, params, error: row.error || mission?.error || null, verification } });
      }
      for (const phase of phases) {
        if (phase.at < from || phase.at > to) continue;
        out.push({ ...base, id: `msn_${row.id}_${phase.phase}`, at: phase.at, receivedAt: phase.at, source: "mission", type: `mission-${phase.phase === "finished" ? status : phase.phase}`, missionId: row.id, severity: phase.severity, summary: phase.summary, details: phase.details, origin: "server" });
      }
    }
    const actions = (await db.query("SELECT * FROM hannah_actions WHERE user_id = $1 AND service = 'robots' AND kind = 'write' AND created_at >= $2 AND created_at <= $3 AND resource LIKE $4 ORDER BY created_at", [userId, from, to, `%"${robotId}"%`])).rows;
    for (const row of actions) {
      const permission = parse(row.permission, {});
      const approval = parse(row.approval, {});
      const who = row.agent ? `${row.agent} (${row.source || "chat"})` : row.source === "robots" ? "a person on the Robots screen" : row.source || "someone";
      const missionId = parse(row.response, {})?.missionId || null;
      out.push({ ...base, id: `act_${row.id}_requested`, at: Number(row.created_at), receivedAt: Number(row.created_at), source: "ai", type: "action-requested", missionId, severity: "info",
        summary: `${who} asked for ${row.action}${row.request ? `: “${clean(row.request, 160)}”` : ""}. Permission: ${permission.outcome || "unknown"}${permission.reason ? ` (${clean(permission.reason, 160)})` : ""}.`,
        details: { action: row.action, agent: row.agent || null, source: row.source || null, permission: { outcome: permission.outcome || null, level: permission.level || null, reason: permission.reason || null, flags: permission.flags || [] } }, origin: "server" });
      if (approval.at && ["approved", "declined"].includes(approval.status)) out.push({ ...base, id: `act_${row.id}_approval`, at: Number(approval.at), receivedAt: Number(approval.at), source: "ai", type: `approval-${approval.status}`, missionId, severity: approval.status === "approved" ? "info" : "warning", summary: `${row.action} was ${approval.status}${approval.by ? ` by ${clean(approval.by, 60)}` : ""}.`, details: { action: row.action }, origin: "server" });
      if (["done", "failed", "unverified", "denied", "expired"].includes(row.status)) out.push({ ...base, id: `act_${row.id}_result`, at: Number(row.executed_at || row.updated_at), receivedAt: Number(row.updated_at), source: "ai", type: `action-${row.status}`, missionId, severity: row.status === "done" ? "info" : "warning", summary: `${row.action} ${row.status}${row.error ? `: ${clean(row.error, 200)}` : "."}`, details: { action: row.action }, origin: "server" });
    }
    return out.filter((item) => item.at >= from && item.at <= to).map((item) => ({ ...item, simulated: null }));
  }

  /**
   * The robot's timeline, oldest first. Filters: from, to (ms), mission, source (comma list), type (comma list),
   * severity (the lowest to include), q (words in the summary), limit (≤ 2000), server (false: black box only).
   */
  async function timeline(db, userId, robotId, filters = {}, { session = false } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const at = now();
    const to = finite(Number(filters.to)) && Number(filters.to) > 0 ? Number(filters.to) : at + 60_000;
    const from = finite(Number(filters.from)) && Number(filters.from) > 0 ? Number(filters.from) : to - DAY;
    if (from > to) throw fail(400, "from must be before to.", "invalid");
    const limit = Math.max(1, Math.min(2000, Number(filters.limit) || 500));
    const sources = String(filters.source || "").split(",").map((item) => item.trim()).filter(Boolean);
    const types = String(filters.type || "").split(",").map((item) => item.trim()).filter(Boolean);
    const minimum = SEVERITIES.indexOf(filters.severity);
    const words = clean(filters.q, 80).toLowerCase();
    const values = [userId, robot.id, from, to];
    let where = "user_id = $1 AND robot_id = $2 AND at >= $3 AND at <= $4";
    if (filters.mission) { values.push(clean(filters.mission, 80)); where += ` AND mission_id = $${values.length}`; }
    if (sources.length) { where += ` AND source IN (${sources.map((item) => { values.push(item); return `$${values.length}`; }).join(", ")})`; }
    if (types.length) { where += ` AND type IN (${types.map((item) => { values.push(item); return `$${values.length}`; }).join(", ")})`; }
    if (minimum > 0) { where += ` AND severity IN (${SEVERITIES.slice(minimum).map((item) => { values.push(item); return `$${values.length}`; }).join(", ")})`; }
    if (words) { values.push(`%${words}%`); where += ` AND (LOWER(summary) LIKE $${values.length} OR LOWER(type) LIKE $${values.length})`; }
    values.push(limit);
    const stored = (await db.query(`SELECT * FROM hannah_robot_blackbox_events WHERE ${where} ORDER BY at DESC LIMIT $${values.length}`, values)).rows.map((row) => publicEvent(row, { session }));
    let items = stored;
    if (filters.server !== false && filters.server !== "0" && filters.server !== "false") {
      const own = (await serverEvents(db, userId, robot.id, { from, to })).map((item) => ({ ...item, simulated: robot.simulated }));
      const matches = (item) => (!filters.mission || item.missionId === filters.mission) && (!sources.length || sources.includes(item.source)) && (!types.length || types.includes(item.type))
        && (minimum <= 0 || SEVERITIES.indexOf(item.severity) >= minimum) && (!words || `${item.summary} ${item.type}`.toLowerCase().includes(words));
      // The robot's regular exchange also carries its events; the black box's richer copy wins.
      const duplicate = (item) => item.origin === "robot-sync" && stored.some((other) => other.type === item.type && Math.abs(other.at - item.at) <= 2000);
      items = [...stored, ...own.filter((item) => matches(item) && !duplicate(item))];
    }
    items.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
    const truncated = items.length > limit;
    items = items.slice(-limit);
    const unsynced = items.filter((item) => item.origin !== "server" && !item.clock.synced).length;
    const widest = items.reduce((max, item) => Math.max(max, item.clock.uncertaintyMs || 0), 0);
    return {
      robot: { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical" }, from, to, events: items, truncated,
      clock: { unsynchronised: unsynced, widestUncertaintyMs: widest, note: unsynced ? `${unsynced} item${unsynced === 1 ? "" : "s"} carry a robot time that wasn't synchronised with HANNAH: their order against HANNAH's own records may be off.` : widest ? `Robot times are synchronised to within ${widest} ms.` : "All times are on synchronised clocks." },
    };
  }

  async function segments(db, userId, robotId, { session = false } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const rows = (await db.query("SELECT * FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND robot_id = $2 ORDER BY from_at", [userId, robot.id])).rows;
    return rows.map((row) => ({ id: row.id, stream: row.stream, topics: parse(row.topics, []), fromAt: row.from_at === null ? null : Number(row.from_at), toAt: row.to_at === null ? null : Number(row.to_at), records: Number(row.records), bytes: Number(row.bytes),
      sha256: row.sha256, sensitivity: row.sensitivity, simulated: Boolean(Number(row.simulated)), verified: Boolean(Number(row.verified)), uploadedAt: Number(row.uploaded_at), expiresAt: Number(row.expires_at), downloadable: row.sensitivity !== "sensitive" || session }));
  }

  async function segmentContent(db, userId, robotId, segmentId, { session = false } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const row = (await db.query("SELECT * FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND robot_id = $2 AND id = $3", [userId, robot.id, clean(segmentId, 64)])).rows[0];
    if (!row || Number(row.expires_at) <= now()) throw fail(404, "That recording isn't stored (it may have expired).", "not-found");
    if (row.sensitivity === "sensitive" && !session) throw fail(403, "This recording is marked sensitive: only a signed-in person can download it.", "session-required");
    const buffer = await store.get(row.storage_key);
    if (!buffer) throw fail(410, "The recording's file is missing from storage.", "missing");
    if (sha256(buffer) !== row.sha256) throw fail(409, "The stored recording doesn't match its checksum.", "checksum");
    return { name: `${robot.id}-${row.id}.hbx.gz`, buffer, sensitivity: row.sensitivity };
  }

  /** The records inside the robot's uploaded segments that overlap [from, to]. Sensitive ones only for a signed-in person. */
  async function segmentRecords(db, userId, robotId, { from, to, session = false, topics = null }) {
    const rows = (await db.query("SELECT * FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND robot_id = $2 AND expires_at > $3 AND (to_at IS NULL OR to_at >= $4) AND (from_at IS NULL OR from_at <= $5)", [userId, robotId, now(), from, to])).rows;
    const out = [];
    for (const row of rows) {
      if (row.sensitivity === "sensitive" && !session) continue;
      const buffer = await store.get(row.storage_key).catch(() => null);
      if (!buffer || sha256(buffer) !== row.sha256) continue;
      try {
        for (const record of readSegment(buffer).records) {
          const t = Number(record.t);
          if (t >= from && t <= to && (!topics || topics.includes(record.topic))) out.push({ ...record, segment: row.id });
        }
      } catch { /* a damaged file is skipped; its checksum was checked */ }
    }
    return out.sort((a, b) => Number(a.t) - Number(b.t));
  }

  // ---------- retention, export, deletion ----------
  async function sweep(db, { userId = null } = {}) {
    const at = now();
    const scope = userId ? " AND user_id = $2" : "";
    const values = userId ? [at, userId] : [at];
    const events = await db.query(`DELETE FROM hannah_robot_blackbox_events WHERE expires_at <= $1${scope}`, values);
    const expired = (await db.query(`SELECT user_id, id, storage_key FROM hannah_robot_blackbox_segments WHERE expires_at <= $1${scope}`, values)).rows;
    for (const row of expired) {
      await store.remove(row.storage_key).catch(() => {});
      await db.query("DELETE FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND id = $2", [row.user_id, row.id]);
    }
    return { events: Number(events.rowCount) || 0, segments: expired.length };
  }

  async function exportData(db, userId, robotId, { from, to } = {}, { session = false } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const end = Number(to) || now() + 60_000;
    const view = await timeline(db, userId, robot.id, { from: Number(from) || 1, to: end, limit: 2000 }, { session });
    return {
      format: "hannah-blackbox-export", version: 1, exportedAt: now(), robot: { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical" },
      settings: await getSettings(db, userId, robot.id), from: view.from, to: view.to, clock: view.clock, events: view.events, truncated: view.truncated,
      segments: (await segments(db, userId, robot.id, { session })).map((item) => ({ ...item, download: item.downloadable ? `/api/robots/${robot.id}/blackbox/segments/${item.id}` : null })),
      note: robot.simulated ? "Everything here comes from a simulated robot." : "Recorded from a physical robot. Times marked unsynchronised are the robot's own clock.",
    };
  }

  async function deleteData(db, userId, robotId, { from = null, to = null } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const start = Number(from) || 0;
    const end = Number(to) || Number.MAX_SAFE_INTEGER;
    const events = await db.query("DELETE FROM hannah_robot_blackbox_events WHERE user_id = $1 AND robot_id = $2 AND at >= $3 AND at <= $4", [userId, robot.id, start, end]);
    const rows = (await db.query("SELECT id, storage_key FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND robot_id = $2 AND (to_at IS NULL OR to_at >= $3) AND (from_at IS NULL OR from_at <= $4)", [userId, robot.id, start, end])).rows;
    for (const row of rows) {
      await store.remove(row.storage_key);
      await db.query("DELETE FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND id = $2", [userId, row.id]);
    }
    const removed = { events: Number(events.rowCount) || 0, segments: rows.length };
    await robotics.addEvent?.(db, userId, robot.id, { type: "blackbox-deleted", severity: "info", message: `Black box data deleted by a signed-in person: ${removed.events} events and ${removed.segments} recordings${from || to ? " in the chosen time range" : ""}.` });
    return { ...removed, note: "Mission history and HANNAH's action records are kept under Missions and History; delete those there." };
  }

  /** When the robot itself is removed, its black box goes with it. */
  async function removeRobotData(db, userId, robotId) {
    const rows = (await db.query("SELECT id, storage_key FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND robot_id = $2", [userId, robotId])).rows;
    for (const row of rows) await store.remove(row.storage_key).catch(() => {});
    await db.query("DELETE FROM hannah_robot_blackbox_segments WHERE user_id = $1 AND robot_id = $2", [userId, robotId]);
    await db.query("DELETE FROM hannah_robot_blackbox_events WHERE user_id = $1 AND robot_id = $2", [userId, robotId]);
    await db.query("DELETE FROM hannah_robot_blackbox_settings WHERE user_id = $1 AND robot_id = $2", [userId, robotId]);
  }

  // ---------- investigation and replay ----------
  /** The incident report for a robot (a view, an id or a name): the latest stop, or a mission's, or the one at or before `at`. */
  async function investigateRobot(db, userId, robotRef, { missionId = null, at = null, session = false } = {}) {
    const robot = robotRef && typeof robotRef === "object" ? robotRef : await robotics.resolveRobot(db, userId, robotRef);
    const current = now();
    let around = Number(at) > 0 ? Number(at) : current;
    if (missionId) {
      const mission = await robotics.getMission(db, userId, missionId);
      if (mission.robotId !== robot.id) throw fail(404, "That mission isn't this robot's.", "not-found");
      around = (mission.finishedAt || mission.deadlineAt || current) + incident.AFTER_MS;
    }
    const view = await timeline(db, userId, robot.id, { from: around - 6 * 3_600_000, to: around + incident.AFTER_MS, limit: 2000 }, { session });
    const history = await timeline(db, userId, robot.id, { from: around - 30 * DAY, to: around, severity: "warning", limit: 2000 }, { session });
    const telemetry = await robotics.telemetry(db, userId, robot.id, { sinceMs: 2 * 3_600_000, limit: 1000 }).catch(() => []);
    const report = incident.investigate({ robot, timeline: view.events, telemetry, history: history.events, missionId, at: missionId ? null : at, now: current });
    return { ...report, clock: { ...(report.clock || {}), timeline: view.clock } };
  }

  async function replayMission(db, userId, robotId, missionId, { session = false } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const mission = await robotics.getMission(db, userId, missionId);
    if (mission.robotId !== robot.id) throw fail(404, "That mission isn't this robot's.", "not-found");
    const from = mission.createdAt - 30_000;
    const to = (mission.finishedAt || Math.min(now(), mission.deadlineAt || now())) + 15_000;
    const [view, telemetry, records] = await Promise.all([
      timeline(db, userId, robot.id, { from, to, limit: 2000 }, { session }),
      robotics.telemetry(db, userId, robot.id, { sinceMs: 2 * 3_600_000, limit: 1000 }).catch(() => []),
      segmentRecords(db, userId, robot.id, { from, to, session, topics: ["nav/pose", "motor/state", "sensors/obstacles"] }),
    ]);
    return replay.reconstruct({ robot, mission, timeline: view.events, telemetry, records });
  }

  async function scenarioFor(db, userId, robotId, { missionId = null, at = null, session = false } = {}) {
    const robot = await robotics.getRobot(db, userId, robotId);
    const report = await investigateRobot(db, userId, robot, { missionId, at, session });
    const id = missionId || report.anchor?.missionId;
    const mission = id ? await robotics.getMission(db, userId, id).catch(() => null) : null;
    const records = mission ? await segmentRecords(db, userId, robot.id, { from: mission.createdAt - 5_000, to: (mission.finishedAt || now()) + 5_000, session, topics: ["sensors/obstacles"] }) : [];
    return { report, scenario: replay.scenarioFromIncident({ report, mission, robot, records }) };
  }

  return { DEFAULTS, deleteData, exportData, getSettings, ingest, ingestEnvelope, investigateRobot, removeRobotData, replayMission, scenarioFor, segmentContent, segmentRecords, segments, settingsView, store, sweep, timeline, updateSettings };
}

module.exports = { DEFAULTS, SEVERITIES, SOURCES, createBlackBoxService, tidy };
