"use strict";

/**
 * "Set up HANNAH" against fake Vercel and Supabase APIs that check what HANNAH
 * sends: the right project found by this site's domain, a new Supabase project
 * with a generated password, the pooled URL tested before anything is saved,
 * sensitive variables (never replacing existing ones unasked), and a fresh
 * production deploy from Git.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const express = require("express");

const VT = "vercel_token_abc";
const ST = "sbp_supabase_token_abc";
const REF = "abcdefghijklmnopqrst";
const calls = [];
let envs = [];
let status = "COMING_UP";
let vercelApi;
let supabaseApi;
let api;
const servers = [];
const tested = [];

function fake(handler) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { calls.push({ method: req.method, path: req.path, query: req.query, body: req.body, auth: req.get("authorization") }); next(); });
  handler(app);
  const server = http.createServer(app);
  servers.push(server);
  return server;
}

before(async () => {
  const v = fake((app) => {
    app.use((req, res, next) => (req.get("authorization") === `Bearer ${VT}` ? next() : res.status(403).json({ error: { message: "Not authorized" } })));
    app.get("/v2/teams", (_req, res) => res.json({ teams: [{ id: "team_1", name: "Harsh's team" }] }));
    app.get("/v10/projects", (req, res) => res.json({ projects: req.query.teamId === "team_1"
      ? [{ id: "prj_hannah", name: "hannah", targets: { production: { alias: ["hannah.example", "hannah.vercel.app"] } }, link: { type: "github", repoId: 42 } }]
      : [{ id: "prj_blog", name: "blog", targets: { production: { alias: ["blog.example"] } } }] }));
    app.get("/v10/projects/prj_hannah/env", (_req, res) => res.json({ envs }));
    app.post("/v10/projects/prj_hannah/env", (req, res) => { envs = req.body.map((item) => ({ key: item.key })); res.status(201).json({ created: req.body, failed: [] }); });
    app.get("/v9/projects/prj_hannah", (_req, res) => res.json({ id: "prj_hannah", name: "hannah", link: { type: "github", repoId: 42, productionBranch: "main" } }));
    app.post("/v13/deployments", (_req, res) => res.json({ id: "dpl_1", url: "hannah-abc.vercel.app", inspectorUrl: "https://vercel.com/i/dpl_1" }));
  });
  const s = fake((app) => {
    app.use((req, res, next) => (req.get("authorization") === `Bearer ${ST}` ? next() : res.status(401).json({ message: "Invalid token" })));
    app.get("/v1/organizations", (_req, res) => res.json([{ id: "o1", slug: "harsh-org", name: "Harsh" }]));
    app.get("/v1/projects", (_req, res) => res.json([{ ref: "zzzzzzzzzzzzzzzzzzzz", name: "old app", region: "us-east-1", status: "ACTIVE_HEALTHY", organization_slug: "harsh-org" }]));
    app.post("/v1/projects", (req, res) => res.status(201).json({ id: REF, ref: REF, name: req.body.name, region: "ap-south-1", status: "COMING_UP", organization_slug: req.body.organization_slug }));
    app.get(`/v1/projects/${REF}`, (_req, res) => res.json({ ref: REF, status }));
    app.patch("/v1/projects/zzzzzzzzzzzzzzzzzzzz/database/password", (_req, res) => res.json({ message: "ok" }));
    app.get(`/v1/projects/${REF}/config/database/pooler`, (_req, res) => res.json([
      { database_type: "PRIMARY", pool_mode: "session", db_user: `postgres.${REF}`, db_host: "aws-0-ap-south-1.pooler.supabase.com", db_port: 5432, db_name: "postgres" },
      { database_type: "PRIMARY", pool_mode: "transaction", db_user: `postgres.${REF}`, db_host: "aws-0-ap-south-1.pooler.supabase.com", db_port: 6543, db_name: "postgres" },
    ]));
  });
  for (const server of [v, s]) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
  vercelApi = `http://127.0.0.1:${v.address().port}`;
  supabaseApi = `http://127.0.0.1:${s.address().port}`;
  process.env.HANNAH_SETUP_VERCEL_API = vercelApi;
  process.env.HANNAH_SETUP_SUPABASE_API = supabaseApi;
  const { createHostingSetupRouter } = require("./hosting-setup");
  const app = express();
  app.use("/api", createHostingSetupRouter({ publicHost: () => "hannah.example", testUrl: async (url) => { tested.push(url); return { ok: true }; } }));
  const server = http.createServer(app);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  api = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => servers.forEach((server) => server.close()));

const post = async (path, body) => {
  const response = await fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test("finds the Vercel project serving this site and the Supabase organizations", async () => {
  const found = await post("/setup/hosting/discover", { vercelToken: VT, supabaseToken: ST });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(found.body.host, "hannah.example");
  assert.deepEqual(found.body.vercel.projects[0], { id: "prj_hannah", name: "hannah", teamId: "team_1", team: "Harsh's team", domains: ["hannah.example", "hannah.vercel.app"], serves: true, git: true });
  assert.equal(found.body.vercel.projects[1].serves, false);
  assert.deepEqual(found.body.supabase.organizations, [{ slug: "harsh-org", name: "Harsh" }]);
  // A wrong token says which service refused it.
  const refused = await post("/setup/hosting/discover", { vercelToken: "wrong", supabaseToken: ST });
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /Vercel didn't accept that token/);
});

test("creates a Supabase project with a generated password, waits for it, then saves sensitive settings and deploys from Git", async () => {
  const database = await post("/setup/hosting/database", { supabaseToken: ST, mode: "new", organizationSlug: "harsh-org", region: "ap-south-1" });
  assert.equal(database.status, 200, JSON.stringify(database.body));
  assert.equal(database.body.projectRef, REF);
  assert.ok(database.body.databasePassword.length >= 30 && /^[A-Za-z0-9]+$/.test(database.body.databasePassword), "a long password that needs no escaping");
  const created = calls.find((call) => call.method === "POST" && call.path === "/v1/projects");
  assert.deepEqual(created.body, { name: "hannah", organization_slug: "harsh-org", db_pass: database.body.databasePassword, region_selection: { type: "specific", code: "ap-south-1" } });

  assert.deepEqual((await post("/setup/hosting/status", { supabaseToken: ST, projectRef: REF })).body, { status: "COMING_UP", ready: false });
  status = "ACTIVE_HEALTHY";
  assert.equal((await post("/setup/hosting/status", { supabaseToken: ST, projectRef: REF })).body.ready, true);

  const finished = await post("/setup/hosting/finish", { vercelToken: VT, teamId: "team_1", projectId: "prj_hannah", supabaseToken: ST, projectRef: REF, databasePassword: database.body.databasePassword });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const url = `postgresql://postgres.${REF}:${database.body.databasePassword}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`;
  assert.deepEqual(tested, [url], "the transaction pooler URL was connected to before anything was saved");
  const saved = calls.find((call) => call.method === "POST" && call.path === "/v10/projects/prj_hannah/env");
  assert.equal(saved.query.teamId, "team_1");
  assert.equal(saved.query.upsert, "true");
  assert.deepEqual(saved.body.map((item) => [item.key, item.type, item.target.join("+")]), [["DATABASE_URL", "sensitive", "production+preview"], ["HANNAH_VAULT_KEY", "sensitive", "production+preview"], ["CRON_SECRET", "sensitive", "production+preview"]]);
  assert.equal(saved.body[0].value, url);
  assert.match(saved.body[1].value, /^[0-9a-f]{64}$/);
  assert.deepEqual(finished.body.secrets, { HANNAH_VAULT_KEY: saved.body[1].value, CRON_SECRET: saved.body[2].value }, "shown once so the person can keep a copy");
  const deployed = calls.find((call) => call.method === "POST" && call.path === "/v13/deployments");
  assert.deepEqual(deployed.body, { name: "hannah", project: "prj_hannah", target: "production", gitSource: { type: "github", repoId: 42, ref: "main" } });
  assert.equal(finished.body.deployment.url, "https://hannah-abc.vercel.app");
  assert.ok(calls.every((call) => !call.auth || call.auth === `Bearer ${VT}` || call.auth === `Bearer ${ST}` || call.auth === "Bearer wrong"), "tokens only go to their own service");
});

test("existing settings aren't replaced unless confirmed, and resetting a password needs confirmation", async () => {
  envs = [{ key: "DATABASE_URL" }, { key: "HANNAH_VAULT_KEY" }];
  const before = calls.length;
  const clash = await post("/setup/hosting/finish", { vercelToken: VT, teamId: "team_1", projectId: "prj_hannah", supabaseToken: ST, projectRef: REF, databasePassword: "p".repeat(32) });
  assert.equal(clash.status, 409);
  assert.deepEqual(clash.body.existing, ["DATABASE_URL", "HANNAH_VAULT_KEY"]);
  assert.match(clash.body.error, /unreadable/);
  assert.ok(!calls.slice(before).some((call) => call.method === "POST"), "nothing saved or deployed");
  assert.equal((await post("/setup/hosting/finish", { vercelToken: VT, teamId: "team_1", projectId: "prj_hannah", supabaseToken: ST, projectRef: REF, databasePassword: "p".repeat(32), replace: true })).status, 200);

  const unconfirmed = await post("/setup/hosting/database", { supabaseToken: ST, mode: "reset", projectRef: "zzzzzzzzzzzzzzzzzzzz" });
  assert.equal(unconfirmed.body.reason, "confirm-reset");
  assert.ok(!calls.some((call) => call.method === "PATCH"));
  const reset = await post("/setup/hosting/database", { supabaseToken: ST, mode: "reset", projectRef: "zzzzzzzzzzzzzzzzzzzz", confirmReset: true });
  assert.equal(reset.status, 200);
  assert.equal(calls.find((call) => call.method === "PATCH").body.password, reset.body.databasePassword);
});
