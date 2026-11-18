#!/usr/bin/env node
/**
 * Build HANNAH's macOS control helper (native/macos-control/HannahControl.swift)
 * as one universal binary (Apple silicon and Intel), for the desktop app.
 *
 *   node scripts/build-macos-control.mjs [output path]
 *
 * Default output: electron/assets/hannah-control. electron-builder keeps it
 * outside app.asar (asarUnpack) and signs it with the app, so macOS attributes
 * its Accessibility permission to HANNAH. Needs Xcode's command-line tools.
 * On other systems it does nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] || join(clientRoot, "electron", "assets", "hannah-control"));
const source = join(clientRoot, "native", "macos-control", "HannahControl.swift");

if (process.platform !== "darwin") {
  console.log("Not macOS: the control helper isn't built here.");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "hannah-control-"));
try {
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slice = join(work, `hannah-control-${arch}`);
    execFileSync("xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macos12`, source, "-o", slice], { stdio: "inherit" });
    slices.push(slice);
  }
  mkdirSync(dirname(output), { recursive: true });
  execFileSync("lipo", ["-create", ...slices, "-output", output], { stdio: "inherit" });
  const archs = execFileSync("lipo", ["-archs", output], { encoding: "utf8" }).trim();
  console.log(`Built ${output} (${archs}).`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
