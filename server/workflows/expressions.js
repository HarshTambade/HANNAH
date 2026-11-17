"use strict";

/**
 * Workflow expressions: `{{ $json.amount > 1000 }}`, `{{ $node["Extract"].json.vendor }}`.
 *
 * A small language parsed and interpreted here, never passed to eval or
 * Function. It can read data and call a fixed list of pure functions; it
 * can't assign, loop, reach prototypes, call methods on values, or touch the
 * process. Evaluation has a step budget, so a pathological expression ends
 * with an error instead of hanging the worker.
 *
 * Grammar (precedence low to high):
 *   ternary   a ? b : c
 *   or/and    || &&  (also ?? for "default when null")
 *   equality  == != === !==
 *   compare   < <= > >=
 *   additive  + -
 *   multiply  * / %
 *   unary     ! -
 *   postfix   .name  [expr]  fn(args)   (calls only on whitelisted names)
 *   primary   numbers, 'strings', "strings", true false null, [arrays], (groups), $variables, function names
 *
 * Scope: $json (the current item), $items (all input items), $node["Name"]
 * (.json = its first output item, .items = all), $trigger, $now, $today,
 * $execution { id, mode }, $workflow { id, name }, $index.
 */

const MAX_STEPS = 20_000;
const MAX_LENGTH = 4_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);

class ExpressionError extends Error {
  constructor(message, expression) {
    super(message);
    this.name = "ExpressionError";
    this.expression = expression;
  }
}

// ---------- tokenizer ----------

const PUNCT = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "??", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", ".", ",", "(", ")", "[", "]"];

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      tokens.push({ type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (char === "'" || char === '"') {
      let value = "";
      let cursor = index + 1;
      for (; cursor < source.length && source[cursor] !== char; cursor += 1) {
        if (source[cursor] === "\\") {
          const next = source[cursor + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next ?? "";
          cursor += 1;
        } else value += source[cursor];
      }
      if (source[cursor] !== char) throw new ExpressionError("A string isn't closed.", source);
      tokens.push({ type: "string", value });
      index = cursor + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      tokens.push({ type: "name", value: match[0] });
      index += match[0].length;
      continue;
    }
    const punct = PUNCT.find((item) => source.startsWith(item, index));
    if (!punct) throw new ExpressionError(`Unexpected character “${char}”.`, source);
    tokens.push({ type: "punct", value: punct });
    index += punct.length;
  }
  tokens.push({ type: "end" });
  return tokens;
}

// ---------- parser ----------

function parse(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const isPunct = (value) => peek().type === "punct" && peek().value === value;
  const expect = (value) => {
    if (!isPunct(value)) throw new ExpressionError(`Expected “${value}”.`, source);
    position += 1;
  };

  function primary() {
    const token = next();
    if (token.type === "number" || token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "name") {
      if (token.value === "true") return { kind: "literal", value: true };
      if (token.value === "false") return { kind: "literal", value: false };
      if (token.value === "null") return { kind: "literal", value: null };
      if (token.value === "undefined") return { kind: "literal", value: undefined };
      return { kind: "name", name: token.value };
    }
    if (token.type === "punct" && token.value === "(") {
      const inner = ternary();
      expect(")");
      return inner;
    }
    if (token.type === "punct" && token.value === "[") {
      const items = [];
      if (!isPunct("]")) {
        do items.push(ternary()); while (isPunct(",") && next());
      }
      expect("]");
      return { kind: "array", items };
    }
    throw new ExpressionError(token.type === "end" ? "The expression ends too early." : `Unexpected “${token.value}”.`, source);
  }

  function postfix() {
    let node = primary();
    for (;;) {
      if (isPunct(".")) {
        next();
        const name = next();
        if (name.type !== "name") throw new ExpressionError("Expected a field name after “.”.", source);
        node = { kind: "member", object: node, property: { kind: "literal", value: name.value } };
      } else if (isPunct("[")) {
        next();
        const property = ternary();
        expect("]");
        node = { kind: "member", object: node, property };
      } else if (isPunct("(")) {
        if (node.kind !== "name") throw new ExpressionError("Only the built-in functions can be called.", source);
        next();
        const args = [];
        if (!isPunct(")")) {
          do args.push(ternary()); while (isPunct(",") && next());
        }
        expect(")");
        node = { kind: "call", name: node.name, args };
      } else return node;
    }
  }

  function unary() {
    if (isPunct("!")) { next(); return { kind: "unary", op: "!", argument: unary() }; }
    if (isPunct("-")) { next(); return { kind: "unary", op: "-", argument: unary() }; }
    return postfix();
  }

  const binary = (ops, lower) => () => {
    let left = lower();
    while (peek().type === "punct" && ops.includes(peek().value)) {
      const op = next().value;
      left = { kind: "binary", op, left, right: lower() };
    }
    return left;
  };
  const multiply = binary(["*", "/", "%"], unary);
  const additive = binary(["+", "-"], multiply);
  const compare = binary(["<", "<=", ">", ">="], additive);
  const equality = binary(["==", "!=", "===", "!=="], compare);
  const and = binary(["&&"], equality);
  const or = binary(["||", "??"], and);

  function ternary() {
    const test = or();
    if (!isPunct("?")) return test;
    next();
    const consequent = ternary();
    expect(":");
    return { kind: "conditional", test, consequent, alternate: ternary() };
  }

  const tree = ternary();
  if (peek().type !== "end") throw new ExpressionError(`Unexpected “${peek().value}” after the expression.`, source);
  return tree;
}

// ---------- functions ----------

const toNumber = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const cleaned = value.replace(/[,\s]/g, "").replace(/^[^0-9.+-]+/, "");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return NaN;
};
const toText = (value) => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
const toDate = (value) => {
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new ExpressionError(`“${toText(value)}” isn't a date.`);
  return date;
};

const FUNCTIONS = {
  lower: (value) => toText(value).toLowerCase(),
  upper: (value) => toText(value).toUpperCase(),
  trim: (value) => toText(value).trim(),
  len: (value) => (Array.isArray(value) || typeof value === "string" ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0),
  number: toNumber,
  string: toText,
  boolean: (value) => Boolean(value) && value !== "false" && value !== "0",
  round: (value, places = 0) => { const factor = 10 ** Math.max(0, Math.min(10, toNumber(places) || 0)); return Math.round(toNumber(value) * factor) / factor; },
  floor: (value) => Math.floor(toNumber(value)),
  ceil: (value) => Math.ceil(toNumber(value)),
  abs: (value) => Math.abs(toNumber(value)),
  min: (...values) => Math.min(...values.flat().map(toNumber)),
  max: (...values) => Math.max(...values.flat().map(toNumber)),
  sum: (values) => (Array.isArray(values) ? values.reduce((total, value) => total + (toNumber(value) || 0), 0) : toNumber(values)),
  json: (value) => JSON.stringify(value ?? null),
  parseJson: (value) => { try { return JSON.parse(toText(value)); } catch { throw new ExpressionError("parseJson got text that isn't JSON."); } },
  contains: (haystack, needle) => (Array.isArray(haystack) ? haystack.includes(needle) : toText(haystack).toLowerCase().includes(toText(needle).toLowerCase())),
  startsWith: (value, prefix) => toText(value).startsWith(toText(prefix)),
  endsWith: (value, suffix) => toText(value).endsWith(toText(suffix)),
  replace: (value, search, replacement) => toText(value).split(toText(search)).join(toText(replacement)),
  split: (value, separator = ",") => toText(value).split(toText(separator)),
  join: (values, separator = ", ") => (Array.isArray(values) ? values.map(toText).join(toText(separator)) : toText(values)),
  slice: (value, start = 0, end) => (Array.isArray(value) || typeof value === "string" ? value.slice(toNumber(start), end === undefined ? undefined : toNumber(end)) : value),
  first: (values) => (Array.isArray(values) ? values[0] : values),
  last: (values) => (Array.isArray(values) ? values[values.length - 1] : values),
  keys: (value) => (value && typeof value === "object" ? Object.keys(value) : []),
  values: (value) => (value && typeof value === "object" ? Object.values(value) : []),
  pluck: (values, field) => (Array.isArray(values) ? values.map((value) => (value && typeof value === "object" ? value[toText(field)] : undefined)) : []),
  default: (value, fallback) => (value === null || value === undefined || value === "" ? fallback : value),
  isEmpty: (value) => value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length),
  now: () => new Date().toISOString(),
  date: (value) => toDate(value).toISOString(),
  dateOnly: (value) => toDate(value).toISOString().slice(0, 10),
  addDays: (value, days) => new Date(toDate(value).getTime() + toNumber(days) * 86_400_000).toISOString(),
  addHours: (value, hours) => new Date(toDate(value).getTime() + toNumber(hours) * 3_600_000).toISOString(),
  daysBetween: (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000),
  matches: (value, pattern) => {
    const text = toText(pattern);
    if (text.length > 200) throw new ExpressionError("A pattern can be up to 200 characters.");
    return new RegExp(text, "i").test(toText(value).slice(0, 20_000));
  },
};

// ---------- evaluator ----------

function readMember(object, key, source) {
  if (object === null || object === undefined) return undefined;
  const name = typeof key === "number" ? key : toText(key);
  if (FORBIDDEN_KEYS.has(String(name))) throw new ExpressionError(`“${name}” can't be read.`, source);
  if (typeof object === "string") return name === "length" ? object.length : /^\d+$/.test(String(name)) ? object[Number(name)] : undefined;
  if (Array.isArray(object)) {
    if (name === "length") return object.length;
    const index = typeof name === "number" ? name : /^-?\d+$/.test(name) ? Number(name) : NaN;
    if (Number.isNaN(index)) return undefined;
    return object[index < 0 ? object.length + index : index];
  }
  if (typeof object === "object") return Object.prototype.hasOwnProperty.call(object, name) ? object[name] : undefined;
  return undefined;
}

function evaluateTree(tree, scope, source) {
  let steps = 0;
  const visit = (node) => {
    steps += 1;
    if (steps > MAX_STEPS) throw new ExpressionError("The expression took too many steps.", source);
    switch (node.kind) {
      case "literal": return node.value;
      case "array": return node.items.map(visit);
      case "name": {
        if (Object.prototype.hasOwnProperty.call(scope, node.name)) return scope[node.name];
        if (FUNCTIONS[node.name]) throw new ExpressionError(`${node.name} is a function; call it like ${node.name}(…).`, source);
        throw new ExpressionError(`Unknown name “${node.name}”. Fields of the current item are under $json, for example $json.${node.name}.`, source);
      }
      case "member": return readMember(visit(node.object), visit(node.property), source);
      case "call": {
        const fn = FUNCTIONS[node.name] ?? (node.name === "$node" ? (name) => scope.$node?.[toText(name)] : null);
        if (!fn) throw new ExpressionError(`Unknown function “${node.name}”.`, source);
        return fn(...node.args.map(visit));
      }
      case "unary": {
        const value = visit(node.argument);
        return node.op === "!" ? !value : -toNumber(value);
      }
      case "conditional": return visit(node.test) ? visit(node.consequent) : visit(node.alternate);
      case "binary": {
        if (node.op === "&&") { const left = visit(node.left); return left ? visit(node.right) : left; }
        if (node.op === "||") { const left = visit(node.left); return left ? left : visit(node.right); }
        if (node.op === "??") { const left = visit(node.left); return left === null || left === undefined ? visit(node.right) : left; }
        const left = visit(node.left);
        const right = visit(node.right);
        switch (node.op) {
          case "+": return typeof left === "string" || typeof right === "string" ? toText(left) + toText(right) : toNumber(left) + toNumber(right);
          case "-": return toNumber(left) - toNumber(right);
          case "*": return toNumber(left) * toNumber(right);
          case "/": return toNumber(left) / toNumber(right);
          case "%": return toNumber(left) % toNumber(right);
          // == compares loosely across numbers and numeric text ("1000" == 1000), never objects by coercion.
          case "==": return looseEqual(left, right);
          case "!=": return !looseEqual(left, right);
          case "===": return left === right;
          case "!==": return left !== right;
          case "<": return compareValues(left, right) < 0;
          case "<=": return compareValues(left, right) <= 0;
          case ">": return compareValues(left, right) > 0;
          case ">=": return compareValues(left, right) >= 0;
          default: throw new ExpressionError(`Unknown operator ${node.op}.`, source);
        }
      }
      default: throw new ExpressionError("Unknown expression.", source);
    }
  };
  return visit(tree);
}

function looseEqual(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return (left ?? null) === (right ?? null);
  if (typeof left === "number" || typeof right === "number") return toNumber(left) === toNumber(right);
  if (typeof left === "boolean" || typeof right === "boolean") return String(left) === String(right);
  return toText(left) === toText(right);
}

function compareValues(left, right) {
  const a = toNumber(left);
  const b = toNumber(right);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a - b;
  return toText(left).localeCompare(toText(right));
}

const cache = new Map();
function compile(source) {
  if (source.length > MAX_LENGTH) throw new ExpressionError(`An expression can be up to ${MAX_LENGTH} characters.`, source);
  let tree = cache.get(source);
  if (!tree) {
    tree = parse(source);
    if (cache.size > 2000) cache.clear();
    cache.set(source, tree);
  }
  return tree;
}

const TEMPLATE = /\{\{([\s\S]*?)\}\}/g;

/** Whether a value contains an expression. */
function hasExpression(value) {
  return typeof value === "string" && value.includes("{{");
}

/**
 * Resolve one parameter value. A string that is exactly one `{{ … }}` keeps
 * the expression's type (a number stays a number); mixed text interpolates.
 * Objects and arrays are resolved recursively.
 */
function resolveValue(value, scope) {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const whole = /^\{\{([\s\S]*)\}\}$/.exec(value.trim());
    if (whole && !whole[1].includes("{{")) return evaluate(whole[1], scope);
    return value.replace(TEMPLATE, (_, expression) => toText(evaluate(expression, scope)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]));
  return value;
}

function evaluate(expression, scope) {
  const source = String(expression).trim();
  if (!source) return "";
  return evaluateTree(compile(source), scope, source);
}

/** Syntax-check every expression inside a value; returns error messages (empty when fine). */
function checkExpressions(value) {
  const errors = [];
  const walk = (item) => {
    if (typeof item === "string" && item.includes("{{")) {
      const opened = (item.match(/\{\{/g) || []).length;
      const closed = (item.match(/\}\}/g) || []).length;
      if (opened !== closed) { errors.push(`“${item.slice(0, 60)}” has unbalanced {{ }}.`); return; }
      for (const [, expression] of item.matchAll(TEMPLATE)) {
        try {
          compile(expression.trim());
        } catch (error) {
          errors.push(`${error.message} In “{{${expression.slice(0, 80)}}}”.`);
        }
      }
    } else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === "object") Object.values(item).forEach(walk);
  };
  walk(value);
  return errors;
}

module.exports = { ExpressionError, FUNCTIONS, checkExpressions, evaluate, hasExpression, resolveValue, toNumber, toText };
