"use strict";

/**
 * Onboard HANNAH Robot OS administration actions.
 *
 * These never write to hardware directly. They queue a signed, expiring command
 * that the robot picks up on its next outbound exchange. The robot checks the
 * signature, its own safety state and command expiry before it applies anything.
 * Both actions always require a signed-in person's approval: a standing grant or
 * an agent key can never stage or roll back a Robot OS update by itself.
 */
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
// toWellFormed: cutting at a length can split an emoji; a lone surrogate then
// broke the robot's signature check (UTF-8 can't encode it).
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max).toWellFormed();
const ROBOT = { type: "string", description: "The Robot OS robot's name or id." };

function robotOSActions({ robotics, robotOSCommands }) {
  if (!robotOSCommands) return [];

  async function target(params, ctx) {
    const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
    if (!robot) throw fail(404, "That Robot OS instance isn't enrolled under this account.", "unknown-robot");
    return robot;
  }

  const updateAction = ({ id, title, description, capability, input, required, paramsOf, lines }) => ({
    id,
    service: "robots",
    kind: "write",
    standing: false, // never covered by a standing permission; a person always approves
    title,
    description,
    needs: "An enrolled Robot OS instance, signed-in approval",
    input: { type: "object", properties: { robot: ROBOT, ...input }, required: ["robot", ...required] },
    normalize: (raw) => ({ robot: clip(raw?.robot, 80), ...paramsOf(raw) }),
    async assess(params, ctx) {
      const robot = await target(params, ctx);
      return { resource: { type: "robot", id: robot.id }, account: robot.name, flags: [], risk: "high", robot };
    },
    preview(_params, _ctx, assessed) {
      return {
        title: `${title}: ${assessed.robot.name}`,
        lines: [{ label: "Robot OS", value: `${assessed.robot.name} — ${assessed.robot.simulated ? "simulation" : "physical"}` }, ...lines(_params)],
        body: "This queues a signed command for the robot to collect. Nothing is flashed. The robot checks its own safety state and refuses the command if it isn't safe. A person must approve before it is sent.",
        warnings: ["Rollback must be confirmed by the robot; if it is offline, the result stays unconfirmed."],
      };
    },
    async execute(params, ctx) {
      const robot = await target(params, ctx);
      const { robot: _robot, ...rest } = params;
      const command = await robotOSCommands.issue(ctx.db, { userId: ctx.userId, robotId: robot.id, capability, params: rest });
      const settled = await robotOSCommands.waitFor(ctx.db, ctx.userId, command.id);
      if (settled?.status === "failed") throw fail(409, `Robot OS refused this command. ${settled.ackReason}`, "command-failed");
      return { commandId: command.id, robot: { id: robot.id, name: robot.name }, status: settled?.status || "pending", capability, note: `Signed ${capability} command queued for ${robot.name}; ${settled?.status === "acked" ? "the robot confirmed it" : "the robot hasn't confirmed it yet"}.` };
    },
    async verify(response, _params, ctx) {
      const command = await robotOSCommands.get(ctx.db, ctx.userId, response.commandId);
      if (!command) return { confirmed: false, evidence: "The command record disappeared." };
      if (command.status === "acked") return { confirmed: true, evidence: `${response.robot.name} accepted and applied ${response.capability}.` };
      if (command.status === "failed") return { confirmed: false, evidence: `Robot OS refused it: ${command.ackReason}` };
      return { confirmed: false, evidence: `The command is still ${command.status}; ${response.robot.name} hasn't reported back yet.` };
    },
  });

  return [
    updateAction({
      id: "robotos.stage_update",
      title: "Stage a Robot OS update",
      description: "Ask a Robot OS instance to download and verify a signed update into its inactive slot. Nothing is flashed and the robot keeps running the current version until a later, separately approved activation.",
      capability: "update.stage",
      input: {
        version: { type: "string", description: "The version in the signed manifest." },
        artifact: { type: "string", description: "Where the robot should fetch the artifact from." },
        sha256: { type: "string", description: "The expected SHA-256 of the artifact." },
        signature: { type: "string", description: "The release signature." },
        signer: { type: "string", description: "The trusted release signer." },
      },
      required: ["version", "artifact", "sha256", "signature", "signer"],
      paramsOf: (raw) => ({
        version: clip(raw?.version, 40), artifact: clip(raw?.artifact, 500), sha256: clip(raw?.sha256, 64),
        signature: clip(raw?.signature, 500), signer: clip(raw?.signer, 120),
      }),
      lines: (params) => [
        { label: "Version", value: params.version },
        { label: "Artifact", value: params.artifact },
        { label: "SHA-256", value: params.sha256 },
      ],
    }),
    updateAction({
      id: "robotos.activate_update",
      title: "Activate a staged Robot OS update",
      description: "Ask a Robot OS instance to promote the staged update into the current slot. The robot refuses unless its own READY gate passes; the parent cannot claim the robot is healthy.",
      capability: "update.activate",
      input: { version: { type: "string", description: "The staged version that may be promoted." } },
      required: ["version"],
      paramsOf: (raw) => ({ version: clip(raw?.version, 40) }),
      lines: (params) => [{ label: "Version", value: params.version }, { label: "Local gate", value: "The robot checks its own service health before applying" }],
    }),
    updateAction({
      id: "robotos.rollback_update",
      title: "Roll back a Robot OS update",
      description: "Ask a Robot OS instance to switch back to its last known-good slot after a failed update. The robot verifies its own recovery state before applying it.",
      capability: "update.rollback",
      input: { reason: { type: "string", description: "Why the rollback is needed; kept in the audit record." } },
      required: ["reason"],
      paramsOf: (raw) => ({ reason: clip(raw?.reason, 500) }),
      lines: (params) => [{ label: "Reason", value: params.reason }],
    }),
  ];
}

module.exports = { robotOSActions };
