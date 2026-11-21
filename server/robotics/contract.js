"use strict";

/**
 * The robot capability contract: the only operations HANNAH can ask a robot
 * for. A capability is a named, high-level operation ("drive to this point",
 * "stop") with a checked input, the conditions it needs, how risky it is, how
 * long it may run, what cancelling does and how its result is verified.
 *
 * There is deliberately no capability for wheel speeds, motor PWM, joint
 * torques or "send this to the actuator": a language model chooses among these
 * operations and fills in their inputs, and the robot's own planner and
 * controller turn them into motion inside the limits the robot enforces.
 *
 * A robot offers a subset. It registers the ids it supports when it enrolls;
 * an id that isn't in this contract, isn't meant for that type of robot, or
 * has no runtime behind it yet ("contract-only") is refused at registration.
 */

const CATEGORIES = {
  "mobile-base": "Mobile base",
  manipulator: "Robot arm",
  "mobile-manipulator": "Mobile manipulator",
  aerial: "Aerial vehicle",
  "stationary-sensor": "Sensor station",
  other: "Other device",
};

const ROBOT_TYPES = {
  "differential-drive": { label: "Differential-drive mobile robot", category: "mobile-base", mobile: true },
  omnidirectional: { label: "Omnidirectional mobile robot", category: "mobile-base", mobile: true },
  ackermann: { label: "Car-like (Ackermann) mobile robot", category: "mobile-base", mobile: true },
  legged: { label: "Legged robot", category: "mobile-base", mobile: true },
  "manipulator-arm": { label: "Robot arm", category: "manipulator", mobile: false },
  "mobile-manipulator": { label: "Mobile manipulator", category: "mobile-manipulator", mobile: true },
  multirotor: { label: "Multirotor aircraft", category: "aerial", mobile: true },
  "sensor-station": { label: "Sensor station", category: "stationary-sensor", mobile: false },
  other: { label: "Other", category: "other", mobile: false },
};

const MOBILE_GROUND = ["differential-drive", "omnidirectional", "ackermann", "legged", "mobile-manipulator"];
const WITH_ARM = ["manipulator-arm", "mobile-manipulator"];
const ANY = Object.keys(ROBOT_TYPES);

/** How much can go wrong. Used for the approval rule and shown before the action. */
const RISK = {
  none: { label: "Reads only", rank: 0 },
  low: { label: "Low: reduces or doesn't cause motion", rank: 1 },
  moderate: { label: "Moderate: the robot moves by itself", rank: 2 },
  high: { label: "High: moves an arm or grips near people or objects", rank: 3 },
  critical: { label: "Critical: hazardous machinery, something that can't be undone, or a change to a safety system", rank: 4 },
};

/**
 * What each risk class requires before HANNAH sends anything.
 *   none      nothing: it reads the registry's last report
 *   low       nothing for stopping, pausing and cancelling; a switchable device follows the account's level
 *   moderate  the account's permission level; a physical robot always asks, and must be commissioned
 *   high      always a person's approval, a commissioned robot, and the robot's own interlocks; no standing permission
 *   critical  not offered: HANNAH has no capability in this class, and adding one needs a safety review first
 */
const APPROVAL = {
  none: "No approval: it only reads.",
  low: "No approval for stopping, pausing or cancelling. Other low-risk operations follow your permission level.",
  moderate: "Follows your permission level. A physical robot always asks, and must be commissioned first.",
  high: "Always asks, on a commissioned robot, with the robot's own interlocks. No standing permission can cover it.",
  critical: "Not offered by HANNAH.",
};

/** Conditions the Safety Gateway checks before a capability may be sent. */
const PRECONDITIONS = {
  enrolled: "The robot is enrolled and its credentials aren't revoked.",
  online: "The robot reported in the last few seconds.",
  "estop-released": "The robot's emergency stop is not engaged.",
  "motors-enabled": "The robot reports its motors enabled.",
  "no-fault": "The robot reports no active fault.",
  localized: "The robot knows where it is on its map.",
  "battery-ok": "The battery is above the robot's minimum for starting a mission.",
  "no-active-motion": "No other motion mission is running on the robot.",
  "dock-configured": "The robot has a dock position.",
};

const number = (minimum, maximum, description) => ({ type: "number", minimum, maximum, description });
const POSE_OUT = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, yaw: { type: "number" }, frame: { type: "string" } } };
const MOTION_PRE = ["enrolled", "online", "estop-released", "motors-enabled", "no-fault", "localized", "battery-ok", "no-active-motion"];
const MOTION_LIMITS = ["workspace", "keep-out", "max-speed", "command-expiry", "link-loss-stop"];

/** What happens when it goes wrong, and what the person is told. */
const READ_FAILURES = [
  { when: "The robot is offline", response: "Its last report is returned, marked as old. Never presented as current." },
  { when: "The robot never reported it", response: "An error naming what is missing. Never an empty or invented value." },
];
const MOTION_FAILURES = [
  { when: "The Safety Gateway refuses it", response: "Nothing is sent. The refusal and its reason are recorded and shown; no approval is asked." },
  { when: "The robot's own checks refuse it", response: "The mission is “rejected” with the robot's reason." },
  { when: "The robot doesn't accept it in time", response: "The command expires and is never run later." },
  { when: "The planner finds no path or is blocked", response: "The robot stops; the mission is “failed” with the planner's reason." },
  { when: "The emergency stop engages or a fault occurs", response: "The robot stops at once; the mission is “failed”. Nothing resumes by itself." },
  { when: "The link to HANNAH is lost", response: "The robot stops by itself after its link timeout; the mission is “cancelled” with that reason when the link returns." },
  { when: "The time limit passes", response: "The robot stops; the mission is “timed-out”." },
  { when: "The robot reports success its state doesn't support", response: "The mission is “unverified”, never “succeeded”." },
  { when: "The robot stops reporting", response: "After the deadline the mission is “lost: outcome unknown”." },
];
const CONTROL_FAILURES = [
  { when: "The robot is offline", response: "The request is recorded and reported as not delivered. A robot without its link has already stopped by itself." },
  { when: "The mission is already over", response: "Nothing changes; the mission's real ending is returned." },
];

const CAPABILITIES = [
  {
    id: "report_robot_state", title: "Report the robot's state", status: "implemented", kind: "read", motion: false, risk: "none",
    description: "The robot's latest reported position, speed, mode, battery, emergency-stop state, sensor health and current mission. Says how old the report is.",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: [],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { online: { type: "boolean" }, ageS: { type: "number" }, mode: { type: "string" }, pose: POSE_OUT, battery: { type: "object" }, estop: { type: "object" } } },
    timeoutS: { default: 5, max: 5 }, cancel: { supported: false, behaviour: "Nothing to cancel." },
    verification: { method: "freshness", description: "The answer carries the report's age; a report older than the online limit is marked stale." },
  },
  {
    id: "read_sensor", title: "Read a sensor", status: "implemented", kind: "read", motion: false, risk: "none",
    description: "The latest reading of one of the robot's registered sensors (for example lidar, odometry, bumper, battery).",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: [],
    input: { type: "object", properties: { sensor: { type: "string", maxLength: 40, description: "The sensor's id as the robot registered it." } }, required: ["sensor"], additionalProperties: false },
    output: { type: "object", properties: { sensor: { type: "string" }, ageS: { type: "number" }, reading: { type: "object" } } },
    timeoutS: { default: 5, max: 5 }, cancel: { supported: false, behaviour: "Nothing to cancel." },
    verification: { method: "freshness", description: "The reading carries its age; an unknown sensor id is an error, never an empty reading." },
  },
  {
    id: "stop_motion", title: "Stop the robot", status: "implemented", kind: "write", deescalates: true, motion: false, risk: "low",
    description: "Cancel whatever the robot is doing and hold position. A software request to the robot's controller: not an emergency stop.",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: ["command-expiry"],
    input: { type: "object", properties: { reason: { type: "string", maxLength: 200 } }, additionalProperties: false },
    output: { type: "object", properties: { stopped: { type: "boolean" }, speed: { type: "number" }, cancelledMission: { type: "string" } } },
    timeoutS: { default: 10, max: 10 }, cancel: { supported: false, behaviour: "A stop is not cancelled." },
    verification: { method: "measured-speed", description: "Confirmed when the robot's measured linear and angular speed are zero after the stop." },
  },
  {
    id: "navigate_to", title: "Drive to a place", status: "implemented", kind: "write", motion: true, risk: "moderate",
    description: "Drive to a position on the robot's map, or to one of its named places. The robot's own planner finds the path and avoids obstacles.",
    robotTypes: MOBILE_GROUND, preconditions: MOTION_PRE, constraints: MOTION_LIMITS,
    input: {
      type: "object", additionalProperties: false,
      properties: {
        x: number(-1000, 1000, "Metres, map frame."), y: number(-1000, 1000, "Metres, map frame."),
        yaw: number(-6.2832, 6.2832, "Final heading in radians (optional)."),
        place: { type: "string", maxLength: 60, description: "A named place the robot registered, instead of x and y." },
        maxSpeed: number(0.05, 5, "A lower speed limit for this mission, m/s. Never raises the robot's own limit."),
        tolerance: number(0.05, 1, "How close counts as arrived, metres. Default 0.25."),
      },
    },
    output: { type: "object", properties: { final: POSE_OUT, distanceToGoal: { type: "number" }, travelled: { type: "number" }, durationS: { type: "number" } } },
    timeoutS: { default: 180, max: 900 }, cancel: { supported: true, behaviour: "The robot's planner is cancelled and the robot holds position where it is." },
    verification: { method: "pose-at-goal", description: "Confirmed when the robot's reported position is within the tolerance of the goal and it is standing still. The position is the robot's own localization." },
  },
  {
    id: "return_to_dock", title: "Return to the dock", status: "implemented", kind: "write", motion: true, risk: "moderate",
    description: "Drive to the robot's dock position.",
    robotTypes: MOBILE_GROUND, preconditions: [...MOTION_PRE, "dock-configured"], constraints: MOTION_LIMITS,
    input: { type: "object", properties: { maxSpeed: number(0.05, 5, "A lower speed limit for this mission, m/s.") }, additionalProperties: false },
    output: { type: "object", properties: { final: POSE_OUT, distanceToGoal: { type: "number" }, docked: { type: "boolean" } } },
    timeoutS: { default: 240, max: 900 }, cancel: { supported: true, behaviour: "The robot's planner is cancelled and the robot holds position where it is." },
    verification: { method: "pose-at-goal", description: "Confirmed when the robot's reported position is within the tolerance of the dock and it is standing still." },
  },
  {
    id: "inspect_area", title: "Visit points and report", status: "implemented", kind: "write", motion: true, risk: "moderate",
    description: "Drive to each of a list of points in order and record what the range sensor sees at each one.",
    robotTypes: MOBILE_GROUND, preconditions: MOTION_PRE, constraints: MOTION_LIMITS,
    input: {
      type: "object", additionalProperties: false, required: ["waypoints"],
      properties: {
        waypoints: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, properties: { x: number(-1000, 1000), y: number(-1000, 1000), place: { type: "string", maxLength: 60 } } } },
        maxSpeed: number(0.05, 5, "A lower speed limit for this mission, m/s."),
        tolerance: number(0.05, 1, "How close counts as reached, metres. Default 0.3."),
      },
    },
    output: { type: "object", properties: { visited: { type: "array" }, final: POSE_OUT } },
    timeoutS: { default: 600, max: 1800 }, cancel: { supported: true, behaviour: "The robot stops where it is; points already visited stay in the report." },
    verification: { method: "waypoints-reached", description: "Confirmed when every point was reached within the tolerance, by the robot's reported position at each." },
  },
  {
    id: "set_supported_device_state", title: "Switch an onboard device", status: "implemented", kind: "write", motion: false, risk: "low",
    description: "Switch one of the robot's registered on/off devices (a beacon light, a horn). Only devices the robot lists; never motors or brakes.",
    robotTypes: ANY, preconditions: ["enrolled", "online", "no-fault"], constraints: ["command-expiry"],
    input: { type: "object", properties: { device: { type: "string", maxLength: 40 }, state: { type: "string", enum: ["on", "off"] } }, required: ["device", "state"], additionalProperties: false },
    output: { type: "object", properties: { device: { type: "string" }, state: { type: "string" } } },
    timeoutS: { default: 10, max: 30 }, cancel: { supported: false, behaviour: "A switch finishes at once." },
    verification: { method: "state-readback", description: "Confirmed when the robot's next state report shows the device in the requested state." },
  },
  {
    id: "report_battery_state", title: "Report the battery", status: "implemented", kind: "read", implicit: true, motion: false, risk: "none",
    description: "The battery's charge, whether it is charging, and the minimum the robot needs to start a mission. Only what the robot's battery sensor reported.",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: [],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { percent: { type: "number" }, charging: { type: "boolean" }, ageS: { type: "number" } } },
    timeoutS: { default: 5, max: 5 }, cancel: { supported: false, behaviour: "Nothing to cancel." },
    verification: { method: "freshness", description: "The answer carries the report's age; a robot with no battery sensor says so." },
  },
  {
    id: "report_surroundings", title: "Report what is around the robot", status: "implemented", kind: "read", motion: false, risk: "none",
    description: "What the robot's range sensor detects around it: obstacles with position and size, whether its route is blocked, what it has seen that isn't on its map, and which sensors are not working. Measurements with their sensor and time; nothing is guessed by a model.",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: [],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { obstacles: { type: "array" }, routeBlocked: { type: "boolean" }, changes: { type: "array" }, sensors: { type: "array" } } },
    timeoutS: { default: 5, max: 5 }, cancel: { supported: false, behaviour: "Nothing to cancel." },
    verification: { method: "provenance", description: "Every item names the sensor it came from, when it was measured and a confidence; an old report is marked old." },
  },
  {
    id: "cancel_mission", title: "Cancel a mission", status: "implemented", kind: "write", deescalates: true, implicit: true, motion: false, risk: "low",
    description: "Cancel a robot's current mission. The robot stops where it is and holds.",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: [],
    input: { type: "object", properties: { mission: { type: "string", maxLength: 40 } }, additionalProperties: false },
    output: { type: "object", properties: { status: { type: "string" } } },
    timeoutS: { default: 10, max: 10 }, cancel: { supported: false, behaviour: "A cancellation is not cancelled." },
    verification: { method: "robot-confirms", description: "Confirmed when the robot reports the mission cancelled; a mission that was never delivered is cancelled at once." },
  },
  {
    id: "pause_mission", title: "Pause a mission", status: "implemented", kind: "write", deescalates: true, implicit: true, motion: false, risk: "low",
    description: "Pause a robot's running mission. The robot holds where it is and keeps the mission; the paused time doesn't count against its time limit.",
    robotTypes: ANY, preconditions: ["enrolled"], constraints: [],
    input: { type: "object", properties: { mission: { type: "string", maxLength: 40 } }, additionalProperties: false },
    output: { type: "object", properties: { status: { type: "string" } } },
    timeoutS: { default: 10, max: 10 }, cancel: { supported: false, behaviour: "A pause is ended by resuming or cancelling." },
    verification: { method: "robot-confirms", description: "Confirmed when the robot reports the mission paused." },
  },
  {
    id: "resume_mission", title: "Resume a paused mission", status: "implemented", kind: "write", implicit: true, motion: true, risk: "moderate",
    description: "Carry on with a paused mission from where the robot stands. It moves the robot, so it is checked and approved like starting a mission.",
    robotTypes: MOBILE_GROUND, preconditions: MOTION_PRE.filter((item) => item !== "no-active-motion"), constraints: MOTION_LIMITS,
    input: { type: "object", properties: { mission: { type: "string", maxLength: 40 } }, additionalProperties: false },
    output: { type: "object", properties: { status: { type: "string" } } },
    timeoutS: { default: 20, max: 20 }, cancel: { supported: true, behaviour: "The mission can be paused or cancelled again." },
    verification: { method: "robot-confirms", description: "Confirmed when the robot reports it resumed. The resume command expires in 20 seconds and works once." },
  },
  // ---- In the contract, with no runtime behind them yet. A robot can't register these in Block 1. ----
  {
    id: "capture_image", title: "Take a picture", status: "implemented", kind: "write", motion: false, risk: "low",
    description: "Take one picture with a registered camera and report the coloured regions a detector finds in it, each with its frame, time, detector and confidence. The camera is read only for this. Camera use has to be switched on for the robot by a signed-in person first. The picture is kept for a limited time and every viewing of it is logged.",
    robotTypes: ANY, preconditions: ["enrolled", "online"], constraints: ["camera-enabled-by-owner", "retention-limit", "access-log", "command-expiry"],
    input: { type: "object", properties: { camera: { type: "string", maxLength: 40, description: "The camera's sensor id. Leave out when the robot has one camera." } }, additionalProperties: false },
    output: { type: "object", properties: { imageId: { type: "string" }, capturedAt: { type: "number" }, frame: { type: "number" }, detections: { type: "array" } } },
    timeoutS: { default: 15, max: 60 }, cancel: { supported: false, behaviour: "A picture is taken at once." },
    verification: { method: "image-received", description: "Confirmed when a valid image of the size the camera reports arrives with its frame number and capture time, taken after the command was issued." },
    failures: [
      { when: "The robot has no camera, or the camera isn't reporting", response: "Refused before anyone is asked, with the reason." },
      { when: "Camera use is switched off for the robot", response: "Refused; a signed-in person can switch it on under Robots." },
      { when: "The robot is offline or doesn't accept the command in time", response: "The command expires. No picture is taken later." },
      { when: "No image arrives, or what arrives isn't a valid image of the size the camera reports", response: "Recorded as unverified; nothing is stored." },
    ],
  },
  {
    id: "follow_target", title: "Follow a target", status: "contract-only", kind: "write", motion: true, risk: "high",
    description: "Keep a set distance behind a tracked person or object.", robotTypes: MOBILE_GROUND, preconditions: MOTION_PRE, constraints: [...MOTION_LIMITS, "following-distance", "person-detection-certified"],
    input: { type: "object", properties: { target: { type: "string", maxLength: 80 }, distance: number(0.5, 5) }, required: ["target"], additionalProperties: false },
    output: { type: "object", properties: { followedS: { type: "number" } } },
    timeoutS: { default: 300, max: 1800 }, cancel: { supported: true, behaviour: "The robot stops and holds position." },
    verification: { method: "tracking-log", description: "Confirmed from the tracker's own record of the target." },
  },
  {
    id: "move_robot_arm", title: "Move the arm", status: "implemented", kind: "write", motion: true, risk: "high",
    description: "Move the arm's tool to a named pose or to a point in its workspace. The arm's own planner chooses the joint motion, inside its joint limits and clear of collisions; HANNAH never sends joint values.",
    robotTypes: WITH_ARM, preconditions: MOTION_PRE.filter((item) => item !== "localized" && item !== "battery-ok"), constraints: ["workspace", "keep-out", "collision-scene", "max-joint-speed", "command-expiry", "link-loss-stop"],
    input: { type: "object", additionalProperties: false, properties: { place: { type: "string", maxLength: 60, description: "A named pose the arm registered." }, x: number(-5, 5, "Metres, the arm's base frame."), y: number(-5, 5, "Metres, the arm's base frame.") } },
    output: { type: "object", properties: { final: POSE_OUT } },
    timeoutS: { default: 60, max: 300 }, cancel: { supported: true, behaviour: "The motion is stopped and the arm holds where it is." },
    verification: { method: "tool-at-target", description: "Confirmed when the tool position computed from the measured joint angles is within 2 cm of the target and the joints are still." },
  },
  {
    id: "grasp_object", title: "Grasp an object", status: "implemented", kind: "write", motion: true, risk: "high",
    description: "Close the gripper on a named object that is at the tool. The gripper's own feedback decides whether anything was grasped.",
    robotTypes: WITH_ARM, preconditions: ["enrolled", "online", "estop-released", "motors-enabled", "no-fault", "no-active-motion"], constraints: ["object-in-scene", "gripper-empty", "command-expiry"],
    input: { type: "object", properties: { object: { type: "string", maxLength: 80 } }, required: ["object"], additionalProperties: false },
    output: { type: "object", properties: { holding: { type: "string" } } },
    timeoutS: { default: 30, max: 120 }, cancel: { supported: true, behaviour: "The gripper stops; it does not open by itself." },
    verification: { method: "gripper-feedback", description: "Confirmed when the gripper reports that it is holding that object. A gripper that closed on nothing is a failure." },
  },
  {
    id: "release_object", title: "Release an object", status: "implemented", kind: "write", motion: true, risk: "high",
    description: "Open the gripper and let go of what it holds.",
    robotTypes: WITH_ARM, preconditions: ["enrolled", "online", "estop-released", "motors-enabled", "no-fault", "no-active-motion"], constraints: ["gripper-holding", "command-expiry"],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: { released: { type: "boolean" } } },
    timeoutS: { default: 15, max: 60 }, cancel: { supported: false, behaviour: "A release finishes at once." },
    verification: { method: "gripper-feedback", description: "Confirmed when the gripper reports open and holding nothing." },
  },
  {
    id: "inspect_machine", title: "Inspect a machine", status: "contract-only", kind: "write", motion: true, risk: "high",
    description: "Approach a registered machine and record readings or images of it.", robotTypes: [...MOBILE_GROUND, "manipulator-arm"], preconditions: MOTION_PRE, constraints: [...MOTION_LIMITS, "machine-exclusion-zone", "site-authorization"],
    input: { type: "object", properties: { machine: { type: "string", maxLength: 80 } }, required: ["machine"], additionalProperties: false },
    output: { type: "object", properties: { readings: { type: "array" } } },
    timeoutS: { default: 600, max: 1800 }, cancel: { supported: true, behaviour: "The robot stops and holds." },
    verification: { method: "recorded-evidence", description: "Confirmed from the readings and images recorded at the machine." },
  },
  {
    id: "execute_approved_workflow", title: "Run an approved mission template", status: "contract-only", kind: "write", motion: true, risk: "moderate",
    description: "Run a sequence of capabilities that a person approved in advance as a template.", robotTypes: ANY, preconditions: MOTION_PRE, constraints: MOTION_LIMITS,
    input: { type: "object", properties: { template: { type: "string", maxLength: 80 } }, required: ["template"], additionalProperties: false },
    output: { type: "object", properties: { steps: { type: "array" } } },
    timeoutS: { default: 900, max: 3600 }, cancel: { supported: true, behaviour: "The current step is cancelled; later steps don't run." },
    verification: { method: "per-step", description: "Each step is verified by its own capability's rule." },
  },
].map((capability) => Object.freeze({
  permissions: { service: "robots", minimumLevel: capability.kind === "read" ? 1 : capability.deescalates ? 1 : 3 },
  failures: capability.kind === "read" ? READ_FAILURES : capability.deescalates ? CONTROL_FAILURES : MOTION_FAILURES,
  ...capability,
}));

const BY_ID = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));
const capability = (id) => BY_ID.get(String(id || "")) || null;

/**
 * Check a value against the small part of JSON Schema the contract uses
 * (object, array, string, number, integer, boolean; required, enum, minimum,
 * maximum, maxLength, minItems, maxItems, additionalProperties: false).
 * Returns the problems as sentences; none means the value is valid.
 */
function validate(schema, value, at = "input") {
  const problems = [];
  const type = schema?.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${at} must be an object`];
    for (const name of schema.required || []) if (value[name] === undefined || value[name] === null) problems.push(`${at}.${name} is required`);
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const child = schema.properties?.[name];
      if (!child) { if (schema.additionalProperties === false) problems.push(`${at}.${name} isn't part of this capability`); continue; }
      problems.push(...validate(child, item, `${at}.${name}`));
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${at} must be a list`];
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at} needs at least ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at} allows at most ${schema.maxItems}`);
    value.slice(0, schema.maxItems ?? value.length).forEach((item, index) => problems.push(...validate(schema.items || {}, item, `${at}[${index}]`)));
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${at} must be a number`];
    if (type === "integer" && !Number.isInteger(value)) problems.push(`${at} must be a whole number`);
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at} must be at most ${schema.maximum}`);
  } else if (type === "string") {
    if (typeof value !== "string") return [`${at} must be text`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at} is longer than ${schema.maxLength} characters`);
    if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} must be one of: ${schema.enum.join(", ")}`);
  } else if (type === "boolean") {
    if (typeof value !== "boolean") problems.push(`${at} must be true or false`);
  }
  return problems;
}

/**
 * What a robot asked to register against what it may have. Returns the ids
 * accepted and, for each one refused, why.
 */
function registerCapabilities(robotType, requested) {
  const accepted = [];
  const refused = [];
  const seen = new Set();
  for (const item of Array.isArray(requested) ? requested.slice(0, 60) : []) {
    const id = String(typeof item === "string" ? item : item?.id || "").slice(0, 60);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const definition = BY_ID.get(id);
    if (!definition) { refused.push({ id, reason: "Not in HANNAH's capability contract." }); continue; }
    if (definition.status !== "implemented") { refused.push({ id, reason: "In the contract, but no runtime implements it yet." }); continue; }
    if (definition.implicit) continue; // HANNAH provides these for every robot; a robot doesn't register them
    if (!definition.robotTypes.includes(robotType)) { refused.push({ id, reason: `Not a capability of a ${ROBOT_TYPES[robotType]?.label || robotType}.` }); continue; }
    accepted.push(id);
  }
  return { accepted, refused };
}

/** The contract as documentation and for the app: everything but nothing executable. */
const publicContract = () => CAPABILITIES.map((item) => ({ ...item, riskLabel: RISK[item.risk].label, approval: APPROVAL[item.risk], preconditionText: item.preconditions.map((id) => PRECONDITIONS[id]) }));

module.exports = { APPROVAL, CAPABILITIES, CATEGORIES, PRECONDITIONS, RISK, ROBOT_TYPES, capability, publicContract, registerCapabilities, validate };
