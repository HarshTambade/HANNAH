"use strict";

/**
 * Shared plumbing for the AI Workforce API.
 *
 * Every workforce route is account-scoped. A row is either personal (its
 * user_id is the signed-in account) or belongs to a team the account is a
 * member of. Membership is always read from the database on the request; it is
 * never taken from a header or a client-supplied team name.
 *
 * Bots are not a security boundary. Files, secrets, browser profiles and
 * memories are keyed by owner and validated again on every access.
 */

const crypto = require("node:crypto");
const express = require("express");
const { databaseConfigured, getDatabase } = require("../db");

const ID = /^[A-Za-z0-9_-]{6,80}$/;
const BOT_STATUSES = new Set(["draft", "active", "paused", "archived"]);
const TASK_STATUSES = new Set(["queued", "running", "waiting-approval", "paused", "blocked", "failed", "completed", "cancelled"]);
const RISKS = ["low", "medium", "high", "critical"];
const ROLES = new Set(["owner", "manager", "member"]);

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const cleanMultiline = (value, max) => String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const parse = (text, fallback = null) => {
  if (text === null || text === undefined || text === "") return fallback;
  if (typeof text === "object") return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
const asArray = (value, max = 40) => (Array.isArray(value) ? [...new Set(value.map((item) => clean(item, 120)).filter(Boolean))].slice(0, max) : []);
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString("hex")}`;
const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const nowIso = (at) => new Date(at).toISOString();

/** True when the bot is available to this person: their own, or a published bot of a team they belong to. */
async function canUseBot(db, userId, botId) {
  if (!ID.test(String(botId || ""))) return null;
  const { rows } = await db.query("SELECT * FROM hannah_bots WHERE id = $1 AND archived_at IS NULL", [botId]);
  const row = rows[0];
  if (!row) return null;
  if (row.user_id === userId) return row;
  if (row.visibility !== "team" || !row.team_id || !row.published_at) return null;
  const member = await membership(db, row.team_id, userId);
  return member ? row : null;
}

async function membership(db, teamId, userId) {
  if (!teamId || !ID.test(String(teamId))) return null;
  const { rows } = await db.query("SELECT role FROM hannah_team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
  return rows[0] ? { role: rows[0].role } : null;
}

async function teamIdsFor(db, userId) {
  const { rows } = await db.query("SELECT team_id FROM hannah_team_members WHERE user_id = $1", [userId]);
  return rows.map((row) => row.team_id);
}

/** A team the person may manage (owner or manager). */
async function managedTeam(db, teamId, userId) {
  const member = await membership(db, teamId, userId);
  if (!member) throw fail(404, "That team doesn't exist.", "not-found");
  if (!["owner", "manager"].includes(member.role)) throw fail(403, "Only a team owner or manager can do that.", "forbidden");
  return member;
}

/** Read one person's policy rules and every team policy they belong to. */
async function policiesFor(db, userId) {
  const { rows: userRows } = await db.query("SELECT rules FROM hannah_workforce_policies WHERE scope_kind = 'user' AND scope_id = $1", [userId]);
  const teamIds = await teamIdsFor(db, userId);
  const teamPolicies = [];
  for (const teamId of teamIds) {
    const { rows } = await db.query("SELECT rules, team_id FROM hannah_org_policies p JOIN hannah_teams t ON t.id = p.team_id WHERE p.team_id = $1", [teamId]);
    if (rows[0]) teamPolicies.push({ teamId, rules: parse(rows[0].rules, []) });
  }
  return { user: parse(userRows[0]?.rules, []), teams: teamPolicies };
}

async function recordEvent(db, userId, kind, { botId = null, taskId = null, computerId = null, severity = "info", detail = null } = {}) {
  try {
    await db.query(
      "INSERT INTO hannah_workforce_events (user_id, id, kind, bot_id, task_id, computer_id, severity, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [userId, id("evt"), clean(kind, 80), botId, taskId, computerId, RISKS.includes(severity) ? severity : "info", detail ? JSON.stringify(detail).slice(0, 20_000) : null, Date.now()],
    );
  } catch (error) {
    console.error(`Workforce event write failed (${error?.code || error?.name || "error"}).`);
  }
}

function publicEvent(row) {
  return {
    id: row.id,
    kind: row.kind,
    botId: row.bot_id || null,
    taskId: row.task_id || null,
    computerId: row.computer_id || null,
    severity: row.severity,
    detail: parse(row.detail, null),
    createdAt: Number(row.created_at),
  };
}

/** Router wrapper: signed-in account, account database, uniform error shape. */
function withAccount(handler, { requireSession = false } = {}) {
  return async (req, res) => {
    try {
      if (!databaseConfigured()) throw fail(503, "The AI workforce needs the account database. Set DATABASE_URL on the server.", "database-required");
      const account = res.locals.hannahAccount;
      if (!account) throw fail(401, "Sign in to use the AI workforce.", "sign-in");
      if (requireSession && account.via !== "session") throw fail(401, "Open the AI Workforce screen and sign in to do that.", "signin-required");
      const db = await getDatabase();
      return await handler(req, res, db, account);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500 && !error.reason) console.error(`Workforce API error (${error?.code || error?.name || "error"}): ${error.message}`);
      return res.status(status).json({
        error: status >= 500 && !error.reason ? "Something went wrong on the server." : error.message,
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.approval ? { approval: error.approval } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}

/** JSON body parser for sub-routers (mounted before the API-wide parser). */
const json = express.json({ limit: "1mb" });

function readBody(req) {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
}

function requireId(value, label = "id") {
  const text = String(value || "");
  if (!ID.test(text)) throw fail(404, `That ${label} doesn't exist.`, "not-found");
  return text;
}

module.exports = {
  BOT_STATUSES,
  ID,
  RISKS,
  ROLES,
  TASK_STATUSES,
  asArray,
  asObject,
  canUseBot,
  clean,
  cleanMultiline,
  fail,
  id,
  json,
  managedTeam,
  membership,
  nowIso,
  parse,
  policiesFor,
  publicEvent,
  readBody,
  recordEvent,
  requireId,
  sha256,
  teamIdsFor,
  withAccount,
};
