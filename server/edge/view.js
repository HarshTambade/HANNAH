"use strict";

const { adviseForRobot } = require("./model-fit");

/** A robot's resources: the latest report, its history and the model advice, for the app and the agent tool alike. */
async function resourcesView(db, robotics, userId, robot, { task, contextTokens, hours } = {}) {
  const latest = await robotics.edgeResources.latest(db, userId, robot.id);
  const history = await robotics.edgeResources.history(db, userId, robot.id, { sinceMs: Math.max(1, Math.min(168, Number(hours) || 6)) * 60 * 60_000 });
  const advice = adviseForRobot(latest, {
    task: ["chat", "agentic", "coding", "reasoning"].includes(task) ? task : "chat",
    contextTokens: Number(contextTokens) || 4096,
    approvedRemote: latest?.policy.approvedRemoteResources[0] || null,
    privacy: latest?.policy.reasoningPrivacy || "allow-approved-remote",
  });
  return {
    robot: { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical", connection: robot.connection },
    latest, history, advice,
    note: latest
      ? (latest.fresh ? "Measured by the robot's Edge Resource Manager." : `The latest report is ${latest.ageS} s old: this is the robot's last known state, not its current one.`)
      : "This robot hasn't sent an edge resources report. HANNAH Robot OS's edge-resources service measures them; nothing is shown until it reports.",
  };
}

module.exports = { resourcesView };
