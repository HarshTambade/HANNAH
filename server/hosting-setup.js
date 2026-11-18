"use strict";

/**
 * "Set up HANNAH": connect this deployment to Vercel and Supabase from the app.
 *
 * With a Vercel access token and a Supabase access token that the person
 * pastes (and that only reach their own accounts), HANNAH:
 *   1. finds the Vercel project serving this site (by its domain);
 *   2. creates a Supabase project for HANNAH with a generated database
 *      password, or (only when asked, with a warning) resets an existing
 *      project's password;
 *   3. waits until the database is up, builds its pooled connection URL from
 *      Supabase's pooler settings, and connects to it (TLS verified) before
 *      saving anything;
 *   4. saves DATABASE_URL, HANNAH_VAULT_KEY and CRON_SECRET to the Vercel
 *      project as sensitive variables (never replacing ones that exist unless
 *      the person confirms), and
 *   5. deploys the production branch again from Git, so the new settings apply.
 *
 * The server stores nothing: tokens arrive with each request and go only to
 * api.vercel.com and api.supabase.com (fixed hosts). The generated secrets are
 * returned once to the browser that asked, so the person can keep a copy.
 *
 *   POST /api/setup/hosting/discover   { vercelToken, supabaseToken }
 *   POST /api/setup/hosting/database   { supabaseToken, mode: "new"|"reset", organizationSlug?, region?, projectRef?, confirmReset? }
 *   POST /api/setup/hosting/status     { supabaseToken, projectRef }
 *   POST /api/setup/hosting/finish     { vercelToken, teamId?, projectId, supabaseToken, projectRef, databasePassword, replace? }
 */
const crypto = require("node:crypto");
const express = require("express");
const { testDatabaseUrl, describeDatabaseError } = require("./db");

const VERCEL = process.env.HANNAH_SETUP_VERCEL_API || "https://api.vercel.com";
const SUPABASE = process.env.HANNAH_SETUP_SUPABASE_API || "https://api.supabase.com";
const KEYS = ["DATABASE_URL", "HANNAH_VAULT_KEY", "CRON_SECRET"];
const REGIONS = new Set(["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ap-east-1", "ap-southeast-1", "ap-northeast-1", "ap-northeast-2", "ap-southeast-2", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-central-1", "eu-central-2", "ca-central-1", "ap-south-1", "sa-east-1"]);

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const token = (value, name) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 512 || /[\s]/.test(text)) throw fail(400, `Paste your ${name} access token.`, "token-required");
  return text;
};
/** A database password Supabase accepts and that needs no escaping in a URL. */
const password = () => crypto.randomBytes(24).toString("base64url").replace(/[-_]/g, "x");

function createHostingSetupRouter({ fetchImpl = (...args) => fetch(...args), testUrl = testDatabaseUrl, publicHost = (req) => req.get("x-forwarded-host") || req.get("host") || "" } = {}) {
  const router = express.Router();
  const json = express.json({ limit: "64kb" });
  const hits = new Map();

  async function call(base, path, bearer, { method = "GET", body, service } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw fail(502, `${service} didn't answer. Try again.`, "unreachable");
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || data?.error || "";
      if (response.status === 401 || response.status === 403) throw fail(401, `${service} didn't accept that token${detail ? ` (${String(detail).slice(0, 160)})` : ""}. Check it has access to the account you mean.`, "token-rejected");
      throw fail(502, `${service} answered ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}.`, "upstream");
    }
    return data;
  }
  const vercel = (path, bearer, options) => call(VERCEL, path, bearer, { ...options, service: "Vercel" });
  const supabase = (path, bearer, options) => call(SUPABASE, path, bearer, { ...options, service: "Supabase" });
  const team = (teamId) => (teamId ? `teamId=${encodeURIComponent(teamId)}` : "");
  const withTeam = (path, teamId) => (teamId ? `${path}${path.includes("?") ? "&" : "?"}${team(teamId)}` : path);

  const handle = (fn) => async (req, res) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.at > 60_000) hits.set(key, { at: now, n: 1 });
    else if (++entry.n > 60) return res.status(429).json({ error: "Too many setup requests. Wait a minute.", reason: "rate-limited" });
    res.setHeader("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ error: status >= 500 && !error.reason ? "Setup didn't complete." : error.message, reason: error.reason || "error" });
    }
  };

  /** The person's Vercel projects (personal and teams), marking the one that serves this host. */
  async function vercelProjects(bearer, host) {
    const teams = (await vercel("/v2/teams?limit=50", bearer))?.teams || [];
    const scopes = [{ id: null, name: "Personal account" }, ...teams.map((item) => ({ id: item.id, name: item.name || item.slug }))];
    const projects = [];
    for (const scope of scopes.slice(0, 20)) {
      let list;
      try {
        list = (await vercel(withTeam("/v10/projects?limit=100", scope.id), bearer))?.projects || [];
      } catch (error) {
        if (scope.id) continue; // A team the token can't see.
        throw error;
      }
      for (const project of list) {
        const aliases = [...(project.targets?.production?.alias || []), ...(project.alias || []).map((item) => item?.domain || item)].filter((item) => typeof item === "string");
        projects.push({ id: project.id, name: project.name, teamId: scope.id, team: scope.name, domains: [...new Set(aliases)].slice(0, 10), serves: Boolean(host) && aliases.includes(host), git: project.link?.type === "github" && Boolean(project.link?.repoId) });
      }
    }
    return projects.sort((a, b) => Number(b.serves) - Number(a.serves));
  }

  router.post("/setup/hosting/discover", json, handle(async (req, res) => {
    const vercelToken = token(req.body?.vercelToken, "Vercel");
    const supabaseToken = token(req.body?.supabaseToken, "Supabase");
    const host = String(publicHost(req)).toLowerCase();
    const [projects, organizations, supabaseProjects] = await Promise.all([
      vercelProjects(vercelToken, host),
      supabase("/v1/organizations", supabaseToken),
      supabase("/v1/projects", supabaseToken),
    ]);
    res.json({
      host,
      vercel: { projects },
      supabase: {
        organizations: (organizations || []).map((org) => ({ slug: org.slug, name: org.name })),
        projects: (supabaseProjects || []).map((project) => ({ ref: project.ref || project.id, name: project.name, region: project.region, status: project.status, organizationSlug: project.organization_slug })),
      },
    });
  }));

  router.post("/setup/hosting/database", json, handle(async (req, res) => {
    const supabaseToken = token(req.body?.supabaseToken, "Supabase");
    const databasePassword = password();
    if (req.body?.mode === "reset") {
      const ref = String(req.body?.projectRef || "");
      if (!/^[a-z]{20}$/.test(ref)) throw fail(400, "Pick the Supabase project.", "invalid");
      if (req.body?.confirmReset !== true) throw fail(400, "Resetting the database password breaks anything else that uses it. Confirm to continue.", "confirm-reset");
      await supabase(`/v1/projects/${ref}/database/password`, supabaseToken, { method: "PATCH", body: { password: databasePassword } });
      return res.json({ projectRef: ref, databasePassword, created: false });
    }
    const organizationSlug = String(req.body?.organizationSlug || "");
    if (!organizationSlug || organizationSlug.length > 100) throw fail(400, "Pick the Supabase organization.", "invalid");
    const region = REGIONS.has(req.body?.region) ? req.body.region : "ap-south-1";
    const name = String(req.body?.name || "hannah").replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 60) || "hannah";
    const project = await supabase("/v1/projects", supabaseToken, { method: "POST", body: { name, organization_slug: organizationSlug, db_pass: databasePassword, region_selection: { type: "specific", code: region } } });
    res.json({ projectRef: project?.ref || project?.id, databasePassword, created: true, region });
  }));

  router.post("/setup/hosting/status", json, handle(async (req, res) => {
    const supabaseToken = token(req.body?.supabaseToken, "Supabase");
    const ref = String(req.body?.projectRef || "");
    if (!/^[a-z]{20}$/.test(ref)) throw fail(400, "Pick the Supabase project.", "invalid");
    const project = await supabase(`/v1/projects/${ref}`, supabaseToken);
    res.json({ status: project?.status || "UNKNOWN", ready: project?.status === "ACTIVE_HEALTHY" });
  }));

  router.post("/setup/hosting/finish", json, handle(async (req, res) => {
    const vercelToken = token(req.body?.vercelToken, "Vercel");
    const supabaseToken = token(req.body?.supabaseToken, "Supabase");
    const ref = String(req.body?.projectRef || "");
    const projectId = String(req.body?.projectId || "");
    const teamId = req.body?.teamId ? String(req.body.teamId) : null;
    const databasePassword = String(req.body?.databasePassword || "");
    if (!/^[a-z]{20}$/.test(ref) || !projectId || projectId.length > 100 || databasePassword.length < 16) throw fail(400, "Something's missing: start the setup again.", "invalid");

    // The pooled (transaction mode) connection for serverless hosting.
    const pooler = await supabase(`/v1/projects/${ref}/config/database/pooler`, supabaseToken);
    const entries = Array.isArray(pooler) ? pooler : [pooler].filter(Boolean);
    const primary = entries.find((item) => item.database_type === "PRIMARY" && item.pool_mode === "transaction") || entries.find((item) => item.database_type === "PRIMARY") || entries[0];
    if (!primary?.db_host || !primary?.db_user) throw fail(502, "Supabase didn't return the database's connection settings yet. Wait a minute and try again.", "pooler-not-ready");
    const port = primary.pool_mode === "transaction" ? primary.db_port || 6543 : 6543;
    const databaseUrl = `postgresql://${encodeURIComponent(primary.db_user)}:${encodeURIComponent(databasePassword)}@${primary.db_host}:${port}/${encodeURIComponent(primary.db_name || "postgres")}`;

    // Connect before saving anything.
    try {
      await testUrl(databaseUrl);
    } catch (error) {
      throw fail(502, `The new database isn't accepting connections yet (${describeDatabaseError(error)}). Wait a minute and try again.`, "database-not-ready");
    }

    // Never replace existing settings without the person's say-so.
    const listed = await vercel(withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env`, teamId), vercelToken);
    const existing = (Array.isArray(listed?.envs) ? listed.envs : Array.isArray(listed) ? listed : []).map((item) => item.key);
    const clashes = KEYS.filter((key) => existing.includes(key));
    if (clashes.length && req.body?.replace !== true) {
      return res.status(409).json({ error: `This Vercel project already has ${clashes.join(", ")}. Replacing ${clashes.includes("HANNAH_VAULT_KEY") ? "HANNAH_VAULT_KEY makes keys saved with the old one unreadable" : "them changes which database HANNAH uses"}. Confirm to replace.`, reason: "exists", existing: clashes });
    }
    const vaultKey = crypto.randomBytes(32).toString("hex");
    const cronSecret = crypto.randomBytes(24).toString("hex");
    const values = { DATABASE_URL: databaseUrl, HANNAH_VAULT_KEY: vaultKey, CRON_SECRET: cronSecret };
    const saved = await vercel(withTeam(`/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`, teamId), vercelToken, {
      method: "POST",
      body: KEYS.map((key) => ({ key, value: values[key], type: "sensitive", target: ["production", "preview"], comment: "Set by HANNAH's hosting setup" })),
    });
    if (Array.isArray(saved?.failed) && saved.failed.length) throw fail(502, `Vercel didn't save ${saved.failed.map((item) => item?.error?.key || item?.error?.envVarKey).filter(Boolean).join(", ") || "the settings"}: ${saved.failed[0]?.error?.message || "unknown error"}.`, "env-failed");

    // Deploy the production branch from Git so the settings apply (a plain redeploy keeps the old ones).
    const project = await vercel(withTeam(`/v9/projects/${encodeURIComponent(projectId)}`, teamId), vercelToken);
    let deployment = null;
    if (project?.link?.type === "github" && project.link.repoId) {
      const created = await vercel(withTeam("/v13/deployments", teamId), vercelToken, {
        method: "POST",
        body: { name: project.name, project: project.id, target: "production", gitSource: { type: "github", repoId: project.link.repoId, ref: project.link.productionBranch || "main" } },
      });
      deployment = { id: created?.id || created?.uid || null, url: created?.url ? `https://${created.url}` : null, inspector: created?.inspectorUrl || null };
    }
    res.json({ saved: KEYS, deployment, secrets: { HANNAH_VAULT_KEY: vaultKey, CRON_SECRET: cronSecret }, database: { host: primary.db_host, ref } });
  }));

  return router;
}

module.exports = { createHostingSetupRouter };
