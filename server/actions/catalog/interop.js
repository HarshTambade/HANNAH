"use strict";

/**
 * Normalized missions as Action Engine actions, for every interop adapter.
 *
 * interop.mission goes through the same chain as every robot movement:
 * identity and the account's permission level (the engine), the adapter's
 * negotiation and safety checks in assess() (a refusal is "forbidden" and is
 * never shown for approval), approval (a physical robot's movement always
 * asks; high-risk contract capabilities never take a standing permission),
 * then execute(), which runs the checks again because the robot may have
 * changed while the approval waited. A model can only call this action; it
 * can't skip any step of it.
 *
 * Stopping and asking for help (interop.request_assistance) and cancelling
 * de-escalate: they never need approval. Reading status is a read.
 */
const capability = require("../../interop/capability");

const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const ROBOT = { type: "string", description: "The robot's or vehicle's id or name, from any adapter." };
const MOTION_TYPES = Object.entries(capability.MISSIONS).filter(([, item]) => item.motion).map(([id]) => id);
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

/** Keep only the inputs a mission takes, with numbers that arrived as text made numbers. */
function cleanParams(type, raw = {}) {
  const definition = capability.MISSIONS[type];
  if (!definition) return {};
  const out = {};
  for (const [key, kind] of Object.entries(definition.input)) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    if (kind === "number") out[key] = typeof value === "string" && Number.isFinite(Number(value)) ? Number(value) : value;
    else if (kind === "string") out[key] = clip(value, 120);
    else out[key] = value;
  }
  return out;
}

function interopActions({ interop }) {
  if (!interop) return [];
  const describe = (type, params, robot) => {
    const where = params.place || (Number.isFinite(params.x) ? `(${params.x}, ${params.y})` : "") || (params.waypoints ? `${params.waypoints.length} points` : "") || (params.to ? "from → to" : "");
    return `${capability.MISSIONS[type]?.title || type}: ${robot?.name || "robot"}${where ? ` ${where}` : ""}`;
  };
  return [
    {
      id: "interop.mission", service: "robots", kind: "write", title: "Send a mission to a robot (any adapter)",
      description: `Send a normalized mission (${MOTION_TYPES.join(", ")}) to a robot on HANNAH's link or a VDA 5050 vehicle. The robot's adapter checks it can and may do it first.`,
      needs: "A robot under Robots or a registered VDA 5050 vehicle, reporting",
      input: { type: "object", properties: { robot: ROBOT, mission: { type: "string", enum: MOTION_TYPES }, params: { type: "object" } }, required: ["robot", "mission"] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), mission: clip(raw?.mission, 40), params: cleanParams(clip(raw?.mission, 40), raw?.params || {}) }),
      async assess(params, ctx) {
        if (!MOTION_TYPES.includes(params.mission)) return { flags: [`forbidden:“${params.mission}” isn't a mission this action sends. Missions are: ${MOTION_TYPES.join(", ")}.`] };
        const verdict = await interop.assess(ctx.db, ctx.userId, params.robot, params.mission, params.params);
        const flags = verdict.ok ? [...(verdict.flags || []), ...(verdict.robot.kind === "physical" ? ["a physical robot will move"] : [])] : [`forbidden:${verdict.violations.map((item) => item.message).join(" ")}`];
        return { resource: { type: "robot", id: verdict.robot.id }, account: verdict.robot.name, flags: [...new Set(flags)], verdict };
      },
      preview(params, _ctx, assessed) {
        const { verdict } = assessed;
        if (!verdict) return { title: "Send a mission", lines: [], body: "Not a mission this action sends." };
        return {
          title: describe(params.mission, params.params, verdict.robot),
          lines: [
            { label: "Robot", value: `${verdict.robot.name} — ${verdict.robot.kind === "simulation" ? "SIMULATION" : "PHYSICAL"} (${verdict.robot.identity.protocol})` },
            { label: "Mission", value: capability.MISSIONS[params.mission]?.title || params.mission },
            ...(verdict.plan?.maxSpeed ? [{ label: "Speed limit", value: `${verdict.plan.maxSpeed} m/s` }] : []),
            { label: "Checked", value: verdict.ok ? "Supported, robot ready, inside its limits" : "Refused" },
          ],
          body: verdict.ok ? "The robot's own controller drives it; HANNAH sends the goal. The checks run again just before it is sent." : verdict.violations.map((item) => item.message).join("\n"),
          warnings: verdict.warnings || [],
        };
      },
      async execute(params, ctx) {
        const mission = await interop.submit(ctx.db, ctx.userId, params.robot, params.mission, params.params, { actionId: ctx.record?.id, identity: { source: ctx.record?.source || ctx.caller?.source || "chat", actor: ctx.record?.agent || ctx.caller?.agent || "" } });
        if (["rejected", "failed", "expired", "lost", "cancelled"].includes(mission.status)) throw fail(409, `${mission.title}: ${mission.status}. ${mission.error || mission.evidence || ""}`.trim(), `mission-${mission.status}`);
        return { missionId: mission.id, adapter: mission.adapter, status: mission.status, note: `${mission.title}: ${mission.status}.` };
      },
      async verify(response, _params, ctx) {
        const mission = await interop.getMission(ctx.db, ctx.userId, response.missionId);
        if (mission.status === "succeeded") return { confirmed: true, evidence: mission.evidence || "The robot reported the mission done and its state confirms it." };
        if (["accepted", "paused"].includes(mission.status)) return { confirmed: true, evidence: `The robot took mission ${mission.id} and is working on it. This confirms the start, not the result.` };
        return { confirmed: false, evidence: `Mission ${mission.id} is ${mission.status}. ${mission.evidence || mission.error || ""}`.trim() };
      },
    },
    {
      id: "interop.request_assistance", service: "robots", kind: "write", deescalates: true, title: "Stop a robot and ask a person for help",
      description: "Make the robot hold where it is (HANNAH link: stop; VDA 5050: startPause) and record that a person is needed. Never needs approval: it only stops motion. Not an emergency stop.",
      needs: "A robot or vehicle",
      input: { type: "object", properties: { robot: ROBOT, reason: { type: "string" } }, required: ["robot"] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), reason: clip(raw?.reason, 300) }),
      async assess(params, ctx) { const { robot } = await interop.resolve(ctx.db, ctx.userId, params.robot); return { resource: { type: "robot", id: robot.id }, account: robot.name, flags: [] }; },
      preview: (params) => ({ title: `Stop and ask for help: ${params.robot}`, lines: [{ label: "Reason", value: params.reason || "none given" }], body: "A software request to hold. The robot's physical emergency stop is separate." }),
      async execute(params, ctx) { return interop.requestAssistance(ctx.db, ctx.userId, params.robot, { reason: params.reason }); },
      async verify(response) { return { confirmed: Boolean(response?.sent), evidence: response?.note || "" }; },
    },
    {
      id: "interop.cancel_mission", service: "robots", kind: "write", deescalates: true, title: "Cancel a robot's mission (any adapter)",
      description: "Cancel a normalized mission. The robot stops as soon as it can. Never needs approval.",
      needs: "A mission that isn't finished",
      input: { type: "object", properties: { mission: { type: "string" } }, required: ["mission"] },
      normalize: (raw) => ({ mission: clip(raw?.mission, 60) }),
      preview: (params) => ({ title: `Cancel mission ${params.mission}`, lines: [] }),
      async execute(params, ctx) { const mission = await interop.cancel(ctx.db, ctx.userId, params.mission); return { missionId: mission.id, status: mission.status }; },
      async verify(response) { return { confirmed: ["cancelled", "succeeded", "failed", "rejected", "expired", "lost", "unverified"].includes(response.status), evidence: `The mission is ${response.status}.` }; },
    },
    {
      id: "interop.report_status", service: "robots", kind: "read", title: "Report a robot's status (any adapter)",
      description: "The robot's normalized state: connection, battery, position, mode, mission, diagnostics with the vendor's own errors. Says how old the report is.",
      needs: "A robot or vehicle",
      input: { type: "object", properties: { robot: ROBOT }, required: ["robot"] },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80) }),
      preview: (params) => ({ title: `Status of ${params.robot}`, lines: [] }),
      async execute(params, ctx) { return interop.reportStatus(ctx.db, ctx.userId, params.robot); },
      async verify(response) { return { confirmed: Boolean(response?.state), evidence: response?.state?.stale ? `Last report ${response.state.ageS ?? "?"} s old: not current.` : "Current report." }; },
    },
  ];
}

module.exports = { interopActions };
