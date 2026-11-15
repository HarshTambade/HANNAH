import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
electronPackage.dependencies = { ...electronPackage.dependencies, "electron-updater": "^6.6.2" };
electronPackage.devDependencies = { ...electronPackage.devDependencies, electron: "^45.3.2" };
const packScript = electronPackage.scripts?.pack;
if (typeof packScript !== "string" || !packScript.includes("electron-builder --config electron-builder.config.js") || !packScript.includes("capacitor-electron vendor")) {
  throw new Error("Could not find the generated Capacitor Electron pack script.");
}
electronPackage.scripts.pack = packScript.replace(
  "electron-builder --config electron-builder.config.js",
  "electron-builder --config electron-builder.yml",
).replace(
  "capacitor-electron vendor",
  "capacitor-electron vendor && node ../scripts/vendor-electron-dependencies.mjs electron-updater",
);
writeFileSync(electronPackagePath, `${JSON.stringify(electronPackage, null, 2)}\n`);

copyFileSync(resolve(clientRoot, "electron-main.ts"), resolve(electronRoot, "main.ts"));
let builderConfig = readFileSync(resolve(clientRoot, "electron-builder.yml"), "utf8");
builderConfig = builderConfig.replace(/^  notarize: false$/m, `  notarize: ${releaseRequested ? "true" : "false"}`);
if (releaseRequested) builderConfig = builderConfig.replaceAll("  forceCodeSigning: false", "  forceCodeSigning: true");
writeFileSync(resolve(electronRoot, "electron-builder.yml"), builderConfig);

console.log(`Prepared Electron packaging for ${electronPackage.version}; notarization ${releaseRequested ? "required" : "disabled"}.`);
