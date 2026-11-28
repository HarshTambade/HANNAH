"use strict";

/**
 * The Safety and Autonomy Manager, server side: operating modes, safety
 * profiles, autonomy policies and their audit. The rules are in autonomy.js
 * (pure); this file stores them, applies them to a robot and records every
 * change. Teleoperation is teleop.js.
 *
 * Who may do what:
 *   - entering Safety Stop: anyone who may stop the robot (it only reduces
 *     what happens), and the robot itself;
 *   - every other mode change, a safety profile, the account's autonomy
 *     policy: a signed-in person (the routes refuse a developer key), and
 *     each change is audited with who, when, before and after;
 *   - a team's autonomy policy: that team's owner or a manager. It applies to
 *     every member and can only make their own policy stricter.
 */
const crypto = require("node:crypto");
const autonomy = require("./autonomy");
const contract = require("./contract");
const permissions = require("../actions/permissions");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function createSafetyManager({ now, core }) {
  // ---------- audit ----------
  async function audit(db, userId, { robotId = null, kind, actor, summary, detail = null }) {
    await db.query("INSERT INTO hannah_robot_safety_audit (user_id, id, robot_id, at, kind, actor, summary, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [userId, crypto.randomUUID(), robotId, now(), clean(kind, 20), clean(actor, 120) || "unknown", clean(summary, 500), detail ? JSON.stringify(detail).slice(0, 8000) : null]);
  }
  async function auditList(db, userId, { robotId, limit = 40 } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (robotId) { values.push(String(robotId)); where += ` AND (robot_id = $${values.length} OR robot_id IS NULL)`; }
    values.push(Math.max(1, Math.min(200, Number(limit) || 40)));
    const { rows } = await db.query(`SELECT * FROM hannah_robot_safety_audit WHERE ${where} ORDER BY at DESC LIMIT $${values.length}`, values);
    return rows.map((row) => ({ id: row.id, robotId: row.robot_id || null, at: Number(row.at), kind: row.kind, actor: row.actor, summary: row.summary, detail: parse(row.detail) }));
  }

  // ---------- autonomy policies ----------
  const policyRow = (row, scope, name = "") => (row ? { scope, scopeId: row.scope_id, name, policy: row.policy, missions: parse(row.missions, []), updatedBy: row.updated_by || "", updatedAt: Number(row.updated_at) } : null);
  async function teamsOf(db, userId) {
    return (await db.query("SELECT t.id, t.name, m.role FROM hannah_team_members m JOIN hannah_teams t ON t.id = m.team_id WHERE m.user_id = $1", [userId]).catch(() => ({ rows: [] }))).rows;
  }
  /** The account's own policy, every team policy that applies to it, and the strictest of them. */
  async function policyFor(db, userId) {
    const own = policyRow((await db.query("SELECT * FROM hannah_robot_autonomy_policies WHERE scope = 'account' AND scope_id = $1", [userId])).rows[0], "account", "Your account");
    const teams = [];
    for (const team of await teamsOf(db, userId)) {
      const found = policyRow((await db.query("SELECT * FROM hannah_robot_autonomy_policies WHERE scope = 'team' AND scope_id = $1", [team.id])).rows[0], "team", team.name);
      teams.push({ teamId: team.id, name: team.name, role: team.role, canSet: ["owner", "manager"].includes(team.role), policy: found });
    }
    const effective = autonomy.combinePolicies([own, ...teams.map((team) => team.policy)].filter(Boolean));
    return { account: own, teams, effective, policies: autonomy.POLICIES, default: autonomy.DEFAULT_POLICY, note: "The strictest policy that applies wins. There is no setting that turns the checks off." };
  }
  async function writePolicy(db, scope, scopeId, normalized, actor) {
    const at = now();
    const updated = await db.query("UPDATE hannah_robot_autonomy_policies SET policy = $1, missions = $2, updated_by = $3, updated_at = $4 WHERE scope = $5 AND scope_id = $6", [normalized.policy, JSON.stringify(normalized.missions), clean(actor, 120), at, scope, scopeId]);
    if (!updated.rowCount) await db.query("INSERT INTO hannah_robot_autonomy_policies (scope, scope_id, policy, missions, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)", [scope, scopeId, normalized.policy, JSON.stringify(normalized.missions), clean(actor, 120), at]);
  }
  async function setAccountPolicy(db, userId, input, actor) {
    const normalized = autonomy.normalizePolicy(input);
    if (normalized.error) throw fail(400, normalized.error, "bad-policy");
    const before = (await policyFor(db, userId)).account;
    await writePolicy(db, "account", userId, normalized, actor);
    await audit(db, userId, { kind: "policy", actor, summary: `Account autonomy policy set to “${autonomy.POLICIES[normalized.policy].label}”${normalized.missions.length ? ` (${normalized.missions.join(", ")})` : ""}.`, detail: { scope: "account", before: before ? { policy: before.policy, missions: before.missions } : null, after: normalized } });
    return policyFor(db, userId);
  }
  async function setTeamPolicy(db, userId, teamId, input, actor) {
    const team = (await teamsOf(db, userId)).find((item) => item.id === String(teamId));
    if (!team) throw fail(404, "You aren't a member of that team.", "not-found");
    if (!["owner", "manager"].includes(team.role)) throw fail(403, "Only the team's owner or a manager can set its robot autonomy policy.", "forbidden");
    const normalized = autonomy.normalizePolicy(input);
    if (normalized.error) throw fail(400, normalized.error, "bad-policy");
    const before = policyRow((await db.query("SELECT * FROM hannah_robot_autonomy_policies WHERE scope = 'team' AND scope_id = $1", [team.id])).rows[0], "team", team.name);
    await writePolicy(db, "team", team.id, normalized, actor);
    // Recorded for whoever made the change and for every member it now applies to.
    const members = (await db.query("SELECT user_id FROM hannah_team_members WHERE team_id = $1", [team.id])).rows.map((row) => row.user_id);
    for (const member of new Set([userId, ...members])) {
      await audit(db, member, { kind: "policy", actor, summary: `Team “${team.name}” robot autonomy policy set to “${autonomy.POLICIES[normalized.policy].label}”${normalized.missions.length ? ` (${normalized.missions.join(", ")})` : ""}.`, detail: { scope: "team", teamId: team.id, before: before ? { policy: before.policy, missions: before.missions } : null, after: normalized } });
    }
    return policyFor(db, userId);
  }

  // ---------- what the chain needs about the account and the robot ----------
  async function openSession(db, robotId) {
    const row = (await db.query("SELECT * FROM hannah_robot_teleop_sessions WHERE robot_id = $1 AND status IN ('activating', 'active') ORDER BY created_at DESC", [robotId])).rows[0];
    return row ? { id: row.id, operator: row.operator, status: row.status, row } : null;
  }
  /** The Action Engine record behind a command, as the chain reads it. */
  async function actionAuthorization(db, userId, recordId) {
    if (!recordId) return null;
    const row = (await db.query("SELECT status, permission, approval FROM hannah_actions WHERE user_id = $1 AND id = $2", [userId, String(recordId)])).rows[0];
    if (!row) return { kind: "action", status: "missing", outcome: null, approved: false };
    return { kind: "action", status: row.status, outcome: parse(row.permission, {})?.outcome || null, approved: parse(row.approval, {})?.status === "approved" };
  }
  async function chainContext(db, userId, robot, { stage = "preflight", authorization = null } = {}) {
    const account = await permissions.loadPolicy(db, userId);
    const resolved = authorization?.kind === "action-record" ? await actionAuthorization(db, userId, authorization.recordId) : authorization;
    return {
      stage, account: { level: account.levels.robots, stopped: Boolean(account.stoppedAt) },
      policy: (await policyFor(db, userId)).effective,
      teleop: robot?.id ? await openSession(db, robot.id) : null,
      authorization: resolved,
    };
  }

  // ---------- safety profiles ----------
  async function setProfile(db, userId, robotId, input, actor) {
    const row = await core.robotRow(db, userId, robotId);
    if (!row) throw fail(404, "That robot isn't enrolled in your account.", "not-found");
    const robot = core.view(row);
    const hardware = robot.safety.reported || {};
    const { profile, problems } = autonomy.normalizeProfile(input || {}, hardware);
    if (problems.length) throw fail(400, problems.join(" "), "bad-profile", { problems });
    const before = robot.safety.profile || null;
    await db.query("UPDATE hannah_robots SET safety = $1, config_version = config_version + 1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify({ ...robot.safety, profile }), now(), userId, row.id]);
    await audit(db, userId, { robotId: row.id, kind: "profile", actor, summary: `Safety profile ${before ? "changed" : "set"}${Object.keys(profile).length ? `: ${Object.keys(profile).join(", ")}` : " (empty: only the robot's own limits apply)"}.`, detail: { before, after: profile } });
    await core.addEvent(db, userId, row.id, { type: "safety-profile", severity: "warning", message: `The safety profile was ${before ? "changed" : "set"} by ${clean(actor, 80)}.` });
    return autonomyView(db, userId, row.id);
  }

  // ---------- operating modes ----------
  /** What must be true for this robot to enter `to` now. Returns [{ code, message }]. */
  function readiness(robot, to, { session = null } = {}) {
    const problems = [];
    const no = (code, message) => problems.push({ code, message });
    const state = robot.state || {};
    const name = robot.name;
    if (to === "safety_stop") return problems;
    if (robot.status !== "enrolled") no("not-enrolled", `${name} isn't enrolled.`);
    if (!robot.online) no("offline", `${name} isn't connected, so its condition can't be checked.`);
    if (state.estop?.engaged) no("estop-engaged", `${name}'s emergency stop is engaged. Release it at the robot first.`);
    const current = robot.operatingMode;
    if (current === "safety_stop" && to !== "maintenance" && Array.isArray(state.faults) && state.faults.length) no("fault", `${name} reports a fault (${clean(state.faults[0]?.message || state.faults[0]?.code, 100)}). Clear it, or go to Maintenance.`);
    if (autonomy.AUTONOMOUS.has(to)) {
      // Restoring autonomy: only from a robot that is demonstrably ready, never with an operator still holding it.
      if (session) no("manual-control-held", `${session.operator} holds manual control. End the session first.`);
      if (Array.isArray(state.faults) && state.faults.length) no("fault", `${name} reports a fault.`);
      if (state.motorsEnabled === false) no("motors-disabled", `${name}'s motors are disabled.`);
      if (state.localized === false) no("not-localized", `${name} doesn't know where it is on its map.`);
      const moving = Math.abs(Number(state.velocity?.linear) || 0) > 0.03 || Math.abs(Number(state.velocity?.angular) || 0) > 0.08;
      if (moving) no("moving", `${name} is still moving. It must stand still first.`);
      if (robot.reportedOperatingMode && robot.reportedOperatingMode.mode !== robot.operatingMode) no("robot-not-confirmed", `${name} hasn't confirmed its current mode yet (it reports ${robot.reportedOperatingMode.mode}).`);
      const profile = robot.safetyProfile;
      const pose = state.pose;
      if (profile?.operatingArea && finite(pose?.x) && finite(pose?.y) && !autonomy.pointInPolygon(pose, profile.operatingArea.polygon)) no("outside-operating-area", `${name} is outside its operating area. Drive it back in by hand first.`);
      for (const zone of profile?.geofences || []) if (finite(pose?.x) && autonomy.pointInPolygon(pose, zone.polygon)) no("in-geofence", `${name} is inside the geofence “${zone.name}”.`);
      const minimum = robot.limits.minBatteryPercent;
      if (finite(minimum) && finite(state.battery?.percent) && state.battery.percent < minimum) no("battery", `${name}'s battery is at ${Math.round(state.battery.percent)}%, below its ${minimum}% minimum.`);
      if (!robot.simulated && robot.commissioning?.required && robot.commissioning.status !== "approved") no("not-commissioned", `${name} hasn't been commissioned.`);
      if (to === "mission" && !robot.simulated && !robot.safetyProfile?.operatingArea) no("no-operating-area", `A physical robot needs a safety profile with an operating area before Mission Autonomy.`);
    }
    return problems;
  }

  async function transitionsFor(db, robot) {
    const session = await openSession(db, robot.id);
    return autonomy.MODE_IDS.filter((id) => id !== robot.operatingMode).map((to) => {
      const structural = autonomy.transitionRefusal(robot.operatingMode, to);
      const reasons = structural ? [structural] : readiness(robot, to, { session });
      return { to, label: autonomy.MODES[to].label, allowed: reasons.length === 0, reasons };
    });
  }

  /**
   * Change a robot's operating mode. Safety Stop goes through the existing stop:
   * every plan and mission ends and a signed stop is sent; the robot holds and
   * refuses everything but stopping until a person moves it out.
   */
  async function setMode(db, userId, robotId, to, { actor, person = false, reason = "", source = "robots" } = {}) {
    const robot = await core.getRobot(db, userId, robotId);
    const from = robot.operatingMode;
    const target = String(to || "");
    if (target === from && target === "safety_stop") return autonomyView(db, userId, robot.id);
    const structural = autonomy.transitionRefusal(from, target);
    if (structural) throw fail(409, structural.message, structural.code);
    if (target !== "safety_stop" && !person) throw fail(403, "Only a signed-in person can change a robot's operating mode, except into Safety Stop.", "person-required");
    const session = await openSession(db, robot.id);
    // Leaving the modes in which an operator drives it ends their manual control first, except to another such mode.
    if (session && !autonomy.TELEOP_MODES.has(target) && target !== "safety_stop") throw fail(409, `${session.operator} holds manual control. End the session before changing to ${autonomy.MODES[target].label}.`, "manual-control-held");
    const problems = readiness(robot, target, { session });
    if (problems.length) throw fail(409, `${robot.name} can't change to ${autonomy.MODES[target].label}: ${problems.map((item) => item.message).join(" ")}`, problems[0].code, { problems });
    const at = now();
    if (target === "safety_stop") {
      if (session) await endSession(db, userId, session.row, "safety-stop", at);
      if (robot.status === "enrolled") await core.stop(db, userId, robot, { reason: reason || "Safety Stop", requestedBy: "safety stop", identity: { userId, source }, authorization: { kind: "system" } }).catch(() => null);
    } else {
      // Work the new mode doesn't allow ends now rather than being refused at the robot later.
      for (const mission of await core.listMissions(db, userId, { robotId: robot.id, active: true, limit: 100 })) {
        const kind = autonomy.commandClass(mission.capability);
        const refused = autonomy.modeRefusal({ mode: target, commandClass: kind, origin: mission.origin || "agent", plan: Boolean(mission.planId), robotName: robot.name });
        if (refused) await core.cancelMission(db, userId, mission.id);
      }
      if (target !== "mission") {
        for (const row of (await db.query("SELECT * FROM hannah_robot_plans WHERE user_id = $1 AND robot_id = $2 AND status IN ('queued', 'running')", [userId, robot.id])).rows) {
          await core.endPlan(db, row, "cancelled", `The robot changed to ${autonomy.MODES[target].label}, where plans don't run.`, at);
        }
      }
    }
    const seq = await core.nextSeq(db, robot.id);
    await db.query("UPDATE hannah_robots SET operating_mode = $1, mode_seq = $2, mode_changed_at = $3, updated_at = $3 WHERE user_id = $4 AND id = $5", [target, seq, at, userId, robot.id]);
    await audit(db, userId, { robotId: robot.id, kind: "mode", actor, summary: `${autonomy.MODES[from].label} → ${autonomy.MODES[target].label}${reason ? `: ${clean(reason, 200)}` : ""}.`, detail: { from, to: target, seq, reason: clean(reason, 300) } });
    await core.addEvent(db, userId, robot.id, { type: "operating-mode", severity: target === "safety_stop" ? "warning" : "info", message: `Operating mode ${autonomy.MODES[from].label} → ${autonomy.MODES[target].label} (${clean(actor, 80)}).` });
    return autonomyView(db, userId, robot.id);
  }

  /** End a teleoperation session (used by teleop.js and by Safety Stop). The robot keeps its mode and holds. */
  async function endSession(db, userId, row, reason, at = now()) {
    const ended = await db.query("UPDATE hannah_robot_teleop_sessions SET status = 'ended', ended_at = $1, end_reason = $2, cmd = NULL, cmd_expires_at = NULL, updated_at = $1 WHERE user_id = $3 AND id = $4 AND status IN ('activating', 'active')", [at, clean(reason, 120), userId, row.id]);
    if (!ended.rowCount) return false;
    // A new mode number tells the robot the session is over even though the mode stays the same.
    const seq = await core.nextSeq(db, row.robot_id);
    await db.query("UPDATE hannah_robots SET mode_seq = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [seq, at, userId, row.robot_id]);
    await audit(db, userId, { robotId: row.robot_id, kind: "teleop", actor: row.operator, summary: `Manual control ended: ${clean(reason, 160)}. The robot holds; autonomy returns only after a person restores it.`, detail: { session: row.id, reason } });
    await core.addEvent(db, userId, row.robot_id, { type: "teleop-ended", severity: "info", message: `Manual control by ${clean(row.operator, 80)} ended: ${clean(reason, 160)}.` });
    return true;
  }

  async function autonomyView(db, userId, robotId) {
    const robot = await core.getRobot(db, userId, robotId);
    const session = await openSession(db, robot.id);
    return {
      robotId: robot.id, mode: robot.operatingMode, label: autonomy.MODES[robot.operatingMode].label, description: autonomy.MODES[robot.operatingMode].description,
      defaultMode: autonomy.defaultMode(robot), modeChangedAt: robot.modeChangedAt, reported: robot.reportedOperatingMode, confirmed: !robot.modeSeq || robot.reportedOperatingMode?.seq === robot.modeSeq,
      modes: Object.entries(autonomy.MODES).map(([id, item]) => ({ id, ...item, next: autonomy.TRANSITIONS[id] })),
      transitions: await transitionsFor(db, robot),
      profile: robot.safetyProfile, hardwareLimits: robot.safety.reported || {}, limits: robot.limits,
      teleopLimits: autonomy.teleopLimits(robot, robot.safetyProfile, robot.operatingMode),
      policy: await policyFor(db, userId),
      teleop: session ? { id: session.id, operator: session.operator, status: session.status } : null,
      audit: await auditList(db, userId, { robotId: robot.id, limit: 30 }),
      capabilities: robot.capabilities.filter((id) => contract.capability(id)?.motion),
      estop: { engaged: Boolean(robot.state?.estop?.engaged), hardware: Boolean(robot.limits.estop?.hardware), note: "The emergency stop is the robot's own circuit. HANNAH reads it; nothing here can release or replace it." },
      disclaimer: "Operating modes and safety profiles are software checks on HANNAH's server and in the robot's runtime. They are not a certified safety function.",
    };
  }

  /** The signed mode command the robot should hear now, or null. */
  function modeCommand(row, robot, session, limits) {
    const seq = Number(row.mode_seq) || 0;
    if (!seq) return null;
    const reported = robot.reportedOperatingMode;
    const wantSession = session?.status === "activating" || session?.status === "active" ? session.id : null;
    if (reported && reported.refusedSeq === seq) return null; // the robot refused this one; it is shown, not repeated
    if (reported && reported.seq === seq && (reported.session || null) === wantSession) return null;
    return {
      type: "mode", mode: robot.operatingMode, modeSeq: seq, issuedAt: Number(row.mode_changed_at) || now(),
      // The robot clamps and checks manual control itself: these limits, and the profile's areas.
      teleop: wantSession ? {
        session: wantSession, deadmanMs: limits.deadmanMs, maxLinearSpeed: limits.maxLinearSpeed ?? null, maxAngularSpeed: limits.maxAngularSpeed ?? null,
        ...(robot.safetyProfile?.operatingArea || robot.safetyProfile?.geofences?.length ? { areas: { keepIn: robot.safetyProfile.operatingArea ? [robot.safetyProfile.operatingArea] : [], keepOut: robot.safetyProfile.geofences || [] } } : {}),
      } : null,
    };
  }

  /** The robot is authoritative about being stopped: a Safety Stop it entered by itself is adopted and recorded. */
  async function reconcile(db, row, robot) {
    const reported = robot.reportedOperatingMode;
    if (reported?.mode === "safety_stop" && robot.operatingMode !== "safety_stop" && reported.local) {
      const seq = await core.nextSeq(db, row.id);
      await db.query("UPDATE hannah_robots SET operating_mode = 'safety_stop', mode_seq = $1, mode_changed_at = $2 WHERE id = $3", [seq, now(), row.id]);
      await audit(db, row.user_id, { robotId: row.id, kind: "mode", actor: "the robot", summary: `${autonomy.MODES[robot.operatingMode].label} → Safety Stop, entered by the robot itself${reported.reason ? `: ${clean(reported.reason, 160)}` : ""}.`, detail: { from: robot.operatingMode, to: "safety_stop", seq, local: true } });
      return true;
    }
    // A mode the robot refused is reported by the robot in its own events; the server neither repeats it nor pretends it took effect.
    return false;
  }

  return { audit, auditList, autonomyView, chainContext, endSession, modeCommand, openSession, policyFor, readiness, reconcile, setAccountPolicy, setMode, setProfile, setTeamPolicy, transitionsFor };
}

module.exports = { createSafetyManager };
