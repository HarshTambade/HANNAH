"use strict";

/**
 * Commissioning: the checks a PHYSICAL robot passes before HANNAH may move it.
 *
 * Enrolling a robot proves which device it is. It proves nothing about whether
 * that machine is safe to move. So a physical robot starts with movement
 * refused, and a signed-in person takes it through seven steps, in order:
 *
 *   1 identity     the fingerprint the runtime printed matches the one shown here
 *   2 inventory    its sensors and actuators are the ones on the machine
 *   3 limits       it reported a speed limit, a workspace, a link timeout, its environment
 *   4 estop        a hardware emergency stop exists, HANNAH saw it engage and release,
 *                  and the person attests that it cuts drive power with the computer off
 *   5 diagnostics  right now: connected, no fault, sensors working, localized, stop released
 *   6 trial        one supervised low-speed movement, verified at its goal
 *   7 approval     the person approves it for operation
 *
 * Where a step has something the server can observe, the server checks it at
 * the moment of confirmation and refuses if it isn't so; a person's tick alone
 * never passes those. Steps 1 to 5 done opens a trial mode: movement is allowed
 * only at the trial speed, and still asks every time. Only step 7 lifts the cap.
 *
 * Commissioning is cleared when the robot enrolls again (a new identity) or
 * reports different limits, sensors, actuators or capabilities.
 *
 * None of this is a safety assessment. It makes sure the obvious things were
 * looked at by a person and records who said so and when.
 */
const TRIAL_SPEED = 0.2;

const STEPS = [
  { id: "identity", title: "Verify the device's identity", detail: "When it enrolled, the robot's runtime printed a fingerprint. It must be the same as the one shown here. If it isn't, something else enrolled as this robot: revoke it." },
  { id: "inventory", title: "Review its sensors and actuators", detail: "The list below is what the runtime reported. Check it against the machine: nothing missing, nothing unexpected." },
  { id: "limits", title: "Confirm its limits", detail: "The robot enforces these itself. Check the top speed, the workspace outline and the environment it declared against where it will really run." },
  { id: "estop", title: "Validate the emergency-stop hardware", detail: "Press and release the robot's emergency stop while it is connected: HANNAH must see both. Then confirm, from a test you did yourself, that the button cuts drive power with the robot's computer switched off." },
  { id: "diagnostics", title: "Run read-only diagnostics", detail: "Checked now, without moving anything: connected, no fault, every sensor reporting, localized on its map, emergency stop released." },
  { id: "trial", title: "Supervised low-speed trial", detail: `With a person at the robot and the space clear, send it on one short trip. It is limited to ${TRIAL_SPEED} m/s and its arrival must be verified.` },
  { id: "approval", title: "Approve for operation", detail: "You are saying this robot may be moved by HANNAH in this space, each movement still with your approval." },
];
const ORDER = STEPS.map((step) => step.id);
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** What the server can see for itself about a step. `problems` empty means it holds. */
function evidence(stepId, { robot, record, events = [], missions = [] }) {
  const problems = [];
  const facts = [];
  const state = robot.state || {};
  const since = record?.startedAt || robot.enrolledAt || 0;
  if (stepId === "identity") {
    facts.push(`Fingerprint: ${robot.fingerprint || "not available"}`);
    if (!robot.fingerprint) problems.push("This robot has no fingerprint; enroll it again.");
  } else if (stepId === "inventory") {
    facts.push(`Sensors: ${robot.sensors.map((sensor) => `${sensor.id} (${sensor.type})`).join(", ") || "none"}`, `Actuators: ${robot.actuators.map((item) => `${item.id} (${item.type})`).join(", ") || "none"}`);
    if (!robot.sensors.length) problems.push("The robot reported no sensors.");
    if (!robot.actuators.length) problems.push("The robot reported no actuators.");
  } else if (stepId === "limits") {
    const limits = robot.limits;
    facts.push(`Top speed ${finite(limits.maxLinearSpeed) ? `${limits.maxLinearSpeed} m/s` : "not reported"}`, `Workspace ${limits.workspaces.length ? "reported" : "not reported"}`, `Environment: ${limits.environment || "not declared"}`, `Stops by itself after ${limits.linkTimeoutS ?? "?"} s without HANNAH`);
    if (!finite(limits.maxLinearSpeed)) problems.push("No speed limit reported.");
    if (!limits.workspaces.length) problems.push("No workspace reported.");
    if (!limits.environment || limits.environment === "simulation") problems.push("The robot didn't declare a physical environment.");
    if (!finite(limits.linkTimeoutS)) problems.push("No link timeout reported.");
  } else if (stepId === "estop") {
    const engaged = events.find((event) => event.source === "robot" && event.type === "estop-engaged" && event.at >= since);
    const released = engaged && events.find((event) => event.source === "robot" && event.type === "estop-released" && event.at >= engaged.at);
    facts.push(robot.limits.estop?.hardware ? `Hardware emergency stop: ${robot.limits.estop.description || "reported"}` : "No hardware emergency stop reported", engaged ? "HANNAH saw it engage" : "HANNAH has not seen it engage", released ? "HANNAH saw it release" : "HANNAH has not seen it release");
    if (!robot.limits.estop?.hardware) problems.push("The robot doesn't report a hardware emergency stop.");
    if (!engaged) problems.push("Press the emergency stop while the robot is connected: HANNAH hasn't seen it engage since commissioning started.");
    else if (!released) problems.push("Release the emergency stop: HANNAH hasn't seen it release.");
  } else if (stepId === "diagnostics") {
    const broken = robot.sensors.filter((sensor) => state.sensors?.[sensor.id]?.ok === false || state.sensors?.[sensor.id] === undefined);
    facts.push(robot.online ? "Connected" : "Not connected", `Faults: ${(state.faults || []).length}`, `Sensors not reporting: ${broken.map((sensor) => sensor.id).join(", ") || "none"}`, state.localized === false ? "Not localized" : "Localized", state.estop?.engaged ? "Emergency stop engaged" : "Emergency stop released");
    if (!robot.online) problems.push("The robot isn't connected.");
    if ((state.faults || []).length) problems.push(`It reports a fault: ${clean(state.faults[0]?.message || state.faults[0]?.code, 120)}.`);
    if (broken.length) problems.push(`Not reporting: ${broken.map((sensor) => sensor.id).join(", ")}.`);
    if (state.localized === false) problems.push("It isn't localized on its map.");
    if (state.estop?.engaged) problems.push("Its emergency stop is engaged.");
  } else if (stepId === "trial") {
    const after = record?.steps?.diagnostics?.at || Infinity;
    const run = missions.find((mission) => mission.status === "succeeded" && mission.verification?.confirmed && ["navigate_to", "return_to_dock", "inspect_area"].includes(mission.capability) && mission.createdAt >= after && (mission.params.maxSpeed ?? Infinity) <= TRIAL_SPEED + 1e-9);
    facts.push(run ? `Trial mission ${run.id} finished and was verified.` : `No verified movement at ${TRIAL_SPEED} m/s or less since the diagnostics step.`);
    if (!run) problems.push("Run one supervised trip first; it has to finish and be verified.");
  }
  return { ok: problems.length === 0, problems, facts };
}

/** Where a robot stands, from its stored record alone: what the Safety Gateway needs. */
function summary(robot, record) {
  if (robot.simulated) return { required: false, status: "not-required", done: 0, total: 0, trialSpeed: null };
  const done = ORDER.filter((id) => record?.steps?.[id]).length;
  const firstFive = ORDER.slice(0, 5).every((id) => record?.steps?.[id]);
  const status = record?.steps?.approval ? "approved" : firstFive ? "trial" : done ? "in-progress" : "required";
  return { required: true, status, done, total: ORDER.length, trialSpeed: status === "trial" ? TRIAL_SPEED : null, resetReason: record?.resetReason || null, approvedAt: record?.steps?.approval?.at || null };
}

/** Everything the commissioning screen shows. */
function view(robot, record, context) {
  const state = summary(robot, record);
  const next = ORDER.find((id) => !record?.steps?.[id]) || null;
  return {
    ...state,
    next,
    steps: STEPS.map((step) => {
      const confirmed = record?.steps?.[step.id] || null;
      const check = state.required ? evidence(step.id, { robot, record, ...context }) : { ok: true, problems: [], facts: [] };
      return { ...step, done: Boolean(confirmed), confirmedAt: confirmed?.at || null, note: confirmed?.note || "", available: state.required && step.id === next, check };
    }),
  };
}

/** Confirm the next step. Returns the new record, or throws with what is missing. */
function confirm(robot, record, stepId, { note = "", attest = false, now = Date.now(), ...context } = {}) {
  if (robot.simulated) throw fail(400, "A simulated robot doesn't need commissioning.", "not-required");
  if (!ORDER.includes(stepId)) throw fail(404, "That isn't a commissioning step.", "not-found");
  const next = ORDER.find((id) => !record?.steps?.[id]);
  if (!next) throw fail(409, `${robot.name} is already approved for operation.`, "already-approved");
  if (stepId !== next) throw fail(409, record?.steps?.[stepId] ? "That step is already done." : `Do “${STEPS.find((step) => step.id === next).title}” first.`, "out-of-order");
  if (attest !== true) throw fail(400, "Confirm that you checked this yourself.", "not-attested");
  const current = record?.startedAt ? record : { startedAt: now, steps: {} };
  const check = evidence(stepId, { robot, record: current, ...context });
  if (!check.ok) throw fail(409, check.problems.join(" "), "evidence-missing", { problems: check.problems });
  return { ...current, resetReason: null, steps: { ...current.steps, [stepId]: { at: now, note: clean(note, 300), facts: check.facts } } };
}

/** What a robot reports that commissioning was done against. A change means it has to be done again. */
const signature = (profile, reported, capabilities) => JSON.stringify([
  (profile.sensors || []).map((item) => `${item.id}:${item.type}`), (profile.actuators || []).map((item) => `${item.id}:${item.type}`), capabilities,
  reported.maxLinearSpeed, reported.maxAngularSpeed, reported.workspace?.polygon, reported.environment, reported.estop?.hardware, reported.linkTimeoutS,
]);

module.exports = { ORDER, STEPS, TRIAL_SPEED, confirm, evidence, signature, summary, view };
