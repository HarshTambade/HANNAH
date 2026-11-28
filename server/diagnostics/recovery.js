"use strict";

/**
 * Recovery actions and the policy each one runs under.
 *
 *   automatic   low risk and reversible: diagnostics may run it on its own,
 *               then checks that it worked. Recorded like every other.
 *   approval    a person approves it first, through the Action Engine (the same
 *               approval and audit history as everything else HANNAH does).
 *   admin       only a server administrator may run it (the operator token, or
 *               a signed-in session whose email is in HANNAH_ADMIN_EMAILS). An
 *               agent or a developer key never can.
 *   prohibited  never run by HANNAH, whoever asks. Listed so the dashboard can
 *               say what has to be done by a person at the hardware.
 *
 * Hard-coded and not configurable: anything touching motor safety, emergency
 * stop circuits, hazardous equipment, power control or motion-controller
 * safety settings is prohibited. A policy override can make an action
 * stricter, never looser, and can never lift a prohibition. Restarting a
 * Robot OS service is limited to the services that take no part in motion or
 * safety, here and again on the robot (robot-os dispatcher), so neither side
 * alone decides.
 */

const POLICIES = ["automatic", "approval", "admin", "prohibited"];
const RANK = Object.fromEntries(POLICIES.map((policy, index) => [policy, index]));

/** Robot OS services that take no part in motion or safety. The robot keeps its own copy of this list. */
const RESTARTABLE_SERVICES = Object.freeze(["telemetry", "update-manager", "ai-runtime", "remote-gateway"]);
/** Services that carry safety or motion. Never restarted by HANNAH. */
const CRITICAL_SERVICES = Object.freeze(["safety-gateway", "motor-controller", "hardware-manager", "sensor-manager", "ros2-runtime"]);

/** Never run, whatever any configuration says. Tests assert this list. */
const PROHIBITED = Object.freeze({
  "robot.release_estop": "Releasing or resetting an emergency stop is done by a person at the robot, after the cause is found.",
  "robot.reset_estop_circuit": "Emergency stop circuits are independent of HANNAH and stay that way.",
  "robot.clear_motor_fault": "A motor or controller fault is cleared at the robot once its cause is fixed; clearing it remotely could restart a faulty drive.",
  "robot.change_motion_safety_settings": "Speed, acceleration, workspace and watchdog limits change only through commissioning, never as a recovery.",
  "robot.restart_critical_service": `The safety gateway, motor controller, hardware manager, sensor manager and ROS 2 runtime (${CRITICAL_SERVICES.join(", ")}) carry motion or safety and are never restarted by HANNAH.`,
  "robot.power_control": "Switching a robot's or a motor's power is done by a person.",
  "hardware.hazardous_equipment": "Equipment that can hurt someone (heaters, cutters, high-voltage loads) is never switched as a recovery.",
});
const SAFETY_TOUCHES = new Set(["motor-safety", "estop", "hazardous-equipment", "power-control", "motion-safety-settings"]);

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function createRecoveryRegistry({ robotOSCommands = null, robotOSEnvelopes = null, devices = null, robotics = null, gateway = require("../gateway"), caches = require("./caches"), overrides = {}, commandWaitMs = 4000, envelopeWaitMs = 3000, now = () => Date.now() } = {}) {
  async function robotTarget(ctx, params) {
    if (!robotics) throw fail(503, "Robots aren't available on this server.", "not-configured");
    const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
    if (!robot) throw fail(404, "That robot isn't enrolled under this account.", "unknown-robot");
    return robot;
  }
  async function robotCommand(ctx, robot, capability, params) {
    if (!robotOSCommands) throw fail(503, "Robot OS commands aren't available on this server.", "not-configured");
    const command = await robotOSCommands.issue(ctx.db, { userId: ctx.userId, robotId: robot.id, capability, params });
    const settled = await robotOSCommands.waitFor(ctx.db, ctx.userId, command.id, { timeoutMs: commandWaitMs });
    return { commandId: command.id, robot: { id: robot.id, name: robot.name }, capability, issuedAt: command.issuedAt, status: settled?.status || "pending", ackReason: settled?.ackReason || "" };
  }
  async function commandVerify(ctx, result, { needEnvelopeAfter = false } = {}) {
    const command = await robotOSCommands.get(ctx.db, ctx.userId, result.commandId);
    if (!command) return { confirmed: false, evidence: "The command record disappeared." };
    if (command.status === "failed") return { confirmed: false, failed: true, evidence: `The robot refused it: ${command.ackReason || "no reason given"}.` };
    if (command.status !== "acked") return { confirmed: false, pending: true, evidence: `The command is ${command.status}; ${result.robot.name} hasn't collected or answered it yet.` };
    if (!needEnvelopeAfter || !robotOSEnvelopes) return { confirmed: true, evidence: `${result.robot.name} applied ${result.capability}: ${command.ackReason || "applied"}.` };
    // The robot acknowledges first and reports the restarted service on its next exchange: wait a little for it.
    let fresh = null;
    for (const deadline = now() + envelopeWaitMs; ;) {
      const recent = await robotOSEnvelopes.listEnvelopes(ctx.db, ctx.userId, { robotId: result.robot.id, limit: 20 });
      fresh = recent.find((envelope) => ["telemetry", "heartbeat"].includes(envelope.kind) && envelope.receivedAt >= result.issuedAt);
      if (fresh || now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return fresh ? { confirmed: true, evidence: `${result.robot.name} restarted the service and sent ${fresh.kind} at ${new Date(fresh.receivedAt).toISOString()}.` } : { confirmed: false, pending: true, evidence: `${result.robot.name} restarted the service; no new telemetry has arrived since.` };
  }

  const actions = [
    {
      id: "server.clear_safe_cache", scope: "server", policy: "automatic", reversible: true, touches: [],
      title: "Clear safe caches", description: "Empty the server's caches that only cost a refetch (the live model catalog). Nothing a person made is held in them.",
      undo: "Nothing to undo: the caches fill again on the next requests.",
      available: () => (caches.safeCaches().length ? { ok: true } : { ok: false, reason: "No safe caches are registered in this server process." }),
      run: async () => ({ cleared: caches.clearSafeCaches() }),
      verify: async (_ctx, _params, result) => { const left = caches.safeCaches().filter((cache) => cache.entries); return left.length ? { confirmed: false, evidence: `Still holding entries: ${left.map((cache) => cache.id).join(", ")} (new requests may have refilled them).` } : { confirmed: true, evidence: `Cleared ${result.cleared.map((item) => `${item.id} (${item.before ?? "?"} entries)`).join(", ")}.` }; },
    },
    {
      id: "server.switch_backup_provider", scope: "server", policy: "admin", reversible: true, touches: [],
      title: "Switch to the backup model provider", description: "Put a failing model provider behind its configured backups (HANNAH_PROVIDER_FALLBACKS) for a while. Requests that pinned a provider are unchanged; the original order comes back when the time runs out, on a restart, or with “restore provider order”.",
      undo: "server.restore_provider_order",
      input: { provider: "the provider to put last", minutes: "how long (default 30, at most 360)" },
      available: (_ctx, params) => { const backups = gateway.configuredBackups(String(params?.provider || "")); return backups.length ? { ok: true } : { ok: false, reason: "No configured backup provider: set HANNAH_PROVIDER_FALLBACKS to providers that have keys." }; },
      run: async (ctx, params) => { const provider = clip(params.provider, 64); const backup = gateway.configuredBackups(provider)[0]; const avoided = gateway.avoidProvider(provider, { forMs: (Number(params.minutes) || 30) * 60_000, reason: params.reason || "diagnostics", by: ctx.actor?.label }); return { provider, backup, until: avoided.until }; },
      verify: async (_ctx, _params, result) => { const backup = gateway.activeBackup(result.provider); return backup ? { confirmed: true, evidence: `Requests that don't pin a provider now go to ${backup} first, until ${new Date(result.until).toISOString()}. The order is ${gateway.providerFallbacks(result.provider).join(" → ")}.` } : { confirmed: false, evidence: "The gateway isn't using a backup: no usable backup provider." }; },
    },
    {
      id: "server.restore_provider_order", scope: "server", policy: "admin", reversible: true, touches: [],
      title: "Restore the configured provider order", description: "Undo a switch to a backup provider.",
      input: { provider: "the provider to bring back" },
      available: () => ({ ok: true }),
      run: async (_ctx, params) => ({ provider: clip(params.provider, 64), restored: gateway.restoreProvider(clip(params.provider, 64)) }),
      verify: async (_ctx, _params, result) => (gateway.activeBackup(result.provider) ? { confirmed: false, evidence: "The provider is still avoided." } : { confirmed: true, evidence: `${result.provider} is back in its configured place.` }),
    },
    {
      id: "device.reconnect", scope: "device", policy: "automatic", reversible: true, touches: [],
      title: "Reconnect a device through its hub", description: "Ask the device's hub to stop and restart its connection to the device. Nothing is written to the device and no setting changes.",
      undo: "Nothing to undo: the device keeps its configuration.",
      input: { device: "the device's name or id" },
      available: () => (devices ? { ok: true } : { ok: false, reason: "Devices aren't available on this server." }),
      run: async (ctx, params) => devices.requestReconnect(ctx.db, ctx.userId, params.device, { requestedBy: ctx.actor?.label || "diagnostics" }),
      verify: async (ctx, _params, result) => {
        const status = await devices.reconnectStatus(ctx.db, ctx.userId, result.deviceId, result.configVersion);
        if (!status.applied) return { confirmed: false, pending: true, evidence: `The hub hasn't taken configuration ${result.configVersion} yet.` };
        return status.connection === "online" ? { confirmed: true, evidence: "The hub restarted the connection and the device reports online." } : { confirmed: false, pending: status.connection === "waiting", evidence: `The hub restarted the connection; the device reports ${status.connection}.` };
      },
    },
    {
      id: "robot.reconnect_telemetry", scope: "robot", policy: "automatic", reversible: true, touches: [],
      title: "Reconnect a robot's telemetry", description: "Ask Robot OS to restart its telemetry service (it takes no part in motion or safety). The robot checks the signed command and its own safety state first.",
      undo: "Nothing to undo: the service starts with the same configuration.",
      input: { robot: "the robot's name or id" },
      available: () => (robotOSCommands ? { ok: true } : { ok: false, reason: "Robot OS commands aren't available on this server." }),
      run: async (ctx, params) => robotCommand(ctx, await robotTarget(ctx, params), "service.restart", { service: "telemetry", reason: clip(params.reason || "telemetry stopped arriving", 200) }),
      verify: (ctx, _params, result) => commandVerify(ctx, result, { needEnvelopeAfter: true }),
    },
    {
      id: "robot.restart_service", scope: "robot", policy: "approval", reversible: true, touches: [],
      title: "Restart a Robot OS service", description: `Restart one Robot OS service through its service manager. Only ${RESTARTABLE_SERVICES.join(", ")}: services that take no part in motion or safety.`,
      undo: "Nothing to undo: the service starts with the same configuration.",
      input: { robot: "the robot's name or id", service: `one of ${RESTARTABLE_SERVICES.join(", ")}` },
      available: (_ctx, params) => (RESTARTABLE_SERVICES.includes(String(params?.service)) ? (robotOSCommands ? { ok: true } : { ok: false, reason: "Robot OS commands aren't available on this server." }) : { ok: false, prohibited: CRITICAL_SERVICES.includes(String(params?.service)), reason: CRITICAL_SERVICES.includes(String(params?.service)) ? PROHIBITED["robot.restart_critical_service"] : `Only ${RESTARTABLE_SERVICES.join(", ")} can be restarted.` }),
      run: async (ctx, params) => robotCommand(ctx, await robotTarget(ctx, params), "service.restart", { service: String(params.service), reason: clip(params.reason || "diagnostics", 200) }),
      verify: (ctx, _params, result) => commandVerify(ctx, result, { needEnvelopeAfter: true }),
    },
    {
      id: "robot.reload_config", scope: "robot", policy: "approval", reversible: true, touches: [],
      title: "Reload a robot's validated configuration", description: "Ask Robot OS to validate its configuration file and apply it to the services that take no part in motion or safety. The robot refuses if the file is invalid or if its safety section differs from the running one: safety settings change only through commissioning.",
      undo: "The previous configuration file stays on the robot.",
      input: { robot: "the robot's name or id" },
      available: () => (robotOSCommands ? { ok: true } : { ok: false, reason: "Robot OS commands aren't available on this server." }),
      run: async (ctx, params) => robotCommand(ctx, await robotTarget(ctx, params), "config.reload", { reason: clip(params.reason || "diagnostics", 200) }),
      verify: (ctx, _params, result) => commandVerify(ctx, result),
    },
    {
      id: "robot.restore_app_version", scope: "robot", policy: "approval", reversible: false, touches: [],
      title: "Restore the robot's last validated version", description: "Ask Robot OS to roll back to its last known-good image slot through its update system. The robot checks its own recovery state first; a rollback never restores a hardware configuration that hasn't been validated.",
      undo: "Stage and activate the newer version again (each separately approved).",
      input: { robot: "the robot's name or id", reason: "why; kept in the audit record" },
      available: () => (robotOSCommands ? { ok: true } : { ok: false, reason: "Robot OS commands aren't available on this server." }),
      run: async (ctx, params) => robotCommand(ctx, await robotTarget(ctx, params), "update.rollback", { reason: clip(params.reason || "diagnostics: failed update", 500) }),
      verify: (ctx, _params, result) => commandVerify(ctx, result),
    },
    ...Object.entries(PROHIBITED).map(([id, reason]) => ({
      id, scope: id.startsWith("hardware") ? "device" : "robot", policy: "prohibited", reversible: false, touches: [id.includes("estop") ? "estop" : id.includes("power") ? "power-control" : id.includes("hazard") ? "hazardous-equipment" : id.includes("motion") ? "motion-safety-settings" : "motor-safety"],
      title: { "robot.release_estop": "Release an emergency stop", "robot.reset_estop_circuit": "Reset an emergency stop circuit", "robot.clear_motor_fault": "Clear a motor or controller fault", "robot.change_motion_safety_settings": "Change motion-controller safety settings", "robot.restart_critical_service": "Restart a safety or motion service", "robot.power_control": "Switch power", "hardware.hazardous_equipment": "Switch hazardous equipment" }[id],
      description: reason, manual: reason,
      available: () => ({ ok: false, prohibited: true, reason }),
      run: async () => { throw fail(403, `Prohibited: ${reason}`, "prohibited"); },
      verify: async () => ({ confirmed: false, evidence: "Never run." }),
    })),
  ];

  const byId = new Map();
  for (const action of actions) {
    // The hard rules, checked when the registry is built: they can't be configured away.
    const forced = PROHIBITED[action.id] || action.touches.some((touch) => SAFETY_TOUCHES.has(touch));
    let policy = forced ? "prohibited" : action.policy;
    const override = overrides[action.id];
    if (override && POLICIES.includes(override) && RANK[override] > RANK[policy]) policy = override; // stricter only
    byId.set(action.id, Object.freeze({ ...action, policy }));
  }

  function get(id) { return byId.get(String(id)) || null; }
  function list() { return [...byId.values()].map(({ id, title, description, scope, policy, reversible, undo, input, manual }) => ({ id, title, description, scope, policy, reversible, undo: undo || null, input: input || {}, manual: manual || null })); }

  /**
   * May this actor run this action now? actor: { kind: "system" | "person" | "agent", admin: boolean }.
   * Returns { decision: "run" | "ask" | "admin-required" | "prohibited" | "unavailable", reason }.
   */
  async function decide(ctx, id, params = {}) {
    const action = get(id);
    if (!action) return { decision: "unavailable", reason: "No such recovery action." };
    if (action.policy === "prohibited") return { decision: "prohibited", policy: action.policy, reason: action.description };
    const available = await Promise.resolve(action.available(ctx, params));
    if (!available.ok) return { decision: available.prohibited ? "prohibited" : "unavailable", policy: available.prohibited ? "prohibited" : action.policy, reason: available.reason };
    const actor = ctx.actor || { kind: "system", admin: false };
    if (action.scope === "server" && action.policy !== "automatic" && !actor.admin) return { decision: "admin-required", policy: action.policy, reason: "This changes the server for everyone: only a server administrator can run it." };
    if (action.policy === "admin") return actor.admin ? { decision: "run", policy: action.policy, reason: "A server administrator asked for it." } : { decision: "admin-required", policy: action.policy, reason: "Only a server administrator can run this." };
    if (action.policy === "approval") return actor.approved ? { decision: "run", policy: action.policy, reason: "A person approved it." } : { decision: "ask", policy: action.policy, reason: "A person approves this before it runs." };
    return { decision: "run", policy: action.policy, reason: "Low risk and reversible: allowed to run automatically." };
  }

  return { CRITICAL_SERVICES, PROHIBITED, RESTARTABLE_SERVICES, decide, get, list, now };
}

module.exports = { CRITICAL_SERVICES, POLICIES, PROHIBITED, RESTARTABLE_SERVICES, SAFETY_TOUCHES, createRecoveryRegistry };
