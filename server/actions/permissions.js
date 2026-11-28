"use strict";

/**
 * The permission manager: what HANNAH may do for an account, decided in one
 * place for every caller (chat, voice, agents, workflows, MCP hosts, devices).
 *
 * A person sets a level per service:
 *
 *   1 Read only            look at what they authorized; change nothing
 *   2 Suggest              also prepare drafts and proposals; submit nothing
 *   3 Approval before act  act only after they approve that action (the default)
 *   4 Scoped autonomy      also act alone where a standing grant names the action and its limits
 *   5 Advanced delegation  grants may cover a whole service, and must expire
 *
 * and may add standing grants: this action, on this resource (a repository, a
 * recipient, a calendar), within these limits, until this date. A grant can be
 * revoked at once; every evaluation reads the current policy, so a task that
 * is running loses the permission with its next action.
 *
 * What no level or grant changes:
 *   - Paying, purchasing, deleting, merging, deploying and changing security
 *     settings ask every time. (A booking may be covered by a grant only when
 *     the grant names that exact action and an amount limit.)
 *   - An action flagged by its own checks (an ambiguous recipient, a private
 *     file leaving the account, a push to the default branch) asks even when a
 *     grant matches.
 *   - While the emergency stop is on, nothing but reading runs, except an
 *     action that only reduces what is happening (stopping a robot): an action
 *     defined with `deescalates: true` is allowed at every level and during a
 *     stop, because refusing it could never be the safer choice.
 *
 * evaluate() is pure: it takes the policy, the grants and the action, and
 * returns { outcome: "allow" | "ask" | "suggest" | "deny", reason, ... }.
 */
const crypto = require("node:crypto");

const SERVICES = {
  code: { label: "Code and repositories", description: "Read repositories, prepare changes, commit to working branches, open pull requests." },
  calendar: { label: "Calendar", description: "Read events, check free time, create, change and delete events." },
  mail: { label: "Email", description: "Read and search mail, write drafts, organize, send." },
  messages: { label: "Messaging", description: "Read connected chats, draft and send messages." },
  browser: { label: "Web and browser", description: "Open pages, fill and submit forms." },
  connectors: { label: "Connectors and outside tools", description: "Call tools of services you connected (MCP connectors)." },
  bookings: { label: "Bookings", description: "Find options, prepare and make reservations." },
  files: { label: "Files", description: "Read and write files in folders you shared and files HANNAH made." },
  device: { label: "This device", description: "Run commands, open apps, control the desktop, change settings." },
  robots: { label: "Robots", description: "Read a robot's state and sensors, start and cancel missions on robots you enrolled. Stopping a robot is always allowed." },
  hardware: { label: "Devices and smart hardware", description: "Read sensors, switch and set devices you connected through a hub, and create automations the hub runs by itself." },
};

const LEVELS = [
  { level: 1, name: "Read only", description: "HANNAH may look at what you authorized and change nothing." },
  { level: 2, name: "Suggest", description: "HANNAH may also prepare drafts and proposals. Nothing is submitted." },
  { level: 3, name: "Approval before action", description: "HANNAH acts only after you approve each action." },
  { level: 4, name: "Scoped autonomy", description: "HANNAH also acts alone where one of your standing permissions names the action and its limits." },
  { level: 5, name: "Advanced delegation", description: "Standing permissions may cover a whole service. Each must have an end date." },
];
const DEFAULT_LEVEL = 3;

/** What an action does, from least to most consequential. */
const KINDS = {
  read: { label: "Reads", minLevel: 1 },
  prepare: { label: "Prepares a draft", minLevel: 2 },
  write: { label: "Changes something of yours", minLevel: 3 },
  send: { label: "Reaches other people", minLevel: 3 },
  spend: { label: "Spends money or commits you", minLevel: 3 },
  destroy: { label: "Deletes or can't be undone", minLevel: 3 },
};

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback) => { try { const value = JSON.parse(text); return value ?? fallback; } catch { return fallback; } };

function defaultPolicy() {
  return { levels: Object.fromEntries(Object.keys(SERVICES).map((id) => [id, DEFAULT_LEVEL])), stoppedAt: null };
}

function normalizePolicy(input) {
  const policy = defaultPolicy();
  for (const id of Object.keys(SERVICES)) {
    const level = Number(input?.levels?.[id]);
    if (Number.isInteger(level) && level >= 1 && level <= 5) policy.levels[id] = level;
  }
  return policy;
}

/** A grant as people write it: checked, never widened. */
function normalizeGrant(input, { now = Date.now(), level = DEFAULT_LEVEL, knownActions = null } = {}) {
  const service = String(input?.service || "");
  if (!Object.hasOwn(SERVICES, service)) throw fail(400, "Choose the service this permission is for.", "bad-grant");
  let actions = Array.isArray(input?.actions) ? [...new Set(input.actions.map((item) => clean(item, 60)).filter(Boolean))].slice(0, 20) : [];
  if (!actions.length) throw fail(400, "Name at least one action this permission covers.", "bad-grant");
  const wide = actions.includes("*");
  if (wide) actions = ["*"];
  if (!wide && knownActions) {
    const unknown = actions.filter((id) => !knownActions.has(id) || knownActions.get(id).service !== service);
    if (unknown.length) throw fail(400, `Not an action of this service: ${unknown.join(", ")}.`, "bad-grant");
  }
  const expiresAt = input?.expiresAt ? Number(new Date(input.expiresAt)) : null;
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) throw fail(400, "The end date must be in the future.", "bad-grant");
  if (wide && level < 5) throw fail(400, "A permission for every action of a service needs level 5 (Advanced delegation) for that service.", "level-too-low");
  if (!wide && level < 4) throw fail(400, "Standing permissions need level 4 (Scoped autonomy) or 5 for that service.", "level-too-low");
  if (wide && expiresAt === null) throw fail(400, "A permission for every action of a service must have an end date.", "bad-grant");
  if (expiresAt !== null && expiresAt - now > 366 * 86_400_000) throw fail(400, "A permission can last a year at most.", "bad-grant");
  const resource = input?.resource && typeof input.resource === "object" && clean(input.resource.match, 300)
    ? { type: clean(input.resource.type, 40) || "any", match: clean(input.resource.match, 300) }
    : null;
  const limits = {};
  const amount = Number(input?.limits?.maxAmount);
  if (Number.isFinite(amount) && amount > 0) { limits.maxAmount = amount; limits.currency = clean(input.limits.currency, 8).toUpperCase() || "USD"; }
  const perDay = Number(input?.limits?.perDay);
  if (Number.isInteger(perDay) && perDay > 0) limits.perDay = Math.min(perDay, 1000);
  const hours = input?.limits?.hours;
  if (hours && Number.isInteger(hours.from) && Number.isInteger(hours.to) && hours.from >= 0 && hours.from <= 23 && hours.to >= 1 && hours.to <= 24) {
    limits.hours = { from: hours.from, to: hours.to, timeZone: clean(hours.timeZone, 60) || "UTC" };
  }
  return { id: crypto.randomUUID(), service, actions, resource, limits, note: clean(input?.note, 300), createdAt: now, expiresAt, revokedAt: null, lastUsedAt: null, uses: 0 };
}

/** Does this grant's resource cover the action's? `*` at the end of a match covers a prefix (an owner's repositories, a domain's addresses). */
function resourceCovers(grantResource, resource) {
  if (!grantResource) return true;
  if (!resource?.id) return false;
  if (grantResource.type !== "any" && resource.type && grantResource.type !== resource.type) return false;
  const want = grantResource.match.toLowerCase();
  const ids = [resource.id, ...(Array.isArray(resource.all) ? resource.all : [])].map((item) => String(item).toLowerCase());
  // Every party must be covered: a grant for one recipient doesn't cover a message that also goes to another.
  return ids.every((have) => (want.endsWith("*") ? have.startsWith(want.slice(0, -1)) : want.startsWith("*") ? have.endsWith(want.slice(1)) : have === want));
}

function hourIn(timeZone, at) {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at)));
  } catch {
    return new Date(at).getUTCHours();
  }
}

/**
 * Decide one action.
 *   action   { id, service, kind, standing?: boolean }   standing: a grant may cover it (never for payments)
 *   call     { resource?: { type, id, all? }, amount?: { value, currency }, flags?: string[] }
 *   usage    { today: Map<grantId, count> }  how often each grant was used today
 */
function evaluate({ policy, grants = [], action, call = {}, now = Date.now(), usage = {} }) {
  const service = SERVICES[action.service];
  const kind = KINDS[action.kind];
  if (!service || !kind) return { outcome: "deny", reason: "This action isn't known to the permission manager.", code: "unknown-action" };
  const level = policy?.levels?.[action.service] ?? DEFAULT_LEVEL;
  const levelName = LEVELS[level - 1].name;
  const base = { level, levelName };
  if (action.deescalates === true) return { ...base, outcome: "allow", code: "deescalates", reason: "Stopping is always allowed." };
  if (policy?.stoppedAt && action.kind !== "read") {
    return { ...base, outcome: "deny", code: "stopped", reason: "The emergency stop is on. Nothing but reading runs until you turn it off in Permissions." };
  }
  if (action.kind === "read") return { ...base, outcome: "allow", code: "read", reason: "Reading what you connected needs no further approval." };
  if (level === 1) return { ...base, outcome: "deny", code: "read-only", reason: `${service.label} is set to Read only, so HANNAH can't ${action.kind === "prepare" ? "prepare this" : "do this"}. Change it in Permissions.` };
  if (action.kind === "prepare") return { ...base, outcome: "allow", code: "prepare", reason: "Preparing a draft submits nothing." };
  if (level === 2) return { ...base, outcome: "suggest", code: "suggest-only", reason: `${service.label} is set to Suggest: this is prepared for you and not submitted.` };

  const flags = Array.isArray(call.flags) ? call.flags.filter(Boolean) : [];
  const blocked = flags.find((flag) => flag.startsWith("forbidden:"));
  if (blocked) return { ...base, outcome: "deny", code: "forbidden", reason: blocked.slice("forbidden:".length) };
  // An action's own rule (a robot autonomy policy of "suggest only") may say it is only prepared.
  const suggested = flags.find((flag) => flag.startsWith("suggest:"));
  if (suggested) return { ...base, outcome: "suggest", code: "suggest-only", reason: suggested.slice("suggest:".length) };
  const mustAsk = action.kind === "destroy" || (action.kind === "spend" && action.standing !== true) || action.standing === false;
  if (mustAsk) return { ...base, outcome: "ask", code: "always-asks", reason: `${kind.label}: this always needs your approval.` };
  if (flags.length) return { ...base, outcome: "ask", code: "flagged", reason: `Needs your approval: ${flags.join("; ")}.`, flags };
  if (level < 4) return { ...base, outcome: "ask", code: "approval", reason: `${service.label} is set to ${levelName}.` };

  for (const grant of grants) {
    if (grant.service !== action.service || grant.revokedAt) continue;
    if (grant.expiresAt && grant.expiresAt <= now) continue;
    const wide = grant.actions.includes("*");
    if (wide && level < 5) continue;
    if (!wide && !grant.actions.includes(action.id)) continue;
    // Committing money needs a grant that names the action itself and an amount.
    if (action.kind === "spend" && (wide || !grant.limits?.maxAmount)) continue;
    if (!resourceCovers(grant.resource, call.resource)) continue;
    if (grant.limits?.maxAmount) {
      const amount = call.amount;
      if (action.kind === "spend" && !amount) continue;
      if (amount && (amount.value > grant.limits.maxAmount || String(amount.currency || "").toUpperCase() !== grant.limits.currency)) continue;
    }
    if (grant.limits?.perDay && (usage.today?.get?.(grant.id) ?? 0) >= grant.limits.perDay) continue;
    if (grant.limits?.hours) {
      const hour = hourIn(grant.limits.hours.timeZone, now);
      const { from, to } = grant.limits.hours;
      if (!(from < to ? hour >= from && hour < to : hour >= from || hour < to)) continue;
    }
    return { ...base, outcome: "allow", code: "grant", grantId: grant.id, reason: `Covered by your standing permission${grant.note ? ` “${grant.note}”` : ""}.` };
  }
  return { ...base, outcome: "ask", code: "no-grant", reason: "No standing permission covers this, so it needs your approval." };
}

// ---------- storage ----------

const grantFromRow = (row) => ({
  id: row.id, service: row.service, actions: parse(row.actions, []), resource: parse(row.resource, null), limits: parse(row.limits, {}) || {}, note: row.note || "",
  createdAt: Number(row.created_at), expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
  lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at), uses: Number(row.uses) || 0,
});

async function loadPolicy(db, userId) {
  const { rows } = await db.query("SELECT policy, stopped_at FROM hannah_permissions WHERE user_id = $1", [userId]);
  const policy = normalizePolicy(rows[0] ? parse(rows[0].policy, {}) : {});
  policy.stoppedAt = rows[0]?.stopped_at ? Number(rows[0].stopped_at) : null;
  return policy;
}

async function savePolicy(db, userId, input, now = Date.now()) {
  const current = await loadPolicy(db, userId);
  const next = normalizePolicy({ levels: { ...current.levels, ...(input?.levels || {}) } });
  const text = JSON.stringify({ levels: next.levels });
  const updated = await db.query("UPDATE hannah_permissions SET policy = $1, updated_at = $2 WHERE user_id = $3", [text, now, userId]);
  if (!updated.rowCount) await db.query("INSERT INTO hannah_permissions (user_id, policy, stopped_at, updated_at) VALUES ($1, $2, NULL, $3)", [userId, text, now]);
  // Lowering a level ends the grants that needed the higher one, so nothing keeps running on an old setting.
  const grants = await listGrants(db, userId, { now });
  for (const grant of grants) {
    const level = next.levels[grant.service];
    if (grant.active && (level < 4 || (grant.actions.includes("*") && level < 5))) await revokeGrant(db, userId, grant.id, now);
  }
  return { ...next, stoppedAt: current.stoppedAt };
}

async function setStopped(db, userId, stopped, now = Date.now()) {
  const current = await loadPolicy(db, userId);
  const text = JSON.stringify({ levels: current.levels });
  const updated = await db.query("UPDATE hannah_permissions SET stopped_at = $1, updated_at = $2 WHERE user_id = $3", [stopped ? now : null, now, userId]);
  if (!updated.rowCount) await db.query("INSERT INTO hannah_permissions (user_id, policy, stopped_at, updated_at) VALUES ($1, $2, $3, $4)", [userId, text, stopped ? now : null, now]);
  return { ...current, stoppedAt: stopped ? now : null };
}

async function listGrants(db, userId, { now = Date.now(), activeOnly = false } = {}) {
  const { rows } = await db.query("SELECT * FROM hannah_grants WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
  return rows.map(grantFromRow)
    .map((grant) => ({ ...grant, active: !grant.revokedAt && !(grant.expiresAt && grant.expiresAt <= now) }))
    .filter((grant) => !activeOnly || grant.active);
}

async function addGrant(db, userId, input, { now = Date.now(), knownActions } = {}) {
  const policy = await loadPolicy(db, userId);
  const grant = normalizeGrant(input, { now, level: policy.levels[input?.service] ?? DEFAULT_LEVEL, knownActions });
  const { rows } = await db.query("SELECT COUNT(*) AS n FROM hannah_grants WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  if (Number(rows[0].n) >= 100) throw fail(400, "You have 100 standing permissions. Revoke one first.", "too-many");
  await db.query(
    "INSERT INTO hannah_grants (user_id, id, service, actions, resource, limits, note, created_at, expires_at, revoked_at, last_used_at, uses) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, 0)",
    [userId, grant.id, grant.service, JSON.stringify(grant.actions), grant.resource ? JSON.stringify(grant.resource) : null, JSON.stringify(grant.limits), grant.note, grant.createdAt, grant.expiresAt],
  );
  return { ...grant, active: true };
}

async function revokeGrant(db, userId, id, now = Date.now()) {
  const result = await db.query("UPDATE hannah_grants SET revoked_at = $1 WHERE user_id = $2 AND id = $3 AND revoked_at IS NULL", [now, userId, String(id)]);
  return result.rowCount > 0;
}

async function markGrantUsed(db, userId, id, now = Date.now()) {
  await db.query("UPDATE hannah_grants SET last_used_at = $1, uses = uses + 1 WHERE user_id = $2 AND id = $3", [now, userId, id]);
}

module.exports = { DEFAULT_LEVEL, KINDS, LEVELS, SERVICES, addGrant, defaultPolicy, evaluate, listGrants, loadPolicy, markGrantUsed, normalizeGrant, normalizePolicy, resourceCovers, revokeGrant, savePolicy, setStopped };
