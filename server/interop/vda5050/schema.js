"use strict";

/**
 * Validation against the published VDA 5050 2.0.0 JSON schemas (schemas/2.0.0).
 *
 * A small validator for the keywords those files use: type (one or a list),
 * required, properties, items, enum, minimum, maximum and local $ref
 * ("#/definitions/…"). "format" is not enforced except date-time, which is
 * checked as ISO 8601. Unknown properties are allowed, as the schemas allow
 * them. See schemas/NOTICE.md for the two defects in the published files and
 * how they are handled here.
 */
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "schemas", "2.0.0");
const FILES = { order: "order.schema", instantActions: "instantActions.schema", state: "state.schema", connection: "connection.schema", factsheet: "factsheet.json" };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function load(topic) {
  const schema = JSON.parse(fs.readFileSync(path.join(DIR, FILES[topic]), "utf8"));
  if (topic === "factsheet" && !schema.properties) {
    // Defect 1: the published factsheet lists its field schemas at the top level.
    const reserved = new Set(["$schema", "title", "description", "required", "subtopic", "type"]);
    schema.properties = Object.fromEntries(Object.entries(schema).filter(([key, value]) => !reserved.has(key) && value && typeof value === "object" && !Array.isArray(value)));
  }
  return schema;
}
const SCHEMAS = Object.fromEntries(Object.keys(FILES).map((topic) => [topic, load(topic)]));

const typeOf = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value);
const matchesType = (wanted, value) => {
  const actual = typeOf(value);
  return wanted === actual || (wanted === "number" && actual === "integer");
};

function check(schema, value, at, root, problems) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((node, key) => node?.[key], root);
    return check(target, value, at, root, problems);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) { problems.push(`${at} must be ${types.join(" or ")}`); return; }
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at} must be ≤ ${schema.maximum}`);
  }
  if (schema.format === "date-time" && typeof value === "string" && !ISO.test(value)) problems.push(`${at} must be an ISO 8601 date-time`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const name of schema.required || []) if (value[name] === undefined) problems.push(`${at}.${name} is required`);
    for (const [name, child] of Object.entries(schema.properties || {})) if (value[name] !== undefined) check(child, value[name], `${at}.${name}`, root, problems);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => check(schema.items, item, `${at}[${index}]`, root, problems));
}

/** Problems with a message on `topic` (order, instantActions, state, connection, factsheet). None means valid. */
function validate(topic, message) {
  const schema = SCHEMAS[topic];
  if (!schema) return [`no schema for ${topic}`];
  const problems = [];
  check(schema, message, topic, schema, problems);
  return problems;
}

module.exports = { SCHEMAS, validate };
