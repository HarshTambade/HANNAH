"use strict";

/**
 * Plans: several robot steps under one approval, run one at a time.
 *
 * A plan is a list of steps a person can read before approving it. Each step
 * is either a capability that starts a mission on the robot (drive, move the
 * arm, grasp) or an observation taken from the robot's own report at that
 * moment (a sensor reading, what is around it). Nothing else can be a step.
 *
 * What a plan is not:
 *   - It is not a script. There are no conditions, loops or expressions; the
 *     steps run in the order listed and the plan stops at the first one that
 *     doesn't finish and verify.
 *   - It does not skip the Safety Gateway. Every step is checked when the plan
 *     is asked for, and again at the moment it is sent, against the robot as
 *     it is then.
 *   - It does not recover by itself. A failed step is reported; the steps
 *     after it are not run, and work queued behind the plan is dropped.
 *
 * This file holds the pure parts: what a step may be, the templates, the
 * observations and the wording. The service owns the records and the queue.
 */
const contract = require("./contract");

const MAX_STEPS = 20;
const MAX_QUEUED = 5;
const START_WITHIN_MIN = { default: 15, max: 120 };
const FINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
/** Capabilities that start a mission on the robot. */
const MISSION_STEPS = ["navigate_to", "return_to_dock", "inspect_area", "set_supported_device_state", "move_robot_arm", "grasp_object", "release_object", "capture_image"];
/** Capabilities answered from the robot's report when the step is reached. Nothing is sent to the robot. */
const OBSERVATION_STEPS = ["report_robot_state", "report_battery_state", "read_sensor", "report_surroundings"];
/**
 * Refusals that an earlier step of the same plan is there to change, so they
 * don't refuse a later step when the plan is asked for. They are checked for
 * real when the step is reached.
 */
const DEPENDS_ON_EARLIER = new Set(["gripper-full", "nothing-held", "precondition:no-active-motion"]);

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const stepKind = (capabilityId) => (OBSERVATION_STEPS.includes(capabilityId) ? "observation" : MISSION_STEPS.includes(capabilityId) ? "mission" : null);

/** Turn what a caller sent into steps: `[{ capability, params }]`. Refuses anything that isn't a known step. */
function normalizeSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) throw fail(400, "A plan needs at least one step.", "bad-request");
  if (raw.length > MAX_STEPS) throw fail(400, `A plan can have at most ${MAX_STEPS} steps.`, "bad-request");
  return raw.map((item, index) => {
    const capabilityId = clean(item?.do ?? item?.capability, 60);
    const definition = contract.capability(capabilityId);
    if (!definition || !stepKind(capabilityId) || definition.status !== "implemented") throw fail(400, `Step ${index + 1}: “${capabilityId || "nothing"}” can't be a plan step. A step is one of: ${[...MISSION_STEPS, ...OBSERVATION_STEPS].filter((id) => contract.capability(id)?.status === "implemented").join(", ")}.`, "bad-request");
    const source = item?.params && typeof item.params === "object" ? item.params : item || {};
    const params = {};
    for (const key of Object.keys(definition.input.properties || {})) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== "") params[key] = source[key];
    }
    return { capability: capabilityId, params };
  });
}

const has = (robot, capabilityId) => robot.capabilities.includes(capabilityId) && !(robot.disabled || []).includes(capabilityId);
const placeNames = (robot) => Object.keys(robot.places || {});
const findPlace = (robot, name) => placeNames(robot).find((known) => known.toLowerCase() === String(name || "").trim().toLowerCase());

/**
 * Templates: a named, fixed shape of plan. A template is offered for a robot
 * only when that robot has every capability it needs.
 */
const TEMPLATES = [
  {
    id: "go_and_return", title: "Go to a place and come back", description: "Drive to a named destination, then return to the dock.",
    needs: ["navigate_to", "return_to_dock"], inputs: { place: "A destination on the robot's list." },
    build(robot, input) {
      const place = findPlace(robot, input.place);
      if (!place) throw fail(400, `${robot.name} has no destination called “${clean(input.place, 60)}”${placeNames(robot).length ? ` (it has: ${placeNames(robot).slice(0, 12).join(", ")})` : ""}.`, "unknown-place");
      return { title: `Go to ${place} and come back`, steps: [{ capability: "navigate_to", params: { place } }, { capability: "return_to_dock", params: {} }] };
    },
  },
  {
    id: "inspection_route", title: "Inspection route", description: "Visit destinations in order. At each one, record what the range sensor detects and, when a sensor is named, its reading. Then return to the dock.",
    needs: ["navigate_to", "report_surroundings"], inputs: { places: "Destinations in the order to visit them.", sensor: "Optional: a sensor to read at each one." },
    build(robot, input) {
      const wanted = Array.isArray(input.places) ? input.places : String(input.places || "").split(",");
      const places = wanted.map((name) => clean(name, 60)).filter(Boolean);
      if (!places.length) throw fail(400, "Name at least one destination to inspect.", "bad-request");
      const sensor = clean(input.sensor, 40);
      if (sensor && !(robot.sensors || []).some((entry) => entry.id === sensor)) throw fail(400, `${robot.name} has no sensor called “${sensor}” (it has: ${(robot.sensors || []).map((entry) => entry.id).join(", ") || "none"}).`, "unknown-sensor");
      const steps = [];
      for (const name of places) {
        const place = findPlace(robot, name);
        if (!place) throw fail(400, `${robot.name} has no destination called “${name}”${placeNames(robot).length ? ` (it has: ${placeNames(robot).slice(0, 12).join(", ")})` : ""}.`, "unknown-place");
        steps.push({ capability: "navigate_to", params: { place } }, { capability: "report_surroundings", params: {} });
        if (sensor) steps.push({ capability: "read_sensor", params: { sensor } });
      }
      if (has(robot, "return_to_dock") && robot.dock) steps.push({ capability: "return_to_dock", params: {} });
      return { title: `Inspect ${places.length === 1 ? places[0] : `${places.length} places`}`, steps };
    },
  },
  {
    id: "pick_and_place", title: "Pick and place", description: "Move the arm to an object the robot reports, grasp it, carry it to a named pose, release it, and go back to the home pose when the arm has one.",
    needs: ["move_robot_arm", "grasp_object", "release_object"], inputs: { object: "An object the robot reports in its scene.", to: "A named pose to put it down at." },
    build(robot, input) {
      const objects = robot.state?.scene?.objects || [];
      const object = objects.find((entry) => String(entry.id).toLowerCase() === clean(input.object, 80).toLowerCase());
      // Where the object is comes from the robot's own report, now. Not from its name, and not from an old list.
      if (!robot.online || !object || !Number.isFinite(object.x) || !Number.isFinite(object.y)) throw fail(409, !robot.online ? `${robot.name} is offline, so where its objects are isn't known.` : `${robot.name} doesn't report an object called “${clean(input.object, 80)}”${objects.length ? ` (it reports: ${objects.map((entry) => entry.id).join(", ")})` : ""}.`, "unknown-object");
      const to = findPlace(robot, input.to);
      if (!to) throw fail(400, `${robot.name} has no pose called “${clean(input.to, 60)}”${placeNames(robot).length ? ` (it has: ${placeNames(robot).slice(0, 12).join(", ")})` : ""}.`, "unknown-place");
      const steps = [
        { capability: "move_robot_arm", params: { x: round(object.x, 4), y: round(object.y, 4) } },
        { capability: "grasp_object", params: { object: object.id } },
        { capability: "move_robot_arm", params: { place: to } },
        { capability: "release_object", params: {} },
      ];
      const home = findPlace(robot, "home");
      if (home) steps.push({ capability: "move_robot_arm", params: { place: home } });
      return { title: `Put the ${object.id} at ${to}`, steps };
    },
  },
  {
    id: "status_report", title: "Status report", description: "Record the robot's state and battery as it reports them. Sends nothing to the robot.",
    needs: ["report_robot_state"], inputs: {},
    build: () => ({ title: "Status report", steps: [{ capability: "report_robot_state", params: {} }, { capability: "report_battery_state", params: {} }] }),
  },
];

/** Every template with whether this robot can run it, and why not when it can't. */
function templatesFor(robot) {
  return TEMPLATES.map((template) => {
    const missing = template.needs.filter((id) => !has(robot, id));
    return {
      id: template.id, title: template.title, description: template.description, inputs: template.inputs, needs: template.needs,
      available: missing.length === 0,
      reason: missing.length ? `${robot.name} doesn't offer ${missing.map((id) => `“${contract.capability(id)?.title || id}”`).join(", ")}.` : null,
    };
  });
}

/** A template with its inputs, as a title and explicit steps. */
function expand(robot, templateId, input = {}) {
  const template = TEMPLATES.find((entry) => entry.id === templateId);
  if (!template) throw fail(400, `There is no template called “${clean(templateId, 60)}”. Templates: ${TEMPLATES.map((entry) => entry.id).join(", ")}.`, "unknown-template");
  const offered = templatesFor(robot).find((entry) => entry.id === template.id);
  if (!offered.available) throw fail(409, `“${template.title}” can't run on ${robot.name}: ${offered.reason}`, "template-unavailable");
  return { template: template.id, ...template.build(robot, input && typeof input === "object" ? input : {}) };
}

const pointText = (params) => (params.place ? `${params.place}${Number.isFinite(params.x) ? ` (${round(params.x)}, ${round(params.y)})` : ""}` : `(${round(params.x, 3)}, ${round(params.y, 3)})`);

/** What a step does, in a few words. `params` may be as asked or as resolved by the gateway. */
function stepText(step) {
  const params = step.sent || step.params || {};
  switch (step.capability) {
    case "navigate_to": return `drive to ${pointText(params)}`;
    case "return_to_dock": return "return to the dock";
    case "inspect_area": return `visit ${(params.waypoints || []).length} point${(params.waypoints || []).length === 1 ? "" : "s"}`;
    case "set_supported_device_state": return `switch the ${params.device} ${params.state}`;
    case "move_robot_arm": return `move the arm to ${pointText(params)}`;
    case "grasp_object": return `grasp the ${params.object}`;
    case "release_object": return "open the gripper";
    case "capture_image": return "take a camera image";
    case "report_robot_state": return "record the robot's state";
    case "report_battery_state": return "record the battery level";
    case "read_sensor": return `read the ${params.sensor} sensor`;
    case "report_surroundings": return "record what the range sensor detects";
    default: return contract.capability(step.capability)?.title || step.capability;
  }
}

/**
 * An observation step: what the robot's report says, right now. The report is
 * the one that arrived in the exchange that reached this step, so it is fresh
 * by construction; `ageS` says so. A reading the robot didn't give is a
 * failure of the step, never a guess.
 */
function observe(step, robot, at) {
  const state = robot.state;
  if (!state || !robot.online) return { ok: false, error: `${robot.name} isn't reporting, so there is nothing to record.` };
  const base = { at, ageS: robot.stateAgeS ?? 0, source: `${robot.name}'s own report`, kind: robot.simulated ? "simulation" : "physical" };
  switch (step.capability) {
    case "report_robot_state":
      return { ok: true, output: { ...base, mode: state.mode ?? null, pose: state.pose ?? null, battery: state.battery ?? null, emergencyStop: Boolean(state.estop?.engaged), faults: (state.faults || []).slice(0, 5) }, evidence: `Mode ${state.mode ?? "unknown"}${Number.isFinite(state.pose?.x) ? ` at (${round(state.pose.x)}, ${round(state.pose.y)})` : ""}.` };
    case "report_battery_state": {
      const percent = state.battery?.percent;
      if (!Number.isFinite(percent)) return { ok: false, error: `${robot.name} didn't report a battery reading.` };
      return { ok: true, output: { ...base, percent, charging: Boolean(state.battery.charging) }, evidence: `Battery ${Math.round(percent)}%${state.battery.charging ? ", charging" : ""}.` };
    }
    case "read_sensor": {
      const reading = state.sensors?.[step.params.sensor];
      if (reading === undefined || reading === null) return { ok: false, error: `${robot.name} didn't report a reading for its ${step.params.sensor} sensor.` };
      if (reading.ok === false) return { ok: false, error: `${robot.name}'s ${step.params.sensor} sensor isn't reporting${reading.fault ? ` (${clean(reading.fault, 80)})` : ""}.` };
      const { ranges: _ranges, ...compact } = reading;
      const value = Object.entries(compact).filter(([key, item]) => typeof item === "number" && key !== "at").slice(0, 4).map(([key, item]) => `${key} ${round(item, 3)}`).join(", ");
      return { ok: true, output: { ...base, sensor: step.params.sensor, reading: compact }, evidence: `The ${step.params.sensor} sensor reported ${value || "a reading"}.` };
    }
    case "report_surroundings": {
      const perception = state.perception;
      if (!perception) return { ok: false, error: `${robot.name} didn't report what its sensors detect.` };
      const obstacles = (perception.obstacles || []).slice(0, 12);
      const nearest = obstacles.reduce((best, item) => (Number.isFinite(item.distance) && (!best || item.distance < best.distance) ? item : best), null);
      return {
        ok: true,
        output: { ...base, position: state.pose ?? null, obstacles, routeBlocked: perception.routeBlocked ?? null, changes: (perception.changes || []).slice(0, 12), sensor: perception.sensor ?? perception.source ?? null },
        evidence: `${obstacles.length} obstacle${obstacles.length === 1 ? "" : "s"} detected${nearest ? `, the nearest ${round(nearest.distance)} m away` : ""}${(perception.changes || []).length ? `; ${(perception.changes || []).length} not on the map` : ""}.`,
      };
    }
    default:
      return { ok: false, error: "That isn't an observation." };
  }
}

/** One honest sentence about a plan. */
function planText(plan, robotName = "The robot") {
  const total = plan.steps.length;
  const name = `Plan “${plan.title}”`;
  const current = plan.steps[Math.min(plan.cursor, total - 1)];
  const rest = plan.steps.filter((step) => step.status === "skipped").length;
  const notRun = rest ? ` ${rest === 1 ? "The last step was" : `The ${rest} steps after it were`} not run.` : "";
  switch (plan.status) {
    case "queued": return `${name}: waiting for ${robotName} to be free. Nothing has started. It is dropped if it hasn't started by ${new Date(plan.startBy).toISOString().slice(11, 16)} UTC.`;
    case "running": return `${name}: step ${plan.cursor + 1} of ${total} (${stepText(current)}) is under way${plan.cursor ? `; ${plan.cursor} finished and verified` : ""}. It is not finished.`;
    case "succeeded": return `${name}: all ${total} step${total === 1 ? "" : "s"} finished and verified.`;
    case "failed": return `${name}: stopped at step ${Math.min(plan.cursor + 1, total)} of ${total} (${stepText(current)}). ${plan.error || ""}${notRun}`.trim();
    case "cancelled": return `${name}: cancelled at step ${Math.min(plan.cursor + 1, total)} of ${total}. ${plan.error || ""}${notRun}`.trim();
    case "expired": return `${name}: never started. ${plan.error || ""}`.trim();
    default: return `${name}: ${plan.status}.`;
  }
}

module.exports = { DEPENDS_ON_EARLIER, FINAL, MAX_QUEUED, MAX_STEPS, MISSION_STEPS, OBSERVATION_STEPS, START_WITHIN_MIN, TEMPLATES, expand, normalizeSteps, observe, planText, stepKind, stepText, templatesFor };
