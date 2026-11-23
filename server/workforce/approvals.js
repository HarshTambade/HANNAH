"use strict";

/**
 * The workforce approval and policy engine.
 *
 * Four risk levels, in the order the brief names them:
 *   low      reading, searching, drafting, memory, artifacts
 *   medium   changing a workspace file, running an approved command, filling a form
 *   high     sending externally, publishing, deleting, spending, changing access
 *   critical payments, destructive system changes, safety settings, robot motion
 *
 * Rules that never change:
 *   - critical actions are refused by this API; there is no workforce route for them;
 *   - high-risk actions always need a decision, even at "autonomous";
 *   - an organization rule can only tighten what a person allows, never loosen it;
 *   - content from a web page, email or tool output is never an approval.
 *
 * Approval payloads carry what the person needs to judge the action. Secrets are
 * never part of a payload: a vault reference is an id and a hint only.
 */

const express = require("express");
const { asArray, clean, fail, id, parse, policiesFor, readBody, recordEvent, withAccount } = require("./common");

const RISK_LEVEL = { low: 0, medium: 1, high: 2, critical: 3 };
const RISK_FOR = {
  "memory.read": "low", "memory.write": "low", "memory.delete": "medium",
  "artifact.create": "low", "artifact.delete": "high",
  "task.create": "low", "task.delegate": "low", "task.complete": "low", "task.cancel": "medium",
  "file.read": "low", "file.write": "medium", "file.delete": "high",
  "terminal.read": "low", "terminal.run": "medium",
  "browser.navigate": "low", "browser.read": "low", "browser.screenshot": "low", "browser.wait": "low",
  "browser.back": "low", "browser.forward": "low", "browser.reload": "low", "browser.new-tab": "low", "browser.switch-tab": "low", "browser.close-tab": "low",
  "browser.fill": "medium", "browser.click": "medium", "browser.select": "medium", "browser.submit": "high", "browser.download": "medium", "browser.takeover": "high",
  "secret.create": "medium", "secret.use": "medium", "secret.revoke": "medium",
  "mail.send": "high", "message.send": "high", "calendar.write": "medium", "calendar.delete": "high",
  "team.publish": "high", "team.unpublish": "high", "access.change": "high",
  "routine.enable": "medium", "routine.run": "medium",
  "meeting.distribute": "high", "meeting.record": "medium",
  "payment": "critical", "system.destroy": "critical", "safety.change": "critical", "robot.motion": "critical",
};
const ALWAYS_ASK = new Set(["high"]);
const EFFECT_RANK = { allow: 0, ask: 1, deny: 2 };
const AUTONOMY_ALLOWANCE = { observe: 0, suggest: 0, approval: 0, scoped: 1, autonomous: 2 };

function classify(action, declared) {
  const known = RISK_FOR[action];
  if (known) return known;
  if (RISK_LEVEL[declared] !== undefined) return declared;
  throw fail(400, "This action has no risk class, so it can't be approved.", "unknown-action");
}

function normalizeRules(input) {
  const list = Array.isArray(input) ? input.slice(0, 100) : [];
  const rules = [];
  for (const item of list) {
    const action = clean(item?.action, 80);
    const effect = String(item?.effect || "");
    if (!/^[a-z][a-z0-9_.*-]{2,79}$/.test(action) || !Object.hasOwn(EFFECT_RANK, effect)) continue;
    if (!rules.some((rule) => rule.action === action && rule.effect === effect)) rules.push({ action, effect, note: clean(item?.note, 200) });
  }
  return rules;
}

function matches(pattern, action) {
  return pattern.endsWith("*") ? action.startsWith(pattern.slice(0, -1)) : pattern === action;
}

async function effectiveRules(db, userId) {
  const policies = await policiesFor(db, userId);
  const rules = [];
  for (const rule of normalizeRules(policies.user)) rules.push({ ...rule, scope: "user" });
  for (const team of policies.teams) for (const rule of normalizeRules(team.rules)) rules.push({ ...rule, scope: "team", teamId: team.teamId });
  return rules;
}

function strictest(rules, action) {
  let result = null;
  for (const rule of rules) {
    if (!matches(rule.action, action)) continue;
    if (!result || EFFECT_RANK[rule.effect] > EFFECT_RANK[result.effect]) result = rule;
  }
  return result;
}

/**
 * Decide whether an action may run.
 * Returns { outcome: "allow"|"ask"|"deny"|"suggest", risk, reason, approval? }.
 * "ask" creates a durable approval record and no action may run until decided.
 */
async function gate(db, userId, { bot = null, taskId = null, action, risk, target = "", title = "", payload = {}, ttlMs = 24 * 60 * 60_000, dryRun = false }) {
  const level = classify(action, risk);
  if (level === "critical") return { outcome: "deny", risk: level, reason: "Critical actions are not available through the workforce API. Use the dedicated approval flow for payments, destructive operations or safety changes." };
  const rules = await effectiveRules(db, userId);
  const rule = strictest(rules, action);
  if (rule?.effect === "deny") return { outcome: "deny", risk: level, reason: `An ${rule.scope === "team" ? "organization" : "account"} rule denies ${action}.`, rule: rule.scope };
  const autonomy = bot?.autonomy || "approval";
  const allowedUpTo = AUTONOMY_ALLOWANCE[autonomy] ?? 1;
  if (autonomy === "observe" && RISK_LEVEL[level] > 0) return { outcome: "deny", risk: level, reason: "This teammate is set to Observe: it can read and remember, but not change anything." };
  if (autonomy === "suggest" && RISK_LEVEL[level] > 0) return { outcome: "suggest", risk: level, reason: "This teammate is set to Suggest: it prepares the action but nothing is executed." };
  const mustAsk = ALWAYS_ASK.has(level) || rule?.effect === "ask" || RISK_LEVEL[level] > allowedUpTo;
  if (!mustAsk) return { outcome: "allow", risk: level, reason: rule?.effect === "allow" ? "A narrow rule permits this action." : "Within this teammate's autonomy." };
  if (dryRun) return { outcome: "ask", risk: level, reason: "This action would need approval. Nothing was created by this check." };
  const at = Date.now();
  const approvalId = id("apv");
  const fullPayload = {
    inputs: payload.inputs ?? null,
    expected: clean(payload.expected, 1000),
    reversible: payload.reversible ?? null,
    dataShared: asArray(payload.dataShared, 20),
    agent: bot ? { id: bot.id, name: bot.name } : null,
    taskId,
    requestedAt: at,
    ...(payload.detail && typeof payload.detail === "object" ? { detail: payload.detail } : {}),
  };
  await db.query(
    `INSERT INTO hannah_workforce_approvals (user_id, id, bot_id, task_id, team_id, action, title, target, risk, status, payload, decision, reason, requested_at, decided_at, expires_at, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NULL, NULL, $11, NULL, $12, NULL)`,
    [userId, approvalId, bot?.id || null, taskId, bot?.team_id || null, action, clean(title, 160) || action, clean(target, 500), level, JSON.stringify(fullPayload), at, at + ttlMs],
  );
  await recordEvent(db, userId, "approval.requested", { botId: bot?.id || null, taskId, detail: { approvalId, action, risk: level, target: clean(target, 200) } });
  return {
    outcome: "ask",
    risk: level,
    reason: `${level === "high" ? "High-risk" : "This"} action needs your approval.`,
    approval: { id: approvalId, action, title: clean(title, 160) || action, target: clean(target, 500), risk: level, requestedAt: at, expiresAt: at + ttlMs },
  };
}

/** Throw the API error a route should return when an action needs a decision. */
async function assertAction(db, userId, request) {
  const decision = await gate(db, userId, request);
  if (decision.outcome === "allow") return decision;
  if (decision.outcome === "deny" || decision.outcome === "suggest") throw fail(403, decision.reason, decision.outcome === "suggest" ? "suggest-only" : "denied");
  throw fail(409, `${decision.reason} Open Actions to decide.`, "approval-required", { approval: decision.approval });
}

function publicApproval(row, at = Date.now()) {
  const expired = row.status === "pending" && Number(row.expires_at) <= at;
  return {
    id: row.id,
    botId: row.bot_id || null,
    taskId: row.task_id || null,
    teamId: row.team_id || null,
    action: row.action,
    title: row.title,
    target: row.target || "",
    risk: row.risk,
    status: expired ? "expired" : row.status,
    payload: parse(row.payload, {}),
    decision: row.decision || null,
    reason: row.reason || "",
    requestedAt: Number(row.requested_at),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    decidedBy: row.decided_by || null,
  };
}

function createApprovalsRouter() {
  const router = express.Router();

  router.get("/workforce/approvals", withAccount(async (req, res, db, account) => {
    const status = clean(req.query.status, 20) || "pending";
    const allowed = new Set(["pending", "approved", "denied", "expired", "all"]);
    if (!allowed.has(status)) throw fail(400, "Unknown approval status.", "invalid");
    const at = Date.now();
    const { rows } = await db.query(
      status === "all"
        ? "SELECT * FROM hannah_workforce_approvals WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 100"
        : "SELECT * FROM hannah_workforce_approvals WHERE user_id = $1 AND status = $2 ORDER BY requested_at DESC LIMIT 100",
      status === "all" ? [account.id] : [account.id, status],
    );
    res.json({ approvals: rows.map((row) => publicApproval(row, at)), serverTime: at });
  }));

  router.get("/workforce/approvals/:id", withAccount(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_workforce_approvals WHERE user_id = $1 AND id = $2", [account.id, clean(req.params.id, 80)]);
    if (!rows[0]) throw fail(404, "That approval doesn't exist.", "not-found");
    res.json({ approval: publicApproval(rows[0]) });
  }));

  router.post("/workforce/approvals/:id/decide", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const decision = String(body.decision || "");
    if (decision !== "allow" && decision !== "deny") throw fail(400, "decision must be allow or deny.", "invalid");
    const at = Date.now();
    const { rows } = await db.query("SELECT * FROM hannah_workforce_approvals WHERE user_id = $1 AND id = $2", [account.id, clean(req.params.id, 80)]);
    const row = rows[0];
    if (!row) throw fail(404, "That approval doesn't exist.", "not-found");
    if (row.status !== "pending") throw fail(409, `This approval is already ${row.status}.`, "not-pending");
    if (Number(row.expires_at) <= at) {
      await db.query("UPDATE hannah_workforce_approvals SET status = 'expired' WHERE user_id = $1 AND id = $2", [account.id, row.id]);
      throw fail(409, "This approval expired. Ask the teammate to try again.", "expired");
    }
    // An approval covers only this one action. It never creates a broad rule.
    await db.query(
      "UPDATE hannah_workforce_approvals SET status = $1, decision = $2, reason = $3, decided_at = $4, decided_by = $5 WHERE user_id = $6 AND id = $7 AND status = 'pending'",
      [decision === "allow" ? "approved" : "denied", decision, clean(body.reason, 500), at, account.id, account.id, row.id],
    );
    await recordEvent(db, account.id, `approval.${decision === "allow" ? "approved" : "denied"}`, { botId: row.bot_id || null, taskId: row.task_id || null, detail: { approvalId: row.id, action: row.action, risk: row.risk } });
    const updated = await db.query("SELECT * FROM hannah_workforce_approvals WHERE user_id = $1 AND id = $2", [account.id, row.id]);
    // An approved task can continue. The runner checks the approval itself before acting.
    if (decision === "allow" && row.task_id) await db.query("UPDATE hannah_workforce_tasks SET status = 'queued', updated_at = $1 WHERE user_id = $2 AND id = $3 AND status = 'waiting-approval'", [at, account.id, row.task_id]);
    res.json({ approval: publicApproval(updated.rows[0]), resume: decision === "allow" && Boolean(row.task_id) });
  }));

  router.get("/workforce/policies", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query("SELECT rules FROM hannah_workforce_policies WHERE scope_kind = 'user' AND scope_id = $1", [account.id]);
    const policies = await policiesFor(db, account.id);
    res.json({ rules: normalizeRules(parse(rows[0]?.rules, [])), organization: policies.teams.map((team) => ({ teamId: team.teamId, rules: normalizeRules(team.rules) })), risks: RISK_FOR });
  }));

  router.put("/workforce/policies", withAccount(async (req, res, db, account) => {
    const rules = normalizeRules(readBody(req).rules);
    const at = Date.now();
    const updated = await db.query("UPDATE hannah_workforce_policies SET rules = $1, updated_at = $2 WHERE scope_kind = 'user' AND scope_id = $3", [JSON.stringify(rules), at, account.id]);
    if (!updated.rowCount) await db.query("INSERT INTO hannah_workforce_policies (scope_kind, scope_id, rules, updated_at) VALUES ('user', $1, $2, $3)", [account.id, JSON.stringify(rules), at]);
    await recordEvent(db, account.id, "policy.updated", { detail: { rules: rules.length } });
    res.json({ rules });
  }));

  router.get("/workforce/policy/check", withAccount(async (req, res, db, account) => {
    const action = clean(req.query.action, 80);
    const risk = clean(req.query.risk, 20) || "medium";
    if (!/^[a-z][a-z0-9_.*-]{2,79}$/.test(action)) throw fail(400, "Name an action.", "invalid");
    const decision = await gate(db, account.id, { action, risk, title: `Check ${action}`, target: "policy check", dryRun: true, payload: { inputs: null, expected: "A policy check executes nothing." } });
    res.json({ decision });
  }));

  return router;
}

module.exports = { RISK_FOR, RISK_LEVEL, assertAction, classify, createApprovalsRouter, effectiveRules, gate, normalizeRules, publicApproval, strictest };
