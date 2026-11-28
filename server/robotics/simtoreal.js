"use strict";

/**
 * Simulation-to-real deployment: the decisions, with no storage.
 *
 * One deployment is one change (a configuration, a driver, a model, software,
 * a mission) taken to one physical robot, then optionally to more. It follows
 * the owner's lifecycle (PART 4), each step checked from what is recorded:
 *
 *    1 select         a physical robot and a simulator profile are chosen
 *    2 load-sim       the simulator loaded that profile and described the simulated robot
 *    3 requirements   the mission's capabilities exist in the simulation AND on the robot, of the same type
 *    4 simulate       scenarios ran in HANNAH's built-in simulator and the results are stored
 *    5 inspect        a person looked at that run's results
 *    6 regression     the run compared with the suite's baseline shows no regression
 *    7 compare        every scenario's observed outcome is the one expected
 *    8 assumptions    every unverified assumption was acknowledged by a person
 *    9 hardware       the parity report (simulation vs the robot) has no blocking difference
 *   10 commissioning  the robot is commissioned and approved for operation (checked live)
 *   11 approval       a signed-in person approved the limited physical stage, for this run and this parity report
 *   12 physical-test  the robot finished a verified mission after that approval
 *   13 observe        a person recorded what they observed on the robot
 *   14 expand         wider stages, each with its own robots, checks and approval
 *
 * Passing the simulation never authorises anything physical: step 11 is a
 * person, and an approval stops counting when the run or the parity report it
 * was given for changes.
 */
const crypto = require("node:crypto");

const STEPS = [
  { id: "select", title: "Select the robot and its configuration" },
  { id: "load-sim", title: "Load the simulation model and environment" },
  { id: "requirements", title: "Validate the mission's requirements" },
  { id: "simulate", title: "Run it in the simulator" },
  { id: "inspect", title: "Inspect the simulated results", person: true },
  { id: "regression", title: "Regression scenarios against the baseline" },
  { id: "compare", title: "Compare expected and observed behaviour" },
  { id: "assumptions", title: "Acknowledge the unverified assumptions", person: true },
  { id: "hardware", title: "Check the real hardware configuration" },
  { id: "commissioning", title: "Commissioning of the physical robot" },
  { id: "approval", title: "Approve the limited physical stage", person: true },
  { id: "physical-test", title: "Limited physical test" },
  { id: "observe", title: "Observe and record the result", person: true },
  { id: "expand", title: "Expand only after validation", person: true },
];
const STAGES = ["simulation", "development", "test", "limited", "wider"];
const STAGE_TITLES = { simulation: "Simulation", development: "Development robot", test: "Test robot", limited: "Limited deployment", wider: "Wider deployment" };
const CHANGE_KINDS = ["configuration", "driver", "model", "software", "mission"];
const PHYSICAL_TEST_CAPABILITIES = ["navigate_to", "return_to_dock", "inspect_area", "move_arm_to", "pick_object", "place_object"];

/**
 * Metrics a regression suite compares, how to read them, and how much change is noise.
 * better: "higher" | "lower"; kind: what PART 4 calls it.
 */
const METRICS = [
  { key: "missionCompletion", label: "Trips completed", kind: "mission completion", better: "higher", tolerance: 0 },
  { key: "navigationReliability", label: "Trips that ended as expected", kind: "navigation reliability", better: "higher", tolerance: 0 },
  { key: "timeouts", label: "Trips that timed out", kind: "navigation reliability", better: "lower", tolerance: 0 },
  { key: "errorsPerTrip", label: "Faults and problems per trip", kind: "error frequency", better: "lower", tolerance: 0 },
  { key: "faults", label: "Faults", kind: "error frequency", better: "lower", tolerance: 0 },
  { key: "closestApproachM", label: "Closest approach to an obstacle (m)", kind: "motion", better: "higher", tolerance: 0.02 },
  { key: "maxOdometryErrorM", label: "Largest odometry error (m)", kind: "motion", better: "lower", tolerance: 0.02 },
  { key: "simulatedSeconds", label: "Simulated time for all trips (s)", kind: "motion", better: "lower", relative: 0.2 },
  { key: "maxLinearSpeed", label: "Top linear speed (m/s)", kind: "motion", changeOnly: true, tolerance: 0.01 },
  { key: "maxLinearAccel", label: "Top linear acceleration (m/s²)", kind: "motion", changeOnly: true, tolerance: 0.01 },
  { key: "cpuMs", label: "CPU time (ms)", kind: "resource use", better: "lower", relative: 0.5, warnOnly: true },
  { key: "peakRssKb", label: "Peak memory (KiB)", kind: "resource use", better: "lower", relative: 0.5, warnOnly: true },
];

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** The run against the baseline: every metric, with what changed and whether it is a regression. */
function regressionDiff(run, baseline) {
  if (!run?.summary) return { verdict: "no-run", items: [], regressions: [], warnings: [] };
  if (!baseline?.summary) return { verdict: "no-baseline", items: [], regressions: [], warnings: ["There is no baseline for this suite yet. Set a run you have inspected as the baseline; later runs are compared with it."] };
  const items = [];
  for (const metric of METRICS) {
    const now = run.summary[metric.key];
    const before = baseline.summary[metric.key];
    if (!finite(now) || !finite(before)) { items.push({ ...metric, before: before ?? null, now: now ?? null, change: null, status: "not-comparable" }); continue; }
    const change = Number((now - before).toFixed(4));
    const allowed = metric.relative ? Math.abs(before) * metric.relative : metric.tolerance;
    let status = "same";
    if (Math.abs(change) > allowed + 1e-9) {
      if (metric.changeOnly) status = "changed";
      else status = (metric.better === "higher" ? change > 0 : change < 0) ? "improved" : metric.warnOnly ? "worse" : "regressed";
    }
    items.push({ key: metric.key, label: metric.label, kind: metric.kind, before, now, change, status });
  }
  const baselinePassed = new Map((baseline.results || []).map((result) => [result.name, result.passed]));
  const scenarioRegressions = (run.results || []).filter((result) => baselinePassed.get(result.name) === true && !result.passed).map((result) => `${result.name} passed in the baseline and fails now: ${result.problems.join("; ")}`);
  const missing = [...baselinePassed.keys()].filter((name) => !(run.results || []).some((result) => result.name === name));
  const regressions = [...items.filter((item) => item.status === "regressed").map((item) => `${item.label}: ${item.before} → ${item.now}`), ...scenarioRegressions];
  const warnings = [...items.filter((item) => item.status === "worse" || item.status === "changed").map((item) => `${item.label} changed: ${item.before} → ${item.now}`), ...(missing.length ? [`Not run this time: ${missing.join(", ")}. The comparison covers only what both runs ran.`] : [])];
  return { verdict: regressions.length ? "regressed" : "pass", items, regressions, warnings };
}

const SIM_ONLY = [
  "The simulated world is not the robot's real environment: floor, lighting, clutter and people are not modelled.",
  "Sensors in the simulator have no noise model other than odometry drift; real sensors are noisier and fail differently.",
  "Wheel slip, payload, motor heating and battery sag under load are not simulated.",
  "The emergency-stop wiring and the robot's own motor controller watchdog are not part of the simulation.",
];

/**
 * Simulation against the physical robot as it reported itself. `sim` is the
 * simulator's description (simulator.describe) with the change's overrides
 * applied; `robot` is the registry view.
 */
function parityReport(sim, overrides, robot) {
  const items = [];
  const add = (area, field, simValue, robotValue, { blocking = false, note = "", compare = "equal" } = {}) => {
    const s = simValue === undefined || simValue === "" ? null : simValue;
    const r = robotValue === undefined || robotValue === "" ? null : robotValue;
    let status = "same";
    if (s === null && r === null) status = "unknown";
    else if (s === null) status = "missing-in-sim";
    else if (r === null) status = "missing-on-robot";
    else if (compare === "equal" ? JSON.stringify(s) !== JSON.stringify(r) : compare(s, r)) status = "different";
    items.push({ area, field, sim: s, physical: r, status, blocking: blocking && (status === "different" || status === "missing-on-robot"), note: status === "same" || status === "unknown" ? "" : note });
  };
  const d = sim.descriptor || {};
  const simLimits = { ...(d.limits || {}), ...(overrides?.limits || {}) };
  const radius = overrides?.robot?.radius ?? sim.robot?.radius ?? d.limits?.robotRadius;
  const reported = robot.safety?.reported || {};
  add("model", "robot type", d.robotType, robot.robotType, { blocking: true, note: "The simulation is of a different kind of robot; nothing it showed applies." });
  add("model", "manufacturer and model", `${d.manufacturer || ""} ${d.model || ""}`.trim(), `${robot.manufacturer || ""} ${robot.model || ""}`.trim(), { note: "The simulated model is generic; its dimensions and dynamics are not this machine's." });
  const faster = (s, r) => r > s + 1e-9;
  for (const [key, label] of [["maxLinearSpeed", "top linear speed (m/s)"], ["maxAngularSpeed", "top angular speed (rad/s)"], ["maxLinearAccel", "linear acceleration (m/s²)"]]) {
    add("motion and navigation", label, simLimits[key], reported[key], { blocking: true, compare: faster, note: "The robot may move faster than anything that was simulated. Lower its limit, or simulate at its limit." });
  }
  add("motion and navigation", "angular acceleration (rad/s²)", simLimits.maxAngularAccel, reported.maxAngularAccel, { note: "Not reported by the robot, or different: the controller's ramp is unverified." });
  add("joint limits", "joint speed (rad/s)", simLimits.maxJointSpeed, reported.maxJointSpeed, { blocking: true, compare: faster, note: "The arm may move its joints faster than was simulated." });
  add("footprint", "radius (m)", radius, reported.robotRadius, { blocking: true, compare: (s, r) => r > s + 0.01, note: "The robot is larger than the simulated one, so the clearances the simulation showed don't hold." });
  const simSensors = new Map((d.sensors || []).map((sensor) => [sensor.id, sensor]));
  const realSensors = new Map((robot.sensors || []).map((sensor) => [sensor.id, sensor]));
  for (const [id, sensor] of simSensors) {
    const real = realSensors.get(id);
    const navigation = /range|lidar|odometry/.test(sensor.type || "");
    add("sensors", `${id} type`, sensor.type, real?.type, { blocking: navigation, note: navigation ? "Navigation in the simulation relied on this sensor." : "This sensor was simulated; the robot reports it differently or not at all." });
    if (sensor.frame || real?.frame) add("frames", `${id} frame`, sensor.frame, real?.frame, { note: "The sensor's frame differs: check its transform on the robot." });
    if (sensor.rateHz || real?.rateHz) add("sensors", `${id} rate (Hz)`, sensor.rateHz, real?.rateHz, { note: "A different rate changes how quickly obstacles are seen." });
  }
  for (const [id, real] of realSensors) if (!simSensors.has(id)) add("sensors", `${id} type`, null, real.type, { note: "The robot has a sensor the simulation didn't model." });
  add("frames", "workspace frame", d.limits?.workspace?.frame || "map", reported.workspace?.frame, { note: "Positions are given in a different frame on the robot." });
  add("controller", "link timeout (s)", d.limits?.linkTimeoutS, reported.linkTimeoutS, { note: "The robot stops after a different silence than the simulation did." });
  add("controller", "command lifetime (s)", d.limits?.commandTtlS, reported.commandTtlS, { note: "Commands expire after a different time on the robot." });
  add("controller", "adapter", d.adapter, robot.adapter, { note: "The robot is driven by a different adapter than the simulator: its controller behaviour is unverified." });
  add("firmware", "firmware version", d.firmwareVersion, robot.firmwareVersion, { note: "The simulator has no firmware; the robot's firmware behaviour is unverified." });
  add("software", "runtime version", d.runtimeVersion, robot.runtimeVersion, { note: "The robot runs a different HANNAH runtime than the simulation did." });
  add("software", "software version", d.softwareVersion, robot.softwareVersion, { note: "The robot's software differs from the simulated one." });
  add("software", "ROS distribution", d.rosDistro, robot.rosDistro, { note: "The robot uses ROS 2 where the simulation didn't, or a different distribution." });
  add("software", "operating system", d.os, robot.os, { note: "Different operating system." });
  const blocking = items.filter((item) => item.blocking);
  const assumptions = [
    ...SIM_ONLY.map((text) => ({ id: hash(["always", text]).slice(0, 12), text, source: "the simulator" })),
    ...items.filter((item) => !item.blocking && item.status !== "same" && item.status !== "unknown").map((item) => ({ id: hash([item.area, item.field]).slice(0, 12), text: `${item.area}, ${item.field}: simulation ${item.sim ?? "—"}, robot ${item.physical ?? "—"}. ${item.note}`, source: "parity report" })),
  ];
  const body = { items, blocking: blocking.map((item) => `${item.field}: ${item.note}`), assumptions };
  return { ...body, ok: blocking.length === 0, robotId: robot.id, simProfile: sim.profile, simulator: sim.simulator, physical: false, hash: hash({ items: items.map(({ area, field, sim: s, physical, status }) => [area, field, s, physical, status]), overrides }) };
}

/** Whether a robot may be in a physical stage right now. */
function robotReady(robot) {
  const problems = [];
  if (!robot) return { ok: false, problems: ["The robot is no longer in your account."] };
  if (robot.simulated) problems.push(`${robot.name} is a simulated robot; a physical stage needs a physical robot.`);
  if (robot.status !== "enrolled") problems.push(`${robot.name} isn't enrolled.`);
  if (!robot.simulated && robot.commissioning?.status !== "approved") problems.push(`${robot.name} isn't commissioned and approved for operation (commissioning: ${robot.commissioning?.status || "required"}).`);
  return { ok: problems.length === 0, problems };
}

/**
 * Every lifecycle step with whether it holds, from the stored deployment and
 * live facts: `robot` (registry view), `run` and `baseline` (stored runs),
 * `missions` (the robot's recent missions).
 */
function evaluate(deployment, { robot, run = null, baseline = null, missions = [] } = {}) {
  const status = {};
  const set = (id, ok, detail) => { status[id] = { ok: Boolean(ok), detail }; };
  const required = deployment.change.capabilities?.length ? deployment.change.capabilities : ["navigate_to"];
  const sim = deployment.sim;
  set("select", robot && !robot.simulated && deployment.change.simProfile, robot ? (robot.simulated ? `${robot.name} is simulated; choose a physical robot.` : `${robot.name} with the simulator profile ${deployment.change.simProfile}.`) : "The robot isn't in your account any more.");
  set("load-sim", sim?.descriptor, sim?.descriptor ? `Loaded ${sim.profile} (${sim.simulator}).` : "The simulator hasn't loaded the profile yet.");
  const simCaps = sim?.descriptor?.capabilities || [];
  const missingSim = required.filter((id) => !simCaps.includes(id));
  const missingRobot = required.filter((id) => !(robot?.capabilities || []).includes(id));
  const sameType = sim?.descriptor && robot && sim.descriptor.robotType === robot.robotType;
  set("requirements", sim?.descriptor && robot && !missingSim.length && !missingRobot.length && sameType, !sim?.descriptor ? "Load the simulation first." : !sameType ? `The simulation is a ${sim.descriptor.robotType}; ${robot?.name} is a ${robot?.robotType}.` : missingSim.length ? `The simulation doesn't offer ${missingSim.join(", ")}.` : missingRobot.length ? `${robot.name} doesn't offer ${missingRobot.join(", ")}.` : `Needs ${required.join(", ")}: offered by both.`);
  set("simulate", run?.summary, run?.summary ? `Run ${run.id}: ${run.summary.scenarios} scenario(s) in ${run.simulator}, ${run.summary.simulatedSeconds} s simulated.` : "No run yet.");
  set("inspect", run && deployment.inspected?.runId === run.id, run && deployment.inspected?.runId === run.id ? `Inspected by ${deployment.inspected.by}.` : "A person must look at this run's results.");
  const diff = run ? regressionDiff(run, baseline) : { verdict: "no-run", regressions: [], warnings: [] };
  const baselineIsThisRun = baseline && run && baseline.id === run.id;
  set("regression", diff.verdict === "pass" || baselineIsThisRun, baselineIsThisRun ? "This run is the suite's baseline (the first one; nothing earlier to compare with)." : diff.verdict === "pass" ? `No regression against baseline ${baseline.id}${diff.warnings.length ? `; ${diff.warnings.length} change(s) to note` : ""}.` : diff.verdict === "regressed" ? `Regressed: ${diff.regressions.join("; ")}` : diff.verdict === "no-baseline" ? "No baseline for this suite yet." : "No run yet.");
  const failed = (run?.results || []).filter((result) => !result.passed);
  set("compare", run?.summary && !failed.length, !run ? "No run yet." : failed.length ? `Not as expected: ${failed.map((result) => `${result.name} (${result.problems[0]})`).join("; ")}` : `All ${run.summary.scenarios} scenario(s) behaved as expected.`);
  const parity = deployment.parity;
  const acknowledged = new Set(deployment.acknowledged?.ids || []);
  const open = (parity?.assumptions || []).filter((item) => !acknowledged.has(item.id));
  set("assumptions", parity && !open.length, !parity ? "No parity report yet." : open.length ? `${open.length} unverified assumption(s) not acknowledged.` : `${parity.assumptions.length} assumption(s) acknowledged by ${deployment.acknowledged.by}.`);
  set("hardware", parity?.ok, !parity ? "No parity report yet." : parity.ok ? `No blocking difference between the simulation and ${robot?.name}.` : `Blocking: ${parity.blocking.join("; ")}`);
  const ready = robotReady(robot);
  set("commissioning", ready.ok, ready.ok ? `${robot.name} is commissioned and approved for operation.` : ready.problems.join(" "));
  const before = STEPS.slice(0, STEPS.findIndex((step) => step.id === "approval")).map((step) => step.id);
  const approval = (deployment.approvals || []).find((item) => item.stage === "development");
  const approvalValid = approval && run && approval.runId === run.id && approval.parityHash === parity?.hash;
  set("approval", approvalValid && before.every((id) => status[id].ok), !approval ? "A signed-in person must approve the limited physical stage." : !approvalValid ? "The approval was given for another run or parity report; it no longer counts." : before.every((id) => status[id].ok) ? `Approved by ${approval.by} on ${new Date(approval.at).toISOString()}.` : "Approved, but an earlier step no longer holds.");
  const physical = approvalValid ? missions.find((mission) => mission.status === "succeeded" && mission.verification?.confirmed && mission.createdAt >= approval.at && PHYSICAL_TEST_CAPABILITIES.includes(mission.capability)) : null;
  set("physical-test", physical && status.approval.ok, physical ? `Mission ${physical.id} (${physical.capability}) finished on ${robot?.name} and was verified.` : "After approval, run one supervised mission on the robot; it must finish and be verified.");
  const observation = (deployment.observations || []).find((item) => item.stage === "development");
  set("observe", observation?.outcome === "ok" && status["physical-test"].ok, observation ? `${observation.outcome === "ok" ? "Behaved as expected" : "Problem observed"}, recorded by ${observation.by}: ${observation.note}` : "Record what you saw on the robot.");
  const reached = STAGES.indexOf(deployment.stage);
  set("expand", reached > STAGES.indexOf("development") || deployment.stage === "completed", reached > 1 ? `Expanded to ${STAGE_TITLES[deployment.stage]}.` : "Optional: take it to a test robot, then a limited and a wider group, each with its own approval.");
  const steps = STEPS.map((step) => ({ ...step, person: Boolean(step.person), ...status[step.id] }));
  const firstOpen = steps.find((step) => !step.ok && step.id !== "expand");
  return { steps, next: firstOpen?.id || "expand", diff, readyForApproval: before.every((id) => status[id].ok), physicalValidated: status.observe.ok };
}

module.exports = { CHANGE_KINDS, METRICS, PHYSICAL_TEST_CAPABILITIES, SIM_ONLY, STAGES, STAGE_TITLES, STEPS, evaluate, parityReport, regressionDiff, robotReady };
