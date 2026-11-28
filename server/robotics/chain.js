"use strict";

/**
 * The command-validation chain: one deterministic order of checks that every
 * command to a robot passes, whoever asked (a person, chat, an agent, a
 * workflow, an AI teammate, the fleet, a plan, an operator's manual control):
 *
 *   1 identity              who is asking, from where
 *   2 user authorization    the account allows it (level, emergency stop; when it is
 *                           about to be sent: the Action Engine's decision or approval)
 *   3 robot authorization   the robot is this account's, enrolled, and the autonomy
 *                           policy lets commands reach it
 *   4 capability            the robot offers it and the input is valid
 *   5 robot state           online, emergency stop released, no fault, localized,
 *                           battery, not busy, sensors reporting
 *   6 operating mode        the robot's mode allows this kind of command from this
 *                           origin, and nobody else holds manual control
 *   7 safety policy         workspace, keep-out, speed, commissioning, and the robot's
 *                           safety profile
 *   8 required approval     who has to approve; when it is about to be sent, that
 *                           they did
 *   9 hardware execution    only then is the signed command queued for the robot
 *
 * The first step that fails is the refusal, with a typed reason
 * ({ step, code, message }). Later steps are still evaluated and listed so a
 * person sees everything that is wrong, but the refusal is always the earliest.
 * No model output decides any step: every input is a stored record, the
 * robot's own report or the account's settings.
 *
 * evaluate() returns a frozen verdict. Only verdicts made here are accepted by
 * the robot service's dispatch(): isGenuine() checks it was minted by this
 * module, at the execution stage, for that robot and capability, moments ago.
 */
const autonomy = require("./autonomy");
const contract = require("./contract");

const STEPS = ["identity", "user-authorization", "robot-authorization", "capability", "robot-state", "operating-mode", "safety-policy", "approval", "execution"];
const STEP_TITLE = {
  identity: "Who is asking", "user-authorization": "The account allows it", "robot-authorization": "The robot may be commanded", capability: "A valid command for this robot",
  "robot-state": "The robot is ready", "operating-mode": "The operating mode allows it", "safety-policy": "Inside the safety limits and profile", approval: "Approved as required", execution: "Sent to the robot",
};
const FRESH_MS = 15_000;
const minted = new WeakSet();

/** Which step a Safety Gateway violation belongs to. */
const STEP_OF = {
  "unknown-robot": "robot-authorization", revoked: "robot-authorization", "not-enrolled": "robot-authorization",
  "unknown-capability": "capability", unsupported: "capability", disabled: "capability", "invalid-input": "capability", "unknown-device": "capability",
  "unknown-sensor": "capability", "unknown-object": "capability", "no-camera": "capability", "unknown-camera": "capability", "dock-configured": "capability",
  "sensor-down": "robot-state", "gripper-full": "robot-state", "nothing-held": "robot-state", "busy-plan": "robot-state", "camera-off": "robot-state",
  "outside-workspace": "safety-policy", "keep-out": "safety-policy", "over-speed": "safety-policy", "no-speed-limit": "safety-policy", "no-workspace": "safety-policy",
  "not-commissioned": "safety-policy", "physical-plan": "safety-policy", "queue-full": "robot-state",
};
const stepOf = (code) => (code.startsWith("precondition:") ? "robot-state" : code.startsWith("profile:") ? "safety-policy" : code.startsWith("mode-") || code === "manual-control-held" || code === "autonomy-active" ? "operating-mode" : STEP_OF[code] || "safety-policy");

/**
 * Evaluate the chain.
 *   stage         "preflight" (when it is asked for) | "execute" (the moment it is sent)
 *   identity      { userId, source, actor? }
 *   account       { level, stopped }            the account's robots level and emergency stop
 *   authorization { kind: "action", outcome, approved, status } | { kind: "teleop", ok, reason } | { kind: "system" } | null
 *   robot         the registry's view (with operatingMode, safetyProfile)
 *   capabilityId, params, gateway (safety.check's answer), commandClass (default from the capability), plan (part of a plan)
 *   policy        the effective autonomy policy
 *   teleop        the robot's open manual-control session, if any { id, operator }
 *   activeMotion  the robot's unfinished motion mission, if any
 */
function evaluate({ stage = "preflight", identity = {}, account = {}, authorization = null, robot = null, capabilityId, params = {}, gateway = null, commandClass: kindGiven, plan = false, policy = null, teleop = null, activeMotion = null, now = Date.now() }) {
  const definition = contract.capability(capabilityId);
  const kind = kindGiven || autonomy.commandClass(capabilityId);
  const origin = autonomy.originOf(identity.source);
  const found = Object.fromEntries(STEPS.map((step) => [step, []]));
  const add = (step, code, message) => found[step].push({ code, message });
  const approvalReasons = [];
  let suggest = null;
  const name = robot?.name || "The robot";

  // 1. Identity
  if (!identity.userId || typeof identity.userId !== "string") add("identity", "no-identity", "Nobody is named as asking for this command.");
  else if (!/^[\w.:-]{1,40}$/.test(String(identity.source || ""))) add("identity", "unknown-source", "The command doesn't say where it came from (chat, the Robots screen, a workflow, an AI teammate, a developer key).");

  // 2. User authorization
  if (kind !== "stop" && kind !== "observe") {
    if (account.stopped) add("user-authorization", "account-stopped", "The account's emergency stop is on. Nothing but stopping and reading runs until it is turned off in Permissions.");
    else if (kind !== "teleop" && Number.isFinite(account.level) && account.level < 2) add("user-authorization", "level-read-only", "Robots are set to Read only in Permissions.");
  }
  if (stage === "execute" && kind !== "observe") {
    if (!authorization) add("user-authorization", "not-authorized", "No approved request stands behind this command.");
    else if (authorization.kind === "system") { if (kind !== "stop") add("user-authorization", "not-authorized", "HANNAH may only stop a robot by itself, never move it."); }
    else if (authorization.kind === "teleop") { if (!authorization.ok) add("user-authorization", authorization.code || "not-authorized", authorization.reason || "This operator doesn't hold manual control of the robot."); }
    else if (authorization.kind === "action") {
      const live = ["executing", "done", "unverified"].includes(authorization.status);
      if (kind !== "stop" && (!live || !(authorization.outcome === "allow" || authorization.approved))) add("user-authorization", "not-authorized", "The request behind this command wasn't allowed or approved.");
    } else add("user-authorization", "not-authorized", "No approved request stands behind this command.");
  }

  // 3. Robot authorization, 4. capability, 5. state and part of 7: the Safety Gateway's findings, sorted into their steps.
  if (!robot) add("robot-authorization", "unknown-robot", "That robot isn't enrolled in this account.");
  for (const item of gateway?.violations || []) add(stepOf(item.code), item.code, item.message);
  const rule = policy ? autonomy.policyRule(policy, { commandClass: kind, capabilityId, risk: gateway?.risk || definition?.risk, simulated: Boolean(robot?.simulated), params }) : {};
  if (rule.refuse) add("robot-authorization", rule.refuse.code, rule.refuse.message);
  if (rule.suggest) suggest = rule.suggest;
  if (kind === "teleop" && robot && robot.status !== "enrolled") add("robot-authorization", "not-enrolled", `${name} isn't enrolled.`);

  // 6. Operating mode, and exclusive control.
  if (robot) {
    const mode = robot.operatingMode || autonomy.defaultMode(robot);
    const refusal = autonomy.modeRefusal({ mode, commandClass: kind, origin, plan, robotName: name });
    if (refusal) add("operating-mode", refusal.code, refusal.message);
    if (teleop && kind !== "stop" && kind !== "observe" && kind !== "teleop" && kind !== "actuate") add("operating-mode", "manual-control-held", `${teleop.operator || "An operator"} holds manual control of ${name}. Autonomous commands are refused until the session ends and autonomy is restored.`);
    if (kind === "teleop" && activeMotion) add("operating-mode", "autonomy-active", `${name} is carrying out “${activeMotion.title || activeMotion.capability}”. Manual commands are refused while an autonomous mission runs.`);
    if (kind === "motion" && autonomy.modeForcesApproval(mode)) approvalReasons.push(`${autonomy.MODES[mode].label}: every movement is approved by a person`);
  }

  // 7. The safety profile (the gateway's limits are already above).
  if (robot?.safetyProfile) for (const item of autonomy.profileViolations(robot.safetyProfile, { capabilityId, params, sent: gateway?.params || {}, robot, now, commandClass: kind })) add("safety-policy", item.code, item.message);

  // 8. Approval
  if (kind !== "stop" && kind !== "observe" && kind !== "teleop") {
    approvalReasons.push(...autonomy.profileApproval(robot?.safetyProfile, { capabilityId, commandClass: kind }));
    if (rule.ask) approvalReasons.push(rule.ask);
    if (stage === "execute" && approvalReasons.length && authorization?.kind === "action" && !authorization.approved) {
      add("approval", "approval-required", `A person has to approve this first: ${approvalReasons.join("; ")}.`);
    }
    if (stage === "execute" && suggest) add("approval", "suggest-only", suggest);
  }

  const steps = STEPS.map((step) => {
    if (step === "execution") return { step, title: STEP_TITLE[step], ok: null };
    const problems = found[step];
    return { step, title: STEP_TITLE[step], ok: problems.length === 0, ...(problems.length ? { problems } : {}) };
  });
  const first = steps.find((item) => item.ok === false);
  const refusal = first ? { step: first.step, code: first.problems[0].code, message: first.problems[0].message } : null;
  // Everything wrong, earliest step first: what the person reads.
  const violations = STEPS.flatMap((step) => found[step].map((item) => ({ ...item, step })));
  const verdict = Object.freeze({
    stage, ok: !refusal, refusal, steps: Object.freeze(steps), violations: Object.freeze(violations), approvalReasons: Object.freeze([...new Set(approvalReasons)]), suggest,
    robotId: robot?.id || null, capabilityId, commandClass: kind, origin, plan, at: now,
  });
  minted.add(verdict);
  return verdict;
}

/** Is this a verdict the chain made, at the execution stage, for this robot and capability, just now? */
function isGenuine(verdict, { robotId, capabilityId, now = Date.now() }) {
  return Boolean(verdict && minted.has(verdict) && verdict.stage === "execute" && verdict.ok && verdict.robotId === robotId && verdict.capabilityId === capabilityId && now - verdict.at <= FRESH_MS && verdict.at <= now + 1000);
}

/** The flags the Action Engine reads: a refusal denies, a suggestion is only prepared, approval reasons ask. */
function flagsFor(verdict) {
  if (!verdict.ok) return [`forbidden:${verdict.violations.map((item) => item.message).join(" ")}`];
  if (verdict.suggest) return [`suggest:${verdict.suggest}`];
  return [...verdict.approvalReasons];
}

module.exports = { STEPS, STEP_TITLE, evaluate, flagsFor, isGenuine, stepOf };
