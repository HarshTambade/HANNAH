"use strict";

/**
 * Fleet: which robot should take a task, and why not the others.
 *
 * choose() is a pure function over the registry's view of each robot. A robot
 * is eligible only when everything the Safety Gateway would check for it
 * already holds: enrolled and connected, offers the capability, commissioned
 * if it is physical, emergency stop released, no fault, sensors reporting,
 * battery above its minimum, not already on a mission, and (when the goal is a
 * name) it has that destination on its own map. Names are resolved per robot:
 * "kitchen" on one robot's map says nothing about another's.
 *
 * Among the eligible, the nearest to the goal wins (straight-line distance on
 * its map, as it reports its position), then the fuller battery, then the
 * name. Every robot that wasn't chosen comes back with its reason.
 *
 * One reservation rule: a goal within RESERVE_M of where another robot on the
 * same map is already heading is refused. It does not plan routes for several
 * robots or keep them out of each other's way in a corridor: that is traffic
 * management, and it is not built.
 */
const contract = require("./contract");

const RESERVE_M = 0.8;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

/** The first point a task sends a robot to, on that robot's own map. `problem` when it can't be resolved for this robot. */
function goalFor(robot, task) {
  if (task.capability === "return_to_dock") return robot.dock && finite(robot.dock.x) ? { point: robot.dock } : { problem: "has no dock" };
  const target = task.capability === "inspect_area" ? (task.waypoints || [])[0] : task;
  if (!target) return { problem: "the task names no place" };
  if (target.place) {
    const wanted = String(target.place).trim().toLowerCase();
    const match = Object.entries(robot.places || {}).find(([name]) => name.toLowerCase() === wanted);
    return match ? { point: match[1], place: match[0] } : { problem: `has no destination called “${String(target.place).slice(0, 40)}”` };
  }
  return finite(target.x) && finite(target.y) ? { point: { x: target.x, y: target.y } } : { problem: "the task names no place" };
}

/** Why a robot can't take a task now, or null when it can. */
function unavailable(robot, definition) {
  if (robot.status !== "enrolled") return robot.status === "revoked" ? "access revoked" : "not enrolled yet";
  if (!robot.online) return robot.lastSeenAt ? "offline" : "never connected";
  if (!definition.implicit && !robot.capabilities.includes(definition.id)) return `doesn't offer “${definition.title}”`;
  if ((robot.disabled || []).includes(definition.id)) return `“${definition.title}” is switched off for it`;
  if (!robot.simulated && robot.commissioning?.required && !["approved", "trial"].includes(robot.commissioning.status)) return "not commissioned";
  const state = robot.state || {};
  if (state.estop?.engaged) return "emergency stop engaged";
  if ((state.faults || []).length) return `fault: ${String(state.faults[0]?.message || state.faults[0]?.code).slice(0, 60)}`;
  if (state.motorsEnabled === false) return "motors disabled";
  if (state.localized === false) return "not localized";
  const blind = ["lidar", "odometry"].filter((id) => state.sensors?.[id]?.ok === false);
  if (blind.length) return `${blind.join(" and ")} sensor not reporting`;
  if (definition.id !== "return_to_dock" && finite(robot.limits?.minBatteryPercent) && finite(state.battery?.percent) && state.battery.percent < robot.limits.minBatteryPercent) return `battery ${Math.round(state.battery.percent)}%, below its ${robot.limits.minBatteryPercent}% minimum`;
  return null;
}

/**
 * Pick a robot for a task.
 *   robots    the registry's views
 *   task      { capability, place? | x,y? | waypoints? }
 *   active    unfinished missions of the account: [{ robotId, capability, params, status }]
 *   only      optional robot id or name the caller insists on
 * Returns { chosen, considered: [{ id, name, eligible, reason?, distanceM?, batteryPercent? }], conflict? }.
 */
function choose({ robots, task, active = [], only = "" }) {
  const definition = contract.capability(task.capability);
  // Only tasks where "which robot" is a question of where it stands. An arm isn't chosen by distance.
  if (!definition || !["navigate_to", "return_to_dock", "inspect_area"].includes(definition.id)) return { chosen: null, considered: [], problem: `“${String(task.capability).slice(0, 40)}” isn't a task a robot can be assigned.` };
  const busy = new Map(active.filter((mission) => contract.capability(mission.capability)?.motion).map((mission) => [mission.robotId, mission]));
  const byId = new Map(robots.map((robot) => [robot.id, robot]));
  const considered = robots
    .filter((robot) => !only || robot.id === only || robot.name.toLowerCase() === String(only).toLowerCase())
    .map((robot) => {
      const entry = { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical", eligible: false, batteryPercent: robot.online ? robot.state?.battery?.percent ?? null : null };
      const reason = unavailable(robot, definition);
      if (reason) return { ...entry, reason };
      if (busy.has(robot.id)) return { ...entry, reason: `busy: ${contract.capability(busy.get(robot.id).capability)?.title || busy.get(robot.id).capability}${busy.get(robot.id).status === "paused" ? " (paused)" : ""}` };
      const goal = goalFor(robot, task);
      if (goal.problem) return { ...entry, reason: goal.problem };
      // Is another robot on the same map already heading there?
      for (const mission of busy.values()) {
        const other = byId.get(mission.robotId);
        const target = mission.capability === "inspect_area" ? (mission.params.waypoints || []).at(-1) : mission.params;
        if (other && other.id !== robot.id && other.mapName && other.mapName === robot.mapName && finite(target?.x) && Math.hypot(target.x - goal.point.x, target.y - goal.point.y) < RESERVE_M) {
          return { ...entry, reason: `${other.name} is already heading to that spot`, conflict: true };
        }
      }
      const pose = robot.state?.pose;
      return { ...entry, eligible: true, place: goal.place || null, goal: { x: round(goal.point.x), y: round(goal.point.y) }, distanceM: finite(pose?.x) ? round(Math.hypot(pose.x - goal.point.x, pose.y - goal.point.y)) : null };
    });
  const eligible = considered.filter((entry) => entry.eligible).sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || (b.batteryPercent ?? 0) - (a.batteryPercent ?? 0) || a.name.localeCompare(b.name));
  const chosen = eligible[0] || null;
  const why = chosen ? (eligible.length === 1 ? "the only robot that can take it now" : `the nearest of ${eligible.length} that can take it${chosen.distanceM !== null ? ` (${chosen.distanceM} m away)` : ""}`) : "";
  return { chosen: chosen ? { ...chosen, why } : null, considered, conflict: considered.some((entry) => entry.conflict) };
}

/** One line per robot for a person or a model: who can work, who can't, and why. */
function overview(robots, active = []) {
  const busy = new Map(active.map((mission) => [mission.robotId, mission]));
  return robots.map((robot) => {
    const state = robot.state || {};
    const mission = busy.get(robot.id);
    const problems = [];
    if (robot.status === "enrolled" && !robot.online) problems.push(robot.lastSeenAt ? "offline" : "never connected");
    if (robot.online && state.estop?.engaged) problems.push("emergency stop engaged");
    if (robot.online) for (const fault of state.faults || []) problems.push(`fault: ${String(fault.message || fault.code).slice(0, 80)}`);
    if (robot.online) for (const [id, reading] of Object.entries(state.sensors || {})) { if (reading?.ok === false) problems.push(`${id} sensor not reporting`); }
    if (robot.online && finite(robot.limits?.minBatteryPercent) && finite(state.battery?.percent) && state.battery.percent < robot.limits.minBatteryPercent) problems.push(`battery low (${Math.round(state.battery.percent)}%)`);
    if (!robot.simulated && robot.commissioning?.required && robot.commissioning.status !== "approved") problems.push(`not commissioned (${robot.commissioning.done} of ${robot.commissioning.total})`);
    return {
      id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical", type: robot.robotType || null, connection: robot.connection, mode: robot.mode, map: robot.mapName || null,
      position: robot.online && finite(state.pose?.x) ? { x: round(state.pose.x), y: round(state.pose.y) } : null,
      batteryPercent: robot.online ? state.battery?.percent ?? null : null, charging: robot.online ? Boolean(state.battery?.charging) : null,
      mission: mission ? { id: mission.id, what: contract.capability(mission.capability)?.title || mission.capability, status: mission.status } : null,
      available: robot.status === "enrolled" && robot.online && !mission && problems.length === 0,
      health: problems.length ? "attention" : robot.online ? "ok" : "unknown", problems,
      capabilities: robot.capabilities.filter((id) => !(robot.disabled || []).includes(id)), destinations: Object.keys(robot.places || {}),
    };
  });
}

/**
 * What the evidence says about one robot's condition. Every finding names what
 * was measured or recorded; nothing is inferred beyond it, and a recommendation
 * is a fixed rule attached to a finding, not a diagnosis.
 */
function diagnose(robot, { events = [], missions = [], maintenance = [], now = Date.now() } = {}) {
  const findings = [];
  const add = (severity, title, evidence, recommendation) => findings.push({ severity, title, evidence, ...(recommendation ? { recommendation } : {}) });
  const state = robot.state || {};
  const day = events.filter((event) => now - event.at < 86_400_000);
  if (robot.status !== "enrolled") add("info", "Not in service", `The robot's record is “${robot.status}”.`);
  else if (!robot.online) add("warning", "Offline", robot.lastSeenAt ? `Last report ${Math.round((now - robot.lastSeenAt) / 1000)} s ago. Everything below is from that report.` : "It has never connected.", "Check that its runtime is running and that it can reach HANNAH.");
  if (state.estop?.engaged) add("error", "Emergency stop engaged", `Reported by the robot (${state.estop.source || "source not stated"}).`, "It has to be released at the robot.");
  for (const fault of state.faults || []) add("error", "Active fault", `${fault.code || "fault"}: ${String(fault.message || "").slice(0, 200)}`, "A fault is acknowledged at the robot once its cause is fixed.");
  for (const sensor of robot.sensors || []) {
    const reading = state.sensors?.[sensor.id];
    if (reading?.ok === false) add("error", `Sensor not reporting: ${sensor.id}`, `The robot reports ${sensor.id} (${sensor.type}) as ${reading.problem || "not working"}.`, ["lidar", "odometry"].includes(sensor.id) ? "The robot won't be moved until it reports again." : undefined);
    else if (robot.online && reading === undefined) add("warning", `No reading from ${sensor.id}`, `The robot registered ${sensor.id} (${sensor.type}) and its report carries no reading for it.`);
  }
  if (finite(state.battery?.percent)) {
    const low = finite(robot.limits?.minBatteryPercent) && state.battery.percent < robot.limits.minBatteryPercent;
    add(low ? "warning" : "info", low ? "Battery below the minimum for a mission" : "Battery", `${Math.round(state.battery.percent)}%${state.battery.charging ? ", charging" : ""}${finite(robot.limits?.minBatteryPercent) ? `; minimum to start ${robot.limits.minBatteryPercent}%` : ""}.`, low ? "Send it to its dock or charge it." : undefined);
  } else if (robot.online) add("info", "No battery reading", "The robot's report carries no battery reading.");
  const lost = day.filter((event) => event.type === "link-lost").length;
  if (lost) add(lost >= 3 ? "warning" : "info", "Link to HANNAH lost", `${lost} time${lost === 1 ? "" : "s"} in the last 24 hours, by the robot's own events.`, lost >= 3 ? "Check the robot's network." : undefined);
  const refused = day.filter((event) => event.type === "command-rejected" || event.type === "command-refused").length;
  if (refused) add("info", "Commands the robot refused", `${refused} in the last 24 hours.`);
  const recent = missions.filter((mission) => mission.final).slice(0, 20);
  const bad = recent.filter((mission) => ["failed", "timed-out", "lost", "unverified"].includes(mission.status));
  if (recent.length >= 3 && bad.length / recent.length >= 0.5) add("warning", "Missions not finishing", `${bad.length} of the last ${recent.length} finished missions failed, timed out, were lost or couldn't be verified.`, "Look at the reasons in the mission history.");
  if (finite(state.sim?.odometryError) && state.sim.odometryError > 0.3) add("warning", "Position estimate has drifted", `The simulator's ground truth is ${round(state.sim.odometryError)} m from where the robot believes it is.`, "Send it to its dock, where its position is reset.");
  if (!robot.simulated && robot.commissioning?.required && robot.commissioning.status !== "approved") add("warning", "Not commissioned", `${robot.commissioning.done} of ${robot.commissioning.total} checks done${robot.commissioning.resetReason ? `: ${robot.commissioning.resetReason}` : ""}.`, "Finish commissioning before it may move.");
  add("info", "Software", `Runtime ${robot.runtimeVersion || "unknown"} (${robot.adapter || "unknown"} adapter), software ${robot.softwareVersion || "unknown"}, firmware ${robot.firmwareVersion || "unknown"}; configuration version ${robot.configVersion}.`);
  if (maintenance.length) add("info", "Last maintenance entry", `${new Date(maintenance[0].at).toISOString().slice(0, 10)}, ${maintenance[0].kind}: ${maintenance[0].note.slice(0, 160)}`);
  const worst = findings.some((item) => item.severity === "error") ? "needs attention now" : findings.some((item) => item.severity === "warning") ? "needs attention" : "no problem found in what it reports";
  return { robot: robot.name, kind: robot.simulated ? "simulation" : "physical", online: robot.online, stale: !robot.online, summary: worst, findings, basis: "Only what the robot reported and what HANNAH recorded. No model was asked to judge its condition." };
}

module.exports = { RESERVE_M, choose, diagnose, goalFor, overview, unavailable };
