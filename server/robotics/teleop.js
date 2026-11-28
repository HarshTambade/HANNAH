"use strict";

/**
 * Teleoperation and rescue mode, server side.
 *
 * Handoff, in this order, each step recorded (the first that fails ends it):
 *   1 operator authentication   a signed-in person (never a developer key or an agent)
 *   2 robot identification      the operator confirms the robot by id, and for a
 *                               physical robot by its key fingerprint
 *   3 permission                the account and the autonomy policy allow commands, the
 *                               robot is ready (online, emergency stop released, no fault),
 *                               a physical robot is commissioned
 *   4 mode transition           to Manual (Assisted and Maintenance keep their mode),
 *                               by the allowed-transition table
 *   5 mission handling          every plan and mission on the robot is cancelled: a manual
 *                               move invalidates where they started from
 *   6 manual activation         the robot is told, signed; control is "active" only once the
 *                               robot reports it took the session
 *   7 operator visibility       the session (who, since when) is on the robot's record for
 *                               everyone who can see the robot
 *   8 audit                     every step, the end and its reason
 * Autonomy comes back only when a person restores it, through the readiness
 * checks in safety_manager.js.
 *
 * Velocity commands: a number that only goes up, a short life (400 ms), and
 * only the newest is ever delivered. A command that is stale when the robot
 * next exchanges is not sent at all, and the robot stops by itself when it
 * hears nothing new within its deadman time (robotics/runtime). Connection
 * loss and an operator who goes away end in the robot holding, not moving.
 *
 * Exclusive control: while a session is open no autonomous command passes the
 * chain, and while an autonomous mission runs no manual command does.
 */
const crypto = require("node:crypto");
const autonomy = require("./autonomy");
const chain = require("./chain");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 3) => Number(Number(value).toFixed(digits));

const STEPS = [
  { id: "operator-auth", title: "Operator signed in" },
  { id: "robot-identification", title: "Robot identified" },
  { id: "permission", title: "Permission checked" },
  { id: "mode-transition", title: "Operating mode changed" },
  { id: "mission-handling", title: "Missions and plans ended" },
  { id: "manual-activation", title: "Robot confirmed manual control" },
  { id: "operator-visibility", title: "Operator shown on the robot" },
  { id: "audit", title: "Recorded" },
];
const OPERATOR_QUIET_MS = 1500; // no input for this long: nothing more is sent (the robot's deadman has stopped it)
const OPERATOR_GONE_MS = 10_000; // no input for this long: the session ends
const ACTIVATION_MS = 20_000; // the robot has this long to confirm it took control

function createTeleop({ now, core, manager }) {
  const sessionView = (row, robot, at = now()) => {
    if (!row) return null;
    const limits = parse(row.limits, {});
    const cmd = parse(row.cmd);
    return {
      id: row.id, robotId: row.robot_id, operator: row.operator, status: row.status, steps: parse(row.steps, []), previousMode: row.previous_mode || null, limits,
      createdAt: Number(row.created_at), activatedAt: row.activated_at ? Number(row.activated_at) : null, endedAt: row.ended_at ? Number(row.ended_at) : null, endReason: row.end_reason || null,
      lastCommand: cmd ? { seq: Number(row.cmd_seq), linear: cmd.linear, angular: cmd.angular, clamped: Boolean(cmd.clamped), receivedAt: Number(row.cmd_received_at), expiresAt: Number(row.cmd_expires_at) } : null,
      link: {
        // Measured on the server: input received → handed to the robot, and the robot's own report of what it applied.
        serverToRobotMs: row.delivered_at && row.cmd_received_at && Number(row.delivered_at) >= Number(row.cmd_received_at) ? Number(row.delivered_at) - Number(row.cmd_received_at) : null,
        deliveredSeq: Number(row.delivered_seq) || 0, ackedSeq: Number(row.acked_seq) || 0,
        robotAckAgeMs: row.acked_at ? Math.max(0, at - Number(row.acked_at)) : null,
        lastInputAgeMs: row.last_input_at ? Math.max(0, at - Number(row.last_input_at)) : null,
        telemetryAgeS: robot?.stateAgeS ?? null, robotOnline: Boolean(robot?.online),
        robotApplied: robot?.state?.teleop && robot.state.teleop.session === row.id ? robot.state.teleop : null,
      },
      video: { available: false, reason: "This robot has no live camera stream in HANNAH. Pictures are taken one at a time on request (Robots → Camera); manual control here uses telemetry only." },
    };
  };
  async function sessionRow(db, userId, robotId, sessionId) {
    return (await db.query("SELECT * FROM hannah_robot_teleop_sessions WHERE user_id = $1 AND robot_id = $2 AND id = $3", [userId, String(robotId), String(sessionId || "")])).rows[0] || null;
  }
  async function latest(db, userId, robotId) {
    return (await db.query("SELECT * FROM hannah_robot_teleop_sessions WHERE user_id = $1 AND robot_id = $2 ORDER BY created_at DESC LIMIT 1", [userId, robotId])).rows[0] || null;
  }
  /** Close what is already over: an operator gone quiet for too long, a robot that never confirmed or dropped the session. */
  async function sweep(db, userId, row, robot, at = now()) {
    if (!row || !["activating", "active"].includes(row.status)) return row;
    let reason = null;
    if (row.status === "activating" && at - Number(row.created_at) > ACTIVATION_MS) reason = "the robot didn't confirm manual control in time";
    else if (row.status === "active" && at - Number(row.last_input_at || row.activated_at || row.created_at) > OPERATOR_GONE_MS) reason = "operator disconnected (no input for 10 seconds)";
    else if (row.status === "active" && robot?.online && robot.reportedOperatingMode && robot.reportedOperatingMode.session !== row.id && robot.reportedOperatingMode.seq === robot.modeSeq) reason = "the robot dropped manual control (link loss or a local stop)";
    if (!reason) return row;
    await manager.endSession(db, userId, row, reason, at);
    return (await sessionRow(db, userId, row.robot_id, row.id)) || row;
  }

  async function view(db, userId, robotId) {
    const robot = await core.getRobot(db, userId, robotId);
    const row = await sweep(db, userId, await latest(db, userId, robot.id), robot);
    return { session: sessionView(row, robot), robot: { id: robot.id, name: robot.name, simulated: robot.simulated, operatingMode: robot.operatingMode, fingerprint: robot.fingerprint || null }, steps: STEPS, limits: autonomy.teleopLimits(robot, robot.safetyProfile, robot.operatingMode) };
  }

  /** The state checks for manual control: online, released, no fault. */
  function readiness(robot) {
    const violations = [];
    const state = robot.state || {};
    const no = (code, message) => violations.push({ code, message });
    if (robot.status !== "enrolled") no("not-enrolled", `${robot.name} isn't enrolled.`);
    else if (!robot.online) no("precondition:online", robot.lastSeenAt ? `${robot.name} is offline.` : `${robot.name} has never connected.`);
    else {
      if (state.estop?.engaged) no("precondition:estop-released", `${robot.name}'s emergency stop is engaged. It has to be released at the robot.`);
      if (state.motorsEnabled === false) no("precondition:motors-enabled", `${robot.name}'s motors are disabled.`);
      if (Array.isArray(state.faults) && state.faults.length) no("precondition:no-fault", `${robot.name} reports a fault: ${clean(state.faults[0]?.message || state.faults[0]?.code, 120)}.`);
      const blind = ["lidar", "odometry"].filter((id) => state.sensors?.[id]?.ok === false);
      if (blind.length) no("sensor-down", `${robot.name}'s ${blind.join(" and ")} isn't reporting.`);
    }
    if (!robot.capabilities.includes("stop_motion")) no("unsupported", `${robot.name} can't be stopped through HANNAH, so it can't be driven by hand either.`);
    if (robot.robotType === "manipulator-arm") no("unsupported", `${robot.name} is an arm. Manual control here drives a mobile base only.`);
    return violations;
  }

  /** Run the handoff. Returns the session and, once only, the token that lets this operator's screen send commands. */
  async function start(db, userId, robotId, { operator, operatorSession = null, person = false, confirm = {} } = {}) {
    const at = now();
    const robot = await core.getRobot(db, userId, robotId);
    const steps = STEPS.map((step) => ({ ...step, ok: null }));
    const mark = (id, ok, detail) => Object.assign(steps.find((step) => step.id === id), { ok, detail, at: now() });
    const refuse = async (id, code, message, extra = {}) => {
      mark(id, false, message);
      await manager.audit(db, userId, { robotId: robot.id, kind: "teleop", actor: operator || "unknown", summary: `Manual control refused at “${STEPS.find((step) => step.id === id).title}”: ${message}`, detail: { step: id, code, steps } });
      throw fail(409, message, code, { step: id, steps, ...extra });
    };
    // 1. Operator authentication
    if (!person || !operator) await refuse("operator-auth", "operator-not-signed-in", "Manual control needs a person signed in to the app. A developer key or an agent can't hold it.");
    mark("operator-auth", true, `Signed in as ${operator}.`);
    // 2. Robot identification
    if (String(confirm.robotId || "") !== robot.id) await refuse("robot-identification", "robot-not-confirmed", `Confirm the robot: its id is ${robot.id}.`);
    if (!robot.simulated && robot.fingerprint && String(confirm.fingerprint || "").replace(/\s+/g, "").toUpperCase() !== robot.fingerprint.replace(/\s+/g, "")) await refuse("robot-identification", "fingerprint-mismatch", `The key fingerprint doesn't match ${robot.name}'s (${robot.fingerprint}). Check the robot you are standing at.`);
    mark("robot-identification", true, `${robot.name} (${robot.id}${robot.fingerprint ? `, fingerprint ${robot.fingerprint}` : ""}), ${robot.simulated ? "a simulation" : "a PHYSICAL robot"}.`);
    // 3. Permission: the same chain as every command, for the manual-control class.
    const context = await manager.chainContext(db, userId, robot);
    if (context.teleop) await refuse("permission", "manual-control-held", `${context.teleop.operator} already holds manual control of ${robot.name}.`);
    const target = autonomy.TELEOP_MODES.has(robot.operatingMode) ? robot.operatingMode : "manual";
    const verdict = chain.evaluate({ stage: "preflight", identity: { userId, source: "teleop" }, account: context.account, robot: { ...robot, operatingMode: target }, capabilityId: "stop_motion", commandClass: "teleop", gateway: { violations: readiness(robot) }, policy: context.policy, now: at });
    const policyBlocks = ["read_only", "suggest_only"].includes(context.policy.policy) ? `The robot autonomy policy is “${autonomy.POLICIES[context.policy.policy].label}”, so no command but a stop reaches robots.` : null;
    if (!verdict.ok) await refuse("permission", verdict.refusal.code, verdict.refusal.message, { chain: verdict.steps });
    if (policyBlocks) await refuse("permission", "policy-blocks-teleop", policyBlocks);
    if (!robot.simulated && robot.commissioning?.required && robot.commissioning.status !== "approved" && robot.commissioning.status !== "trial") await refuse("permission", "not-commissioned", `${robot.name} hasn't been commissioned, so it may not move, not even by hand.`);
    mark("permission", true, `Robots level ${context.account.level}, policy “${autonomy.POLICIES[context.policy.policy].label}”, robot ready.`);
    // 4. Mode transition
    if (target !== robot.operatingMode) {
      const structural = autonomy.transitionRefusal(robot.operatingMode, target);
      if (structural) await refuse("mode-transition", structural.code, structural.message);
      const problems = manager.readiness(robot, target);
      if (problems.length) await refuse("mode-transition", problems[0].code, problems.map((item) => item.message).join(" "));
    }
    // Claim the robot: the unique index lets only one open session exist, whoever asks at the same moment.
    const id = `to_${crypto.randomBytes(9).toString("hex")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const limits = autonomy.teleopLimits(robot, robot.safetyProfile, target);
    if (!finite(limits.maxLinearSpeed) || !finite(limits.maxAngularSpeed)) await refuse("permission", "no-speed-limit", `${robot.name} didn't report speed limits, so it can't be driven by hand.`);
    try {
      await db.query(
        `INSERT INTO hannah_robot_teleop_sessions (user_id, id, robot_id, operator, operator_session, token_hash, status, steps, previous_mode, limits, created_at, updated_at, last_input_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'activating', $7, $8, $9, $10, $10, $10)`,
        [userId, id, robot.id, clean(operator, 120), operatorSession ? clean(operatorSession, 80) : null, sha256(token), JSON.stringify(steps), robot.operatingMode, JSON.stringify(limits), at],
      );
    } catch {
      await refuse("permission", "manual-control-held", `Someone else just took manual control of ${robot.name}.`);
    }
    const before = robot.operatingMode;
    if (target !== before) {
      await db.query("UPDATE hannah_robots SET operating_mode = $1, mode_changed_at = $2 WHERE user_id = $3 AND id = $4", [target, at, userId, robot.id]);
      await manager.audit(db, userId, { robotId: robot.id, kind: "mode", actor: operator, summary: `${autonomy.MODES[before].label} → ${autonomy.MODES[target].label}, for manual control.`, detail: { from: before, to: target, session: id } });
    }
    mark("mode-transition", true, target === before ? `Stays in ${autonomy.MODES[target].label}.` : `${autonomy.MODES[before].label} → ${autonomy.MODES[target].label}.`);
    // 5. Mission handling
    const ended = [];
    for (const row of (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status IN ('queued', 'running')", [userId, robot.id])).rows) {
      await core.endPlan(db, row, "cancelled", "An operator took manual control.", at);
      ended.push(`plan “${clean(row.title, 60)}”`);
    }
    for (const mission of await core.listMissions(db, userId, { robotId: robot.id, active: true, limit: 100 })) {
      if (mission.capability === "stop_motion") continue;
      await core.cancelMission(db, userId, mission.id);
      ended.push(`mission ${mission.id} (${mission.title})`);
    }
    mark("mission-handling", true, ended.length ? `Cancelled: ${ended.join(", ")}.` : "Nothing was running.");
    // 6. Manual activation: a new mode number carries the session to the robot.
    const seq = await core.nextSeq(db, robot.id);
    await db.query("UPDATE hannah_robots SET mode_seq = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [seq, at, userId, robot.id]);
    mark("manual-activation", null, "Waiting for the robot to confirm.");
    // 7 and 8.
    mark("operator-visibility", true, `Shown on ${robot.name}'s record: ${operator}, since ${new Date(at).toISOString().slice(11, 19)} UTC.`);
    mark("audit", true, "Every step is in the safety audit.");
    await db.query("UPDATE hannah_robot_teleop_sessions SET steps = $1 WHERE user_id = $2 AND id = $3", [JSON.stringify(steps), userId, id]);
    await manager.audit(db, userId, { robotId: robot.id, kind: "teleop", actor: operator, summary: `Manual control handed to ${clean(operator, 80)}${ended.length ? `; cancelled ${ended.length} task${ended.length === 1 ? "" : "s"}` : ""}. Waiting for the robot to confirm.`, detail: { session: id, steps, limits } });
    await core.addEvent(db, userId, robot.id, { type: "teleop-started", severity: "warning", message: `${clean(operator, 80)} is taking manual control.` });
    return { ...(await view(db, userId, robot.id)), token };
  }

  /** The operator's screen proves it holds the session. */
  async function authorize(db, userId, robotId, sessionId, token) {
    const row = await sessionRow(db, userId, robotId, sessionId);
    if (!row) return { row: null, authorization: { kind: "teleop", ok: false, code: "no-session", reason: "That manual-control session doesn't exist." } };
    const good = typeof token === "string" && token.length > 10 && crypto.timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(row.token_hash));
    if (!good) return { row, authorization: { kind: "teleop", ok: false, code: "not-operator", reason: "Only the operator's own screen can drive the robot." } };
    if (row.status === "activating") return { row, authorization: { kind: "teleop", ok: false, code: "robot-not-confirmed", reason: "The robot hasn't confirmed manual control yet." } };
    if (row.status !== "active") return { row, authorization: { kind: "teleop", ok: false, code: "session-ended", reason: `This session ended${row.end_reason ? `: ${row.end_reason}` : ""}.` } };
    return { row, authorization: { kind: "teleop", ok: true } };
  }

  /** One velocity command: through the chain, clamped to the limits, kept for a short time; only the newest counts. */
  async function command(db, userId, robotId, sessionId, { token, seq, linear, angular } = {}) {
    const at = now();
    const robot = await core.getRobot(db, userId, robotId);
    let { row, authorization } = await authorize(db, userId, robot.id, sessionId, token);
    if (row) { row = await sweep(db, userId, row, robot, at); if (!["active", "activating"].includes(row.status)) authorization = { kind: "teleop", ok: false, code: "session-ended", reason: `This session ended${row.end_reason ? `: ${row.end_reason}` : ""}.` }; }
    const number = Number(seq);
    const v = Number(linear);
    const w = Number(angular);
    if (!Number.isSafeInteger(number) || number <= 0 || !Number.isFinite(v) || !Number.isFinite(w)) throw fail(400, "A command needs a sequence number and linear and angular speeds.", "bad-request");
    const context = await manager.chainContext(db, userId, robot, { stage: "execute", authorization });
    const activeMotion = await core.activeMotion(db, userId, robot.id);
    const verdict = chain.evaluate({ stage: "execute", identity: { userId, source: "teleop" }, account: context.account, authorization, robot, capabilityId: "stop_motion", commandClass: "teleop", gateway: { violations: readiness(robot) }, policy: context.policy, activeMotion, now: at });
    if (!verdict.ok) throw fail(409, verdict.refusal.message, verdict.refusal.code, { step: verdict.refusal.step, chain: verdict.steps });
    const limits = parse(row.limits, {});
    const clamp = (value, max) => Math.max(-max, Math.min(max, value));
    const sent = { linear: round(clamp(v, limits.maxLinearSpeed)), angular: round(clamp(w, limits.maxAngularSpeed)) };
    const clamped = sent.linear !== round(v) || sent.angular !== round(w);
    // Newer only: a late or repeated command is dropped, never applied after a newer one.
    const stored = await db.query("UPDATE hannah_robot_teleop_sessions SET cmd = $1, cmd_seq = $2, cmd_received_at = $3, cmd_expires_at = $4, last_input_at = $3, updated_at = $3 WHERE user_id = $5 AND id = $6 AND status = 'active' AND cmd_seq < $2",
      [JSON.stringify({ ...sent, clamped }), number, at, at + limits.commandTtlMs, userId, row.id]);
    if (!stored.rowCount) throw fail(409, "A newer command was already received; this one was dropped.", "stale-sequence");
    return { accepted: true, seq: number, ...sent, clamped, expiresAt: at + limits.commandTtlMs, receivedAt: at };
  }

  async function end(db, userId, robotId, sessionId, { actor, reason = "ended by the operator" } = {}) {
    const robot = await core.getRobot(db, userId, robotId);
    const row = await sessionRow(db, userId, robot.id, sessionId);
    if (!row) throw fail(404, "That manual-control session doesn't exist.", "not-found");
    await manager.endSession(db, userId, row, actor && actor !== row.operator ? `${reason} (by ${clean(actor, 80)})` : reason);
    return view(db, userId, robot.id);
  }

  /**
   * During an exchange with the robot: confirm activation, record what it
   * applied, and hand back the newest fresh command (unsigned; sync signs it).
   */
  async function forSync(db, row, robot, at) {
    let session = (await db.query("SELECT * FROM hannah_robot_teleop_sessions WHERE robot_id = $1 AND status IN ('activating', 'active') ORDER BY created_at DESC", [row.id])).rows[0] || null;
    if (!session) return { session: null, commands: [], fast: false };
    const reported = robot.reportedOperatingMode;
    if (session.status === "activating" && reported?.session === session.id && reported.seq === Number(row.mode_seq)) {
      const steps = parse(session.steps, []).map((step) => (step.id === "manual-activation" ? { ...step, ok: true, detail: `${robot.name} confirmed it took manual control.`, at } : step));
      const won = await db.query("UPDATE hannah_robot_teleop_sessions SET status = 'active', activated_at = $1, last_input_at = $1, steps = $2, updated_at = $1 WHERE id = $3 AND status = 'activating'", [at, JSON.stringify(steps), session.id]);
      if (won.rowCount) {
        await manager.audit(db, row.user_id, { robotId: row.id, kind: "teleop", actor: session.operator, summary: `${robot.name} confirmed manual control by ${clean(session.operator, 80)}.`, detail: { session: session.id } });
        session = { ...session, status: "active", activated_at: at, last_input_at: at, steps: JSON.stringify(steps) };
      }
    }
    session = await sweep(db, row.user_id, session, robot, at);
    if (!["activating", "active"].includes(session.status)) return { session: null, commands: [], fast: false };
    const applied = robot.state?.teleop;
    if (applied?.session === session.id && Number(applied.seq) > Number(session.acked_seq)) {
      await db.query("UPDATE hannah_robot_teleop_sessions SET acked_seq = $1, acked_at = $2 WHERE id = $3", [Math.round(Number(applied.seq)), at, session.id]);
    }
    const commands = [];
    const quiet = at - Number(session.last_input_at || 0) > OPERATOR_QUIET_MS;
    if (session.status === "active" && session.cmd && !quiet && Number(session.cmd_seq) > Number(session.delivered_seq) && Number(session.cmd_expires_at) > at) {
      const cmd = parse(session.cmd, {});
      commands.push({ type: "teleop", session: session.id, seq: Number(session.cmd_seq), linear: cmd.linear, angular: cmd.angular, issuedAt: Number(session.cmd_received_at), expiresAt: Number(session.cmd_expires_at) });
      await db.query("UPDATE hannah_robot_teleop_sessions SET delivered_seq = $1, delivered_at = $2 WHERE id = $3 AND delivered_seq < $1", [Number(session.cmd_seq), at, session.id]);
    }
    return { session: { id: session.id, status: session.status }, commands, fast: true };
  }

  return { STEPS, command, end, forSync, start, view };
}

module.exports = { ACTIVATION_MS, OPERATOR_GONE_MS, OPERATOR_QUIET_MS, STEPS, createTeleop };
