"use strict";

// Predictive maintenance against the real server and database, with a
// stand-in robot that reports whatever the test scripts. The history is
// synthetic: generated here with anomalies injected into known series, so the
// detectors' precision and recall over whole robots can be measured. None of
// it is a physical measurement.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "maintenance-test-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "d".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");
const { createMaintenanceService } = require("./maintenance/service");
const d = require("./maintenance/detectors");

let server;
let base;
let db;
const users = {};
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
};
const physical = () => descriptor({ simulation: null, limits: { ...descriptor().limits, environment: "shared-with-people", estop: { hardware: true, description: "red button" } } });
async function enrolled(who, name, { simulated = false } = {}) {
  const created = await call(who, "POST", "/robots", { name, simulated });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  const answer = await robot.enroll(created.body.enrollment.code, simulated ? descriptor() : physical());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return robot;
}

const HOUR = 3_600_000;
const STEP = 10 * 60_000;
function gaussian(random) { const u = Math.max(1e-12, random()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random()); }
/** Four days of history and twenty hours of recent values, one every ten minutes. `inject` changes the recent ones. */
async function seed(service, userId, robotId, component, metric, { mu, sigma, seed: s, inject = null, unit = "", source = "physical" }) {
  const random = d.seeded(s);
  const end = Date.now() - 60_000;
  for (let at = end - 4 * 24 * HOUR; at <= end; at += STEP) {
    const recent = at >= end - 20 * HOUR;
    let value = mu + sigma * gaussian(random);
    if (recent && inject) value = inject(value, (at - (end - 20 * HOUR)) / (20 * HOUR));
    await service.record(db, userId, { assetId: robotId, component, metric, value, unit, source, at });
  }
}

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["mira", "otto"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@maintenance.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@maintenance.example`])).rows[0].id;
  }
  const key = await call(users.mira, "POST", "/account/api-keys", { name: "agent" });
  users.miraKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("a robot's reported motor, battery and controller readings are stored as series; nothing invented, broken readings dropped", async () => {
  const robot = await enrolled(users.mira, "Mule");
  const reported = state({ motors: [{ id: "left", temperatureC: 41.5, currentA: 3.2 }, { id: "right", temperature_c: 40.1, current_a: 3.0, voltageV: "24" }], battery: { percent: 80, voltageV: 25.2, temperatureC: 9999 }, compute: { cpuPercent: 37 } });
  assert.equal((await robot.sync({ send: reported })).status, 200);
  const series = (await call(users.mira, "GET", `/maintenance/series?asset=${robot.robotId}`)).body.series;
  const keys = series.map((item) => `${item.component}.${item.metric}`).sort();
  assert.deepEqual(keys, ["battery.voltageV", "computer.cpuPercent", "motor:left.currentA", "motor:left.temperatureC", "motor:right.currentA", "motor:right.temperatureC"], "a string voltage and a 9999 °C battery are not measurements");
  assert.ok(series.every((item) => item.source === "physical"));
  const buckets = (await call(users.mira, "GET", `/maintenance/series?asset=${robot.robotId}&component=motor:left&metric=temperatureC`)).body.buckets;
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].mean, 41.5);
  // Another account sees nothing of it.
  assert.equal((await call(users.otto, "GET", `/maintenance/series?asset=${robot.robotId}`)).status, 404);
  // With no history there is no baseline and nothing is judged.
  const report = (await call(users.mira, "GET", `/maintenance?asset=${robot.robotId}`)).body;
  assert.equal(report.findings.length, 0);
  assert.ok(report.coverage.every((entry) => entry.baselineReady === false));
  assert.match(report.basis, /No model was asked/);
});

test("detectors over whole robots: injected wear is found with measured precision and recall, clean series stay quiet, and a suspected cause links two anomalies", async () => {
  const service = createMaintenanceService();
  const robot = await enrolled(users.mira, "Hauler");
  const userId = users.miraId;
  // Truth: which (component.metric) series carry an injected change.
  const plan = [
    { component: "motor:left", metric: "temperatureC", mu: 40, sigma: 1, inject: (v, f) => v + 4 + 8 * f, anomalous: true },
    { component: "motor:left", metric: "currentA", mu: 3, sigma: 0.2, inject: (v) => v + 1.2, anomalous: true },
    { component: "motor:right", metric: "temperatureC", mu: 40, sigma: 1, anomalous: false },
    { component: "motor:right", metric: "currentA", mu: 3, sigma: 0.2, anomalous: false },
    { component: "battery", metric: "voltageV", mu: 25, sigma: 0.1, inject: (v) => v - 0.8, anomalous: true },
    { component: "battery", metric: "temperatureC", mu: 22, sigma: 0.5, anomalous: false },
    { component: "controller:main", metric: "temperatureC", mu: 50, sigma: 1.5, inject: (v, f) => (f > 0.5 && f < 0.6 ? v + 15 : v), anomalous: true },
    { component: "motor:left", metric: "encoderResidualMps", mu: 0.02, sigma: 0.005, anomalous: false },
    { component: "base", metric: "vibrationRms", mu: 0.3, sigma: 0.03, anomalous: false },
    { component: "computer", metric: "cpuPercent", mu: 35, sigma: 4, anomalous: false },
  ];
  let s = 11;
  for (const item of plan) await seed(service, userId, robot.robotId, item.component, item.metric, { mu: item.mu, sigma: item.sigma, seed: (s += 7), inject: item.inject });
  const analysis = await call(users.mira, "POST", "/maintenance/analyze", { asset: robot.robotId });
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  const findings = (await call(users.mira, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings;
  const measured = findings.filter((item) => item.label === "measured-anomaly" && item.detector !== "isolation-forest");
  const detected = [...new Set(measured.map((item) => `${item.component}.${item.metric}`))];
  const truth = plan.filter((item) => item.anomalous).map((item) => `${item.component}.${item.metric}`);
  const tp = detected.filter((key) => truth.includes(key)).length;
  const precision = detected.length ? tp / detected.length : 0;
  const recall = tp / truth.length;
  assert.ok(recall >= 0.99, `recall ${recall}: detected ${detected.join(", ")}`);
  assert.ok(precision >= 0.99, `precision ${precision}: detected ${detected.join(", ")}`);

  // What each finding carries: evidence, measurements, timeline, confidence, causes, inspection, priority; never a date.
  for (const finding of measured) {
    assert.ok(finding.evidence.length && finding.evidence[0].statement, "evidence cited");
    assert.ok(finding.measurements?.baseline?.n > 0, "the baseline it was compared with");
    assert.ok(finding.timeline.points.length > 0);
    assert.ok(finding.confidence > 0 && finding.confidence <= 1);
    assert.match(finding.confidenceMeans, /not a probability of failure/);
    assert.ok(finding.possibleCauses.length && /not confirmed/.test(finding.causesStatus));
    assert.ok(finding.inspection.length);
    assert.ok(["high", "medium", "low"].includes(finding.priority));
    assert.equal(finding.failureDate, null);
    assert.match(finding.failureDateNote, /no failure date/);
    assert.equal(finding.simulated, false);
  }
  assert.ok(measured.some((item) => item.component === "controller:main" && ["robust-z", "threshold"].includes(item.detector)), "the short controller spike is a point anomaly");
  const suspected = findings.find((item) => item.label === "suspected-cause" && item.component === "motor:left");
  assert.ok(suspected, "hotter AND drawing more current: a suspected cause");
  assert.match(suspected.title, /suspected/);
  assert.match(suspected.causesStatus, /not confirmed/);
  assert.ok(suspected.members.length >= 2);
  assert.equal(findings.find((item) => item.label === "suspected-cause" && item.component === "battery"), undefined, "a voltage sag without a temperature or current rise is not linked to ageing");
  assert.equal(findings.filter((item) => item.label === "confirmed-fault").length, 0, "nothing is confirmed by analysis");

  // Analysing again updates, it doesn't duplicate.
  await call(users.mira, "POST", "/maintenance/analyze", { asset: robot.robotId });
  const again = (await call(users.mira, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings;
  assert.equal(again.length, findings.length);
  assert.ok(again.some((item) => item.occurrences === 2));
  // Baselines persisted.
  const baselines = (await db.query("SELECT COUNT(*) AS n FROM hannah_maint_baselines WHERE user_id = $1 AND asset_id = $2", [userId, robot.robotId])).rows[0];
  assert.equal(Number(baselines.n), plan.length);
  // Nothing was sent to the robot.
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_missions WHERE robot_id = $1", [robot.robotId])).rows[0].n), 0);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_os_commands WHERE robot_id = $1", [robot.robotId])).rows[0].n), 0);
});

test("a controller-reported fault code is a confirmed fault; nothing else becomes one without a person", async () => {
  const robot = await enrolled(users.mira, "Faulty");
  await robot.sync({ send: state({ faults: [{ code: "VESC-6", message: "motor over temperature", source: "motor-controller", motor: "left" }, { message: "no code", source: "motor-controller" }, { code: "odometry-stale", message: "the runtime's own observation" }] }) });
  const findings = (await call(users.mira, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings;
  assert.equal(findings.length, 1, "a fault without a code, or one no controller reported, is not a controller fault code");
  assert.equal(findings[0].label, "confirmed-fault");
  assert.equal(findings[0].confirmation.by, "controller");
  assert.equal(findings[0].confirmation.code, "VESC-6");
  assert.equal(findings[0].component, "motor:left");
  assert.match(findings[0].causesStatus, /its cause is not/);
  // The same fault reported again is the same finding.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const service = createMaintenanceService({ recordEveryMs: 0 });
  await service.recordRobotState(db, { id: robot.robotId, user_id: users.miraId, simulated: 0 }, state({ faults: [{ code: "VESC-6", message: "again", motor: "left", source: "motor-controller" }] }));
  assert.equal((await call(users.mira, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings.length, 1);
});

test("verdicts measure false positives; only a person gives them or confirms a fault; tasks remind, complete into the service history, and everything is audited", async () => {
  const robot = await enrolled(users.mira, "Judge");
  const service = createMaintenanceService();
  await seed(service, users.miraId, robot.robotId, "motor:a", "temperatureC", { mu: 40, sigma: 1, seed: 3, inject: (v) => v + 9 });
  await seed(service, users.miraId, robot.robotId, "motor:b", "temperatureC", { mu: 40, sigma: 1, seed: 4, inject: (v) => v + 9 });
  await call(users.mira, "POST", "/maintenance/analyze", { asset: robot.robotId });
  const findings = (await call(users.mira, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings.filter((item) => item.label === "measured-anomaly");
  const a = findings.find((item) => item.component === "motor:a");
  const b = findings.find((item) => item.component === "motor:b");
  assert.ok(a && b);

  // An agent (developer key) can read but not judge, confirm, or close.
  assert.equal((await call(users.miraKey, "GET", `/maintenance/findings/${a.id}`)).status, 200);
  assert.equal((await call(users.miraKey, "POST", `/maintenance/findings/${a.id}/feedback`, { verdict: "true-positive" })).status, 403);
  assert.equal((await call(users.miraKey, "POST", `/maintenance/findings/${a.id}/confirm`, { note: "trust me" })).status, 403);
  assert.equal((await call(users.otto, "GET", `/maintenance/findings/${a.id}`)).status, 404);

  assert.equal((await call(users.mira, "POST", `/maintenance/findings/${a.id}/feedback`, { verdict: "maybe" })).status, 400);
  const fp = await call(users.mira, "POST", `/maintenance/findings/${b.id}/feedback`, { verdict: "false-positive", note: "the robot was in the sun all day" });
  assert.equal(fp.status, 200);
  assert.equal(fp.body.finding.status, "dismissed");
  assert.equal(fp.body.precision.overall.falsePositives, 1);
  assert.equal(fp.body.precision.overall.precision, 0);
  assert.equal((await call(users.mira, "POST", `/maintenance/findings/${a.id}/confirm`, {})).status, 400, "a confirmation says what was found");
  const confirmed = await call(users.mira, "POST", `/maintenance/findings/${a.id}/confirm`, { note: "Bearing rough when turned by hand." });
  assert.equal(confirmed.body.finding.label, "confirmed-fault");
  assert.equal(confirmed.body.finding.confirmation.by, "person");
  assert.equal(confirmed.body.finding.confirmation.previousLabel, "measured-anomaly");
  const precision = (await call(users.mira, "GET", "/maintenance/findings")).body.precision;
  assert.equal(precision.overall.truePositives, 1);
  assert.equal(precision.overall.precision, 0.5);
  assert.ok(Object.values(precision.byDetector).some((entry) => entry.judged > 0));

  // A task from the finding, with a reminder in the synced reminders list.
  const due = Date.now() + 3 * 86_400_000;
  const task = await call(users.mira, "POST", "/maintenance/tasks", { assetId: robot.robotId, findingId: a.id, kind: "replacement", dueAt: due, remind: true, note: "Order a 6202 bearing" });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  assert.equal(task.body.task.component, "motor:a");
  const reminders = JSON.parse((await db.query("SELECT value FROM hannah_user_data WHERE user_id = $1 AND namespace = 'reminders'", [users.miraId])).rows[0].value);
  const reminder = reminders.find((item) => item.id === task.body.task.reminderId);
  assert.equal(reminder.dueAt, due);
  assert.equal(reminder.status, "scheduled");
  assert.match(reminder.text, /Judge: Replacement/);
  assert.equal((await call(users.miraKey, "POST", `/maintenance/tasks/${task.body.task.id}/complete`, {})).status, 403);
  const done = await call(users.mira, "POST", `/maintenance/tasks/${task.body.task.id}/complete`, { note: "Replaced the left bearing." });
  assert.equal(done.body.task.status, "done");
  const history = (await call(users.mira, "GET", `/maintenance/history?asset=${robot.robotId}`)).body.history;
  assert.equal(history[0].kind, "replacement");
  assert.equal(history[0].component, "motor:a");
  assert.equal(history[0].taskId, task.body.task.id);
  assert.equal((await call(users.mira, "GET", `/maintenance/findings/${a.id}`)).body.finding.status, "resolved");
  // After the replacement the component's baseline starts again: the old data no longer counts.
  await call(users.mira, "POST", "/maintenance/analyze", { asset: robot.robotId });
  const coverage = (await call(users.mira, "GET", `/maintenance?asset=${robot.robotId}&refresh=1`)).body.coverage.find((entry) => entry.component === "motor:a");
  assert.equal(coverage.sinceReason, "replacement");
  assert.equal(coverage.baselineReady, false);
  // The existing robot's service-history route still works and shows the entry.
  assert.equal((await call(users.mira, "GET", `/robots/${robot.robotId}/maintenance`)).body.maintenance[0].kind, "replacement");

  const trail = (await db.query("SELECT event FROM hannah_ops_audit WHERE user_id = $1 AND area = 'maintenance' ORDER BY at", [users.miraId])).rows.map((row) => row.event);
  for (const event of ["finding-opened:measured-anomaly", "verdict:false-positive", "finding-confirmed", "task-created", "task-completed"]) assert.ok(trail.includes(event), `audited: ${event}`);
});

test("a simulated robot's findings say so and stay low priority", async () => {
  const robot = await enrolled(users.otto, "Sim", { simulated: true });
  const service = createMaintenanceService();
  await seed(service, users.ottoId, robot.robotId, "motor:left", "temperatureC", { mu: 40, sigma: 1, seed: 8, inject: (v) => v + 50, source: "simulation" });
  await call(users.otto, "POST", "/maintenance/analyze", { asset: robot.robotId });
  const findings = (await call(users.otto, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings;
  assert.ok(findings.length);
  assert.ok(findings.every((item) => item.simulated && item.priority === "low"));
  assert.ok(findings.some((item) => /simulated/.test(item.simulationNote || "")));
  const report = (await call(users.otto, "GET", "/maintenance")).body;
  assert.match(report.summary, /Nothing unusual in the measurements of physical hardware/);
  assert.match(report.summary, /simulated/);
});

test("chat and agents ask “is anything wearing out?” through the maintenance.report action", async () => {
  const asked = await call(users.miraKey, "POST", "/actions", { action: "maintenance.report", params: {}, request: "is anything wearing out?", agent: "Robot agent" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.record.status, "done");
  const response = asked.body.record.response;
  assert.ok(response.findings.length > 0);
  assert.ok(response.findings.every((item) => item.failureDate === null && item.label));
  assert.match(response.rules, /Never give a failure date/);
  assert.equal(typeof response.precision.precision, "number");
});

test("a Robot OS maintenance window (as robot-os/services/maintenance_features.py sends it) becomes series, and its controller fault a confirmed fault", async () => {
  const robot = await enrolled(users.otto, "OS-robot");
  const service = createMaintenanceService();
  const payload = {
    window_ms: 60000, simulated: false,
    controllers: { drive: { input_voltage_v: { n: 600, mean: 23.9, min: 23.5, max: 24.2, std: 0.1, last: 23.8 } }, "drive-left": { temp_fet_c: { n: 600, mean: 41, min: 40, max: 43, std: 0.5, last: 42 }, encoder_residual_mps: { n: 599, mean: 0.01, min: 0, max: 0.04, std: 0.01, last: 0.0 } }, broken: { temp_fet_c: { n: 3, mean: 90, min: 10, max: 20, last: 15 } } },
    fault_codes: [{ controller_id: "drive", fault: "FET over temperature", at_ms: Date.now() }],
  };
  assert.deepEqual(await service.recordRobotOSFeatures(db, users.ottoId, robot.robotId, payload), { recorded: 3 }, "a window whose mean is outside its own min and max is dropped");
  const keys = (await call(users.otto, "GET", `/maintenance/series?asset=${robot.robotId}`)).body.series.map((item) => `${item.component}.${item.metric}`).sort();
  assert.deepEqual(keys, ["controller:drive-left.temperatureC", "controller:drive.voltageV", "motor:drive-left.encoderResidualMps"]);
  const bucket = (await call(users.otto, "GET", `/maintenance/series?asset=${robot.robotId}&component=controller:drive-left&metric=temperatureC`)).body.buckets[0];
  assert.equal(bucket.n, 600);
  assert.equal(bucket.mean, 41);
  assert.equal(bucket.max, 43);
  const fault = (await call(users.otto, "GET", `/maintenance/findings?asset=${robot.robotId}`)).body.findings[0];
  assert.equal(fault.label, "confirmed-fault");
  assert.equal(fault.confirmation.code, "FET over temperature");
});
