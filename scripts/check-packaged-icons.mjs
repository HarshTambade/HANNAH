#!/usr/bin/env node
/**
 * Packaged-app icon check: the desktop apps CI just built carry HANNAH's icon,
 * not Electron's.
 *
 *   node scripts/check-packaged-icons.mjs <electron dist directory>
 *
 * The source brand check (check-brand-assets.mjs) can pass while packaging
 * still ships the framework icon: v1.4.0's macOS app had Electron's
 * electron.icns because electron-builder wasn't pointed at HANNAH's icon yet.
 * So this looks inside what was built:
 * - macOS: every HANNAH.app names its icon in Info.plist (CFBundleIconFile),
 *   and that file is byte-identical to client/electron-assets/icons/icon.icns.
 * - Linux: the .deb's hicolor icons are byte-identical to HANNAH's PNG set.
 * - Windows: the icon is embedded in the .exe, which this script doesn't parse;
 *   it only checks that the packaged app exists. (The NSIS config is covered by
 *   check-brand-assets.mjs.)
 * Fails when it finds nothing to check, so a changed output layout can't pass silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const dist = resolve(process.argv[2] || "client/electron/dist");
const icons = resolve(import.meta.dirname, "..", "client", "electron-assets", "icons");
const problems = [];
let checked = 0;
let found = 0;

if (!existsSync(dist)) {
  console.error(`No packaged output at ${dist}.`);
  process.exit(1);
}

const walk = (dir, depth = 0) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  if (name.endsWith(".app")) return [path];
  return depth < 3 ? walk(path, depth + 1) : [];
});
const files = walk(dist);
const same = (a, b) => readFileSync(a).equals(readFileSync(b));

// macOS
for (const app of files.filter((path) => basename(path) === "HANNAH.app")) {
  found += 1;
  const plist = join(app, "Contents", "Info.plist");
  const xml = process.platform === "darwin" ? execFileSync("plutil", ["-convert", "xml1", "-o", "-", plist], { encoding: "utf8" }) : readFileSync(plist, "utf8");
  const name = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1];
  if (!name) { problems.push(`${app}: Info.plist names no icon.`); continue; }
  const file = join(app, "Contents", "Resources", name.endsWith(".icns") ? name : `${name}.icns`);
  if (!existsSync(file)) problems.push(`${app}: the icon ${name} named in Info.plist isn't in Resources.`);
  else if (!same(file, join(icons, "icon.icns"))) problems.push(`${app}: ${basename(file)} isn't HANNAH's icon (client/electron-assets/icons/icon.icns).`);
  else checked += 1;
}

// Linux
for (const deb of files.filter((path) => path.endsWith(".deb"))) {
  found += 1;
  const out = mkdtempSync(join(tmpdir(), "hannah-deb-"));
  try {
    execFileSync("dpkg-deb", ["-x", deb, out]);
  } catch {
    problems.push(`${deb}: couldn't unpack it (is dpkg-deb installed?).`);
    continue;
  }
  const hicolor = join(out, "usr", "share", "icons", "hicolor");
  const sizes = existsSync(hicolor) ? readdirSync(hicolor) : [];
  if (!sizes.length) { problems.push(`${deb}: has no hicolor icons.`); continue; }
  for (const size of sizes) {
    const own = join(icons, "png", `${size}.png`);
    const apps = join(hicolor, size, "apps");
    for (const icon of existsSync(apps) ? readdirSync(apps) : []) {
      if (!existsSync(own)) problems.push(`${deb}: ${size}/${icon} has no HANNAH icon of that size to match.`);
      else if (!same(join(apps, icon), own)) problems.push(`${deb}: ${size}/${icon} isn't HANNAH's icon.`);
      else checked += 1;
    }
  }
}

// Windows
const exe = files.find((path) => /win-unpacked[\\/]HANNAH\.exe$/.test(path));
if (exe) console.log(`Windows: ${exe} exists (its embedded icon isn't parsed here).`);

if (!found && !exe) problems.push(`No HANNAH.app or .deb found under ${dist} to check.`);
if (problems.length) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`Packaged icons: ${checked === 1 ? "1 icon file is" : `${checked} icon files are`} HANNAH's own.`);
