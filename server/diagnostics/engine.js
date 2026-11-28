"use strict";

/**
 * Self-diagnostics and recovery, for the server and the robots, hubs and
 * devices an account connected.
 *
 * Every problem a check finds goes through the same thirteen steps, each
 * recorded on its incident with what happened at it:
 *
 *    1 detect           which check failed, with what it measured
 *    2 component        the subsystem (os, runtime, hardware, ai) and component
 *    3 telemetry        the measurements behind it
 *    4 logs             the related events the robot, hub or server recorded
 *    5 dependencies     what the component depends on
 *    6 severity         info, warning or error
 *    7 causes           possible causes (never claimed as the cause)
 *    8 diagnosis        what the evidence supports, and that it is unconfirmed
 *    9 suggested        the recovery actions that fit, with their policies
 *   10 permission       the policy and who is asking: run, ask, admin, prohibited
 *   11 remediation      only an allowed, reversible action, and only once in a while
 *   12 verify           the action's own check, then the failing check again
 *   13 log              the audit trail (hannah_ops_audit)
 *
 * Nothing here changes motor safety, emergency stops, power, hazardous
 * equipment or motion-controller safety settings: those actions are
 * prohibited in recovery.js and never run, whoever asks.
 */
const crypto = require("node:crypto");
const { audit, list: auditList } = require("../ops-audit");
const { accountChecks, serverChecks } = require("./checks");
const { checkOllama, checkPythonFallback } = require("../health");
const gatewayModule = require("../gateway");

const STEPS = ["detect", "component", "telemetry", "logs", "dependencies", "severity", "causes", "diagnosis", "suggested", "permission", "remediation", "verify", "log"];
const OPEN = "('open', 'waiting-approval', 'needs-admin', 'needs-person', 'recovering', 'failed')";
const RETRY_AFTER_MS = 10 * 60_000;
const MAX_AUTOMATIC = 3;

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function createDiagnosticsEngine({ now = () => Date.now(), robotics = null, devices = null, robotOSEnvelopes = null, registry, actionEngine = () => null, probes = {}, gateway = gatewayModule } = {}) {
  const ollama = probes.ollama || checkOllama;
  const pythonFallback = probes.pythonFallback || checkPythonFallback;
  const extraServerChecks = probes.serverChecks || null;

  // ---------- collecting ----------
  function problemsOf(checks) {
    const out = [];
    for (const item of checks) {
      for (const problem of [...(item.problem ? [item.problem] : []), ...(item.problems || [])]) {
        const scope = item.target === "server" ? "server" : "account";
        out.push({ ...problem, scope, target: item.target === "account" ? "account" : item.target, targetName: item.targetName || (item.target === "server" ? "this server" : "your account"), subsystem: item.subsystem, component: item.component, checkId: item.id, measured: problem.measured || item.measured, evidence: item.evidence, simulated: Boolean(item.simulated), fingerprint: `${scope}|${item.target}|${problem.code}|${problem.key || ""}` });
      }
    }
    return out;
  }
  async function collect(db, { userId, includeServer }) {
    const at = now();
    const server = includeServer ? [...await serverChecks({ db, now: at, ollama, pythonFallback, gateway }), ...(extraServerChecks ? await extraServerChecks({ db, now: at }) : [])] : [];
    const account = userId ? await accountChecks({ db, userId, now: at, robotics, devices, robotOSEnvelopes }) : [];
    return { checks: [...server, ...account], at };
  }

  // ---------- incidents ----------
  function publicIncident(row, recoveries = []) {
    const detail = parse(row.detail, {});
    return { id: row.id, scope: row.scope, server: row.user_id === null, targetId: row.target_id, subsystem: row.subsystem, component: row.component, problem: row.problem, severity: row.severity, status: row.status, title: row.title, occurrences: Number(row.occurrences), openedAt: Number(row.opened_at), updatedAt: Number(row.updated_at), resolvedAt: row.resolved_at ? Number(row.resolved_at) : null, ...detail, recoveries };
  }
  async function recoveriesFor(db, incidentId) {
    return (await db.query("SELECT * FROM hannah_diag_recoveries WHERE incident_id = $1 ORDER BY created_at DESC LIMIT 20", [incidentId])).rows.map(publicRecovery);
  }
  function publicRecovery(row) {
    return { id: row.id, incidentId: row.incident_id, action: row.action, policy: row.policy, status: row.status, targetId: row.target_id, requestedBy: row.requested_by, actionRecordId: row.action_record_id || null, params: parse(row.params, {}), result: parse(row.result), verification: parse(row.verification), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
  const ownerOf = (problem, userId) => (problem.scope === "server" ? null : userId);

  function lifecycleFor(problem, suggestions, at) {
    const step = (name, status, detail) => ({ step: name, n: STEPS.indexOf(name) + 1, status, detail, at });
    return [
      step("detect", "done", `${problem.checkId} reported ${problem.code}.`),
      step("component", "done", `${problem.subsystem} → ${problem.component}${problem.simulated ? " (simulated)" : ""}.`),
      step("telemetry", problem.measured ? "done" : "none", problem.measured ? problem.measured : "Nothing was measured for this check."),
      step("logs", (problem.logs || []).length ? "done" : "none", (problem.logs || []).length ? problem.logs : "No related log entries were recorded."),
      step("dependencies", "done", problem.dependencies || []),
      step("severity", "done", problem.severity),
      step("causes", "done", { possible: problem.causes || [], status: problem.confirmed ? "the device reported this itself; its cause is not confirmed" : "possible, not confirmed" }),
      step("diagnosis", "done", diagnosisText(problem)),
      step("suggested", suggestions.length ? "done" : "none", suggestions.length ? suggestions.map((item) => ({ action: item.action, title: item.title, policy: item.policy })) : (problem.manual || "No recovery action fits; a person has to look.")),
    ];
  }
  function diagnosisText(problem) {
    const measured = (problem.evidence || [])[0] || "";
    if (problem.confirmed) return `${problem.title}. ${measured} The device reported this itself.`;
    return `${problem.title}. ${measured} The evidence fits one of the possible causes listed; none is confirmed until someone checks.`.replace(/\s+/g, " ").trim();
  }

  async function upsertIncident(db, userId, problem, at) {
    const owner = ownerOf(problem, userId);
    const existing = (await db.query(`SELECT * FROM hannah_diag_incidents WHERE fingerprint = $1 AND status IN ${OPEN} AND ${owner ? "user_id = $2" : "user_id IS NULL"}`, owner ? [problem.fingerprint, owner] : [problem.fingerprint])).rows[0];
    const suggestions = (problem.recoveries || []).map((item) => { const action = registry.get(item.action); return action ? { action: action.id, title: action.title, policy: action.policy, params: item.params || {}, reversible: action.reversible } : null; }).filter(Boolean);
    const detail = { evidence: problem.evidence, measured: problem.measured || null, logs: problem.logs || [], dependencies: problem.dependencies || [], causes: problem.causes || [], causesStatus: problem.confirmed ? "reported by the device; cause not confirmed" : "possible, not confirmed", diagnosis: diagnosisText(problem), manual: problem.manual || null, suggestions, simulated: problem.simulated, targetName: problem.targetName, lifecycle: lifecycleFor(problem, suggestions, at) };
    if (existing) {
      const previous = parse(existing.detail, {});
      await db.query("UPDATE hannah_diag_incidents SET detail = $1, severity = $2, title = $3, occurrences = occurrences + 1, updated_at = $4 WHERE id = $5", [JSON.stringify({ ...detail, lifecycle: mergeLifecycle(previous.lifecycle, detail.lifecycle) }).slice(0, 60_000), problem.severity, clip(problem.title, 200), at, existing.id]);
      return { id: existing.id, created: false, status: existing.status, suggestions };
    }
    const id = `inc_${crypto.randomBytes(8).toString("hex")}`;
    await db.query("INSERT INTO hannah_diag_incidents (id, user_id, scope, target_id, subsystem, component, problem, fingerprint, severity, status, title, detail, occurrences, opened_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open', $10, $11, 1, $12, $12)",
      [id, owner, problem.scope, problem.target, problem.subsystem, clip(problem.component, 160), problem.code, problem.fingerprint, problem.severity, clip(problem.title, 200), JSON.stringify(detail).slice(0, 60_000), at]);
    await audit(db, { userId: owner, area: "diagnostics", subjectId: id, actor: "diagnostics", event: "incident-opened", detail: { problem: problem.code, target: problem.target, severity: problem.severity, evidence: problem.evidence }, at });
    return { id, created: true, status: "open", suggestions };
  }
  /** Keep the steps after "suggested" from earlier runs; refresh the first nine. */
  function mergeLifecycle(previous = [], fresh = []) {
    const later = (previous || []).filter((step) => step.n > 9);
    return [...fresh, ...later];
  }
  async function setLifecycle(db, incidentId, steps, status, at) {
    const row = (await db.query("SELECT detail FROM hannah_diag_incidents WHERE id = $1", [incidentId])).rows[0];
    const detail = parse(row?.detail, {});
    const kept = (detail.lifecycle || []).filter((step) => !steps.some((item) => item.step === step.step));
    detail.lifecycle = [...kept, ...steps].sort((a, b) => a.n - b.n);
    await db.query(`UPDATE hannah_diag_incidents SET detail = $1, ${status ? "status = $3, " : ""}updated_at = $2 WHERE id = $${status ? 4 : 3}`, status ? [JSON.stringify(detail).slice(0, 60_000), at, status, incidentId] : [JSON.stringify(detail).slice(0, 60_000), at, incidentId]);
  }
  const lifeStep = (name, status, detail, at) => ({ step: name, n: STEPS.indexOf(name) + 1, status, detail, at });

  // ---------- recovery ----------
  async function insertRecovery(db, { incidentId, userId, action, policy, status, targetId, requestedBy, params }) {
    const id = `rec_${crypto.randomBytes(8).toString("hex")}`;
    const at = now();
    await db.query("INSERT INTO hannah_diag_recoveries (id, incident_id, user_id, action, policy, status, target_id, requested_by, params, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)", [id, incidentId, userId, action, policy, status, targetId || "", clip(requestedBy, 120), JSON.stringify(params || {}), at]);
    return id;
  }
  async function updateRecovery(db, id, fields) {
    const names = Object.keys(fields);
    await db.query(`UPDATE hannah_diag_recoveries SET ${names.map((name, index) => `${name} = $${index + 1}`).join(", ")}, updated_at = $${names.length + 1} WHERE id = $${names.length + 2}`, [...names.map((name) => fields[name]), now(), id]);
  }

  /** Run an allowed action and check it. Returns the recovery's final record. */
  async function perform(db, { userId, incidentId, recoveryId, action, params, actor }) {
    const ctx = { db, userId, actor };
    const at = now();
    await updateRecovery(db, recoveryId, { status: "running" });
    await audit(db, { userId, area: "diagnostics", subjectId: recoveryId, actor: actor.label, event: `recovery-run:${action.id}`, detail: { incidentId, params, policy: action.policy }, at });
    let result;
    try {
      result = await action.run(ctx, params);
    } catch (error) {
      const message = error?.status ? error.message : `${action.title} failed (${error?.code || error?.name || "error"}).`;
      await updateRecovery(db, recoveryId, { status: "failed", result: JSON.stringify({ error: clip(message, 500) }) });
      await audit(db, { userId, area: "diagnostics", subjectId: recoveryId, actor: actor.label, event: "recovery-failed", detail: { error: clip(message, 500) } });
      if (incidentId) await setLifecycle(db, incidentId, [lifeStep("remediation", "failed", `${action.title}: ${clip(message, 300)}`, now()), lifeStep("verify", "none", "Nothing to verify: the action failed.", now()), lifeStep("log", "done", `Recorded as recovery ${recoveryId}.`, now())], "failed", now());
      return publicRecovery((await db.query("SELECT * FROM hannah_diag_recoveries WHERE id = $1", [recoveryId])).rows[0]);
    }
    let verification;
    try { verification = await action.verify(ctx, params, result); } catch (error) { verification = { confirmed: false, evidence: `The check afterwards failed: ${clip(error?.message, 200)}` }; }
    const status = verification.confirmed ? "verified" : verification.failed ? "failed" : "unverified";
    await updateRecovery(db, recoveryId, { status, result: JSON.stringify(result).slice(0, 20_000), verification: JSON.stringify({ ...verification, checkedAt: now() }) });
    await audit(db, { userId, area: "diagnostics", subjectId: recoveryId, actor: actor.label, event: `recovery-${status}`, detail: { action: action.id, evidence: verification.evidence } });
    if (incidentId) await setLifecycle(db, incidentId, [
      lifeStep("remediation", "done", `${action.title} (${action.policy}) run for ${actor.label}.`, at),
      lifeStep("verify", verification.confirmed ? "done" : verification.failed ? "failed" : "pending", verification.evidence, now()),
      lifeStep("log", "done", `Recorded as recovery ${recoveryId}.`, now()),
    ], verification.confirmed ? "recovering" : verification.failed ? "failed" : "recovering", now());
    return publicRecovery((await db.query("SELECT * FROM hannah_diag_recoveries WHERE id = $1", [recoveryId])).rows[0]);
  }

  /**
   * Ask for a recovery. The policy decides: run now, ask a person (through
   * the Action Engine), refuse because only an administrator may, or refuse
   * because it is prohibited. Every outcome is recorded.
   */
  async function requestRecovery(db, { userId = null, incidentId = null, action: actionId, params = {}, actor }) {
    const action = registry.get(actionId);
    if (!action) throw fail(404, "There is no recovery action with that name.", "unknown-action");
    let incident = null;
    if (incidentId) {
      incident = (await db.query("SELECT * FROM hannah_diag_incidents WHERE id = $1", [String(incidentId)])).rows[0];
      if (!incident || (incident.user_id !== null && incident.user_id !== userId)) throw fail(404, "That incident doesn't exist.", "not-found");
      if (incident.user_id === null && action.scope !== "server") throw fail(400, "That action doesn't apply to a server incident.", "bad-request");
    }
    const owner = action.scope === "server" ? null : userId;
    if (action.scope !== "server" && !userId) throw fail(401, "Sign in: robots and devices belong to an account.", "signin-required");
    const decision = await registry.decide({ db, userId, actor }, action.id, params);
    const targetId = String(params.robot || params.device || params.provider || "server");
    const at = now();
    const permissionStep = (detail, status = "done") => lifeStep("permission", status, detail, at);
    if (decision.decision === "prohibited" || decision.decision === "admin-required" || decision.decision === "unavailable") {
      const status = decision.decision === "prohibited" ? "prohibited" : decision.decision === "unavailable" ? "unavailable" : "refused";
      const recoveryId = await insertRecovery(db, { incidentId: incident?.id || null, userId: owner, action: action.id, policy: decision.policy || action.policy, status, targetId, requestedBy: actor.label, params });
      await updateRecovery(db, recoveryId, { result: JSON.stringify({ reason: decision.reason }) });
      await audit(db, { userId: owner, area: "diagnostics", subjectId: recoveryId, actor: actor.label, event: `recovery-${status}:${action.id}`, detail: { reason: decision.reason, incidentId: incident?.id || null }, at });
      if (incident) await setLifecycle(db, incident.id, [permissionStep(`${action.title}: ${decision.reason}`, "refused"), lifeStep("remediation", "none", decision.decision === "prohibited" ? `Not run: prohibited. ${action.manual || ""}`.trim() : "Not run.", at), lifeStep("log", "done", `Recorded as recovery ${recoveryId}.`, at)], decision.decision === "admin-required" ? "needs-admin" : "needs-person", at);
      const error = fail(decision.decision === "unavailable" ? 409 : 403, decision.reason, decision.decision);
      error.recoveryId = recoveryId;
      throw error;
    }
    if (decision.decision === "ask") {
      const engine = actionEngine();
      if (!engine) throw fail(503, "Approvals aren't available on this server.", "not-configured");
      const recoveryId = await insertRecovery(db, { incidentId: incident?.id || null, userId: owner, action: action.id, policy: action.policy, status: "waiting-approval", targetId, requestedBy: actor.label, params });
      const record = await engine.run(db, userId, { action: "diagnostics.recover", params: { recoveryId }, request: `Recovery: ${action.title}`, agent: actor.kind === "agent" ? actor.label : "", source: actor.kind === "agent" ? "agent" : "diagnostics" });
      await updateRecovery(db, recoveryId, { action_record_id: record.id, ...(record.status === "denied" ? { status: "refused", result: JSON.stringify({ reason: record.permission?.reason || "not allowed" }) } : {}) });
      await audit(db, { userId: owner, area: "diagnostics", subjectId: recoveryId, actor: actor.label, event: `recovery-approval-requested:${action.id}`, detail: { actionRecord: record.id, status: record.status, incidentId: incident?.id || null }, at });
      if (incident) await setLifecycle(db, incident.id, [permissionStep(`${action.title} needs a person's approval (${record.status === "denied" ? `refused: ${record.permission?.reason}` : "requested"}).`, record.status === "denied" ? "refused" : "waiting"), lifeStep("log", "done", `Recorded as recovery ${recoveryId}; approval ${record.id}.`, at)], record.status === "denied" ? "needs-person" : "waiting-approval", at);
      return { ...publicRecovery((await db.query("SELECT * FROM hannah_diag_recoveries WHERE id = $1", [recoveryId])).rows[0]), approval: { id: record.id, status: record.status } };
    }
    const recoveryId = await insertRecovery(db, { incidentId: incident?.id || null, userId: owner, action: action.id, policy: action.policy, status: "running", targetId, requestedBy: actor.label, params });
    if (incident) await setLifecycle(db, incident.id, [permissionStep(`${action.title}: ${decision.reason}`)], null, at);
    return perform(db, { userId: owner ?? userId, incidentId: incident?.id || null, recoveryId, action, params, actor });
  }

  /** The Action Engine calls this once a person approved a recovery. The stored action and parameters run, nothing sent with the approval. */
  async function executeApproved(db, userId, recoveryId, { by = "a signed-in person" } = {}) {
    const row = (await db.query("SELECT * FROM hannah_diag_recoveries WHERE id = $1 AND user_id = $2", [String(recoveryId || ""), userId])).rows[0];
    if (!row) throw fail(404, "That recovery request doesn't exist.", "not-found");
    if (row.status !== "waiting-approval") throw fail(409, `That recovery is ${row.status}.`, "not-waiting");
    const action = registry.get(row.action);
    const params = parse(row.params, {});
    const decision = await registry.decide({ db, userId, actor: { kind: "person", label: by, admin: false, approved: true } }, row.action, params);
    if (!action || decision.decision !== "run") {
      await updateRecovery(db, row.id, { status: decision.decision === "prohibited" ? "prohibited" : "refused", result: JSON.stringify({ reason: decision.reason }) });
      await audit(db, { userId, area: "diagnostics", subjectId: row.id, actor: by, event: "recovery-refused-after-approval", detail: { reason: decision.reason } });
      throw fail(403, decision.reason, decision.decision);
    }
    if (row.incident_id) await setLifecycle(db, row.incident_id, [lifeStep("permission", "done", `${action.title}: approved by ${by}.`, now())], null, now());
    return perform(db, { userId, incidentId: row.incident_id, recoveryId: row.id, action, params, actor: { kind: "person", label: by, admin: false, approved: true } });
  }

  // ---------- the whole pass ----------
  /**
   * Run every check, open or update incidents, try the automatic recoveries
   * that fit (once in a while, at most three times per incident), verify, and
   * close incidents whose check passes again.
   */
  async function diagnose(db, { userId = null, actor = { kind: "system", label: "diagnostics (automatic)", admin: false }, autoRecover = true, includeServer = true } = {}) {
    const first = await collect(db, { userId, includeServer });
    let problems = problemsOf(first.checks);
    const ran = [];
    for (const problem of problems) {
      const incident = await upsertIncident(db, userId, problem, first.at);
      problem.incidentId = incident.id;
      const suggestion = incident.suggestions[0];
      if (!suggestion) { await setLifecycle(db, incident.id, [lifeStep("permission", "none", "No recovery action to check.", first.at), lifeStep("remediation", "none", problem.manual || "Nothing HANNAH can do: a person has to look.", first.at), lifeStep("log", "done", "Recorded.", first.at)], incident.status === "open" ? "needs-person" : null, first.at); continue; }
      const action = registry.get(suggestion.action);
      if (action.policy !== "automatic" || !autoRecover) {
        const decision = await registry.decide({ db, userId, actor }, action.id, suggestion.params);
        if (incident.status === "open" || incident.status === "needs-person") await setLifecycle(db, incident.id, [lifeStep("permission", decision.decision === "run" ? "waiting" : "refused", `${action.title} (${action.policy}): ${decision.reason}`, first.at), lifeStep("remediation", "none", action.policy === "prohibited" ? `Not run: prohibited. ${action.manual || ""}`.trim() : action.policy === "approval" ? "Waiting for someone to ask for it; a person approves it before it runs." : action.policy === "admin" ? "Only a server administrator can run it." : "Automatic recovery is off for this run.", first.at)], action.policy === "prohibited" ? "needs-person" : action.policy === "admin" ? "needs-admin" : null, first.at);
        continue;
      }
      const attempts = (await db.query("SELECT status, created_at FROM hannah_diag_recoveries WHERE incident_id = $1 AND action = $2 AND requested_by = $3 ORDER BY created_at DESC", [incident.id, action.id, "diagnostics (automatic)"])).rows;
      if (attempts.length >= MAX_AUTOMATIC || (attempts[0] && first.at - Number(attempts[0].created_at) < RETRY_AFTER_MS)) {
        await setLifecycle(db, incident.id, [lifeStep("remediation", "skipped", attempts.length >= MAX_AUTOMATIC ? `Tried automatically ${attempts.length} times; not repeated. A person has to look.` : `Tried at ${new Date(Number(attempts[0].created_at)).toISOString()}; not repeated within ten minutes.`, first.at)], attempts.length >= MAX_AUTOMATIC ? "needs-person" : null, first.at);
        continue;
      }
      try {
        ran.push(await requestRecovery(db, { userId, incidentId: incident.id, action: action.id, params: suggestion.params, actor: { ...actor, label: "diagnostics (automatic)" } }));
      } catch (error) {
        if (!error.status) throw error;
      }
    }
    // Verify by checking again, and close what passes.
    const second = ran.length ? await collect(db, { userId, includeServer }) : first;
    if (ran.length) problems = problemsOf(second.checks);
    const present = new Set(problems.map((problem) => problem.fingerprint));
    const openRows = [
      ...(userId ? (await db.query(`SELECT * FROM hannah_diag_incidents WHERE user_id = $1 AND status IN ${OPEN}`, [userId])).rows : []),
      ...(includeServer ? (await db.query(`SELECT * FROM hannah_diag_incidents WHERE user_id IS NULL AND status IN ${OPEN}`)).rows : []),
    ];
    for (const row of openRows) {
      if (present.has(row.fingerprint)) continue;
      const at = now();
      await setLifecycle(db, row.id, [lifeStep("verify", "done", `${row.title}: the check passes again.`, at), lifeStep("log", "done", "Incident closed.", at)], "resolved", at);
      await db.query("UPDATE hannah_diag_incidents SET resolved_at = $1 WHERE id = $2", [at, row.id]);
      await audit(db, { userId: row.user_id, area: "diagnostics", subjectId: row.id, actor: "diagnostics", event: "incident-resolved", detail: { problem: row.problem, after: ran.some((item) => item.incidentId === row.id) ? "recovery" : "the check passed" }, at });
    }
    return view(second.checks, await listIncidents(db, userId, { includeServer }), second.at);
  }

  function view(checks, incidents, at) {
    const subsystems = {};
    for (const name of ["os", "runtime", "hardware", "ai"]) {
      const mine = checks.filter((item) => item.subsystem === name);
      const status = !mine.length ? "nothing-to-check" : mine.some((item) => item.status === "failed") ? "failed" : mine.some((item) => item.status === "degraded") ? "degraded" : mine.every((item) => ["unknown", "not-configured"].includes(item.status)) ? "unknown" : "ok";
      subsystems[name] = { status, checks: mine.map(({ problem: _problem, problems: _problems, ...rest }) => rest) };
    }
    const open = incidents.filter((incident) => incident.status !== "resolved");
    const worst = open.some((incident) => incident.severity === "error") ? "needs attention now" : open.some((incident) => incident.severity === "warning") ? "needs attention" : "no problem found in what was measured";
    return { checkedAt: at, summary: worst, subsystems, incidents, basis: "Only what this server measured, what robots, Robot OS and hubs reported, and what HANNAH recorded. A check with nothing to measure says unknown, never ok. Causes are possibilities until someone confirms them." };
  }

  async function listIncidents(db, userId, { includeServer = true, status = "open", limit = 50 } = {}) {
    const where = [];
    const values = [];
    if (userId && includeServer) { values.push(userId); where.push(`(user_id = $${values.length} OR user_id IS NULL)`); } else if (userId) { values.push(userId); where.push(`user_id = $${values.length}`); } else where.push("user_id IS NULL");
    if (status === "open") where.push(`status IN ${OPEN}`);
    values.push(Math.max(1, Math.min(200, Number(limit) || 50)));
    const rows = (await db.query(`SELECT * FROM hannah_diag_incidents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $${values.length}`, values)).rows;
    const rank = { error: 0, warning: 1, info: 2 };
    const out = [];
    for (const row of rows) out.push(publicIncident(row, await recoveriesFor(db, row.id)));
    return out.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || b.updatedAt - a.updatedAt);
  }
  async function getIncident(db, userId, id) {
    const row = (await db.query("SELECT * FROM hannah_diag_incidents WHERE id = $1", [String(id || "")])).rows[0];
    if (!row || (row.user_id !== null && row.user_id !== userId)) throw fail(404, "That incident doesn't exist.", "not-found");
    return publicIncident(row, await recoveriesFor(db, row.id));
  }
  const auditTrail = (db, userId, options = {}) => auditList(db, { userId, includeServer: true, area: "diagnostics", ...options });

  return { STEPS, actions: () => registry.list(), auditTrail, diagnose, executeApproved, getIncident, listIncidents, requestRecovery };
}

module.exports = { STEPS, createDiagnosticsEngine };
