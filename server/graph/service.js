"use strict";

/**
 * The Device Intelligence Graph.
 *
 * Entities (robots, sensors, machines, rooms, workflows…) and typed,
 * versioned relationships, stored with their history: a change closes the
 * old row (valid_to) and adds a new one, so the graph can be read as it was
 * at any time, and every row says where it came from (`source`: a person,
 * or `auto:<kind>` when it was derived from the account's robots, hubs,
 * devices, missions, maintenance records and workflows).
 *
 * Scope. A row belongs to one account (user_id) and is either personal
 * (team_id NULL: only that account sees it) or shared with one team (every
 * current member sees it; only the team's owner or managers change it).
 * Workspace and project narrow a query; they never widen what is visible.
 * Membership is read from the database on every call. An edge may only
 * join two entities of the same scope, and traversal re-checks visibility
 * of every edge and node it reaches, so nothing crosses accounts or teams.
 *
 * "Current". Graph rows are what was recorded. A context answer asks the
 * live source again for every robot, device, hub, workflow and mission it
 * returns (is the robot connected now, is the workflow still published and
 * active) and calls an entity current only when that check says so;
 * everything else is labelled as last known or as entered by a person.
 */
const crypto = require("node:crypto");
const { ENTITY_TYPES, PLACES, RELATION_TYPES, publicSchema, relationProblem } = require("./schema");

const MAX_DEPTH = 4;
const MAX_NODES = 200;
const ID = /^g[ne]_[a-f0-9]{8,40}$/;
const SCOPE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = {}) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const newId = (prefix) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
const optionalScope = (value, label) => {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value);
  if (!SCOPE_ID.test(text)) throw fail(400, `That ${label} isn't a valid id.`, "invalid");
  return text;
};

/** Props are a flat object of short scalars: what a person or a source said about the entity. */
function cleanProps(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw fail(400, "Properties must be an object.", "invalid");
  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    const name = clean(key, 60);
    if (!/^[A-Za-z][A-Za-z0-9_ .-]*$/.test(name)) continue;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[name] = value;
    else if (typeof value === "string") out[name] = clean(value, 300);
    else if (Array.isArray(value)) out[name] = value.slice(0, 20).map((item) => clean(item, 80)).filter(Boolean);
  }
  if (JSON.stringify(out).length > 6000) throw fail(413, "Those properties are too large.", "too-large");
  return out;
}

function createGraphService({ now = () => Date.now(), robotics = null, devices = null } = {}) {
  const robots = () => (typeof robotics === "function" ? robotics() : robotics);
  const deviceService = () => (typeof devices === "function" ? devices() : devices);

  // ---------------------------------------------------------------- scope
  async function scopeOf(db, userId) {
    const { rows } = await db.query("SELECT team_id, role FROM hannah_team_members WHERE user_id = $1", [userId]);
    return { userId, teams: new Map(rows.map((row) => [row.team_id, row.role])) };
  }

  /** SQL that keeps only rows this account may see. Appends its values to params. */
  function visible(scope, alias, params) {
    params.push(scope.userId);
    const own = `(${alias}.user_id = $${params.length} AND ${alias}.team_id IS NULL)`;
    const teams = [...scope.teams.keys()];
    if (!teams.length) return own;
    const marks = teams.map((team) => { params.push(team); return `$${params.length}`; });
    return `(${own} OR ${alias}.team_id IN (${marks.join(", ")}))`;
  }

  function temporal(alias, asOf, params) {
    if (asOf === null || asOf === undefined) return `${alias}.valid_to IS NULL`;
    params.push(asOf);
    const at = `$${params.length}`;
    return `(${alias}.valid_from <= ${at} AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ${at}))`;
  }

  function assertCanWrite(scope, row) {
    if (row.team_id) {
      const role = scope.teams.get(row.team_id);
      if (!role) throw fail(404, "That entity isn't in your graph.", "not-found");
      if (!["owner", "manager"].includes(role)) throw fail(403, "Only the team's owner or a manager can change its shared graph.", "forbidden");
    } else if (row.user_id !== scope.userId) {
      throw fail(404, "That entity isn't in your graph.", "not-found");
    }
  }

  function nodeView(row, scope) {
    return {
      id: row.id, type: row.type, typeLabel: ENTITY_TYPES[row.type] || row.type, name: row.name, ref: row.ref || null, props: parse(row.props),
      source: row.source, derived: String(row.source).startsWith("auto:"),
      scope: { team: row.team_id || null, workspace: row.workspace_id || null, project: row.project_id || null, owner: row.user_id === scope.userId ? "you" : "a teammate" },
      validFrom: Number(row.valid_from), validTo: row.valid_to === null || row.valid_to === undefined ? null : Number(row.valid_to),
    };
  }
  function edgeView(row) {
    const rel = RELATION_TYPES[row.type];
    return {
      id: row.id, type: row.type, typeVersion: Number(row.type_version), currentTypeVersion: rel ? rel.version : null, from: row.from_id, to: row.to_id, props: parse(row.props), source: row.source,
      derived: String(row.source).startsWith("auto:"), scope: { team: row.team_id || null, workspace: row.workspace_id || null, project: row.project_id || null },
      validFrom: Number(row.valid_from), validTo: row.valid_to === null || row.valid_to === undefined ? null : Number(row.valid_to),
    };
  }

  async function nodeRow(db, scope, id, { open = true } = {}) {
    if (!ID.test(String(id || ""))) throw fail(404, "That entity isn't in your graph.", "not-found");
    const params = [String(id)];
    const row = (await db.query(`SELECT * FROM hannah_graph_nodes n WHERE n.id = $1 AND ${visible(scope, "n", params)}${open ? " AND n.valid_to IS NULL" : ""}`, params)).rows[0];
    if (!row) throw fail(404, "That entity isn't in your graph.", "not-found");
    return row;
  }

  async function nodesByIds(db, scope, ids, asOf = null) {
    if (!ids.length) return [];
    const params = [];
    const marks = ids.map((id) => { params.push(id); return `$${params.length}`; });
    const sql = `SELECT * FROM hannah_graph_nodes n WHERE n.id IN (${marks.join(", ")}) AND ${visible(scope, "n", params)} AND ${temporal("n", asOf, params)}`;
    return (await db.query(sql, params)).rows;
  }

  async function edgesAround(db, scope, ids, asOf = null, types = null) {
    if (!ids.length) return [];
    const params = [];
    const marks = ids.map((id) => { params.push(id); return `$${params.length}`; });
    let sql = `SELECT * FROM hannah_graph_edges e WHERE (e.from_id IN (${marks.join(", ")}) OR e.to_id IN (${marks.join(", ")})) AND ${visible(scope, "e", params)} AND ${temporal("e", asOf, params)}`;
    if (types?.length) sql += ` AND e.type IN (${types.map((type) => { params.push(type); return `$${params.length}`; }).join(", ")})`;
    return (await db.query(`${sql} ORDER BY e.valid_from`, params)).rows;
  }

  // ---------------------------------------------------------------- reads
  async function list(db, userId, { type, workspace, project, team, asOf, limit = 500 } = {}) {
    const scope = await scopeOf(db, userId);
    const at = asOf === undefined || asOf === null || asOf === "" ? null : Number(asOf);
    if (at !== null && !Number.isFinite(at)) throw fail(400, "asOf must be a time in milliseconds.", "invalid");
    const params = [];
    const where = [visible(scope, "n", params), temporal("n", at, params)];
    if (type) { if (!ENTITY_TYPES[type]) throw fail(400, `${type} is not an entity type.`, "invalid"); params.push(type); where.push(`n.type = $${params.length}`); }
    for (const [column, value, label] of [["workspace_id", workspace, "workspace"], ["project_id", project, "project"], ["team_id", team, "team"]]) {
      const id = optionalScope(value, label);
      if (id) { params.push(id); where.push(`n.${column} = $${params.length}`); }
    }
    params.push(Math.max(1, Math.min(2000, Number(limit) || 500)));
    const nodes = (await db.query(`SELECT * FROM hannah_graph_nodes n WHERE ${where.join(" AND ")} ORDER BY n.type, n.name LIMIT $${params.length}`, params)).rows;
    const ids = nodes.map((row) => row.id);
    const shown = new Set(ids);
    const edges = [];
    for (let index = 0; index < ids.length; index += 200) {
      for (const row of await edgesAround(db, scope, ids.slice(index, index + 200), at)) if (shown.has(row.from_id) && shown.has(row.to_id) && !edges.some((edge) => edge.id === row.id)) edges.push(row);
    }
    return { asOf: at, nodes: nodes.map((row) => nodeView(row, scope)), edges: edges.map(edgeView) };
  }

  async function getNode(db, userId, id) {
    const scope = await scopeOf(db, userId);
    return nodeView(await nodeRow(db, scope, id, { open: false }), scope);
  }

  /** Every version of an entity and every relationship it ever had that this account may see. */
  async function history(db, userId, id) {
    const scope = await scopeOf(db, userId);
    const row = await nodeRow(db, scope, id, { open: false });
    const versions = (await db.query("SELECT * FROM hannah_graph_node_versions WHERE node_id = $1 ORDER BY version", [row.id])).rows.map((item) => ({ version: Number(item.version), name: item.name, props: parse(item.props), source: item.source, validFrom: Number(item.valid_from), validTo: item.valid_to === null ? null : Number(item.valid_to) }));
    const params = [row.id];
    const edges = (await db.query(`SELECT * FROM hannah_graph_edges e WHERE (e.from_id = $1 OR e.to_id = $1) AND ${visible(scope, "e", params)} ORDER BY e.valid_from`, params)).rows;
    const others = await nodesByAnyTime(db, scope, [...new Set(edges.flatMap((edge) => [edge.from_id, edge.to_id]))]);
    return { node: nodeView(row, scope), versions, edges: edges.filter((edge) => others.has(edge.from_id) && others.has(edge.to_id)).map((edge) => ({ ...edgeView(edge), fromName: others.get(edge.from_id).name, toName: others.get(edge.to_id).name })) };
  }
  async function nodesByAnyTime(db, scope, ids) {
    const out = new Map();
    for (let index = 0; index < ids.length; index += 200) {
      const params = [];
      const marks = ids.slice(index, index + 200).map((id) => { params.push(id); return `$${params.length}`; });
      for (const row of (await db.query(`SELECT * FROM hannah_graph_nodes n WHERE n.id IN (${marks.join(", ")}) AND ${visible(scope, "n", params)}`, params)).rows) out.set(row.id, row);
    }
    return out;
  }

  /**
   * Breadth-first traversal from one entity, at most `depth` hops (≤ 4) and
   * MAX_NODES entities. Every hop re-applies the visibility and time filters.
   */
  async function traverse(db, userId, id, { depth = 2, types = null, asOf = null } = {}) {
    const scope = await scopeOf(db, userId);
    const start = await nodeRow(db, scope, id, { open: asOf === null });
    const limit = Math.max(1, Math.min(MAX_DEPTH, Number(depth) || 2));
    const wanted = types ? (Array.isArray(types) ? types : String(types).split(",")).map((item) => item.trim()).filter((item) => RELATION_TYPES[item]) : null;
    const nodes = new Map([[start.id, { row: start, hops: 0 }]]);
    const edges = new Map();
    let frontier = [start.id];
    let truncated = false;
    for (let hop = 1; hop <= limit && frontier.length; hop += 1) {
      const found = await edgesAround(db, scope, frontier, asOf, wanted);
      const next = new Set();
      for (const edge of found) for (const other of [edge.from_id, edge.to_id]) if (!nodes.has(other)) next.add(other);
      const rows = await nodesByIds(db, scope, [...next].slice(0, MAX_NODES), asOf);
      for (const row of rows) {
        if (nodes.size >= MAX_NODES) { truncated = true; break; }
        nodes.set(row.id, { row, hops: hop });
      }
      for (const edge of found) if (nodes.has(edge.from_id) && nodes.has(edge.to_id)) edges.set(edge.id, edge);
      frontier = rows.map((row) => row.id).filter((nodeId) => nodes.get(nodeId)?.hops === hop);
    }
    return {
      start: nodeView(start, scope), depth: limit, truncated, asOf,
      nodes: [...nodes.values()].map(({ row, hops }) => ({ ...nodeView(row, scope), hops })),
      edges: [...edges.values()].map(edgeView),
    };
  }

  // ---------------------------------------------------------------- writes
  async function insertNode(db, { userId, teamId = null, workspaceId = null, projectId = null, type, ref = null, name, props, source, at }) {
    const id = newId("gn");
    await db.query("INSERT INTO hannah_graph_nodes (id, user_id, team_id, workspace_id, project_id, type, ref, name, props, source, valid_from, valid_to, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $11, $11)",
      [id, userId, teamId, workspaceId, projectId, type, ref, name, JSON.stringify(props), source, at]);
    await db.query("INSERT INTO hannah_graph_node_versions (node_id, version, name, props, source, valid_from, valid_to) VALUES ($1, 1, $2, $3, $4, $5, NULL)", [id, name, JSON.stringify(props), source, at]);
    return id;
  }

  async function reviseNode(db, row, { name, props, source, at }) {
    const current = (await db.query("SELECT MAX(version) AS v FROM hannah_graph_node_versions WHERE node_id = $1", [row.id])).rows[0];
    const version = Number(current?.v || 0) + 1;
    await db.query("UPDATE hannah_graph_node_versions SET valid_to = $1 WHERE node_id = $2 AND valid_to IS NULL", [at, row.id]);
    await db.query("INSERT INTO hannah_graph_node_versions (node_id, version, name, props, source, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5, $6, NULL)", [row.id, version, name, JSON.stringify(props), source, at]);
    await db.query("UPDATE hannah_graph_nodes SET name = $1, props = $2, source = $3, updated_at = $4 WHERE id = $5", [name, JSON.stringify(props), source, at, row.id]);
    return version;
  }

  async function createNode(db, userId, input = {}) {
    const scope = await scopeOf(db, userId);
    const type = String(input.type || "");
    if (!ENTITY_TYPES[type]) throw fail(400, `Choose an entity type: ${Object.keys(ENTITY_TYPES).join(", ")}.`, "invalid");
    const name = clean(input.name, 120);
    if (!name) throw fail(400, "Give the entity a name.", "invalid");
    const teamId = optionalScope(input.team, "team");
    if (teamId) assertCanWrite(scope, { team_id: teamId, user_id: userId });
    const at = now();
    const id = await insertNode(db, { userId, teamId, workspaceId: optionalScope(input.workspace, "workspace"), projectId: optionalScope(input.project, "project"), type, name, props: cleanProps(input.props), source: `user:${userId}`, at });
    return getNode(db, userId, id);
  }

  async function updateNode(db, userId, id, input = {}) {
    const scope = await scopeOf(db, userId);
    const row = await nodeRow(db, scope, id);
    assertCanWrite(scope, row);
    if (String(row.source).startsWith("auto:")) throw fail(409, `${row.name} comes from your ${row.source.slice(5)} records; change it there and refresh the graph.`, "derived");
    const name = input.name === undefined ? row.name : clean(input.name, 120);
    if (!name) throw fail(400, "Give the entity a name.", "invalid");
    const props = input.props === undefined ? parse(row.props) : cleanProps(input.props);
    await reviseNode(db, row, { name, props, source: `user:${userId}`, at: now() });
    return getNode(db, userId, id);
  }

  async function closeNodeRow(db, row, at) {
    await db.query("UPDATE hannah_graph_nodes SET valid_to = $1, updated_at = $1 WHERE id = $2 AND valid_to IS NULL", [at, row.id]);
    await db.query("UPDATE hannah_graph_node_versions SET valid_to = $1 WHERE node_id = $2 AND valid_to IS NULL", [at, row.id]);
    await db.query("UPDATE hannah_graph_edges SET valid_to = $1 WHERE (from_id = $2 OR to_id = $2) AND valid_to IS NULL", [at, row.id]);
  }

  async function closeNode(db, userId, id) {
    const scope = await scopeOf(db, userId);
    const row = await nodeRow(db, scope, id);
    assertCanWrite(scope, row);
    if (String(row.source).startsWith("auto:")) throw fail(409, `${row.name} comes from your ${row.source.slice(5)} records; remove it there and refresh the graph.`, "derived");
    await closeNodeRow(db, row, now());
    return { closed: true, id: row.id };
  }

  async function insertEdge(db, { from, to, type, props = {}, source, at, workspaceId = null, projectId = null }) {
    const id = newId("ge");
    await db.query("INSERT INTO hannah_graph_edges (id, user_id, team_id, workspace_id, project_id, type, type_version, from_id, to_id, props, source, valid_from, valid_to, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $12)",
      [id, from.user_id, from.team_id || null, workspaceId ?? from.workspace_id ?? null, projectId ?? from.project_id ?? null, type, RELATION_TYPES[type].version, from.id, to.id, JSON.stringify(props), source, at]);
    return id;
  }

  async function createEdge(db, userId, input = {}) {
    const scope = await scopeOf(db, userId);
    const type = String(input.type || "").toUpperCase();
    const from = await nodeRow(db, scope, input.from);
    const to = await nodeRow(db, scope, input.to);
    if (from.id === to.id) throw fail(400, "A relationship joins two different entities.", "invalid");
    const problem = relationProblem(type, from.type, to.type);
    if (problem) throw fail(400, problem, "invalid-relation");
    // Both ends in one scope: two personal entities of this account, or two entities of the same team.
    if ((from.team_id || null) !== (to.team_id || null) || (!from.team_id && (from.user_id !== userId || to.user_id !== userId))) {
      throw fail(400, "Both entities must be in the same scope: both yours, or both shared with the same team.", "cross-scope");
    }
    assertCanWrite(scope, from);
    const existing = (await db.query("SELECT * FROM hannah_graph_edges WHERE from_id = $1 AND to_id = $2 AND type = $3 AND valid_to IS NULL", [from.id, to.id, type])).rows[0];
    if (existing) return { ...edgeView(existing), existing: true };
    const id = await insertEdge(db, { from, to, type, props: cleanProps(input.props), source: `user:${userId}`, at: now(), workspaceId: optionalScope(input.workspace, "workspace"), projectId: optionalScope(input.project, "project") });
    return edgeView((await db.query("SELECT * FROM hannah_graph_edges WHERE id = $1", [id])).rows[0]);
  }

  async function closeEdge(db, userId, id) {
    const scope = await scopeOf(db, userId);
    if (!ID.test(String(id || ""))) throw fail(404, "That relationship isn't in your graph.", "not-found");
    const params = [String(id)];
    const row = (await db.query(`SELECT * FROM hannah_graph_edges e WHERE e.id = $1 AND e.valid_to IS NULL AND ${visible(scope, "e", params)}`, params)).rows[0];
    if (!row) throw fail(404, "That relationship isn't in your graph.", "not-found");
    assertCanWrite(scope, row);
    if (String(row.source).startsWith("auto:")) throw fail(409, `That relationship comes from your ${row.source.slice(5)} records; change it there and refresh the graph.`, "derived");
    await db.query("UPDATE hannah_graph_edges SET valid_to = $1 WHERE id = $2", [now(), row.id]);
    return { closed: true, id: row.id };
  }

  // ---------------------------------------------------------------- auto-population
  /**
   * Bring the account's personal graph in line with its robots, hubs,
   * devices, recent missions, maintenance records and workflows. Derived rows
   * that no longer have a source are closed, never deleted, so their history
   * stays. Entities and relationships a person added are left alone.
   */
  async function populate(db, userId) {
    const at = now();
    const seenNodes = new Set();
    const seenEdges = new Set();
    const counts = { nodes: 0, edges: 0, closedNodes: 0, closedEdges: 0 };

    async function node(ref, type, name, props, kind) {
      const source = `auto:${kind}`;
      const cleanName = clean(name, 120) || ref;
      const cleaned = cleanProps(props);
      let row = (await db.query("SELECT * FROM hannah_graph_nodes WHERE user_id = $1 AND ref = $2 AND valid_to IS NULL", [userId, ref])).rows[0];
      if (!row) {
        try {
          await insertNode(db, { userId, type, ref, name: cleanName, props: cleaned, source, at });
          counts.nodes += 1;
        } catch (error) {
          // Another refresh may have inserted it first: use that one; anything else is a real failure.
          row = (await db.query("SELECT * FROM hannah_graph_nodes WHERE user_id = $1 AND ref = $2 AND valid_to IS NULL", [userId, ref])).rows[0];
          if (!row) throw error;
        }
        row = row || (await db.query("SELECT * FROM hannah_graph_nodes WHERE user_id = $1 AND ref = $2 AND valid_to IS NULL", [userId, ref])).rows[0];
      } else if (row.name !== cleanName || row.props !== JSON.stringify(cleaned)) {
        await reviseNode(db, row, { name: cleanName, props: cleaned, source, at });
      }
      seenNodes.add(row.id);
      return row;
    }
    async function edge(from, type, to, kind) {
      if (!from || !to || relationProblem(type, from.type, to.type)) return;
      let row = (await db.query("SELECT id FROM hannah_graph_edges WHERE from_id = $1 AND to_id = $2 AND type = $3 AND valid_to IS NULL", [from.id, to.id, type])).rows[0];
      if (!row) {
        const id = await insertEdge(db, { from, to, type, source: `auto:${kind}`, at });
        row = { id };
        counts.edges += 1;
      }
      seenEdges.add(row.id);
    }
    const placeRef = (name) => `place:${String(name).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80)}`;

    const robotService = robots();
    if (robotService) {
      for (const robot of await robotService.listRobots(db, userId)) {
        const r = await node(`robot:${robot.id}`, "robot", robot.name, { kind: robot.simulated ? "simulation" : "physical", status: robot.status, robotType: robot.robotType || null, manufacturer: robot.manufacturer || null, model: robot.model || null }, "robots");
        for (const sensor of robot.sensors || []) {
          const s = await node(`robot:${robot.id}/sensor:${sensor.id}`, "sensor", `${robot.name} ${sensor.id}`, { sensorType: sensor.type || null, frame: sensor.frame || null, simulated: robot.simulated }, "robots");
          await edge(r, "HAS_SENSOR", s, "robots");
        }
        for (const part of robot.actuators || []) {
          const motor = /motor|wheel|drive|servo|joint/i.test(`${part.type} ${part.id}`);
          const a = await node(`robot:${robot.id}/actuator:${part.id}`, motor ? "motor_controller" : "actuator", `${robot.name} ${part.id}`, { actuatorType: part.type || null, simulated: robot.simulated }, "robots");
          await edge(r, motor ? "HAS_MOTOR" : "HAS_ACTUATOR", a, "robots");
        }
        if (robot.mapName) await edge(r, "USES_MAP", await node(`map:${robot.mapName}`, "map", robot.mapName, {}, "robots"), "robots");
        for (const entry of await robotService.maintenance(db, userId, robot.id, 10).catch(() => [])) {
          const m = await node(`maintenance:${entry.id}`, "maintenance_record", `${robot.name}: ${entry.kind}`, { kind: entry.kind, note: entry.note || "", at: entry.at }, "maintenance");
          await edge(m, "RECORDED_FOR", r, "maintenance");
        }
      }
      for (const mission of await robotService.listMissions(db, userId, { limit: 30 }).catch(() => [])) {
        const robotRow = (await db.query("SELECT * FROM hannah_graph_nodes WHERE user_id = $1 AND ref = $2 AND valid_to IS NULL", [userId, `robot:${mission.robotId}`])).rows[0];
        if (!robotRow) continue;
        const m = await node(`mission:${mission.id}`, "mission", `${mission.title || mission.capability} (${robotRow.name})`, { capability: mission.capability, status: mission.status }, "missions");
        await edge(m, "ASSIGNED_TO", robotRow, "missions");
      }
    }
    const deviceSvc = deviceService();
    if (deviceSvc) {
      const hubNodes = new Map();
      for (const hub of await deviceSvc.listHubs(db, userId)) hubNodes.set(hub.id, await node(`hub:${hub.id}`, "hub", hub.name, { status: hub.status, software: hub.software || null }, "devices"));
      for (const device of await deviceSvc.listDevices(db, userId)) {
        const category = device.profile?.category || "other";
        const type = /sensor|environment|energy-meter|camera/.test(category) ? "sensor" : category === "actuator" ? "actuator" : "iot_device";
        const d = await node(`device:${device.id}`, type, device.name, { category, manufacturer: device.profile?.manufacturer || null, model: device.profile?.model || null, simulated: device.profile?.simulated === true, points: (device.profile?.points || []).map((point) => point.id) }, "devices");
        await edge(d, "CONNECTED_TO", hubNodes.get(device.hub?.id), "devices");
        if (device.location) await edge(d, "LOCATED_IN", await node(placeRef(device.location), "room", device.location, {}, "devices"), "devices");
      }
    }
    for (const row of (await db.query("SELECT id, name, active, published_version FROM hannah_workflows WHERE user_id = $1", [userId]).catch(() => ({ rows: [] }))).rows) {
      await node(`workflow:${row.id}`, "workflow", row.name, { published: row.published_version !== null && row.published_version !== undefined, active: Boolean(Number(row.active)) }, "workflows");
    }

    // Close derived rows whose source is gone.
    const openNodes = (await db.query("SELECT * FROM hannah_graph_nodes WHERE user_id = $1 AND team_id IS NULL AND valid_to IS NULL AND source LIKE 'auto:%'", [userId])).rows;
    for (const row of openNodes) if (!seenNodes.has(row.id)) { await closeNodeRow(db, row, at); counts.closedNodes += 1; }
    const openEdges = (await db.query("SELECT id FROM hannah_graph_edges WHERE user_id = $1 AND team_id IS NULL AND valid_to IS NULL AND source LIKE 'auto:%'", [userId])).rows;
    for (const row of openEdges) if (!seenEdges.has(row.id)) { await db.query("UPDATE hannah_graph_edges SET valid_to = $1 WHERE id = $2 AND valid_to IS NULL", [at, row.id]); counts.closedEdges += 1; }
    return { ...counts, at };
  }

  // ---------------------------------------------------------------- live verification
  /** Ask the live source about one entity. Uses the owning account's records, which this caller may already see through the graph. */
  async function verify(db, row) {
    const checkedAt = now();
    const ref = String(row.ref || "");
    const owner = row.user_id;
    const result = (current, state, detail) => ({ verified: true, current, state, detail, checkedAt });
    try {
      let match = /^robot:([^/]+)\/sensor:(.+)$/.exec(ref);
      if (match && robots()) {
        const robot = await robots().getRobot(db, owner, match[1]);
        const registered = (robot.sensors || []).some((sensor) => sensor.id === match[2]);
        if (!registered) return result(false, "removed", `${robot.name} no longer reports this sensor.`);
        return result(robot.online, robot.connection, robot.online ? `${robot.name} is connected and reports this sensor (state ${robot.stateAgeS ?? "?"} s old).` : `${robot.name} is ${robot.connection}; the sensor's last report is not current.`);
      }
      match = /^robot:([^/]+)$/.exec(ref);
      if (match && robots()) {
        const robot = await robots().getRobot(db, owner, match[1]);
        return result(robot.online, robot.connection, robot.online ? `${robot.name} is connected (${robot.simulated ? "simulation" : "physical"}), mode ${robot.mode}.` : `${robot.name} is ${robot.connection}${robot.lastSeenAt ? `, last seen ${Math.round((checkedAt - robot.lastSeenAt) / 1000)} s ago` : ""}.`);
      }
      match = /^device:(.+)$/.exec(ref);
      if (match && deviceService()) {
        const device = await deviceService().getDevice(db, owner, match[1]);
        return result(device.connection === "online", device.connection, device.connection === "online" ? `${device.name} is reporting through ${device.hub.name}.` : `${device.name}: ${device.connection}${device.connectionDetail ? ` (${device.connectionDetail})` : ""}; values are last known, not live.`);
      }
      match = /^hub:(.+)$/.exec(ref);
      if (match && deviceService()) {
        const hub = await deviceService().getHub(db, owner, match[1]);
        return result(hub.online, hub.connection, `${hub.name} is ${hub.connection}.`);
      }
      match = /^workflow:(.+)$/.exec(ref);
      if (match) {
        const wf = (await db.query("SELECT name, active, published_version FROM hannah_workflows WHERE user_id = $1 AND id = $2", [owner, match[1]])).rows[0];
        if (!wf) return result(false, "removed", "This workflow no longer exists.");
        const published = wf.published_version !== null && wf.published_version !== undefined;
        const active = Boolean(Number(wf.active));
        return { ...result(published && active, published ? (active ? "published-active" : "published-inactive") : "draft", published && active ? `“${wf.name}” is published (version ${wf.published_version}) and active.` : published ? `“${wf.name}” is published but switched off.` : `“${wf.name}” has never been published, so it isn't approved to run.`), approved: published && active };
      }
      match = /^mission:(.+)$/.exec(ref);
      if (match && robots()) {
        const mission = await robots().getMission(db, owner, match[1]);
        return result(!mission.final, mission.status, `Mission is ${mission.status}.`);
      }
    } catch (error) {
      if (error?.status === 404) return { verified: true, current: false, state: "removed", detail: "Its source record no longer exists; this entity is out of date.", checkedAt };
      return { verified: false, current: null, state: "unknown", detail: "The live source couldn't be checked just now.", checkedAt };
    }
    if (!ref) return { verified: false, current: null, state: "recorded", detail: `Entered by a person (${row.source}); there is no live source to check.`, checkedAt };
    return { verified: false, current: null, state: "recorded", detail: "Derived from records with no live state (a map or place name).", checkedAt };
  }

  // ---------------------------------------------------------------- context
  /**
   * From one entity (typically a sensor with an anomaly) to the machine it
   * belongs to or watches, the places that machine is in, the robots that
   * monitor or operate there, and the workflows approved to respond, with a
   * live check of each.
   */
  async function context(db, userId, id) {
    const scope = await scopeOf(db, userId);
    const start = await nodeRow(db, scope, id);
    const rows = new Map([[start.id, start]]);
    const load = async (ids) => {
      const missing = ids.filter((item) => !rows.has(item));
      for (const row of await nodesByIds(db, scope, missing)) rows.set(row.id, row);
      return ids.map((item) => rows.get(item)).filter(Boolean);
    };
    const out = async (ids, types) => (await edgesAround(db, scope, ids, null, types));
    const path = [];

    // 1. The equipment: the start itself if it is a machine, else what carries or is watched by it.
    let machines = [];
    if (start.type === "machine") machines = [start];
    else {
      const linked = await out([start.id], ["HAS_SENSOR", "MONITORS", "HAS_COMPONENT"]);
      const ids = linked.flatMap((edge) => {
        if (edge.type === "MONITORS" && edge.from_id === start.id) return [edge.to_id];
        if (["HAS_SENSOR", "HAS_COMPONENT"].includes(edge.type) && edge.to_id === start.id) return [edge.from_id];
        return [];
      });
      machines = (await load([...new Set(ids)])).filter((row) => ["machine", "iot_device", "robot"].includes(row.type));
      for (const edge of linked) if (machines.some((row) => row.id === edge.from_id || row.id === edge.to_id)) path.push(edge);
    }
    const anchor = machines.length ? machines : [start];

    // 2. Places: LOCATED_IN, then PART_OF, up to three hops.
    const places = [];
    let frontier = anchor.map((row) => row.id);
    for (let hop = 0; hop < 3 && frontier.length; hop += 1) {
      const edges = (await out(frontier, ["LOCATED_IN", "PART_OF"])).filter((edge) => frontier.includes(edge.from_id));
      const found = (await load([...new Set(edges.map((edge) => edge.to_id))])).filter((row) => PLACES.includes(row.type) && !places.some((place) => place.id === row.id));
      places.push(...found);
      path.push(...edges.filter((edge) => found.some((row) => row.id === edge.to_id)));
      frontier = found.map((row) => row.id);
    }

    // 3. Robots that monitor the equipment or a place, or operate in a place. A robot that carries the sensor counts too.
    const targets = [...anchor, ...places].map((row) => row.id);
    const robotEdges = (await out(targets, ["MONITORS", "OPERATES_IN", "HAS_SENSOR"])).filter((edge) => targets.includes(edge.to_id) || (edge.type === "HAS_SENSOR" && edge.to_id === start.id));
    const carried = (await out([start.id], ["HAS_SENSOR"])).filter((edge) => edge.to_id === start.id);
    const robotIds = [...new Set([...robotEdges, ...carried].map((edge) => edge.from_id))];
    const robotRows = (await load(robotIds)).filter((row) => row.type === "robot");
    path.push(...[...robotEdges, ...carried].filter((edge) => robotRows.some((row) => row.id === edge.from_id)));

    // 4. Workflows that handle or monitor the sensor, the equipment or a place.
    const handled = [start.id, ...targets];
    const workflowEdges = (await out(handled, ["HANDLES", "MONITORS"])).filter((edge) => handled.includes(edge.to_id));
    const workflowRows = (await load([...new Set(workflowEdges.map((edge) => edge.from_id))])).filter((row) => row.type === "workflow");
    path.push(...workflowEdges.filter((edge) => workflowRows.some((row) => row.id === edge.from_id)));

    const describe = async (row) => {
      const live = await verify(db, row);
      return { ...nodeView(row, scope), live, label: live.verified ? (live.current ? "current" : "not current") : "recorded" };
    };
    const startView = await describe(start);
    const machineViews = await Promise.all(machines.map(describe));
    const placeViews = await Promise.all(places.map(describe));
    const robotViews = await Promise.all(robotRows.map(describe));
    const workflowViews = await Promise.all(workflowRows.map(describe));
    const approved = workflowViews.filter((item) => item.live.approved === true);
    const summary = [
      `${startView.name} (${startView.typeLabel}) — ${startView.live.detail}`,
      machineViews.length ? `Equipment: ${machineViews.map((item) => `${item.name} [${item.label}]`).join(", ")}.` : "No machine is linked to it in the graph.",
      placeViews.length ? `Located in: ${placeViews.map((item) => item.name).join(" → ")}.` : "No location is recorded.",
      robotViews.length ? `Robots there: ${robotViews.map((item) => `${item.name} [${item.label}: ${item.live.detail}]`).join("; ")}.` : "No robot monitors or operates there.",
      workflowViews.length ? `Workflows: ${workflowViews.map((item) => `${item.name} [${item.live.approved ? "approved: published and active" : item.live.detail}]`).join("; ")}.` : "No workflow is set to handle it.",
    ];
    return {
      start: startView, machines: machineViews, places: placeViews, robots: robotViews, workflows: workflowViews, approvedWorkflows: approved.map((item) => ({ id: item.id, name: item.name, ref: item.ref })),
      path: [...new Map(path.map((edge) => [edge.id, edge])).values()].map(edgeView),
      summary: summary.join(" "),
      note: "“current” means the live source confirmed it just now. Anything else is what was last recorded, or what a person entered.",
    };
  }

  /** Find an entity by id, ref or exact name (any case). Ambiguous or unknown names are errors listing the choices. */
  async function resolve(db, userId, reference, { type } = {}) {
    const scope = await scopeOf(db, userId);
    const wanted = clean(reference, 120);
    if (!wanted) throw fail(400, "Name the entity to ask about.", "invalid");
    if (ID.test(wanted)) return nodeView(await nodeRow(db, scope, wanted), scope);
    const params = [wanted, wanted.toLowerCase()];
    let sql = `SELECT * FROM hannah_graph_nodes n WHERE (n.ref = $1 OR LOWER(n.name) = $2) AND n.valid_to IS NULL AND ${visible(scope, "n", params)}`;
    if (type && ENTITY_TYPES[type]) { params.push(type); sql += ` AND n.type = $${params.length}`; }
    const rows = (await db.query(`${sql} LIMIT 10`, params)).rows;
    if (rows.length === 1) return nodeView(rows[0], scope);
    if (rows.length > 1) throw fail(400, `“${wanted}” matches several entities: ${rows.map((row) => `${row.name} (${row.type}, ${row.id})`).join(", ")}.`, "ambiguous", { candidates: rows.map((row) => ({ id: row.id, name: row.name, type: row.type })) });
    throw fail(404, `Nothing called “${wanted}” is in your graph. Refresh it from your robots and devices, or add the entity.`, "not-found");
  }

  /** The question an agent can ask: context, neighbours or history of one entity. */
  async function ask(db, userId, { entity, question = "context", depth = 2, type } = {}) {
    const node = await resolve(db, userId, entity, { type });
    if (question === "history") return { question, ...(await history(db, userId, node.id)) };
    if (question === "neighbors") {
      const found = await traverse(db, userId, node.id, { depth });
      const names = new Map(found.nodes.map((item) => [item.id, item.name]));
      return { question, start: found.start, depth: found.depth, truncated: found.truncated, relationships: found.edges.map((edge) => `${names.get(edge.from)} —${edge.type}→ ${names.get(edge.to)}`), nodes: found.nodes.map(({ id, name, type: t, hops, source }) => ({ id, name, type: t, hops, source })), note: "These are recorded relationships. Ask for context to check which entities are live now." };
    }
    return { question: "context", ...(await context(db, userId, node.id)) };
  }

  return { ask, closeEdge, closeNode, context, createEdge, createNode, getNode, history, list, populate, resolve, schema: publicSchema, traverse, updateNode, verify };
}

module.exports = { MAX_DEPTH, MAX_NODES, createGraphService };
