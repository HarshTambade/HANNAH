#!/usr/bin/env node
/**
 * Brand check: every platform ships HANNAH's own icon, never a framework default.
 * Runs in CI without rendering anything.
 *
 *   node scripts/check-brand-assets.mjs
 *
 * Checks
 * - Desktop: electron-builder.yml names an icon for macOS, Windows and Linux (and the NSIS
 *   installer), the files exist, the .icns has the 1024 and 512 images and the .ico a 256 one,
 *   and the prepare script copies them (plus the window icon) into the packaged app.
 * - Android: legacy, round, adaptive foreground and monochrome PNGs at every density with the
 *   right pixel sizes; the adaptive icon declares background, foreground and monochrome.
 * - iOS: the app icon is 1024 x 1024 and opaque (the App Store refuses alpha).
 * - Web: favicon.ico (16/32/48), a maskable PWA icon in the manifest, the favicon linked.
 * - No tracked file is byte-identical to a known default icon (Capacitor's launcher and app
 *   icons that this project used to ship, and Electron's electron.icns).
 * Regenerate the assets with: node client/scripts/generate-brand-assets.mjs
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = (path) => resolve(root, "client", path);
const problems = [];
const fail = (message) => problems.push(message);

/** Width, height and colour type of a PNG, from its IHDR chunk. */
function png(path) {
  const data = readFileSync(path);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} isn't a PNG.`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data[25] };
}

const DEFAULT_ICONS = new Set([
  "0166fc333074c373fbd0ce6b5defd71552166165ac778121ca9c9dff6b83f0fc",
  "1ee4cd9ff371dcb2e3938097e434f6fb8731688ed7165e61fc63693ad5b2f455",
  "27ed3603010ebc278f64f8645741ab132ff517abb5308eb9df6c8e42a48956b2",
  "29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b",
  "32baa10d2632a4417454a579f992bd640e0a3cec79321423559b2c9940de58a9",
  "40911a00922868686854a4804b93fd6e56b503664696de03f450bff690affb6d",
  "4a82bc1e9923576275869998925ce0ae021a79aa18b24a0dd87ad6b61ca85053",
  "58e78a618778926b1f6d9472a6468de878de8530970934e94aab5ba4ba08cc00",
  "5a9a78d54c157f55672afea37037464858a87fd5f276fc8206787f366ed684cf",
  "6f88083b8166cc559102f7044688de7525287632ebe09ac45d001ac8bf4b3eae",
  "718ba51adf166bb55c3e9936bb8199a0148457f7f0191aaa2f37a94f3159d6ec",
  "72b71c3581ca3b5a23b1c168d69b9d855b3f184fa079902a01f088eb4f0607d5",
  "87cb2f2ffe992652bb4fa768c73719a37b5852ab17fbf8e170e888f7a42b0761",
  "9c3a7e0a6515c6e1a7ae834a9ae430311ebc3241f7b2e5e7f0460aa690709a7c",
  "a8514094f754b099d3e55ce1d6e0b2de79db418b2eeacb0fc2a6bb0bfadef221",
  "ab93096331e7cd8ec379f73f1e9adcaaa9ee1115c9f4ff10411a811fb9700174",
  "bd24fd383253bf8d43f0a81f11c071d76d1d555114376dd647cd9fb38fa0a9da",
  "bfcc1b0fa931b14bb241372c76ab4f04374b67d02363c98d9cb12edfdacdf5f3",
  "cd40bafe618ff506f4088778b135cb4faa15f25e0c9b475e22d730c74b7be115",
  "d35dbfff175b83c13ef59cf924abfc810f7b6a158595d7417c5498ea8c7c7ed1",
  "ed346eb1e3f0280f15709393705899b3ff55c20b88f4e0308006b3c33cf5fe14"
]);

// ---- desktop ----
const builder = readFileSync(client("electron-builder.yml"), "utf8");
for (const [platform, pattern] of [["macOS", /^mac:\n(?:  .*\n)*?  icon: build-resources\/icon\.icns$/m], ["Windows", /^win:\n(?:  .*\n)*?  icon: build-resources\/icon\.ico$/m], ["Linux", /^linux:\n(?:  .*\n)*?  icon: build-resources\/png$/m], ["Windows installer", /^  installerIcon: build-resources\/icon\.ico$/m]]) {
  if (!pattern.test(builder)) fail(`electron-builder.yml doesn't set the ${platform} icon, so the package would show Electron's.`);
}
const icons = client("electron-assets/icons");
for (const name of ["icon.icns", "icon.ico", "icon.png"]) if (!existsSync(resolve(icons, name))) fail(`client/electron-assets/icons/${name} is missing.`);
if (existsSync(resolve(icons, "icon.icns"))) {
  const data = readFileSync(resolve(icons, "icon.icns"));
  const types = new Set();
  for (let offset = 8; offset + 8 <= data.length; offset += data.readUInt32BE(offset + 4)) {
    types.add(data.toString("ascii", offset, offset + 4));
    if (data.readUInt32BE(offset + 4) < 8) break;
  }
  for (const type of ["ic10", "ic09", "ic08", "ic07"]) if (!types.has(type)) fail(`icon.icns has no ${type} image.`);
}
if (existsSync(resolve(icons, "icon.ico"))) {
  const data = readFileSync(resolve(icons, "icon.ico"));
  const sizes = Array.from({ length: data.readUInt16LE(4) }, (_, index) => data[6 + index * 16] || 256);
  for (const size of [16, 32, 48, 256]) if (!sizes.includes(size)) fail(`icon.ico has no ${size}x${size} image.`);
}
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  const path = resolve(icons, `png/${size}x${size}.png`);
  if (!existsSync(path)) fail(`The Linux icon ${size}x${size}.png is missing.`);
  else if (png(path).width !== size) fail(`The Linux icon ${size}x${size}.png is the wrong size.`);
}
const prepare = readFileSync(client("scripts/prepare-electron-release.mjs"), "utf8");
if (!/build-resources/.test(prepare) || !/"assets", "icon\.png"/.test(prepare)) fail("prepare-electron-release.mjs doesn't copy the app icons into the Electron project.");

// ---- Android ----
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, factor] of Object.entries(densities)) {
  for (const [name, size] of [["ic_launcher", 48], ["ic_launcher_round", 48], ["ic_launcher_foreground", 108], ["ic_launcher_monochrome", 108]]) {
    const path = client(`android/app/src/main/res/mipmap-${density}/${name}.png`);
    if (!existsSync(path)) { fail(`Android ${density}/${name}.png is missing.`); continue; }
    const { width, height } = png(path);
    if (width !== Math.round(size * factor) || height !== width) fail(`Android ${density}/${name}.png is ${width}x${height}, expected ${Math.round(size * factor)}.`);
  }
}
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  const xml = readFileSync(client(`android/app/src/main/res/mipmap-anydpi-v26/${name}`), "utf8");
  for (const layer of ["background", "foreground", "monochrome"]) if (!xml.includes(`<${layer} `)) fail(`Android ${name} has no ${layer} layer.`);
}

// ---- iOS ----
const iosIcon = client("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
const ios = png(iosIcon);
if (ios.width !== 1024 || ios.height !== 1024) fail(`The iOS app icon is ${ios.width}x${ios.height}; it must be 1024x1024.`);
if (ios.colorType === 6 || ios.colorType === 4) fail("The iOS app icon has an alpha channel, which the App Store refuses.");

// ---- web ----
if (!existsSync(client("public/favicon.ico"))) fail("client/public/favicon.ico is missing.");
if (!/purpose: "maskable"/.test(readFileSync(client("vite.config.ts"), "utf8"))) fail("The PWA manifest has no maskable icon.");
if (!/href="\/favicon\.ico"/.test(readFileSync(client("index.html"), "utf8"))) fail("index.html doesn't link favicon.ico.");
const apple = png(client("public/apple-touch-icon.png"));
if (apple.width !== 180 || apple.colorType === 6) fail("apple-touch-icon.png must be an opaque 180x180 image.");

// ---- no framework defaults anywhere ----
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.png", "*.icns", "*.ico", "*.xml"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
for (const file of tracked) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
  if (DEFAULT_ICONS.has(createHash("sha256").update(readFileSync(path)).digest("hex"))) fail(`${file} is a framework's default icon, not HANNAH's.`);
}

if (problems.length) {
  console.error(`Brand check: ${problems.length} problem${problems.length === 1 ? "" : "s"}.`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("Regenerate with: node client/scripts/generate-brand-assets.mjs");
  process.exit(1);
}
console.log(`Brand check: HANNAH's icon on macOS, Windows, Linux, Android, iOS and the web; no framework defaults in ${tracked.length} image and resource files.`);
