#!/usr/bin/env node
/**
 * HANNAH's icons for every platform, from the one official mark:
 * client/public/icon.svg (the four-colour ring on the dark rounded square).
 *
 *   node scripts/generate-brand-assets.mjs          write everything
 *   node scripts/generate-brand-assets.mjs --check  fail if a committed asset differs (CI)
 *
 * The ring's geometry and colours are read from icon.svg and only placed
 * differently per platform, never redrawn:
 *   macOS   .icns on Apple's 1024 grid: the rounded square is 824 px with 100 px clear space
 *   Windows .ico (16–256), the rounded square edge to edge, as Windows icons are
 *   Linux   PNGs 16–1024 for the AppImage and .deb launchers, plus the window icon
 *   Android legacy square and round launcher icons per density; adaptive icon
 *           layers (background colour, foreground ring inside the 66 dp safe zone of
 *           the 108 dp canvas) and a monochrome layer for themed icons (Android 13+)
 *   iOS     one 1024 opaque, square icon (iOS applies the corner mask; alpha is refused)
 *   Web     favicon.ico (16/32/48), apple-touch-icon (opaque 180), a maskable 512 for PWAs
 * Rendering uses headless Chromium (Playwright, already a dev dependency);
 * ICNS and ICO files are assembled here, so this runs on any OS.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const master = readFileSync(resolve(root, "public/icon.svg"), "utf8");
const BACKGROUND = /<rect[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(master)?.[1] ?? "#0c0e14";
const defs = /<defs>[\s\S]*?<\/defs>/.exec(master)?.[0];
const ring = /<g fill="none"[\s\S]*?<\/g>/.exec(master)?.[0];
if (!defs || !ring) throw new Error("public/icon.svg doesn't have the expected <defs> and ring <g>.");
// The ring spans 106–406 (centre 256, outer radius 150 + 39 = 189) in the master's 512 box.
const RING_OUTER = 189;

/** The ring centred in a size×size box with the given outer diameter, optionally single-colour. */
function ringSvg(size, diameter, { mono = null } = {}) {
  const scale = diameter / (RING_OUTER * 2);
  const shift = size / 2 - 256 * scale;
  const group = mono ? ring.replace(/stroke="url\(#[a-d]\)"/g, `stroke="${mono}"`) : ring;
  return `<g transform="translate(${shift} ${shift}) scale(${scale})">${group}</g>`;
}

/** Variants: the official composition placed on each platform's canvas. */
const variants = {
  // Rounded square body (the master) inset by `inset` px on each side.
  rounded: (size, inset = 0) => {
    const body = size - inset * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}<rect x="${inset}" y="${inset}" width="${body}" height="${body}" rx="${(body * 120) / 512}" fill="${BACKGROUND}"/>${ringSvg(size, (body * RING_OUTER * 2) / 512)}</svg>`;
  },
  // Full-bleed square (iOS, apple-touch, maskable): the OS rounds it.
  square: (size, ringShare = (RING_OUTER * 2) / 512) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}<rect width="${size}" height="${size}" fill="${BACKGROUND}"/>${ringSvg(size, size * ringShare)}</svg>`,
  circle: (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${BACKGROUND}"/>${ringSvg(size, size * 0.62)}</svg>`,
  // Adaptive foreground: 108 dp canvas; keep the ring inside the 66 dp safe circle (with margin).
  foreground: (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs}${ringSvg(size, (size * 60) / 108)}</svg>`,
  monochrome: (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${ringSvg(size, (size * 60) / 108, { mono: "#ffffff" })}</svg>`,
};

const { chromium } = require("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(svg, size, { opaque = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${opaque ? BACKGROUND : "transparent"}">${svg}</body></html>`);
  return page.screenshot({ type: "png", omitBackground: !opaque, clip: { x: 0, y: 0, width: size, height: size } });
}

/** ICNS: PNG entries keyed by Apple's type codes. */
function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** ICO with PNG-encoded images (Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const directory = images.map(([size, png]) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...directory, ...images.map(([, png]) => png)]);
}

const written = [];
const stale = [];
function output(path, data) {
  const target = resolve(root, path);
  if (check) {
    if (!existsSync(target)) stale.push(`${path} (missing)`);
    else if (createHash("sha256").update(readFileSync(target)).digest("hex") !== createHash("sha256").update(data).digest("hex")) stale.push(path);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  written.push(path);
}

// ---- macOS (Apple grid: 824 body in 1024) ----
const mac = async (size) => render(variants.rounded(size, Math.round((size * 100) / 1024)), size);
const macSizes = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 };
const macPngs = {};
for (const size of new Set(Object.values(macSizes))) macPngs[size] = await mac(size);
output("electron-assets/icons/icon.icns", icns(Object.entries(macSizes).map(([type, size]) => [type, macPngs[size]])));

// ---- Windows (edge to edge, tiny inset so the corners stay crisp) ----
const winSizes = [16, 24, 32, 48, 64, 128, 256];
const winPngs = [];
for (const size of winSizes) winPngs.push([size, await render(variants.rounded(size, size <= 32 ? 0 : Math.round(size / 64)), size)]);
output("electron-assets/icons/icon.ico", ico(winPngs));

// ---- Linux and the window icon ----
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) output(`electron-assets/icons/png/${size}x${size}.png`, await render(variants.rounded(size, Math.round(size / 32)), size));
output("electron-assets/icons/icon.png", await render(variants.rounded(512, 16), 512));

// ---- Android ----
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, factor] of Object.entries(densities)) {
  const legacy = Math.round(48 * factor);
  const layer = Math.round(108 * factor);
  output(`android/app/src/main/res/mipmap-${density}/ic_launcher.png`, await render(variants.rounded(legacy, Math.round(2 * factor)), legacy));
  output(`android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, await render(variants.circle(legacy), legacy));
  output(`android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, await render(variants.foreground(layer), layer));
  output(`android/app/src/main/res/mipmap-${density}/ic_launcher_monochrome.png`, await render(variants.monochrome(layer), layer));
}
const adaptive = (round) => `<?xml version="1.0" encoding="utf-8"?>
<!-- HANNAH's adaptive launcher icon (generated by scripts/generate-brand-assets.mjs). -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
${round ? "" : ""}`;
output("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", Buffer.from(adaptive(false)));
output("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml", Buffer.from(adaptive(true)));
output("android/app/src/main/res/values/ic_launcher_background.xml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BACKGROUND.toUpperCase()}</color>\n</resources>\n`));

// ---- iOS: one 1024 opaque square ----
output("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", await render(variants.square(1024), 1024, { opaque: true }));

// ---- Web ----
const favicons = [];
for (const size of [16, 32, 48]) favicons.push([size, await render(variants.rounded(size, 0), size)]);
output("public/favicon.ico", ico(favicons));
output("public/apple-touch-icon.png", await render(variants.square(180), 180, { opaque: true }));
// Maskable: the safe zone is the centre 80 %; the ring stays inside it.
output("public/icon-maskable-512.png", await render(variants.square(512, 0.56), 512, { opaque: true }));

await browser.close();
if (check) {
  if (stale.length) {
    console.error(`Brand assets are out of date or missing:\n  ${stale.join("\n  ")}\nRun: node scripts/generate-brand-assets.mjs`);
    process.exit(1);
  }
  console.log("Brand assets match public/icon.svg.");
} else {
  console.log(`Wrote ${written.length} brand assets from public/icon.svg.`);
}
