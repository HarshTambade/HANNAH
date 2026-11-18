"use strict";

/**
 * Workflow engine: validation, planning and execution. Pure logic: storage,
 * credentials and side effects come in through `services`, so the same engine
 * runs in the worker, in tests and in "test this node" from the editor.
 *
 * Execution model
 * - A workflow is a directed acyclic graph. The run starts at one trigger node
 *   and visits nodes in topological order. Each node gets the items its
 *   upstream nodes produced on the connected output ports; a node that
 *   receives no items is skipped (that's how If/Switch branches work), and so
 *   is everything after it.
 * - After every node the state (finished nodes and their outputs) is
 *   checkpointed. A run that stops (a wait, an approval, a worker restart)
 *   continues from the checkpoint: finished nodes never run again, so
 *   external effects happen at most once per node unless the node itself was
 *   interrupted mid-call (at-least-once for that node; HTTP nodes can send an
 *   Idempotency-Key).
 * - Each node has retries with exponential backoff and jitter, and a timeout.
 *   The workflow has an overall time limit. Cancellation is checked before
 *   every node and between items.
 * - A failed node fails the run, unless the node is set to "continue on
 *   error"; then the error becomes its output and the run is marked as
 *   completed with errors. Nothing is ever reported as succeeded when it
 *   didn't.
 */
const { Cron } = require("croner");
const { ExpressionError, checkExpressions, resolveValue } = require("./expressions");
const { REGISTRY, outputsOf } = require("./nodes");

const FORMAT = "hannah-workflow";
const VERSION = 2;
const LIMITS = {
  nodes: 100,
  connections: 300,
  itemsPerNode: 5000,
  stateBytes: 4 * 1024 * 1024,
  nodeTimeoutMs: { default: 60_000, max: 5 * 60_000 },
  workflowTimeoutMs: { default: 15 * 60_000, max: 60 * 60_000 },
  retries: { max: 5 },
};
/** Waiting out an AI provider's rate limit (see execute). */
const RATE_LIMIT = { waits: 12, windowMs: 30 * 60_000, firstMs: 10_000, maxMs: 5 * 60_000, inlineMs: 20_000 };

/** How long to wait before rate-limit try `wait` (1-based): the provider's Retry-After, or 10 s doubling, with jitter so parallel runs don't all return at once. */
function rateLimitDelay(error, wait, random = Math.random) {
  const base = Number(error?.retryAfterMs) > 0 ? Number(error.retryAfterMs) : RATE_LIMIT.firstMs * 2 ** (wait - 1);
  return Math.round(Math.min(RATE_LIMIT.maxMs, Math.max(1000, base)) * (1 + random() * 0.25));
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- validation ----------

/** Whether a parameter applies, given the others (its showIf); `params` already has defaults filled in. */
function visible(param, params) {
  if (!param.showIf) return true;
  return Object.entries(param.showIf).every(([key, expected]) => (Array.isArray(expected) ? expected.includes(params?.[key]) : params?.[key] === expected));
}

/** Parameters with defaults filled in. */
function withDefaults(definition, params = {}) {
  const out = {};
  for (const param of definition.params) out[param.name] = Object.prototype.hasOwnProperty.call(params, param.name) ? params[param.name] : param.default;
  return out;
}

function checkSchedule(params) {
  const mode = params.mode;
  if (mode === "interval") {
    const minutes = Number(params.minutes);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10080) return "Repeat every 5 to 10,080 minutes.";
  } else if (mode === "daily" || mode === "weekly") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(params.time))) return "The time must look like 08:00.";
    if (mode === "weekly" && (!Array.isArray(params.days) || !params.days.length || params.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) return "Pick at least one day.";
  } else if (mode === "cron") {
    try {
      const fields = String(params.cron || "").trim().split(/\s+/);
      if (fields.length !== 5) return "A cron expression has 5 fields: minute hour day-of-month month day-of-week.";
      new Cron(params.cron, { paused: true }).stop();
      if (fields[0] === "*" || /^\*\/[1-4]$/.test(fields[0])) return "Schedules can run at most every 5 minutes.";
    } catch (error) {
      return `The cron expression isn't valid: ${error.message}`;
    }
  } else return "Choose how often it repeats.";
  return null;
}

/** The cron pattern a schedule trigger's parameters mean. */
function cronFor(params) {
  if (params.mode === "cron") return String(params.cron).trim();
  if (params.mode === "daily" || params.mode === "weekly") {
    const [hour, minute] = String(params.time).split(":").map(Number);
    const days = params.mode === "weekly" ? [...new Set(params.days)].sort().join(",") : "*";
    return `${minute} ${hour} * * ${days}`;
  }
  return null;
}

/** Next time a schedule trigger fires after `after` (ms), in the workflow's time zone. */
function nextScheduledRun(params, timezone, after) {
  if (params.mode === "interval") return after + Math.max(5, Number(params.minutes)) * 60_000;
  const cron = new Cron(cronFor(params), { timezone: timezone || "UTC", paused: true });
  const next = cron.nextRun(new Date(after));
  cron.stop();
  return next ? next.getTime() : null;
}

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a workflow. Returns { errors, warnings }, each [{ nodeId?, field?, message }].
 * `credentials` maps credential id → type for the owner, so missing or wrong
 * credentials are caught before activation.
 */
function validateWorkflow(definition, { credentials = new Map() } = {}) {
  const errors = [];
  const warnings = [];
  const error = (message, nodeId, field) => errors.push({ ...(nodeId ? { nodeId } : {}), ...(field ? { field } : {}), message });
  const warn = (message, nodeId) => warnings.push({ ...(nodeId ? { nodeId } : {}), message });

  if (!definition || typeof definition !== "object") return { errors: [{ message: "The workflow is empty." }], warnings };
  if (definition.format !== FORMAT || definition.version !== VERSION) error(`This isn't a HANNAH workflow (format ${FORMAT}, version ${VERSION}).`);
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  const connections = Array.isArray(definition.connections) ? definition.connections : [];
  if (!nodes.length) error("Add a trigger to start the workflow.");
  if (nodes.length > LIMITS.nodes) error(`A workflow can have up to ${LIMITS.nodes} nodes.`);
  if (connections.length > LIMITS.connections) error(`A workflow can have up to ${LIMITS.connections} connections.`);
  const settings = definition.settings || {};
  if (settings.timezone && !validTimezone(settings.timezone)) error(`“${settings.timezone}” isn't a time zone.`);
  if (settings.timeoutMs !== undefined && (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs < 10_000 || settings.timeoutMs > LIMITS.workflowTimeoutMs.max)) error("The workflow time limit must be between 10 seconds and 60 minutes.");

  const byId = new Map();
  const names = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== "object" || !ID.test(String(node.id))) { error("Every node needs an id of letters, digits, - or _."); continue; }
    if (byId.has(node.id)) error(`Two nodes share the id ${node.id}.`, node.id);
    byId.set(node.id, node);
    const name = String(node.name || "").trim();
    if (!name) error("Give this node a name.", node.id, "name");
    else if (names.has(name.toLowerCase())) error(`Two nodes are called “${name}”; names must be unique so expressions can refer to them.`, node.id, "name");
    names.add(name.toLowerCase());
    const definitionOf = REGISTRY.get(node.type);
    if (!definitionOf) { error(`Unknown node type “${node.type}”.`, node.id); continue; }
    if (definitionOf.status === "upcoming") error(`“${definitionOf.label}” isn't available yet.`, node.id);
    if (node.disabled) continue;
    const params = withDefaults(definitionOf, node.params);
    for (const param of definitionOf.params) {
      if (!visible(param, params)) continue;
      const value = params[param.name];
      const empty = value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
      if (param.required && empty) { error(`${param.label} is required.`, node.id, param.name); continue; }
      if (empty) continue;
      if (param.type === "select" && !(typeof value === "string" && value.includes("{{")) && !param.options.some((option) => option.value === value)) error(`${param.label}: “${value}” isn't one of the choices.`, node.id, param.name);
      if (param.type === "number" && !(typeof value === "string" && value.includes("{{"))) {
        const number = Number(value);
        if (!Number.isFinite(number)) error(`${param.label} must be a number.`, node.id, param.name);
        else if ((param.min !== undefined && number < param.min) || (param.max !== undefined && number > param.max)) error(`${param.label} must be between ${param.min ?? "−∞"} and ${param.max ?? "∞"}.`, node.id, param.name);
      }
      if (param.pattern && typeof value === "string" && !value.includes("{{") && !new RegExp(param.pattern).test(value)) error(`${param.label} isn't in the expected format.`, node.id, param.name);
      for (const message of checkExpressions(value)) error(`${param.label}: ${message}`, node.id, param.name);
    }
    if (node.type === "trigger.schedule") {
      const problem = checkSchedule(params);
      if (problem) error(problem, node.id);
    }
    if (definitionOf.credential) {
      if (!node.credentialId) {
        if (definitionOf.credential.required) error(`Choose a ${definitionOf.credential.types.map((type) => type).join(" or ")} credential.`, node.id, "credential");
      } else if (!credentials.has(node.credentialId)) error("The chosen credential doesn't exist any more. Choose another.", node.id, "credential");
      else if (!definitionOf.credential.types.includes(credentials.get(node.credentialId))) error(`This node needs a ${definitionOf.credential.types.join(" or ")} credential.`, node.id, "credential");
    }
    const nodeSettings = node.settings || {};
    if (nodeSettings.retries !== undefined && (!Number.isInteger(nodeSettings.retries) || nodeSettings.retries < 0 || nodeSettings.retries > LIMITS.retries.max)) error(`Retries must be 0 to ${LIMITS.retries.max}.`, node.id, "retries");
    if (nodeSettings.timeoutMs !== undefined && (!Number.isFinite(nodeSettings.timeoutMs) || nodeSettings.timeoutMs < 1000 || nodeSettings.timeoutMs > LIMITS.nodeTimeoutMs.max)) error("A node's time limit must be between 1 second and 5 minutes.", node.id, "timeoutMs");
  }

  const triggers = nodes.filter((node) => REGISTRY.get(node.type)?.category === "trigger" && !node.disabled);
  if (nodes.length && !triggers.length) error("Add a trigger: Manual, Schedule, Webhook or HANNAH event.");

  const incoming = new Map();
  const outgoing = new Map();
  const seen = new Set();
  for (const connection of connections) {
    const source = byId.get(connection?.source);
    const target = byId.get(connection?.target);
    if (!source || !target) { error("A connection points to a node that doesn't exist."); continue; }
    const sourceDefinition = REGISTRY.get(source.type);
    const targetDefinition = REGISTRY.get(target.type);
    if (!sourceDefinition || !targetDefinition) continue;
    const sourceOutput = connection.sourceOutput || "main";
    const targetInput = connection.targetInput || "main";
    if (!outputsOf(sourceDefinition, withDefaults(sourceDefinition, source.params)).includes(sourceOutput)) error(`“${source.name}” has no output called ${sourceOutput}.`, source.id);
    if (!targetDefinition.inputs.length) error(`“${target.name}” is a trigger and can't have incoming connections.`, target.id);
    else if (!targetDefinition.inputs.includes(targetInput)) error(`“${target.name}” has no input called ${targetInput}.`, target.id);
    if (source.id === target.id) error(`“${source.name}” is connected to itself.`, source.id);
    const key = `${source.id}:${sourceOutput}>${target.id}:${targetInput}`;
    if (seen.has(key)) warn(`“${source.name}” is connected to “${target.name}” twice.`, source.id);
    seen.add(key);
    outgoing.set(source.id, [...(outgoing.get(source.id) || []), target.id]);
    incoming.set(target.id, [...(incoming.get(target.id) || []), source.id]);
  }

  // Cycles: workflows are acyclic (loops are item-based, through Split into items).
  const order = topologicalOrder(nodes.map((node) => node.id), connections.filter((connection) => byId.has(connection?.source) && byId.has(connection?.target)));
  if (!order) error("The connections form a loop. Workflows run in one direction; to repeat steps per entry, use “Split into items”.");

  // Nodes no trigger reaches never run.
  const reachable = new Set();
  const queue = triggers.map((node) => node.id);
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of outgoing.get(id) || []) queue.push(next);
  }
  for (const node of nodes) {
    if (reachable.has(node.id) || node.disabled) continue;
    const definitionOf = REGISTRY.get(node.type);
    if (definitionOf && definitionOf.category !== "trigger") warn(`“${node.name}” isn't connected to a trigger, so it never runs.`, node.id);
  }
  for (const node of nodes) {
    const definitionOf = REGISTRY.get(node.type);
    if (definitionOf?.type === "logic.merge" && new Set((connections || []).filter((connection) => connection.target === node.id).map((connection) => connection.targetInput || "main")).size < 2) warn(`“${node.name}” merges two inputs but only one is connected.`, node.id);
  }
  return { errors, warnings };
}

function topologicalOrder(ids, connections) {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map();
  for (const connection of connections) {
    indegree.set(connection.target, (indegree.get(connection.target) || 0) + 1);
    outgoing.set(connection.source, [...(outgoing.get(connection.source) || []), connection.target]);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  return order.length === ids.length ? order : null;
}

/** What a workflow is allowed to do, for the activation review. Stable order, so it can be hashed. */
function permissionManifest(definition) {
  const permissions = new Map();
  for (const node of definition.nodes || []) {
    if (node.disabled) continue;
    const definitionOf = REGISTRY.get(node.type);
    if (!definitionOf) continue;
    const own = definitionOf.permissionsFor ? definitionOf.permissionsFor(withDefaults(definitionOf, node.params)) : definitionOf.permissions;
    for (const permission of own) permissions.set(permission, [...(permissions.get(permission) || []), node.name]);
    if (node.type === "action.email" && withDefaults(definitionOf, node.params).mode === "send" && withDefaults(definitionOf, node.params).approval === "on-activation") permissions.set("send-email-without-asking", [...(permissions.get("send-email-without-asking") || []), node.name]);
  }
  return [...permissions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([permission, nodes]) => ({ permission, nodes: [...new Set(nodes)].sort() }));
}

// ---------- execution ----------

class NodeFailure extends Error {
  constructor(message, { nodeId, nodeName, cause, attempts } = {}) {
    super(message);
    this.name = "NodeFailure";
    this.nodeId = nodeId;
    this.nodeName = nodeName;
    this.cause = cause;
    this.attempts = attempts;
  }
}

class CancelledError extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "CancelledError";
  }
}

const SENSITIVE_KEY = /authorization|password|passwd|secret|token|api[-_]?key|cookie|set-cookie|private[-_]?key|connectionstring/i;
// Token counts (an AI step's usage: promptTokens, total_tokens, maxTokens …) are numbers, not secrets.
const TOKEN_COUNT_KEY = /^(prompt|completion|total|input|output|max|reasoning|cached)[-_]?tokens?$|tokens$/i;
const masked = (key, item) => SENSITIVE_KEY.test(key) && !(TOKEN_COUNT_KEY.test(key) && typeof item === "number");

/** A copy that's safe to show: secret-looking keys masked, long text and lists cut. */
function sanitize(value, depth = 0) {
  const { looksSecret } = require("./nodes");
  if (depth > 8) return "[…]";
  if (typeof value === "string") return looksSecret(value) ? "[redacted]" : value.length > 4000 ? `${value.slice(0, 4000)}… (${value.length} characters)` : value;
  if (Array.isArray(value)) return value.length > 50 ? [...value.slice(0, 50).map((item) => sanitize(item, depth + 1)), `… ${value.length - 50} more`] : value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, masked(key, item) ? "[redacted]" : sanitize(item, depth + 1)]));
  return value;
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new CancelledError()); }, { once: true });
});

function normalizeOutputs(result, ports, nodeName) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`“${nodeName}” returned no output.`);
  const out = {};
  for (const [port, items] of Object.entries(result)) {
    if (!ports.includes(port)) continue;
    if (!Array.isArray(items)) throw new Error(`“${nodeName}” returned an invalid ${port} output.`);
    if (items.length > LIMITS.itemsPerNode) throw new Error(`“${nodeName}” produced ${items.length} items; the limit is ${LIMITS.itemsPerNode}. Use Limit or Aggregate.`);
    out[port] = items.map((item) => (item && typeof item === "object" && item.json && typeof item.json === "object" ? { json: item.json } : { json: { value: item } }));
  }
  for (const port of ports) out[port] = out[port] || [];
  return out;
}

function permanent(error) {
  return error instanceof ExpressionError || error?.code === "request-blocked" || error?.retryable === false || error?.name === "CancelledError" || error?.permanent;
}

/**
 * Run (or continue) an execution.
 *
 * input: { definition, execution: { id, mode, triggerNodeId, triggerData, state, startedAt }, workflow: { id, name, timezone },
 *          services, now, signal (AbortSignal for cancel), onCheckpoint(state, event), resume?: { nodeId, approved?, data? },
 *          inlineWaitMs? (longest rate-limit wait done in place; longer ones park the run),
 *          shouldPause? (async; true stops the run before the next step as a "paused" wait),
 *          shouldYield? (true hands the run back before the next step that hasn't started, as "queued", for
 *          hosting where one call has a time budget: serverless functions are stopped at their limit) }
 * returns { status: completed | failed | waiting | waiting-approval | cancelled | timed-out | queued, state, error?, errorNode?, waiting?, warnings }
 *
 * The workflow's time limit counts active time across calls (state.activeMs), not
 * time spent waiting between them, so yielding or recovering doesn't reset it.
 *
 * Rate limits. An AI provider that is rate-limiting (an error with
 * `rateLimited`) doesn't fail the step: the engine waits for the provider's
 * Retry-After (or a growing delay) and tries again, for up to 30 minutes and
 * 12 tries (RATE_LIMIT), separately from the step's own retries. Short waits happen in place;
 * longer ones park the run as a timed wait, which survives restarts and, on
 * serverless hosting, is woken by the next tick.
 */
async function execute({ definition, execution, workflow, services, now = () => Date.now(), signal, onCheckpoint = async () => {}, resume, sleep = delay, inlineWaitMs = RATE_LIMIT.inlineMs, shouldPause = async () => false, shouldYield = () => false }) {
  const nodes = (definition.nodes || []).filter((node) => REGISTRY.has(node.type));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const connections = (definition.connections || []).filter((connection) => byId.has(connection.source) && byId.has(connection.target));
  const order = topologicalOrder(nodes.map((node) => node.id), connections);
  if (!order) throw new Error("The workflow's connections form a loop.");
  const state = execution.state && typeof execution.state === "object" ? execution.state : { nodes: {} };
  state.nodes = state.nodes || {};
  const timeoutMs = Math.min(LIMITS.workflowTimeoutMs.max, Number(definition.settings?.timeoutMs) || LIMITS.workflowTimeoutMs.default);
  const activeBefore = Math.max(0, Number(state.activeMs) || 0);
  const startedAt = now();
  const deadline = startedAt + timeoutMs - activeBefore;
  const activeNow = () => activeBefore + Math.max(0, now() - startedAt);
  const save = onCheckpoint;
  onCheckpoint = (checkpointState, event) => { checkpointState.activeMs = activeNow(); return save(checkpointState, event); };
  let warnings = 0;
  let started = 0;

  const isCancelled = () => Boolean(signal?.aborted);
  const throwIfCancelled = () => { if (isCancelled()) throw new CancelledError(signal.reason?.message || "Cancelled."); };

  const nodeScope = () => {
    const scope = {};
    for (const [id, result] of Object.entries(state.nodes)) {
      const node = byId.get(id);
      if (!node || !result.outputs) continue;
      const items = Object.values(result.outputs).flat().map((item) => item.json);
      scope[node.name] = { json: items[0] ?? {}, items };
    }
    return scope;
  };
  const triggerItem = () => {
    const result = state.nodes[execution.triggerNodeId];
    return result?.outputs ? Object.values(result.outputs).flat()[0]?.json ?? {} : execution.triggerData ?? {};
  };

  if (resume) {
    const result = state.nodes[resume.nodeId];
    if (!result || result.status !== "waiting") throw new Error("This run isn't waiting at that step.");
    result.resumed = { approved: resume.approved, data: resume.data ?? null, at: now() };
  }

  for (const id of order) {
    const node = byId.get(id);
    const definitionOf = REGISTRY.get(node.type);
    const previous = state.nodes[id];
    if (previous && ["done", "skipped", "failed-continued", "denied"].includes(previous.status)) continue;
    throwIfCancelled();
    if (now() > deadline) return { status: "timed-out", state, error: `The workflow ran past its ${Math.round(timeoutMs / 60_000)}-minute limit.`, errorNode: id, warnings };
    // Paused by the person: stop before this step. Resuming runs it from the start (finished steps never run again).
    if (previous?.status !== "waiting" && await shouldPause()) {
      const waiting = { kind: "paused", retry: true, message: `Paused by you before “${node.name}”. Resume to continue from here.` };
      state.nodes[id] = { status: "waiting", waiting, at: now() };
      await onCheckpoint(state, { nodeId: id, status: "waiting" });
      return { status: "waiting", state, waiting: { nodeId: id, ...waiting }, warnings };
    }
    // Out of time for this call: hand the run back before a step that hasn't started. At least one step runs per call.
    if (!previous && started > 0 && shouldYield()) {
      state.activeMs = activeNow();
      return { status: "queued", state, warnings };
    }
    started += 1;

    // Gather this node's input items.
    const isStart = id === execution.triggerNodeId;
    const inputs = {};
    for (const port of definitionOf.inputs) inputs[port] = [];
    for (const connection of connections.filter((item) => item.target === id)) {
      const upstream = state.nodes[connection.source];
      const items = upstream?.outputs?.[connection.sourceOutput || "main"] || [];
      inputs[connection.targetInput || "main"] = [...(inputs[connection.targetInput || "main"] || []), ...items];
    }
    const total = Object.values(inputs).reduce((sum, items) => sum + items.length, 0);
    // A step that may run on nothing (Aggregate set to continue) runs when a step before it ran and produced no items at all.
    // A branch not taken stays skipped: when If or Switch sent the items down another output, this step doesn't run.
    const producedNothing = (source) => ["done", "failed-continued"].includes(state.nodes[source]?.status) && Object.values(state.nodes[source].outputs || {}).every((items) => !items.length);
    const runsEmpty = total === 0 && definitionOf.category !== "trigger" && Boolean(definitionOf.runsOnEmpty?.(withDefaults(definitionOf, node.params)))
      && connections.some((connection) => connection.target === id && producedNothing(connection.source));
    if (definitionOf.category === "trigger" ? !isStart : total === 0 && !runsEmpty) {
      state.nodes[id] = { status: "skipped", reason: definitionOf.category === "trigger" ? "Another trigger started this run." : "No items reached this step.", at: now() };
      await onCheckpoint(state, { nodeId: id, status: "skipped" });
      continue;
    }
    const items = inputs.main || [];

    if (node.disabled) {
      const firstOutput = outputsOf(definitionOf, withDefaults(definitionOf, node.params))[0] || "main";
      state.nodes[id] = { status: "done", disabled: true, outputs: { [firstOutput]: items }, at: now() };
      await onCheckpoint(state, { nodeId: id, status: "done" });
      continue;
    }

    const params = withDefaults(definitionOf, node.params);
    const ports = outputsOf(definitionOf, params);
    const settings = node.settings || {};
    const retries = Math.max(0, Math.min(LIMITS.retries.max, Number.isInteger(settings.retries) ? settings.retries : 0));
    const retryDelayMs = Math.max(500, Math.min(60_000, Number(settings.retryDelayMs) || 2000));
    const nodeTimeout = Math.max(1000, Math.min(LIMITS.nodeTimeoutMs.max, Number(settings.timeoutMs) || LIMITS.nodeTimeoutMs.default));

    const scopeFor = (index, sourceItems = items) => ({
      $json: sourceItems[index]?.json ?? {},
      $items: sourceItems.map((item) => item.json),
      $index: index,
      $node: nodeScope(),
      $trigger: triggerItem(),
      $now: new Date(now()).toISOString(),
      $today: new Date(now()).toISOString().slice(0, 10),
      $execution: { id: execution.id, mode: execution.mode },
      $workflow: { id: workflow.id, name: workflow.name },
    });
    const resolve = (index) => resolveValue(params, scopeFor(index));
    const resolveOnce = () => resolveValue(params, scopeFor(0));

    // Per-run approval gate for sensitive steps (for example sending an email).
    const resumed = previous?.status === "waiting" ? previous.resumed : null;
    if (definitionOf.approvalFor && !previous?.gateApproved) {
      const reason = definitionOf.approvalFor(params);
      if (reason) {
        if (resumed && previous.gate) {
          if (!resumed.approved) {
            state.nodes[id] = { ...previous, status: "denied", finishedAt: now(), error: `You denied “${reason}”.` };
            await onCheckpoint(state, { nodeId: id, status: "denied" });
            return { status: "cancelled", state, error: `You denied “${reason}” at “${node.name}”.`, errorNode: id, warnings };
          }
          state.nodes[id] = { status: "pending", gateApproved: true };
        } else {
          let preview;
          try {
            preview = sanitize(resolveOnce());
          } catch (error) {
            preview = { error: error.message };
          }
          state.nodes[id] = { status: "waiting", gate: true, waiting: { kind: "approval", message: `${reason}: “${node.name}”`, details: preview, until: now() + 24 * 3_600_000 }, at: now() };
          await onCheckpoint(state, { nodeId: id, status: "waiting" });
          return { status: "waiting-approval", state, waiting: { nodeId: id, ...state.nodes[id].waiting }, warnings };
        }
      }
    }

    const credential = node.credentialId ? await services.credential(node.credentialId) : null;
    if (definitionOf.credential?.required && !credential) {
      const failure = new NodeFailure(`“${node.name}” needs a credential, and the chosen one is missing.`, { nodeId: id, nodeName: node.name, attempts: 0 });
      state.nodes[id] = { status: "failed", error: failure.message, attempts: 0, at: now() };
      await onCheckpoint(state, { nodeId: id, status: "failed" });
      return { status: "failed", state, error: failure.message, errorNode: id, warnings };
    }

    const startedAt = now();
    state.nodes[id] = { ...(state.nodes[id] || {}), status: "running", startedAt, attempts: 0, inputCount: total };
    await onCheckpoint(state, { nodeId: id, status: "running", input: items });

    let lastError = null;
    let result = null;
    let parkUntil = null;
    // A step parked for a rate limit runs again from the start, not as a resumed wait.
    const retryingAfterPark = Boolean(previous?.waiting?.retry);
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      state.nodes[id].attempts = attempt;
      const controller = new AbortController();
      const forwardCancel = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", forwardCancel, { once: true });
      const remaining = deadline - now();
      const limit = Math.max(1000, Math.min(nodeTimeout, remaining));
      const timer = setTimeout(() => controller.abort(Object.assign(new Error(`“${node.name}” didn't finish within ${Math.round(limit / 1000)} seconds.`), { code: "timeout" })), limit);
      try {
        const ctx = {
          node: { ...node, params }, params, items, inputs, credential, services, signal: controller.signal, timeoutMs: limit,
          execution: { id: execution.id, mode: execution.mode }, workflow, triggerData: isStart ? execution.triggerData : undefined,
          // How many webhook hops led to this run (see the HTTP step's X-Hannah-Hops header).
          hops: Math.max(0, Number(execution.triggerData?.$hops) || 0),
          resumed: resumed && !previous?.gate && !retryingAfterPark ? resumed : null, now, resolve, resolveOnce, scopeFor, throwIfCancelled: () => { if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new CancelledError(); },
        };
        result = await Promise.race([
          definitionOf.execute(ctx),
          new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new CancelledError()), { once: true })),
        ]);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (isCancelled()) break;
        if (error?.rateLimited) {
          const waits = (state.nodes[id].rateLimitWaits || 0) + 1;
          const since = state.nodes[id].rateLimitedSince ?? now();
          const waitMs = rateLimitDelay(error, waits);
          // Keep trying for up to RATE_LIMIT.windowMs from the first refusal (and at most RATE_LIMIT.waits times).
          if (waits <= RATE_LIMIT.waits && now() + waitMs - since <= RATE_LIMIT.windowMs) {
            state.nodes[id].rateLimitWaits = waits;
            state.nodes[id].rateLimitedSince = since;
            state.nodes[id].lastError = error.message;
            if (waitMs <= inlineWaitMs && now() + waitMs < deadline) {
              await onCheckpoint(state, { nodeId: id, status: "retrying", error: error.message, attempt });
              await sleep(waitMs, signal);
              attempt -= 1; // a rate limit doesn't use up the step's own retries
              continue;
            }
            parkUntil = now() + waitMs;
            lastError = null;
            break;
          }
          const minutes = Math.max(1, Math.round((now() - since) / 60_000));
          lastError = Object.assign(new Error(`${error.message} HANNAH kept trying for ${minutes} minute${minutes === 1 ? "" : "s"} (${waits} tries). Free plans allow only a few requests or tokens a minute or day: run this less often, send less text, or save another provider's key so Auto can use it.`), { rateLimited: true });
          break;
        }
        if (permanent(error) || attempt > retries) break;
        const backoff = Math.min(60_000, retryDelayMs * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);
        state.nodes[id].lastError = error.message;
        await onCheckpoint(state, { nodeId: id, status: "retrying", error: error.message, attempt });
        await sleep(backoff, signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardCancel);
      }
    }

    if (isCancelled()) {
      state.nodes[id] = { ...state.nodes[id], status: "cancelled", finishedAt: now() };
      await onCheckpoint(state, { nodeId: id, status: "cancelled" });
      return { status: "cancelled", state, error: signal.reason?.message || "Cancelled.", errorNode: id, warnings };
    }

    if (parkUntil !== null) {
      const waiting = { kind: "time", until: parkUntil, retry: true, message: `“${node.name}”: ${state.nodes[id].lastError} HANNAH waits and tries again (for up to ${Math.round(RATE_LIMIT.windowMs / 60_000)} minutes).` };
      state.nodes[id] = { ...state.nodes[id], status: "waiting", waiting, resumed: undefined };
      await onCheckpoint(state, { nodeId: id, status: "waiting" });
      return { status: "waiting", state, waiting: { nodeId: id, ...waiting }, warnings };
    }

    if (lastError) {
      const message = lastError.message || String(lastError);
      if (settings.continueOnFail) {
        warnings += 1;
        state.nodes[id] = { ...state.nodes[id], status: "failed-continued", error: message, finishedAt: now(), outputs: { [ports[0]]: [{ json: { error: message, node: node.name } }] } };
        await onCheckpoint(state, { nodeId: id, status: "failed-continued", error: message });
        continue;
      }
      const failedLogs = Array.isArray(lastError.logs) && lastError.logs.length ? { logs: lastError.logs.slice(0, 50).map((line) => String(line).slice(0, 2000)) } : {};
      state.nodes[id] = { ...state.nodes[id], status: "failed", error: message, finishedAt: now(), ...failedLogs };
      await onCheckpoint(state, { nodeId: id, status: "failed", error: message });
      const timedOut = lastError.code === "timeout";
      return { status: "failed", state, error: `${node.name}: ${message}${state.nodes[id].attempts > 1 ? ` (after ${state.nodes[id].attempts} attempts)` : ""}`, errorNode: id, warnings, timedOut };
    }

    if (result && result.wait) {
      const waiting = { ...result.wait };
      state.nodes[id] = { ...state.nodes[id], status: "waiting", waiting };
      await onCheckpoint(state, { nodeId: id, status: "waiting" });
      return { status: waiting.kind === "approval" ? "waiting-approval" : "waiting", state, waiting: { nodeId: id, ...waiting }, warnings };
    }

    const outputs = normalizeOutputs(result, ports, node.name);
    // A node may also return logs (the Code step's console output), kept with its result.
    const logs = Array.isArray(result?.logs) ? result.logs.slice(0, 50).map((line) => String(line).slice(0, 2000)) : undefined;
    state.nodes[id] = { ...state.nodes[id], status: "done", finishedAt: now(), outputs, ...(logs?.length ? { logs } : {}), resumed: undefined, waiting: undefined };
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > LIMITS.stateBytes) {
      state.nodes[id] = { ...state.nodes[id], status: "failed", outputs: undefined, error: "The data passed between steps grew past 4 MB. Use Limit, Aggregate or Map fields to keep only what you need." };
      await onCheckpoint(state, { nodeId: id, status: "failed" });
      return { status: "failed", state, error: `${node.name}: ${state.nodes[id].error}`, errorNode: id, warnings };
    }
    await onCheckpoint(state, { nodeId: id, status: "done", output: outputs });
  }
  return { status: "completed", state, warnings, ...(warnings ? { error: `${warnings} step${warnings === 1 ? "" : "s"} failed and continued.` } : {}) };
}

/** Run one node on its own (editor “Test step”), with given input items. */
async function executeSingleNode({ node, items = [{ json: {} }], workflow, services, now = () => Date.now() }) {
  const definitionOf = REGISTRY.get(node.type);
  if (!definitionOf) throw new Error(`Unknown node type “${node.type}”.`);
  const execution = { id: `test-${Date.now().toString(36)}`, mode: "test", triggerNodeId: definitionOf.category === "trigger" ? node.id : "__input" };
  const definition = definitionOf.category === "trigger"
    ? { nodes: [{ ...node, settings: { ...node.settings, retries: 0 } }], connections: [] }
    : { nodes: [{ id: "__input", name: "__input", type: "trigger.manual", params: {} }, { ...node, settings: { ...node.settings, retries: 0 } }], connections: [{ source: "__input", target: node.id, sourceOutput: "main", targetInput: definitionOf.inputs[0] }] };
  const state = definitionOf.category === "trigger" ? { nodes: {} } : { nodes: { __input: { status: "done", outputs: { main: items } } } };
  const result = await execute({ definition, execution: { ...execution, state }, workflow, services, now });
  const own = result.state.nodes[node.id] || {};
  return { status: own.status, outputs: own.outputs, error: own.error || result.error, waiting: result.waiting };
}

module.exports = { FORMAT, LIMITS, VERSION, CancelledError, cronFor, execute, executeSingleNode, nextScheduledRun, permissionManifest, sanitize, topologicalOrder, validateWorkflow, withDefaults };
