"use strict";

/**
 * The checks diagnostics runs, by subsystem:
 *
 *   os        this server process (memory, event loop, disk, load, database) and
 *             each robot's Robot OS services and update state, from its status
 *   runtime   each robot's link and missions; each hub's link
 *   hardware  emergency stop, faults, sensors and battery each robot reported;
 *             devices behind hubs
 *   ai        model providers (outcomes of real calls in this process), local
 *             inference, the agent fallback service, the memory store and queues
 *
 * A check reports what it measured. When there is nothing to measure it says
 * "unknown" or "not configured", never "ok". A problem carries what was
 * measured, related logs, dependencies, possible causes and the recovery
 * actions that fit it; it never claims a cause.
 */
const os = require("node:os");
const fs = require("node:fs");
const v8 = require("node:v8");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { providerHealth } = require("../observability/provider-health");
const { listProviders, defaultProviderId } = require("../providers/catalog");
const { RESTARTABLE_SERVICES, CRITICAL_SERVICES } = require("./recovery");

let loopMonitor = null;
function loopDelay() {
  if (!loopMonitor) { loopMonitor = monitorEventLoopDelay({ resolution: 20 }); loopMonitor.enable(); return null; }
  if (!loopMonitor.count) return null;
  const out = { p50Ms: Math.round(loopMonitor.percentile(50) / 1e6), p99Ms: Math.round(loopMonitor.percentile(99) / 1e6), maxMs: Math.round(loopMonitor.max / 1e6), samples: loopMonitor.count };
  loopMonitor.reset();
  return out;
}
loopDelay();

const pct = (value) => Math.round(value * 1000) / 10;
const ago = (at, now) => `${Math.round((now - at) / 1000)} s ago`;
const ROBOT_OS_SILENT_MS = 2 * 60_000;

function check(base) { return { status: "ok", measured: null, evidence: [], ...base }; }

/** Checks of the server itself. */
async function serverChecks({ db, now, ollama, pythonFallback, gateway }) {
  const out = [];
  // Memory.
  const heap = v8.getHeapStatistics();
  const memory = process.memoryUsage();
  const heapShare = heap.used_heap_size / heap.heap_size_limit;
  const memCheck = check({ id: "os.memory", subsystem: "os", component: "server memory", target: "server", measured: { heapUsedMb: Math.round(heap.used_heap_size / 1048576), heapLimitMb: Math.round(heap.heap_size_limit / 1048576), heapUsedPercent: pct(heapShare), rssMb: Math.round(memory.rss / 1048576), systemFreeMb: Math.round(os.freemem() / 1048576), systemTotalMb: Math.round(os.totalmem() / 1048576) } });
  memCheck.evidence.push(`Heap ${memCheck.measured.heapUsedMb} of ${memCheck.measured.heapLimitMb} MB (${memCheck.measured.heapUsedPercent}%), resident ${memCheck.measured.rssMb} MB.`);
  if (heapShare > 0.85) {
    memCheck.status = heapShare > 0.95 ? "failed" : "degraded";
    memCheck.problem = { code: "server-memory-high", severity: heapShare > 0.95 ? "error" : "warning", title: "Server memory nearly full", causes: ["A memory leak in a request handler", "Large uploads or documents held in memory", "Too little memory for the load"], dependencies: ["Node.js heap limit (--max-old-space-size)"], recoveries: [{ action: "server.clear_safe_cache", params: {} }] };
  }
  out.push(memCheck);
  // Event loop.
  const loop = loopDelay();
  const loopCheck = check({ id: "os.event_loop", subsystem: "os", component: "server event loop", target: "server", measured: loop });
  if (!loop) { loopCheck.status = "unknown"; loopCheck.evidence.push("Not measured yet in this process (the monitor started now)."); }
  else {
    loopCheck.evidence.push(`Event loop delay p50 ${loop.p50Ms} ms, p99 ${loop.p99Ms} ms, max ${loop.maxMs} ms since the last check.`);
    if (loop.p99Ms > 200) { loopCheck.status = loop.p99Ms > 1000 ? "failed" : "degraded"; loopCheck.problem = { code: "server-event-loop-slow", severity: loop.p99Ms > 1000 ? "error" : "warning", title: "Server responding slowly", causes: ["Synchronous work blocking requests (large JSON, crypto)", "The machine is overloaded"], dependencies: ["CPU"], recoveries: [] }; }
  }
  out.push(loopCheck);
  // Disk.
  const diskCheck = check({ id: "os.disk", subsystem: "os", component: "server disk", target: "server" });
  try {
    const stat = fs.statfsSync(os.tmpdir());
    const free = (stat.bavail * stat.bsize) / (stat.blocks * stat.bsize);
    diskCheck.measured = { freeGb: Math.round((stat.bavail * stat.bsize) / 1e8) / 10, freePercent: pct(free), path: "temporary directory" };
    diskCheck.evidence.push(`${diskCheck.measured.freePercent}% free (${diskCheck.measured.freeGb} GB) where the server writes temporary files.`);
    if (free < 0.1) { diskCheck.status = free < 0.03 ? "failed" : "degraded"; diskCheck.problem = { code: "server-disk-low", severity: free < 0.03 ? "error" : "warning", title: "Server disk nearly full", causes: ["Logs or traces growing", "Uploaded files or temporary files left behind"], dependencies: ["The server's disk"], recoveries: [] }; }
  } catch { diskCheck.status = "unknown"; diskCheck.evidence.push("This platform doesn't report free disk space to the server."); }
  out.push(diskCheck);
  // Load.
  const load = os.loadavg()[0];
  const cpus = os.cpus().length || 1;
  out.push(check({ id: "os.load", subsystem: "os", component: "server CPU load", target: "server", measured: { load1: Math.round(load * 100) / 100, cpus }, evidence: [`1-minute load ${Math.round(load * 100) / 100} on ${cpus} CPU${cpus === 1 ? "" : "s"}.`], status: load / cpus > 2 ? "degraded" : "ok", ...(load / cpus > 2 ? { problem: { code: "server-cpu-overloaded", severity: "warning", title: "Server CPU overloaded", causes: ["More requests than the machine can serve", "A runaway process"], dependencies: ["CPU"], recoveries: [] } } : {}) }));
  // Database.
  const dbCheck = check({ id: "os.database", subsystem: "os", component: "database", target: "server" });
  if (!db) { dbCheck.status = "not-configured"; dbCheck.evidence.push("No database is configured: account features are unavailable."); }
  else {
    const started = Date.now();
    try {
      await db.query("SELECT 1 AS ok");
      const ms = Date.now() - started;
      dbCheck.measured = { latencyMs: ms, kind: db.kind, schemaVersion: db.schemaVersion ?? null };
      dbCheck.evidence.push(`${db.kind} answered in ${ms} ms; schema version ${db.schemaVersion ?? "unknown"}.`);
      if (ms > 1000) { dbCheck.status = "degraded"; dbCheck.problem = { code: "database-slow", severity: "warning", title: "Database answering slowly", causes: ["Network latency to the database", "The database is overloaded or on a cold start"], dependencies: ["The database host"], recoveries: [] }; }
    } catch (error) {
      dbCheck.status = "failed";
      dbCheck.evidence.push(`The database didn't answer (${error?.code || error?.name || "error"}).`);
      dbCheck.problem = { code: "database-unreachable", severity: "error", title: "Database unreachable", causes: ["The database host is down or unreachable", "Credentials changed"], dependencies: ["DATABASE_URL"], recoveries: [] };
    }
  }
  out.push(dbCheck);

  // AI: providers, from real calls.
  const health = providerHealth({ now });
  const configured = listProviders().filter((provider) => provider.configured);
  const primary = defaultProviderId();
  const providerCheck = check({ id: "ai.providers", subsystem: "ai", component: "model providers", target: "server", measured: { primary, fallbacks: gateway.configuredBackups(primary), calls: health, avoided: gateway.providerAvoidance() } });
  if (!Object.keys(health).length) { providerCheck.status = "unknown"; providerCheck.evidence.push("No model calls recorded in this server process in the last 15 minutes, so provider health isn't measured."); }
  for (const [id, entry] of Object.entries(health)) {
    providerCheck.evidence.push(`${id}: ${entry.calls} call${entry.calls === 1 ? "" : "s"}, ${entry.failures} failed${entry.lastError ? ` (last error ${entry.lastError})` : ""}${entry.medianLatencyMs !== null ? `, median ${entry.medianLatencyMs} ms` : ""}.`);
    if (entry.calls >= 3 && entry.failureShare >= 0.5 && (!entry.lastOkAt || entry.lastErrorAt > entry.lastOkAt)) {
      providerCheck.status = "degraded";
      const backups = gateway.configuredBackups(id);
      providerCheck.problems = [...(providerCheck.problems || []), { code: "provider-failing", key: id, severity: "warning", title: `Model provider ${id} is failing`, causes: entry.lastError === "auth" ? ["The provider key is invalid or revoked"] : entry.lastError === "rate_limited" ? ["The account hit its rate limit or quota"] : ["The provider is having an outage", "The network path to it is failing", "A key or quota problem"], dependencies: [`${id} API`, "the provider key", "outbound network"], recoveries: backups.length ? [{ action: "server.switch_backup_provider", params: { provider: id, minutes: 30 } }] : [], manual: backups.length ? null : "No backup provider is configured (HANNAH_PROVIDER_FALLBACKS). Check the provider's status page and the key.", measured: entry }];
    }
  }
  if (!configured.length) { providerCheck.status = "failed"; providerCheck.problem = { code: "no-provider", severity: "error", title: "No model provider configured", causes: ["No provider key set on the server"], dependencies: ["provider keys"], recoveries: [] }; }
  out.push(providerCheck);

  // AI: local inference, only when the operator set one up.
  const localWanted = listProviders().some((provider) => provider.local && provider.id === primary) || Boolean(process.env.OLLAMA_BASE_URL);
  const localCheck = check({ id: "ai.local_inference", subsystem: "ai", component: "local inference (Ollama)", target: "server" });
  if (!localWanted) { localCheck.status = "not-configured"; localCheck.evidence.push("No local model runtime is set up on this server."); }
  else {
    const result = await ollama().catch(() => null);
    localCheck.measured = result ? { reachable: result.reachable, ready: result.ready, model: result.model, modelPresent: result.modelPresent, latencyMs: result.latencyMs } : null;
    if (!result?.ready) {
      localCheck.status = "failed";
      localCheck.evidence.push(result ? `Ollama at ${result.baseUrl || "its address"}: ${result.reachable ? `reachable, model ${result.model} ${result.modelPresent ? "present" : "missing"}` : `not reachable (${result.error})`}.` : "The probe couldn't run.");
      localCheck.problem = { code: "local-inference-down", severity: "warning", title: "Local inference not ready", causes: result?.reachable ? ["The configured model isn't pulled"] : ["Ollama isn't running", "It listens on another address"], dependencies: ["Ollama service", "OLLAMA_BASE_URL"], recoveries: [], manual: result?.reachable ? `Run \`ollama pull ${result.model}\` on that machine.` : "Start Ollama on that machine." };
    } else localCheck.evidence.push(`Ollama ready with ${result.model} (${result.latencyMs} ms).`);
  }
  out.push(localCheck);

  // AI: the agent fallback service, only when configured.
  const agentCheck = check({ id: "ai.agents", subsystem: "ai", component: "agent fallback service", target: "server" });
  if (!process.env.PYTHON_FALLBACK_URL) { agentCheck.status = "not-configured"; agentCheck.evidence.push("No agent fallback service is configured (PYTHON_FALLBACK_URL)."); }
  else {
    const result = await pythonFallback().catch(() => null);
    agentCheck.measured = result ? { reachable: result.reachable, ready: result.ready, latencyMs: result.latencyMs } : null;
    if (!result?.ready) { agentCheck.status = "failed"; agentCheck.evidence.push(`Not ready (${result?.error || "probe failed"}).`); agentCheck.problem = { code: "agent-service-down", severity: "warning", title: "Agent fallback service not ready", causes: ["The service isn't running", "Its address changed"], dependencies: ["PYTHON_FALLBACK_URL"], recoveries: [] }; }
    else agentCheck.evidence.push(`Ready (${result.latencyMs} ms).`);
  }
  out.push(agentCheck);
  return out;
}

/** Checks of one account's robots, Robot OS instances, hubs, devices, memory and queues. */
async function accountChecks({ db, userId, now, robotics, devices, robotOSEnvelopes }) {
  const out = [];
  // AI: memory store and queues for this account.
  const memoryCheck = check({ id: "ai.memory", subsystem: "ai", component: "memory store", target: "account" });
  try {
    const row = (await db.query("SELECT value, updated_at FROM hannah_user_data WHERE user_id = $1 AND namespace = $2", [userId, "memories"])).rows[0];
    let count = null;
    try { count = row ? JSON.parse(row.value).length : 0; } catch { count = null; }
    memoryCheck.measured = { syncedMemories: count, lastUpdatedAt: row ? Number(row.updated_at) : null };
    if (count === null) { memoryCheck.status = "failed"; memoryCheck.problem = { code: "memory-store-corrupt", severity: "warning", title: "Synced memories can't be read", causes: ["The stored list is not valid JSON"], dependencies: ["hannah_user_data"], recoveries: [] }; }
    memoryCheck.evidence.push(count === null ? "The synced memory list isn't readable." : `${count} synced memories${row ? `, last updated ${new Date(Number(row.updated_at)).toISOString()}` : ""}.`);
  } catch { memoryCheck.status = "unknown"; memoryCheck.evidence.push("The memory store couldn't be read."); }
  out.push(memoryCheck);

  const queueCheck = check({ id: "ai.queues", subsystem: "ai", component: "queues", target: "account", measured: {} });
  const count = async (sql, values) => Number((await db.query(sql, values).catch(() => ({ rows: [{ n: null }] }))).rows[0]?.n ?? null);
  queueCheck.measured.actionsWaitingApproval = await count("SELECT COUNT(*) AS n FROM hannah_actions WHERE user_id = $1 AND status = 'waiting-approval' AND (expires_at IS NULL OR expires_at > $2)", [userId, now]);
  queueCheck.measured.workforceTasksQueued = await count("SELECT COUNT(*) AS n FROM hannah_workforce_tasks WHERE user_id = $1 AND status IN ('queued', 'pending')", [userId]);
  const expired = await count("SELECT COUNT(*) AS n FROM hannah_robot_os_commands WHERE user_id = $1 AND status = 'pending' AND expires_at <= $2 AND expires_at > $3", [userId, now, now - 86_400_000]);
  queueCheck.measured.robotOSCommandsUncollected = expired;
  queueCheck.evidence.push(`${queueCheck.measured.actionsWaitingApproval ?? "?"} actions waiting for approval, ${queueCheck.measured.workforceTasksQueued ?? "?"} workforce tasks queued, ${expired ?? "?"} Robot OS commands expired uncollected in the last 24 hours.`);
  if (expired >= 2) { queueCheck.status = "degraded"; queueCheck.problem = { code: "robot-os-commands-uncollected", severity: "warning", title: "Robot OS commands expiring uncollected", causes: ["The robot's bridge isn't polling HANNAH", "The robot is offline"], dependencies: ["Robot OS remote gateway", "the robot's network"], recoveries: [] }; }
  out.push(queueCheck);

  // Robots.
  const robots = robotics ? (await robotics.listRobots(db, userId).catch(() => [])).filter((robot) => robot.status === "enrolled") : [];
  for (const robot of robots) {
    const target = robot.id;
    const tag = { target, targetName: robot.name, simulated: Boolean(robot.simulated) };
    const state = robot.state || {};
    const events = await robotics.events(db, userId, { robotId: robot.id, limit: 30 }).catch(() => []);
    const logs = events.slice(0, 8).map((event) => ({ at: event.at, source: event.source, message: `${event.type}: ${event.message}` }));
    const link = check({ id: "runtime.link", subsystem: "runtime", component: `${robot.name}: link to HANNAH`, ...tag, measured: { online: robot.online, lastSeenAt: robot.lastSeenAt || null } });
    if (!robot.online) {
      link.status = "failed";
      link.evidence.push(robot.lastSeenAt ? `Last report ${ago(robot.lastSeenAt, now)}.` : "Never connected.");
      link.problem = { code: "robot-offline", severity: "warning", title: `${robot.name} isn't reporting`, logs, causes: ["The robot's runtime isn't running", "The robot lost its network", "The robot is switched off"], dependencies: ["the robot's runtime (hannah_robot)", "the robot's network", "this server"], recoveries: [], manual: "A robot opens its own connection to HANNAH: check its runtime and network at the robot." };
    } else link.evidence.push(`Reporting; last report ${ago(robot.lastSeenAt, now)}.`);
    out.push(link);
    if (robot.online || robot.lastSeenAt) {
      const note = robot.online ? "" : " (from its last report)";
      const estop = check({ id: "hardware.estop", subsystem: "hardware", component: `${robot.name}: emergency stop`, ...tag, measured: { engaged: Boolean(state.estop?.engaged), source: state.estop?.source || null } });
      if (state.estop?.engaged) { estop.status = "failed"; estop.evidence.push(`Engaged${note}, source ${state.estop.source || "not stated"}.`); estop.problem = { code: "estop-engaged", severity: "error", title: `${robot.name}: emergency stop engaged`, logs, causes: ["Someone pressed it", "The robot's own safety system tripped"], dependencies: ["the robot's emergency stop circuit"], recoveries: [{ action: "robot.release_estop", params: { robot: robot.id } }], manual: "Find out why it was pressed, then release it at the robot." }; }
      else estop.evidence.push(state.estop ? `Not engaged${note}.` : `Not reported${note}.`);
      if (!state.estop) estop.status = "unknown";
      out.push(estop);
      const faults = Array.isArray(state.faults) ? state.faults : [];
      const faultCheck = check({ id: "hardware.faults", subsystem: "hardware", component: `${robot.name}: controller faults`, ...tag, measured: { active: faults.length } });
      if (faults.length) { faultCheck.status = "failed"; faultCheck.evidence.push(...faults.slice(0, 5).map((fault) => `${fault.code || "fault"}: ${String(fault.message || "").slice(0, 160)}${note}`)); faultCheck.problem = { code: "controller-fault", severity: "error", title: `${robot.name}: active fault`, logs, causes: ["See the fault code: the controller reported it"], dependencies: ["the robot's motor controllers"], recoveries: [{ action: "robot.clear_motor_fault", params: { robot: robot.id } }], manual: "Fix the cause, then acknowledge the fault at the robot.", confirmed: true }; }
      else faultCheck.evidence.push(`No active faults reported${note}.`);
      out.push(faultCheck);
      const down = (robot.sensors || []).filter((sensor) => state.sensors?.[sensor.id]?.ok === false);
      const sensorCheck = check({ id: "hardware.sensors", subsystem: "hardware", component: `${robot.name}: sensors`, ...tag, measured: { registered: (robot.sensors || []).length, notReporting: down.map((sensor) => sensor.id) } });
      if (down.length) { sensorCheck.status = "degraded"; sensorCheck.evidence.push(`Not working: ${down.map((sensor) => `${sensor.id} (${state.sensors[sensor.id].problem || "not ok"})`).join(", ")}${note}.`); sensorCheck.problem = { code: "sensor-down", key: down.map((sensor) => sensor.id).join(","), severity: down.some((sensor) => ["lidar", "odometry"].includes(sensor.id)) ? "error" : "warning", title: `${robot.name}: sensor not working`, logs, causes: ["A loose cable or connector", "The sensor's driver stopped", "The sensor failed"], dependencies: down.map((sensor) => `${sensor.id} (${sensor.type})`), recoveries: [], manual: "Check the sensor's cable and its driver on the robot." }; }
      else sensorCheck.evidence.push(`${(robot.sensors || []).length} registered sensors, none reported as not working${note}.`);
      out.push(sensorCheck);
      const battery = check({ id: "hardware.battery", subsystem: "hardware", component: `${robot.name}: battery`, ...tag, measured: Number.isFinite(state.battery?.percent) ? { percent: state.battery.percent, charging: Boolean(state.battery.charging), minimumForMission: robot.limits?.minBatteryPercent ?? null } : null });
      if (!battery.measured) { battery.status = "unknown"; battery.evidence.push("No battery reading reported."); }
      else if (Number.isFinite(robot.limits?.minBatteryPercent) && state.battery.percent < robot.limits.minBatteryPercent && !state.battery.charging) { battery.status = "degraded"; battery.evidence.push(`${state.battery.percent}%, below the ${robot.limits.minBatteryPercent}% a mission needs${note}.`); battery.problem = { code: "battery-low", severity: "warning", title: `${robot.name}: battery low`, logs, causes: ["It needs charging"], dependencies: ["the battery", "the dock"], recoveries: [], manual: "Send it to its dock or charge it (moving it is a mission, approved as usual)." }; }
      else battery.evidence.push(`${state.battery.percent}%${state.battery.charging ? ", charging" : ""}${note}.`);
      out.push(battery);
    }
    const lost = (await robotics.listMissions(db, userId, { robotId: robot.id, limit: 30 }).catch(() => [])).filter((mission) => mission.status === "lost" && now - (mission.finishedAt || mission.createdAt) < 86_400_000);
    const missions = check({ id: "runtime.missions", subsystem: "runtime", component: `${robot.name}: missions`, ...tag, measured: { lostLast24h: lost.length } });
    if (lost.length >= 2) { missions.status = "degraded"; missions.evidence.push(`${lost.length} missions lost in the last 24 hours (accepted, then the robot stopped reporting).`); missions.problem = { code: "missions-lost", severity: "warning", title: `${robot.name}: missions lost mid-way`, logs, causes: ["The link drops while the robot works", "The runtime restarts during missions"], dependencies: ["the robot's network", "the robot's runtime"], recoveries: [] }; }
    else missions.evidence.push(`${lost.length} missions lost in the last 24 hours.`);
    out.push(missions);

    // Robot OS, when this robot has one reporting.
    if (!robotOSEnvelopes) continue;
    const envelopes = await robotOSEnvelopes.listEnvelopes(db, userId, { robotId: robot.id, limit: 60 }).catch(() => []);
    if (!envelopes.length) continue;
    const latest = envelopes[0];
    const osLink = check({ id: "os.robot_link", subsystem: "os", component: `${robot.name}: Robot OS bridge`, ...tag, measured: { lastEnvelopeAt: latest.receivedAt, kind: latest.kind } });
    if (now - latest.receivedAt > ROBOT_OS_SILENT_MS) { osLink.status = "failed"; osLink.evidence.push(`Last envelope (${latest.kind}) ${ago(latest.receivedAt, now)}.`); osLink.problem = { code: "robot-os-silent", severity: "warning", title: `${robot.name}: Robot OS stopped reporting`, logs: envelopes.slice(0, 5).map((env) => ({ at: env.receivedAt, source: "robot-os", message: env.kind })), causes: ["The remote gateway service stopped", "The robot lost its network", "The robot is switched off"], dependencies: ["Robot OS remote-gateway service", "the robot's network"], recoveries: [], manual: "The bridge connects from the robot; check its remote-gateway service at the robot." }; }
    else osLink.evidence.push(`Last envelope (${latest.kind}) ${ago(latest.receivedAt, now)}.`);
    out.push(osLink);
    const withHealth = envelopes.find((env) => env.payload?.health && Array.isArray(env.payload.health.services));
    if (withHealth) {
      const services = withHealth.payload.health.services;
      const bad = services.filter((service) => service && (service.state !== "ready" || service.stale));
      const svc = check({ id: "os.robot_services", subsystem: "os", component: `${robot.name}: Robot OS services`, ...tag, measured: { reportedAt: withHealth.receivedAt, robotReady: Boolean(withHealth.payload.health.robot_ready), services: services.map((service) => ({ name: service.name, state: service.state, stale: Boolean(service.stale) })) } });
      svc.evidence.push(`Reported ${ago(withHealth.receivedAt, now)}: ${services.map((service) => `${service.name} ${service.state}${service.stale ? " (stale)" : ""}`).join(", ")}.`);
      if (bad.length) {
        svc.status = bad.some((service) => CRITICAL_SERVICES.includes(service.name)) ? "failed" : "degraded";
        svc.problems = bad.map((service) => {
          const critical = CRITICAL_SERVICES.includes(service.name);
          const restartable = RESTARTABLE_SERVICES.includes(service.name);
          return {
            code: critical ? "robot-critical-service-down" : "robot-service-down", key: service.name, severity: critical ? "error" : "warning", title: `${robot.name}: ${service.name} ${service.state}${service.stale ? " (stale)" : ""}`,
            logs: envelopes.filter((env) => env.kind === "event").slice(0, 5).map((env) => ({ at: env.receivedAt, source: "robot-os", message: String(env.payload?.type || env.payload?.event || "event") })),
            causes: ["The service crashed or is restarting", "Its configuration or hardware isn't available"], dependencies: [`hannah-${service.name}.service`, ...(service.name === "telemetry" ? ["the robot's network"] : [])],
            recoveries: critical ? [{ action: "robot.restart_critical_service", params: { robot: robot.id, service: service.name } }] : service.name === "telemetry" ? [{ action: "robot.reconnect_telemetry", params: { robot: robot.id } }] : restartable ? [{ action: "robot.restart_service", params: { robot: robot.id, service: service.name } }] : [],
            manual: critical ? "A safety or motion service: a person checks the robot, then restarts it there." : null,
          };
        });
      }
      out.push(svc);
    }
    const withUpdate = envelopes.find((env) => env.payload?.update && typeof env.payload.update === "object");
    if (withUpdate) {
      const update = withUpdate.payload.update;
      const failed = ["failed", "rolled-back", "recovery"].includes(String(update.status || update.state || ""));
      const up = check({ id: "os.robot_update", subsystem: "os", component: `${robot.name}: Robot OS update`, ...tag, measured: { status: update.status || update.state || null, currentVersion: update.current_version || update.currentVersion || null, lastGoodVersion: update.last_good_version || update.lastGoodVersion || null } });
      up.evidence.push(`Update state ${up.measured.status || "unknown"}, running ${up.measured.currentVersion || "unknown"}, last good ${up.measured.lastGoodVersion || "unknown"}.`);
      if (failed) { up.status = "failed"; up.problem = { code: "robot-update-failed", severity: "error", title: `${robot.name}: update failed`, causes: ["The new image didn't pass its health gate", "The update was interrupted"], dependencies: ["systemd-sysupdate", "the A/B image slots"], recoveries: up.measured.lastGoodVersion ? [{ action: "robot.restore_app_version", params: { robot: robot.id, reason: "diagnostics: update failed" } }] : [] }; }
      out.push(up);
    }
    const withConfig = envelopes.find((env) => env.payload?.config && typeof env.payload.config === "object");
    if (withConfig?.payload.config.pending === true && withConfig.payload.config.valid === true) {
      out.push(check({ id: "os.robot_config", subsystem: "os", component: `${robot.name}: Robot OS configuration`, ...tag, status: "degraded", measured: withConfig.payload.config, evidence: ["A validated configuration file is waiting to be applied."], problem: { code: "robot-config-pending", severity: "info", title: `${robot.name}: new configuration not applied yet`, causes: ["The file changed since the services started"], dependencies: ["/etc/hannah-robot-os/config.json"], recoveries: [{ action: "robot.reload_config", params: { robot: robot.id } }] } }));
    }
  }

  // Hubs and devices.
  if (devices) {
    const hubs = await devices.listHubs(db, userId).catch(() => []);
    for (const hub of hubs.filter((item) => item.status === "enrolled")) {
      const hubCheck = check({ id: "runtime.hub_link", subsystem: "runtime", component: `${hub.name}: hub link`, target: hub.id, targetName: hub.name, measured: { connection: hub.connection, lastSeenAt: hub.lastSeenAt || null } });
      if (hub.connection !== "online") { hubCheck.status = "failed"; hubCheck.evidence.push(hub.lastSeenAt ? `Last report ${ago(hub.lastSeenAt, now)}.` : "Never connected."); hubCheck.problem = { code: "hub-offline", severity: "warning", title: `Hub ${hub.name} isn't reporting`, causes: ["The hub's software stopped", "The hub lost its network", "It is switched off"], dependencies: ["the hub (hannah_edge)", "its network"], recoveries: [], manual: "A hub opens its own connection: check it where it runs. Its automations keep running locally." }; }
      else hubCheck.evidence.push(`Reporting; last report ${ago(hub.lastSeenAt, now)}.`);
      out.push(hubCheck);
    }
    const list = await devices.listDevices(db, userId).catch(() => []);
    for (const device of list.filter((item) => item.status === "active")) {
      const tag = { target: device.id, targetName: device.name, simulated: device.profile?.simulated === true };
      const devCheck = check({ id: "hardware.device", subsystem: "hardware", component: `${device.name}: device`, ...tag, measured: { connection: device.connection, lastSeenAt: device.lastSeenAt || null } });
      if (["offline", "error", "no-data"].includes(device.connection)) {
        devCheck.status = "failed";
        devCheck.evidence.push(`Its hub reports it ${device.connection}${device.connectionDetail ? `: ${device.connectionDetail}` : ""}.`);
        devCheck.problem = { code: "device-disconnected", severity: "warning", title: `${device.name} isn't connected`, causes: ["The device lost power or its network", "Its address or credentials changed", "The hub's adapter for it stopped"], dependencies: [`hub ${device.hub?.name || ""}`, "the device's network"], recoveries: [{ action: "device.reconnect", params: { device: device.id } }] };
      } else devCheck.evidence.push(device.connection === "hub-offline" ? "Unknown: its hub isn't reporting." : `Connection ${device.connection}.`);
      if (device.connection === "hub-offline") devCheck.status = "unknown";
      out.push(devCheck);
    }
  }
  return out;
}

module.exports = { accountChecks, serverChecks };
