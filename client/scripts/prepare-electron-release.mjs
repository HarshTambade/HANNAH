import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");
const electronRoot = resolve(clientRoot, "electron");
const releaseRequested = process.env.ELECTRON_RELEASE_REQUESTED === "true";
const releaseTag = process.env.ELECTRON_RELEASE_TAG?.trim() ?? "";
const appPackage = JSON.parse(readFileSync(resolve(clientRoot, "package.json"), "utf8"));

if (!existsSync(electronRoot)) throw new Error("Capacitor Electron did not create client/electron.");
if (releaseRequested && !/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(releaseTag)) {
  throw new Error("Electron release builds require an explicit vMAJOR.MINOR.PATCH release tag.");
}

const electronPackagePath = resolve(electronRoot, "package.json");
const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
electronPackage.version = releaseRequested ? releaseTag.slice(1) : appPackage.version;
// Keep electron-updater in devDependencies so electron-builder does not collect
// the entire application dependency tree into the packaged app. It is still
// installed for `capacitor-electron vendor` and copied into vendor/node_modules.
electronPackage.dependencies = {};
electronPackage.devDependencies = {
  ...electronPackage.devDependencies,
  electron: "^45.3.2",
  "electron-updater": "^6.6.2",
};
// Build-tool security fixes the packager's own dependency ranges don't pick up yet.
// minimatch < 11.0.1 (GHSA-g3hv-75wg-m249) comes in through @electron/universal and
// app-builder-lib at 9.x and 10.x; 11.x keeps the same named `minimatch` export.
electronPackage.overrides = {
  ...electronPackage.overrides,
  "minimatch@^9.0.0": "^11.0.9",
  "minimatch@^10.0.0": "^11.0.9",
};
electronPackage.homepage = "https://hannah.app";
electronPackage.author = "HANNAH contributors";
electronPackage.description = appPackage.description || "HANNAH desktop companion";
const packScript = electronPackage.scripts?.pack;
const alreadyPrepared = typeof packScript === "string" && packScript.includes("electron-builder --config electron-builder.yml") && packScript.includes("vendor-electron-dependencies.mjs");
if (!alreadyPrepared && (typeof packScript !== "string" || !packScript.includes("electron-builder --config electron-builder.config.js") || !packScript.includes("capacitor-electron vendor"))) {
  throw new Error("Could not find the generated Capacitor Electron pack script.");
}
// Re-runnable: a folder prepared earlier (local development) keeps its rewritten pack script.
electronPackage.scripts.pack = alreadyPrepared ? packScript : packScript.replace(
  "electron-builder --config electron-builder.config.js",
  "electron-builder --config electron-builder.yml",
).replace(
  "capacitor-electron vendor",
  "capacitor-electron vendor && node ../scripts/vendor-electron-dependencies.mjs electron-updater",
);
writeFileSync(electronPackagePath, `${JSON.stringify(electronPackage, null, 2)}\n`);

copyFileSync(resolve(clientRoot, "electron-main.ts"), resolve(electronRoot, "main.ts"));
// HANNAH's window size, minimum size and background colour.
copyFileSync(resolve(clientRoot, "electron-config.ts"), resolve(electronRoot, "capacitor.electron.config.ts"));
// HANNAH's splash window instead of the generated plain-text one.
mkdirSync(resolve(electronRoot, "assets"), { recursive: true });
copyFileSync(resolve(clientRoot, "electron-splash.html"), resolve(electronRoot, "assets", "splash.html"));
// Tray icons (client/electron-assets, rendered from public/icon-512.png; the template image is for the macOS menu bar).
for (const name of ["tray-16.png", "tray-32.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  copyFileSync(resolve(clientRoot, "electron-assets", name), resolve(electronRoot, "assets", name));
}
// App icons (scripts/generate-brand-assets.mjs): .icns, .ico and the Linux PNG set for electron-builder,
// and a PNG the app uses as its window icon on Windows and Linux.
const iconSource = resolve(clientRoot, "electron-assets", "icons");
mkdirSync(resolve(electronRoot, "build-resources", "png"), { recursive: true });
for (const name of ["icon.icns", "icon.ico", "icon.png"]) copyFileSync(resolve(iconSource, name), resolve(electronRoot, "build-resources", name));
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) copyFileSync(resolve(iconSource, "png", `${size}x${size}.png`), resolve(electronRoot, "build-resources", "png", `${size}x${size}.png`));
copyFileSync(resolve(iconSource, "icon.png"), resolve(electronRoot, "assets", "icon.png"));
const signingAvailable = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
let builderConfig = readFileSync(resolve(clientRoot, "electron-builder.yml"), "utf8");
builderConfig = builderConfig.replace(/^  notarize: false$/m, `  notarize: ${releaseRequested && signingAvailable ? "true" : "false"}`);
if (releaseRequested && signingAvailable) {
  builderConfig = builderConfig.replaceAll("  forceCodeSigning: false", "  forceCodeSigning: true");
}
writeFileSync(resolve(electronRoot, "electron-builder.yml"), builderConfig);

console.log(`Prepared Electron packaging for ${electronPackage.version}; notarization ${releaseRequested ? "required" : "disabled"}.`);
