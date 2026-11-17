#!/usr/bin/env node
/**
 * Dependency audit gate. Runs `npm audit --json` in a package folder and
 * fails on any high or critical advisory, exactly like `npm audit
 * --audit-level=high`, except advisories recorded in .audit-exceptions.json
 * with a reason and an expiry date. An expired exception fails the build, so
 * nothing stays accepted silently.
 *
 *   node scripts/audit-gate.mjs <package-dir> [--level high|critical|moderate] [--omit-dev]
 *
 * .audit-exceptions.json (repository root):
 * [{ "advisory": "GHSA-…", "package": "picomatch", "scope": "client/electron",
 *    "reason": "…", "exposure": "…", "expires": "2027-01-31" }]
 *
 * An exception covers an advisory in the named scope only. Packages that are
 * vulnerable only because they depend on an excepted package (npm lists them
 * "via" it) are covered too; anything with its own advisory is not.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const dir = resolve(process.cwd(), args.find((arg) => !arg.startsWith("--")) ?? ".");
const levelIndex = args.indexOf("--level");
const level = levelIndex >= 0 ? args[levelIndex + 1] : "high";
const omitDev = args.includes("--omit-dev");
const ORDER = ["info", "low", "moderate", "high", "critical"];
const threshold = ORDER.indexOf(level);
if (threshold < 0) throw new Error(`Unknown level ${level}`);
const scope = relative(root, dir) || ".";
const today = new Date().toISOString().slice(0, 10);

const exceptions = existsSync(resolve(root, ".audit-exceptions.json")) ? JSON.parse(readFileSync(resolve(root, ".audit-exceptions.json"), "utf8")) : [];
const problems = [];
for (const entry of exceptions) {
  for (const field of ["advisory", "package", "scope", "reason", "exposure", "expires"]) if (!entry[field]) problems.push(`An exception for ${entry.advisory ?? "?"} is missing "${field}".`);
  if (entry.scope === scope && entry.expires < today) problems.push(`The exception for ${entry.advisory} (${entry.package}) expired on ${entry.expires}. Fix it, or review and extend it with a new reason.`);
}

let report;
try {
  const args = ["audit", "--json", ...(omitDev ? ["--omit=dev"] : [])];
  const options = { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  // On Windows npm is npm.cmd, which Node only starts through a shell. The arguments are fixed words, so the command line is safe.
  const output = process.platform === "win32" ? execSync(`npm ${args.join(" ")}`, options) : execFileSync("npm", args, options);
  report = JSON.parse(output);
} catch (error) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  try {
    report = JSON.parse(error.stdout?.toString?.() ?? "");
  } catch {
    console.error(`npm audit didn't produce a report in ${scope}: ${error.stderr?.toString?.().trim() || error.message}`);
    process.exit(2);
  }
}
if (report.error) {
  console.error(`npm audit failed in ${scope}: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

const vulnerabilities = report.vulnerabilities ?? {};
const active = exceptions.filter((entry) => entry.scope === scope && entry.expires >= today);
const exceptedAdvisory = (via) => typeof via === "object" && active.some((entry) => via.url?.endsWith(entry.advisory) && via.name === entry.package);

/** Is this package's finding entirely explained by excepted advisories (directly or through other packages)? */
function covered(name, seen = new Set()) {
  if (seen.has(name)) return true;
  seen.add(name);
  const entry = vulnerabilities[name];
  if (!entry) return true;
  return entry.via.every((via) => (typeof via === "string" ? covered(via, seen) : exceptedAdvisory(via)));
}

const blocking = [];
const accepted = [];
for (const [name, entry] of Object.entries(vulnerabilities)) {
  if (ORDER.indexOf(entry.severity) < threshold) continue;
  const advisories = entry.via.filter((via) => typeof via === "object").map((via) => `${via.url?.split("/").pop()} ${via.title}`);
  const line = `${entry.severity.padEnd(8)} ${name}${entry.isDirect ? " (direct)" : ""} ${entry.range}${advisories.length ? ` — ${advisories.join("; ")}` : ` — via ${entry.via.filter((via) => typeof via === "string").join(", ")}`}`;
  (covered(name) ? accepted : blocking).push(line);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(`Audit of ${scope}${omitDev ? " (production only)" : ""}: ${counts.total ?? 0} finding(s) — ${ORDER.slice().reverse().map((key) => `${counts[key] ?? 0} ${key}`).join(", ")}.`);
for (const line of accepted) console.log(`  accepted (see .audit-exceptions.json): ${line}`);
for (const problem of problems) console.error(`  ${problem}`);
if (blocking.length) {
  console.error(`${blocking.length} finding(s) at or above "${level}" without an exception:`);
  for (const line of blocking) console.error(`  ${line}`);
}
if (blocking.length || problems.length) process.exit(1);
console.log(`No unexcepted findings at or above "${level}".`);
