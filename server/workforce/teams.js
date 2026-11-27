"use strict";

/**
 * Team bots and organization policy.
 *
 * A team is an access boundary with explicit members and roles. A team bot is
 * a bot the team's owner or manager publishes. Publishing shares the bot's
 * configuration, skills and allowed apps — never its conversations, memories,
 * files or secrets. Those stay with the person who created them.
 */
const express = require("express");
const {
  clean, cleanMultiline, fail, id, managedTeam, membership, parse, publicEvent, readBody,
  recordEvent, requireId, withAccount,
} = require("./common");
const { normalizeRules } = require("./approvals");

const MEMBER_ROLES = new Set(["manager", "member"]);

function publicTeam(row, role, counts = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    ownerId: row.owner_user_id,
    role,
    botCount: counts.bots || 0,
    memberCount: counts.members || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function createTeamsRouter() {
  const router = express.Router();

  router.get("/workforce/teams", withAccount(async (_req, res, db, account) => {
    const { rows } = await db.query(
      `SELECT t.*, m.role,
         (SELECT COUNT(*) FROM hannah_bots b WHERE b.team_id = t.id AND b.published_at IS NOT NULL AND b.archived_at IS NULL) AS bot_count,
         (SELECT COUNT(*) FROM hannah_team_members mm WHERE mm.team_id = t.id) AS member_count
       FROM hannah_teams t JOIN hannah_team_members m ON m.team_id = t.id WHERE m.user_id = $1 ORDER BY t.name`,
      [account.id],
    );
    res.json({ teams: rows.map((row) => publicTeam(row, row.role, { bots: Number(row.bot_count), members: Number(row.member_count) })) });
  }));

  router.post("/workforce/teams", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const name = clean(body.name, 80);
    if (!name) throw fail(400, "Give the team a name.", "invalid");
    const teamId = id("team");
    const at = Date.now();
    await db.query("INSERT INTO hannah_teams (id, owner_user_id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)", [teamId, account.id, name, cleanMultiline(body.description, 600), at]);
    await db.query("INSERT INTO hannah_team_members (team_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)", [teamId, account.id, at]);
    await recordEvent(db, account.id, "team.created", { detail: { teamId, name } });
    const row = (await db.query("SELECT * FROM hannah_teams WHERE id = $1", [teamId])).rows[0];
    res.status(201).json({ team: publicTeam(row, "owner", { bots: 0, members: 1 }) });
  }));

  router.get("/workforce/teams/:id", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    const member = await membership(db, teamId, account.id);
    if (!member) throw fail(404, "That team doesn't exist.", "not-found");
    const team = (await db.query("SELECT * FROM hannah_teams WHERE id = $1", [teamId])).rows[0];
    if (!team) throw fail(404, "That team doesn't exist.", "not-found");
    const members = (await db.query("SELECT m.user_id, m.role, m.created_at, u.email, u.display_name FROM hannah_team_members m JOIN hannah_users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.created_at", [teamId])).rows.map((row) => ({ userId: row.user_id, role: row.role, email: row.email, displayName: row.display_name || "", addedAt: Number(row.created_at) }));
    const bots = (await db.query("SELECT id, name, role, description, visibility, published_at, status, updated_at FROM hannah_bots WHERE team_id = $1 AND archived_at IS NULL ORDER BY name", [teamId])).rows.map((row) => ({ id: row.id, name: row.name, role: row.role, description: row.description || "", published: Boolean(row.published_at), visibility: row.visibility, status: row.status, updatedAt: Number(row.updated_at), canManage: ["owner", "manager"].includes(member.role) }));
    const policy = parse((await db.query("SELECT rules FROM hannah_org_policies WHERE team_id = $1", [teamId])).rows[0]?.rules, []);
    res.json({ team: publicTeam(team, member.role, { bots: bots.length, members: members.length }), members, bots, policy: normalizeRules(policy) });
  }));

  router.patch("/workforce/teams/:id", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    await managedTeam(db, teamId, account.id);
    const body = readBody(req);
    const name = clean(body.name, 80);
    if (body.name !== undefined && !name) throw fail(400, "Give the team a name.", "invalid");
    const current = (await db.query("SELECT * FROM hannah_teams WHERE id = $1", [teamId])).rows[0];
    await db.query("UPDATE hannah_teams SET name = $1, description = $2, updated_at = $3 WHERE id = $4", [name || current.name, body.description === undefined ? current.description : cleanMultiline(body.description, 600), Date.now(), teamId]);
    const row = (await db.query("SELECT * FROM hannah_teams WHERE id = $1", [teamId])).rows[0];
    await recordEvent(db, account.id, "team.updated", { detail: { teamId } });
    res.json({ team: publicTeam(row, (await membership(db, teamId, account.id)).role) });
  }));

  router.delete("/workforce/teams/:id", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    const team = (await db.query("SELECT * FROM hannah_teams WHERE id = $1", [teamId])).rows[0];
    if (!team) throw fail(404, "That team doesn't exist.", "not-found");
    if (team.owner_user_id !== account.id) throw fail(403, "Only the team owner can delete it.", "forbidden");
    await db.query("UPDATE hannah_bots SET team_id = NULL, visibility = 'private', published_at = NULL WHERE team_id = $1", [teamId]);
    await db.query("DELETE FROM hannah_teams WHERE id = $1", [teamId]);
    await recordEvent(db, account.id, "team.deleted", { detail: { teamId, name: team.name } });
    res.json({ ok: true, deleted: true });
  }));

  router.post("/workforce/teams/:id/members", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    const mine = await managedTeam(db, teamId, account.id);
    const body = readBody(req);
    const email = clean(body.email, 254).toLowerCase();
    const role = String(body.role || "member");
    if (!email || !email.includes("@")) throw fail(400, "Enter the email address of a HANNAH account.", "invalid");
    if (!MEMBER_ROLES.has(role)) throw fail(400, "role must be manager or member.", "invalid");
    if (role === "manager" && mine.role !== "owner") throw fail(403, "Only the owner can add a manager.", "forbidden");
    const user = (await db.query("SELECT id FROM hannah_users WHERE lower(email) = $1", [email])).rows[0];
    if (!user) throw fail(404, "No HANNAH account uses that email.", "not-found");
    const existing = await membership(db, teamId, user.id);
    if (existing) throw fail(409, "That person is already on this team.", "exists");
    await db.query("INSERT INTO hannah_team_members (team_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)", [teamId, user.id, role, Date.now()]);
    await recordEvent(db, account.id, "team.member_added", { detail: { teamId, role } });
    res.status(201).json({ ok: true, role });
  }));

  router.delete("/workforce/teams/:id/members/:userId", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    const mine = await managedTeam(db, teamId, account.id);
    const target = requireId(req.params.userId, "member");
    const targetMember = await membership(db, teamId, target);
    if (!targetMember) throw fail(404, "That person isn't on this team.", "not-found");
    if (targetMember.role === "owner") throw fail(403, "The owner can't be removed. Delete the team instead.", "forbidden");
    if (targetMember.role === "manager" && mine.role !== "owner") throw fail(403, "Only the owner can remove a manager.", "forbidden");
    await db.query("DELETE FROM hannah_team_members WHERE team_id = $1 AND user_id = $2", [teamId, target]);
    // Their teammates leave with them: no longer published, no longer in this team.
    const withdrawn = await db.query("UPDATE hannah_bots SET published_at = NULL, visibility = 'private', team_id = NULL, updated_at = $1 WHERE team_id = $2 AND user_id = $3", [Date.now(), teamId, target]);
    await recordEvent(db, account.id, "team.member_removed", { detail: { teamId, botsWithdrawn: withdrawn.rowCount || 0 } });
    res.json({ ok: true, removed: true });
  }));

  router.put("/workforce/teams/:id/policy", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    await managedTeam(db, teamId, account.id);
    const rules = normalizeRules(readBody(req).rules);
    const at = Date.now();
    const updated = await db.query("UPDATE hannah_org_policies SET rules = $1, updated_at = $2 WHERE team_id = $3", [JSON.stringify(rules), at, teamId]);
    if (!updated.rowCount) await db.query("INSERT INTO hannah_org_policies (team_id, rules, updated_at) VALUES ($1, $2, $3)", [teamId, JSON.stringify(rules), at]);
    await recordEvent(db, account.id, "team.policy_updated", { detail: { teamId, rules: rules.length } });
    res.json({ policy: rules });
  }));

  router.post("/workforce/teams/:id/bots/:botId/publish", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    await managedTeam(db, teamId, account.id);
    const botId = requireId(req.params.botId, "teammate");
    const bot = (await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND id = $2 AND archived_at IS NULL", [account.id, botId])).rows[0];
    if (!bot) throw fail(404, "That teammate isn't yours to publish.", "not-found");
    if (bot.team_id !== teamId) throw fail(400, "Move this teammate to the team before publishing it.", "invalid");
    const at = Date.now();
    await db.query("UPDATE hannah_bots SET visibility = 'team', published_at = $1, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, account.id, botId]);
    await recordEvent(db, account.id, "bot.published", { botId, detail: { teamId } });
    res.json({ ok: true, publishedAt: at });
  }));

  router.post("/workforce/teams/:id/bots/:botId/unpublish", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    await managedTeam(db, teamId, account.id);
    const botId = requireId(req.params.botId, "teammate");
    // Any owner or manager may take a teammate down from their team, whoever published it.
    const bot = (await db.query("SELECT * FROM hannah_bots WHERE team_id = $1 AND id = $2", [teamId, botId])).rows[0];
    if (!bot) throw fail(404, "That teammate isn't published to this team.", "not-found");
    await db.query("UPDATE hannah_bots SET published_at = NULL, updated_at = $1 WHERE team_id = $2 AND id = $3", [Date.now(), teamId, botId]);
    await recordEvent(db, account.id, "bot.unpublished", { botId, detail: { teamId } });
    res.json({ ok: true, published: false });
  }));

  router.get("/workforce/teams/:id/activity", withAccount(async (req, res, db, account) => {
    const teamId = requireId(req.params.id, "team");
    if (!(await membership(db, teamId, account.id))) throw fail(404, "That team doesn't exist.", "not-found");
    const botIds = (await db.query("SELECT id, user_id FROM hannah_bots WHERE team_id = $1", [teamId])).rows;
    if (!botIds.length) return res.json({ events: [] });
    const placeholders = botIds.map((_, index) => `$${index + 2}`).join(", ");
    const { rows } = await db.query(`SELECT * FROM hannah_workforce_events WHERE user_id = $1 AND bot_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 100`, [account.id, ...botIds.map((row) => row.id)]);
    // A member sees events from their own account only; team-shared activity requires each owner to share it.
    res.json({ events: rows.map(publicEvent), note: "Activity is shown from your account. Other members' private activity stays private." });
  }));

  return router;
}

module.exports = { createTeamsRouter, publicTeam };
