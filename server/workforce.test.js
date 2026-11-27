/**
 * The AI workforce end to end: real HTTP, the real SQLite account database, a
 * real server-side task runner, real files and a durable routine scheduler.
 * The only stand-in is the model provider, which answers at api.groq.com.
 *
 * Postgres runs the same suite through workforce.pglite.test.js.
 */
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workforce-test-token-0123456789-abcdefghijkl";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.CRON_SECRET = "workforce-cron-secret-0123456789";
process.env.WORKFORCE_WORKER = "off";

const realFetch = globalThis.fetch;
const modelCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://api.groq.com/")) {
    const body = JSON.parse(init.body || "{}");
    const system = body.messages?.find((message) => message.role === "system")?.content || "";
    const prompt = body.messages?.find((message) => message.role === "user")?.content || "";
    modelCalls.push({ model: body.model, system, prompt });
    const content = /faithful meeting notes/i.test(system)
      ? JSON.stringify({
        summary: "The team agreed to ship the migration on Friday.",
        decisions: ["Ship the migration on Friday"],
        actionItems: [{ title: "Send the migration recap", owner: "Alice", due: "", details: "Send it to the team channel." }],
        risks: ["The rollback plan is not written yet"],
        followUps: ["Confirm the rollback owner"],
      })
      : JSON.stringify({
        summary: "Completed the task with a short, sourced report.",
        findings: ["The report is saved as an artifact."],
        deliverables: [{ name: "report.md", type: "text/markdown", content: "# Report\n\nReal content produced by the runner." }],
        memory: [{ kind: "worklog", content: "Ran the research task and saved a report." }],
        nextSteps: [{ action: "mail.send", title: "Email the report to the team", reason: "A person should review and send it." }],
      });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 12 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
};

let server;
let baseUrl;
let db;
const users = {};

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  db = await require("./db").getDatabase();
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  globalThis.fetch = realFetch;
  await require("./db").resetDatabase();
});

async function signUp(email) {
  const response = await realFetch(`${baseUrl}/api/account/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const row = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [email])).rows[0];
  users[email] = { id: row.id, cookie };
  return users[email];
}

async function storeProviderKey(userId, value = "gsk_test_workforce_key_0123456789") {
  const { encryptSecret } = require("./vault");
  const sealed = encryptSecret(value, { userId, providerId: "groq" });
  await db.query(
    "INSERT INTO hannah_credentials (user_id, provider_id, key_id, wrapped_key, ciphertext, hint, created_at, updated_at) VALUES ($1, 'groq', $2, $3, $4, $5, $6, $6)",
    [userId, sealed.keyId, sealed.wrappedKey, sealed.ciphertext, "gsk_…6789", Date.now()],
  );
}

function client(cookie) {
  const call = async (method, path, body) => {
    const response = await realFetch(`${baseUrl}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return {
    call,
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    patch: (path, body) => call("PATCH", path, body),
    delete: (path) => call("DELETE", path),
  };
}

const state = {};

test("accounts, overview and provider status are real", async () => {
  const alice = await signUp("alice@example.com");
  const bob = await signUp("bob@example.com");
  const carol = await signUp("carol@example.com");
  await storeProviderKey(alice.id);
  state.alice = client(alice.cookie);
  state.bob = client(bob.cookie);
  state.carol = client(carol.cookie);
  state.aliceId = alice.id;
  state.bobId = bob.id;
  state.carolId = carol.id;

  const overview = await state.alice.get("/workforce/overview");
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  assert.equal(overview.body.capabilities.model.available, true);
  assert.equal(overview.body.capabilities.model.provider, "Groq");
  assert.equal(overview.body.capabilities.meetings.liveJoin, false);
  assert.equal(overview.body.capabilities.vault, true);
  assert.equal(overview.body.counts.bots, 0);
});

test("teammates: templates, activation, versions and isolation", async () => {
  const templates = await state.alice.get("/workforce/templates");
  assert.equal(templates.status, 200);
  assert.ok(templates.body.templates.some((template) => template.id === "chief-of-staff"));

  const created = await state.alice.post("/workforce/bots", { templateId: "research-analyst", name: "Atlas" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bot = created.body.bot;
  assert.equal(bot.name, "Atlas");
  assert.equal(bot.status, "draft");
  assert.equal(bot.version, 1);
  state.aliceBot = bot;

  const activated = await state.alice.post(`/workforce/bots/${bot.id}/status`, { status: "active" });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.bot.status, "active");

  const updated = await state.alice.put(`/workforce/bots/${bot.id}`, { instructions: "Research carefully, cite every claim with a URL, and never invent a source." });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.bot.version, 2);
  const versions = await state.alice.get(`/workforce/bots/${bot.id}/versions`);
  assert.equal(versions.status, 200);
  assert.deepEqual(versions.body.versions.slice(0, 2).map((item) => item.version), [2, 1]);

  const forbidden = await state.bob.get(`/workforce/bots/${bot.id}`);
  assert.equal(forbidden.status, 404, "a private teammate is invisible to another account");

  const copy = await state.alice.post(`/workforce/bots/${bot.id}/duplicate`, { name: "Atlas Two" });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.bot.status, "draft");
  state.secondBot = copy.body.bot;
});

test("teams share a teammate without sharing private data", async () => {
  const team = await state.alice.post("/workforce/teams", { name: "Research team", description: "Shared research" });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  state.teamId = team.body.team.id;

  const added = await state.alice.post(`/workforce/teams/${state.teamId}/members`, { email: "bob@example.com", role: "member" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const bobTeams = await state.bob.get("/workforce/teams");
  assert.equal(bobTeams.status, 200);
  assert.equal(bobTeams.body.teams[0].role, "member");

  const teamBot = await state.alice.post("/workforce/bots", {
    templateId: "research-analyst", name: "Team researcher", teamId: state.teamId, visibility: "team",
  });
  assert.equal(teamBot.status, 201, JSON.stringify(teamBot.body));
  state.teamBot = teamBot.body.bot;
  await state.alice.post(`/workforce/bots/${state.teamBot.id}/status`, { status: "active" });
  const published = await state.alice.post(`/workforce/teams/${state.teamId}/bots/${state.teamBot.id}/publish`, {});
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const bobBots = await state.bob.get("/workforce/bots");
  assert.ok(bobBots.body.bots.some((bot) => bot.id === state.teamBot.id && bot.teamName === "Research team"));

  const denied = await state.alice.put(`/workforce/teams/${state.teamId}/policy`, { rules: [{ action: "browser.fill", effect: "deny" }] });
  assert.equal(denied.status, 200);
  const check = await state.alice.get("/workforce/policy/check?action=browser.fill&risk=medium");
  assert.equal(check.status, 200);
  assert.equal(check.body.decision.outcome, "deny");

  const memberCannotPublish = await state.bob.post(`/workforce/teams/${state.teamId}/bots/${state.teamBot.id}/unpublish`, {});
  assert.equal(memberCannotPublish.status, 403);
});

test("memory is scoped, searchable, provenance-aware and refuses secrets", async () => {
  const written = await state.alice.post("/workforce/memory", {
    scope: "bot", botId: state.aliceBot.id, kind: "fact", content: "The Atlas project uses PostgreSQL 16 and a Vercel deployment.",
    provenance: "Architecture decision record 4", confidence: 0.9,
  });
  assert.equal(written.status, 201, JSON.stringify(written.body));
  assert.equal(written.body.memory.scope, "bot");
  assert.equal(written.body.memory.provenance, "Architecture decision record 4");

  const recall = await state.alice.post("/workforce/memory/recall", { query: "PostgreSQL deployment", botId: state.aliceBot.id });
  assert.equal(recall.status, 200);
  assert.equal(recall.body.matches[0].id, written.body.memory.id);
  assert.equal(recall.body.method, "keyword");

  const secret = await state.alice.post("/workforce/memory", { scope: "bot", botId: state.aliceBot.id, content: "password: hunter2hunter2" });
  assert.equal(secret.status, 400);
  assert.equal(secret.body.reason, "secret-refused");

  const otherBot = await state.bob.post("/workforce/memory", { scope: "bot", botId: state.aliceBot.id, content: "Here is a fact." });
  assert.equal(otherBot.status, 404, "another account can't write memory for a teammate it can't use");

  const bobList = await state.bob.get("/workforce/memory");
  assert.equal(bobList.status, 200);
  assert.equal(bobList.body.memories.length, 0);
});

test("computers have real files, a safe terminal and isolation", async () => {
  const capabilities = await state.alice.get("/workforce/computers/capabilities");
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.terminal.shell, false);
  assert.deepEqual(capabilities.body.terminal.extended, []);

  const computer = await state.alice.post("/workforce/computers", { name: "Research workspace", kind: "cloud" });
  assert.equal(computer.status, 201, JSON.stringify(computer.body));
  state.computer = computer.body.computer;
  assert.equal(computer.body.computer.kind, "cloud");

  const started = await state.alice.post(`/workforce/computers/${state.computer.id}/start`, {});
  assert.equal(started.status, 200);
  assert.equal(started.body.computer.status, "running");

  const written = await state.alice.put(`/workforce/computers/${state.computer.id}/files`, { path: "notes.txt", content: "Hello workforce" });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.path, "notes.txt");

  const listing = await state.alice.get(`/workforce/computers/${state.computer.id}/files?path=`);
  assert.equal(listing.status, 200);
  assert.ok(listing.body.files.some((file) => file.name === "notes.txt"));

  const content = await state.alice.get(`/workforce/computers/${state.computer.id}/files/content?path=notes.txt`);
  assert.equal(content.status, 200);
  assert.equal(content.body.content, "Hello workforce");

  const ls = await state.alice.post(`/workforce/computers/${state.computer.id}/terminal`, { command: "ls", args: ["."] });
  assert.equal(ls.status, 200, JSON.stringify(ls.body));
  assert.equal(ls.body.result.exitCode, 0);
  assert.match(ls.body.result.stdout, /notes\.txt/);
  assert.equal(ls.body.result.readOnly, true);

  const denied = await state.alice.post(`/workforce/computers/${state.computer.id}/terminal`, { command: "rm", args: ["-rf", "."] });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, "command-denied");

  const traversal = await state.alice.put(`/workforce/computers/${state.computer.id}/files`, { path: "../escape.txt", content: "no" });
  assert.equal(traversal.status, 400);

  const other = await state.bob.get(`/workforce/computers/${state.computer.id}`);
  assert.equal(other.status, 404);
});

test("skills: draft, dry-run test, approval and a masked learned workflow", async () => {
  const skill = await state.alice.post("/workforce/skills", {
    name: "Search a site",
    description: "Open a site and fill its search field.",
    whenToUse: "When someone asks to search the example site.",
    inputs: [{ name: "url", label: "Site URL", type: "url", required: true }, { name: "query", label: "Search query", type: "text", required: true }],
    steps: [
      { action: "browser.navigate", title: "Open the site", params: { url: "{{url}}" } },
      { action: "browser.fill", title: "Type the query", params: { selector: "#q", value: "{{query}}" } },
    ],
    permissions: ["browser.navigate"],
    safety: [],
  });
  assert.equal(skill.status, 201, JSON.stringify(skill.body));
  state.skill = skill.body.skill;

  const early = await state.alice.post(`/workforce/skills/${state.skill.id}/status`, { status: "approved" });
  assert.equal(early.status, 400);
  assert.equal(early.body.reason, "test-required");

  const tested = await state.alice.post(`/workforce/skills/${state.skill.id}/test`, { inputs: { url: "https://example.com", query: "HANNAH" } });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
  assert.equal(tested.body.test.dryRun, true);
  assert.equal(tested.body.test.executed, false);
  assert.equal(tested.body.test.ready, true);

  const approved = await state.alice.post(`/workforce/skills/${state.skill.id}/status`, { status: "approved" });
  assert.equal(approved.status, 200);

  const noConsent = await state.alice.post("/workforce/teach", { title: "Pay a bill" });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.reason, "consent-required");

  const audio = await state.alice.post("/workforce/teach", { title: "Pay a bill", consent: { recordInteractions: true, recordAudio: true } });
  assert.equal(audio.status, 400);
  assert.equal(audio.body.reason, "audio-refused");

  const taught = await state.alice.post("/workforce/teach", { title: "File an expense", consent: { recordInteractions: true, recordFormValues: false } });
  assert.equal(taught.status, 201, JSON.stringify(taught.body));
  const teachId = taught.body.session.id;
  const recorded = await state.alice.post(`/workforce/teach/${teachId}/events`, {
    events: [
      { action: "navigate", url: "https://expenses.example.com" },
      { action: "fill", selector: "input[name=password]", label: "Password", value: "SuperSecretPassword123!" },
      { action: "fill", selector: "#amount", label: "Amount", value: "42.50" },
      { action: "click", selector: "#submit", label: "Submit" },
    ],
  });
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.recorded, 4);

  const compiled = await state.alice.post(`/workforce/teach/${teachId}/compile`, {});
  assert.equal(compiled.status, 201, JSON.stringify(compiled.body));
  assert.equal(compiled.body.skill.status, "draft");
  assert.equal(compiled.body.skill.source, "taught");
  assert.ok(compiled.body.skill.inputs.some((input) => input.type === "secret"));
  const text = JSON.stringify(compiled.body);
  assert.equal(text.includes("SuperSecretPassword123!"), false, "a recorded password value never reaches the skill");

  const events = await state.alice.get(`/workforce/teach/${teachId}`);
  assert.equal(events.status, 200);
  assert.equal(events.body.session.status, "compiled");
});

test("tasks run for real, produce artifacts and memory, and can be verified", async () => {
  const created = await state.alice.post("/workforce/tasks", {
    botId: state.aliceBot.id, title: "Write an Atlas status report", objective: "Summarize the current state of Atlas and save a short report.",
    deliverable: "A markdown report", acceptance: "The report exists as an artifact.",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  state.task = created.body.task;
  assert.equal(state.task.status, "queued");

  const run = await state.alice.post(`/workforce/tasks/${state.task.id}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.task.status, "completed", JSON.stringify(run.body));
  assert.match(run.body.task.result.summary, /Completed the task/);
  assert.equal(run.body.task.result.artifacts.length, 1);
  assert.equal(run.body.task.result.artifacts[0].name, "report.md");
  assert.equal(run.body.task.result.nextSteps[0].action, "mail.send");

  const artifactContent = await state.alice.get(`/workforce/artifacts/${run.body.task.result.artifacts[0].id}/content`);
  assert.equal(artifactContent.status, 200);
  assert.match(artifactContent.body, /Real content produced by the runner/);

  const memory = await state.alice.get(`/workforce/memory?botId=${state.aliceBot.id}`);
  assert.ok(memory.body.memories.some((item) => item.content.includes("Ran the research task")));

  const reviewer = await state.alice.post("/workforce/bots", { templateId: "qa-engineer", name: "Verifier" });
  await state.alice.post(`/workforce/bots/${reviewer.body.bot.id}/status`, { status: "active" });
  const selfVerify = await state.alice.post(`/workforce/tasks/${state.task.id}/verify`, { reviewerBotId: state.aliceBot.id, verdict: "pass" });
  assert.equal(selfVerify.status, 400);
  const verified = await state.alice.post(`/workforce/tasks/${state.task.id}/verify`, { reviewerBotId: reviewer.body.bot.id, verdict: "pass", notes: "Checked the artifact." });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.task.result.verification.verdict, "pass");

  assert.equal((await state.bob.get(`/workforce/tasks/${state.task.id}`)).status, 404);
});

test("approvals: risky work waits, a decision is durable and org deny wins", async () => {
  const { gate } = require("./workforce/approvals");
  const bot = { ...state.aliceBot, autonomy: "approval", team_id: null };

  const low = await gate(db, state.aliceId, { bot, action: "file.read", target: "notes.txt" });
  assert.equal(low.outcome, "allow");

  const medium = await gate(db, state.aliceId, { bot, action: "file.write", target: "report.md", title: "Write report.md" });
  assert.equal(medium.outcome, "ask", JSON.stringify(medium));
  const approvalId = medium.approval.id;
  const listed = await state.alice.get("/workforce/approvals?status=pending");
  assert.ok(listed.body.approvals.some((item) => item.id === approvalId));
  const bobDecision = await state.bob.post(`/workforce/approvals/${approvalId}/decide`, { decision: "allow" });
  assert.equal(bobDecision.status, 404);
  const decided = await state.alice.post(`/workforce/approvals/${approvalId}/decide`, { decision: "allow", reason: "Looks right" });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.approval.status, "approved");
  const again = await state.alice.post(`/workforce/approvals/${approvalId}/decide`, { decision: "deny" });
  assert.equal(again.status, 409);

  const critical = await gate(db, state.aliceId, { bot, action: "payment", target: "invoice" });
  assert.equal(critical.outcome, "deny");

  const observing = await gate(db, state.aliceId, { bot: { ...bot, autonomy: "observe" }, action: "file.write", target: "x" });
  assert.equal(observing.outcome, "deny");

  // The organization rule denies file.write, even if a person's own rule allows it.
  await state.alice.put("/workforce/teams/" + state.teamId + "/policy", { rules: [{ action: "file.write", effect: "deny" }] });
  await state.alice.put("/workforce/policies", { rules: [{ action: "file.write", effect: "allow" }] });
  const org = await gate(db, state.aliceId, { bot, action: "file.write", target: "elsewhere" });
  assert.equal(org.outcome, "deny");
  assert.match(org.reason, /organization/i);
  // Reset for later work.
  await state.alice.put("/workforce/policies", { rules: [] });
  await state.alice.put("/workforce/teams/" + state.teamId + "/policy", { rules: [] });
});

test("the Secure Vault stores values, never returns them, and revokes", async () => {
  const created = await state.alice.post("/workforce/secrets", {
    name: "Expenses login", application: "expenses.example.com", kind: "password", value: "correct-horse-battery-staple",
    scopes: ["expenses.example.com"], botIds: [state.aliceBot.id],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const secret = created.body.secret;
  assert.equal(JSON.stringify(created.body).includes("correct-horse-battery-staple"), false);
  assert.ok(secret.hint.endsWith("aple"));
  assert.equal(secret.revoked, false);

  const listed = await state.alice.get("/workforce/secrets");
  assert.equal(listed.status, 200);
  assert.equal(JSON.stringify(listed.body).includes("correct-horse-battery-staple"), false);
  assert.equal("ciphertext" in listed.body.secrets[0], false);

  const bobUse = await state.bob.post(`/workforce/secrets/${secret.id}/use`, { purpose: "test" });
  assert.equal(bobUse.status, 404);

  const used = await state.alice.post(`/workforce/secrets/${secret.id}/use`, { purpose: "Test injection", target: "expenses.example.com" });
  assert.equal(used.status, 200);
  assert.equal(used.body.injectedServerSide, true);
  assert.equal(JSON.stringify(used.body).includes("correct-horse-battery-staple"), false);

  const revoked = await state.alice.delete(`/workforce/secrets/${secret.id}`);
  assert.equal(revoked.status, 200);
  const afterRevoke = await state.alice.get("/workforce/secrets");
  assert.equal(afterRevoke.body.secrets.length, 0);
  const { resolveSecret } = require("./workforce/secrets");
  await assert.rejects(() => resolveSecret(db, state.aliceId, `secret:${secret.id}`), /revoked|doesn't exist/);
});

test("artifacts version, download and stay inside one account", async () => {
  const created = await state.alice.post("/workforce/artifacts", { name: "brief.md", type: "text/markdown", content: "# Brief\n\nVersion one." });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const artifact = created.body.artifact;
  const v2 = await state.alice.post(`/workforce/artifacts/${artifact.id}/versions`, { content: "# Brief\n\nVersion two." });
  assert.equal(v2.status, 201);
  assert.equal(v2.body.artifact.version, 2);
  const detail = await state.alice.get(`/workforce/artifacts/${artifact.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.versions.length, 2);
  const content = await state.alice.get(`/workforce/artifacts/${v2.body.artifact.id}/content`);
  assert.match(content.body, /Version two/);
  assert.equal((await state.bob.get(`/workforce/artifacts/${artifact.id}`)).status, 404);
  assert.equal((await state.bob.get(`/workforce/artifacts/${artifact.id}/content`)).status, 404);
  assert.equal((await state.alice.delete(`/workforce/artifacts/${artifact.id}`)).status, 200);
});

test("routines fire durably from a cron tick, once, with a recorded run", async () => {
  const routine = await state.alice.post("/workforce/routines", {
    name: "Atlas standing report", description: "Write a short standing report for Atlas.",
    botId: state.aliceBot.id, mode: "schedule", status: "active",
    trigger: { type: "cron", cron: "*/5 * * * *" },
  });
  assert.equal(routine.status, 201, JSON.stringify(routine.body));
  assert.ok(routine.body.routine.nextRunAt > Date.now());
  state.routine = routine.body.routine;

  const unauthorized = await realFetch(`${baseUrl}/api/workforce/tick`, { method: "POST", headers: { Authorization: "Bearer wrong" } });
  assert.equal(unauthorized.status, 401);

  await db.query("UPDATE hannah_routines SET next_run_at = $1 WHERE user_id = $2 AND id = $3", [Date.now() - 1000, state.aliceId, state.routine.id]);
  const tick = await realFetch(`${baseUrl}/api/workforce/tick`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(tick.status, 200, await tick.clone().text());
  const tickBody = await tick.json();
  assert.ok(tickBody.fired >= 1);
  assert.ok(tickBody.processed.length >= 1);

  const runs = await state.alice.get(`/workforce/routines/${state.routine.id}/runs`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].status, "completed");
  assert.ok(runs.body.runs[0].taskId);

  const next = await state.alice.get(`/workforce/routines/${state.routine.id}`);
  assert.equal(next.body.routine.runCount, 1);
  assert.ok(next.body.routine.nextRunAt > Date.now());
});

test("proactive suggestions use real signals and respect settings", async () => {
  const off = await state.alice.post("/workforce/proactive/scan", { force: true });
  assert.equal(off.status, 409);
  const enabled = await state.alice.put("/workforce/proactive/settings", {
    enabled: true, categories: ["tasks", "approvals"], maxPerDay: 5, timezone: "UTC", quietHours: { start: "00:00", end: "00:00" },
  });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

  await state.alice.post("/workforce/tasks", {
    botId: state.aliceBot.id, title: "Overdue Atlas follow-up", objective: "Follow up on the Atlas decision.",
    deadline: new Date(Date.now() - 3600_000).toISOString(),
  });
  const scan = await state.alice.post("/workforce/proactive/scan", { force: true });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.ok(scan.body.offers.some((offer) => offer.kind === "overdue"), JSON.stringify(scan.body));
  const offer = scan.body.offers.find((item) => item.kind === "overdue");
  const acted = await state.alice.post(`/workforce/proactive/offers/${offer.id}/act`, {});
  assert.equal(acted.status, 200);
  assert.equal(acted.body.open.screen, "tasks");
  const second = scan.body.offers.find((item) => item.id !== offer.id);
  if (second) assert.equal((await state.alice.post(`/workforce/proactive/offers/${second.id}/dismiss`, {})).status, 200);
});

test("meetings summarize a consented transcript and turn actions into real tasks", async () => {
  const capabilities = await state.alice.get("/workforce/meetings/capabilities");
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.liveJoin, false);
  assert.match(capabilities.body.reason, /credentials/);

  const meeting = await state.alice.post("/workforce/meetings", {
    title: "Migration planning", provider: "google-meet", participants: ["Alice", "Carol"],
    startsAt: new Date(Date.now() - 7200_000).toISOString(), endsAt: new Date(Date.now() - 3600_000).toISOString(),
    consent: { record: true, transcript: true },
  });
  assert.equal(meeting.status, 201, JSON.stringify(meeting.body));
  state.meeting = meeting.body.meeting;
  assert.equal(meeting.body.meeting.hasTranscript, false);

  const transcript = "Alice: We will ship the migration on Friday. Carol: The rollback plan still needs an owner. Alice: I will send a recap.";
  const saved = await state.alice.post(`/workforce/meetings/${state.meeting.id}/transcript`, { transcript });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const summarized = await state.alice.post(`/workforce/meetings/${state.meeting.id}/summarize`, {});
  assert.equal(summarized.status, 200, JSON.stringify(summarized.body));
  assert.match(summarized.body.meeting.notes.summary, /Friday/);
  assert.equal(summarized.body.meeting.actions.length, 1);
  assert.equal(summarized.body.meeting.actions[0].accepted, false);

  const accepted = await state.alice.post(`/workforce/meetings/${state.meeting.id}/actions/act-1/accept`, { botId: state.aliceBot.id });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.task.title, "Send the migration recap");
  const detail = await state.alice.get(`/workforce/meetings/${state.meeting.id}`);
  assert.equal(detail.body.meeting.actions[0].accepted, true);
  assert.equal((await state.bob.get(`/workforce/meetings/${state.meeting.id}`)).status, 404);

  const noConsent = await state.alice.post("/workforce/meetings", { title: "No consent", consent: { record: false, transcript: false } });
  const rejected = await state.alice.post(`/workforce/meetings/${noConsent.body.meeting.id}/transcript`, { transcript });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.reason, "consent-required");
});

test("a skill step's approval covers only that step as the person saw it", async () => {
  await db.query("UPDATE hannah_bots SET computer_access = $1, autonomy = 'approval' WHERE user_id = $2 AND id = $3",
    [JSON.stringify({ enabled: true, computerIds: [state.computer.id] }), state.aliceId, state.aliceBot.id]);
  const definition = (content) => ({
    name: "Write a note", description: "Writes a note after a person confirms.", whenToUse: "When asked to write the note.",
    inputs: [], permissions: ["file.write"], safety: [],
    steps: [
      { action: "human.approval", title: "Confirm the person is at the computer" },
      { action: "file.write", title: "Write the note", params: { path: "approval-note.txt", content } },
    ],
  });
  const created = await state.alice.post("/workforce/skills", definition("first"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const skillId = created.body.skill.id;
  const approveSkill = async () => {
    assert.equal((await state.alice.post(`/workforce/skills/${skillId}/test`, { inputs: {} })).status, 200);
    const result = await state.alice.post(`/workforce/skills/${skillId}/status`, { status: "approved" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  };
  await approveSkill();
  const made = await state.alice.post("/workforce/tasks", { botId: state.aliceBot.id, title: "Write the note", objective: "Run the note skill.", inputs: { skillId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const task = made.body.task;
  const pending = async (action) => (await state.alice.get("/workforce/approvals?status=pending")).body.approvals
    .filter((item) => item.taskId === task.id && item.action === action);
  const run = async () => {
    const response = await state.alice.post(`/workforce/tasks/${task.id}/run`, {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.task;
  };
  const decide = (approval) => state.alice.post(`/workforce/approvals/${approval.id}/decide`, { decision: "allow" });

  // The human step waits; once approved, the run moves on instead of asking again.
  assert.equal((await run()).status, "waiting-approval");
  const takeover = await pending("browser.takeover");
  assert.equal(takeover.length, 1);
  await decide(takeover[0]);
  assert.equal((await run()).status, "waiting-approval");
  assert.equal((await pending("browser.takeover")).length, 0, "an approved human step is not asked for again");
  const write = await pending("file.write");
  assert.equal(write.length, 1);
  await decide(write[0]);

  // The skill changes after that decision: the old approval must not cover the changed step.
  const edited = await state.alice.put(`/workforce/skills/${skillId}`, definition("changed after approval"));
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  await approveSkill();
  assert.equal((await run()).status, "waiting-approval");
  const rewrite = await pending("file.write");
  assert.equal(rewrite.length, 1, "the changed step needs its own decision");
  await decide(rewrite[0]);
  const done = await run();
  assert.equal(done.status, "completed", JSON.stringify(done));
  const file = await state.alice.get(`/workforce/computers/${state.computer.id}/files/content?path=approval-note.txt`);
  assert.equal(file.status, 200, JSON.stringify(file.body));
  assert.match(typeof file.body === "string" ? file.body : JSON.stringify(file.body), /changed after approval/);
});

test("the terminal's find stays inside the workspace, and HTML artifacts can't run scripts", async () => {
  const run = (args) => state.alice.post(`/workforce/computers/${state.computer.id}/terminal`, { command: "find", args });
  const inside = await run([".", "-maxdepth", "1", "-name", "notes.txt"]);
  assert.equal(inside.status, 200, JSON.stringify(inside.body));
  assert.match(inside.body.result.stdout, /notes\.txt/);
  // A second start path used to go unchecked: find . /etc listed the server's files.
  for (const args of [[".", "/etc", "-maxdepth", "1"], [".", "../..", "-name", "*"], ["-name", "x", "/etc"]]) {
    const escaped = await run(args);
    assert.equal(escaped.status, 400, `${args.join(" ")} -> ${JSON.stringify(escaped.body)}`);
  }

  const page = await state.alice.post("/workforce/artifacts", { name: "report.html", type: "text/html", content: "<h1>Report</h1><script>fetch('/api/workforce/approvals')</script>" });
  assert.equal(page.status, 201, JSON.stringify(page.body));
  const served = await state.alice.get(`/workforce/artifacts/${page.body.artifact.id}/content`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-security-policy") || "", /\bsandbox\b/);
  assert.match(served.headers.get("content-security-policy") || "", /default-src 'none'/);
});

test("deeply nested files count against a computer's storage limit", async () => {
  const quota = await state.alice.post("/workforce/computers", { name: "Small", kind: "cloud", limits: { storageMb: 16 } });
  assert.equal(quota.status, 201, JSON.stringify(quota.body));
  assert.equal(Number(quota.body.computer.limits.storageMb), 16);
  const id = quota.body.computer.id;
  // Below depth 8 the old count saw nothing, so every write fitted.
  const deep = "a/b/c/d/e/f/g/h/i/j/k";
  const chunk = "x".repeat(7 * 1024 * 1024);
  const results = [];
  for (let index = 0; index < 4; index += 1) results.push((await state.alice.put(`/workforce/computers/${id}/files`, { path: `${deep}/part-${index}.txt`, content: chunk })).status);
  assert.deepEqual(results, [200, 200, 413, 413]);
});

test("a teammate leaves its team when the person who published it is removed", async () => {
  const added = await state.alice.post(`/workforce/teams/${state.teamId}/members`, { email: "carol@example.com", role: "manager" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const made = await state.carol.post("/workforce/bots", { templateId: "research-analyst", name: "Carol's scout", teamId: state.teamId, visibility: "team" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const botId = made.body.bot.id;
  await state.carol.post(`/workforce/bots/${botId}/status`, { status: "active" });
  const publish = () => state.carol.post(`/workforce/teams/${state.teamId}/bots/${botId}/publish`, {});
  assert.equal((await publish()).status, 200);
  const bobSees = async () => (await state.bob.get("/workforce/bots")).body.bots.some((bot) => bot.id === botId);
  assert.equal(await bobSees(), true);

  // The team's owner can take down a teammate someone else published.
  const unpublished = await state.alice.post(`/workforce/teams/${state.teamId}/bots/${botId}/unpublish`, {});
  assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
  assert.equal(await bobSees(), false);

  assert.equal((await publish()).status, 200);
  assert.equal(await bobSees(), true);
  const removed = await state.alice.delete(`/workforce/teams/${state.teamId}/members/${state.carolId}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(await bobSees(), false, "a removed manager's teammate is no longer shared");
  const { canUseBot } = require("./workforce/common");
  assert.equal(await canUseBot(db, state.bobId, botId), null);
  assert.ok(await canUseBot(db, state.carolId, botId), "Carol keeps her own teammate");
});

test("the workforce API is closed to signed-out callers", async () => {
  const response = await realFetch(`${baseUrl}/api/workforce/overview`);
  assert.equal(response.status, 401);
});
