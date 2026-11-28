"use strict";

/**
 * Edge resource reports: what a robot's onboard Edge Resource Manager
 * (robot-os/src/hannah_robot_os/resources) measured, as it reported it.
 *
 * A report arrives over the robot's signed sync (the robotics runtime
 * forwards it) or as a signed Robot OS bridge telemetry envelope. It is
 * cleaned, never completed: a metric the robot couldn't measure stays
 * "not measurable on this device" and a malformed measurement becomes one.
 * A report from a simulated robot measured the computer running the
 * simulation, and says so.
 *
 * Reports are kept for REPORTS_KEEP_MS and read back per account.
 */
const crypto = require("node:crypto");

const SCHEMA = "hannah.edge-resources.v1";
const NOT_MEASURABLE = "not measurable on this device";
const REPORTS_KEEP_MS = 7 * 24 * 60 * 60_000;
const FRESH_MS = 60_000;
const MAX_REPORT_BYTES = 60_000;
const MIN_INTERVAL_MS = 5_000;

const KEY = /^[A-Za-z0-9_.[\]/ -]{1,64}$/;
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** One metric leaf: a real value with its unit and source, or the reason there isn't one. */
function cleanMetric(raw) {
  if (raw.available === true) {
    const value = raw.value;
    const ok = finite(value) || typeof value === "boolean" || (typeof value === "string" && value.length <= 40);
    if (!ok) return { available: false, reason: `${NOT_MEASURABLE}: the robot sent a value that isn't a measurement` };
    return { available: true, value: typeof value === "string" ? clean(value, 40) : value, unit: clean(raw.unit, 20), source: clean(raw.source, 200) || "unstated" };
  }
  const reason = clean(raw.reason, 240);
  return { available: false, reason: reason.startsWith(NOT_MEASURABLE) ? reason : `${NOT_MEASURABLE}${reason ? `: ${reason}` : ""}` };
}

function cleanValue(raw, depth) {
  if (depth > 7) return undefined;
  if (raw === null || typeof raw === "boolean") return raw;
  if (finite(raw)) return raw;
  if (typeof raw === "string") return clean(raw, 300);
  if (Array.isArray(raw)) return raw.slice(0, 40).map((item) => cleanValue(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof raw === "object") {
    if ("available" in raw) return cleanMetric(raw);
    const out = {};
    for (const [key, value] of Object.entries(raw).slice(0, 60)) {
      if (!KEY.test(key)) continue;
      const cleaned = cleanValue(value, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

/** Validate and clean a report. Throws a coded error for one that isn't an edge resources report. */
function normalizeReport(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("A resources report must be an object."), { status: 400, reason: "invalid-report" });
  if (raw.schema !== SCHEMA || !raw.snapshot || raw.snapshot.schema !== SCHEMA) throw Object.assign(new Error(`A resources report must use ${SCHEMA}.`), { status: 400, reason: "invalid-report" });
  if (JSON.stringify(raw).length > MAX_REPORT_BYTES) throw Object.assign(new Error("The resources report is too large."), { status: 413, reason: "too-large" });
  const measuredAt = Number(raw.snapshot.measured_at_ms);
  if (!finite(measuredAt) || measuredAt <= 0) throw Object.assign(new Error("The resources report has no measurement time."), { status: 400, reason: "invalid-report" });
  const report = cleanValue(raw, 0);
  const status = ["ok", "warning", "critical"].includes(report.evaluation?.status) ? report.evaluation.status : "unknown";
  return {
    report: { ...report, schema: SCHEMA, snapshot: { ...report.snapshot, measured_at_ms: measuredAt } },
    measuredAt: Math.min(measuredAt, now + 60_000),
    status,
  };
}

const metric = (node) => (node && node.available === true ? node.value : null);

/** Headline numbers for a history row; null where the robot couldn't measure it. */
function headline(report) {
  const snap = report.snapshot || {};
  const gpu = (snap.gpu?.devices || [])[0] || null;
  const disks = (snap.storage || []).map((disk) => metric(disk.used_pct)).filter(finite);
  return {
    cpuPct: metric(snap.cpu?.utilization_pct),
    cpuTempC: metric(snap.cpu?.temperature_c),
    memoryPct: metric(snap.memory?.used_pct),
    gpuPct: gpu ? metric(gpu.utilization_pct) : null,
    storagePct: disks.length ? Math.max(...disks) : null,
    batteryPct: metric(snap.battery?.percent),
    inferenceP50Ms: metric(snap.inference?.latency_ms_p50),
  };
}

function createEdgeResourceStore({ now = () => Date.now() } = {}) {
  let writes = 0;
  const lastAt = new Map();

  /** Store a report for a robot the account owns. Returns null when it was dropped (too soon after the last). */
  async function record(db, { userId, robotId, report: raw, source, simulatedHost = false }) {
    const at = now();
    const key = `${userId}:${robotId}`;
    if (at - (lastAt.get(key) || 0) < MIN_INTERVAL_MS) return null;
    const { report, measuredAt, status } = normalizeReport(raw, { now: at });
    // The server knows whether the robot record is a simulation; the robot's own flag can only add to that.
    report.simulated_host = Boolean(simulatedHost) || report.simulated_host === true;
    const id = `res_${crypto.randomBytes(9).toString("hex")}`;
    await db.query("INSERT INTO hannah_edge_resource_reports (user_id, id, robot_id, at, measured_at, source, status, report) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [userId, id, String(robotId), at, measuredAt, clean(source, 40), status, JSON.stringify(report)]);
    lastAt.set(key, at);
    if ((writes += 1) % 50 === 0) await db.query("DELETE FROM hannah_edge_resource_reports WHERE at < $1", [at - REPORTS_KEEP_MS]).catch(() => {});
    return { id, at, status };
  }

  function view(row, at = now()) {
    if (!row) return null;
    const report = parse(row.report, {});
    const measuredAt = Number(row.measured_at);
    const ageS = Math.max(0, Math.round((at - measuredAt) / 1000));
    return {
      id: row.id, robotId: row.robot_id, receivedAt: Number(row.at), measuredAt, ageS, fresh: at - measuredAt <= FRESH_MS,
      source: row.source, status: row.status,
      measuredOn: report.simulated_host ? "the computer running this simulated robot (not robot hardware)" : "the robot's onboard computer",
      simulatedHost: Boolean(report.simulated_host),
      enforcement: report.enforcement || "unknown", shedActive: Boolean(report.shed_active),
      snapshot: report.snapshot || {}, evaluation: report.evaluation || { status: "unknown", warnings: [], unmeasured: [] },
      actions: report.actions || [], workloads: report.workloads || [],
      policy: {
        approvedRemoteResources: Array.isArray(report.policy?.approved_remote_resources) ? report.policy.approved_remote_resources.slice(0, 5) : [],
        reasoningPrivacy: report.policy?.reasoning_privacy === "local-only" ? "local-only" : "allow-approved-remote",
      },
    };
  }

  async function latest(db, userId, robotId) {
    const row = (await db.query("SELECT * FROM hannah_edge_resource_reports WHERE user_id = $1 AND robot_id = $2 ORDER BY at DESC LIMIT 1", [userId, String(robotId)])).rows[0];
    return view(row);
  }

  async function history(db, userId, robotId, { sinceMs = 6 * 60 * 60_000, limit = 300 } = {}) {
    const from = now() - Math.min(REPORTS_KEEP_MS, Math.max(60_000, Number(sinceMs) || 0));
    const { rows } = await db.query("SELECT id, at, measured_at, status, report FROM hannah_edge_resource_reports WHERE user_id = $1 AND robot_id = $2 AND at >= $3 ORDER BY at DESC LIMIT $4",
      [userId, String(robotId), from, Math.max(1, Math.min(1000, Number(limit) || 300))]);
    return rows.map((row) => {
      const report = parse(row.report, {});
      return { id: row.id, receivedAt: Number(row.at), measuredAt: Number(row.measured_at), status: row.status, warnings: (report.evaluation?.warnings || []).length, ...headline(report) };
    });
  }

  return { latest, history, record, view };
}

module.exports = { FRESH_MS, NOT_MEASURABLE, REPORTS_KEEP_MS, SCHEMA, createEdgeResourceStore, headline, normalizeReport };
