"use strict";

/**
 * Operating modes, safety profiles and autonomy policies: pure rules, no I/O.
 *
 * An operating mode says what kind of command a robot may take at all. It is a
 * label the server and the robot's runtime both enforce; it is not a safety
 * function. Safety Stop is reached through the stop mechanisms that already
 * exist (cancel everything, a signed stop, the runtime's hold, Robot OS's
 * latched software stop), and a physical emergency stop stays what it is: a
 * circuit on the robot that works with all of this switched off.
 *
 * A safety profile narrows what the robot's own limits allow (speed,
 * acceleration, where it may go, when, with how much battery, how long it may
 * go without hearing from HANNAH, what needs a person's approval). It is
 * checked against the limits the robot reported and can never be looser.
 *
 * An autonomy policy is set per account, and by a team's owner or manager for
 * every member. The strictest one that applies wins. There is no policy that
 * switches every check off.
 */
const contract = require("./contract");

const MODES = {
  manual: { label: "Manual", description: "Only an operator holding a teleoperation session drives it. No missions, plans or agent commands." },
  assisted: { label: "Assisted", description: "An operator may drive it, and a signed-in person may send single missions from the Robots screen, each approved. No agent, workflow or plan commands." },
  supervised: { label: "Supervised Autonomy", description: "Single missions from people, agents, workflows and the fleet, each movement approved by a person. No plans." },
  mission: { label: "Mission Autonomy", description: "Missions and plans from any source, within the account's permissions and autonomy policy." },
  maintenance: { label: "Maintenance", description: "No missions. Sensors, onboard devices and slow jogging by an operator only." },
  safety_stop: { label: "Safety Stop", description: "Stopped through the robot's own stop mechanism. Only stopping and reading. Leaving it needs a signed-in person and a released emergency stop." },
};
const MODE_IDS = Object.keys(MODES);

/** Every allowed change. Anything not listed is refused, on the server and on the robot. */
const TRANSITIONS = {
  manual: ["assisted", "supervised", "maintenance", "safety_stop"],
  assisted: ["manual", "supervised", "maintenance", "safety_stop"],
  supervised: ["manual", "assisted", "mission", "maintenance", "safety_stop"],
  mission: ["supervised", "manual", "safety_stop"],
  maintenance: ["manual", "safety_stop"],
  safety_stop: ["manual", "maintenance"],
};

/** Modes in which the robot moves by itself; entering one is "restoring autonomy" and is validated first. */
const AUTONOMOUS = new Set(["supervised", "mission"]);
/** Modes in which an operator may hold manual control. */
const TELEOP_MODES = new Set(["manual", "assisted", "maintenance"]);
/** How fast an operator may jog a robot in Maintenance, whatever else allows. */
const MAINTENANCE_SPEED = { linear: 0.2, angular: 0.5 };

/** The kind of command, for the mode rules. */
function commandClass(capabilityId) {
  const definition = contract.capability(capabilityId);
  if (!definition) return "unknown";
  if (definition.deescalates) return "stop";
  if (definition.kind === "read" || capabilityId === "capture_image") return "observe";
  if (definition.motion) return "motion";
  return "actuate";
}

/** Where a command came from, from the Action Engine's source. A person pressing a button on the Robots screen is the only "person". */
function originOf(source) {
  const value = String(source || "");
  if (value === "robots") return "person";
  if (["workflow", "workforce", "plan", "teleop", "system", "api-key"].includes(value)) return value;
  return "agent"; // chat, voice, MCP hosts and anything else an agent asked for
}

const ORIGIN_TEXT = { person: "a person on the Robots screen", agent: "an agent", workflow: "a workflow", workforce: "an AI teammate", plan: "a plan", teleop: "an operator's manual control", system: "HANNAH itself", "api-key": "a developer key" };

/**
 * May a command of this class, from this origin, run in this mode?
 * Returns null when it may, or { code, message }.
 */
function modeRefusal({ mode, commandClass: kind, origin, plan = false, robotName = "The robot" }) {
  const label = MODES[mode]?.label || mode;
  const no = (code, message) => ({ code, message });
  if (!MODES[mode]) return no("mode-unknown", `${robotName} is in an unknown operating mode.`);
  if (kind === "stop" || kind === "observe") return null;
  if (mode === "safety_stop") return no("mode-safety-stop", `${robotName} is in Safety Stop: only stopping and reading are allowed. A signed-in person has to move it to Manual or Maintenance first.`);
  if (kind === "teleop") return TELEOP_MODES.has(mode) ? null : no("mode-no-teleop", `${robotName} is in ${label}. Manual control needs Manual, Assisted or Maintenance mode.`);
  if (kind === "actuate") return mode === "manual" ? no("mode-manual", `${robotName} is in Manual mode: only the operator's manual control and stopping.`) : null;
  if (kind === "motion") {
    if (mode === "manual") return no("mode-manual", `${robotName} is in Manual mode: it takes no missions, only the operator's manual control.`);
    if (mode === "maintenance") return no("mode-maintenance", `${robotName} is in Maintenance mode: it takes no missions.`);
    if (mode === "assisted" && origin !== "person") return no("mode-assisted-origin", `${robotName} is in Assisted mode: only a person on the Robots screen may send it a mission, not ${ORIGIN_TEXT[origin] || origin}.`);
    if (plan && mode !== "mission") return no("mode-no-plans", `${robotName} is in ${label}: plans of several steps run only in Mission Autonomy.`);
    return null;
  }
  return no("mode-unknown-command", `${robotName} doesn't know what kind of command this is, so it isn't sent.`);
}

/** Does this mode make every movement wait for a person? */
const modeForcesApproval = (mode) => mode === "assisted" || mode === "supervised";

const defaultMode = (robot) => (robot?.simulated ? "mission" : "supervised");

// ---------- autonomy policies ----------

const POLICIES = {
  read_only: { label: "Read only", rank: 5, description: "Robots may be read. Nothing is sent but a stop." },
  suggest_only: { label: "Suggest only", rank: 4, description: "HANNAH prepares robot commands for a person to look at; none is submitted." },
  approve_every: { label: "Approve every operation", rank: 3, description: "Every robot command waits for a person's approval, whatever standing permission exists." },
  approved_missions: { label: "Approved missions only", rank: 2, description: "A standing permission may cover only the missions on the approved list. Everything else asks." },
  approved_low_risk: { label: "Approved low-risk operations", rank: 1, description: "A standing permission may cover low-risk commands, and simulated movement. Physical movement, arms and grippers always ask." },
};
const DEFAULT_POLICY = "approved_low_risk";
const MISSION_PATTERN = /^[a-z_]{3,40}(:[\w .-]{1,60})?$/;

/** A policy as a person or an admin wrote it, checked. */
function normalizePolicy(input) {
  const policy = Object.hasOwn(POLICIES, input?.policy) ? input.policy : null;
  if (!policy) return { error: `Choose a policy: ${Object.keys(POLICIES).join(", ")}.` };
  const missions = [...new Set((Array.isArray(input?.missions) ? input.missions : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 50);
  const bad = missions.filter((item) => !MISSION_PATTERN.test(item) || !contract.capability(item.split(":")[0])?.motion);
  if (bad.length) return { error: `Not a movement mission: ${bad.slice(0, 5).join(", ")}. Write a capability, optionally with a destination, like navigate_to:workbench.` };
  if (policy === "approved_missions" && !missions.length) return { error: "List at least one approved mission." };
  return { policy, missions: policy === "approved_missions" ? missions : [] };
}

/** The strictest of the policies that apply. Two approved-mission lists keep only what both allow. */
function combinePolicies(list) {
  const valid = list.filter((item) => item && POLICIES[item.policy]);
  if (!valid.length) return { policy: DEFAULT_POLICY, missions: [], sources: [{ scope: "default", policy: DEFAULT_POLICY }] };
  const top = Math.max(...valid.map((item) => POLICIES[item.policy].rank));
  const winners = valid.filter((item) => POLICIES[item.policy].rank === top);
  let missions = [];
  if (winners[0].policy === "approved_missions") {
    missions = winners.reduce((kept, item) => (kept === null ? [...item.missions] : kept.filter((entry) => item.missions.includes(entry))), null) || [];
  }
  return { policy: winners[0].policy, missions, sources: valid.map(({ scope, scopeId, name, policy }) => ({ scope, scopeId, name, policy })) };
}

/** Does an approved-missions list cover this command? `navigate_to` covers any destination; `navigate_to:dock` only that one. */
function missionListed(missions, capabilityId, params = {}) {
  const places = capabilityId === "inspect_area" ? (params.waypoints || []).map((point) => point?.place).filter(Boolean) : params.place ? [params.place] : [];
  return missions.some((entry) => {
    const [capability, place] = entry.split(":");
    if (capability !== capabilityId) return false;
    if (!place) return true;
    if (capabilityId === "inspect_area") return places.length === (params.waypoints || []).length && places.every((name) => name.toLowerCase() === place.toLowerCase());
    return places.length === 1 && places[0].toLowerCase() === place.toLowerCase();
  });
}

/**
 * What the policy says about one command.
 * Returns { refuse?: {code, message}, suggest?: string, ask?: string } (all empty: the account's permissions decide).
 */
function policyRule(effective, { commandClass: kind, capabilityId, risk, simulated, params }) {
  const label = POLICIES[effective.policy]?.label || effective.policy;
  if (kind === "stop" || kind === "observe") return {};
  if (effective.policy === "read_only") return { refuse: { code: "policy-read-only", message: `The robot autonomy policy is “${label}”: robots may be read and stopped, nothing else.` } };
  if (effective.policy === "suggest_only") return { suggest: `The robot autonomy policy is “${label}”: this is prepared for you and not submitted.` };
  if (effective.policy === "approve_every") return { ask: `the robot autonomy policy is “${label}”` };
  if (effective.policy === "approved_missions") {
    if (kind === "motion" && !missionListed(effective.missions, capabilityId, params)) return { ask: `the robot autonomy policy allows standing permissions only for approved missions, and this isn't one` };
    if (kind !== "motion") return { ask: `the robot autonomy policy allows standing permissions only for approved missions` };
    return {};
  }
  const order = ["none", "low", "moderate", "high", "critical"];
  const rank = order.indexOf(risk);
  if (rank >= 3 || (rank === 2 && !simulated)) return { ask: `the robot autonomy policy covers only low-risk commands and simulated movement` };
  return {};
}

// ---------- safety profiles ----------

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ENVIRONMENTS = ["simulation", "enclosed-no-people", "shared-with-people"];

function cleanPolygon(input) {
  if (!Array.isArray(input) || input.length < 3 || input.length > 64) return null;
  const points = input.map((pair) => (Array.isArray(pair) && finite(pair[0]) && finite(pair[1]) ? [round(pair[0]), round(pair[1])] : null));
  return points.every(Boolean) ? points : null;
}
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > point.y) !== (yj > point.y) && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const label = (value, max = 40) => String(value ?? "").replace(/[^\w .:-]/g, "").trim().slice(0, max);

/**
 * Check a profile against the robot's own (reported) limits. Returns
 * { profile, problems: [string] }. A profile with a problem is not saved: a
 * value looser than the robot's own is refused, not silently clamped, so the
 * person sees what the robot actually allows.
 */
function normalizeProfile(input, hardware = {}) {
  const problems = [];
  const out = {};
  const source = input && typeof input === "object" ? input : {};
  const number = (name, { min, max, unit, looser }) => {
    const raw = source[name];
    if (raw === undefined || raw === null || raw === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) { problems.push(`${name} must be a number from ${min} to ${max}${unit ? ` ${unit}` : ""}.`); return; }
    const own = hardware[looser?.field || name];
    if (looser && finite(own) && looser.test(value, own)) { problems.push(`${name} ${value}${unit ? ` ${unit}` : ""} is looser than the robot's own ${own}${unit ? ` ${unit}` : ""}. A profile can only tighten.`); return; }
    out[name] = round(value);
  };
  const above = (value, own) => value > own + 1e-9;
  const below = (value, own) => value < own - 1e-9;
  number("maxLinearSpeed", { min: 0.01, max: 20, unit: "m/s", looser: { test: above } });
  number("maxAngularSpeed", { min: 0.01, max: 20, unit: "rad/s", looser: { test: above } });
  number("maxLinearAccel", { min: 0.01, max: 50, unit: "m/s²", looser: { test: above } });
  number("maxJointSpeed", { min: 0.01, max: 20, unit: "rad/s", looser: { test: above } });
  number("minBatteryPercent", { min: 0, max: 100, unit: "%", looser: { test: below } });
  number("commsTimeoutS", { min: 1, max: 600, unit: "s", looser: { field: "linkTimeoutS", test: above } });

  // Where it may go: an operating area (keep-in) and geofences (keep-out). Both inside the robot's own workspace.
  const workspace = hardware.workspace?.polygon || null;
  // A corner on the workspace's own edge counts as inside it.
  const onEdge = ({ x, y }, polygon) => polygon.some(([ax, ay], index) => {
    const [bx, by] = polygon[(index + 1) % polygon.length];
    const length = Math.hypot(bx - ax, by - ay) || 1e-9;
    const along = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (length * length);
    if (along < -1e-9 || along > 1 + 1e-9) return false;
    return Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length < 1e-6;
  });
  const inWorkspace = (polygon, what) => {
    if (workspace && polygon.some(([x, y]) => !pointInPolygon({ x, y }, workspace) && !onEdge({ x, y }, workspace))) problems.push(`${what} reaches outside the robot's own workspace. A profile can only tighten.`);
  };
  if (source.operatingArea !== undefined && source.operatingArea !== null) {
    const polygon = cleanPolygon(source.operatingArea?.polygon ?? source.operatingArea);
    if (!polygon) problems.push("The operating area must be a polygon of 3 to 64 [x, y] points in metres.");
    else { inWorkspace(polygon, "The operating area"); out.operatingArea = { name: label(source.operatingArea?.name) || "operating area", polygon }; }
  }
  if (source.armWorkspace !== undefined && source.armWorkspace !== null) {
    const polygon = cleanPolygon(source.armWorkspace?.polygon ?? source.armWorkspace);
    if (!polygon) problems.push("The arm workspace must be a polygon of 3 to 64 [x, y] points in metres.");
    else { inWorkspace(polygon, "The arm workspace"); out.armWorkspace = { name: "arm workspace", polygon }; }
  }
  if (source.geofences !== undefined) {
    if (!Array.isArray(source.geofences) || source.geofences.length > 32) problems.push("Geofences must be a list of at most 32 zones.");
    else {
      out.geofences = [];
      source.geofences.forEach((zone, index) => {
        const polygon = cleanPolygon(zone?.polygon);
        if (!polygon) problems.push(`Geofence ${index + 1} needs a polygon of 3 to 64 [x, y] points.`);
        else out.geofences.push({ name: label(zone?.name) || `zone ${index + 1}`, polygon });
      });
    }
  }
  const names = (key, max = 60) => {
    if (source[key] === undefined) return;
    if (!Array.isArray(source[key])) { problems.push(`${key} must be a list.`); return; }
    out[key] = [...new Set(source[key].map((item) => label(item, 60)).filter(Boolean))].slice(0, max);
  };
  names("restrictedDestinations");
  names("allowedDestinations");
  if (source.allowedMissions !== undefined) {
    if (!Array.isArray(source.allowedMissions)) problems.push("allowedMissions must be a list of capabilities.");
    else {
      const unknown = source.allowedMissions.filter((item) => !contract.capability(String(item)));
      if (unknown.length) problems.push(`Not a capability: ${unknown.slice(0, 5).join(", ")}.`);
      out.allowedMissions = [...new Set(source.allowedMissions.map(String))].filter((item) => contract.capability(item)).slice(0, 40);
    }
  }
  if (source.timeWindows !== undefined) {
    if (!Array.isArray(source.timeWindows) || source.timeWindows.length > 14) problems.push("Time windows must be a list of at most 14.");
    else {
      out.timeWindows = [];
      source.timeWindows.forEach((window, index) => {
        const days = Array.isArray(window?.days) ? [...new Set(window.days.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort() : [0, 1, 2, 3, 4, 5, 6];
        const timeZone = String(window?.timeZone || "UTC").slice(0, 60);
        let zoneOk = true;
        try { new Intl.DateTimeFormat("en-GB", { timeZone }); } catch { zoneOk = false; }
        if (!TIME.test(String(window?.from)) || !TIME.test(String(window?.to)) || !days.length || !zoneOk) problems.push(`Time window ${index + 1} needs days (0 = Sunday), from and to as HH:MM, and a valid time zone.`);
        else out.timeWindows.push({ days, from: window.from, to: window.to, timeZone });
      });
    }
  }
  if (source.allowedEnvironments !== undefined) {
    if (!Array.isArray(source.allowedEnvironments)) problems.push("allowedEnvironments must be a list.");
    else out.allowedEnvironments = source.allowedEnvironments.filter((item) => ENVIRONMENTS.includes(item));
  }
  if (source.requireHardwareEstop !== undefined) out.requireHardwareEstop = source.requireHardwareEstop === true;
  const approval = source.approval && typeof source.approval === "object" ? source.approval : null;
  if (approval) {
    out.approval = { motion: approval.motion === "always" ? "always" : "policy", capabilities: (Array.isArray(approval.capabilities) ? approval.capabilities : []).map(String).filter((item) => contract.capability(item) && !contract.capability(item).deescalates).slice(0, 40) };
  }
  // Manual control: never faster than the robot's own limits, and a short deadman.
  const teleop = source.teleop && typeof source.teleop === "object" ? source.teleop : null;
  if (teleop) {
    out.teleop = {};
    const own = { maxLinearSpeed: hardware.maxLinearSpeed, maxAngularSpeed: hardware.maxAngularSpeed };
    for (const [name, max] of [["maxLinearSpeed", 5], ["maxAngularSpeed", 10]]) {
      if (teleop[name] === undefined || teleop[name] === null || teleop[name] === "") continue;
      const value = Number(teleop[name]);
      if (!Number.isFinite(value) || value <= 0 || value > max) problems.push(`teleop.${name} must be above 0 and at most ${max}.`);
      else if (finite(own[name]) && value > own[name] + 1e-9) problems.push(`teleop.${name} ${value} is looser than the robot's own ${own[name]}. A profile can only tighten.`);
      else out.teleop[name] = round(value);
    }
    if (teleop.deadmanMs !== undefined && teleop.deadmanMs !== null && teleop.deadmanMs !== "") {
      const value = Number(teleop.deadmanMs);
      if (!Number.isInteger(value) || value < 150 || value > 1000) problems.push("teleop.deadmanMs must be a whole number from 150 to 1000.");
      else out.teleop.deadmanMs = value;
    }
  }
  return { profile: out, problems };
}

function minutesIn(timeZone, at) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}
const toMinutes = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
/** Is `at` inside one of the windows? A window whose end is before its start runs past midnight. */
function inTimeWindows(windows, at) {
  if (!windows?.length) return true;
  return windows.some((window) => {
    const { day, minutes } = minutesIn(window.timeZone, at);
    const from = toMinutes(window.from);
    const to = toMinutes(window.to);
    if (from <= to) return window.days.includes(day) && minutes >= from && minutes < to;
    const yesterday = (day + 6) % 7;
    return (window.days.includes(day) && minutes >= from) || (window.days.includes(yesterday) && minutes < to);
  });
}

/** Goals a command would send the robot to, for the profile's area and destination rules. */
function goalsOf(capabilityId, sent) {
  if (capabilityId === "inspect_area") return (sent.waypoints || []).map((point, index) => ({ ...point, label: `Point ${index + 1}` }));
  if (["navigate_to", "return_to_dock", "move_robot_arm"].includes(capabilityId) && finite(sent.x) && finite(sent.y)) return [{ ...sent, label: capabilityId === "move_robot_arm" ? "The target" : "The goal" }];
  return [];
}

/**
 * The profile's rules for one command (after the Safety Gateway resolved it).
 * Returns [{ code, message }]. Speed, acceleration and communication timeout
 * are not refused here: they are merged into the limits the robot is sent.
 */
function profileViolations(profile, { capabilityId, params = {}, sent = {}, robot, now = Date.now(), commandClass: kind }) {
  const problems = [];
  if (!profile || kind === "stop" || kind === "observe") return problems;
  const name = robot?.name || "The robot";
  const no = (code, message) => problems.push({ code: `profile:${code}`, message });
  if (profile.allowedMissions?.length && !profile.allowedMissions.includes(capabilityId)) no("mission-not-allowed", `${name}'s safety profile doesn't allow “${contract.capability(capabilityId)?.title || capabilityId}”.`);
  if (kind === "motion" || kind === "teleop") {
    if (!inTimeWindows(profile.timeWindows, now)) no("outside-time-window", `${name}'s safety profile allows movement only ${profile.timeWindows.map((window) => `${window.from}–${window.to} (${window.timeZone})`).join(", ")}.`);
    if (profile.allowedEnvironments?.length && !profile.allowedEnvironments.includes(robot?.limits?.environment || "")) no("environment", `${name}'s safety profile doesn't allow movement in its declared environment (${robot?.limits?.environment || "not declared"}).`);
    if (profile.requireHardwareEstop && !robot?.limits?.estop?.hardware) no("no-hardware-estop", `${name}'s safety profile requires a hardware emergency stop, and the robot didn't report one.`);
    if (finite(profile.minBatteryPercent) && finite(robot?.state?.battery?.percent) && robot.state.battery.percent < profile.minBatteryPercent && capabilityId !== "return_to_dock") no("battery", `${name}'s battery is at ${Math.round(robot.state.battery.percent)}%, below its safety profile's ${profile.minBatteryPercent}% minimum.`);
  }
  const places = capabilityId === "inspect_area" ? (params.waypoints || []).map((item) => item?.place).filter(Boolean) : params.place ? [params.place] : [];
  for (const place of places) {
    const lower = String(place).toLowerCase();
    if ((profile.restrictedDestinations || []).some((item) => item.toLowerCase() === lower)) no("destination-restricted", `“${place}” is a restricted destination in ${name}'s safety profile.`);
    else if (profile.allowedDestinations?.length && !profile.allowedDestinations.some((item) => item.toLowerCase() === lower)) no("destination-not-allowed", `“${place}” isn't one of the destinations ${name}'s safety profile allows.`);
  }
  const area = capabilityId === "move_robot_arm" ? profile.armWorkspace : profile.operatingArea;
  for (const goal of goalsOf(capabilityId, sent)) {
    if (area && !pointInPolygon(goal, area.polygon)) no("outside-operating-area", `${goal.label} (${round(goal.x, 2)}, ${round(goal.y, 2)}) is outside ${name}'s ${area.name}.`);
    for (const zone of profile.geofences || []) if (pointInPolygon(goal, zone.polygon)) no("geofence", `${goal.label} (${round(goal.x, 2)}, ${round(goal.y, 2)}) is inside the geofence “${zone.name}”.`);
  }
  return problems;
}

/** Approval the profile asks for, as reasons. */
function profileApproval(profile, { capabilityId, commandClass: kind }) {
  const reasons = [];
  if (!profile?.approval) return reasons;
  if (kind === "motion" && profile.approval.motion === "always") reasons.push("the robot's safety profile asks before every movement");
  if (profile.approval.capabilities?.includes(capabilityId)) reasons.push(`the robot's safety profile asks before “${contract.capability(capabilityId)?.title || capabilityId}”`);
  return reasons;
}

/** Limits for manual control: the robot's own, the profile's, and Maintenance's cap; the lowest wins. */
function teleopLimits(robot, profile, mode) {
  const pick = (...values) => { const known = values.filter(finite); return known.length ? Math.min(...known) : undefined; };
  const linear = pick(robot?.limits?.maxLinearSpeed, profile?.maxLinearSpeed, profile?.teleop?.maxLinearSpeed, mode === "maintenance" ? MAINTENANCE_SPEED.linear : undefined);
  const angular = pick(robot?.limits?.maxAngularSpeed, profile?.maxAngularSpeed, profile?.teleop?.maxAngularSpeed, mode === "maintenance" ? MAINTENANCE_SPEED.angular : undefined);
  return { maxLinearSpeed: linear, maxAngularSpeed: angular, deadmanMs: profile?.teleop?.deadmanMs || 500, commandTtlMs: 400 };
}

/** May the robot change from one mode to another? The structural rule only; the robot's condition is checked by the caller. */
function transitionRefusal(from, to) {
  if (!MODES[to]) return { code: "mode-unknown", message: `There is no operating mode called “${String(to).slice(0, 40)}”. Modes: ${MODE_IDS.join(", ")}.` };
  if (from === to) return { code: "mode-same", message: `The robot is already in ${MODES[to].label}.` };
  if (!(TRANSITIONS[from] || []).includes(to)) return { code: "transition-not-allowed", message: `${MODES[from]?.label || from} can't change straight to ${MODES[to].label}. From ${MODES[from]?.label || from} it can go to: ${(TRANSITIONS[from] || []).map((id) => MODES[id].label).join(", ")}.` };
  return null;
}

module.exports = {
  AUTONOMOUS, DEFAULT_POLICY, MAINTENANCE_SPEED, MODES, MODE_IDS, ORIGIN_TEXT, POLICIES, TELEOP_MODES, TRANSITIONS,
  combinePolicies, commandClass, defaultMode, inTimeWindows, missionListed, modeForcesApproval, modeRefusal, normalizePolicy, normalizeProfile,
  originOf, pointInPolygon, policyRule, profileApproval, profileViolations, teleopLimits, transitionRefusal,
};
