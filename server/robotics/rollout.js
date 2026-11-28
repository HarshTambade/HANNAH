"use strict";

/**
 * Staged rollout of an update package to selected robots.
 *
 * Waves go in this order, each to robots a person picked:
 *
 *   development → test → limited → selected → wider
 *
 * By default a rollout never reaches every robot at once: the first wave is
 * one robot, the "limited" wave at most a quarter of the robots in the
 * rollout, and no single wave may hold every robot when there is more than
 * one. Only an explicit "all at once" choice, stated when approving, lifts
 * that. A wave starts only after the wave before it is healthy on every
 * robot, and only with its own approval by a signed-in person.
 *
 * On each robot of a started wave (Robot OS signed commands):
 *
 *   queued → staging → staged → activating → verifying → healthy
 *                ↘ failed ← (refused, timed out, or a health check failed)
 *   failed → rolling-back → rolled-back      (automatic when rollback is available)
 *   the robot itself may report rolled-back (its boot loader fell back)
 *
 * "healthy" means the robot reported every health check the package lists as
 * passing. A robot that says nothing before the deadline has failed: silence
 * is never success. Any failure halts the rollout; no further wave starts.
 *
 * This module only decides. The service (robotops.js) stores the record and
 * sends the commands.
 */
const STAGES = ["development", "test", "limited", "selected", "wider"];
const STAGE_TITLES = { development: "Development robot", test: "Test robot", limited: "Limited group", selected: "Selected fleet", wider: "Wider fleet" };
const FINAL_TARGET = new Set(["healthy", "failed", "rolled-back", "rollback-failed", "skipped"]);
const ACTIVE_TARGET = new Set(["queued", "staging", "staged", "activating", "verifying", "rolling-back"]);
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const LIMITED_SHARE = 0.25;

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });

/**
 * The waves for the robots a person picked per stage.
 *   picked     { development: [robotId], test: [...], limited: [...], selected: [...], wider: [...] }
 *   eligible   every robot id that passed validation for this package
 */
function planWaves(picked, eligible, { allowAllAtOnce = false } = {}) {
  const problems = [];
  const seen = new Set();
  const waves = [];
  for (const stage of STAGES) {
    const ids = [...new Set((Array.isArray(picked?.[stage]) ? picked[stage] : []).map(String))];
    if (!ids.length) continue;
    for (const id of ids) {
      if (!eligible.includes(id)) problems.push(`${id} isn't eligible for this package (it failed validation, or isn't in your account).`);
      if (seen.has(id)) problems.push(`${id} is in more than one wave.`);
      seen.add(id);
    }
    waves.push({ stage, robotIds: ids, status: "planned", approval: null, startedAt: null, finishedAt: null });
  }
  const total = seen.size;
  if (!waves.length) problems.push("Pick at least one robot.");
  if (!allowAllAtOnce && total > 1) {
    if (waves[0] && waves[0].robotIds.length !== 1) problems.push(`The first wave (${STAGE_TITLES[waves[0].stage]}) is one robot, so a bad update reaches one machine first.`);
    for (const wave of waves) if (wave.robotIds.length === total) problems.push(`The ${STAGE_TITLES[wave.stage]} wave holds every robot in the rollout. Split it, or choose "all at once" explicitly.`);
    const limited = waves.find((wave) => wave.stage === "limited");
    const cap = Math.max(1, Math.floor(total * LIMITED_SHARE));
    if (limited && limited.robotIds.length > cap) problems.push(`The limited wave is at most a quarter of the rollout (${cap} of ${total}).`);
  }
  return { ok: problems.length === 0, waves, problems, total };
}

/** Whether a wave may be approved and started now, and why not. */
function canStart(rollout, index) {
  const wave = rollout.waves[index];
  if (!wave) return { ok: false, reason: "That wave doesn't exist." };
  if (["halted", "cancelled", "completed"].includes(rollout.status)) return { ok: false, reason: `The rollout is ${rollout.status}.` };
  if (wave.status !== "planned") return { ok: false, reason: `That wave is already ${wave.status}.` };
  const before = rollout.waves.slice(0, index);
  const unfinished = before.find((item) => item.status !== "healthy");
  if (unfinished) return { ok: false, reason: `The ${STAGE_TITLES[unfinished.stage]} wave isn't healthy yet (${unfinished.status}). Each wave waits for the one before it.` };
  return { ok: true, reason: "" };
}

function newTarget(robotId, waveIndex) {
  return { robotId, wave: waveIndex, status: "planned", commands: {}, backup: null, deadlineAt: null, health: null, reason: "", history: [] };
}

function move(target, status, at, reason = "", extra = {}) {
  return { ...target, ...extra, status, reason: reason || target.reason, history: [...target.history, { at, status, ...(reason ? { reason } : {}) }].slice(-40) };
}

/**
 * The health checks the package lists, against what the robot reported.
 * Every listed check must be reported, and pass.
 */
function judgeHealth(healthChecks, reported) {
  const byId = new Map((Array.isArray(reported) ? reported : []).filter((item) => item && typeof item.id === "string").map((item) => [item.id, item]));
  const results = healthChecks.map((check) => {
    const item = byId.get(check.id);
    return { id: check.id, description: check.description, ok: item?.ok === true, detail: item ? String(item.detail || (item.ok ? "passed" : "failed")).slice(0, 200) : "not reported by the robot" };
  });
  return { ok: results.length > 0 && results.every((item) => item.ok), results };
}

/** What a wave's status is, from its robots. */
function waveStatus(rollout, index) {
  const wave = rollout.waves[index];
  if (wave.status === "planned") return "planned";
  const targets = wave.robotIds.map((id) => rollout.targets[id]);
  if (targets.some((target) => ["failed", "rolled-back", "rollback-failed", "rolling-back"].includes(target.status))) return "failed";
  if (targets.every((target) => target.status === "healthy")) return "healthy";
  return "installing";
}

/** The rollout's status from its waves. */
function rolloutStatus(rollout) {
  if (rollout.status === "cancelled") return "cancelled";
  const statuses = rollout.waves.map((_wave, index) => waveStatus(rollout, index));
  if (statuses.includes("failed")) return "halted";
  if (statuses.every((status) => status === "healthy")) return "completed";
  if (statuses.includes("installing")) return "in-progress";
  return statuses.some((status) => status === "healthy") ? "paused" : "planned";
}

/** Recompute derived statuses after a change. Returns a new rollout. */
function settle(rollout, at) {
  const waves = rollout.waves.map((wave, index) => {
    const status = waveStatus(rollout, index);
    return { ...wave, status, finishedAt: ["healthy", "failed"].includes(status) ? wave.finishedAt || at : null };
  });
  const next = { ...rollout, waves };
  return { ...next, status: rolloutStatus(next) };
}

/** Robots whose deadline passed in an active state: failed-update detection. */
function overdue(rollout, at) {
  return Object.values(rollout.targets).filter((target) => ACTIVE_TARGET.has(target.status) && target.deadlineAt && target.deadlineAt <= at);
}

module.exports = { ACTIVE_TARGET, COMMAND_TIMEOUT_MS, FINAL_TARGET, LIMITED_SHARE, STAGES, STAGE_TITLES, canStart, fail, judgeHealth, move, newTarget, overdue, planWaves, rolloutStatus, settle, waveStatus };
