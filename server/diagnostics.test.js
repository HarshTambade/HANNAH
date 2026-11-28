"use strict";

// Self-diagnostics and recovery against the real server and database. The
// robots are stand-ins that report what the test scripts; a small loop plays
// the onboard Robot OS, answering its signed commands and sending the status
// a restarted service would. Nothing here is a physical robot.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "diagnostics-test-token-0123456789-abcdefghijklmnop";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "d".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
process.env.HANNAH_ADMIN_EMAILS = "root@diagnostics.example";
process.env.HANNAH_PROVIDER_FALLBACKS = "groq";
process.env.GROQ_API_KEY = "gsk_diagnosticstestkeynotreal0000000000"; // makes groq a usable backup; no call is made with it
delete process.env.VERCEL;

const { createRobotClient, descriptor, state } = require("./test-fixtures/robot-client");
const { createRecoveryRegistry, PROHIBITED, CRITICAL_SERVICES, RESTARTABLE_SERVICES, POLICIES } = require("./diagnostics/recovery");
const { STEPS } = require("./diagnostics/engine");
const envelopes = require("./robotics/robot_os_envelopes");
const { createRobotOSCommandService } = require("./robotics/robot_os_commands");
const { recordProviderOutcome, resetProviderHealth } = require("./observability/provider-health");
const gateway = require("./gateway");

let server;
let base;
let db;
const users = {};
const operatorToken = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
};
async function enrolled(who, name) {
  const created = await call(who, "POST", "/robots", { name, simulated: true });
  const robot = createRobotClient({ base });
  assert.equal((await robot.enroll(created.body.enrollment.code, descriptor())).status, 201);
  return robot;
}
const health = (services) => ({ robot_ready: services.every(([, ready]) => ready), required: [], services: services.map(([name, ready]) => ({ name, state: ready ? "ready" : "fault", stale: !ready, last_ok_ms: null, detail: "" })) });
let envelopeSeq = 0;
const report = (robotId, kind, payload) => envelopes.saveEnvelope(db, { envelope_id: `env_test_${(envelopeSeq += 1)}_${Date.now()}`, robot_id: robotId, kind, ts_ms: Date.now(), signature: "sig", payload });

/**
 * Plays Robot OS for one robot: acknowledges each signed command it is sent
 * (refusing a restart of anything but the non-critical services, as the real
 * dispatcher does), then reports the restarted service as ready.
 */
function robotOS(robotId, services) {
  const commands = createRobotOSCommandService();
  const seen = [];
  const control = { fixes: true };
  let on = true;
  const loop = (async () => {
    while (on) {
      for (const command of await commands.pending(db, robotId)) {
        seen.push(command);
        const ok = command.capability !== "service.restart" || RESTARTABLE_SERVICES.includes(command.params.service);
        await commands.ack(db, { robotId, commandId: command.id, ok, reason: ok ? "applied" : "service is not restartable" });
        if (ok && command.capability === "service.restart" && control.fixes) { services.set(command.params.service, true); await report(robotId, "heartbeat", { health: health([...services.entries()]) }); }
      }
      await sleep(40);
    }
  })();
  return { seen, control, stop: async () => { on = false; await loop; } };
}

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  db = await require("./db").getDatabase();
  for (const name of ["ana", "root"]) {
    const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@diagnostics.example`, password: "correct horse battery staple" }) });
    assert.equal(response.status, 200, await response.clone().text());
    users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
    users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@diagnostics.example`])).rows[0].id;
  }
  const key = await call(users.ana, "POST", "/account/api-keys", { name: "agent" });
  users.anaKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await require("./db").closeDatabase?.();
});

test("motor safety, emergency stops, power control and motion safety settings are hard-coded prohibited; overrides only tighten", async () => {
  const registry = createRecoveryRegistry({ overrides: { "robot.release_estop": "automatic", "robot.clear_motor_fault": "approval", "robot.change_motion_safety_settings": "admin", "robot.power_control": "automatic", "robot.restart_service": "automatic", "device.reconnect": "approval" } });
  for (const id of ["robot.release_estop", "robot.reset_estop_circuit", "robot.clear_motor_fault", "robot.change_motion_safety_settings", "robot.restart_critical_service", "robot.power_control", "hardware.hazardous_equipment"]) {
    assert.ok(PROHIBITED[id], `${id} is on the prohibited list`);
    assert.equal(registry.get(id).policy, "prohibited", `${id} stays prohibited whatever the override`);
    await assert.rejects(registry.get(id).run({}, {}), (error) => error.reason === "prohibited");
    assert.equal((await registry.decide({ actor: { kind: "person", admin: true, approved: true } }, id, {})).decision, "prohibited", "not even an approved administrator");
  }
  assert.equal(registry.get("robot.restart_service").policy, "approval", "an override can't loosen a policy");
  assert.equal(registry.get("device.reconnect").policy, "approval", "an override can tighten one");
  for (const service of CRITICAL_SERVICES) assert.equal((await registry.decide({ actor: { kind: "person", admin: true, approved: true } }, "robot.restart_service", { service })).decision, "prohibited", `${service} is never restarted`);
  assert.deepEqual([...RESTARTABLE_SERVICES].sort(), ["ai-runtime", "remote-gateway", "telemetry", "update-manager"]);
  assert.ok(!RESTARTABLE_SERVICES.some((service) => CRITICAL_SERVICES.includes(service)));
  for (const action of registry.list()) {
    assert.ok(POLICIES.includes(action.policy));
    assert.equal(typeof registry.get(action.id).verify, "function", `${action.id} has a verification step`);
  }
  // The spec's actions that exist in this codebase are all present.
  for (const id of ["robot.restart_service", "device.reconnect", "robot.reload_config", "server.clear_safe_cache", "server.switch_backup_provider", "robot.reconnect_telemetry", "robot.restore_app_version"]) assert.ok(registry.get(id), id);
  assert.equal(STEPS.length, 13);
});

test("the checks report what they measured, per subsystem, and 'unknown' where nothing was measured", async () => {
  resetProviderHealth();
  const result = (await call(users.ana, "GET", "/diagnostics?auto=0")).body;
  assert.deepEqual(Object.keys(result.subsystems).sort(), ["ai", "hardware", "os", "runtime"]);
  const ai = result.subsystems.ai.checks;
  const providers = ai.find((item) => item.id === "ai.providers");
  assert.equal(providers.status, "unknown", "no model calls recorded: not 'ok'");
  assert.match(providers.evidence.join(" "), /No model calls recorded/);
  const memory = result.subsystems.os.checks.find((item) => item.id === "os.memory");
  assert.ok(memory.measured.heapUsedMb > 0);
  const database = result.subsystems.os.checks.find((item) => item.id === "os.database");
  assert.equal(database.status, "ok");
  assert.ok(Number.isFinite(database.measured.latencyMs));
  assert.ok(result.subsystems.ai.checks.find((item) => item.id === "ai.queues").measured);
  assert.equal(result.you.admin, false);
  assert.equal((await call(null, "GET", "/diagnostics")).status, 401);
});

test("an engaged emergency stop and a controller fault become incidents whose only recovery is prohibited: a person acts at the robot", async () => {
  const robot = await enrolled(users.ana, "Stopped");
  await robot.sync({ send: state({ estop: { engaged: true, source: "hardware button" }, faults: [{ code: "ODRV-0x40", message: "motor overheated" }] }) });
  const result = (await call(users.ana, "GET", "/diagnostics")).body;
  const estop = result.incidents.find((incident) => incident.problem === "estop-engaged" && incident.targetId === robot.robotId);
  assert.ok(estop, "incident opened");
  assert.equal(estop.severity, "error");
  assert.equal(estop.status, "needs-person");
  assert.equal(estop.suggestions[0].action, "robot.release_estop");
  assert.equal(estop.suggestions[0].policy, "prohibited");
  assert.equal(estop.recoveries.length, 0, "nothing was attempted");
  const steps = estop.lifecycle.map((step) => step.step);
  for (const name of ["detect", "component", "telemetry", "logs", "dependencies", "severity", "causes", "diagnosis", "suggested", "permission", "remediation"]) assert.ok(steps.includes(name), name);
  assert.match(estop.lifecycle.find((step) => step.step === "remediation").detail, /prohibited/);
  assert.match(estop.diagnosis, /none is confirmed|reported this itself/);
  const fault = result.incidents.find((incident) => incident.problem === "controller-fault" && incident.targetId === robot.robotId);
  assert.equal(fault.suggestions[0].policy, "prohibited");
  // Asking for it anyway is refused and recorded.
  const asked = await call(users.ana, "POST", "/diagnostics/recover", { incidentId: estop.id, action: "robot.release_estop", params: { robot: robot.robotId } });
  assert.equal(asked.status, 403);
  assert.equal(asked.body.reason, "prohibited");
  const asAdmin = await call(users.root, "POST", "/diagnostics/recover", { action: "robot.clear_motor_fault", params: { robot: robot.robotId } });
  assert.equal(asAdmin.status, 403, "not even an administrator");
  const refused = (await db.query("SELECT status FROM hannah_diag_recoveries WHERE id = $1", [asked.body.recoveryId])).rows[0];
  assert.equal(refused.status, "prohibited");
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_os_commands WHERE robot_id = $1", [robot.robotId])).rows[0].n), 0, "no command reached the robot");
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robot_missions WHERE robot_id = $1", [robot.robotId])).rows[0].n), 0);
  // Released at the robot: the next diagnosis closes the incident and verifies it from the check.
  await robot.sync({ send: state() });
  const later = await call(users.ana, "GET", `/diagnostics/incidents/${estop.id}`);
  assert.equal(later.status, 200);
  await call(users.ana, "GET", "/diagnostics?auto=0");
  const closed = (await call(users.ana, "GET", `/diagnostics/incidents/${estop.id}`)).body.incident;
  assert.equal(closed.status, "resolved");
  assert.equal(closed.lifecycle.length, STEPS.length, "all thirteen steps recorded");
  assert.match(closed.lifecycle.find((step) => step.step === "verify").detail, /check passes again/);
});

test("telemetry stopped: the automatic low-risk recovery restarts it through Robot OS, verifies it and closes the incident; not repeated within ten minutes", async () => {
  const robot = await enrolled(users.ana, "Quiet");
  await robot.sync({ send: state() });
  const services = new Map([["safety-gateway", true], ["motor-controller", true], ["telemetry", false]]);
  await report(robot.robotId, "heartbeat", { health: health([...services.entries()]) });
  const os = robotOS(robot.robotId, services);
  try {
    const result = (await call(users.ana, "GET", "/diagnostics")).body;
    assert.equal(os.seen.length, 1);
    assert.equal(os.seen[0].capability, "service.restart");
    assert.deepEqual(os.seen[0].params.service, "telemetry");
    const incident = (await db.query("SELECT * FROM hannah_diag_incidents WHERE user_id = $1 AND target_id = $2 AND problem = 'robot-service-down'", [users.anaId, robot.robotId])).rows[0];
    assert.equal(incident.status, "resolved", "the check passed again after the recovery");
    const view = (await call(users.ana, "GET", `/diagnostics/incidents/${incident.id}`)).body.incident;
    assert.equal(view.recoveries[0].action, "robot.reconnect_telemetry");
    assert.equal(view.recoveries[0].policy, "automatic");
    assert.equal(view.recoveries[0].status, "verified");
    assert.match(view.recoveries[0].verification.evidence, /sent heartbeat/);
    assert.ok(!result.incidents.some((item) => item.id === incident.id && item.status !== "resolved"));
    // Down again, and this time the restart doesn't bring it back: one attempt, then not repeated within ten minutes.
    os.control.fixes = false;
    services.set("telemetry", false);
    await report(robot.robotId, "heartbeat", { health: health([...services.entries()]) });
    await call(users.ana, "GET", "/diagnostics");
    assert.equal(os.seen.length, 2);
    const open = (await db.query("SELECT * FROM hannah_diag_incidents WHERE user_id = $1 AND target_id = $2 AND problem = 'robot-service-down' AND status <> 'resolved'", [users.anaId, robot.robotId])).rows[0];
    assert.ok(open, "still open: the service didn't come back");
    const second = (await call(users.ana, "GET", `/diagnostics/incidents/${open.id}`)).body.incident;
    assert.equal(second.recoveries[0].status, "unverified", "acked, but no new telemetry: not called a success");
    await call(users.ana, "GET", "/diagnostics");
    assert.equal(os.seen.length, 2, "not repeated");
    const skipped = (await call(users.ana, "GET", `/diagnostics/incidents/${open.id}`)).body.incident.lifecycle.find((step) => step.step === "remediation");
    assert.match(skipped.detail, /not repeated within ten minutes/);
  } finally { await os.stop(); }
});

test("a non-critical service needs a person's approval; a critical one is never restarted; the approval goes through the Action Engine", async () => {
  const robot = await enrolled(users.ana, "Busy");
  await robot.sync({ send: state() });
  const services = new Map([["safety-gateway", true], ["motor-controller", false], ["ai-runtime", false]]);
  await report(robot.robotId, "heartbeat", { health: health([...services.entries()]) });
  const os = robotOS(robot.robotId, services);
  try {
    const result = (await call(users.ana, "GET", "/diagnostics")).body;
    const critical = result.incidents.find((item) => item.problem === "robot-critical-service-down" && item.targetId === robot.robotId);
    assert.equal(critical.severity, "error");
    assert.equal(critical.suggestions[0].policy, "prohibited");
    assert.equal(critical.status, "needs-person");
    const ai = result.incidents.find((item) => item.problem === "robot-service-down" && item.targetId === robot.robotId);
    assert.equal(ai.suggestions[0].action, "robot.restart_service");
    assert.equal(ai.suggestions[0].policy, "approval");
    assert.equal(os.seen.length, 0, "nothing was sent without approval");

    // An agent may ask; the request waits for a person.
    const asked = await call(users.anaKey, "POST", "/diagnostics/recover", { incidentId: ai.id, action: "robot.restart_service", params: { robot: robot.robotId, service: "ai-runtime" } });
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    assert.equal(asked.body.recovery.status, "waiting-approval");
    const record = (await call(users.ana, "GET", `/actions/${asked.body.recovery.approval.id}`)).body.record;
    assert.equal(record.action, "diagnostics.recover");
    assert.equal(record.status, "waiting-approval");
    assert.equal(os.seen.length, 0);
    // A developer key can't approve its own request.
    assert.notEqual((await call(users.anaKey, "POST", `/actions/${record.id}/decision`, { approve: true })).status, 200);
    const approved = await call(users.ana, "POST", `/actions/${record.id}/decision`, { approve: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.record.status, "done", JSON.stringify(approved.body.record));
    assert.equal(os.seen.length, 1);
    assert.equal(os.seen[0].params.service, "ai-runtime");
    const recovery = (await db.query("SELECT * FROM hannah_diag_recoveries WHERE id = $1", [asked.body.recovery.id])).rows[0];
    assert.equal(recovery.status, "verified");

    // Asking to restart the motor controller is refused here, before anything is sent.
    const motor = await call(users.ana, "POST", "/diagnostics/recover", { incidentId: critical.id, action: "robot.restart_service", params: { robot: robot.robotId, service: "motor-controller" } });
    assert.equal(motor.status, 403);
    assert.equal(motor.body.reason, "prohibited");
    assert.equal(os.seen.length, 1);
    // An approved recovery can't be replayed.
    assert.equal((await call(users.ana, "POST", `/actions/${record.id}/decision`, { approve: true })).status, 409);
  } finally { await os.stop(); }
});

test("a failing model provider: switching to the backup is administrator-only, reversible and verified", async () => {
  resetProviderHealth();
  for (let i = 0; i < 4; i += 1) recordProviderOutcome({ providerId: "ollama", status: "error", errorType: "network" });
  const result = (await call(users.ana, "GET", "/diagnostics")).body;
  const incident = result.incidents.find((item) => item.problem === "provider-failing");
  assert.ok(incident, "detected from recorded calls");
  assert.equal(incident.server, true);
  assert.equal(incident.suggestions[0].action, "server.switch_backup_provider");
  assert.equal(incident.status, "needs-admin");
  const byUser = await call(users.ana, "POST", "/diagnostics/recover", { incidentId: incident.id, action: "server.switch_backup_provider", params: { provider: "ollama" } });
  assert.equal(byUser.status, 403);
  assert.equal(byUser.body.reason, "admin-required");
  const byKey = await call(users.anaKey, "POST", "/diagnostics/recover", { action: "server.switch_backup_provider", params: { provider: "ollama" } });
  assert.equal(byKey.status, 403);
  assert.equal(gateway.activeBackup("ollama"), null);

  const byAdmin = await call(users.root, "POST", "/diagnostics/recover", { incidentId: incident.id, action: "server.switch_backup_provider", params: { provider: "ollama", minutes: 5 } });
  assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
  assert.equal(byAdmin.body.recovery.status, "verified");
  assert.equal(gateway.activeBackup("ollama"), "groq");
  assert.deepEqual(gateway.providerFallbacks("ollama"), ["groq", "ollama"]);
  const undo = await call(operatorToken, "POST", "/diagnostics/recover", { action: "server.restore_provider_order", params: { provider: "ollama" } });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(undo.body.recovery.status, "verified");
  assert.equal(gateway.activeBackup("ollama"), null);
  resetProviderHealth();
});

test("clearing the safe caches is automatic and verified; every incident and recovery is in the audit trail", async () => {
  const run = await call(users.ana, "POST", "/diagnostics/recover", { action: "server.clear_safe_cache", params: {} });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.recovery.policy, "automatic");
  assert.equal(run.body.recovery.status, "verified");
  const trail = (await call(users.ana, "GET", "/diagnostics/audit?limit=500")).body.audit.map((entry) => entry.event);
  for (const event of ["incident-opened", "incident-resolved", "recovery-verified", "recovery-prohibited:robot.release_estop", "recovery-refused:server.switch_backup_provider", "recovery-approval-requested:robot.restart_service", "recovery-run:robot.reconnect_telemetry"]) assert.ok(trail.some((item) => item === event || item.startsWith(event)), `audited: ${event}`);
  const actions = (await call(users.ana, "GET", "/diagnostics/actions")).body.actions;
  assert.equal(actions.find((item) => item.id === "robot.power_control").policy, "prohibited");
});

test("chat and agents ask “what's wrong with the system?” through the diagnostics.report action", async () => {
  const asked = await call(users.anaKey, "POST", "/actions", { action: "diagnostics.report", params: {}, request: "what's wrong with the system?", agent: "Operator" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.record.status, "done");
  const response = asked.body.record.response;
  assert.deepEqual(Object.keys(response.subsystems).sort(), ["ai", "hardware", "os", "runtime"]);
  assert.ok(response.incidents.some((incident) => incident.recovery?.policy === "prohibited"));
  assert.match(response.rules, /never run/);
});
