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

const kindLabel = (robot) => (robot.simulated ? `SIMULATION (${robot.simulator || "simulator"})` : "PHYSICAL ROBOT");
const pointText = (point) => (point.place ? `${point.place} (${round(point.x)}, ${round(point.y)})` : `(${round(point.x)}, ${round(point.y)})`);

/** One honest sentence about a mission. */
function missionText(mission, robotName = "The robot") {
  const what = mission.title || mission.capability;
  switch (mission.status) {
    case "queued": return `${what}: waiting to be delivered to ${robotName}. Nothing has moved.`;
    case "sent": return `${what}: delivered; ${robotName} hasn't accepted it yet. Nothing has moved.`;
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
      id: `robots.${capabilityId}`, service: "robots", kind: "write", title, description: definition.description, needs: "A robot enrolled under Robots, connected",
      input: { type: "object", properties: { robot: ROBOT, ...definition.input.properties }, required: definition.input.required || [] },
      normalize: (raw) => ({ robot: clip(raw.robot, 80), ...coerce(definition.input, Object.fromEntries(Object.entries(raw || {}).filter(([key]) => key !== "robot" && Object.hasOwn(definition.input.properties, key)))) }),
      async assess(params, ctx) {
        const verdict = await robotics.assess(ctx.db, ctx.userId, params.robot, capabilityId, inputOf(params));
        const flags = verdict.ok ? verdict.flags : [`forbidden:${verdict.violations.map((item) => item.message).join(" ")}`];
        return { resource: { type: "robot", id: verdict.robot.id }, account: verdict.robot.name, flags, verdict };
      },
      preview(params, _ctx, assessed) {
        const { verdict } = assessed;
        const robot = verdict.robot;
        return {
          title: `Start a mission: ${robot.name} ${describe(verdict.params, robot)}`,
          lines: [
            { label: "Robot", value: `${robot.name} — ${kindLabel(robot)}` },
            ...(verdict.params.maxSpeed !== undefined ? [{ label: "Speed limit", value: `${round(verdict.params.maxSpeed)} m/s` }] : []),
            { label: "Risk", value: verdict.risk },
            { label: "Checked", value: verdict.ok ? "Inside the workspace, outside keep-out zones, robot ready" : "Refused by the Safety Gateway" },
            { label: "If the link drops", value: "The robot stops by itself" },
          ],
          body: verdict.ok ? `The robot's own planner drives it; HANNAH sends the goal, not wheel commands. The command is valid for ${Math.round(verdict.limits?.commandTtlS ?? 20)} seconds after it is sent.` : verdict.violations.map((item) => item.message).join("\n"),
          warnings: verdict.warnings,
        };
      },
      async execute(params, ctx) {
        const verdict = await robotics.assess(ctx.db, ctx.userId, params.robot, capabilityId, inputOf(params));
        if (!verdict.ok) throw fail(409, `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`, "safety-refused");
        const queued = await robotics.dispatch(ctx.db, ctx.userId, { robot: verdict.robot, capabilityId, params: verdict.params, actionId: ctx.record?.id });
        const mission = await robotics.waitFor(ctx.db, ctx.userId, queued.id, (item) => item.status !== "queued" && item.status !== "sent");
        if (["rejected", "failed", "timed-out", "expired", "lost", "cancelled"].includes(mission.status)) throw fail(409, missionText(mission, verdict.robot.name), `mission-${mission.status}`);
        return { missionId: mission.id, robot: { id: verdict.robot.id, name: verdict.robot.name, kind: verdict.robot.simulated ? "simulation" : "physical" }, status: mission.status, sent: verdict.params, note: missionText(mission, verdict.robot.name) };
      },
      async verify(response, _params, ctx) {
        const mission = await robotics.getMission(ctx.db, ctx.userId, response.missionId);
        if (mission.status === "succeeded") return { confirmed: true, evidence: `Mission ${mission.id} already finished. ${mission.verification?.evidence || ""}`.trim() };
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
    mode: robot.state?.mode ?? null, pose: robot.state?.pose ?? null, velocity: robot.state?.velocity ?? null, battery: robot.state?.battery ?? null, emergencyStop: robot.state?.estop ?? null, motorsEnabled: robot.state?.motorsEnabled ?? null,
    localized: robot.state?.localized ?? null, faults: robot.state?.faults ?? [], mission: robot.state?.mission ?? null, devices: robot.state?.devices ?? null,
  });

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
    missionAction({ capabilityId: "navigate_to", title: "Drive a robot to a place", describe: (sent) => `drives to ${pointText(sent)}` }),
    missionAction({ capabilityId: "return_to_dock", title: "Send a robot to its dock", describe: (sent) => `returns to its dock at (${round(sent.x)}, ${round(sent.y)})` }),
    missionAction({ capabilityId: "inspect_area", title: "Have a robot visit points and report", describe: (sent) => `visits ${sent.waypoints.length} point${sent.waypoints.length === 1 ? "" : "s"}: ${sent.waypoints.map(pointText).join(", ")}` }),
    missionAction({ capabilityId: "set_supported_device_state", title: "Switch a robot's onboard device", describe: (sent) => `switches its ${sent.device} ${sent.state}` }),
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
        const queued = await robotics.stop(ctx.db, ctx.userId, robot, { reason: params.reason, actionId: ctx.record?.id });
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
  ];
}

module.exports = { missionText, robotActions };
