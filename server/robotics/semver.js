"use strict";

/**
 * Versions and version ranges for update packages and compatibility checks.
 *
 * A version is MAJOR.MINOR.PATCH with an optional -prerelease. A range is
 * one or more comparators joined by spaces (all must hold), alternatives
 * joined by "||" (one must hold):
 *
 *   1.2.3            exactly that
 *   >=1.2.0 <2.0.0   at least 1.2.0 and below 2.0.0
 *   ^1.2.0           >=1.2.0 <2.0.0   (^0.3.1 is >=0.3.1 <0.4.0)
 *   ~1.2.0           >=1.2.0 <1.3.0
 *   *                anything that is a version
 *
 * A prerelease (1.3.0-rc.1) is ordered before its release and only matches a
 * range that names a prerelease of the same MAJOR.MINOR.PATCH, so "^1.2.0"
 * does not pick up 1.3.0-rc.1 by accident.
 */
const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function parse(text) {
  const match = VERSION.exec(String(text ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split(".") : [] };
}

function comparePre(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const left = /^\d+$/.test(a[index]) ? Number(a[index]) : a[index];
    const right = /^\d+$/.test(b[index]) ? Number(b[index]) : b[index];
    if (left === right) continue;
    if (typeof left === "number" && typeof right !== "number") return -1;
    if (typeof left !== "number" && typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1; throws on something that isn't a version. */
function compare(a, b) {
  const left = typeof a === "string" ? parse(a) : a;
  const right = typeof b === "string" ? parse(b) : b;
  if (!left || !right) throw new Error(`Not a version: ${!left ? a : b}`);
  for (const key of ["major", "minor", "patch"]) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  return comparePre(left.pre, right.pre);
}

const text = (version) => `${version.major}.${version.minor}.${version.patch}${version.pre.length ? `-${version.pre.join(".")}` : ""}`;

function comparator(token) {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  const operator = match[1] || "=";
  const version = parse(match[2]);
  if (!version) return null;
  if (operator === "^") {
    const upper = version.major > 0 ? { major: version.major + 1, minor: 0, patch: 0, pre: [] } : version.minor > 0 ? { major: 0, minor: version.minor + 1, patch: 0, pre: [] } : { major: 0, minor: 0, patch: version.patch + 1, pre: [] };
    return [[">=", version], ["<", upper]];
  }
  if (operator === "~") return [[">=", version], ["<", { major: version.major, minor: version.minor + 1, patch: 0, pre: [] }]];
  return [[operator, version]];
}

/** The range as a list of alternatives, each a list of [operator, version]; null when it isn't a range. */
function parseRange(range) {
  const source = String(range ?? "").trim();
  if (!source || source.length > 200) return null;
  const alternatives = [];
  for (const part of source.split("||")) {
    const tokens = part.trim().replace(/(>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    if (tokens.length === 1 && (tokens[0] === "*" || tokens[0] === "x")) { alternatives.push([]); continue; }
    const set = [];
    for (const token of tokens) {
      const parsed = comparator(token);
      if (!parsed) return null;
      set.push(...parsed);
    }
    alternatives.push(set);
  }
  return alternatives;
}

const validRange = (range) => parseRange(range) !== null;

function holds([operator, bound], version) {
  const order = compare(version, bound);
  return operator === "=" ? order === 0 : operator === ">" ? order > 0 : operator === ">=" ? order >= 0 : operator === "<" ? order < 0 : order <= 0;
}

/** Whether a version is inside a range. Something that isn't a version is never inside one. */
function satisfies(version, range) {
  const parsed = typeof version === "string" ? parse(version) : version;
  const alternatives = parseRange(range);
  if (!parsed || !alternatives) return false;
  return alternatives.some((set) => {
    if (!set.every((item) => holds(item, parsed))) return false;
    if (!parsed.pre.length) return true;
    // A prerelease matches only when the range names a prerelease of the same release.
    return set.some(([, bound]) => bound.pre.length && bound.major === parsed.major && bound.minor === parsed.minor && bound.patch === parsed.patch);
  });
}

/** The highest version in a list that is inside the range, or null. */
function maxSatisfying(versions, range) {
  return versions.filter((version) => satisfies(version, range)).sort(compare).pop() || null;
}

module.exports = { EXACT, compare, maxSatisfying, parse, parseRange, satisfies, text, validRange };
