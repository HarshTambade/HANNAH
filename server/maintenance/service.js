"use strict";

/**
 * Predictive maintenance: from what robots and hubs reported to findings a
 * person can check, with their evidence, and the work that follows.
 *
 *   record      measurements robots, Robot OS and hubs reported, in five-minute
 *               buckets (count, sum, sum of squares, min, max, last). Kept 180 days.
 *   baseline    per asset, component and metric, from the history before the
 *               last 24 hours (and after the component's last replacement).
 *   detect      detectors.js on the last 24 hours (and 7 days for trends);
 *               event rates from robot events and missions.
 *   findings    three labels, never mixed up:
 *                 measured-anomaly  a detector found the measurement unusual
 *                 suspected-cause   a fixed rule links two measured anomalies
 *                                   (hotter AND drawing more current); still unconfirmed
 *                 confirmed-fault   ONLY a fault code the robot's controller
 *                                   reported, or a person confirming a finding
 *               Each carries evidence, measurements, a timeline, a statistical
 *               confidence (that the measurement is unusual, not that anything
 *               will fail), possible causes, what to inspect and a priority.
 *               There is never a failure date: no validated failure model exists.
 *   verdicts    people mark findings true or false positives; precision is
 *               computed from those verdicts and shown, per detector.
 *   work        maintenance tasks with due dates (and a reminder in the
 *               person's synced reminders), completed into the service history
 *               (hannah_robot_maintenance).
 *
 * Nothing here sends a command to a robot or a hub, or changes a limit or a
 * safety setting. Maintenance only reads and records.
 */
const crypto = require("node:crypto");
const d = require("./detectors");
const catalog = require("./catalog");
const features = require("./features");
const { audit } = require("../ops-audit");

const BUCKET_MS = 5 * 60_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const KEEP_MS = 180 * DAY;
const HISTORY_MS = 30 * DAY;
const RECENT_MS = DAY;
const TREND_MS = 7 * DAY;
const MIN_BASELINE = 24; // two hours of buckets
const RECORD_EVERY_MS = 10_000;
const CLEAR_AFTER_MS = 3 * DAY;
const LABELS = ["measured-anomaly", "suspected-cause", "confirmed-fault"];
const VERDICTS = ["true-positive", "false-positive", "unsure"];
const TASK_KINDS = ["inspection", "repair", "replacement", "calibration", "service"];
const OPEN = "('open', 'acknowledged')";
const NAV_CAPABILITIES = new Set(["navigate_to", "return_to_dock", "inspect_area"]);
const BAD_MISSION = new Set(["failed", "timed-out", "lost"]);
const NO_DATE = "HANNAH gives no failure date: there is no validated failure model for this hardware. The trend says how the measurement is moving, not when anything will fail.";
const CONFIDENCE_NOTE = "Statistical confidence that this measurement is unusual for this component, from the detector and the amount of data. It is not a probability of failure.";

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const finite = d.finite;
const r = (value, digits = 3) => d.round(value, digits);
const clamp01 = (value) => Math.max(0, Math.min(1, value));

function createMaintenanceService({ now = () => Date.now(), emit = null, recordEveryMs = RECORD_EVERY_MS } = {}) {
  const lastRecorded = new Map();
  let writes = 0;

  // ---------- assets ----------
  async function assets(db, userId) {
    const robots = (await db.query("SELECT id, name, simulated, status, created_at FROM hannah_robots WHERE user_id = $1 ORDER BY created_at", [userId])).rows
      .map((row) => ({ id: row.id, kind: "robot", name: row.name, simulated: Boolean(Number(row.simulated)) || row.simulated === true, status: row.status, since: Number(row.created_at) }));
    const devices = (await db.query("SELECT id, name, profile, status, created_at FROM hannah_devices WHERE user_id = $1 ORDER BY created_at", [userId]).catch(() => ({ rows: [] }))).rows
      .map((row) => ({ id: row.id, kind: "device", name: row.name, simulated: parse(row.profile, {})?.simulated === true, status: row.status, since: Number(row.created_at), profile: parse(row.profile, {}) }));
    return [...robots, ...devices];
  }
  async function asset(db, userId, id) {
    const found = (await assets(db, userId)).find((item) => item.id === String(id || "") || item.name.toLowerCase() === String(id || "").toLowerCase());
    if (!found) throw fail(404, "That robot or device isn't in your account.", "not-found");
    return found;
  }

  // ---------- recording ----------
  async function upsert(db, { userId, assetId, assetKind, component, metric, unit, source, at, n, sum, sumsq, min, max, last }) {
    const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
    await db.query(
      `INSERT INTO hannah_maint_series (user_id, asset_id, component, metric, bucket_at, asset_kind, unit, source, n, sum_v, sumsq_v, min_v, max_v, last_v, last_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (user_id, asset_id, component, metric, bucket_at) DO UPDATE SET
         n = hannah_maint_series.n + excluded.n, sum_v = hannah_maint_series.sum_v + excluded.sum_v, sumsq_v = hannah_maint_series.sumsq_v + excluded.sumsq_v,
         min_v = CASE WHEN excluded.min_v < hannah_maint_series.min_v THEN excluded.min_v ELSE hannah_maint_series.min_v END,
         max_v = CASE WHEN excluded.max_v > hannah_maint_series.max_v THEN excluded.max_v ELSE hannah_maint_series.max_v END,
         last_v = CASE WHEN excluded.last_at >= hannah_maint_series.last_at THEN excluded.last_v ELSE hannah_maint_series.last_v END,
         last_at = CASE WHEN excluded.last_at > hannah_maint_series.last_at THEN excluded.last_at ELSE hannah_maint_series.last_at END`,
      [userId, assetId, clean(component, 60), clean(metric, 60), bucket, assetKind, unit ?? null, source, n, sum, sumsq, min, max, last, at],
    );
    writes += 1;
    if (writes % 500 === 0) await db.query("DELETE FROM hannah_maint_series WHERE bucket_at < $1", [now() - KEEP_MS]).catch(() => {});
  }
  /** One measured value. `source` is "physical" or "simulation". */
  async function record(db, userId, { assetId, assetKind = "robot", component, metric, value, unit = "", source = "physical", at = now() }) {
    if (!finite(value)) return false;
    await upsert(db, { userId, assetId, assetKind, component, metric, unit, source, at, n: 1, sum: value, sumsq: value * value, min: value, max: value, last: value });
    return true;
  }

  /** A robot's state report (called from the robot sync). Records at most every `recordEveryMs` per robot. */
  async function recordRobotState(db, robotRow, state, at = now()) {
    if (!robotRow || !state) return { recorded: 0 };
    if (at - (lastRecorded.get(robotRow.id) || 0) < recordEveryMs) return { recorded: 0 };
    lastRecorded.set(robotRow.id, at);
    const source = Number(robotRow.simulated) || robotRow.simulated === true ? "simulation" : "physical";
    let recorded = 0;
    for (const item of features.fromRobotState(state)) {
      if (await record(db, robotRow.user_id, { assetId: robotRow.id, assetKind: "robot", component: item.component, metric: item.metric, value: item.value, unit: item.unit, source, at })) recorded += 1;
    }
    for (const fault of features.faultsFromRobotState(state)) await reportedFault(db, robotRow.user_id, { assetId: robotRow.id, assetKind: "robot", simulated: source === "simulation", ...fault, at });
    return { recorded };
  }

  /** A Robot OS maintenance window (envelope payload.maintenance). */
  async function recordRobotOSFeatures(db, userId, robotId, payload, { simulated = false, at = now() } = {}) {
    const source = simulated || payload?.simulated === true ? "simulation" : "physical";
    let recorded = 0;
    for (const item of features.fromRobotOSFeatures(payload)) {
      const { n, mean, min, max, last, sumsq } = item.stats;
      await upsert(db, { userId, assetId: robotId, assetKind: "robot", component: item.component, metric: item.metric, unit: item.unit, source, at, n, sum: mean * n, sumsq, min, max, last });
      recorded += 1;
    }
    for (const fault of features.faultsFromRobotOS(payload)) await reportedFault(db, userId, { assetId: robotId, assetKind: "robot", simulated: source === "simulation", ...fault, at });
    return { recorded };
  }

  /** Numeric hub readings since the last import, into the same buckets. */
  async function ingestDeviceReadings(db, userId) {
    let imported = 0;
    for (const device of (await assets(db, userId)).filter((item) => item.kind === "device")) {
      const mark = Number((await db.query("SELECT MAX(last_at) AS at FROM hannah_maint_series WHERE user_id = $1 AND asset_id = $2", [userId, device.id])).rows[0]?.at) || 0;
      const { rows } = await db.query("SELECT point, at, value FROM hannah_device_readings WHERE user_id = $1 AND device_id = $2 AND at > $3 ORDER BY at LIMIT 20000", [userId, device.id, mark]).catch(() => ({ rows: [] }));
      const units = Object.fromEntries((device.profile?.points || []).map((point) => [point.id, point.unit || ""]));
      for (const row of rows) {
        const value = parse(row.value);
        if (await record(db, userId, { assetId: device.id, assetKind: "device", component: "device", metric: clean(row.point, 60), value: typeof value === "number" ? value : NaN, unit: units[row.point] || "", source: device.simulated ? "simulation" : "physical", at: Number(row.at) })) imported += 1;
      }
    }
    return { imported };
  }

  async function series(db, userId, assetId, component, metric, { sinceMs = HISTORY_MS } = {}) {
    const { rows } = await db.query("SELECT bucket_at, n, sum_v, sumsq_v, min_v, max_v, last_v, unit, source FROM hannah_maint_series WHERE user_id = $1 AND asset_id = $2 AND component = $3 AND metric = $4 AND bucket_at >= $5 ORDER BY bucket_at", [userId, String(assetId), String(component), String(metric), now() - sinceMs]);
    return rows.map((row) => ({ at: Number(row.bucket_at), n: Number(row.n), mean: Number(row.sum_v) / Number(row.n), min: Number(row.min_v), max: Number(row.max_v), last: Number(row.last_v), unit: row.unit || "", source: row.source }));
  }
  async function seriesKeys(db, userId, assetId) {
    const { rows } = await db.query("SELECT component, metric, COUNT(*) AS buckets, MIN(bucket_at) AS first_at, MAX(bucket_at) AS last_at, MAX(unit) AS unit, MAX(source) AS source FROM hannah_maint_series WHERE user_id = $1 AND asset_id = $2 AND bucket_at >= $3 GROUP BY component, metric ORDER BY component, metric", [userId, assetId, now() - HISTORY_MS]);
    return rows.map((row) => ({ component: row.component, metric: row.metric, buckets: Number(row.buckets), firstAt: Number(row.first_at), lastAt: Number(row.last_at), unit: row.unit || "", source: row.source }));
  }

  // ---------- findings storage ----------
  function publicFinding(row) {
    const detail = parse(row.detail, {});
    return {
      id: row.id, assetId: row.asset_id, assetKind: row.asset_kind, component: row.component, metric: row.metric, label: row.label, detector: row.detector,
      status: row.status, priority: row.priority, confidence: Number(row.confidence), simulated: Boolean(Number(row.simulated)), title: row.title,
      firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at), occurrences: Number(row.occurrences),
      feedback: row.feedback || null, feedbackNote: row.feedback_note || null, feedbackAt: row.feedback_at ? Number(row.feedback_at) : null,
      confirmation: parse(row.confirmation), ...detail, failureDate: null, confidenceMeans: CONFIDENCE_NOTE,
    };
  }
  async function saveFinding(db, userId, finding, at) {
    const existing = (await db.query(`SELECT * FROM hannah_maint_findings WHERE user_id = $1 AND fingerprint = $2 AND status IN ${OPEN}`, [userId, finding.fingerprint])).rows[0];
    if (existing) {
      const previous = parse(existing.detail, {});
      const merged = JSON.stringify({ ...finding.detail, timeline: { ...finding.detail.timeline, firstSeenAt: Number(existing.first_seen_at), seen: [...(previous.timeline?.seen || []), at].slice(-50) } }).slice(0, 60_000);
      const label = existing.label === "confirmed-fault" ? "confirmed-fault" : finding.label;
      await db.query("UPDATE hannah_maint_findings SET detail = $1, last_seen_at = $2, occurrences = occurrences + 1, confidence = $3, priority = $4, title = $5, label = $6, updated_at = $2 WHERE user_id = $7 AND id = $8", [merged, at, finding.confidence, existing.label === "confirmed-fault" ? existing.priority : finding.priority, finding.title, label, userId, existing.id]);
      return { id: existing.id, created: false };
    }
    const id = `mf_${crypto.randomBytes(8).toString("hex")}`;
    await db.query(
      `INSERT INTO hannah_maint_findings (user_id, id, fingerprint, asset_id, asset_kind, component, metric, label, detector, status, priority, confidence, simulated, title, detail, first_seen_at, last_seen_at, occurrences, confirmation, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, $12, $13, $14, $15, $15, 1, $16, $15, $15)`,
      [userId, id, finding.fingerprint, finding.assetId, finding.assetKind, finding.component, finding.metric || null, finding.label, finding.detector, finding.priority, finding.confidence, finding.simulated ? 1 : 0, finding.title, JSON.stringify({ ...finding.detail, timeline: { ...finding.detail.timeline, firstSeenAt: at, seen: [at] } }).slice(0, 60_000), at, finding.confirmation ? JSON.stringify(finding.confirmation) : null],
    );
    await audit(db, { userId, area: "maintenance", subjectId: id, actor: "maintenance analysis", event: `finding-opened:${finding.label}`, detail: { assetId: finding.assetId, component: finding.component, metric: finding.metric, detector: finding.detector, priority: finding.priority }, at });
    if (emit && finding.priority === "high" && !finding.simulated) void Promise.resolve(emit(userId, "robot.alert", { kind: "maintenance", findingId: id, assetId: finding.assetId, title: finding.title, label: finding.label })).catch(() => {});
    return { id, created: true };
  }

  /** A fault code the robot reported: the only automatic route to "confirmed fault". */
  async function reportedFault(db, userId, { assetId, assetKind, simulated, component, code, message, source, at }) {
    const fingerprint = `${assetId}|${component}|fault|${code}`;
    const open = (await db.query(`SELECT id FROM hannah_maint_findings WHERE user_id = $1 AND fingerprint = $2 AND status IN ${OPEN}`, [userId, fingerprint])).rows[0];
    if (open) { await db.query("UPDATE hannah_maint_findings SET last_seen_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, userId, open.id]); return open.id; }
    const hardware = component.startsWith("motor") || component.startsWith("controller");
    const saved = await saveFinding(db, userId, {
      fingerprint, assetId, assetKind, component, metric: null, label: "confirmed-fault", detector: "controller-fault-code", priority: "high", confidence: 1, simulated,
      title: `${component}: fault ${code} reported`,
      confirmation: { by: "controller", code, source, message, at },
      detail: {
        description: `The ${source} reported fault code ${code}${message ? `: ${message}` : ""}. This is the device's own report, not an inference.`,
        evidence: [{ detector: "controller-fault-code", statement: `Fault code ${code} in the robot's report at ${new Date(at).toISOString()}.`, stats: { code, source } }],
        measurements: null, timeline: { lastSeenAt: at },
        possibleCauses: hardware ? catalog.causesFor("errorCount", component) : ["See the fault code in the device's documentation"], causesStatus: "possible, not confirmed: the fault is confirmed, its cause is not",
        inspection: ["Look up the fault code in the controller's documentation", "Fix the cause before the fault is cleared at the robot. HANNAH never clears a fault."],
        failureDateNote: NO_DATE,
      },
    }, at);
    return saved.id;
  }

  // ---------- analysis ----------
  async function replacementSince(db, userId, assetId, component) {
    const row = (await db.query("SELECT MAX(at) AS at FROM hannah_robot_maintenance WHERE user_id = $1 AND robot_id = $2 AND kind = 'replacement' AND (component = $3 OR component = $4)", [userId, assetId, component, component.split(":")[0]]).catch(() => ({ rows: [] }))).rows[0];
    return Number(row?.at) || 0;
  }
  async function limitOverrides(db, userId) {
    const row = (await db.query("SELECT value FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, "maintenance.limits"])).rows[0];
    return parse(row?.value, {}) || {};
  }

  const hourly = (buckets) => {
    const groups = new Map();
    for (const bucket of buckets) {
      const hour = Math.floor(bucket.at / HOUR) * HOUR;
      const entry = groups.get(hour) || { at: hour, sum: 0, n: 0 };
      entry.sum += bucket.mean * bucket.n; entry.n += bucket.n;
      groups.set(hour, entry);
    }
    return [...groups.values()].sort((a, b) => a.at - b.at).map((entry) => ({ at: entry.at, value: entry.sum / entry.n }));
  };
  const statsOf = (values) => (values.length ? { n: values.length, mean: r(d.mean(values)), min: r(Math.min(...values)), max: r(Math.max(...values)), last: r(values[values.length - 1]) } : { n: 0 });
  const metricBase = (metric) => (metric.startsWith("sensorBias") ? "sensorBias" : metric);

  /** Detectors over one series. Returns finding drafts (measured anomalies only). */
  function analyzeSeries({ assetItem, component, metric, buckets, at, overrides }) {
    const drafts = [];
    const info = catalog.metricInfo(metricBase(metric));
    const unit = buckets[buckets.length - 1]?.unit || info.unit || "";
    const simulated = buckets.some((bucket) => bucket.source === "simulation") || assetItem.simulated;
    const recent = buckets.filter((bucket) => bucket.at >= at - RECENT_MS);
    const history = buckets.filter((bucket) => bucket.at < at - RECENT_MS);
    if (!recent.length) return { drafts, baseline: null, coverage: { recent: 0, history: history.length } };
    const recentPoints = recent.map((bucket) => ({ at: bucket.at, value: bucket.mean }));
    const baseline = history.length >= MIN_BASELINE ? d.baselineOf(history.map((bucket) => bucket.mean)) : null;
    const volume = baseline ? clamp01(baseline.n / 288) : 0.5;
    const measurements = { unit, recent: statsOf(recent.map((bucket) => bucket.mean)), recentPeak: r(Math.max(...recent.map((bucket) => bucket.max))), baseline: baseline ? { n: baseline.n, median: r(baseline.median), mean: r(baseline.mean), std: r(baseline.std), p05: r(baseline.p05), p95: r(baseline.p95), from: history[0].at, to: history[history.length - 1].at } : null };
    const timelinePoints = hourly(buckets.filter((bucket) => bucket.at >= at - 2 * DAY)).map((point) => ({ at: point.at, value: r(point.value) }));
    const concernOf = (direction) => info.concern === "both" || info.concern === direction;
    const draft = (kind, detector, { title, description, evidence, confidence, direction, priority }) => {
      const concerning = concernOf(direction);
      drafts.push({
        fingerprint: `${assetItem.id}|${component}|${metric}|${kind}`, assetId: assetItem.id, assetKind: assetItem.kind, component, metric, label: "measured-anomaly", detector,
        priority: simulated ? "low" : priority || (concerning ? "medium" : "low"), confidence: r(clamp01(confidence) * (kind === "threshold" ? 1 : 0.5 + 0.5 * volume), 2), simulated, title, direction,
        detail: {
          description, direction, evidence, measurements, timeline: { lastSeenAt: at, points: timelinePoints },
          possibleCauses: concerning ? catalog.causesFor(metricBase(metric), component) : ["A change in how the robot was used", "A sensor or reading problem"], causesStatus: "possible, not confirmed",
          inspection: catalog.inspectionFor(metricBase(metric), component), failureDateNote: NO_DATE,
          ...(simulated ? { simulationNote: "From a simulated robot or device. It says nothing about physical hardware." } : {}),
        },
      });
    };
    const label = `${component} ${info.label}`;
    const fmt = (value) => `${r(value, 2)}${unit ? ` ${unit}` : ""}`;

    // 1. Thresholds on the recent peaks.
    const limits = catalog.limitsFor(metricBase(metric), component, overrides);
    if (limits) {
      const direction = info.concern === "down" ? "below" : "above";
      const hits = d.threshold(recent.map((bucket) => ({ at: bucket.at, value: direction === "below" ? bucket.min : bucket.max })), { ...limits, direction });
      if (hits.length) {
        const critical = hits.some((hit) => hit.level === "critical");
        const worst = hits.reduce((a, b) => (direction === "below" ? (b.value < a.value ? b : a) : (b.value > a.value ? b : a)));
        draft("threshold", "threshold", {
          title: `${label} ${direction} its ${critical ? "critical" : "warning"} limit`, direction: direction === "below" ? "down" : "up", priority: critical ? "high" : "medium", confidence: critical ? 0.95 : 0.8,
          description: `In the last 24 hours ${label} went ${direction} ${fmt(worst.limit)} (${limits.source}) in ${hits.length} five-minute period${hits.length === 1 ? "" : "s"}; the extreme was ${fmt(worst.value)}.`,
          evidence: [{ detector: "threshold", statement: `${hits.length} of ${recent.length} recent periods past the limit; extreme ${fmt(worst.value)} at ${new Date(worst.at).toISOString()}.`, stats: { warn: limits.warn ?? null, critical: limits.critical ?? null, limitSource: limits.source, hits: hits.length } }],
        });
      }
    }
    if (!baseline) return { drafts, baseline: null, coverage: { recent: recent.length, history: history.length } };

    // 2. Point anomalies (robust z).
    const spikes = d.robustZ(recentPoints, baseline, { limit: 4 });
    const strongest = spikes.reduce((a, b) => (!a || Math.abs(b.z) > Math.abs(a.z) ? b : a), null);
    if (spikes.length >= 2 || (strongest && Math.abs(strongest.z) >= 6)) {
      const direction = strongest.z > 0 ? "up" : "down";
      draft("spike", "robust-z", {
        title: `${label}: unusual ${direction === "up" ? "highs" : "lows"}`, direction, confidence: 1 - Math.exp(-(Math.abs(strongest.z) - 3.5) / 2) * (spikes.length >= 3 ? 0.7 : 1),
        description: `${spikes.length} five-minute average${spikes.length === 1 ? "" : "s"} in the last 24 hours ${spikes.length === 1 ? "was" : "were"} more than 4 robust standard deviations from this component's usual ${fmt(baseline.median)}; the furthest was ${fmt(strongest.value)} (z = ${strongest.z}).`,
        evidence: [{ detector: "robust-z", statement: `Median ${fmt(baseline.median)}, robust spread ${fmt(baseline.scale)} from ${baseline.n} earlier periods; ${spikes.length} recent periods past |z| > 4.`, stats: { hits: spikes.length, maxZ: strongest.z, baselineN: baseline.n } }],
      });
    }
    // 3. Sustained shift (EWMA).
    const shift = d.ewma(recentPoints, baseline);
    if (shift.shifted) {
      const direction = shift.last > baseline.mean ? "up" : "down";
      const beyond = Math.abs(shift.last - baseline.mean) / Math.max(1e-9, Math.abs((direction === "up" ? shift.upper : shift.lower) - baseline.mean));
      draft("shift", "ewma", {
        title: `${label}: sustained ${direction === "up" ? "rise" : "drop"}`, direction, confidence: clamp01(0.55 + 0.3 * Math.min(1, beyond - 1)),
        description: `The moving average of ${label} has been ${direction === "up" ? "above" : "below"} its control limit (${fmt(direction === "up" ? shift.upper : shift.lower)}) since ${new Date(shift.hits[0].at).toISOString()}; it is now ${fmt(shift.last)} against a usual ${fmt(baseline.mean)}.`,
        evidence: [{ detector: "ewma", statement: `EWMA (λ 0.2, limits ±3.5σ·√(λ/(2−λ))) outside the limits in ${shift.hits.length} recent periods.`, stats: { upper: shift.upper, lower: shift.lower, last: shift.last, baselineMean: r(baseline.mean), baselineStd: r(baseline.std) } }],
      });
    }
    // 4. Trend over the last 7 days of hourly averages.
    const trendPoints = hourly(buckets.filter((bucket) => bucket.at >= at - TREND_MS));
    const slope = d.trend(trendPoints, { alpha: 0.01, minPoints: 24, spread: baseline.std || baseline.scale, minRelative: 1 });
    if (slope.trending && concernOf(slope.direction)) {
      draft("trend", "trend", {
        title: `${label}: ${slope.direction === "up" ? "rising" : "falling"} over ${slope.spanDays} days`, direction: slope.direction, confidence: clamp01(1 - slope.p * 50),
        description: `Hourly averages of ${label} ${slope.direction === "up" ? "rose" : "fell"} by about ${fmt(Math.abs(slope.changeOverWindow))} over ${slope.spanDays} days (${fmt(slope.slopePerDay)} per day, Theil-Sen). The rise is significant (Mann-Kendall p = ${slope.p}).`,
        evidence: [{ detector: "trend", statement: `${slope.n} hourly averages; Theil-Sen slope ${fmt(slope.slopePerDay)}/day; Mann-Kendall z = ${slope.z}, p = ${slope.p}.`, stats: slope }],
      });
    }
    // 5. Hour of day, when the history covers at least three days.
    if (history.length && history[history.length - 1].at - history[0].at >= 3 * DAY) {
      const profile = d.seasonalProfile(history.map((bucket) => ({ at: bucket.at, value: bucket.mean })));
      const odd = d.seasonal(recentPoints, profile, { limit: 4.5, floor: 0.5 * (baseline.scale || 0) });
      if (odd.length >= 3) {
        const direction = d.mean(odd.map((hit) => hit.z)) > 0 ? "up" : "down";
        draft("seasonal", "seasonal", {
          title: `${label}: unusual for the time of day`, direction, confidence: clamp01(0.4 + 0.1 * odd.length),
          description: `${odd.length} recent periods were far from what this component usually measures at that hour (for example ${fmt(odd[0].value)} at ${odd[0].hour}:00 UTC, where it is usually ${fmt(odd[0].hourMedian)}).`,
          evidence: [{ detector: "seasonal", statement: `Hour-of-day medians from ${history.length} earlier periods; ${odd.length} recent periods past 4.5 robust deviations from their hour.`, stats: { hits: odd.length, examples: odd.slice(0, 5) } }],
        });
      }
    }
    return { drafts, baseline, coverage: { recent: recent.length, history: history.length } };
  }

  /** Isolation forest over the metrics of one component that share buckets. */
  function analyzeMultivariate({ assetItem, component, bySeries, at }) {
    const metrics = Object.keys(bySeries).filter((metric) => bySeries[metric].length >= 64).sort();
    if (metrics.length < 2) return null;
    const maps = metrics.map((metric) => new Map(bySeries[metric].map((bucket) => [bucket.at, bucket.mean])));
    const times = [...maps[0].keys()].filter((time) => maps.every((map) => map.has(time))).sort((a, b) => a - b);
    const history = times.filter((time) => time < at - RECENT_MS);
    const recent = times.filter((time) => time >= at - RECENT_MS);
    if (history.length < 64 || !recent.length) return null;
    const vector = (time) => maps.map((map) => map.get(time));
    const model = d.isolationForest(history.map(vector), { trees: 100, sampleSize: 128, seed: 7, contamination: 0.01 });
    if (!model) return null;
    const flagged = recent.map((time) => ({ at: time, score: model.score(vector(time)), values: vector(time) })).filter((item) => item.score > model.threshold);
    if (flagged.length < 2) return null;
    const top = flagged.reduce((a, b) => (b.score > a.score ? b : a));
    const simulated = assetItem.simulated || Object.values(bySeries).some((list) => list.some((bucket) => bucket.source === "simulation"));
    return {
      fingerprint: `${assetItem.id}|${component}|${metrics.join("+")}|multivariate`, assetId: assetItem.id, assetKind: assetItem.kind, component, metric: metrics.join("+"), label: "measured-anomaly", detector: "isolation-forest",
      priority: "low", confidence: r(clamp01(0.4 + (top.score - model.threshold) * 2), 2), simulated, title: `${component}: unusual combination of ${metrics.map((metric) => catalog.metricInfo(metricBase(metric)).label).join(" and ")}`,
      detail: {
        description: `${flagged.length} recent periods had a combination of ${metrics.join(", ")} that rarely occurred together in this component's history, although each value alone may be in range (for example ${metrics.map((metric, index) => `${metric} ${r(top.values[index], 2)}`).join(", ")}).`,
        evidence: [{ detector: "isolation-forest", statement: `Isolation forest (100 trees, seeded) trained on ${history.length} earlier periods; ${flagged.length} recent periods scored above ${r(model.threshold, 3)} (top ${r(top.score, 3)}).`, stats: { trained: history.length, threshold: r(model.threshold, 3), flagged: flagged.length } }],
        measurements: null, timeline: { lastSeenAt: at }, possibleCauses: ["A changed relationship between these measurements, for example heat without the usual load"], causesStatus: "possible, not confirmed",
        inspection: catalog.inspectionFor(metricBase(metrics[0]), component), failureDateNote: NO_DATE, ...(simulated ? { simulationNote: "From a simulated robot or device. It says nothing about physical hardware." } : {}),
      },
    };
  }

  /** Event rates for a robot: link losses, controller faults, navigation failures, mission success. */
  async function analyzeRates(db, userId, robot, at) {
    const drafts = [];
    const exposureDays = Math.max(0, Math.min(29, (at - RECENT_MS - robot.since) / DAY));
    if (exposureDays < 3) return drafts;
    const since = at - RECENT_MS - exposureDays * DAY;
    const events = (await db.query("SELECT type, at FROM hannah_robot_events WHERE user_id = $1 AND robot_id = $2 AND at >= $3", [userId, robot.id, since])).rows.map((row) => ({ type: row.type, at: Number(row.at) }));
    const missions = (await db.query("SELECT capability, status, created_at, error FROM hannah_robot_missions WHERE user_id = $1 AND robot_id = $2 AND created_at >= $3", [userId, robot.id, since])).rows.map((row) => ({ capability: row.capability, status: row.status, at: Number(row.created_at), error: row.error }));
    const split = (items) => ({ recent: items.filter((item) => item.at >= at - RECENT_MS).length, base: items.filter((item) => item.at < at - RECENT_MS).length });
    const rateDraft = (metric, component, items, noun) => {
      const counts = split(items);
      const test = d.rateChange({ recentCount: counts.recent, recentExposure: 1, baseCount: counts.base, baseExposure: exposureDays });
      if (!test.raised) return;
      const info = catalog.metricInfo(metric);
      drafts.push({
        fingerprint: `${robot.id}|${component}|${metric}|rate`, assetId: robot.id, assetKind: "robot", component, metric, label: "measured-anomaly", detector: "rate",
        priority: robot.simulated ? "low" : "medium", confidence: r(clamp01(1 - test.p * 50), 2), simulated: robot.simulated, title: `More ${noun} than usual`, direction: "up",
        detail: {
          description: `${counts.recent} ${noun} in the last 24 hours against a usual ${test.baseRate} a day over the previous ${r(exposureDays, 1)} days.`,
          evidence: [{ detector: "rate", statement: `Poisson test: expected ${test.expected}, z = ${test.z}, p = ${test.p}.`, stats: { ...test, recent: counts.recent, base: counts.base, baseDays: r(exposureDays, 1) } }],
          measurements: { unit: info.unit, recent: { n: counts.recent }, baseline: { perDay: test.baseRate, days: r(exposureDays, 1) } }, timeline: { lastSeenAt: at },
          possibleCauses: catalog.causesFor(metric, component), causesStatus: "possible, not confirmed", inspection: catalog.inspectionFor(metric, component), failureDateNote: NO_DATE,
          ...(robot.simulated ? { simulationNote: "From a simulated robot. It says nothing about physical hardware." } : {}),
        },
      });
    };
    rateDraft("linkLossesPerDay", "link", events.filter((event) => event.type === "link-lost"), "link losses");
    rateDraft("controllerFaultsPerDay", "controller", events.filter((event) => event.type === "fault"), "controller faults");
    const nav = missions.filter((mission) => NAV_CAPABILITIES.has(mission.capability));
    rateDraft("navFailuresPerDay", "navigation", nav.filter((mission) => BAD_MISSION.has(mission.status)), "navigation failures");
    // Mission success: share of finished missions that failed, recent week against before.
    const ended = missions.filter((mission) => mission.capability !== "stop_motion" && ["succeeded", "unverified", ...BAD_MISSION].includes(mission.status));
    const week = ended.filter((mission) => mission.at >= at - 7 * DAY);
    const before = ended.filter((mission) => mission.at < at - 7 * DAY);
    if (week.length >= 5 && before.length >= 10) {
      const bad = (list) => list.filter((mission) => BAD_MISSION.has(mission.status)).length;
      const test = d.rateChange({ recentCount: bad(week), recentExposure: week.length, baseCount: bad(before), baseExposure: before.length });
      if (test.raised) {
        drafts.push({
          fingerprint: `${robot.id}|missions|missionSuccessRate|rate`, assetId: robot.id, assetKind: "robot", component: "missions", metric: "missionSuccessRate", label: "measured-anomaly", detector: "rate",
          priority: robot.simulated ? "low" : "medium", confidence: r(clamp01(1 - test.p * 50), 2), simulated: robot.simulated, title: "Missions failing more often", direction: "down",
          detail: {
            description: `${bad(week)} of ${week.length} missions in the last 7 days failed, timed out or were lost, against ${bad(before)} of ${before.length} before.`,
            evidence: [{ detector: "rate", statement: `Failure share ${r(bad(week) / week.length, 3)} against ${r(bad(before) / before.length, 3)}; z = ${test.z}, p = ${test.p}.`, stats: test }],
            measurements: { unit: "share", recent: { n: week.length, successRate: r(1 - bad(week) / week.length, 3) }, baseline: { n: before.length, successRate: r(1 - bad(before) / before.length, 3) } }, timeline: { lastSeenAt: at },
            possibleCauses: catalog.causesFor("missionSuccessRate", "missions"), causesStatus: "possible, not confirmed", inspection: catalog.inspectionFor("missionSuccessRate", "missions"), failureDateNote: NO_DATE,
          },
        });
      }
    }
    return drafts;
  }

  /** Fixed rules that link two measured anomalies into a suspected cause. Never confirmed by this. */
  function correlate(drafts, assetItem) {
    const out = [];
    const find = (predicate) => drafts.find((item) => item.label === "measured-anomaly" && predicate(item));
    const motors = [...new Set(drafts.filter((item) => item.component.startsWith("motor:")).map((item) => item.component))];
    const suspect = (key, component, title, description, members, causes, inspection) => out.push({
      fingerprint: `${assetItem.id}|${component}|${key}|suspected`, assetId: assetItem.id, assetKind: assetItem.kind, component, metric: null, label: "suspected-cause", detector: "correlation",
      priority: assetItem.simulated ? "low" : "medium", confidence: r(Math.min(...members.map((item) => item.confidence)) * 0.8, 2), simulated: members.some((item) => item.simulated), title,
      detail: { description, evidence: members.map((item) => ({ detector: item.detector, statement: item.title, findingFingerprint: item.fingerprint })), measurements: null, timeline: { lastSeenAt: now() }, possibleCauses: causes, causesStatus: "suspected, not confirmed: a person confirms it after inspection", inspection, failureDateNote: NO_DATE, members: members.map((item) => item.fingerprint) },
    });
    for (const motor of motors) {
      const hot = find((item) => item.component === motor && item.metric === "temperatureC" && item.direction === "up");
      const loaded = find((item) => item.component === motor && item.metric === "currentA" && item.direction === "up");
      if (hot && loaded) suspect("load", motor, `${motor}: suspected extra mechanical load or friction`, `Both the temperature and the current of ${motor} are higher than usual. Together they fit extra load or friction (for example bearing wear or debris), which only an inspection can confirm.`, [hot, loaded], ["Bearing or gearbox wear", "Debris or a dragging brake", "A heavier payload"], catalog.inspectionFor("currentA", motor));
      const slip = find((item) => item.component === motor && item.metric === "encoderResidualMps" && item.direction === "up");
      const nav = find((item) => item.metric === "navFailuresPerDay");
      if (slip && nav) suspect("slip", motor, `${motor}: suspected wheel slip or encoder problem behind navigation failures`, `The encoder disagreement of ${motor} rose while navigation failures increased.`, [slip, nav], ["Wheel slip from worn tread", "A loose encoder or coupling"], catalog.inspectionFor("encoderResidualMps", motor));
    }
    const sag = find((item) => item.component === "battery" && item.metric === "voltageV" && item.direction === "down");
    const warm = find((item) => item.component === "battery" && (item.metric === "temperatureC" || item.metric === "currentA") && item.direction === "up");
    if (sag && warm) suspect("ageing", "battery", "Battery: suspected ageing or a poor connection", "The battery voltage is lower than usual while its temperature or current is higher, which fits higher internal resistance (ageing cells or a poor connector).", [sag, warm], ["Ageing cells", "A loose or corroded connector"], catalog.inspectionFor("voltageV", "battery"));
    const links = find((item) => item.metric === "linkLossesPerDay");
    const busy = find((item) => item.component === "computer" && item.direction === "up");
    if (links && busy) suspect("overload", "link", "Link losses: suspected overloaded computer", "Link losses rose while the robot's computer ran hotter or busier than usual.", [links, busy], ["Computer overload delaying the link", "Thermal throttling"], catalog.inspectionFor(busy.metric, "computer"));
    return out;
  }

  /** Run every detector for the account's assets (or one). Returns the report. */
  async function analyze(db, userId, { assetId = null } = {}) {
    const at = now();
    await ingestDeviceReadings(db, userId).catch(() => {});
    const overrides = await limitOverrides(db, userId);
    const list = (await assets(db, userId)).filter((item) => !assetId || item.id === assetId);
    const seen = new Set();
    const coverage = [];
    for (const assetItem of list) {
      const drafts = [];
      const keys = await seriesKeys(db, userId, assetItem.id);
      const byComponent = {};
      for (const key of keys) {
        const replaced = await replacementSince(db, userId, assetItem.id, key.component);
        const buckets = (await series(db, userId, assetItem.id, key.component, key.metric)).filter((bucket) => bucket.at >= replaced);
        const result = analyzeSeries({ assetItem, component: key.component, metric: key.metric, buckets, at, overrides });
        drafts.push(...result.drafts);
        coverage.push({ assetId: assetItem.id, component: key.component, metric: key.metric, unit: key.unit, buckets: buckets.length, recentBuckets: result.coverage.recent, baselineBuckets: result.coverage.history, baselineReady: Boolean(result.baseline), source: key.source, lastAt: key.lastAt, ...(replaced ? { since: replaced, sinceReason: "replacement" } : {}) });
        if (result.baseline) {
          await db.query(
            `INSERT INTO hannah_maint_baselines (user_id, asset_id, component, metric, computed_at, from_at, to_at, stats) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, asset_id, component, metric) DO UPDATE SET computed_at = excluded.computed_at, from_at = excluded.from_at, to_at = excluded.to_at, stats = excluded.stats`,
            [userId, assetItem.id, key.component, key.metric, at, buckets[0].at, at - RECENT_MS, JSON.stringify(result.baseline)],
          );
        }
        (byComponent[key.component] ||= {})[key.metric] = buckets;
      }
      for (const [component, bySeries] of Object.entries(byComponent)) { const multi = analyzeMultivariate({ assetItem, component, bySeries, at }); if (multi) drafts.push(multi); }
      if (assetItem.kind === "robot") drafts.push(...await analyzeRates(db, userId, assetItem, at));
      drafts.push(...correlate(drafts, assetItem));
      for (const draft of drafts) { await saveFinding(db, userId, draft, at); seen.add(draft.fingerprint); }
      // Measured findings no longer detected for three days are cleared (kept, with their verdicts).
      const stale = (await db.query(`SELECT id, fingerprint, last_seen_at, label FROM hannah_maint_findings WHERE user_id = $1 AND asset_id = $2 AND status IN ${OPEN} AND label <> 'confirmed-fault'`, [userId, assetItem.id])).rows;
      for (const row of stale) {
        if (seen.has(row.fingerprint) || at - Number(row.last_seen_at) < CLEAR_AFTER_MS) continue;
        await db.query("UPDATE hannah_maint_findings SET status = 'cleared', updated_at = $1 WHERE user_id = $2 AND id = $3", [at, userId, row.id]);
        await audit(db, { userId, area: "maintenance", subjectId: row.id, actor: "maintenance analysis", event: "finding-cleared", detail: { reason: "not detected for three days" }, at });
      }
    }
    return { analyzedAt: at, assets: list.length, coverage };
  }

  // ---------- reading findings ----------
  async function listFindings(db, userId, { assetId = null, status = "open", limit = 100 } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (assetId) { values.push(String(assetId)); where += ` AND asset_id = $${values.length}`; }
    if (status === "open") where += ` AND status IN ${OPEN}`;
    else if (status && status !== "all") { values.push(String(status)); where += ` AND status = $${values.length}`; }
    values.push(Math.max(1, Math.min(500, Number(limit) || 100)));
    const rows = (await db.query(`SELECT * FROM hannah_maint_findings WHERE ${where} ORDER BY last_seen_at DESC LIMIT $${values.length}`, values)).rows;
    const rank = { high: 0, medium: 1, low: 2 };
    const labelRank = { "confirmed-fault": 0, "suspected-cause": 1, "measured-anomaly": 2 };
    return rows.map(publicFinding).sort((a, b) => rank[a.priority] - rank[b.priority] || labelRank[a.label] - labelRank[b.label] || b.lastSeenAt - a.lastSeenAt);
  }
  async function getFinding(db, userId, id) {
    const row = (await db.query("SELECT * FROM hannah_maint_findings WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "That finding doesn't exist.", "not-found");
    return publicFinding(row);
  }

  /** Precision from the verdicts people gave, overall and per detector. Null where there are none. */
  async function precision(db, userId) {
    const { rows } = await db.query("SELECT detector, feedback, COUNT(*) AS n FROM hannah_maint_findings WHERE user_id = $1 AND feedback IS NOT NULL GROUP BY detector, feedback", [userId]);
    const awaiting = Number((await db.query("SELECT COUNT(*) AS n FROM hannah_maint_findings WHERE user_id = $1 AND feedback IS NULL AND label <> 'confirmed-fault'", [userId])).rows[0]?.n || 0);
    const by = {};
    for (const row of rows) { const entry = (by[row.detector] ||= { truePositives: 0, falsePositives: 0, unsure: 0 }); entry[row.feedback === "true-positive" ? "truePositives" : row.feedback === "false-positive" ? "falsePositives" : "unsure"] += Number(row.n); }
    const finish = (entry) => ({ ...entry, judged: entry.truePositives + entry.falsePositives, precision: entry.truePositives + entry.falsePositives ? r(entry.truePositives / (entry.truePositives + entry.falsePositives), 3) : null });
    const total = Object.values(by).reduce((sum, entry) => ({ truePositives: sum.truePositives + entry.truePositives, falsePositives: sum.falsePositives + entry.falsePositives, unsure: sum.unsure + entry.unsure }), { truePositives: 0, falsePositives: 0, unsure: 0 });
    return { overall: finish(total), byDetector: Object.fromEntries(Object.entries(by).map(([key, entry]) => [key, finish(entry)])), awaitingVerdict: awaiting, basis: "From the true and false positive verdicts people gave on findings. Findings without a verdict are not counted. Recall can't be measured here: a failure HANNAH didn't flag has no finding to judge." };
  }

  // ---------- people's verdicts and confirmations ----------
  async function setFeedback(db, userId, id, { verdict, note = "", by = "a signed-in person" } = {}) {
    if (!VERDICTS.includes(verdict)) throw fail(400, `The verdict must be one of ${VERDICTS.join(", ")}.`, "bad-request");
    const finding = await getFinding(db, userId, id);
    const at = now();
    const status = verdict === "false-positive" ? "dismissed" : finding.status;
    await db.query("UPDATE hannah_maint_findings SET feedback = $1, feedback_note = $2, feedback_at = $3, status = $4, updated_at = $3 WHERE user_id = $5 AND id = $6", [verdict, clean(note, 500) || null, at, status, userId, finding.id]);
    await audit(db, { userId, area: "maintenance", subjectId: finding.id, actor: by, event: `verdict:${verdict}`, detail: { note: clean(note, 500), previous: finding.feedback }, at });
    return getFinding(db, userId, finding.id);
  }
  /** A person confirms a finding after inspecting: the only way a measured anomaly or suspected cause becomes a confirmed fault. */
  async function confirmFinding(db, userId, id, { note = "", by = "a signed-in person" } = {}) {
    const finding = await getFinding(db, userId, id);
    const text = clean(note, 500);
    if (!text) throw fail(400, "Say what the inspection found. A confirmation needs what you saw.", "bad-request");
    const at = now();
    const confirmation = { by: "person", who: by, note: text, at, previousLabel: finding.label };
    await db.query("UPDATE hannah_maint_findings SET label = 'confirmed-fault', confirmation = $1, priority = 'high', feedback = COALESCE(feedback, 'true-positive'), feedback_at = COALESCE(feedback_at, $2), status = 'acknowledged', updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(confirmation), at, userId, finding.id]);
    await audit(db, { userId, area: "maintenance", subjectId: finding.id, actor: by, event: "finding-confirmed", detail: confirmation, at });
    return getFinding(db, userId, finding.id);
  }
  async function setStatus(db, userId, id, status, { by = "a signed-in person" } = {}) {
    if (!["acknowledged", "resolved", "open"].includes(status)) throw fail(400, "Status must be open, acknowledged or resolved.", "bad-request");
    const finding = await getFinding(db, userId, id);
    await db.query("UPDATE hannah_maint_findings SET status = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [status, now(), userId, finding.id]);
    await audit(db, { userId, area: "maintenance", subjectId: finding.id, actor: by, event: `finding-${status}` });
    return getFinding(db, userId, finding.id);
  }
  async function setLimits(db, userId, limits = {}, { by = "a signed-in person" } = {}) {
    const out = {};
    for (const [key, value] of Object.entries(limits || {}).slice(0, 100)) {
      if (!/^[a-z0-9_:.-]{1,80}\.[A-Za-z.]{2,40}$/.test(key) || !value || typeof value !== "object") continue;
      const entry = {};
      if (finite(value.warn)) entry.warn = value.warn;
      if (finite(value.critical)) entry.critical = value.critical;
      if (Object.keys(entry).length) out[key] = entry;
    }
    const at = now();
    const existing = (await db.query("SELECT version FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, "maintenance.limits"])).rows[0];
    if (existing) await db.query("UPDATE hannah_user_data SET value = $1, version = $2, updated_at = $3 WHERE user_id = $4 AND namespace = $5", [JSON.stringify(out), Number(existing.version) + 1, at, userId, "maintenance.limits"]);
    else await db.query("INSERT INTO hannah_user_data (user_id, namespace, value, version, updated_at) VALUES ($1, $2, $3, 1, $4)", [userId, "maintenance.limits", JSON.stringify(out), at]);
    await audit(db, { userId, area: "maintenance", actor: by, event: "limits-set", detail: out, at });
    return out;
  }

  // ---------- tasks, reminders, service history ----------
  function publicTask(row) {
    return { id: row.id, assetId: row.asset_id, component: row.component || null, findingId: row.finding_id || null, kind: row.kind, title: row.title, note: row.note || "", status: row.status, dueAt: row.due_at ? Number(row.due_at) : null, reminderId: row.reminder_id || null, createdAt: Number(row.created_at), doneAt: row.done_at ? Number(row.done_at) : null, doneNote: row.done_note || null, overdue: row.status === "open" && row.due_at ? Number(row.due_at) < now() : false };
  }
  /** A reminder in the person's synced reminders (the same list the Reminders screen and workflows use). */
  async function addReminder(db, userId, text, dueAt) {
    const at = now();
    const item = { id: crypto.randomUUID(), text: clean(text, 300), dueAt, createdAt: at, status: "scheduled" };
    await db.transaction(async (query) => {
      const { rows } = await query("SELECT value, version FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, "reminders"]);
      const list = Array.isArray(parse(rows[0]?.value, [])) ? parse(rows[0]?.value, []) : [];
      const next = JSON.stringify([...list, item].slice(-200));
      if (rows[0]) await query("UPDATE hannah_user_data SET value = $1, version = $2, updated_at = $3 WHERE user_id = $4 AND namespace = $5", [next, Number(rows[0].version) + 1, at, userId, "reminders"]);
      else await query("INSERT INTO hannah_user_data (user_id, namespace, value, version, updated_at) VALUES ($1, $2, $3, 1, $4)", [userId, "reminders", next, at]);
    });
    return item.id;
  }
  async function createTask(db, userId, input = {}, { by = "a signed-in person" } = {}) {
    const target = await asset(db, userId, input.assetId);
    const kind = TASK_KINDS.includes(input.kind) ? input.kind : "inspection";
    const finding = input.findingId ? await getFinding(db, userId, input.findingId) : null;
    if (finding && finding.assetId !== target.id) throw fail(400, "That finding belongs to another robot or device.", "bad-request");
    const title = clean(input.title, 160) || (finding ? `${kind[0].toUpperCase()}${kind.slice(1)}: ${finding.title}` : "");
    if (!title) throw fail(400, "Give the task a title.", "bad-request");
    const dueAt = input.dueAt === undefined || input.dueAt === null || input.dueAt === "" ? null : Number(new Date(input.dueAt));
    if (dueAt !== null && !Number.isFinite(dueAt)) throw fail(400, "The due date isn't a date.", "bad-request");
    const id = `mt_${crypto.randomBytes(8).toString("hex")}`;
    const at = now();
    const reminderId = input.remind && dueAt ? await addReminder(db, userId, `${target.name}: ${title}`, dueAt) : null;
    await db.query("INSERT INTO hannah_maint_tasks (user_id, id, asset_id, component, finding_id, kind, title, note, status, due_at, reminder_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $11)",
      [userId, id, target.id, clean(input.component || finding?.component, 60) || null, finding?.id || null, kind, title, clean(input.note, 1000) || null, dueAt, reminderId, at]);
    if (finding && finding.status === "open") await db.query("UPDATE hannah_maint_findings SET status = 'acknowledged', updated_at = $1 WHERE user_id = $2 AND id = $3", [at, userId, finding.id]);
    await audit(db, { userId, area: "maintenance", subjectId: id, actor: by, event: "task-created", detail: { assetId: target.id, kind, title, dueAt, findingId: finding?.id || null, reminder: Boolean(reminderId) }, at });
    return publicTask((await db.query("SELECT * FROM hannah_maint_tasks WHERE user_id = $1 AND id = $2", [userId, id])).rows[0]);
  }
  async function listTasks(db, userId, { assetId = null, status = null } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (assetId) { values.push(String(assetId)); where += ` AND asset_id = $${values.length}`; }
    if (status) { values.push(String(status)); where += ` AND status = $${values.length}`; }
    return (await db.query(`SELECT * FROM hannah_maint_tasks WHERE ${where} ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, COALESCE(due_at, created_at) LIMIT 200`, values)).rows.map(publicTask);
  }
  /** Finish a task: it goes into the service history; a replacement restarts that component's baseline. */
  async function completeTask(db, userId, id, { note = "", by = "a signed-in person" } = {}) {
    const row = (await db.query("SELECT * FROM hannah_maint_tasks WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "That task doesn't exist.", "not-found");
    if (row.status !== "open") throw fail(409, `That task is already ${row.status}.`, "already-closed");
    const text = clean(note, 500) || row.title;
    const at = now();
    await db.query("UPDATE hannah_maint_tasks SET status = 'done', done_at = $1, done_note = $2, updated_at = $1 WHERE user_id = $3 AND id = $4", [at, text, userId, row.id]);
    const historyKind = row.kind === "service" ? "note" : row.kind;
    await db.query("INSERT INTO hannah_robot_maintenance (user_id, id, robot_id, at, kind, note, component, task_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [userId, crypto.randomUUID(), row.asset_id, at, historyKind, text, row.component || null, row.id]);
    if (row.finding_id) await db.query("UPDATE hannah_maint_findings SET status = 'resolved', updated_at = $1 WHERE user_id = $2 AND id = $3", [at, userId, row.finding_id]);
    await audit(db, { userId, area: "maintenance", subjectId: row.id, actor: by, event: "task-completed", detail: { kind: row.kind, note: text, component: row.component, findingResolved: row.finding_id || null }, at });
    return publicTask((await db.query("SELECT * FROM hannah_maint_tasks WHERE user_id = $1 AND id = $2", [userId, row.id])).rows[0]);
  }
  async function cancelTask(db, userId, id, { by = "a signed-in person" } = {}) {
    const done = await db.query("UPDATE hannah_maint_tasks SET status = 'cancelled', updated_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'open'", [now(), userId, String(id || "")]);
    if (!done.rowCount) throw fail(404, "No open task with that id.", "not-found");
    await audit(db, { userId, area: "maintenance", subjectId: String(id), actor: by, event: "task-cancelled" });
    return publicTask((await db.query("SELECT * FROM hannah_maint_tasks WHERE user_id = $1 AND id = $2", [userId, String(id)])).rows[0]);
  }
  async function history(db, userId, assetId, limit = 100) {
    const { rows } = await db.query("SELECT * FROM hannah_robot_maintenance WHERE user_id = $1 AND robot_id = $2 ORDER BY at DESC LIMIT $3", [userId, String(assetId), Math.max(1, Math.min(500, Number(limit) || 100))]);
    return rows.map((row) => ({ id: row.id, at: Number(row.at), kind: row.kind, note: row.note, component: row.component || null, taskId: row.task_id || null }));
  }

  /** Everything for one asset or the account: what "is anything wearing out?" is answered from. */
  async function report(db, userId, { assetId = null, refresh = true } = {}) {
    const target = assetId ? await asset(db, userId, assetId) : null;
    const analysis = refresh ? await analyze(db, userId, { assetId: target?.id || null }) : null;
    const findings = await listFindings(db, userId, { assetId: target?.id || null });
    const list = target ? [target] : await assets(db, userId);
    const coverage = analysis?.coverage || [];
    return {
      at: now(), assets: list.map((item) => ({ id: item.id, kind: item.kind, name: item.name, simulated: item.simulated, measuredSeries: coverage.filter((entry) => entry.assetId === item.id).length })),
      findings, precision: await precision(db, userId), tasks: await listTasks(db, userId, { assetId: target?.id || null, status: "open" }),
      coverage, history: target ? await history(db, userId, target.id, 20) : [],
      summary: summarize(findings, coverage),
      basis: "Only measurements the robots, Robot OS and hubs reported, and the events and missions HANNAH recorded. No model was asked to judge their condition. Measured anomalies, suspected causes and confirmed faults are kept apart; nothing gets a failure date.",
    };
  }
  function summarize(findings, coverage) {
    if (!coverage.length && !findings.length) return "No maintenance measurements have been reported yet, so there is nothing to judge wear from. Robots report them when their runtime or Robot OS sends motor, battery or controller readings.";
    const physical = findings.filter((item) => !item.simulated);
    const confirmed = physical.filter((item) => item.label === "confirmed-fault").length;
    const suspected = physical.filter((item) => item.label === "suspected-cause").length;
    const measured = physical.filter((item) => item.label === "measured-anomaly").length;
    const simulated = findings.length - physical.length;
    const ready = coverage.filter((entry) => entry.baselineReady).length;
    const parts = [];
    if (!physical.length) parts.push("Nothing unusual in the measurements of physical hardware.");
    else parts.push(`${confirmed} confirmed fault${confirmed === 1 ? "" : "s"}, ${suspected} suspected cause${suspected === 1 ? "" : "s"} and ${measured} measured anomal${measured === 1 ? "y" : "ies"} on physical hardware.`);
    if (simulated) parts.push(`${simulated} finding${simulated === 1 ? "" : "s"} from simulated robots or devices (not physical hardware).`);
    parts.push(`${ready} of ${coverage.length} measured series have enough history for a baseline.`);
    return parts.join(" ");
  }

  return { analyze, assets, asset, cancelTask, completeTask, confirmFinding, createTask, getFinding, history, ingestDeviceReadings, listFindings, listTasks, precision, record, recordRobotOSFeatures, recordRobotState, report, series, seriesKeys, setFeedback, setLimits, setStatus, BUCKET_MS };
}

module.exports = { BUCKET_MS, LABELS, NO_DATE, TASK_KINDS, VERDICTS, createMaintenanceService };
