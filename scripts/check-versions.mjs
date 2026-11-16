#!/usr/bin/env node
/**
 * Fail if HANNAH's version differs anywhere it ships from, and (on a tag
 * build) if the tag doesn't match it. Run in CI before any build.
 *
 *   node scripts/check-versions.mjs              compare the version files
 *   node scripts/check-versions.mjs --tag v1.3.0 also require this tag
 *
 * client/package.json is the source of truth. The Electron app takes its
 * version from it (client/scripts/prepare-electron-release.mjs), Android and
 * iOS from client/scripts/sync-native-versions.mjs, and the website's
 * version label from the build (__HANNAH_APP_VERSION__).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const version = read("client/package.json").version;
const problems = [];

for (const path of ["package.json", "server/package.json"]) {
  const other = read(path).version;
  if (other !== version) problems.push(`${path} is ${other}; client/package.json is ${version}.`);
}
for (const path of ["package-lock.json", "client/package-lock.json", "server/package-lock.json"]) {
  const lock = read(path);
  if (lock.version !== version || lock.packages?.[""]?.version !== version) problems.push(`${path} records ${lock.version}; run npm install to refresh it.`);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`Version "${version}" is not MAJOR.MINOR.PATCH.`);

const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?`, "m").test(changelog)) problems.push(`CHANGELOG.md has no "## ${version}" section.`);

const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex > 0 ? process.argv[tagIndex + 1] : "";
if (tag && tag !== `v${version}`) problems.push(`Tag ${tag} does not match the app version v${version}.`);

try {
  execFileSync(process.execPath, [resolve(root, "client/scripts/sync-native-versions.mjs"), "--check"], { stdio: "pipe" });
} catch (error) {
  problems.push(String(error.stderr || error.message).trim());
}

if (problems.length) {
  console.error("Version check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`All HANNAH version fields are ${version}${tag ? ` and match ${tag}` : ""}.`);
