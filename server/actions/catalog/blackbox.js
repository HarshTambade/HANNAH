"use strict";

/**
 * The black box as Action Engine actions, for agents and chat ("Why did my
 * robot stop?"). Both only read stored records. An agent never sees a
 * sensitive item's details: those need a signed-in person on the Robots screen.
 */
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const ROBOT = { type: "string", description: "The robot's name or id. Leave out when there is exactly one robot." };

function blackboxActions({ robotics, blackbox }) {
  if (!blackbox) return [];
  const read = ({ id, title, description, input, normalize, run, evidence }) => ({
    id, service: "robots", kind: "read", title, description, needs: "A robot enrolled under Robots", input: { type: "object", properties: input, required: [] },
    normalize, assess: () => ({}), preview: () => ({ title, lines: [] }), execute: (params, ctx) => run(params, ctx),
    verify: () => ({ confirmed: true, evidence }),
  });
  return [
    read({
      id: "robots.why_stopped", title: "Explain why a robot stopped",
      description: "An incident report from the robot's stored records: the stop (an emergency stop, a fault, a lost link, a navigation failure, a sensor that stopped reporting, a mission that didn't succeed), every record in the two minutes before it, what the records confirm, suspected causes from fixed rules with the records behind each, how often the same stop happened in 30 days, what is missing, and recovery steps for a person. Every line cites record ids. Without a mission, the latest stop.",
      input: { robot: ROBOT, mission: { type: "string", description: "A mission id, to explain that mission's stop." } },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), mission: clip(raw?.mission, 80) }),
      evidence: "Built by fixed rules from stored records only; suspected causes are marked suspected.",
      async run(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const report = await blackbox.investigateRobot(ctx.db, ctx.userId, robot, { missionId: params.mission || null, session: false });
        if (!report.found) return { ...report, howToAnswer: "Say that no stop is recorded, and what was searched. Do not suggest a cause." };
        return {
          ...report, sequence: report.sequence.slice(-40),
          howToAnswer: "Give the confirmed lines as what the records show, each with its record ids. Give each suspected cause as suspected (never as the cause), with its ids and how to confirm it. Say if the robot is a simulation. Mention the gaps and clock notes when there are any. The recovery steps are for the person; you carry out none of them.",
        };
      },
    }),
    read({
      id: "robots.timeline", title: "Search a robot's event timeline",
      description: "A robot's events in order: its black box events (motor, sensors, navigation, safety, link, OS), its missions, and what agents and people asked of it with permission and approval. Each says where it came from and whether its time is on a synchronised clock. Filter by mission, source, severity or words.",
      input: { robot: ROBOT, mission: { type: "string" }, minutes: { type: "number", description: "How far back. Default 60, at most 10080 (a week)." }, source: { type: "string", description: "motor, sensor, navigation, ai, os, safety, link, mission or server; several with commas." }, severity: { type: "string", enum: ["info", "warning", "error", "critical"] }, words: { type: "string" } },
      normalize: (raw) => ({ robot: clip(raw?.robot, 80), mission: clip(raw?.mission, 80), minutes: Math.max(1, Math.min(10_080, Number(raw?.minutes) || 60)), source: clip(raw?.source, 80), severity: clip(raw?.severity, 20), words: clip(raw?.words, 80) }),
      evidence: "Read from stored records.",
      async run(params, ctx) {
        const robot = await robotics.resolveRobot(ctx.db, ctx.userId, params.robot);
        const to = ctx.now() + 60_000;
        const view = await blackbox.timeline(ctx.db, ctx.userId, robot.id, { from: to - params.minutes * 60_000, to, mission: params.mission || undefined, source: params.source, severity: params.severity || undefined, q: params.words, limit: 120 }, { session: false });
        return { ...view, events: view.events.map(({ dataRefs: _refs, receivedAt: _received, ...item }) => item) };
      },
    }),
  ];
}

module.exports = { blackboxActions };
