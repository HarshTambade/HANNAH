"use strict";

// Edge resources (a robot's onboard measurements, history, model advice) and
// the Device Intelligence Graph (scoping, temporal history, auto-population,
// live-checked context, the agent tool) against the real server and database.
// The robot here is a stand-in that speaks the robot protocol; nothing is a
// physical measurement.
const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { after, before } = test;

const pglite = process.env.HANNAH_TEST_DB === "pglite";
process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "edge-graph-test-token-0123456789-abcdefghijklmn";
process.env.DATABASE_URL = pglite ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "e".repeat(64);
process.env.HANNAH_RATE_LIMIT_ROBOT_SYNC_PER_5S = "100000";
process.env.HANNAH_RATE_LIMIT_ROBOT_ENROLL_PER_ADDRESS = "40";
delete process.env.VERCEL;

const { createRobotClient, descriptor } = require("./test-fixtures/robot-client");
const { adviseForRobot, hardwareFromReport } = require("./edge/model-fit");
const { normalizeReport } = require("./edge/resources");

let server;
let base;
let db;
const users = {};

const call = async (who, method, route, body) => {
  const response = await fetch(`${base}/api${route}`, { method, headers: { ...(who || {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
};

const m = (value, unit, source = "test fixture") => ({ available: true, value, unit, source });
const na = (reason) => ({ available: false, reason: `not measurable on this device: ${reason}` });
function report({ id = "res_1", cpuTemp = 55, memAvailMb = 6000, memTotalMb = 8000, gpu = null, warnings = [], status = "ok", measuredAt = Date.now(), policy } = {}) {
  return {
    schema: "hannah.edge-resources.v1", report_id: id, reported_at_ms: measuredAt, enforcement: "recommend-only", shed_active: false,
    snapshot: {
      schema: "hannah.edge-resources.v1", measured_at_ms: measuredAt,
      cpu: { utilization_pct: m(23.5, "%", "/proc/stat"), temperature_c: cpuTemp === null ? na("no thermal zone") : m(cpuTemp, "C", "/sys/class/thermal/thermal_zone0 (cpu-thermal)"), load_1m: m(1.1, "load") },
      memory: { total_mb: memTotalMb === null ? na("/proc/meminfo is missing") : m(memTotalMb, "MB"), available_mb: memAvailMb === null ? na("/proc/meminfo is missing") : m(memAvailMb, "MB"), used_pct: memAvailMb === null ? na("/proc/meminfo is missing") : m(Math.round(100 * (1 - memAvailMb / memTotalMb)), "%") },
      gpu: gpu ? { devices: [gpu], status: m(1, "devices", "nvidia-smi") } : { devices: [], status: na("no supported GPU tool found") },
      storage: [{ path: "/", total_gb: m(64, "GB"), free_gb: m(30, "GB"), used_pct: m(53, "%") }],
      network: { interfaces: [], link_up: m(true, "bool") },
      battery: { percent: m(76, "%"), status: m("discharging", "state") },
      power: { external_power: m(false, "bool") },
      inference: { latency_ms_p50: na("no local inference has run") },
    },
    evaluation: { status, warnings, unmeasured: cpuTemp === null ? ["cpu.temperature_c"] : [] },
    actions: [], workloads: [{ cls: "critical_safety", protected: true, sheddable: false, services: ["safety-gateway"] }],
    ...(policy ? { policy } : {}),
  };
}

async function account(name) {
  const response = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${name}@graph.example`, password: "correct horse battery staple" }) });
  assert.equal(response.status, 200, await response.clone().text());
  users[name] = { Cookie: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") };
  users[`${name}Id`] = (await db.query("SELECT id FROM hannah_users WHERE email = $1", [`${name}@graph.example`])).rows[0].id;
}

async function enrolled(who, name) {
  const created = await call(who, "POST", "/robots", { name, simulated: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const robot = createRobotClient({ base });
  const answer = await robot.enroll(created.body.enrollment.code, descriptor());
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal((await robot.sync()).status, 200);
  return robot;
}

async function syncResources(robot, resources) {
  const text = JSON.stringify({ runtime: { version: "test", adapter: "stand-in" }, state: robot.state, reports: [], events: [], resources });
  const response = await robot.rawSync(text, robot.sign(text));
  assert.equal(response.status, 200, await response.text());
}

before(async () => {
  if (pglite) await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  db = await require("./db").getDatabase();
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["ada", "ben", "cy"]) await account(name);
  const key = await call(users.ada, "POST", "/account/api-keys", { name: "agent" });
  users.adaKey = { Authorization: `Bearer ${key.body.key}` };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

// ------------------------------------------------------------------ edge resources
test("migration 37 created the graph and edge resource tables", async () => {
  const applied = (await db.query("SELECT version FROM hannah_migrations WHERE version = 37")).rows;
  assert.equal(applied.length, 1);
  for (const table of ["hannah_graph_nodes", "hannah_graph_node_versions", "hannah_graph_edges", "hannah_edge_resource_reports"]) {
    assert.ok((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows);
  }
});

test("a robot's resources report is stored as measured, history is kept, and nothing is invented", async () => {
  const robot = await enrolled(users.ada, "Scout");
  const none = await call(users.ada, "GET", `/robots/${robot.robotId}/resources`);
  assert.equal(none.status, 200);
  assert.equal(none.body.latest, null);
  assert.equal(none.body.advice.available, false);
  assert.match(none.body.note, /hasn't sent an edge resources report/);

  await syncResources(robot, report({ cpuTemp: null }));
  const got = await call(users.ada, "GET", `/robots/${robot.robotId}/resources`);
  assert.equal(got.status, 200);
  const latest = got.body.latest;
  assert.equal(latest.fresh, true);
  assert.equal(latest.simulatedHost, true, "a simulated robot's report measured its host computer");
  assert.match(latest.measuredOn, /simulated robot \(not robot hardware\)/);
  assert.equal(latest.snapshot.cpu.temperature_c.available, false);
  assert.match(latest.snapshot.cpu.temperature_c.reason, /^not measurable on this device/);
  assert.equal(latest.snapshot.memory.total_mb.value, 8000);
  assert.equal(got.body.history.length, 1);
  assert.equal(got.body.history[0].cpuTempC, null);
  assert.equal(got.body.history[0].memoryPct, 25);
  // Another account can't read it.
  assert.equal((await call(users.ben, "GET", `/robots/${robot.robotId}/resources`)).status, 404);
});

test("a malformed measurement becomes 'not measurable'; a foreign report is refused and recorded", () => {
  const raw = report();
  raw.snapshot.cpu.utilization_pct = { available: true, value: { nested: 1 }, unit: "%" };
  const { report: cleaned } = normalizeReport(raw);
  assert.equal(cleaned.snapshot.cpu.utilization_pct.available, false);
  assert.match(cleaned.snapshot.cpu.utilization_pct.reason, /isn't a measurement/);
  assert.throws(() => normalizeReport({ schema: "other" }), /hannah.edge-resources.v1/);
});

test("model advice uses the reported hardware and degrades without touching safety", () => {
  const view = (raw) => ({ id: "r", fresh: true, ageS: 1, measuredAt: Date.now(), measuredOn: "x", simulatedHost: false, ...normalizeReport(raw).report, evaluation: raw.evaluation });
  const small = adviseForRobot(view(report({ memAvailMb: 5000, memTotalMb: 8000 })));
  assert.equal(small.degradation.level, "normal");
  assert.ok(small.chosen, "something fits in 5 GB free");
  assert.ok(!small.recommendations.some((item) => item.fits && item.weightsGB > 3), "nothing bigger than its free memory allows");
  assert.match(small.chosen.reason, /free system memory/);

  const gpu = adviseForRobot(view(report({ gpu: { name: "RTX A4000", utilization_pct: m(5, "%"), memory_used_mb: m(1000, "MB"), memory_total_mb: m(16384, "MB"), temperature_c: m(40, "C"), power_w: m(20, "W"), shared_memory: false } })));
  assert.equal(gpu.hardware.gpuKind, "discrete");
  assert.equal(gpu.chosen.placement, "gpu");

  const hot = adviseForRobot(view(report({ status: "critical", warnings: [{ kind: "thermal", severity: "critical", metric: "cpu.temperature_c", value: 93, threshold: 90, message: "CPU temperature 93 C", source: "/sys/class/thermal/thermal_zone0" }] })), { approvedRemote: null });
  assert.equal(hot.degradation.level, "minimal");
  const reasoning = hot.degradation.decisions.find((item) => item.workload === "ai_reasoning");
  assert.equal(reasoning.action, "use-smaller-model");
  assert.match(reasoning.reason, /no remote resource is approved/);
  for (const protectedClass of ["critical_safety", "navigation"]) assert.equal(hot.degradation.decisions.find((item) => item.workload === protectedClass).action, "unchanged");

  const remote = adviseForRobot(view(report({ status: "critical", warnings: [{ kind: "thermal", severity: "critical", message: "CPU temperature 93 C", source: "t" }] })), { approvedRemote: "hannah-server" });
  assert.equal(remote.degradation.decisions[0].action, "offload-to-approved-remote");
  const local = adviseForRobot(view(report({ status: "critical", warnings: [{ kind: "thermal", severity: "critical", message: "hot", source: "t" }] })), { approvedRemote: "hannah-server", privacy: "local-only" });
  assert.notEqual(local.degradation.decisions[0].action, "offload-to-approved-remote");

  const blind = hardwareFromReport(view(report({ memAvailMb: null, memTotalMb: null })));
  assert.deepEqual(blind.missing.slice(0, 2), ["installed memory", "free memory"]);
  const unknown = adviseForRobot(view(report({ memAvailMb: null, memTotalMb: null })));
  assert.equal(unknown.chosen, null);
  assert.match(unknown.degradation.decisions[0].reason, /free memory isn't measurable/);
});

test("the agent tool reports resources with their sources", async () => {
  const robot = await enrolled(users.ada, "Rover2");
  await syncResources(robot, report({ id: "res_tool", policy: { approved_remote_resources: ["hannah-server"], reasoning_privacy: "allow-approved-remote" } }));
  const result = await call(users.adaKey, "POST", "/actions", { action: "robots.resources", params: { robot: "Rover2" }, request: "how is the robot's compute?", agent: "Robot agent" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.record.status, "done", JSON.stringify(result.body.record));
  const response = result.body.record.response;
  assert.equal(response.snapshot.memory.total_mb.source, "test fixture");
  assert.equal(response.modelAdvice.available, true);
  assert.ok(response.modelAdvice.degradation.decisions.some((item) => item.workload === "critical_safety" && item.action === "unchanged"));
});

// ------------------------------------------------------------------ graph
test("auto-population derives robots, sensors, maps, maintenance and workflows, with history when they change", async () => {
  await db.query("INSERT INTO hannah_workflows (user_id, id, name, draft, draft_version, published_version, active, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, 1, 1, $5, $5)", [users.adaId, "wf_cooling", "Cooling alarm response", "{}", Date.now()]);
  await db.query("INSERT INTO hannah_workflows (user_id, id, name, draft, draft_version, published_version, active, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, NULL, 0, $5, $5)", [users.adaId, "wf_draft", "Unpublished idea", "{}", Date.now()]);
  assert.equal((await call(users.adaKey, "POST", "/graph/populate")).status, 403, "a developer key can't rewrite the graph");
  const filled = await call(users.ada, "POST", "/graph/populate");
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.ok(filled.body.nodes >= 6);
  const graph = (await call(users.ada, "GET", "/graph")).body;
  const scoutId = (await call(users.ada, "GET", "/robots")).body.robots.find((r) => r.name === "Scout").id;
  const scout = graph.nodes.find((node) => node.ref === `robot:${scoutId}`);
  assert.ok(scout && scout.derived && scout.type === "robot");
  const lidar = graph.nodes.find((node) => node.name === "Scout lidar");
  assert.equal(lidar.type, "sensor");
  assert.ok(graph.edges.some((edge) => edge.type === "HAS_SENSOR" && edge.from === scout.id && edge.to === lidar.id && edge.typeVersion === 1));
  assert.ok(graph.nodes.some((node) => node.type === "workflow" && node.name === "Cooling alarm response"));
  // Running it again adds nothing.
  const again = (await call(users.ada, "POST", "/graph/populate")).body;
  assert.equal(again.nodes, 0);
  assert.equal(again.edges, 0);
  // A renamed robot keeps its node and gets a new version.
  await call(users.ada, "PATCH", `/robots/${scout.ref.slice(6)}`, { name: "Scout Prime" });
  await call(users.ada, "POST", "/graph/populate");
  const hist = (await call(users.ada, "GET", `/graph/nodes/${scout.id}/history`)).body;
  assert.deepEqual(hist.versions.map((item) => item.name), ["Scout", "Scout Prime"]);
  assert.ok(hist.versions[0].validTo !== null && hist.versions[1].validTo === null);
  // Derived entities are changed at their source, not in the graph.
  assert.equal((await call(users.ada, "PATCH", `/graph/nodes/${scout.id}`, { name: "x" })).status, 409);
});

test("context: sensor anomaly → machine → zone → monitoring robot → approved workflow, each checked live", async () => {
  const add = async (body) => { const r = await call(users.ada, "POST", "/graph/nodes", body); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.node; };
  const link = async (type, from, to) => { const r = await call(users.ada, "POST", "/graph/edges", { type, from: from.id, to: to.id }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.edge; };
  const all = (await call(users.ada, "GET", "/graph")).body.nodes;
  const robot = all.find((node) => node.name === "Scout Prime");
  const workflow = all.find((node) => node.name === "Cooling alarm response");
  const draft = all.find((node) => node.name === "Unpublished idea");
  const sensor = await add({ type: "sensor", name: "Chiller 3 vibration sensor", props: { unit: "mm/s" } });
  const machine = await add({ type: "machine", name: "Chiller 3" });
  const zone = await add({ type: "zone", name: "Plant room B" });
  const building = await add({ type: "building", name: "North building" });
  await link("MONITORS", sensor, machine);
  await link("LOCATED_IN", machine, zone);
  await link("PART_OF", zone, building);
  await link("MONITORS", robot, zone);
  await link("HANDLES", workflow, machine);
  await link("HANDLES", draft, machine);
  // Relationship rules are enforced.
  const wrong = await call(users.ada, "POST", "/graph/edges", { type: "HAS_SENSOR", from: zone.id, to: sensor.id });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.reason, "invalid-relation");

  const ctx = await call(users.ada, "GET", `/graph/nodes/${sensor.id}/context`);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
  assert.deepEqual(ctx.body.machines.map((item) => item.name), ["Chiller 3"]);
  assert.deepEqual(ctx.body.places.map((item) => item.name), ["Plant room B", "North building"]);
  assert.deepEqual(ctx.body.robots.map((item) => item.name), ["Scout Prime"]);
  // The robot synced moments ago, so its live check says connected; a person-entered machine has no live source.
  assert.equal(ctx.body.robots[0].live.verified, true);
  assert.equal(ctx.body.machines[0].label, "recorded");
  // Only the published, active workflow counts as approved.
  assert.deepEqual(ctx.body.approvedWorkflows.map((item) => item.name), ["Cooling alarm response"]);
  assert.match(ctx.body.workflows.find((item) => item.name === "Unpublished idea").live.detail, /never been published/);

  // When the robot is revoked the same question no longer calls it current.
  await call(users.ada, "POST", `/robots/${robot.ref.slice(6)}/revoke`);
  const later = (await call(users.ada, "GET", `/graph/nodes/${sensor.id}/context`)).body;
  assert.equal(later.robots[0].live.current, false);
  assert.equal(later.robots[0].label, "not current");

  // The agent tool asks the same question by name.
  const asked = await call(users.adaKey, "POST", "/actions", { action: "robots.graph", params: { entity: "Chiller 3 vibration sensor", question: "context" }, request: "what does this sensor affect?", agent: "Robot agent" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.match(asked.body.record.response.summary, /Chiller 3/);
  const neighbors = await call(users.adaKey, "POST", "/graph/ask", { entity: "Chiller 3", question: "neighbors", depth: 1 });
  assert.ok(neighbors.body.relationships.includes("Chiller 3 vibration sensor —MONITORS→ Chiller 3"));
});

test("temporal: a closed relationship is gone now but visible as of before", async () => {
  const before = Date.now();
  const nodes = (await call(users.ada, "GET", "/graph?type=machine")).body.nodes;
  const machine = nodes.find((node) => node.name === "Chiller 3");
  const edges = (await call(users.ada, "GET", `/graph/nodes/${machine.id}/neighbors?depth=1`)).body.edges;
  const located = edges.find((edge) => edge.type === "LOCATED_IN");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await call(users.ada, "DELETE", `/graph/edges/${located.id}`)).status, 200);
  const now = (await call(users.ada, "GET", `/graph/nodes/${machine.id}/neighbors?depth=1`)).body.edges;
  assert.ok(!now.some((edge) => edge.id === located.id));
  const then = (await call(users.ada, "GET", `/graph/nodes/${machine.id}/neighbors?depth=1&asOf=${before}`)).body.edges;
  assert.ok(then.some((edge) => edge.id === located.id));
  const hist = (await call(users.ada, "GET", `/graph/nodes/${machine.id}/history`)).body;
  assert.ok(hist.edges.find((edge) => edge.id === located.id).validTo !== null);
  // Traversal depth is capped.
  assert.equal((await call(users.ada, "GET", `/graph/nodes/${machine.id}/neighbors?depth=99`)).body.depth, 4);
});

test("no cross-tenant leaks: other accounts, teams and their members see only what is theirs", async () => {
  const adaGraph = (await call(users.ada, "GET", "/graph")).body;
  const secret = adaGraph.nodes.find((node) => node.name === "Chiller 3");
  // Ben sees nothing of Ada's.
  assert.equal((await call(users.ben, "GET", "/graph")).body.nodes.length, 0);
  for (const route of [`/graph/nodes/${secret.id}`, `/graph/nodes/${secret.id}/history`, `/graph/nodes/${secret.id}/neighbors`, `/graph/nodes/${secret.id}/context`]) {
    assert.equal((await call(users.ben, "GET", route)).status, 404, route);
  }
  assert.equal((await call(users.ben, "POST", "/graph/ask", { entity: "Chiller 3" })).status, 404);
  assert.equal((await call(users.ben, "DELETE", `/graph/nodes/${secret.id}`)).status, 404);

  // Ada's team: Ben joins as a member; Cy stays outside.
  const team = (await call(users.ada, "POST", "/workforce/teams", { name: "Plant ops" })).body.team;
  assert.equal((await call(users.ada, "POST", `/workforce/teams/${team.id}/members`, { email: "ben@graph.example", role: "member" })).status, 201);
  const shared = (await call(users.ada, "POST", "/graph/nodes", { type: "warehouse", name: "Shared warehouse", team: team.id, workspace: "ws_ops" })).body.node;
  const sharedMachine = (await call(users.ada, "POST", "/graph/nodes", { type: "machine", name: "Shared conveyor", team: team.id })).body.node;
  assert.equal((await call(users.ada, "POST", "/graph/edges", { type: "LOCATED_IN", from: sharedMachine.id, to: shared.id })).status, 201);
  // A team edge can't reach into a personal entity, either way.
  const crossing = await call(users.ada, "POST", "/graph/edges", { type: "LOCATED_IN", from: secret.id, to: shared.id });
  assert.equal(crossing.status, 400);
  assert.equal(crossing.body.reason, "cross-scope");

  const benView = (await call(users.ben, "GET", "/graph")).body;
  assert.deepEqual(benView.nodes.map((node) => node.name).sort(), ["Shared conveyor", "Shared warehouse"]);
  assert.equal(benView.edges.length, 1);
  assert.equal(benView.nodes[0].scope.owner, "a teammate");
  // Workspace narrows, never widens.
  assert.deepEqual((await call(users.ben, "GET", "/graph?workspace=ws_ops")).body.nodes.map((node) => node.name), ["Shared warehouse"]);
  // A member reads but can't change the team's graph.
  assert.equal((await call(users.ben, "PATCH", `/graph/nodes/${shared.id}`, { name: "Mine now" })).status, 403);
  assert.equal((await call(users.ben, "POST", "/graph/nodes", { type: "room", name: "x", team: team.id })).status, 403);
  // Traversal from a team entity never reaches Ada's personal entities, even through a forged edge.
  await db.query("INSERT INTO hannah_graph_edges (id, user_id, team_id, workspace_id, project_id, type, type_version, from_id, to_id, props, source, valid_from, valid_to, created_at) VALUES ($1, $2, $3, NULL, NULL, 'LOCATED_IN', 1, $4, $5, '{}', 'test:forged', $6, NULL, $6)",
    ["ge_forged0000000001", users.adaId, team.id, sharedMachine.id, secret.id, Date.now() - 1000]);
  const walked = (await call(users.ben, "GET", `/graph/nodes/${sharedMachine.id}/neighbors?depth=4`)).body;
  assert.ok(!walked.nodes.some((node) => node.id === secret.id), "a personal entity never shows up in a teammate's traversal");
  assert.ok(!walked.edges.some((edge) => edge.id === "ge_forged0000000001"));
  // Cy, outside the team, sees nothing at all.
  assert.equal((await call(users.cy, "GET", "/graph")).body.nodes.length, 0);
  assert.equal((await call(users.cy, "GET", `/graph/nodes/${shared.id}`)).status, 404);
  // Leaving the team ends access at once.
  await call(users.ada, "DELETE", `/workforce/teams/${team.id}/members/${users.benId}`);
  assert.equal((await call(users.ben, "GET", "/graph")).body.nodes.length, 0);
});

test("the schema lists versioned relationship types", async () => {
  const schema = (await call(users.ada, "GET", "/graph/schema")).body;
  const monitors = schema.relations.find((item) => item.id === "MONITORS");
  assert.equal(monitors.version, 2);
  assert.equal(monitors.changes.length, 2);
  for (const id of ["HAS_SENSOR", "HAS_MOTOR", "MONITORS", "OPERATES_IN", "LOCATED_IN", "CONTROLS", "ASSIGNED_TO", "USES_MAP", "CONNECTED_TO"]) assert.ok(schema.relations.some((item) => item.id === id), id);
  for (const id of ["user", "organization", "workspace", "robot", "machine", "iot_device", "sensor", "actuator", "motor_controller", "network", "room", "building", "warehouse", "map", "environment", "task", "mission", "workflow", "skill", "maintenance_record", "hardware_component"]) assert.ok(schema.entities.some((item) => item.id === id), id);
});
