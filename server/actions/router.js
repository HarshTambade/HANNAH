"use strict";

/**
 * The Action Engine, the permission manager, the integrations hub and the
 * coding service over HTTP. Everything here belongs to one signed-in account.
 *
 *   GET    /api/actions/catalog                 every action HANNAH has, and what each needs
 *   POST   /api/actions                         { action, params, request?, agent?, source?, taskId?, idempotencyKey? } → its record
 *   GET    /api/actions                         history, newest first (?status=waiting|changes &service= &task= &limit= &before=)
 *   GET    /api/actions/:id
 *   POST   /api/actions/:id/decision            { approve }     a signed-in person only
 *   POST   /api/actions/:id/report              { ok, response?, verification?, error? }   from the device that performed it
 *   POST   /api/actions/stop                    the emergency stop
 *   POST   /api/actions/resume                  a signed-in person only
 *
 *   GET    /api/account/permissions             levels, standing permissions, when each was last used
 *   PUT    /api/account/permissions             { levels: { service: 1..5 } }
 *   POST   /api/account/permissions/grants      { service, actions, resource?, limits?, expiresAt?, note? }
 *   DELETE /api/account/permissions/grants/:id
 *
 *   GET    /api/account/integrations            every connection in one list: status, account, what it can and can't do, last success, last error
 *   PUT    /api/account/integrations/github     { token }
 *   DELETE /api/account/integrations/github
 *
 *   GET    /api/coding/repos                    connected repositories (?available=1 adds what the GitHub token can see)
 *   POST   /api/coding/repos                    { host: "github" | "local", name }
 *   PATCH  /api/coding/repos                    { id, access?, watch? }
 *   DELETE /api/coding/repos?id=
 *   POST   /api/coding/repos/check              { id } → a report; changes nothing
 *   GET    /api/coding/tasks, GET /api/coding/tasks/:id
 *   POST   /api/coding/tasks                    { repoId, kind: "scan" | "change", request, options? }   event stream → task
 *   POST   /api/coding/tasks/:id/continue       { answer? }                                              event stream → task
 *   POST   /api/coding/tasks/:id/cancel | pause
 *   POST   /api/coding/tasks/:id/publish        { pullRequest?, draft?, target? } → the action's record and the task
 *
 * Who may do what: an account session (a person in the app) or one of the
 * account's developer keys (an agent, an MCP host) may ask for actions and
 * read history. Only a session may approve an action, change levels, add a
 * standing permission, connect a token or turn the emergency stop off, so
 * nothing holding only a key can widen what HANNAH is allowed to do.
 */
const express = require("express");
const permissions = require("./permissions");
const { createActionEngine, outcomeText } = require("./engine");
const { calendarActions } = require("./catalog/calendar");
const { communicationActions, CAN_START, REPLY_ONLY } = require("./catalog/communications");
const { codeActions } = require("./catalog/code");
const { deviceActions } = require("./catalog/device");
const { robotActions } = require("./catalog/robots");
const { hardwareActions } = require("./catalog/hardware");
const { robotOSActions } = require("./catalog/robot_os");
const { createDeviceService } = require("../devices/service");
const { createRoboticsService } = require("../robotics/service");
const { emitUserEvent } = require("../webhooks");
const { createCodingService } = require("../coding/service");
const { DRIVERS } = require("../channel-drivers");
const connections = require("../connections");
const comms = require("../communications");
const { getDatabase } = require("../db");
const { createAsk, patient } = require("../llm");
const { vaultConfigured } = require("../vault");

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

/** One engine, one coding service and one robot registry for the whole server: routes, workflows and MCP all use these. */
function createOperator({ fetchImpl = (...args) => fetch(...args), request, now = () => Date.now(), roots, robotAckWaitMs, robotOSCommands = null, trust = null } = {}) {
  const coding = createCodingService({ fetchImpl, now, ...(request ? { request } : {}), ...(roots ? { roots } : {}) });
  // The account's device policy (secret age, mTLS) for the robot link, read at most every 30 s per account.
  const policies = new Map();
  const credentialPolicy = trust ? async (db, userId) => {
    const cached = policies.get(userId);
    if (cached && now() - cached.at < 30_000) return cached.policy;
    const policy = await trust.getPolicy(db, userId).catch(() => null);
    if (policies.size > 5000) policies.clear();
    policies.set(userId, { at: now(), policy });
    return policy;
  } : null;
  const robotics = createRoboticsService({ now, emit: emitUserEvent, credentialPolicy, ...(robotAckWaitMs ? { ackWaitMs: robotAckWaitMs } : {}) });
  const devices = createDeviceService({ now, emit: emitUserEvent });
  const engine = createActionEngine({ now, actions: [...calendarActions({ fetchImpl }), ...communicationActions({ fetchImpl }), ...codeActions({ coding }), ...deviceActions(), ...robotActions({ robotics }), ...hardwareActions({ devices }), ...robotOSActions({ robotics, robotOSCommands })] });
  return { coding, devices, engine, robotics, robotOSCommands, trust };
}

/** Every connection an account has, in one shape. */
async function integrationsHub(db, userId, { coding, engine, robotics = null, now = () => Date.now() }) {
  const out = [];
  const last = await engine.lastUsed(db, userId);
  const github = await coding.githubStatus(db, userId);
  out.push({
    id: "github", category: "Development", name: "GitHub", connected: github.connected, account: github.account || null,
    permissions: github.connected ? (github.scopes ? github.scopes : ["Whatever the fine-grained token was given: GitHub doesn't report it; the token's own page lists it"]) : [],
    supported: ["Read repositories, issues, pull requests, commits and Actions results", "Index and scan code", "Commit a change to a new branch (never forced)", "Open pull requests, issues, comments and reviews", "Merge a pull request when the repository's access allows it and you approve"],
    unsupported: ["Force pushes, deleting branches or repositories, changing repository settings or secrets", "Running the repository's code on HANNAH's server (a GitHub repository's tests run in its own CI)"],
    setup: github.connected ? null : (vaultConfigured() ? "Create a fine-grained personal access token limited to the repositories HANNAH should see (Contents: read and write, Pull requests: read and write, Issues: read and write, Actions: read, Metadata: read) and add it here." : "This server can't store tokens yet (no key vault)."),
    lastOkAt: github.lastOkAt || null, lastError: github.lastError || null, expires: github.expires || null, disconnect: github.connected ? "DELETE /api/account/integrations/github" : null, lastAction: last.code,
  });
  const rows = (await db.query("SELECT provider, account_email, scopes, created_at, updated_at FROM hannah_connections WHERE user_id = $1", [userId])).rows;
  for (const provider of Object.values(connections.PROVIDERS)) {
    const row = rows.find((item) => item.provider === provider.id);
    const configured = provider.env.every((name) => process.env[name]);
    const scopes = row ? String(row.scopes || "").split(/\s+/).filter(Boolean) : [];
    const organize = provider.id !== "google" || scopes.includes(comms.GMAIL_MODIFY);
    out.push({
      id: provider.id, category: "Productivity", name: provider.services, connected: Boolean(row), account: row?.account_email || null, permissions: scopes.map((scope) => scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")),
      supported: ["Read events and find free time", "Create, change and delete events, with attendees, repeats, reminders and a meeting link", "Search and read mail, find what needs a reply", "Save drafts and reply drafts", "Send mail, with files HANNAH made attached", ...(organize ? ["Archive and label mail"] : []), ...(provider.id === "google" && comms.hasChatScopes(row?.scopes) ? ["Read and post in Google Chat spaces as you"] : [])],
      unsupported: ["Deleting mail", "Other people's calendars beyond the free/busy they share with you", ...(row && !organize ? ["Archiving and labels (reconnect and accept the organize permission)"] : [])],
      setup: row ? null : configured ? "Connect in Settings → Calendar and email." : `Not set up on this server: the operator has to register an OAuth app and set ${provider.env.join(" and ")}.`,
      lastOkAt: row ? Number(row.updated_at) : null, lastError: null, disconnect: row ? `DELETE /api/account/connections/${provider.id}` : null, lastAction: provider.id === "google" || provider.id === "microsoft" ? (last.mail && last.calendar ? (last.mail.at > last.calendar.at ? last.mail : last.calendar) : last.mail || last.calendar) : null,
    });
  }
  const channels = (await db.query("SELECT id, kind, name, paired_chat_id, paired_name, allowed, created_at, updated_at FROM hannah_channels WHERE user_id = $1 ORDER BY created_at", [userId]).catch(() => ({ rows: [] }))).rows;
  for (const kind of Object.keys(DRIVERS)) {
    const mine = channels.filter((row) => row.kind === kind);
    const base = { id: `channel:${kind}`, category: "Communication", name: DRIVERS[kind].label || kind, lastAction: last.messages };
    const limits = kind === "whatsapp" ? ["Your personal WhatsApp chats: this is a WhatsApp Business number through Meta's Cloud API, not your own account", "Messages to people more than 24 hours after they last wrote (WhatsApp allows only approved templates then)"]
      : kind === "telegram" ? ["Your personal Telegram chats: this is a bot, not your account", "Writing to someone who hasn't started a chat with the bot", "Groups and channels"]
        : ["Your own account's chats: this is a bot or app", "Group conversations"];
    if (!mine.length) { out.push({ ...base, connected: false, account: null, permissions: [], supported: [CAN_START[kind] || REPLY_ONLY[kind] || "Answers direct messages"], unsupported: limits, setup: "Create the bot or app on the platform and connect it in Settings → Chat apps.", lastOkAt: null, lastError: null, disconnect: null }); continue; }
    for (const row of mine) {
      let people = 0;
      try { people = JSON.parse(row.allowed || "[]").length; } catch { people = 0; }
      out.push({ ...base, id: `channel:${row.id}`, connected: true, account: row.name, permissions: [row.paired_chat_id ? `Paired with ${row.paired_name || "your chat"}` : "Not paired yet", `${people} approved ${people === 1 ? "person" : "people"}`], supported: ["Answers direct messages from you and people you approved", ...(CAN_START[kind] ? [`Sends messages you approve: ${CAN_START[kind]}`] : [])], unsupported: [...limits, ...(CAN_START[kind] ? [] : [REPLY_ONLY[kind]])], setup: null, lastOkAt: Number(row.updated_at), lastError: null, disconnect: `DELETE /api/channels/${row.id}` });
    }
  }
  out.push({ id: "research", category: "Research", name: "Web search and research", connected: true, account: null, permissions: [], supported: ["Search (Tavily, Brave or SearXNG when the operator set one; otherwise Groq's browser search with your key; Wikipedia, OpenAlex and arXiv always)", "Open and read public pages, obeying robots.txt"], unsupported: ["Pages behind a sign-in or paywall", "Submitting forms (that is the desktop app's browser)"], setup: null, lastOkAt: null, lastError: null, disconnect: null });
  out.push({ id: "bookings", category: "Bookings", name: "Restaurants, travel, appointments", connected: false, account: null, permissions: [], supported: ["Finding and comparing options through web research, with sources", "Preparing a booking request as an email or message for you to approve", "Adding the appointment to your calendar"], unsupported: ["Checking live availability or prices with a provider", "Making, paying for or confirming a reservation: no booking provider's API is connected. HANNAH never reports a booking as made"], setup: "Needs a provider that offers an API and an account with it (partner approval for restaurant and travel networks). None is connected.", lastOkAt: null, lastError: null, disconnect: null });
  out.push({ id: "device", category: "Device control", name: "This computer or phone", connected: null, account: null, permissions: [], supported: ["Desktop app: files in folders you share, commands you approve, a browser window, app and window control, screen reading", "Android and iOS: reminders, notifications, the dialer and message drafts"], unsupported: ["Anything on a device where the HANNAH app isn't open and signed in", "Sending texts or placing calls without the phone's own confirmation"], setup: "Shown per device in Settings → Desktop access and Settings → Phone.", lastOkAt: null, lastError: null, disconnect: null, lastAction: last.device || last.files });
  if (robotics) {
    const robots = await robotics.listRobots(db, userId).catch(() => []);
    const enrolled = robots.filter((robot) => robot.status === "enrolled");
    out.push({
      id: "robots", category: "Robots", name: "Robots", connected: enrolled.length > 0, account: enrolled.length ? enrolled.map((robot) => `${robot.name} (${robot.simulated ? "simulation" : "physical"}, ${robot.connection})`).join(", ") : null, permissions: [],
      supported: ["A simulated differential-drive robot (HANNAH's built-in simulator): drive to a place, stop, return to dock, visit points, read state and sensors", "Enrollment with a one-time code, signed commands that expire, a software stop that never needs approval"],
      unsupported: ["Physical robots: the ROS 2 adapter is written and has not been run on hardware", "Gazebo and Nav2: the integration is written and has not been run", "Arms, grippers, cameras and following a target: in the capability contract, with no runtime yet", "An emergency stop: HANNAH's stop is a software request; an emergency stop is hardware on the robot"],
      setup: vaultConfigured() ? "Add a robot under Robots and run HANNAH's robot runtime with the one-time code." : "This server can't enroll robots yet (no key vault).",
      lastOkAt: enrolled.reduce((latest, robot) => Math.max(latest, robot.lastSeenAt || 0), 0) || null, lastError: null, disconnect: null, lastAction: last.robots,
    });
  }
  return { integrations: out, checkedAt: now() };
}

function createOperatorRouter({ operator, getRequestProvider, preferredProviderId, timeoutMs = 90_000 }) {
  const { engine, coding, robotics, devices } = operator;
  const router = express.Router();
  const json = express.json({ limit: "600kb" });
  const guard = ({ session = false } = {}) => (handler) => async (req, res) => {
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to let HANNAH act for you. Actions, permissions and their history belong to an account.", reason: "signin-required" });
    if (session && account.via !== "session") return res.status(403).json({ error: "Only you, signed in to the app, can do this. A developer key can't approve actions or change permissions.", reason: "session-required" });
    const db = await getDatabase().catch(() => null);
    if (!db) return res.status(503).json({ error: "Actions need the account database.", reason: "no-database" });
    try {
      return await handler(req, res, db, account);
    } catch (error) {
      if (res.headersSent) return undefined;
      if (!error.status) console.error(`Operator request failed (${error?.code || error?.name || "error"}).`);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "That didn't work on the server.", ...(error.reason ? { reason: error.reason } : {}), ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.record ? { record: error.record } : {}) });
    }
  };
  const anyAccount = guard();
  const person = guard({ session: true });
  const withText = (record) => ({ ...record, outcome: outcomeText(record) });
  const sourceOf = (req, account) => (account.via === "session" ? String(req.body?.source || "chat").slice(0, 40) : "api-key");

  // ---------- actions ----------
  router.get("/actions/catalog", anyAccount(async (_req, res, db, account) => {
    const policy = await permissions.loadPolicy(db, account.id);
    res.json({ actions: engine.catalog().map((action) => ({ ...action, level: policy.levels[action.service] })), services: permissions.SERVICES });
  }));
  router.post("/actions", json, anyAccount(async (req, res, db, account) => {
    const record = await engine.run(db, account.id, { action: req.body?.action, params: req.body?.params, request: req.body?.request, intent: req.body?.intent, agent: req.body?.agent, source: sourceOf(req, account), taskId: req.body?.taskId, idempotencyKey: req.body?.idempotencyKey });
    res.status(record.status === "waiting-approval" ? 202 : 200).json({ record: withText(record) });
  }));
  router.post("/actions/stop", anyAccount(async (_req, res, db, account) => {
    const stopped = await engine.stop(db, account.id);
    const paused = await coding.pauseAll(db, account.id);
    // A software stop goes to every robot that could be moving. It is a request to each robot's controller, not an emergency stop.
    const robots = robotics ? await robotics.stopAll(db, account.id).catch(() => 0) : 0;
    // Automations on hubs are paused too: they are HANNAH acting. Devices stay as they are; a person resumes them under Devices.
    const hubs = devices ? await devices.suspendRules(db, account.id, true).catch(() => 0) : 0;
    res.json({ stoppedAt: stopped.policy.stoppedAt, cancelled: stopped.cancelled, pausedTasks: paused, stoppedRobots: robots, pausedAutomationHubs: hubs });
  }));
  router.post("/actions/resume", person(async (_req, res, db, account) => res.json({ stoppedAt: (await engine.resume(db, account.id)).stoppedAt })));
  router.get("/actions", anyAccount(async (req, res, db, account) => {
    const records = await engine.list(db, account.id, { status: req.query.status, service: req.query.service, taskId: req.query.task, limit: req.query.limit, before: req.query.before });
    res.json({ actions: records.map(withText), stoppedAt: (await permissions.loadPolicy(db, account.id)).stoppedAt });
  }));
  router.get("/actions/:id", anyAccount(async (req, res, db, account) => res.json({ record: withText(await engine.get(db, account.id, req.params.id)) })));
  router.post("/actions/:id/decision", json, person(async (req, res, db, account) => {
    if (typeof req.body?.approve !== "boolean") throw fail(400, "Say whether you approve (approve: true or false).", "bad-request");
    res.json({ record: withText(await engine.decide(db, account.id, req.params.id, { approve: req.body.approve, by: String(req.body?.device || "app").slice(0, 80) })) });
  }));
  router.post("/actions/:id/report", json, anyAccount(async (req, res, db, account) => res.json({ record: withText(await engine.report(db, account.id, req.params.id, req.body || {})) })));

  // ---------- permissions ----------
  const knownActions = () => new Map(engine.catalog().map((action) => [action.id, action]));
  async function permissionView(db, userId) {
    const [policy, grants, lastUsed] = await Promise.all([permissions.loadPolicy(db, userId), permissions.listGrants(db, userId), engine.lastUsed(db, userId)]);
    return {
      levels: permissions.LEVELS, stoppedAt: policy.stoppedAt,
      services: Object.entries(permissions.SERVICES).map(([id, service]) => ({ id, ...service, level: policy.levels[id], lastUsed: lastUsed[id], actions: engine.catalog().filter((action) => action.service === id).map(({ id: actionId, title, kind, standing, executor }) => ({ id: actionId, title, kind, standing, executor })) })),
      grants, kinds: permissions.KINDS,
      always: ["Paying and purchasing", "Deleting (events, files) and merging", "Committing to a repository's default branch", "Anything an action's own checks flag: an ambiguous recipient, an attachment, a conflict, a password-like text", "Any movement of a physical robot"],
    };
  }
  router.get("/account/permissions", anyAccount(async (_req, res, db, account) => res.json(await permissionView(db, account.id))));
  router.put("/account/permissions", json, person(async (req, res, db, account) => {
    await permissions.savePolicy(db, account.id, { levels: req.body?.levels });
    res.json(await permissionView(db, account.id));
  }));
  router.post("/account/permissions/grants", json, person(async (req, res, db, account) => {
    const grant = await permissions.addGrant(db, account.id, req.body, { knownActions: knownActions() });
    const definition = grant.actions.map((id) => engine.definition(id)).find((action) => action && (action.kind === "destroy" || action.standing === false));
    if (definition) { await permissions.revokeGrant(db, account.id, grant.id); throw fail(400, `“${definition.title}” always asks; a standing permission can't cover it.`, "always-asks"); }
    res.status(201).json({ grant, ...(await permissionView(db, account.id)) });
  }));
  router.delete("/account/permissions/grants/:id", person(async (req, res, db, account) => {
    if (!(await permissions.revokeGrant(db, account.id, req.params.id))) throw fail(404, "That permission doesn't exist or was already revoked.", "not-found");
    res.json(await permissionView(db, account.id));
  }));

  // ---------- integrations ----------
  router.get("/account/integrations", anyAccount(async (_req, res, db, account) => res.json(await integrationsHub(db, account.id, { coding, engine, robotics }))));
  router.put("/account/integrations/github", json, person(async (req, res, db, account) => res.json({ github: await coding.connectGithub(db, account.id, req.body?.token) })));
  router.delete("/account/integrations/github", person(async (_req, res, db, account) => res.json({ disconnected: await coding.disconnectGithub(db, account.id) })));

  // ---------- coding ----------
  router.get("/coding/repos", anyAccount(async (req, res, db, account) => {
    const github = await coding.githubStatus(db, account.id);
    const repos = await coding.listRepos(db, account.id);
    let available;
    if (req.query.available && github.connected) available = await (await coding.githubFor(db, account.id)).repos({ max: 100 });
    res.json({ repos, github, local: { enabled: coding.localEnabled() }, access: coding.ACCESS.map((id) => ({ id, label: coding.ACCESS_LABEL[id] })), ...(available ? { available } : {}) });
  }));
  router.post("/coding/repos", json, person(async (req, res, db, account) => res.status(201).json({ repo: await coding.addRepo(db, account.id, { host: req.body?.host, name: req.body?.name }) })));
  router.patch("/coding/repos", json, person(async (req, res, db, account) => res.json({ repo: await coding.updateRepo(db, account.id, req.body?.id, req.body) })));
  router.delete("/coding/repos", person(async (req, res, db, account) => res.json({ removed: await coding.removeRepo(db, account.id, String(req.query.id || "")) })));
  router.post("/coding/repos/check", json, anyAccount(async (req, res, db, account) => res.json({ report: await coding.checkRepo(db, account.id, req.body?.id) })));
  router.get("/coding/tasks", anyAccount(async (req, res, db, account) => res.json({ tasks: await coding.listTasks(db, account.id, { limit: req.query.limit }) })));
  router.get("/coding/tasks/:id", anyAccount(async (req, res, db, account) => res.json({ task: await coding.getTask(db, account.id, req.params.id) })));
  router.post("/coding/tasks/:id/cancel", anyAccount(async (req, res, db, account) => res.json({ task: await coding.cancelTask(db, account.id, req.params.id) })));
  router.post("/coding/tasks/:id/pause", anyAccount(async (req, res, db, account) => res.json({ task: await coding.pauseTask(db, account.id, req.params.id) })));
  router.post("/coding/tasks/:id/publish", json, anyAccount(async (req, res, db, account) => {
    const record = await engine.run(db, account.id, { action: "code.publish", params: { taskId: req.params.id, pullRequest: req.body?.pullRequest, draft: req.body?.draft, target: req.body?.target }, request: req.body?.request, agent: "Coding agent", source: sourceOf(req, account), taskId: req.params.id });
    res.status(record.status === "waiting-approval" ? 202 : 200).json({ record: withText(record), task: await coding.getTask(db, account.id, req.params.id) });
  }));

  /** Run a task forward while the request is open, streaming what happens. */
  async function drive(req, res, db, account, taskId, answer) {
    let ask = null;
    let waiting = () => {};
    try { ask = patient(createAsk({ req, res, getRequestProvider, preferredProviderId, timeoutMs, providerId: req.body?.provider, model: req.body?.model }), { emit: (event) => waiting(event), waits: 2, maxWaitS: 30 }); } catch { ask = null; }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let open = true;
    const beat = setInterval(() => { if (open) res.write(": still working\n\n"); }, 15_000);
    res.on("close", () => { open = false; clearInterval(beat); });
    const emit = (event) => { if (open) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    waiting = emit;
    try {
      const budgetMs = Math.max(5000, Math.min(240_000, Number(req.body?.budgetMs) || (process.env.VERCEL ? 40_000 : 150_000)));
      const task = await coding.advance(db, account.id, taskId, { ask, emit, engine, budgetMs, answer });
      emit({ type: "result", task });
    } catch (error) {
      emit({ type: "error", message: error.status ? error.message : "The task stopped on a server error.", reason: error.reason || "failed" });
    }
    clearInterval(beat);
    if (open) res.end();
  }
  router.post("/coding/tasks", json, anyAccount(async (req, res, db, account) => {
    const task = await coding.createTask(db, account.id, { repoId: req.body?.repoId || req.body?.repo, kind: req.body?.kind, request: req.body?.request, options: req.body?.options });
    if (req.body?.start === false) return res.status(201).json({ task });
    return drive(req, res, db, account, task.id);
  }));
  router.post("/coding/tasks/:id/continue", json, anyAccount(async (req, res, db, account) => {
    await coding.getTask(db, account.id, req.params.id);
    return drive(req, res, db, account, req.params.id, typeof req.body?.answer === "string" ? req.body.answer : "");
  }));

  return router;
}

module.exports = { createOperator, createOperatorRouter, integrationsHub };
