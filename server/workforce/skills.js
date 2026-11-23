"use strict";

/**
 * Skills and Teach Mode.
 *
 * A skill is a reusable procedure with inputs, permissions, steps and safety
 * rules. A learned skill starts as a draft: the compiler turns recorded
 * interactions into proposed steps, but it never schedules or runs anything.
 * The person reviews, edits, tests and approves it.
 *
 * Teach Mode records actions the person explicitly allows. It refuses audio,
 * raw password values and anything that looks like a secret. A password field
 * becomes an input that must be filled from the Secure Vault at run time.
 *
 * Testing is a dry run: it checks inputs, permissions, steps and approval
 * checkpoints and reports what would happen. It does not claim that a live run
 * happened.
 */
const express = require("express");
const {
  asArray, asObject, canUseBot, clean, cleanMultiline, fail, id, parse, readBody, recordEvent, requireId, withAccount,
} = require("./common");
const { looksSecret } = require("./memory");
const { RISK_FOR } = require("./approvals");

const SKILL_ACTIONS = new Set(["browser.navigate", "browser.click", "browser.fill", "browser.select", "browser.press", "browser.extract", "browser.download", "browser.upload", "browser.screenshot", "file.read", "file.write", "connector.call", "agent.task", "notify", "human.approval"]);
const STATUSES = new Set(["draft", "testing", "approved", "published", "archived"]);
const INPUT_TYPES = new Set(["text", "number", "date", "url", "file", "secret", "choice"]);

function normalizeInputs(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 30).map((item) => ({
    name: clean(item?.name, 80).replace(/[^A-Za-z0-9_-]/g, ""),
    label: clean(item?.label, 120),
    type: INPUT_TYPES.has(String(item?.type)) ? String(item.type) : "text",
    required: item?.required !== false,
    description: clean(item?.description, 300),
    ...(item?.secretRef ? { secretRef: clean(item.secretRef, 80) } : {}),
  })).filter((item) => item.name);
}

function normalizeSteps(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((item, index) => {
    const action = String(item?.action || "");
    if (!SKILL_ACTIONS.has(action)) throw fail(400, `Step ${index + 1}: ${action || "no action"} isn't a supported skill action.`, "invalid-step");
    const params = asObject(item.params);
    const serialized = JSON.stringify(params);
    if (serialized.length > 20_000) throw fail(400, `Step ${index + 1} is too large.`, "invalid-step");
    // A skill never stores a credential value, only the name of a vault reference.
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && looksSecret(value)) throw fail(400, `Step ${index + 1}: ${key} looks like a credential. Use a secret input instead.`, "secret-in-skill");
    }
    return {
      id: clean(item.id, 40) || `step-${index + 1}`,
      title: clean(item.title, 200) || `${action} step ${index + 1}`,
      action,
      params,
      onFailure: ["stop", "retry", "skip", "ask"].includes(item.onFailure) ? item.onFailure : "stop",
      requiresApproval: item.requiresApproval === true,
    };
  });
}

function normalizeDefinition(body, base = {}) {
  const definition = {
    name: clean(body.name ?? base.name, 120),
    description: cleanMultiline(body.description ?? base.description, 1000),
    whenToUse: cleanMultiline(body.whenToUse ?? base.whenToUse, 2000),
    inputs: normalizeInputs(body.inputs ?? base.inputs),
    apps: asArray(body.apps ?? base.apps, 30),
    permissions: asArray(body.permissions ?? base.permissions, 40),
    steps: normalizeSteps(body.steps ?? base.steps),
    decisionRules: asArray(body.decisionRules ?? base.decisionRules, 30),
    outputs: asArray(body.outputs ?? base.outputs, 20),
    failureHandling: cleanMultiline(body.failureHandling ?? base.failureHandling, 2000),
    safety: asArray(body.safety ?? base.safety, 30),
    version: Number(base.version) || 1,
  };
  if (!definition.name) throw fail(400, "Give the skill a name.", "invalid");
  if (!definition.steps.length) throw fail(400, "A skill needs at least one step.", "invalid");
  return definition;
}

function publicSkill(row) {
  return {
    id: row.id,
    teamId: row.team_id || null,
    name: row.name,
    description: row.description || "",
    whenToUse: row.when_to_use || "",
    inputs: parse(row.inputs, []),
    apps: parse(row.apps, []),
    permissions: parse(row.permissions, []),
    steps: parse(row.steps, []),
    decisionRules: parse(row.decision_rules, []),
    outputs: parse(row.outputs, []),
    failureHandling: row.failure_handling || "",
    safety: parse(row.safety, []),
    status: row.status,
    source: row.source,
    version: Number(row.version),
    tests: parse(row.tests, []),
    publishedAt: row.published_at === null || row.published_at === undefined ? null : Number(row.published_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function definitionFromRow(row) {
  return {
    name: row.name, description: row.description, whenToUse: row.when_to_use, inputs: parse(row.inputs, []), apps: parse(row.apps, []),
    permissions: parse(row.permissions, []), steps: parse(row.steps, []), decisionRules: parse(row.decision_rules, []), outputs: parse(row.outputs, []),
    failureHandling: row.failure_handling, safety: parse(row.safety, []), version: Number(row.version),
  };
}

async function saveSkillVersion(db, row, definition, note, at) {
  await db.query("INSERT INTO hannah_skill_versions (user_id, skill_id, version, definition, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [row.user_id, row.id, Number(row.version), JSON.stringify(definition), clean(note, 300), at]);
}

async function loadSkill(db, userId, skillId) {
  const row = (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2 AND archived_at IS NULL", [userId, requireId(skillId, "skill")])).rows[0];
  if (!row) throw fail(404, "That skill doesn't exist.", "not-found");
  return row;
}

/** A safe, deterministic test: what the skill would need and do, with no external action. */
function dryRun(skill, inputs = {}) {
  const resolve = (value) => String(value ?? "").replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, name) => {
    const supplied = inputs[name];
    return supplied === undefined || supplied === null ? "" : String(supplied);
  });
  const actions = [];
  const permissions = new Set(skill.permissions);
  const approvals = [];
  const issues = [];
  const missing = [];
  for (const input of skill.inputs) {
    if (!input.required) continue;
    const value = inputs[input.name];
    if (input.type === "secret" && !input.secretRef) issues.push(`Input ${input.label || input.name} is a secret but has no vault reference.`);
    if (value === undefined || value === null || value === "") {
      if (input.secretRef) {
        approvals.push({ step: "inputs", reason: `The vault entry for ${input.label || input.name} will be injected server-side.` });
      } else {
        missing.push(input.label || input.name);
      }
    }
  }
  for (const [index, step] of skill.steps.entries()) {
    const risk = RISK_FOR[step.action] || (step.action === "browser.navigate" ? "low" : "medium");
    if (risk !== "low") permissions.add(step.action);
    if (step.requiresApproval || risk === "high" || risk === "critical") approvals.push({ step: index + 1, title: step.title, action: step.action, risk });
    if (step.action === "browser.navigate") {
      try {
        const url = new URL(resolve(step.params.url));
        if (!["http:", "https:"].includes(url.protocol)) issues.push(`Step ${index + 1}: only http(s) pages are allowed.`);
        actions.push({ step: index + 1, action: step.action, url: url.toString() });
      } catch {
        issues.push(`Step ${index + 1}: the recorded URL is missing or invalid.`);
      }
    } else if (step.action === "browser.fill") {
      actions.push({ step: index + 1, action: step.action, selector: clean(step.params.selector, 200), value: step.params.secretRef ? "vault reference" : "input" });
    } else {
      actions.push({ step: index + 1, action: step.action, title: step.title });
    }
  }
  const ready = missing.length === 0 && issues.length === 0;
  return {
    dryRun: true,
    executed: false,
    ready,
    missing,
    issues,
    permissions: [...permissions],
    approvals,
    actions,
    note: "This checked the skill without changing anything. A live run still needs your approval for the actions listed here.",
  };
}

// ---------------------------------------------------------------- Teach Mode

const EVENT_ACTIONS = new Set(["navigate", "click", "fill", "press", "select", "extract", "download", "upload", "wait", "screenshot", "handoff"]);

function sanitizeTeachEvent(input, consent) {
  const action = String(input?.action || "");
  if (!EVENT_ACTIONS.has(action)) throw fail(400, `That recorded action isn't supported: ${clean(action, 40)}.`, "invalid-event");
  const selector = clean(input.selector, 400);
  const label = clean(input.label, 200);
  const event = { action, selector, label, at: Date.now() };
  if (action === "navigate") {
    try {
      const url = new URL(String(input.url || ""));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
      event.url = url.toString().slice(0, 2000);
    } catch {
      throw fail(400, "A recorded navigation needs an http(s) URL.", "invalid-event");
    }
  }
  if (action === "fill" || action === "select") {
    const raw = typeof input.value === "string" ? input.value : "";
    const sensitive = input.masked === true || /password|passcode|pin|secret|token|card|cvv|ssn/i.test(`${selector} ${label}`) || looksSecret(raw);
    if (sensitive) {
      event.masked = true;
      event.needsVault = true;
      event.field = clean(input.field || label || selector.replace(/[^A-Za-z0-9]+/g, " "), 100) || "credential";
    } else if (consent.recordFormValues === true && raw) {
      if (looksSecret(raw)) throw fail(400, "That value looks like a credential and can't be recorded.", "secret-refused");
      event.value = raw.slice(0, 500);
    } else {
      event.valueOmitted = true;
    }
  }
  if (action === "download" || action === "upload") event.path = clean(input.path, 500);
  return event;
}

function compileTeachSession(session) {
  const events = parse(session.events, []);
  if (!events.length) throw fail(400, "Nothing was recorded yet, so there is nothing to compile.", "empty-recording");
  const steps = [];
  const apps = new Set();
  const inputs = [];
  const permissions = new Set();
  const safety = ["Review every step before publishing. A learned skill is never scheduled automatically."];
  let previous = "";
  for (const [index, event] of events.entries()) {
    const signature = `${event.action}:${event.url || event.selector || event.label || ""}`;
    if (signature === previous && event.action !== "navigate") continue;
    previous = signature;
    if (event.url) {
      try { apps.add(new URL(event.url).hostname.replace(/^www\./, "")); } catch { /* ignored */ }
    }
    if (event.action === "navigate") {
      steps.push({ id: `step-${index + 1}`, title: `Open ${event.url}`, action: "browser.navigate", params: { url: event.url }, onFailure: "stop" });
      permissions.add("browser.navigate");
    } else if (event.action === "click") {
      steps.push({ id: `step-${index + 1}`, title: `Click ${event.label || event.selector || "the page element"}`, action: "browser.click", params: { selector: event.selector }, onFailure: "stop" });
      permissions.add("browser.click");
    } else if (event.action === "fill" || event.action === "select") {
      const fieldName = event.masked
        ? `${clean(event.field, 40).replace(/[^A-Za-z0-9]+/g, "_").toLowerCase() || "credential"}_secret`
        : `${clean(event.label || event.selector, 40).replace(/[^A-Za-z0-9]+/g, "_").toLowerCase() || `field_${index + 1}`}`;
      if (!inputs.some((item) => item.name === fieldName)) {
        inputs.push({ name: fieldName, label: event.label || fieldName, type: event.masked ? "secret" : "text", required: true, description: event.masked ? "Injected from the Secure Vault at run time." : "Value recorded during the demonstration." });
      }
      steps.push({
        id: `step-${index + 1}`, title: `Fill ${event.label || event.selector || "the field"}`,
        action: event.action === "select" ? "browser.select" : "browser.fill",
        params: { selector: event.selector, ...(event.masked ? { secretRef: event.needsVault ? "vault entry" : undefined } : { value: `{{${fieldName}}}` }) },
        onFailure: "stop", requiresApproval: Boolean(event.masked),
      });
      permissions.add("browser.fill");
    } else if (event.action === "press") {
      steps.push({ id: `step-${index + 1}`, title: `Press ${clean(event.label, 40) || "a key"}`, action: "browser.press", params: { selector: event.selector, key: event.label || "Enter" }, onFailure: "stop" });
    } else if (event.action === "download") {
      steps.push({ id: `step-${index + 1}`, title: "Download the result", action: "browser.download", params: { selector: event.selector }, onFailure: "stop", requiresApproval: true });
      permissions.add("browser.download");
    } else if (event.action === "extract") {
      steps.push({ id: `step-${index + 1}`, title: "Read the page result", action: "browser.extract", params: { selector: event.selector || "body" }, onFailure: "skip" });
    } else if (event.action === "upload") {
      steps.push({ id: `step-${index + 1}`, title: "Upload the file", action: "browser.upload", params: { selector: event.selector }, onFailure: "stop", requiresApproval: true });
      permissions.add("browser.upload");
    } else if (event.action === "handoff") {
      steps.push({ id: `step-${index + 1}`, title: "Wait for a person", action: "human.approval", params: { reason: event.label || "A person completes a verification step." }, onFailure: "stop", requiresApproval: true });
    }
  }
  if (!steps.length) throw fail(400, "The recording had no usable steps.", "empty-recording");
  if (events.some((event) => event.masked || event.needsVault)) safety.push("A password or secret field is filled from the Secure Vault; no value was recorded.");
  if (!apps.size) safety.push("No application domain was recorded; check that the steps point at the right system.");
  return {
    name: clean(session.title, 120) || "Learned workflow",
    description: `Learned from a demonstration on ${new Date(session.created_at).toISOString().slice(0, 10)}.`,
    whenToUse: "Use when the person asks for this demonstrated workflow and every required input is available.",
    inputs,
    apps: [...apps],
    permissions: [...permissions],
    steps,
    decisionRules: ["If a page no longer matches the recorded step, stop and ask the person rather than improvising."],
    outputs: ["The completed result in the recorded application", "An artifact or link recorded by the final step"],
    failureHandling: "Stop at the failed step, keep the session checkpoint and ask the person to review the screen. Never repeat a payment or send.",
    safety,
  };
}

function createSkillsRouter() {
  const router = express.Router();

  router.get("/workforce/skills", withAccount(async (req, res, db, account) => {
    const status = clean(req.query.status, 20);
    const { rows } = await db.query(
      status ? "SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND status = $2 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200"
        : "SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200",
      status ? [account.id, status] : [account.id],
    );
    res.json({ skills: rows.map(publicSkill), actions: [...SKILL_ACTIONS], statuses: [...STATUSES] });
  }));

  router.post("/workforce/skills", withAccount(async (req, res, db, account) => {
    const definition = normalizeDefinition(readBody(req));
    const at = Date.now();
    const skillId = id("skl");
    await db.query(
      `INSERT INTO hannah_workforce_skills (user_id, id, team_id, name, description, when_to_use, inputs, apps, permissions, steps, decision_rules, outputs, failure_handling, safety, status, source, version, tests, published_at, archived_at, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', 'manual', 1, '[]', NULL, NULL, $14, $14)`,
      [account.id, skillId, definition.name, definition.description, definition.whenToUse, JSON.stringify(definition.inputs), JSON.stringify(definition.apps), JSON.stringify(definition.permissions),
        JSON.stringify(definition.steps), JSON.stringify(definition.decisionRules), JSON.stringify(definition.outputs), definition.failureHandling, JSON.stringify(definition.safety), at],
    );
    const row = (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2", [account.id, skillId])).rows[0];
    await saveSkillVersion(db, row, definitionFromRow(row), "Created", at);
    await recordEvent(db, account.id, "skill.created", { detail: { skillId, name: definition.name } });
    res.status(201).json({ skill: publicSkill(row) });
  }));

  router.get("/workforce/skills/:id", withAccount(async (req, res, db, account) => {
    const row = await loadSkill(db, account.id, req.params.id);
    const versions = (await db.query("SELECT version, note, created_at FROM hannah_skill_versions WHERE user_id = $1 AND skill_id = $2 ORDER BY version DESC LIMIT 30", [account.id, row.id])).rows.map((item) => ({ version: Number(item.version), note: item.note || "", createdAt: Number(item.created_at) }));
    res.json({ skill: publicSkill(row), versions });
  }));

  router.put("/workforce/skills/:id", withAccount(async (req, res, db, account) => {
    const row = await loadSkill(db, account.id, req.params.id);
    if (["published"].includes(row.status)) throw fail(409, "A published skill is versioned. Duplicate it or archive it before editing.", "published");
    const definition = normalizeDefinition(readBody(req), definitionFromRow(row));
    const at = Date.now();
    const nextVersion = Number(row.version) + 1;
    await db.query(
      `UPDATE hannah_workforce_skills SET name = $1, description = $2, when_to_use = $3, inputs = $4, apps = $5, permissions = $6, steps = $7, decision_rules = $8, outputs = $9, failure_handling = $10, safety = $11, version = $12, status = 'draft', updated_at = $13 WHERE user_id = $14 AND id = $15`,
      [definition.name, definition.description, definition.whenToUse, JSON.stringify(definition.inputs), JSON.stringify(definition.apps), JSON.stringify(definition.permissions),
        JSON.stringify(definition.steps), JSON.stringify(definition.decisionRules), JSON.stringify(definition.outputs), definition.failureHandling, JSON.stringify(definition.safety), nextVersion, at, account.id, row.id],
    );
    const updated = (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0];
    await saveSkillVersion(db, updated, definitionFromRow(updated), clean(readBody(req).note, 200) || "Edited", at);
    await recordEvent(db, account.id, "skill.updated", { detail: { skillId: row.id, version: nextVersion } });
    res.json({ skill: publicSkill(updated) });
  }));

  router.delete("/workforce/skills/:id", withAccount(async (req, res, db, account) => {
    const row = await loadSkill(db, account.id, req.params.id);
    await db.query("UPDATE hannah_workforce_skills SET archived_at = $1, status = 'archived', updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, row.id]);
    const routines = (await db.query("SELECT id FROM hannah_routines WHERE user_id = $1 AND skill_id = $2 AND status = 'active'", [account.id, row.id])).rows;
    for (const routine of routines) await db.query("UPDATE hannah_routines SET status = 'paused', updated_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, routine.id]);
    await recordEvent(db, account.id, "skill.archived", { detail: { skillId: row.id, pausedRoutines: routines.length } });
    res.json({ ok: true, archived: true, pausedRoutines: routines.length });
  }));

  router.post("/workforce/skills/:id/test", withAccount(async (req, res, db, account) => {
    const row = await loadSkill(db, account.id, req.params.id);
    const definition = definitionFromRow(row);
    const result = dryRun(definition, asObject(readBody(req).inputs));
    const tests = parse(row.tests, []);
    tests.push({ at: Date.now(), dryRun: true, ready: result.ready, issues: result.issues, missing: result.missing });
    await db.query("UPDATE hannah_workforce_skills SET tests = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(tests.slice(-20)), Date.now(), account.id, row.id]);
    await recordEvent(db, account.id, "skill.tested", { detail: { skillId: row.id, ready: result.ready, dryRun: true } });
    res.json({ test: result, skillVersion: Number(row.version) });
  }));

  router.post("/workforce/skills/:id/status", withAccount(async (req, res, db, account) => {
    const row = await loadSkill(db, account.id, req.params.id);
    const status = String(readBody(req).status || "");
    if (!STATUSES.has(status)) throw fail(400, `status must be one of ${[...STATUSES].join(", ")}.`, "invalid");
    const tests = parse(row.tests, []);
    if (status === "approved" && !tests.some((test) => test.ready)) throw fail(400, "Run a dry test that passes before approving this skill.", "test-required");
    const at = Date.now();
    await db.query("UPDATE hannah_workforce_skills SET status = $1, published_at = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [status, status === "published" ? at : row.published_at, at, account.id, row.id]);
    await recordEvent(db, account.id, `skill.${status}`, { detail: { skillId: row.id } });
    const updated = (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2", [account.id, row.id])).rows[0];
    res.json({ skill: publicSkill(updated) });
  }));

  router.get("/workforce/skills/:id/export", withAccount(async (req, res, db, account) => {
    const row = await loadSkill(db, account.id, req.params.id);
    res.json({ format: "hannah-skill", version: 1, exportedAt: new Date().toISOString(), skill: definitionFromRow(row) });
  }));

  router.get("/workforce/skills/match", withAccount(async (req, res, db, account) => {
    const query = clean(req.query.q, 500);
    if (!query) return res.json({ matches: [] });
    const words = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
    const { rows } = await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND status IN ('approved', 'published') AND archived_at IS NULL", [account.id]);
    const matches = rows.map((row) => {
      const skill = publicSkill(row);
      const hay = `${skill.name} ${skill.whenToUse} ${skill.description} ${skill.apps.join(" ")}`.toLowerCase();
      let hits = 0;
      for (const word of words) if (hay.includes(word)) hits += 1;
      return { skill: { id: skill.id, name: skill.name, whenToUse: skill.whenToUse, version: skill.version, status: skill.status }, score: words.size ? hits / words.size : 0 };
    }).filter((item) => item.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 10);
    res.json({ query, matches });
  }));

  // ----- Teach Mode

  router.post("/workforce/teach", withAccount(async (req, res, db, account) => {
    const body = readBody(req);
    const title = clean(body.title, 160);
    if (!title) throw fail(400, "Say what you're teaching, for example “the weekly company report”.", "invalid");
    const consent = asObject(body.consent);
    if (consent.recordInteractions !== true) throw fail(400, "Teach Mode needs your agreement to record the actions you demonstrate.", "consent-required");
    if (consent.recordAudio === true) throw fail(400, "Teach Mode doesn't record audio. Only permitted interaction steps are recorded.", "audio-refused");
    const bot = body.botId ? await canUseBot(db, account.id, clean(body.botId, 80)) : null;
    if (body.botId && !bot) throw fail(404, "That teammate doesn't exist.", "not-found");
    const computer = body.computerId ? (await db.query("SELECT * FROM hannah_computers WHERE user_id = $1 AND id = $2", [account.id, clean(body.computerId, 80)])).rows[0] : null;
    if (body.computerId && !computer) throw fail(404, "That computer doesn't exist.", "not-found");
    const at = Date.now();
    const teachId = id("tch");
    await db.query(
      "INSERT INTO hannah_teach_sessions (user_id, id, bot_id, computer_id, title, status, consent, events, skill_id, created_at, updated_at, ended_at) VALUES ($1, $2, $3, $4, $5, 'recording', $6, '[]', NULL, $7, $7, NULL)",
      [account.id, teachId, bot?.id || null, computer?.id || null, title, JSON.stringify({ recordInteractions: true, recordFormValues: consent.recordFormValues === true, recordAudio: false, agreedAt: at }), at],
    );
    await recordEvent(db, account.id, "teach.started", { botId: bot?.id || null, computerId: computer?.id || null, detail: { teachId, title } });
    res.status(201).json({ session: { id: teachId, title, status: "recording", consent: { recordInteractions: true, recordFormValues: consent.recordFormValues === true, recordAudio: false }, createdAt: at } });
  }));

  router.get("/workforce/teach/:id", withAccount(async (req, res, db, account) => {
    const session = (await db.query("SELECT * FROM hannah_teach_sessions WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "demonstration")])).rows[0];
    if (!session) throw fail(404, "That demonstration doesn't exist.", "not-found");
    res.json({
      session: {
        id: session.id, title: session.title, status: session.status, botId: session.bot_id || null, computerId: session.computer_id || null,
        consent: parse(session.consent, {}), eventCount: parse(session.events, []).length, skillId: session.skill_id || null,
        createdAt: Number(session.created_at), updatedAt: Number(session.updated_at),
      },
    });
  }));

  router.post("/workforce/teach/:id/events", withAccount(async (req, res, db, account) => {
    const session = (await db.query("SELECT * FROM hannah_teach_sessions WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "demonstration")])).rows[0];
    if (!session) throw fail(404, "That demonstration doesn't exist.", "not-found");
    if (session.status !== "recording") throw fail(409, "This demonstration isn't recording.", "not-recording");
    const consent = parse(session.consent, {});
    const body = readBody(req);
    const raw = Array.isArray(body.events) ? body.events.slice(0, 50) : [body];
    const events = parse(session.events, []);
    for (const item of raw) events.push(sanitizeTeachEvent(item, consent));
    await db.query("UPDATE hannah_teach_sessions SET events = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(events.slice(0, 2000)), Date.now(), account.id, session.id]);
    res.json({ recorded: raw.length, total: Math.min(events.length, 2000) });
  }));

  router.post("/workforce/teach/:id/compile", withAccount(async (req, res, db, account) => {
    const session = (await db.query("SELECT * FROM hannah_teach_sessions WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "demonstration")])).rows[0];
    if (!session) throw fail(404, "That demonstration doesn't exist.", "not-found");
    if (session.status === "compiled" && session.skill_id) {
      return res.json({ skillId: session.skill_id, alreadyCompiled: true });
    }
    const definition = compileTeachSession(session);
    const at = Date.now();
    const skillId = id("skl");
    await db.query(
      `INSERT INTO hannah_workforce_skills (user_id, id, team_id, name, description, when_to_use, inputs, apps, permissions, steps, decision_rules, outputs, failure_handling, safety, status, source, version, tests, published_at, archived_at, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', 'taught', 1, '[]', NULL, NULL, $14, $14)`,
      [account.id, skillId, definition.name, definition.description, definition.whenToUse, JSON.stringify(definition.inputs), JSON.stringify(definition.apps), JSON.stringify(definition.permissions),
        JSON.stringify(definition.steps), JSON.stringify(definition.decisionRules), JSON.stringify(definition.outputs), definition.failureHandling, JSON.stringify(definition.safety), at],
    );
    const row = (await db.query("SELECT * FROM hannah_workforce_skills WHERE user_id = $1 AND id = $2", [account.id, skillId])).rows[0];
    await saveSkillVersion(db, row, definition, "Learned from a demonstration", at);
    await db.query("UPDATE hannah_teach_sessions SET status = 'compiled', skill_id = $1, events = '[]', updated_at = $2, ended_at = $2 WHERE user_id = $3 AND id = $4", [skillId, at, account.id, session.id]);
    await recordEvent(db, account.id, "teach.compiled", { botId: session.bot_id || null, detail: { teachId: session.id, skillId, steps: definition.steps.length } });
    res.status(201).json({ skill: publicSkill(row), session: { id: session.id, status: "compiled", skillId }, note: "This is a draft. Review and dry-test it before approving. It is not scheduled." });
  }));

  router.post("/workforce/teach/:id/cancel", withAccount(async (req, res, db, account) => {
    const session = (await db.query("SELECT * FROM hannah_teach_sessions WHERE user_id = $1 AND id = $2", [account.id, requireId(req.params.id, "demonstration")])).rows[0];
    if (!session) throw fail(404, "That demonstration doesn't exist.", "not-found");
    await db.query("UPDATE hannah_teach_sessions SET status = 'cancelled', events = '[]', updated_at = $1, ended_at = $1 WHERE user_id = $2 AND id = $3", [Date.now(), account.id, session.id]);
    await recordEvent(db, account.id, "teach.cancelled", { detail: { teachId: session.id } });
    res.json({ ok: true, cancelled: true });
  }));

  return router;
}

module.exports = {
  SKILL_ACTIONS, STATUSES, compileTeachSession, createSkillsRouter, definitionFromRow, dryRun,
  normalizeDefinition, publicSkill, sanitizeTeachEvent, saveSkillVersion,
};
