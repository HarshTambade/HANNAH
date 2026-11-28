"use strict";

/**
 * Replay on the server: a mission reconstructed from its records, and a
 * regression scenario made from an incident.
 *
 * reconstruct() puts a mission's timeline together (its phases, every event
 * around it, and the robot's track from telemetry and any uploaded
 * recording) as frames to play back. It is always marked as playback: it is
 * what was recorded, never the robot now.
 *
 * scenarioFromIncident() writes a scenario in the format of robotics/scenarios
 * for HANNAH's built-in simulator (python3 -m hannah_robot.scenarios FILE): the
 * mission's goal, the objects the range sensor reported, and the sensor and
 * emergency-stop changes recorded, expecting the recorded outcome. Passing it
 * says the simulator reproduces the same outcome from the same inputs; it is
 * not a test on the robot.
 */
const KNOWN_WORLDS = new Set(["home", "bench", "workcell"]);
const PLAYBACK = "PLAYBACK: recorded data, not live. Nothing here is the robot's present state.";

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function reconstruct({ robot, mission, timeline = [], telemetry = [], records = [] }) {
  const start = Math.min(mission.createdAt, ...timeline.filter((item) => item.missionId === mission.id).map((item) => item.at));
  const end = Math.max(mission.finishedAt || mission.deadlineAt || start, ...timeline.filter((item) => item.missionId === mission.id).map((item) => item.at));
  const frames = new Map();
  for (const sample of telemetry) {
    if (sample.at < start - 5_000 || sample.at > end + 10_000 || !Number.isFinite(sample.x)) continue;
    frames.set(sample.at, { at: sample.at, pose: { x: sample.x, y: sample.y, yaw: sample.yaw ?? null }, speed: sample.v ?? null, mode: sample.mode || null, battery: sample.battery ?? null, estop: Boolean(sample.estop), from: "telemetry" });
  }
  for (const record of records) {
    const t = Number(record.t);
    if (record.topic !== "nav/pose" || t < start - 5_000 || t > end + 10_000) continue;
    const data = record.data || {};
    if (!Number.isFinite(data.x)) continue;
    frames.set(t, { ...(frames.get(t) || {}), at: t, pose: { x: data.x, y: data.y, yaw: data.yaw ?? null }, from: "recording", segment: record.segment });
  }
  const motor = records.filter((record) => record.topic === "motor/state");
  for (const frame of frames.values()) {
    if (frame.speed !== undefined && frame.speed !== null) continue;
    const near = motor.filter((record) => Number(record.t) <= frame.at).pop();
    if (near) { frame.speed = near.data?.linear ?? null; frame.estop = Boolean(near.data?.estop); }
  }
  const events = timeline.filter((item) => item.at >= start - 30_000 && item.at <= end + 10_000);
  return {
    playback: true, live: false, label: PLAYBACK, robot: { id: robot.id, name: robot.name, kind: robot.simulated ? "simulation" : "physical" },
    mission: { id: mission.id, capability: mission.capability, params: mission.params, status: mission.status, error: mission.error || null, verification: mission.verification || null, createdAt: mission.createdAt, finishedAt: mission.finishedAt },
    from: start, to: end, world: robot.world || null, frames: [...frames.values()].sort((a, b) => a.at - b.at), events,
    sources: { telemetrySamples: telemetry.length, recordingRecords: records.length },
    note: frames.size ? "Positions are what the robot reported (its own localization), not ground truth." : "No positions are stored for this mission: telemetry is kept for two hours, and no recording covering it was uploaded.",
  };
}

function goalOf(mission, robot) {
  const params = mission.params || {};
  if (mission.capability === "return_to_dock" && robot.dock) return { x: robot.dock.x, y: robot.dock.y };
  if (["navigate_to", "return_to_dock"].includes(mission.capability) && Number.isFinite(params.x) && Number.isFinite(params.y)) return { x: params.x, y: params.y };
  return null;
}

function scenarioFromIncident({ report, mission, robot, records = [] }) {
  if (!report?.found) throw fail(409, "There is no incident to turn into a scenario.", "no-incident");
  if (!mission) throw fail(409, "The incident isn't tied to a mission, so there is no goal to reproduce. Investigate a mission's stop instead.", "no-mission");
  const goal = goalOf(mission, robot);
  if (!goal) throw fail(409, `Only drive missions can become a simulator scenario; this one was ${mission.capability}.`, "not-a-drive");
  const expect = ["succeeded", "failed", "cancelled", "timed-out"].includes(mission.status) ? mission.status : null;
  if (!expect) throw fail(409, `The mission ended ${mission.status}, which the simulator can't check.`, "unsupported-outcome");
  const started = mission.acceptedAt || mission.createdAt;
  const during = [];
  const notReproducible = [];
  const faults = new Set();
  for (const item of report.sequence) {
    if (item.at < started || (mission.finishedAt && item.at > mission.finishedAt + 2_000)) continue;
    const after = Math.round(Math.max(0, item.at - started) / 10) / 100;
    if (item.type === "sensor-lost" && item.deviceId) { faults.add(item.deviceId); during.push({ after, sensorFaults: [...faults].sort(), recordedEvent: item.id }); }
    else if (item.type === "sensor-restored" && item.deviceId) { faults.delete(item.deviceId); during.push({ after, sensorFaults: [...faults].sort(), recordedEvent: item.id }); }
    else if (item.type === "estop-engaged") during.push({ after, estop: true, recordedEvent: item.id });
    else if (item.type === "link-lost") notReproducible.push({ event: item.id, what: "the link to HANNAH was lost: the built-in simulator's scenarios have no network" });
    else if (item.type === "fault") notReproducible.push({ event: item.id, what: "a robot fault: the simulator only faults on collision" });
  }
  if (expect === "cancelled" && notReproducible.some((item) => item.what.startsWith("the link"))) throw fail(409, "The mission ended because the link was lost, which the built-in simulator can't reproduce.", "not-reproducible");
  const obstacles = [];
  for (const record of records) {
    if (record.topic !== "sensors/obstacles" || (record.mission && record.mission !== mission.id)) continue;
    for (const found of record.data?.objects || []) {
      if (!Number.isFinite(found.x) || !Number.isFinite(found.y) || obstacles.some((other) => Math.abs(other.x - found.x) < 0.3 && Math.abs(other.y - found.y) < 0.3)) continue;
      const size = Math.max(0.2, Number(found.widthM) || 0.3);
      obstacles.push({ name: "object the range sensor reported", x: found.x, y: found.y, w: Math.round(size * 100) / 100, h: Math.round(size * 100) / 100 });
    }
  }
  const worldName = String(robot.mapName || robot.world?.name || "");
  const world = KNOWN_WORLDS.has(worldName) ? `../worlds/${worldName}.json` : null;
  const step = { navigate: goal, expect, timeout: 240, ...(expect !== "succeeded" && mission.error ? { reason: escape(String(mission.error).slice(0, 60)) } : {}), ...(during.length ? { during } : {}) };
  return {
    name: `incident-${mission.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60),
    description: `Generated from HANNAH's records of ${robot.name}'s mission ${mission.id} (${robot.simulated ? "a simulation" : "a physical robot"}): the same goal, ${obstacles.length} object${obstacles.length === 1 ? "" : "s"} the range sensor reported, and the recorded sensor and emergency-stop changes, expecting the recorded outcome (${expect}).`,
    world: world || "../worlds/home.json",
    steps: [...obstacles.slice(0, 8).map((rect) => ({ obstacle: rect })), step],
    expect: {},
    source: {
      kind: "blackbox-incident", robotId: robot.id, missionId: mission.id, anchor: report.anchor.id, recordedOn: robot.simulated ? "simulation" : "physical robot", evidence: report.evidenceIds,
      notReproducible, worldKnown: Boolean(world), note: `${world ? "" : `The robot's map (${worldName || "unnamed"}) isn't one of HANNAH's built-in worlds: set "world" to a matching world file before running. `}Runs in HANNAH's built-in simulator only. Passing it is not a test on the robot.`,
    },
  };
}

module.exports = { PLAYBACK, reconstruct, scenarioFromIncident };
