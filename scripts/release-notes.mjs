#!/usr/bin/env node
/**
 * Release notes for a tag: the CHANGELOG.md section for that version, plus an
 * honest table of what was signed in this build and how to install it.
 *
 *   node scripts/release-notes.mjs v1.3.0 SIGNING_STATUS > notes.md
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+/.test(tag ?? "")) throw new Error("Usage: release-notes.mjs vMAJOR.MINOR.PATCH [SIGNING_STATUS]");
const version = tag.slice(1);

const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const start = changelog.search(new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}\\]?.*$`, "m"));
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}.`);
const rest = changelog.slice(start);
const next = rest.slice(3).search(/^## /m);
const section = (next < 0 ? rest : rest.slice(0, next + 3)).replace(/^## .*\n/, "").trim();

const statusPath = process.argv[3];
const status = Object.fromEntries(
  (statusPath && existsSync(statusPath) ? readFileSync(statusPath, "utf8") : "")
    .split("\n").filter(Boolean).map((line) => line.split("=")),
);
const signedMac = process.env.MAC_SIGNED === "true";
const signedWin = process.env.WIN_SIGNED === "true";
const gpg = process.env.GPG_SIGNED === "true";

const rows = [
  ["macOS", "`HANNAH-macOS-AppleSilicon.dmg`, `HANNAH-macOS-Intel.dmg`", signedMac ? "Signed and notarized" : "Not signed or notarized: Control-click the app, choose **Open** the first time"],
  ["Windows", "`HANNAH-Windows.exe` (installer)", signedWin ? "Code-signed" : "Not code-signed: SmartScreen may warn; choose **More info → Run anyway**"],
  ["Linux", "`HANNAH-Linux.AppImage`, `HANNAH-Linux.deb`", gpg ? "GPG signatures attached (`.asc`)" : "Verify with `SHA256SUMS`"],
  ["Android", `\`HANNAH-Android.apk\`${status.aab === "yes" ? ", `HANNAH-Android.aab`" : ""}`, status.android === "release-signed" ? "Release-signed" : "Debug-signed test build for sideloading (no Play Store listing yet)"],
  ["iOS", status.ios === "signed" ? "`HANNAH-iOS.ipa`" : "Not included", status.ios === "signed" ? "Signed for App Store Connect / TestFlight" : "Needs an Apple Developer signing identity; build from source with Xcode meanwhile"],
  ["Web", "No download", "Open the web app in any modern browser; installable as a PWA"],
];

const table = ["| Platform | Files | Signing and install |", "| --- | --- | --- |", ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");

process.stdout.write(`${section}

## Downloads

${table}

Every file is listed with its SHA-256 hash in \`SHA256SUMS\`. Check a download with \`shasum -a 256 -c SHA256SUMS --ignore-missing\` (macOS) or \`sha256sum -c SHA256SUMS --ignore-missing\` (Linux).
`);
