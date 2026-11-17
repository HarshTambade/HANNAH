#!/usr/bin/env node
/**
 * Native permission audit: every permission the Android and iOS apps declare
 * must be listed, with its reason, in docs/NATIVE_PERMISSIONS.json. A new
 * permission fails CI until someone writes down why HANNAH needs it; a listed
 * permission that's no longer declared is reported so the list stays true.
 *
 * Checked: Android <uses-permission> in the app manifest, iOS NS*UsageDescription
 * keys and UIBackgroundModes in Info.plist. Permissions that Capacitor plugins
 * merge in at build time aren't in these files; docs/PLATFORM_SUPPORT.md lists them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expected = JSON.parse(readFileSync(resolve(root, "docs/NATIVE_PERMISSIONS.json"), "utf8"));

const manifest = readFileSync(resolve(root, "client/android/app/src/main/AndroidManifest.xml"), "utf8");
const android = [...manifest.matchAll(/<uses-permission(?:-sdk-23)?\s+android:name="([^"]+)"/g)].map((match) => match[1]);

const plist = readFileSync(resolve(root, "client/ios/App/App/Info.plist"), "utf8");
const ios = [...plist.matchAll(/<key>(NS[A-Za-z]+UsageDescription)<\/key>\s*<string>([^<]*)<\/string>/g)].map((match) => ({ key: match[1], text: match[2].trim() }));
const backgroundModes = /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "";
const modes = [...backgroundModes.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);

const problems = [];
const stale = [];
for (const name of android) if (!expected.android[name]) problems.push(`Android declares ${name}, which isn't in docs/NATIVE_PERMISSIONS.json.`);
for (const name of Object.keys(expected.android)) if (!android.includes(name)) stale.push(`docs/NATIVE_PERMISSIONS.json lists Android ${name}, which the manifest no longer declares.`);
for (const { key, text } of ios) {
  if (!expected.ios[key]) problems.push(`iOS declares ${key}, which isn't in docs/NATIVE_PERMISSIONS.json.`);
  else if (text.length < 40) problems.push(`iOS ${key} has a one-line reason ("${text}"); App Review expects a full sentence.`);
}
for (const key of Object.keys(expected.ios)) if (!ios.some((item) => item.key === key)) stale.push(`docs/NATIVE_PERMISSIONS.json lists iOS ${key}, which Info.plist no longer declares.`);
for (const mode of modes) if (!expected.iosBackgroundModes?.[mode]) problems.push(`iOS declares the background mode "${mode}", which isn't in docs/NATIVE_PERMISSIONS.json.`);
for (const mode of Object.keys(expected.iosBackgroundModes ?? {})) if (!modes.includes(mode)) stale.push(`docs/NATIVE_PERMISSIONS.json lists the iOS background mode "${mode}", which Info.plist no longer declares.`);

for (const line of stale) console.log(`note: ${line}`);
if (problems.length) {
  console.error("Native permission audit failed:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Native permission audit: ${android.length} Android permissions, ${ios.length} iOS usage descriptions and ${modes.length} background modes, all documented.`);
