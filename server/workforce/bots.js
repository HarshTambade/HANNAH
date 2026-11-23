"use strict";

/**
 * AI teammates (bots): creation, configuration, lifecycle, versions and export.
 *
 * A bot is a configuration, not a process. Work is done by tasks and routines,
 * always under the bot's permission and autonomy settings. Bots never receive
 * secrets: they reference a vault entry by id, and the value is injected
 * server-side (see secrets.js).
 */

const express = require("express");
const {
  BOT_STATUSES, asArray, asObject, canUseBot, clean, cleanMultiline, fail, id, membership,
  parse, readBody, recordEvent, requireId, sha256, withAccount,
} = require("./common");

const AUTONOMY = new Set(["observe", "suggest", "approval", "scoped", "autonomous"]);
const VISIBILITY = new Set(["private", "team"]);
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,120}$/;

const TEMPLATES = [
  {
    id: "chief-of-staff", name: "Chief of Staff", role: "Coordination", avatar: "compass",
    description: "Coordinates the other teammates, keeps priorities straight and prepares briefings.",
    personality: "Calm, structured and concise. Summarises decisions and owners rather than narrating.",
    instructions: "Coordinate work across the team. Turn large requests into clear assignments, keep dependencies visible, and aggregate completed work. Never mark work done without the evidence a teammate returned.",
    responsibilities: ["Coordinate priorities and handoffs", "Prepare daily and weekly briefings", "Track blockers and approvals", "Combine verified results"],
    skills: ["Briefing", "Task decomposition", "Result aggregation"], apps: [], tools: ["tasks", "memory", "artifacts"], autonomy: "approval",
  },
  {
    id: "research-analyst", name: "Research Analyst", role: "Research", avatar: "search",
    description: "Researches topics, collects sources, compares findings and writes cited reports.",
    personality: "Curious and exacting. Separates facts from assumptions and always names its sources.",
    instructions: "Use web research and connected documents. Cite every material claim with a URL or document reference. State uncertainty and never invent a source.",
    responsibilities: ["Gather evidence", "Compare options", "Write cited reports", "Flag contradictions"],
    skills: ["Web research", "Source comparison", "Report writing"], apps: ["web"], tools: ["research", "documents", "memory"], autonomy: "approval",
  },
  {
    id: "software-engineer", name: "Software Engineer", role: "Engineering", avatar: "terminal",
    description: "Inspects repositories, writes code, runs tests and prepares technical documentation.",
    personality: "Pragmatic and precise. Explains trade-offs briefly and shows the diff that matters.",
    instructions: "Inspect before editing. Work on a branch, run the relevant tests, and report what passed and what did not. Never claim a test passed without its output.",
    responsibilities: ["Inspect repositories", "Implement changes", "Run tests", "Document changes"],
    skills: ["Code review", "Test execution", "Technical writing"], apps: ["github", "gitlab"], tools: ["coding", "terminal", "files", "artifacts"], autonomy: "approval",
  },
  {
    id: "qa-engineer", name: "QA Engineer", role: "Quality", avatar: "check",
    description: "Builds and runs test plans, reproduces bugs and validates fixes.",
    personality: "Skeptical and methodical. Reports reproduction steps, not opinions.",
    instructions: "Reproduce before reporting. Give exact steps, expected and actual results, and the evidence you captured. Verify a fix against the original reproduction.",
    responsibilities: ["Build test plans", "Reproduce bugs", "Validate fixes", "Report regressions"],
    skills: ["Test planning", "Bug reproduction", "Regression checks"], apps: ["github", "linear", "sentry"], tools: ["browser", "terminal", "artifacts"], autonomy: "approval",
  },
  {
    id: "security-analyst", name: "Security Analyst", role: "Security", avatar: "shield",
    description: "Reviews code and configurations, audits dependencies and records findings.",
    personality: "Direct and evidence-led. Rates severity and never recommends disabling a control without saying so.",
    instructions: "Review read-only by default. Severity-rank findings with a concrete attack path. Do not test against systems you were not authorized to test.",
    responsibilities: ["Review code and configuration", "Audit dependencies", "Record findings", "Recommend remediation"],
    skills: ["Threat modelling", "Dependency audit", "Configuration review"], apps: ["github", "sentry"], tools: ["coding", "files", "artifacts"], autonomy: "approval",
  },
  {
    id: "marketing-manager", name: "Marketing Manager", role: "Marketing", avatar: "megaphone",
    description: "Researches markets, drafts campaigns, organises content and analyses performance.",
    personality: "Audience-first and specific. Prefers a clear message over a pile of adjectives.",
    instructions: "Research the audience before drafting. Keep drafts as drafts until a person approves publishing. Name the evidence behind performance claims.",
    responsibilities: ["Market research", "Campaign drafts", "Content calendar", "Performance summaries"],
    skills: ["Audience research", "Campaign drafting", "Content planning"], apps: ["notion", "google-drive"], tools: ["research", "documents", "memory"], autonomy: "approval",
  },
  {
    id: "sales-assistant", name: "Sales Assistant", role: "Sales", avatar: "users",
    description: "Researches prospects, organises leads and prepares outreach for approval.",
    personality: "Helpful and respectful. Never invents a customer fact or sends without approval.",
    instructions: "Prepare outreach as a draft. Every claim about a prospect must come from a named source. Sending is always a high-risk action needing approval.",
    responsibilities: ["Prospect research", "Lead notes", "Outreach drafts", "Follow-up preparation"],
    skills: ["Prospect research", "Outreach drafting"], apps: ["gmail", "outlook", "notion"], tools: ["research", "email", "memory"], autonomy: "approval",
  },
  {
    id: "finance-assistant", name: "Finance Assistant", role: "Finance", avatar: "receipt",
    description: "Organises financial records, prepares summaries and drafts expense reports.",
    personality: "Careful and audit-minded. Flags missing evidence instead of filling gaps.",
    instructions: "Do not move money or change payment settings. Summarise approved records only, keep currency explicit, and attach source documents. Payments are critical risk and always refused.",
    responsibilities: ["Organise records", "Prepare summaries", "Categorise approved expenses", "Draft reports"],
    skills: ["Record organisation", "Expense summaries"], apps: ["google-sheets", "xlsx"], tools: ["documents", "files", "artifacts"], autonomy: "approval",
  },
  {
    id: "personal-assistant", name: "Personal Assistant", role: "Personal", avatar: "calendar",
    description: "Coordinates your calendar, reminders and inbox drafts, and prepares daily briefings.",
    personality: "Warm and brief. Puts the next commitment first.",
    instructions: "Check current calendar and mail state before acting. Prepare drafts; sending and calendar changes need approval unless a standing permission covers them.",
    responsibilities: ["Calendar coordination", "Reminders", "Inbox drafts", "Daily briefing"],
    skills: ["Daily briefing", "Inbox triage", "Calendar planning"], apps: ["google-calendar", "gmail", "outlook"], tools: ["calendar", "email", "memory"], autonomy: "approval",
  },
  {
    id: "robotics-engineer", name: "Robotics Engineer", role: "Robotics", avatar: "robot",
    description: "Monitors robots, inspects diagnostics and prepares missions for validation.",
    personality: "Safety-first and factual. Never treats a simulation result as a physical one.",
    instructions: "Read robot and fleet state through the robotics API. Missions go through the existing Safety Gateway. Never send motor commands directly and never bypass the onboard runtime.",
    responsibilities: ["Inspect robot health", "Review missions", "Prepare routes", "Report unavailable robots"],
    skills: ["Fleet inspection", "Mission preparation"], apps: [], tools: ["robots", "files", "artifacts"], autonomy: "approval",
  },
  {
    id: "iot-manager", name: "IoT Manager", role: "Devices", avatar: "plug",
    description: "Manages registered devices, monitors health and drafts approved automations.",
    personality: "Methodical and cautious. Names the device and its last reading before recommending a change.",
    instructions: "Use the device registry and capability limits. Draft automations; changing a device is a hardware action that follows the Action Engine and the hub's readback. Never guess a device's protocol.",
    responsibilities: ["Monitor device health", "Draft automations", "Report sensor problems", "Guide onboarding"],
    skills: ["Device health check", "Automation drafting"], apps: [], tools: ["devices", "files", "artifacts"], autonomy: "approval",
  },
];

function publicBot(row, { userId, teamName = null } = {}) {
  return {
    id: row.id,
    mine: row.user_id === userId,
    teamId: row.team_id || null,
    teamName,
    name: row.name,
    avatar: row.avatar || null,
    description: row.description || "",
    role: row.role || "",
    template: row.template || null,
    personality: row.personality || "",
    instructions: row.instructions || "",
    responsibilities: parse(row.responsibilities, []),
    skills: parse(row.skills, []),
    apps: parse(row.apps, []),
    tools: parse(row.tools, []),
    memoryConfig: parse(row.memory_config, { scopes: ["user", "bot"] }),
    modelPrefs: parse(row.model_prefs, {}),
    computerAccess: parse(row.computer_access, { enabled: false, computerIds: [] }),
    fileAccess: parse(row.file_access, { read: [], write: [] }),
    permissions: parse(row.permissions, {}),
    autonomy: row.autonomy,
    notifications: parse(row.notifications, {}),
    limits: parse(row.limits, {}),
    status: row.status,
    visibility: row.visibility,
    publishedAt: row.published_at === null || row.published_at === undefined ? null : Number(row.published_at),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
  };
}

function normalizeConfig(input, base = {}) {
  const config = {
    name: clean(input.name ?? base.name, 60),
    avatar: clean(input.avatar ?? base.avatar, 80) || null,
    description: cleanMultiline(input.description ?? base.description, 600),
    role: clean(input.role ?? base.role, 80),
    personality: cleanMultiline(input.personality ?? base.personality, 2000),
    instructions: cleanMultiline(input.instructions ?? base.instructions, 12_000),
    responsibilities: asArray(input.responsibilities ?? base.responsibilities, 20),
    skills: asArray(input.skills ?? base.skills, 40),
    apps: asArray(input.apps ?? base.apps, 40),
    tools: asArray(input.tools ?? base.tools, 40),
    memoryConfig: asObject(input.memoryConfig ?? base.memoryConfig),
    modelPrefs: asObject(input.modelPrefs ?? base.modelPrefs),
    computerAccess: asObject(input.computerAccess ?? base.computerAccess),
    fileAccess: asObject(input.fileAccess ?? base.fileAccess),
    permissions: asObject(input.permissions ?? base.permissions),
    autonomy: String(input.autonomy ?? base.autonomy ?? "approval"),
    notifications: asObject(input.notifications ?? base.notifications),
    limits: asObject(input.limits ?? base.limits),
    visibility: String(input.visibility ?? base.visibility ?? "private"),
  };
  if (!config.name) throw fail(400, "Give the teammate a name.", "invalid");
  if (!config.role) throw fail(400, "Give the teammate a role.", "invalid");
  if (!AUTONOMY.has(config.autonomy)) throw fail(400, `autonomy must be one of ${[...AUTONOMY].join(", ")}.`, "invalid");
  if (!VISIBILITY.has(config.visibility)) throw fail(400, "visibility must be private or team.", "invalid");
  const provider = clean(config.modelPrefs.provider, 80);
  const model = clean(config.modelPrefs.model, 120);
  if (model && !MODEL_ID.test(model)) throw fail(400, "That model id has unexpected characters.", "invalid");
  config.modelPrefs = { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(config.modelPrefs.auto === false ? { auto: false } : {}) };
  const scopes = Array.isArray(config.memoryConfig.scopes) ? config.memoryConfig.scopes.filter((scope) => ["user", "bot", "project", "team", "device"].includes(scope)) : ["user", "bot"];
  config.memoryConfig = { ...config.memoryConfig, scopes: [...new Set(scopes)] };
  config.computerAccess = {
    enabled: config.computerAccess.enabled === true,
    computerIds: asArray(config.computerAccess.computerIds, 20),
    localDesktop: false,
  };
  const read = asArray(config.fileAccess.read, 20);
  const write = asArray(config.fileAccess.write, 20);
  config.fileAccess = { read, write };
  return config;
}

function templateConfig(template, overrides) {
  return normalizeConfig({
    name: overrides.name || template.name,
    avatar: template.avatar,
    description: template.description,
    role: template.role,
    personality: template.personality,
    instructions: template.instructions,
    responsibilities: template.responsibilities,
    skills: template.skills,
    apps: template.apps,
    tools: template.tools,
    autonomy: template.autonomy,
    ...overrides,
  });
}

function configFromRow(row) {
  return normalizeConfig({
    name: row.name, avatar: row.avatar, description: row.description, role: row.role, personality: row.personality,
    instructions: row.instructions, responsibilities: parse(row.responsibilities, []), skills: parse(row.skills, []),
    apps: parse(row.apps, []), tools: parse(row.tools, []), memoryConfig: parse(row.memory_config, {}),
    modelPrefs: parse(row.model_prefs, {}), computerAccess: parse(row.computer_access, {}), fileAccess: parse(row.file_access, {}),
    permissions: parse(row.permissions, {}), autonomy: row.autonomy, notifications: parse(row.notifications, {}),
    limits: parse(row.limits, {}), visibility: row.visibility,
  });
}

async function loadBot(db, userId, botId) {
  const bot = await canUseBot(db, userId, botId);
  if (!bot) throw fail(404, "That teammate doesn't exist.", "not-found");
  return bot;
}

async function saveVersion(db, row, userId, note, at) {
  const config = { ...configFromRow(row), autonomy: row.autonomy, visibility: row.visibility };
  await db.query(
    "INSERT INTO hannah_bot_versions (user_id, bot_id, version, config, author_user_id, note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [row.user_id, row.id, Number(row.version), JSON.stringify(config), userId, clean(note, 200), at],
  );
}

/** Validate a bot configuration without running anything. */
function inspectBot(config, row = null) {
  const issues = [];
  const notes = [];
  if (!config.name) issues.push("A name is required.");
  if (!config.role) issues.push("A role is required.");
  if (config.instructions.length < 40) issues.push("Write at least a sentence of instructions so the teammate knows how to work.");
  if (!config.responsibilities.length) notes.push("No responsibilities listed; the teammate will rely on its instructions.");
  if (!config.tools.length) notes.push("No tools are allowed; this teammate can only talk and use its memory.");
  if (!config.memoryConfig.scopes?.length) issues.push("Choose at least one memory scope.");
  if (config.computerAccess.enabled && !config.computerAccess.computerIds.length) issues.push("Computer access is on but no computer is assigned.");
  if (config.visibility === "team" && !row?.team_id) notes.push("A team bot needs a team before it can be published.");
  if (config.autonomy === "autonomous") notes.push("Autonomous still asks for high-risk actions; critical actions are always refused.");
  if (config.instructions.length > 6000) notes.push("Long instructions: consider moving procedures into a Skill.");
  return {
    ok: issues.length === 0,
    issues,
    notes,
    checks: {
      name: Boolean(config.name), role: Boolean(config.role), instructions: config.instructions.length >= 40,
      memoryScopes: config.memoryConfig.scopes?.length || 0, tools: config.tools.length, autonomy: config.autonomy,
      computer: config.computerAccess.enabled ? config.computerAccess.computerIds.length : "off",
      visibility: config.visibility,
    },
    run: null,
  };
}

function createBotsRouter() {
  const router = express.Router();

  router.get("/workforce/templates", withAccount(async (_req, res) => {
    res.json({ templates: TEMPLATES });
  }));

  router.get("/workforce/bots", withAccount(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200", [account.id]);
    const teamIds = new Set((await db.query("SELECT team_id FROM hannah_team_members WHERE user_id = $1", [account.id])).rows.map((row) => row.team_id));
    let shared = [];
    if (teamIds.size) {
      const list = [...teamIds];
      const placeholders = list.map((_, index) => `$${index + 2}`).join(", ");
      shared = (await db.query(`SELECT b.*, t.name AS team_name FROM hannah_bots b JOIN hannah_teams t ON t.id = b.team_id WHERE b.visibility = 'team' AND b.published_at IS NOT NULL AND b.archived_at IS NULL AND b.team_id IN (${placeholders}) AND b.user_id <> $1 LIMIT 200`, [account.id, ...list])).rows;
    }
    const teams = new Map((await db.query("SELECT t.id, t.name FROM hannah_teams t JOIN hannah_team_members m ON m.team_id = t.id WHERE m.user_id = $1", [account.id])).rows.map((row) => [row.id, row.name]));
    res.json({
      bots: [...rows.map((row) => publicBot(row, { userId: account.id, teamName: row.team_id ? teams.get(row.team_id) : null })), ...shared.map((row) => publicBot(row, { userId: account.id, teamName: row.team_name }))],
      autonomyLevels: [...AUTONOMY],
    });
  }));

  router.post("/workforce/bots", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const template = body.templateId ? TEMPLATES.find((item) => item.id === clean(body.templateId, 80)) : null;
    if (body.templateId && !template) throw fail(404, "That template doesn't exist.", "not-found");
    let teamId = body.teamId ? clean(body.teamId, 80) : null;
    if (teamId) {
      const member = await membership(db, teamId, account.id);
      if (!member || !["owner", "manager"].includes(member.role)) throw fail(403, "Only a team owner or manager can create a team teammate.", "forbidden");
    }
    const config = template
      ? templateConfig(template, { ...body, visibility: teamId ? "team" : (body.visibility || "private") })
      : normalizeConfig(body);
    if (config.visibility === "team" && !teamId) throw fail(400, "Choose a team for a team teammate.", "invalid");
    const at = Date.now();
    const botId = id("bot");
    const status = BOT_STATUSES.has(body.status) && body.status !== "archived" ? body.status : "draft";
    await db.query(
      `INSERT INTO hannah_bots (user_id, id, team_id, name, avatar, description, role, template, personality, instructions, responsibilities, skills, apps, tools, memory_config, model_prefs, computer_access, file_access, permissions, autonomy, notifications, limits, status, visibility, version, config_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 1, $25, $26, $26)`,
      [account.id, botId, teamId, config.name, config.avatar, config.description, config.role, template?.id || null, config.personality, config.instructions,
        JSON.stringify(config.responsibilities), JSON.stringify(config.skills), JSON.stringify(config.apps), JSON.stringify(config.tools), JSON.stringify(config.memoryConfig),
        JSON.stringify(config.modelPrefs), JSON.stringify(config.computerAccess), JSON.stringify(config.fileAccess), JSON.stringify(config.permissions), config.autonomy,
        JSON.stringify(config.notifications), JSON.stringify(config.limits), status, config.visibility, sha256(JSON.stringify(config)), at],
    );
    const { rows } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND id = $2", [account.id, botId]);
    await saveVersion(db, rows[0], account.id, "Created", at);
    await recordEvent(db, account.id, "bot.created", { botId, detail: { name: config.name, template: template?.id || null } });
    res.status(201).json({ bot: publicBot(rows[0], { userId: account.id }) });
  }));

  router.get("/workforce/bots/:id", withAccount(async (req, res, db, account) => {
    const row = await loadBot(db, account.id, requireId(req.params.id, "teammate"));
    const team = row.team_id ? (await db.query("SELECT name FROM hannah_teams WHERE id = $1", [row.team_id])).rows[0] : null;
    res.json({ bot: publicBot(row, { userId: account.id, teamName: team?.name || null }) });
  }));

  router.put("/workforce/bots/:id", withAccount(async (req, res, db, account) => {
    const botId = requireId(req.params.id, "teammate");
    const row = await loadBot(db, account.id, botId);
    if (row.user_id !== account.id) throw fail(403, "Only the owner can change this teammate.", "forbidden");
    const body = readBody(req);
    const config = normalizeConfig(body, configFromRow(row));
    if (config.visibility === "team" && !row.team_id) throw fail(400, "Choose a team before making this teammate a team bot.", "invalid");
    const at = Date.now();
    const nextVersion = Number(row.version) + 1;
    await db.query(
      `UPDATE hannah_bots SET name = $1, avatar = $2, description = $3, role = $4, personality = $5, instructions = $6, responsibilities = $7, skills = $8, apps = $9, tools = $10,
         memory_config = $11, model_prefs = $12, computer_access = $13, file_access = $14, permissions = $15, autonomy = $16, notifications = $17, limits = $18, visibility = $19,
         version = $20, config_hash = $21, updated_at = $22
       WHERE user_id = $23 AND id = $24`,
      [config.name, config.avatar, config.description, config.role, config.personality, config.instructions, JSON.stringify(config.responsibilities), JSON.stringify(config.skills),
        JSON.stringify(config.apps), JSON.stringify(config.tools), JSON.stringify(config.memoryConfig), JSON.stringify(config.modelPrefs), JSON.stringify(config.computerAccess),
        JSON.stringify(config.fileAccess), JSON.stringify(config.permissions), config.autonomy, JSON.stringify(config.notifications), JSON.stringify(config.limits), config.visibility,
        nextVersion, sha256(JSON.stringify(config)), at, account.id, botId],
    );
    const { rows } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND id = $2", [account.id, botId]);
    await saveVersion(db, rows[0], account.id, clean(body.note, 200) || "Configuration updated", at);
    await recordEvent(db, account.id, "bot.updated", { botId, detail: { version: nextVersion } });
    res.json({ bot: publicBot(rows[0], { userId: account.id }) });
  }));

  router.post("/workforce/bots/:id/status", withAccount(async (req, res, db, account) => {
    const botId = requireId(req.params.id, "teammate");
    const row = await loadBot(db, account.id, botId);
    if (row.user_id !== account.id) throw fail(403, "Only the owner can change this teammate's status.", "forbidden");
    const status = String(readBody(req).status || "");
    if (!BOT_STATUSES.has(status)) throw fail(400, "status must be draft, active, paused or archived.", "invalid");
    if (status === "active" && row.status === "draft") {
      const check = inspectBot(configFromRow(row), row);
      if (!check.ok) throw fail(400, check.issues.join(" "), "not-ready", { details: check });
    }
    const at = Date.now();
    await db.query("UPDATE hannah_bots SET status = $1, archived_at = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [status, status === "archived" ? at : null, at, account.id, botId]);
    await recordEvent(db, account.id, `bot.${status}`, { botId });
    const { rows } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND id = $2", [account.id, botId]);
    res.json({ bot: publicBot(rows[0], { userId: account.id }) });
  }));

  router.post("/workforce/bots/:id/duplicate", withAccount(async (req, res, db, account) => {
    const source = await loadBot(db, account.id, requireId(req.params.id, "teammate"));
    if (source.user_id !== account.id) throw fail(403, "Only copy a teammate you own.", "forbidden");
    const body = readBody(req);
    const config = configFromRow(source);
    config.name = clean(body.name, 60) || `${config.name} copy`;
    config.visibility = "private";
    const at = Date.now();
    const botId = id("bot");
    await db.query(
      `INSERT INTO hannah_bots (user_id, id, team_id, name, avatar, description, role, template, personality, instructions, responsibilities, skills, apps, tools, memory_config, model_prefs, computer_access, file_access, permissions, autonomy, notifications, limits, status, visibility, version, config_hash, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'draft', 'private', 1, $22, $23, $23)`,
      [account.id, botId, config.name, config.avatar, config.description, config.role, source.template, config.personality, config.instructions,
        JSON.stringify(config.responsibilities), JSON.stringify(config.skills), JSON.stringify(config.apps), JSON.stringify(config.tools), JSON.stringify(config.memoryConfig),
        JSON.stringify(config.modelPrefs), JSON.stringify(config.computerAccess), JSON.stringify(config.fileAccess), JSON.stringify(config.permissions), config.autonomy,
        JSON.stringify(config.notifications), JSON.stringify(config.limits), sha256(JSON.stringify(config)), at],
    );
    const { rows } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND id = $2", [account.id, botId]);
    await saveVersion(db, rows[0], account.id, `Copied from ${source.name}`, at);
    await recordEvent(db, account.id, "bot.duplicated", { botId, detail: { from: source.id } });
    res.status(201).json({ bot: publicBot(rows[0], { userId: account.id }) });
  }));

  router.delete("/workforce/bots/:id", withAccount(async (req, res, db, account) => {
    const botId = requireId(req.params.id, "teammate");
    const row = await loadBot(db, account.id, botId);
    if (row.user_id !== account.id) throw fail(403, "Only the owner can delete this teammate.", "forbidden");
    const at = Date.now();
    await db.query("UPDATE hannah_bots SET archived_at = $1, status = 'archived', visibility = 'private', published_at = NULL, updated_at = $1 WHERE user_id = $2 AND id = $3", [at, account.id, botId]);
    await recordEvent(db, account.id, "bot.deleted", { botId });
    res.json({ ok: true, archived: true });
  }));

  router.get("/workforce/bots/:id/export", withAccount(async (req, res, db, account) => {
    const row = await loadBot(db, account.id, requireId(req.params.id, "teammate"));
    res.json({
      format: "hannah-bot",
      version: 1,
      exportedAt: new Date().toISOString(),
      bot: { ...configFromRow(row), template: row.template, status: row.status, visibility: "private" },
    });
  }));

  router.get("/workforce/bots/:id/versions", withAccount(async (req, res, db, account) => {
    const row = await loadBot(db, account.id, requireId(req.params.id, "teammate"));
    const { rows } = await db.query("SELECT version, note, author_user_id, created_at FROM hannah_bot_versions WHERE user_id = $1 AND bot_id = $2 ORDER BY version DESC LIMIT 50", [row.user_id, row.id]);
    res.json({ versions: rows.map((item) => ({ version: Number(item.version), note: item.note || "", authorId: item.author_user_id || null, createdAt: Number(item.created_at) })) });
  }));

  router.post("/workforce/bots/:id/versions/:version/restore", withAccount(async (req, res, db, account) => {
    const row = await loadBot(db, account.id, requireId(req.params.id, "teammate"));
    if (row.user_id !== account.id) throw fail(403, "Only the owner can restore a version.", "forbidden");
    const version = Number(req.params.version);
    const { rows } = await db.query("SELECT config FROM hannah_bot_versions WHERE user_id = $1 AND bot_id = $2 AND version = $3", [account.id, row.id, version]);
    if (!rows[0]) throw fail(404, "That version doesn't exist.", "not-found");
    const config = normalizeConfig(parse(rows[0].config, {}), configFromRow(row));
    const at = Date.now();
    const nextVersion = Number(row.version) + 1;
    await db.query(
      `UPDATE hannah_bots SET name = $1, avatar = $2, description = $3, role = $4, personality = $5, instructions = $6, responsibilities = $7, skills = $8, apps = $9, tools = $10,
         memory_config = $11, model_prefs = $12, computer_access = $13, file_access = $14, permissions = $15, autonomy = $16, notifications = $17, limits = $18, visibility = $19,
         version = $20, config_hash = $21, updated_at = $22 WHERE user_id = $23 AND id = $24`,
      [config.name, config.avatar, config.description, config.role, config.personality, config.instructions, JSON.stringify(config.responsibilities), JSON.stringify(config.skills),
        JSON.stringify(config.apps), JSON.stringify(config.tools), JSON.stringify(config.memoryConfig), JSON.stringify(config.modelPrefs), JSON.stringify(config.computerAccess),
        JSON.stringify(config.fileAccess), JSON.stringify(config.permissions), config.autonomy, JSON.stringify(config.notifications), JSON.stringify(config.limits), config.visibility,
        nextVersion, sha256(JSON.stringify(config)), at, account.id, row.id],
    );
    const { rows: updated } = await db.query("SELECT * FROM hannah_bots WHERE user_id = $1 AND id = $2", [account.id, row.id]);
    await saveVersion(db, updated[0], account.id, `Restored version ${version}`, at);
    await recordEvent(db, account.id, "bot.restored", { botId: row.id, detail: { fromVersion: version, version: nextVersion } });
    res.json({ bot: publicBot(updated[0], { userId: account.id }) });
  }));

  router.post("/workforce/bots/:id/test", withAccount(async (req, res, db, account) => {
    const row = await loadBot(db, account.id, requireId(req.params.id, "teammate"));
    const check = inspectBot(configFromRow(row), row);
    const computerIds = configFromRow(row).computerAccess.computerIds;
    if (computerIds.length) {
      const { rows } = await db.query("SELECT id FROM hannah_computers WHERE user_id = $1", [account.id]);
      const owned = new Set(rows.map((item) => item.id));
      check.issues.push(...computerIds.filter((computerId) => !owned.has(computerId)).map((computerId) => `Computer ${computerId} isn't assigned to you.`));
      check.ok = check.issues.length === 0;
    }
    await recordEvent(db, account.id, "bot.tested", { botId: row.id, detail: { ok: check.ok } });
    res.json(check);
  }));

  return router;
}

module.exports = { AUTONOMY, TEMPLATES, createBotsRouter, inspectBot, normalizeConfig, publicBot, templateConfig };
