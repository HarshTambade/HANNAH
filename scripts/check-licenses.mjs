#!/usr/bin/env node
/**
 * Licence check for everything that ships: the production dependencies of the
 * root, client and server packages. Fails on a copyleft licence HANNAH's
 * MIT distribution can't carry, and on a dependency with no licence
 * statement. Weak-copyleft licences (MPL, LGPL) pass with a note, because
 * they only cover their own files.
 *
 *   node scripts/check-licenses.mjs            check all three packages
 *   node scripts/check-licenses.mjs --report   also print every package
 *
 * Exceptions live in .licenses-allow.json: { "<package>@<version>": "<reason>" }.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const report = process.argv.includes("--report");
const PACKAGES = [".", "client", "server"];

const ALLOWED = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear", "0BSD", "Apache-2.0", "Unlicense", "CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "Python-2.0", "BlueOak-1.0.0", "Zlib", "W3C-20150513", "W3C", "Artistic-2.0", "PSF-2.0", "MIT-0", "WTFPL", "BSL-1.0", "ODC-By-1.0", "OFL-1.1", "Ruby", "MIT*", "(MIT OR CC0-1.0)", "(MIT OR Apache-2.0)", "(Apache-2.0 OR MIT)", "(BSD-2-Clause OR MIT OR Apache-2.0)", "(MIT OR GPL-3.0)", "(MIT OR GPL-2.0)", "(MIT AND Zlib)", "(MIT AND BSD-3-Clause)", "(BSD-3-Clause OR GPL-2.0)", "(WTFPL OR MIT)", "(MPL-2.0 OR Apache-2.0)", "(AFL-2.1 OR BSD-3-Clause)", "(Apache-2.0 AND MIT)", "(MIT OR WTFPL)", "Apache 2.0", "Apache-2.0 WITH LLVM-exception", "LGPL-3.0-or-later", "LGPL-2.1-or-later", "LGPL-2.1", "LGPL-3.0", "MPL-2.0", "EPL-2.0", "CC-BY-SA-4.0"]);
const WEAK_COPYLEFT = /^(?:LGPL|MPL|EPL|CC-BY-SA)/;
const COPYLEFT = /^(?:AGPL|GPL|SSPL|EUPL|OSL|CPAL|RPL)/;

/**
 * Is this SPDX expression acceptable? "A OR B" passes when any side does
 * (we take that side); "A AND B" only when every side does.
 */
function evaluate(expression) {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/ OR /.test(text)) return text.split(/ OR /).some((part) => evaluate(part).ok) ? { ok: true } : { ok: false, why: "no side of the OR is permissive" };
  if (/ AND /.test(text)) {
    const parts = text.split(/ AND /).map(evaluate);
    return parts.every((part) => part.ok) ? { ok: true, weak: parts.some((part) => part.weak) } : { ok: false, why: "one side of the AND isn't permissive" };
  }
  const id = text.replace(/\s+WITH .*$/, "");
  if (COPYLEFT.test(id)) return { ok: false, why: `${id} is a copyleft licence HANNAH's MIT distribution can't carry` };
  if (WEAK_COPYLEFT.test(id)) return { ok: true, weak: true };
  if (ALLOWED.has(id) || ALLOWED.has(text)) return { ok: true };
  return { ok: false, why: `${id} isn't on the allowed list; review it, then add it to ALLOWED or .licenses-allow.json` };
}

/** The LICENSE file, for packages that state nothing in package.json. */
function licenseFromFile(path) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "License.md"]) {
    try {
      const head = readFileSync(resolve(path, name), "utf8").slice(0, 600);
      if (/MIT License|Permission is hereby granted, free of charge/i.test(head)) return "MIT";
      if (/Apache License/i.test(head)) return "Apache-2.0";
      if (/BSD/i.test(head) && /Redistribution and use/i.test(head)) return "BSD-3-Clause";
      if (/ISC/i.test(head) && /Permission to use, copy, modify/i.test(head)) return "ISC";
    } catch {
      // Try the next name.
    }
  }
  return "";
}

const exceptions = existsSync(resolve(root, ".licenses-allow.json")) ? JSON.parse(readFileSync(resolve(root, ".licenses-allow.json"), "utf8")) : {};

function licenseOf(path) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
    if (typeof manifest.license === "string") return manifest.license.trim();
    if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type.trim();
    if (Array.isArray(manifest.licenses) && manifest.licenses.length) return `(${manifest.licenses.map((item) => item.type ?? item).join(" OR ")})`;
  } catch {
    // Missing manifest: reported below.
  }
  return "";
}

function walk(node, seen, out, parent) {
  for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
    if (!child || typeof child !== "object") continue;
    const key = `${name}@${child.version ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (child.path) out.push({ key, name, version: child.version ?? "?", path: child.path, parent });
    walk(child, seen, out, name);
  }
}

const problems = [];
const notes = [];
let total = 0;
for (const pkg of PACKAGES) {
  const cwd = resolve(root, pkg);
  let tree;
  try {
    const json = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    tree = JSON.parse(json);
  } catch (error) {
    // npm ls exits non-zero on peer warnings but still prints the tree.
    const stdout = error.stdout?.toString?.() ?? "";
    try {
      tree = JSON.parse(stdout);
    } catch {
      console.error(`Couldn't read the dependency tree of ${pkg}: run npm ci there first.`);
      process.exit(2);
    }
  }
  const deps = [];
  walk(tree, new Set(), deps, pkg);
  total += deps.length;
  for (const dep of deps) {
    // The repository's own workspaces aren't third-party code (npm lists them through their node_modules symlink).
    let real = dep.path;
    try { real = realpathSync(dep.path); } catch { /* keep the listed path */ }
    if (real === cwd || !real.includes("node_modules")) continue;
    const stated = licenseOf(dep.path);
    const license = stated || licenseFromFile(dep.path);
    const label = `${pkg}: ${dep.key}`;
    if (report) console.log(`${label}  ${license || "(none)"}${!stated && license ? " (from its LICENSE file)" : ""}`);
    if (exceptions[dep.key]) { notes.push(`${label}: ${license || "(none)"} allowed: ${exceptions[dep.key]}`); continue; }
    if (!license || /^UNLICENSED$/i.test(license)) { problems.push(`${label} states no licence.`); continue; }
    const verdict = evaluate(license);
    if (!verdict.ok) { problems.push(`${label} uses ${license}: ${verdict.why}.`); continue; }
    if (verdict.weak) notes.push(`${label} is ${license} (weak copyleft: its own files only).`);
  }
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  console.error(`Licence check: ${problems.length} problem${problems.length === 1 ? "" : "s"} across ${total} production dependencies.`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Licence check: ${total} production dependencies, all permissive${notes.length ? ` (${notes.length} noted)` : ""}.`);
