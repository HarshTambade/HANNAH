#!/usr/bin/env node
/**
 * Copy the app version from client/package.json into the native projects, so
 * every platform ships the same version:
 *
 *   Android  versionName = 1.3.0      versionCode = 10300
 *   iOS      MARKETING_VERSION = 1.3.0  CURRENT_PROJECT_VERSION = 10300
 *
 * The build number is MAJOR*10000 + MINOR*100 + PATCH. It only ever grows
 * while MINOR and PATCH stay below 100, which Google Play (versionCode) and
 * App Store Connect (CFBundleVersion) both require.
 *
 *   node scripts/sync-native-versions.mjs          write the versions
 *   node scripts/sync-native-versions.mjs --check  fail if any differ
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(resolve(clientRoot, "package.json"), "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match) throw new Error(`client/package.json version "${version}" must be MAJOR.MINOR.PATCH for native builds.`);
const [major, minor, patch] = match.slice(1).map(Number);
if (minor > 99 || patch > 99) throw new Error("MINOR and PATCH must be below 100 to keep build numbers increasing.");
export const buildNumber = major * 10000 + minor * 100 + patch;

const checkOnly = process.argv.includes("--check");
const problems = [];

function update(path, replacements) {
  if (!existsSync(path)) return;
  const original = readFileSync(path, "utf8");
  let next = original;
  for (const [pattern, replacement, label] of replacements) {
    if (!pattern.test(next)) problems.push(`${label} not found in ${path}`);
    next = next.replace(pattern, replacement);
  }
  if (next === original) return;
  if (checkOnly) problems.push(`${path} is not at version ${version} (${buildNumber}). Run: node client/scripts/sync-native-versions.mjs`);
  else writeFileSync(path, next);
}

update(resolve(clientRoot, "android/app/build.gradle"), [
  [/versionCode \d+/, `versionCode ${buildNumber}`, "versionCode"],
  [/versionName "[^"]*"/, `versionName "${version}"`, "versionName"],
]);
update(resolve(clientRoot, "ios/App/App.xcodeproj/project.pbxproj"), [
  [/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`, "MARKETING_VERSION"],
  [/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`, "CURRENT_PROJECT_VERSION"],
]);

if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`${checkOnly ? "Native versions match" : "Native versions set to"} ${version} (build ${buildNumber}).`);
