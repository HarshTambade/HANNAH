"use strict";

/**
 * Commissioning: the checks a PHYSICAL robot passes before HANNAH may move it.
 *
 * Enrolling a robot proves which device it is. It proves nothing about whether
 * that machine is safe to move. So a physical robot starts with movement
 * refused, and a signed-in person takes it through eleven steps, in order:
 *
 *    1 identity     the fingerprint the runtime printed matches the one shown here
 *    2 inventory    its sensors and actuators are the ones on the machine
 *    3 software     it reported its runtime, software and firmware versions and speaks this protocol
 *    4 limits       it reported a speed limit, a workspace, a link timeout, its environment
 *    5 frames       it reports a position in a named frame; the person checked the robot model and frames
 *    6 estop        a hardware emergency stop exists, HANNAH saw it engage and release, and the person
 *                   attests that it cuts drive power, and disables the motors, with the computer off
 *    7 diagnostics  right now: connected, no fault, sensors working, localized, stop released
 *    8 watchdog     HANNAH saw the robot report that it lost its link, held, and got it back
 *    9 trial        one supervised low-speed movement, verified at its goal
 *   10 odometry     the person measured where it stopped and wrote down how that compares
 *   11 approval     the person approves it for operation
 *
 * Where a step has something the server can observe, the server checks it at
 * the moment of confirmation and refuses if it isn't so; a person's tick alone
 * never passes those. Everything before the trial done opens a trial mode:
 * movement is allowed only at the trial speed, and still asks every time. Only
 * the last step lifts the cap.
 *
 * What the server cannot observe is said to be the person's own statement:
 * that the button cuts power, that the wheels turned the right way, what a
 * tape measure showed. Those are recorded with who said so and when.
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
  { id: "software", title: "Check software and firmware versions", detail: "The versions below are what the robot reported. Check that the firmware on its controller is the one this software was tested with. A robot that reports different hardware or limits later has to be commissioned again." },
  { id: "limits", title: "Confirm its limits", detail: "The robot enforces these itself. Check the top speed, the workspace outline and the environment it declared against where it will really run." },
  { id: "frames", title: "Check the robot model and coordinate frames", detail: "The robot must report its position in a named frame. Check for yourself, in the robot's own tools, that its model matches the machine, that each sensor's frame is where the sensor really is, and that forward on the robot is forward in its model." },
  { id: "estop", title: "Validate the emergency-stop hardware", detail: "Press and release the robot's emergency stop while it is connected: HANNAH must see both. Then confirm, from a test you did yourself, that the button cuts drive power and leaves the motors disabled with the robot's computer switched off." },
  { id: "diagnostics", title: "Run read-only diagnostics", detail: "Checked now, without moving anything: connected, no fault, every sensor reporting, localized on its map, emergency stop released." },
  { id: "watchdog", title: "Test the link watchdog", detail: "With the robot connected and standing still, take its network away for longer than its link timeout, then give it back. HANNAH must see the robot report that it lost the link and held, and that the link returned. The robot's own controller must also stop the wheels when it hears nothing from the computer: test that yourself." },
  { id: "trial", title: "Supervised low-speed trial", detail: `With a person at the robot and the space clear, send it on one short trip. It is limited to ${TRIAL_SPEED} m/s and its arrival must be verified.` },
  { id: "odometry", title: "Compare the trip with a measurement", needsNote: true, detail: "Measure where the robot stopped on the trial and compare it with the position it reported, shown below. Check that both wheels turned the right way and that it drove towards the goal. Write down what you measured." },
  { id: "approval", title: "Approve for operation", detail: "You are saying this robot may be moved by HANNAH in this space, each movement still with your approval." },
];
const ORDER = STEPS.map((step) => step.id);
const BEFORE_TRIAL = ORDER.slice(0, ORDER.indexOf("trial"));
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** The verified low-speed trip made after everything before the trial was confirmed. */
function trialRun(record, missions) {
  const after = record?.steps?.[BEFORE_TRIAL[BEFORE_TRIAL.length - 1]]?.at || Infinity;
  return missions.find((mission) => mission.status === "succeeded" && mission.verification?.confirmed && ["navigate_to", "return_to_dock", "inspect_area"].includes(mission.capability) && mission.createdAt >= after && (mission.params.maxSpeed ?? Infinity) <= TRIAL_SPEED + 1e-9) || null;
}

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
  } else if (stepId === "software") {
    const speaks = (robot.protocols || []).includes("hannah-robot-v1");
    facts.push(`Runtime ${robot.runtimeVersion || "not reported"}`, `Software ${robot.softwareVersion || "not reported"}`, `Firmware ${robot.firmwareVersion || "not reported"}`, `ROS ${robot.rosDistro || "not used or not reported"}`, `Adapter ${robot.adapter || "not reported"}`, speaks ? "Speaks hannah-robot-v1" : "Did not list the protocol hannah-robot-v1");
    if (!robot.runtimeVersion) problems.push("The robot didn't report its runtime version.");
    if (!robot.softwareVersion) problems.push("The robot didn't report its software version.");
    if (!robot.firmwareVersion) problems.push("The robot didn't report its firmware version.");
    if (!speaks) problems.push("The robot didn't list the protocol this server speaks.");
  } else if (stepId === "limits") {
    const limits = robot.limits;
    facts.push(`Top speed ${finite(limits.maxLinearSpeed) ? `${limits.maxLinearSpeed} m/s` : "not reported"}`, `Workspace ${limits.workspaces.length ? "reported" : "not reported"}`, `Environment: ${limits.environment || "not declared"}`, `Stops by itself after ${limits.linkTimeoutS ?? "?"} s without HANNAH`);
    if (!finite(limits.maxLinearSpeed)) problems.push("No speed limit reported.");
    if (!limits.workspaces.length) problems.push("No workspace reported.");
    if (!limits.environment || limits.environment === "simulation") problems.push("The robot didn't declare a physical environment.");
    if (!finite(limits.linkTimeoutS)) problems.push("No link timeout reported.");
  } else if (stepId === "frames") {
    const pose = state.pose;
    const unframed = robot.sensors.filter((sensor) => !sensor.frame).map((sensor) => sensor.id);
    facts.push(pose?.frame ? `Position reported in the frame “${pose.frame}”${pose.source ? `, from ${pose.source}` : ""}` : "No position frame reported", `Map: ${robot.mapName || "not named"}`, ...robot.sensors.filter((sensor) => sensor.frame).map((sensor) => `${sensor.id} is in the frame “${sensor.frame}”`), ...(unframed.length ? [`No frame registered for: ${unframed.join(", ")}`] : []));
    if (!robot.online) problems.push("The robot isn't connected, so the frame it reports can't be read.");
    else if (!finite(pose?.x) || !finite(pose?.y)) problems.push("The robot isn't reporting a position.");
    else if (!pose.frame) problems.push("The robot reports a position without saying which frame it is in.");
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
  } else if (stepId === "watchdog") {
    const after = record?.steps?.diagnostics?.at || since;
    const lost = [...events].reverse().find((event) => event.source === "robot" && event.type === "link-lost" && event.at >= after);
    const back = lost && [...events].reverse().find((event) => event.source === "robot" && event.type === "link-restored" && event.at >= lost.at);
    facts.push(`Link timeout: ${robot.limits.linkTimeoutS ?? "?"} s`, lost ? "The robot reported that it lost its link and held" : "The robot has not reported a lost link since the diagnostics step", back ? "The robot reported that the link returned" : "No report of the link returning");
    if (!lost) problems.push("Take the robot's network away for longer than its link timeout while it is connected: HANNAH hasn't seen it report a lost link since the diagnostics step.");
    else if (!back) problems.push("Give the robot its network back: HANNAH hasn't seen it report that the link returned.");
    else if (!robot.online) problems.push("The robot isn't connected.");
  } else if (stepId === "odometry") {
    const run = trialRun(record, missions);
    const final = run?.result?.final || null;
    facts.push(run ? `Trial mission ${run.id}: goal (${run.params.x}, ${run.params.y})` : "No verified trial mission", ...(run?.verification?.evidence ? [run.verification.evidence] : []), ...(finite(final?.x) ? [`It reported stopping at (${final.x}, ${final.y})`] : []));
    if (!run) problems.push("There is no verified trial trip to compare with.");
  } else if (stepId === "trial") {
    const run = trialRun(record, missions);
    facts.push(run ? `Trial mission ${run.id} finished and was verified.` : `No verified movement at ${TRIAL_SPEED} m/s or less since the watchdog step.`);
    if (!run) problems.push("Run one supervised trip first; it has to finish and be verified.");
  }
  return { ok: problems.length === 0, problems, facts };
}

/** Where a robot stands, from its stored record alone: what the Safety Gateway needs. */
function summary(robot, record) {
  if (robot.simulated) return { required: false, status: "not-required", done: 0, total: 0, trialSpeed: null };
  const done = ORDER.filter((id) => record?.steps?.[id]).length;
  const ready = BEFORE_TRIAL.every((id) => record?.steps?.[id]);
  const status = record?.steps?.approval ? "approved" : ready ? "trial" : done ? "in-progress" : "required";
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
      return { ...step, needsNote: Boolean(step.needsNote), done: Boolean(confirmed), confirmedAt: confirmed?.at || null, note: confirmed?.note || "", available: state.required && step.id === next, check };
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
  if (STEPS.find((step) => step.id === stepId).needsNote && clean(note, 300).length < 3) throw fail(400, "Write down what you measured.", "note-missing");
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
