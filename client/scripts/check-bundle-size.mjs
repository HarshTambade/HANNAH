import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const clientRoot = resolve(import.meta.dirname, "..");
const distPath = resolve(clientRoot, "dist");
const rendererLimit = 5 * 1024 * 1024;
const packageLimit = 150 * 1024 * 1024;
const packageArtifactPattern = /\.(?:appimage|deb|dmg|exe|msi|pkg|rpm|zip)$/i;
const strict = process.argv.includes("--strict");
const packageDirIndex = process.argv.indexOf("--package-dir");
const packagePath = packageDirIndex >= 0 ? resolve(process.cwd(), process.argv[packageDirIndex + 1] || "") : null;

function listFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

if (!statSync(distPath, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("client/dist is missing. Run npm run build first.");
  process.exit(1);
}

const files = listFiles(distPath);
const rendererBytes = files
  .filter((path) => /\.(?:m?js|css)$/i.test(path))
  .reduce((total, path) => total + gzipSync(readFileSync(path), { level: 9 }).byteLength, 0);
const webDistributionBytes = files.reduce((total, path) => total + statSync(path).size, 0);
const rendererPass = rendererBytes <= rendererLimit;

console.log(`Renderer JS/CSS (per-file gzip): ${formatMiB(rendererBytes)} / 5.00 MiB ${rendererPass ? "PASS" : "OVER TARGET"}`);
console.log(`Web distribution: ${formatMiB(webDistributionBytes)} (includes models and static assets)`);

let packagePass = true;
if (packagePath) {
  if (!statSync(packagePath, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Package directory does not exist: ${packagePath}`);
    process.exit(1);
  }
  const packageArtifacts = listFiles(packagePath)
    .filter((path) => packageArtifactPattern.test(path) && !/\.blockmap$/i.test(path))
    .map((path) => ({ path, bytes: statSync(path).size }));
  if (packageArtifacts.length === 0) {
    packagePass = false;
    console.error(`No distributable installer artifacts found in ${packagePath}`);
  } else {
    const oversizedArtifacts = packageArtifacts.filter(({ bytes }) => bytes > packageLimit);
    packagePass = oversizedArtifacts.length === 0;
    const largest = packageArtifacts.reduce((previous, current) => current.bytes > previous.bytes ? current : previous);
    console.log(`Largest platform installer: ${formatMiB(largest.bytes)} / 150.00 MiB ${packagePass ? "PASS" : "OVER TARGET"}`);
    for (const artifact of oversizedArtifacts) {
      console.error(`Over target: ${artifact.path} (${formatMiB(artifact.bytes)})`);
    }
  }
} else {
  console.log("Platform installer size not checked. Pass --package-dir <packaged-app-directory> after packaging.");
}

if (strict && (!rendererPass || !packagePass)) process.exitCode = 1;
