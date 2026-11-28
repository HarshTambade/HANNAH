"use strict";

/**
 * Robot capabilities as Action Engine actions.
 *
 * A robot is asked for an operation the same way an email is sent: the engine
 * checks the account's permission for the Robots service, asks for approval
 * when the level or the action's own flags require it, runs it once, checks
 * the result and records all of it. What is specific to robots:
 *
 *   - assess() runs the Robotics Safety Gateway. A command that can't be valid
 *     for that robot (a goal outside its workspace, a capability it doesn't
 *     offer, an engaged emergency stop) is refused with the reason and is
 *     never shown for approval. A physical robot's movement always asks.
 *   - execute() runs the gateway again, because the robot's state may have
 *     changed while the approval waited, then queues a signed command and
 *     waits a few seconds for the robot's own answer.
 *   - "done" for a movement means the robot accepted the mission and started
 *     it. Arrival is the mission's own result (robots.mission), verified from
 *     the robot's reported state when it finishes.
 *   - Stopping is defined with `deescalates`: it needs no approval at any
 *     level and works while the emergency stop is on.
 *
 * There is no action here for wheel speeds or any other actuator value.
 */
const { capability } = require("../../robotics/contract");
const fleet = require("../../robotics/fleet");
const plans = require("../../robotics/plans");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const ROBOT = { type: "string", description: "The robot's name or id. Leave out when there is exactly one robot." };

/** Tool callers often send numbers as text; the contract wants numbers. */
function coerce(schema, value) {
  if (schema?.type === "number" && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (schema?.type === "array" && Array.isArray(value)) return value.map((item) => coerce(schema.items, item));
  if (schema?.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) { if (item !== undefined && item !== null && item !== "") out[key] = coerce(schema.properties?.[key], item); }
    return out;
  }
  return value;
}

/** Who asked, as the command-validation chain needs it: the Action Engine's record when it runs, the request before. */
const callerOf = (ctx) => ({ source: ctx.record?.source || ctx.caller?.source || "chat", actor: ctx.record?.agent || ctx.caller?.agent || "" });

const kindLabel = (robot) => (robot.simulated ? `SIMULATION (${robot.simulator || "simulator"})` : "PHYSICAL ROBOT");
const pointText = (point) => (point.place ? `${point.place} (${round(point.x)}, ${round(point.y)})` : `(${round(point.x)}, ${round(point.y)})`);

/** One honest sentence about a mission. */
function missionText(mission, robotName = "The robot") {
  const what = mission.title || mission.capability;
  switch (mission.status) {
    case "queued": return `${what}: waiting to be delivered to ${robotName}. Nothing has moved.`;
    case "sent": return `${what}: delivered; ${robotName} hasn't accepted it yet. Nothing has moved.`;
    case "paused": return `${what}: paused. ${robotName} is holding where it is and keeps the mission${mission.resumeRequestedAt ? "; a resume has been sent" : ""}.${mission.error ? ` ${mission.error}` : ""}`;
    case "accepted": return `${what}: ${robotName} accepted it and is carrying it out${mission.progress?.distanceRemaining !== undefined ? ` (${round(mission.progress.distanceRemaining)} m to go)` : ""}. It is not finished.`;
    case "succeeded": return `${what}: finished and verified. ${mission.verification?.evidence || ""}`.trim();
    case "unverified": return `${what}: ${robotName} reported success, but its state doesn't confirm it. ${mission.verification?.evidence || ""}`.trim();
    case "rejected": return `${what}: ${robotName}'s own checks refused it. ${mission.error || ""}`.trim();
    case "cancelled": return `${what}: cancelled. ${mission.error || ""}`.trim();
    case "failed": return `${what}: failed. ${mission.error || ""}`.trim();
    case "timed-out": return `${what}: ran out of time. ${mission.error || ""}`.trim();
    case "expired": return `${what}: never started. ${mission.error || ""}`.trim();
    case "lost": return `${what}: outcome unknown. ${mission.error || ""}`.trim();
    default: return `${what}: ${mission.status}.`;
  }
}

function robotActions({ robotics }) {
  const summary = (robot) => ({
    id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical", simulator: robot.simulator, type: robot.robotType || null, maker: [robot.manufacturer, robot.model].filter(Boolean).join(" ") || null,
    connection: robot.connection, mode: robot.mode, battery: robot.online ? robot.state?.battery?.percent ?? null : null,
    capabilities: robot.capabilities.filter((id) => !robot.disabled.includes(id)), places: Object.keys(robot.places || {}), sensors: (robot.sensors || []).map((sensor) => sensor.id), devices: Object.keys(robot.devices || {}),
  });

  /** A capability that starts a mission on the robot. */
  function missionAction({ capabilityId, title, describe }) {
    const definition = capability(capabilityId);
    const inputOf = (params) => { const { robot: _robot, ...rest } = params; return rest; };
    return {
      // High risk (an arm, a gripper) always asks: no standing permission can cover it, in simulation or not.
      ...(definition.risk === "high" ? { standing: false } : {}),
      id: `robots.${capabilityId}`, service: "robots", kind: "write", title, description: definition.description, needs: "A robot enrolled under Robots, connected",
      input: { type: "object", properties: { robot: ROBOT, ...definition.input.properties }, required: definition.input.required || [] },
      normalize: (raw) => ({ robot: clip(raw.robot, 80), ...coerce(definition.input, Object.fromEntries(Object.entries(raw || {}).filter(([key]) => key !== "robot" && Object.hasOwn(definition.input.properties, key)))) }),
      async assess(params, ctx) {
        const verdict = await robotics.assess(ctx.db, ctx.userId, params.robot, capabilityId, inputOf(params), { stage: "preflight", identity: callerOf(ctx) });
        return { resource: { type: "robot", id: verdict.robot.id }, account: verdict.robot.name, flags: verdict.flags, verdict };
      },
      preview(params, _ctx, assessed) {
        const { verdict } = assessed;
        const robot = verdict.robot;
        return {
          ...(capabilityId === "capture_image" ? {
            title: `Take a picture: ${robot.name} ${describe(verdict.params, robot)}`,
            lines: [
              { label: "Robot", value: `${robot.name} — ${kindLabel(robot)}` },
              { label: "Camera", value: `${verdict.params.camera || "none"}${robot.simulated ? " (simulated)" : ""}` },
              { label: "Kept for", value: `${robot.camera?.retentionHours ?? 24} hours, then deleted` },
              { label: "Who can see it", value: "Only this account. Every viewing is logged" },
              { label: "What is detected", value: "Regions of colour, with a confidence. Not what an object is, and never who a person is" },
            ],
            body: verdict.ok ? "The camera is read once, for this picture. Nothing moves." : verdict.violations.map((item) => item.message).join("\n"),
            warnings: verdict.warnings,
          } : {}),
          ...(capabilityId === "capture_image" ? {} : {
          title: `Start a mission: ${robot.name} ${describe(verdict.params, robot)}`,
          lines: [
            { label: "Robot", value: `${robot.name} — ${kindLabel(robot)}` },
            ...(verdict.params.maxSpeed !== undefined ? [{ label: "Speed limit", value: `${round(verdict.params.maxSpeed)} m/s` }] : []),
            { label: "Risk", value: verdict.risk },
            { label: "Checked", value: !verdict.ok ? "Refused by the Safety Gateway" : definition.motion && !["navigate_to", "return_to_dock", "inspect_area"].includes(capabilityId) ? "Robot ready; the arm's planner checks joint limits and collisions before it moves" : "Inside the workspace, outside keep-out zones, robot ready" },
            { label: "If the link drops", value: "The robot stops by itself" },
          ],
          body: verdict.ok ? `${["move_robot_arm", "grasp_object", "release_object"].includes(capabilityId) ? "The arm's own planner chooses the joint motion; HANNAH sends the target, never joint values." : "The robot's own planner drives it; HANNAH sends the goal, not wheel commands."} The command is valid for ${Math.round(verdict.limits?.commandTtlS ?? 20)} seconds after it is sent.` : verdict.violations.map((item) => item.message).join("\n"),
          warnings: verdict.warnings,
          }),
        };
      },
      async execute(params, ctx) {
        // The chain again, at the moment it is sent, with the approved request behind it.
        const verdict = await robotics.assess(ctx.db, ctx.userId, params.robot, capabilityId, inputOf(params), { stage: "execute", identity: callerOf(ctx), authorization: { kind: "action-record", recordId: ctx.record?.id } });
        if (!verdict.ok) throw fail(409, `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`, "safety-refused");
        const queued = await robotics.dispatch(ctx.db, ctx.userId, { robot: verdict.robot, capabilityId, params: verdict.params, actionId: ctx.record?.id, verdict });
        const mission = await robotics.waitFor(ctx.db, ctx.userId, queued.id, (item) => (capabilityId === "capture_image" ? item.final : item.status !== "queued" && item.status !== "sent"));
        if (["rejected", "failed", "timed-out", "expired", "lost", "cancelled"].includes(mission.status)) throw fail(409, missionText(mission, verdict.robot.name), `mission-${mission.status}`);
        if (capabilityId === "capture_image" && mission.result?.imageId) {
          const { detector, detections = [], ...picture } = mission.result;
          return { missionId: mission.id, robot: { id: verdict.robot.id, name: verdict.robot.name, kind: verdict.robot.simulated ? "simulation" : "physical" }, status: mission.status, imageId: picture.imageId, capturedAt: picture.capturedAt, frame: picture.frame, sensor: picture.sensor, source: picture.source, keptUntil: picture.expiresAt, detector, detections, note: `${detections.length} coloured region${detections.length === 1 ? "" : "s"} detected by ${detector?.model || "the detector"}. It finds regions of colour; it cannot say what an object is. ${verdict.robot.simulated ? "This is a simulated camera." : ""}`.trim() };
        }
        return { missionId: mission.id, robot: { id: verdict.robot.id, name: verdict.robot.name, kind: verdict.robot.simulated ? "simulation" : "physical" }, status: mission.status, sent: verdict.params, note: missionText(mission, verdict.robot.name) };
      },
      async verify(response, _params, ctx) {
        const mission = await robotics.getMission(ctx.db, ctx.userId, response.missionId);
        if (mission.status === "succeeded") return { confirmed: true, evidence: capabilityId === "capture_image" ? mission.verification?.evidence || "The picture arrived." : `Mission ${mission.id} already finished. ${mission.verification?.evidence || ""}`.trim() };
        if (mission.status === "accepted") return { confirmed: true, evidence: `${response.robot.name} accepted mission ${mission.id} and is carrying it out. This confirms the start, not the result: read the mission for where the robot ended up.` };
        if (mission.status === "queued" || mission.status === "sent") return { confirmed: false, evidence: `${response.robot.name} hasn't acknowledged mission ${mission.id} yet. If it doesn't accept it within ${Math.max(0, Math.round((mission.expiresAt - Date.now()) / 1000))} seconds the command expires and nothing runs.` };
        return { confirmed: false, evidence: missionText(mission, response.robot.name) };
      },
    };
  }

  /** Something read from the registry's last report; never a command to the robot. */
  function readAction({ id, title, description, input, run }) {
    return {
      id, service: "robots", kind: "read", title, description, needs: "A robot enrolled under Robots", input: { type: "object", properties: input, required: [] },
      normalize: (raw) => Object.fromEntries(Object.keys(input).map((key) => [key, clip(raw?.[key], 80)])),
      assess: () => ({}),
      preview: () => ({ title, lines: [] }),
      execute: (params, ctx) => run(params, ctx),
      verify: (response) => ({ confirmed: true, evidence: response?.stale ? "Read from the robot's last report, which is old: the robot is offline." : "Read from the robot's latest report." }),
    };
  }

  const stateOf = (robot) => ({
    robot: summary(robot), online: robot.online, stale: !robot.online, ageS: robot.stateAgeS,
    note: robot.online ? "Current: reported in the last few seconds." : robot.lastSeenAt ? `Not current: ${robot.name} is offline; this is its last report.` : `${robot.name} has never connected.`,
    gripper: robot.state?.gripper ?? undefined, scene: robot.state?.scene ?? undefined,
    mode: robot.state?.mode ?? null, pose: robot.state?.pose ?? null, velocity: robot.state?.velocity ?? null, battery: robot.state?.battery ?? null, emergencyStop: robot.state?.estop ?? null, motorsEnabled: robot.state?.motorsEnabled ?? null,
    localized: robot.state?.localized ?? null, faults: robot.state?.faults ?? [], mission: robot.state?.mission ?? null, devices: robot.state?.devices ?? null,
  });

  /**
   * Give a task to whichever robot can best take it. The choice is made when the
   * task is asked for and is part of what the person approves: if that robot can
   * no longer take it when it is sent, it is refused, never quietly given to another.
   */
  function assignAction() {
    const tasks = { navigate_to: "robots.navigate_to", return_to_dock: "robots.return_to_dock", inspect_area: "robots.inspect_area" };
    const inner = (capabilityId) => missions.find((action) => action.id === tasks[capabilityId]);
    return {
      id: "robots.assign", service: "robots", kind: "write", title: "Assign a task to an available robot", needs: "At least one robot that can take the task",
      description: "Choose the robot best placed to take a movement task (drive to a place, return to dock, visit points) and start it there. A robot is chosen only if it is connected, ready, commissioned if physical, not busy, and has the destination on its own map; the nearest wins. The answer lists every robot considered and why the others weren't chosen.",
      input: { type: "object", properties: { task: { type: "string", enum: Object.keys(tasks), description: "What to do." }, place: { type: "string" }, x: { type: "number" }, y: { type: "number" }, waypoints: { type: "array", items: { type: "object" } }, maxSpeed: { type: "number" }, among: { type: "string", description: "Only consider this robot (name or id). Optional." } }, required: ["task"] },
      async normalize(raw, ctx) {
        const capabilityId = String(raw?.task || raw?.capability || "navigate_to");
        if (!tasks[capabilityId]) throw fail(400, `A robot can be assigned: ${Object.keys(tasks).join(", ")}.`, "bad-request");
        const task = { capability: capabilityId, ...(await inner(capabilityId).normalize(raw || {}, ctx)) };
        const [everyRobot, active] = await Promise.all([robotics.listRobots(ctx.db, ctx.userId), robotics.listMissions(ctx.db, ctx.userId, { active: true, limit: 100 })]);
        // A task handed on from another robot: that robot is left out, and bare coordinates only mean the same place on the same map.
        const robots = everyRobot.filter((robot) => robot.id !== raw?.exclude && (!raw?.sameMapAs || robot.mapName === raw.sameMapAs));
        const choice = fleet.choose({ robots, task, active, only: clip(raw?.among, 80) });
        if (!choice.chosen) throw fail(409, choice.problem || (choice.considered.length ? `No robot can take that now. ${choice.considered.map((entry) => `${entry.name}: ${entry.reason}`).join("; ")}.` : "You have no robots."), choice.conflict ? "conflict" : "no-robot-available", { candidates: choice.considered });
        const { capability: _capability, robot: _robot, ...rest } = task;
        return { task: capabilityId, ...rest, robot: choice.chosen.id, chosen: { name: choice.chosen.name, why: choice.chosen.why }, considered: choice.considered.map(({ id: _id, eligible, ...entry }) => ({ ...entry, chosen: entry.name === choice.chosen.name, eligible })) };
      },
      forward: (params) => { const { task: _task, chosen: _chosen, considered: _considered, ...rest } = params; return rest; },
      async assess(params, ctx) { return inner(params.task).assess(this.forward(params), ctx); },
      async preview(params, ctx, assessed) {
        const base = await inner(params.task).preview(this.forward(params), ctx, assessed);
        const others = params.considered.filter((entry) => !entry.chosen);
        return { ...base, lines: [{ label: "Chosen", value: `${params.chosen.name}: ${params.chosen.why}` }, ...(others.length ? [{ label: "Not chosen", value: others.map((entry) => `${entry.name} (${entry.eligible ? `${entry.distanceM ?? "?"} m away` : entry.reason})`).join("; ") }] : []), ...base.lines] };
      },
      async execute(params, ctx) { return { ...(await inner(params.task).execute(this.forward(params), ctx)), chosen: params.chosen, considered: params.considered }; },
      verify(response, params, ctx) { return inner(params.task).verify(response, this.forward(params), ctx); },
    };
  }

  /** The mission a control action is about: the one named, or the robot's unfinished one. */
  async function target(ctx, params, wanted, word) {
    if (params.mission) {
      const mission = await robotics.getMission(ctx.db, ctx.userId, params.mission);
      return { mission, robot: await robotics.getRobot(ctx.db, ctx.userId, mission.robotId) };
    }
    const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
    const missions = (await robotics.listMissions(ctx.db, ctx.userId, { robotId: robot.id, active: true, limit: 20 })).filter((item) => item.capability !== "stop_motion");
    const mission = missions.find(wanted) || missions[0];
    if (!mission) throw fail(404, `${robot.name} has no ${word} mission.`, "no-mission");
    return { mission, robot };
  }
  /** A resume moves the robot again, so it gets the same checks as the mission did, against the robot as it is now. */
  async function resumeCheck(ctx, robot, mission, stage = "preflight") {
    if (mission.status !== "paused") return { ok: false, violations: [{ code: "not-paused", message: mission.final ? "That mission is already over." : "That mission isn't paused." }], flags: [], warnings: [] };
    const strip = ({ place: _place, ...point }) => point;
    const params = mission.capability === "inspect_area" ? { waypoints: (mission.params.waypoints || []).map(strip), tolerance: mission.params.tolerance } : mission.capability === "return_to_dock" ? {} : { x: mission.params.x, y: mission.params.y, ...(mission.params.yaw === undefined ? {} : { yaw: mission.params.yaw }), tolerance: mission.params.tolerance };
    // The whole chain, as for a new mission; the paused mission itself doesn't count as "another mission running".
    return robotics.assess(ctx.db, ctx.userId, robot, mission.capability, params, { stage, identity: callerOf(ctx), resuming: mission.id, planId: mission.planId, ...(stage === "execute" ? { authorization: { kind: "action-record", recordId: ctx.record?.id } } : {}) });
  }
  /** Cancel or pause: reduces what is happening, so it never needs approval. */
  function control({ id, capabilityId, title, verb, act, settled, good }) {
    return {
      id, service: "robots", kind: "write", deescalates: true, title, description: capability(capabilityId).description, needs: "A mission that isn't finished",
      input: { type: "object", properties: { robot: ROBOT, mission: { type: "string", description: "The mission id. Leave out for the robot's current mission." } }, required: [] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), mission: clip(raw?.mission, 40) }),
      async assess(params, ctx) {
        const { robot, mission } = await target(ctx, params, (item) => item.status === "accepted", "running");
        return { resource: { type: "robot", id: robot.id }, account: robot.name, robot, mission };
      },
      preview: (_params, _ctx, assessed) => ({ title: `${verb} ${assessed.robot.name}'s mission “${assessed.mission.title}”`, lines: [{ label: "Robot", value: `${assessed.robot.name} — ${kindLabel(assessed.robot)}` }, { label: "Approval", value: "Never needed" }] }),
      async execute(params, ctx) {
        const { robot, mission } = await target(ctx, params, (item) => item.status === "accepted", "running");
        await act(ctx.db, ctx.userId, mission.id);
        const after = robot.online ? await robotics.waitFor(ctx.db, ctx.userId, mission.id, settled) : await robotics.getMission(ctx.db, ctx.userId, mission.id);
        return { missionId: mission.id, robot: { id: robot.id, name: robot.name, online: robot.online }, status: after.status, note: missionText(after, robot.name) };
      },
      async verify(response, _params, ctx) {
        const mission = await robotics.getMission(ctx.db, ctx.userId, response.missionId);
        if (good.includes(mission.status)) return { confirmed: true, evidence: missionText(mission, response.robot.name) };
        if (!response.robot.online) return { confirmed: false, evidence: `${response.robot.name} is offline, so this couldn't be delivered. A robot that loses its link to HANNAH has already stopped by itself.` };
        return { confirmed: false, evidence: missionText(mission, response.robot.name) };
      },
    };
  }

  /**
   * Several steps under one approval. A template is expanded into explicit
   * steps before anything is checked, so what the person approves is the list
   * of steps, not a template name.
   */
  function planAction() {
    const forward = (params) => params.steps.map((step) => ({ capability: step.capability, params: step.params }));
    return {
      id: "robots.run_plan", service: "robots", kind: "write", title: "Run a plan of several steps on a robot", needs: "A simulated robot enrolled under Robots, connected",
      description: "Run several steps in order on one robot under one approval: drive somewhere, record what the sensors detect, read a sensor, move an arm, grasp, release. Give explicit steps, or a template with its inputs. Every step is checked by the Safety Gateway now and again when it is sent. The plan stops at the first step that doesn't finish and verify; later steps are not run. A busy robot queues the plan. Physical robots are refused: each of their movements is approved by itself.",
      input: {
        type: "object",
        properties: {
          robot: ROBOT,
          template: { type: "string", enum: plans.TEMPLATES.map((template) => template.id), description: "A template, instead of steps." },
          inputs: { type: "object", description: "The template's inputs, for example { place } or { places, sensor } or { object, to }." },
          steps: { type: "array", maxItems: plans.MAX_STEPS, items: { type: "object" }, description: "Explicit steps, each { do: capability, ...its inputs }. For example { do: \"navigate_to\", place: \"kitchen\" }." },
          title: { type: "string" },
          priority: { type: "number", description: "1 (low) to 5 (high) among plans waiting for the same robot. Default 3." },
          startWithinMinutes: { type: "number", description: `Dropped if it hasn't started by then. Default ${plans.START_WITHIN_MIN.default}, at most ${plans.START_WITHIN_MIN.max}.` },
        },
        required: [],
      },
      async normalize(raw, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, clip(raw?.robot, 80));
        let title = clip(raw?.title, 120);
        let template = null;
        let steps;
        if (raw?.template) {
          const built = plans.expand(robot, clip(raw.template, 60), raw.inputs && typeof raw.inputs === "object" ? raw.inputs : raw);
          template = built.template;
          steps = built.steps;
          title = title || built.title;
        } else steps = plans.normalizeSteps(raw?.steps);
        steps = steps.map((step) => ({ capability: step.capability, params: coerce(capability(step.capability).input, step.params) }));
        return { robot: robot.id, title: title || `${steps.length} step${steps.length === 1 ? "" : "s"} on ${robot.name}`, template, steps, priority: Math.max(1, Math.min(5, Math.round(Number(raw?.priority) || 3))), startWithinMinutes: Math.max(1, Math.min(plans.START_WITHIN_MIN.max, Number(raw?.startWithinMinutes) || plans.START_WITHIN_MIN.default)) };
      },
      async assess(params, ctx) {
        const verdict = await robotics.assessPlan(ctx.db, ctx.userId, params.robot, forward(params), { identity: callerOf(ctx) });
        const flags = verdict.ok ? verdict.flags : [`forbidden:${verdict.violations.map((item) => item.message).join(" ")}`];
        return { resource: { type: "robot", id: verdict.robot.id }, account: verdict.robot.name, flags, verdict };
      },
      preview(params, _ctx, assessed) {
        const { verdict } = assessed;
        const robot = verdict.robot;
        return {
          title: `Run a plan on ${robot.name}: ${params.title}`,
          lines: [
            { label: "Robot", value: `${robot.name} — ${kindLabel(robot)}` },
            ...verdict.steps.map((step, index) => ({ label: `Step ${index + 1}`, value: `${plans.stepText(step)}${step.kind === "observation" ? " (from its report; nothing is sent)" : ""}` })),
            { label: "Risk", value: verdict.risk },
            { label: "If a step fails", value: "The plan stops. Later steps are not run and nothing is retried." },
            { label: "Starts", value: verdict.waitsFor ? `After “${verdict.waitsFor}”, if that is within ${params.startWithinMinutes} minutes; otherwise it is dropped` : "At the robot's next exchange" },
            { label: "If the link drops", value: "The robot stops by itself and the plan ends" },
          ],
          body: verdict.ok ? "Each step is checked again by the Safety Gateway at the moment it is sent, against the robot as it is then. Stopping the robot ends the plan." : verdict.violations.map((item) => item.message).join("\n"),
          warnings: verdict.warnings,
        };
      },
      async execute(params, ctx) {
        const verdict = await robotics.assessPlan(ctx.db, ctx.userId, params.robot, forward(params), { identity: callerOf(ctx) });
        if (!verdict.ok) throw fail(409, `Not started. ${verdict.violations.map((item) => item.message).join(" ")}`, "safety-refused");
        const created = await robotics.createPlan(ctx.db, ctx.userId, { robot: verdict.robot, title: params.title, template: params.template, steps: forward(params), priority: params.priority, startWithinMin: params.startWithinMinutes, actionId: ctx.record?.id });
        // Wait a moment for the robot to take the first step, so the answer says what happened rather than "queued".
        const plan = await robotics.waitForPlan(ctx.db, ctx.userId, created.id, (item) => item.status === "running" && (item.cursor > 0 || item.steps[0]?.missionId));
        if (plan.status === "failed" || plan.status === "expired") throw fail(409, plans.planText(plan, verdict.robot.name), `plan-${plan.status}`);
        return { planId: plan.id, robot: { id: verdict.robot.id, name: verdict.robot.name, kind: verdict.robot.simulated ? "simulation" : "physical" }, status: plan.status, steps: plan.steps.map((step) => ({ n: step.n, does: step.text, status: step.status })), note: plans.planText(plan, verdict.robot.name) };
      },
      async verify(response, _params, ctx) {
        const plan = await robotics.getPlan(ctx.db, ctx.userId, response.planId);
        if (plan.status === "succeeded") return { confirmed: true, evidence: plans.planText(plan, response.robot.name) };
        if (plan.status === "running") return { confirmed: true, evidence: `${plans.planText(plan, response.robot.name)} This confirms the plan started, not that it finished: read the plan for each step's result.` };
        if (plan.status === "queued") return { confirmed: true, evidence: plans.planText(plan, response.robot.name) };
        return { confirmed: false, evidence: plans.planText(plan, response.robot.name) };
      },
    };
  }
  /** The plan a request is about: the one named, or the robot's latest unfinished one, or its latest. */
  async function planOf(ctx, params, { open = false } = {}) {
    if (params.plan) {
      const plan = await robotics.getPlan(ctx.db, ctx.userId, params.plan);
      return { plan, robot: await robotics.getRobot(ctx.db, ctx.userId, plan.robotId).catch(() => null) };
    }
    const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
    const found = await robotics.listPlans(ctx.db, ctx.userId, { robotId: robot.id, limit: 20 });
    const plan = found.find((item) => item.status === "running") || found.find((item) => !item.final) || (open ? null : found[0]);
    if (!plan) throw fail(404, `${robot.name} has no ${open ? "unfinished " : ""}plan.`, "no-plan");
    return { plan, robot };
  }

  /**
   * Hand a task that didn't finish to another robot. Never automatic: a person
   * or an agent asks for it, the original mission must be over and must not
   * have succeeded, another robot is chosen and checked as for any new task
   * against its state now, and the person approves that robot by name.
   */
  function reassignAction() {
    const NOT_DONE = ["failed", "cancelled", "rejected", "expired", "timed-out", "lost", "unverified"];
    const bare = ({ from: _from, ...rest }) => rest;
    return {
      ...assign,
      id: "robots.reassign", title: "Give an unfinished task to another robot", needs: "A mission that ended without succeeding, and another robot that can take it",
      description: "Take a movement mission that failed, was cancelled, was refused, expired or was lost, and give the same task to a different robot. The other robot is chosen and checked exactly as for a new task, against its state now: connected, ready, commissioned if physical, not busy, with that destination on its own map. A mission that is still running or that succeeded can't be reassigned. Nothing is reassigned by itself.",
      input: { type: "object", properties: { mission: { type: "string", description: "The mission that didn't finish. Leave out for the robot's latest." }, robot: ROBOT, among: { type: "string", description: "Only consider this robot (name or id). Optional." } }, required: [] },
      async normalize(raw, ctx) {
        let mission;
        if (raw?.mission) mission = await robotics.getMission(ctx.db, ctx.userId, clip(raw.mission, 40));
        else {
          const from = await robotics.resolveRobot(ctx.db, ctx.userId, clip(raw?.robot, 80));
          mission = (await robotics.listMissions(ctx.db, ctx.userId, { robotId: from.id, limit: 10 })).find((item) => item.capability !== "stop_motion");
          if (!mission) throw fail(404, `${from.name} has no mission to hand on.`, "not-found");
        }
        if (!mission.final) throw fail(409, "That mission is still under way. Cancel it first, or wait for it to end.", "still-running");
        if (!NOT_DONE.includes(mission.status)) throw fail(409, "That mission succeeded; there is nothing to hand on.", "already-done");
        if (!["navigate_to", "return_to_dock", "inspect_area"].includes(mission.capability)) throw fail(400, "Only a driving task can be given to another robot.", "bad-request");
        const original = await robotics.getRobot(ctx.db, ctx.userId, mission.robotId).catch(() => null);
        // A named place is looked up on each robot's own map. Bare coordinates only mean the same spot on the same map.
        const point = ({ place, x, y }) => (place && place !== "dock" ? { place } : { x, y });
        const named = mission.capability === "inspect_area" ? (mission.params.waypoints || []).every((item) => item.place) : Boolean(mission.params.place);
        const task = mission.capability === "navigate_to" ? point(mission.params) : mission.capability === "inspect_area" ? { waypoints: (mission.params.waypoints || []).map(point) } : {};
        const chosen = await assign.normalize({ task: mission.capability, ...task, among: raw?.among, exclude: mission.robotId, ...(named || mission.capability === "return_to_dock" ? {} : { sameMapAs: original?.mapName || "" }) }, ctx);
        return { ...chosen, from: { mission: mission.id, robot: original?.name || "a removed robot", status: mission.status, reason: clip(mission.error || mission.verification?.evidence || "", 200) } };
      },
      assess: (params, ctx) => assign.assess(bare(params), ctx),
      async preview(params, ctx, assessed) {
        const base = await assign.preview(bare(params), ctx, assessed);
        return { ...base, lines: [{ label: "Instead of", value: `${params.from.robot}, whose mission ended as ${params.from.status}${params.from.reason ? `: ${params.from.reason}` : ""}` }, ...base.lines] };
      },
      async execute(params, ctx) { return { ...(await assign.execute(bare(params), ctx)), reassignedFrom: params.from }; },
      verify: (response, params, ctx) => assign.verify(response, bare(params), ctx),
    };
  }

  const assign = assignAction();
  const missions = [
    missionAction({ capabilityId: "navigate_to", title: "Drive a robot to a place", describe: (sent) => `drives to ${pointText(sent)}` }),
    missionAction({ capabilityId: "return_to_dock", title: "Send a robot to its dock", describe: (sent) => `returns to its dock at (${round(sent.x)}, ${round(sent.y)})` }),
    missionAction({ capabilityId: "inspect_area", title: "Have a robot visit points and report", describe: (sent) => `visits ${sent.waypoints.length} point${sent.waypoints.length === 1 ? "" : "s"}: ${sent.waypoints.map(pointText).join(", ")}` }),
    missionAction({ capabilityId: "set_supported_device_state", title: "Switch a robot's onboard device", describe: (sent) => `switches its ${sent.device} ${sent.state}` }),
    missionAction({ capabilityId: "move_robot_arm", title: "Move a robot arm", describe: (sent) => `moves its arm to ${sent.place ? `${sent.place} (${round(sent.x, 3)}, ${round(sent.y, 3)})` : `(${round(sent.x, 3)}, ${round(sent.y, 3)})`}` }),
    missionAction({ capabilityId: "grasp_object", title: "Grasp an object with a robot arm", describe: (sent) => `closes its gripper on the ${sent.object}` }),
    missionAction({ capabilityId: "release_object", title: "Release what a robot arm holds", describe: () => "opens its gripper" }),
    missionAction({ capabilityId: "capture_image", title: "Take a picture with a robot's camera", describe: (sent) => `takes one picture with its ${sent.camera || "camera"}` }),
  ];
  return [
    readAction({
      id: "robots.list", title: "List robots", description: "Every robot enrolled in the account: whether it is a simulation or physical, whether it is connected, what it can do and the places it knows.", input: {},
      run: async (_params, ctx) => ({ robots: (await robotics.listRobots(ctx.db, ctx.userId)).map(summary) }),
    }),
    readAction({
      id: "robots.state", title: "Report a robot's state", description: capability("report_robot_state").description, input: { robot: ROBOT },
      run: async (params, ctx) => stateOf(await robotics.resolveRobot(ctx.db, ctx.userId, params.robot)),
    }),
    readAction({
      id: "robots.read_sensor", title: "Read a robot's sensor", description: capability("read_sensor").description, input: { robot: ROBOT, sensor: { type: "string", description: "The sensor's id, for example lidar." } },
      run: async (params, ctx) => {
        const verdict = await robotics.assess(ctx.db, ctx.userId, params.robot, "read_sensor", { sensor: params.sensor });
        if (!verdict.ok) throw fail(400, verdict.violations.map((item) => item.message).join(" "), "safety-refused");
        const reading = verdict.robot.state?.sensors?.[params.sensor];
        if (reading === undefined || reading === null) throw fail(409, `${verdict.robot.name} hasn't reported a reading for ${params.sensor} yet.`, "no-reading");
        return { robot: verdict.robot.name, sensor: params.sensor, online: verdict.robot.online, stale: !verdict.robot.online, ageS: verdict.robot.stateAgeS, reading };
      },
    }),
    readAction({
      id: "robots.mission", title: "Check a robot mission", description: "The status and result of a mission: whether the robot accepted it, how far along it is, and how the result was verified. Without a mission id, the robot's most recent one.", input: { mission: { type: "string", description: "The mission id." }, robot: ROBOT },
      run: async (params, ctx) => {
        let mission;
        if (params.mission) mission = await robotics.getMission(ctx.db, ctx.userId, params.mission);
        else {
          const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
          mission = (await robotics.listMissions(ctx.db, ctx.userId, { robotId: robot.id, limit: 1 }))[0];
          if (!mission) throw fail(404, `${robot.name} has no missions yet.`, "not-found");
        }
        const robot = await robotics.getRobot(ctx.db, ctx.userId, mission.robotId).catch(() => null);
        return { ...mission, robot: robot ? { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical", online: robot.online } : null, summary: missionText(mission, robot?.name) };
      },
    }),
    readAction({
      id: "robots.fleet", title: "Show the fleet", description: "Every robot with its connection, health, battery, position, current mission and whether it can take a task now, with the reason when it can't.", input: {},
      run: async (_params, ctx) => {
        const [robots, active] = await Promise.all([robotics.listRobots(ctx.db, ctx.userId), robotics.listMissions(ctx.db, ctx.userId, { active: true, limit: 100 })]);
        const rows = fleet.overview(robots, active);
        return { robots: rows, available: rows.filter((row) => row.available).map((row) => row.name), needAttention: rows.filter((row) => row.health === "attention").map((row) => row.name), note: "A robot that is offline shows no battery or position: its last report is not the present." };
      },
    }),
    {
      ...readAction({
        id: "robots.analytics", title: "Report fleet figures", description: "Figures from stored records for the last days (7 by default, at most 30): missions started and how they ended, the share verified as succeeded, how long missions took, command latency, how busy each robot was, problems recorded, and battery change over the last two hours. Each figure says how many records it came from and is empty when there are none.", input: { days: { type: "number", description: "How many days back. Default 7." } },
        run: async (params, ctx) => robotics.analytics(ctx.db, ctx.userId, { days: params.days }),
      }),
      normalize: (raw) => ({ days: Math.max(1, Math.min(30, Number(raw?.days) || 7)) }),
      verify: () => ({ confirmed: true, evidence: "Computed from stored mission, plan, event and telemetry records." }),
    },
    readAction({
      id: "robots.diagnostics", title: "Diagnose a robot", description: "What the evidence says about one robot's condition: sensors not reporting, faults, battery, link losses, refused commands, missions that didn't finish, software versions, the last maintenance entry. Findings come from what the robot reported and what was recorded; nothing is guessed.", input: { robot: ROBOT },
      run: async (params, ctx) => {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const [events, missions, maintenance] = await Promise.all([robotics.events(ctx.db, ctx.userId, { robotId: robot.id, limit: 200 }), robotics.listMissions(ctx.db, ctx.userId, { robotId: robot.id, limit: 30 }), robotics.maintenance(ctx.db, ctx.userId, robot.id, 5)]);
        return fleet.diagnose(robot, { events, missions, maintenance, now: ctx.now() });
      },
    }),
    readAction({
      id: "robots.battery", title: "Report a robot's battery", description: capability("report_battery_state").description, input: { robot: ROBOT },
      run: async (params, ctx) => {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const battery = robot.state?.battery;
        if (!battery || typeof battery.percent !== "number") throw fail(409, `${robot.name} hasn't reported a battery reading${(robot.sensors || []).some((sensor) => sensor.id === "battery") ? " yet" : ": it has no battery sensor registered"}.`, "no-reading");
        return { robot: robot.name, online: robot.online, stale: !robot.online, ageS: robot.stateAgeS, percent: battery.percent, charging: Boolean(battery.charging), minimumToStartPercent: robot.limits.minBatteryPercent ?? null, source: "the robot's battery sensor" };
      },
    }),
    readAction({
      id: "robots.surroundings", title: "Report what is around a robot", description: capability("report_surroundings").description, input: { robot: ROBOT },
      run: async (params, ctx) => {
        const verdict = await robotics.assess(ctx.db, ctx.userId, params.robot, "report_surroundings", {});
        if (!verdict.ok) throw fail(400, verdict.violations.map((item) => item.message).join(" "), "safety-refused");
        const perception = verdict.robot.state?.perception;
        if (!perception) throw fail(409, `${verdict.robot.name} hasn't reported what its sensors detect yet.`, "no-reading");
        return { robot: verdict.robot.name, kind: verdict.robot.simulated ? "simulation" : "physical", online: verdict.robot.online, stale: !verdict.robot.online, ageS: verdict.robot.stateAgeS, position: verdict.robot.state.pose ?? null, ...perception, note: "These are sensor measurements with their source. Nothing here was inferred by a language model." };
      },
    }),
    readAction({
      id: "robots.arm_state", title: "Report a robot arm's state", description: "An arm's own report: where its tool is (computed from its joint encoders), each joint's angle and speed, what its gripper holds, the named poses it registered (its safe pose is the one called home, when it has one), and the objects it reports with their positions. The answer says how old it is.", input: { robot: ROBOT },
      run: async (params, ctx) => {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        if (!robot.capabilities.includes("move_robot_arm")) throw fail(409, `${robot.name} has no arm.`, "no-arm");
        const state = robot.state;
        if (!state) throw fail(409, `${robot.name} hasn't reported its state yet.`, "no-reading");
        const joints = state.sensors?.joint_encoders;
        const poses = Object.fromEntries(Object.entries(robot.places || {}).map(([name, point]) => [name, { x: point.x, y: point.y }]));
        return {
          robot: robot.name, kind: robot.simulated ? "simulation" : "physical", online: robot.online, stale: !robot.online, ageS: robot.stateAgeS,
          note: robot.online ? "Current: reported in the last few seconds." : `Not current: ${robot.name} is offline; this is its last report.`,
          mode: state.mode ?? null, tool: state.pose ?? null, moving: Math.abs(Number(state.velocity?.angular) || 0) > 0.02,
          joints: joints && joints.ok !== false ? { positions: joints.positions ?? null, speeds: joints.speeds ?? null, unit: joints.unit || "rad", measuredAt: joints.measuredAt ?? null, source: joints.source || null } : null,
          gripper: state.gripper ?? null, target: state.arm?.target ?? null, emergencyStop: state.estop ?? null, faults: state.faults ?? [],
          namedPoses: poses, safePose: Object.keys(poses).find((name) => name.toLowerCase() === "home") || null,
          objects: state.scene?.objects ?? [], objectsSource: state.scene?.source ?? null,
        };
      },
    }),
    readAction({
      id: "robots.camera", title: "Report what a robot's camera last saw", description: "The most recent picture a robot took on request: when, with which camera and frame, and the coloured regions a detector found, each with its confidence and, when the camera has depth, a distance and position. The answer says how old the picture is; an old picture is not what the robot sees now. It never says what an object is. Reading this is not viewing the picture.", input: { robot: ROBOT },
      run: async (params, ctx) => {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const { camera, images } = await robotics.listImages(ctx.db, ctx.userId, robot.id, 1);
        if (!camera.cameras.length) throw fail(409, `${robot.name} has no camera registered.`, "no-camera");
        const latest = images[0];
        if (!latest) return { robot: robot.name, kind: robot.simulated ? "simulation" : "physical", cameraUse: camera.enabled ? "on" : "off", picture: null, note: camera.enabled ? `${robot.name} has no stored picture. Take one with robots.capture_image.` : `Camera use is switched off for ${robot.name}, and it has no stored picture.` };
        const ageS = Math.max(0, Math.round((ctx.now() - latest.capturedAt) / 1000));
        return {
          robot: robot.name, kind: latest.kind, cameraUse: camera.enabled ? "on" : "off", imageId: latest.id, sensor: latest.sensor, frame: latest.frame, capturedAt: latest.capturedAt, ageS, stale: ageS > 30,
          takenFrom: latest.pose, source: latest.source, depth: latest.depth, detector: latest.detector, detections: latest.detections,
          note: `${ageS > 30 ? `This picture is ${ageS >= 120 ? `${Math.round(ageS / 60)} minutes` : `${ageS} seconds`} old: it is what the camera saw then, not what is there now. ` : ""}The detector finds regions of colour; it cannot say what an object is.${latest.kind === "simulation" ? " The camera is simulated." : ""}`,
        };
      },
    }),
    readAction({
      id: "robots.destinations", title: "List a robot's destinations", description: "The named destinations a robot can be sent to, each with its map, coordinate frame, position and who defined it. A name is usable only when it is on this list.", input: { robot: ROBOT },
      run: async (params, ctx) => {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        return { robot: robot.name, ...(await robotics.listDestinations(ctx.db, ctx.userId, robot.id)) };
      },
    }),
    ...missions,
    {
      id: "robots.stop_motion", service: "robots", kind: "write", deescalates: true, title: "Stop a robot", description: capability("stop_motion").description, needs: "A robot enrolled under Robots",
      input: { type: "object", properties: { robot: ROBOT, reason: { type: "string" } }, required: [] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), reason: clip(raw?.reason, 200) }),
      async assess(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        return { resource: { type: "robot", id: robot.id }, account: robot.name, robot };
      },
      preview: (_params, _ctx, assessed) => ({
        title: `Stop ${assessed.robot.name}`,
        lines: [{ label: "Robot", value: `${assessed.robot.name} — ${kindLabel(assessed.robot)}` }, { label: "Approval", value: "Never needed: stopping is always allowed" }],
        warnings: assessed.robot.simulated ? [] : ["This is a software request to the robot's controller, not an emergency stop. In danger, use the robot's own emergency stop."],
      }),
      async execute(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const queued = await robotics.stop(ctx.db, ctx.userId, robot, { reason: params.reason, actionId: ctx.record?.id, identity: callerOf(ctx) });
        const mission = robot.online ? await robotics.waitFor(ctx.db, ctx.userId, queued.id, (item) => item.final) : queued;
        return { missionId: mission.id, robot: { id: robot.id, name: robot.name, online: robot.online, linkTimeoutS: robot.limits.linkTimeoutS ?? null }, status: mission.status, note: missionText(mission, robot.name) };
      },
      async verify(response, _params, ctx) {
        const mission = await robotics.getMission(ctx.db, ctx.userId, response.missionId);
        if (mission.status === "succeeded") return { confirmed: true, evidence: mission.verification?.evidence || "The robot reported it stopped." };
        if (!response.robot.online) return { confirmed: false, evidence: `${response.robot.name} is offline, so the stop couldn't be delivered. A robot that loses its link to HANNAH stops by itself${response.robot.linkTimeoutS ? ` within ${response.robot.linkTimeoutS} seconds` : ""}; HANNAH can't see whether it has.` };
        return { confirmed: false, evidence: missionText(mission, response.robot.name) };
      },
    },
    {
      // Safety Stop only reduces what happens: allowed at every level and during the emergency stop, never asks.
      id: "robots.safety_stop", service: "robots", kind: "write", deescalates: true, title: "Put a robot in Safety Stop", description: "Stop the robot through its stop mechanism and hold it in the Safety Stop operating mode: every plan and mission ends, it takes nothing but stops and reads, and only a signed-in person can move it out. A software state, not an emergency stop: the robot's own emergency stop stays the way to stop it in danger.", needs: "A robot enrolled under Robots",
      input: { type: "object", properties: { robot: ROBOT, reason: { type: "string" } }, required: [] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), reason: clip(raw?.reason, 200) }),
      async assess(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        return { resource: { type: "robot", id: robot.id }, account: robot.name, robot };
      },
      preview: (_params, _ctx, assessed) => ({ title: `Safety Stop: ${assessed.robot.name}`, lines: [{ label: "Robot", value: `${assessed.robot.name} — ${kindLabel(assessed.robot)}` }, { label: "Approval", value: "Never needed" }, { label: "Leaving it", value: "Only a signed-in person, with the emergency stop released" }], warnings: assessed.robot.simulated ? [] : ["This is software. In danger, use the robot's own emergency stop."] }),
      async execute(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const view = await robotics.manager.setMode(ctx.db, ctx.userId, robot.id, "safety_stop", { actor: ctx.record?.agent || "an agent", reason: params.reason, source: callerOf(ctx).source });
        return { robot: { id: robot.id, name: robot.name, online: robot.online }, mode: view.mode, confirmed: view.confirmed, note: `${robot.name} is in Safety Stop. ${robot.online ? "The stop was sent." : "It is offline; a robot that loses its link stops by itself."}` };
      },
      async verify(response, _params, ctx) {
        const robot = await robotics.getRobot(ctx.db, ctx.userId, response.robot.id);
        if (robot.operatingMode !== "safety_stop") return { confirmed: false, evidence: `${robot.name} is in ${robot.operatingMode}.` };
        return robot.reportedOperatingMode?.mode === "safety_stop" ? { confirmed: true, evidence: `${robot.name} reports it is in Safety Stop.` } : { confirmed: false, evidence: `HANNAH holds ${robot.name} in Safety Stop; the robot hasn't confirmed it yet.` };
      },
    },
    {
      // Any other mode change is a safety-configuration change: always a person's approval, never a standing permission.
      id: "robots.set_mode", service: "robots", kind: "write", standing: false, title: "Change a robot's operating mode", description: "Change a robot's operating mode (manual, assisted, supervised, mission, maintenance) by the allowed-transition table. Restoring autonomy is checked first: the robot must be connected, still, released, without faults, inside its operating area and commissioned if physical. Always needs a person's approval.", needs: "A robot enrolled under Robots, connected",
      input: { type: "object", properties: { robot: ROBOT, mode: { type: "string", enum: ["manual", "assisted", "supervised", "mission", "maintenance"] }, reason: { type: "string" } }, required: ["mode"] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), mode: clip(raw?.mode, 20), reason: clip(raw?.reason, 200) }),
      async assess(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const option = (await robotics.manager.transitionsFor(ctx.db, robot)).find((item) => item.to === params.mode);
        const reasons = option ? option.reasons : [{ message: `“${params.mode}” isn't an operating mode, or ${robot.name} is already in it.` }];
        return { resource: { type: "robot", id: robot.id }, account: robot.name, robot, option, flags: reasons.length ? [`forbidden:${reasons.map((item) => item.message).join(" ")}`] : [] };
      },
      preview: (params, _ctx, assessed) => ({ title: `Operating mode: ${assessed.robot.name} → ${assessed.option?.label || params.mode}`, lines: [{ label: "Robot", value: `${assessed.robot.name} — ${kindLabel(assessed.robot)}` }, { label: "From", value: assessed.robot.operatingMode }, { label: "Reason", value: params.reason || "none given" }], body: (assessed.option?.reasons || []).map((item) => item.message).join("\n") || "Approve to change it. The robot confirms the change itself." }),
      async execute(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const context = await robotics.manager.chainContext(ctx.db, ctx.userId, robot, { stage: "execute", authorization: { kind: "action-record", recordId: ctx.record?.id } });
        if (!context.authorization?.approved) throw fail(403, "A person has to approve an operating-mode change.", "approval-required");
        const view = await robotics.manager.setMode(ctx.db, ctx.userId, robot.id, params.mode, { actor: `${ctx.record?.agent || "an agent"}, approved by a person`, person: true, reason: params.reason, source: callerOf(ctx).source });
        return { robot: { id: robot.id, name: robot.name }, mode: view.mode, note: `${robot.name} is now in ${view.label}; waiting for the robot to confirm.` };
      },
      async verify(response, _params, ctx) {
        const robot = await robotics.getRobot(ctx.db, ctx.userId, response.robot.id);
        return robot.reportedOperatingMode?.mode === robot.operatingMode && robot.operatingMode === response.mode ? { confirmed: true, evidence: `${robot.name} reports ${robot.operatingMode}.` } : { confirmed: false, evidence: `HANNAH set ${response.mode}; ${robot.name} hasn't confirmed it yet.` };
      },
    },
    assign,
    reassignAction(),
    planAction(),
    readAction({
      id: "robots.plan", title: "Check a robot plan", description: "A plan's status and every step's outcome: what was sent, what the robot reported, how it was verified, what an observation recorded, and which steps were not run. Without a plan id, the robot's current or latest plan.", input: { plan: { type: "string", description: "The plan id." }, robot: ROBOT },
      run: async (params, ctx) => {
        const { plan, robot } = await planOf(ctx, params);
        return { ...plan, robot: robot ? { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical", online: robot.online } : null, summary: plans.planText(plan, robot?.name) };
      },
    }),
    readAction({
      id: "robots.templates", title: "List plan templates for a robot", description: "The plan templates and whether this robot can run each one. A template that needs hardware the robot doesn't have is listed as unavailable, with the reason.", input: { robot: ROBOT },
      run: async (params, ctx) => {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        return { robot: robot.name, kind: robot.simulated ? "simulation" : "physical", templates: plans.templatesFor(robot), note: robot.simulated ? "Run one with robots.run_plan and its inputs." : "Plans of several steps run on simulated robots only; a physical robot's movements are approved one at a time." };
      },
    }),
    {
      id: "robots.cancel_plan", service: "robots", kind: "write", deescalates: true, title: "Cancel a robot's plan", description: "Cancel a plan. One that is waiting is dropped; one that is running has its current step cancelled on the robot, which then holds, and the remaining steps are not run. Never needs approval.", needs: "A plan that isn't finished",
      input: { type: "object", properties: { robot: ROBOT, plan: { type: "string", description: "The plan id. Leave out for the robot's current plan." } }, required: [] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), plan: clip(raw?.plan, 40) }),
      async assess(params, ctx) {
        const { plan, robot } = await planOf(ctx, params, { open: true });
        return { resource: { type: "robot", id: plan.robotId }, account: robot?.name || "", robot, plan };
      },
      preview: (_params, _ctx, assessed) => ({ title: `Cancel the plan “${assessed.plan.title}”`, lines: [{ label: "Robot", value: assessed.robot ? `${assessed.robot.name} — ${kindLabel(assessed.robot)}` : "removed" }, { label: "Approval", value: "Never needed" }] }),
      async execute(params, ctx) {
        const { plan, robot } = await planOf(ctx, params, { open: true });
        const after = await robotics.cancelPlan(ctx.db, ctx.userId, plan.id);
        const current = plan.steps[plan.cursor];
        const mission = current?.missionId && robot?.online ? await robotics.waitFor(ctx.db, ctx.userId, current.missionId, (item) => item.final) : null;
        return { planId: after.id, robot: { id: plan.robotId, name: robot?.name || "", online: Boolean(robot?.online) }, status: after.status, missionId: current?.missionId || null, missionStatus: mission?.status || null, note: `${plans.planText(after, robot?.name)}${mission ? ` ${missionText(mission, robot.name)}` : ""}` };
      },
      async verify(response, _params, ctx) {
        const plan = await robotics.getPlan(ctx.db, ctx.userId, response.planId);
        if (plan.status !== "cancelled") return { confirmed: false, evidence: plans.planText(plan, response.robot.name) };
        if (!response.missionId) return { confirmed: true, evidence: "The plan was dropped before any step was sent." };
        const mission = await robotics.getMission(ctx.db, ctx.userId, response.missionId);
        if (mission.final) return { confirmed: true, evidence: `The plan is cancelled and its step in hand ended: ${missionText(mission, response.robot.name)}` };
        return { confirmed: false, evidence: response.robot.online ? `The plan is cancelled; ${response.robot.name} hasn't confirmed that it stopped the step in hand yet.` : `The plan is cancelled. ${response.robot.name} is offline, so the cancel for its step in hand couldn't be delivered; a robot that loses its link to HANNAH stops by itself.` };
      },
    },
    control({ id: "robots.cancel_mission", capabilityId: "cancel_mission", title: "Cancel a robot's mission", verb: "Cancel", act: (db, userId, missionId) => robotics.cancelMission(db, userId, missionId), settled: (item) => item.final, good: ["cancelled"] }),
    control({ id: "robots.pause_mission", capabilityId: "pause_mission", title: "Pause a robot's mission", verb: "Pause", act: (db, userId, missionId) => robotics.pauseMission(db, userId, missionId), settled: (item) => item.status === "paused" || item.final, good: ["paused"] }),
    {
      id: "robots.resume_mission", service: "robots", kind: "write", title: "Resume a robot's paused mission", description: capability("resume_mission").description, needs: "A paused mission",
      input: { type: "object", properties: { robot: ROBOT, mission: { type: "string", description: "The mission id. Leave out for the robot's paused mission." } }, required: [] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), mission: clip(raw?.mission, 40) }),
      async assess(params, ctx) {
        const { robot, mission } = await target(ctx, params, (item) => item.status === "paused", "paused");
        const verdict = await resumeCheck(ctx, robot, mission);
        return { resource: { type: "robot", id: robot.id }, account: robot.name, flags: verdict.ok ? verdict.flags : [`forbidden:${verdict.violations.map((item) => item.message).join(" ")}`], verdict, mission, robot };
      },
      preview: (_params, _ctx, assessed) => ({
        title: `Resume: ${assessed.robot.name} carries on with “${assessed.mission.title}”`,
        lines: [{ label: "Robot", value: `${assessed.robot.name} — ${kindLabel(assessed.robot)}` }, { label: "Mission", value: `${assessed.mission.title}, paused` }, { label: "Checked", value: assessed.verdict.ok ? "Robot ready, goal still inside its limits" : "Refused by the Safety Gateway" }],
        body: assessed.verdict.ok ? "The robot starts moving again from where it stands. The resume is valid for 20 seconds and works once." : assessed.verdict.violations.map((item) => item.message).join("\n"),
        warnings: assessed.verdict.warnings,
      }),
      async execute(params, ctx) {
        const { robot, mission } = await target(ctx, params, (item) => item.status === "paused", "paused");
        const verdict = await resumeCheck(ctx, robot, mission, "execute");
        if (!verdict.ok) throw fail(409, `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`, "safety-refused");
        await robotics.resumeMission(ctx.db, ctx.userId, mission.id, { verdict });
        const after = await robotics.waitFor(ctx.db, ctx.userId, mission.id, (item) => item.status !== "paused" || !item.resumeRequestedAt);
        if (after.status === "paused" && after.error) throw fail(409, `${robot.name} didn't resume. ${after.error}`, "resume-refused");
        return { missionId: mission.id, robot: { id: robot.id, name: robot.name }, status: after.status, note: missionText(after, robot.name) };
      },
      async verify(response, _params, ctx) {
        const mission = await robotics.getMission(ctx.db, ctx.userId, response.missionId);
        if (mission.status === "accepted" || mission.status === "succeeded") return { confirmed: true, evidence: `${response.robot.name} reported that it resumed mission ${mission.id}. This confirms it is moving again, not that it arrived.` };
        return { confirmed: false, evidence: missionText(mission, response.robot.name) };
      },
    },
  ];
}

module.exports = { missionText, robotActions };
