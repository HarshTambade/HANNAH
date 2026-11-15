import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

const electronRoot = resolve(import.meta.dirname, "../electron");
const vendorRoot = resolve(electronRoot, "vendor/node_modules");
const requestedPackages = process.argv.slice(2);

if (requestedPackages.length === 0) {
  throw new Error("Pass one or more Electron runtime packages to vendor.");
}

mkdirSync(vendorRoot, { recursive: true });
const copied = new Set();

function findPackageRoot(entryPath, expectedName) {
  let current = dirname(entryPath);
  while (current.startsWith(`${electronRoot}${sep}`) || current === electronRoot) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === expectedName) return { root: current, manifest };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function vendorPackage(packageName, requiringDirectory = electronRoot) {
  if (copied.has(packageName)) return;
  const requireFromDirectory = createRequire(join(requiringDirectory, "package.json"));
  let entryPath;
  try {
    entryPath = requireFromDirectory.resolve(packageName);
  } catch {
    throw new Error(`Could not resolve Electron runtime dependency "${packageName}" from ${relative(electronRoot, requiringDirectory)}.`);
  }
  const found = findPackageRoot(entryPath, packageName);
  if (!found) throw new Error(`Could not locate package metadata for Electron runtime dependency "${packageName}".`);

  const destination = join(vendorRoot, packageName);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(found.root, destination, { recursive: true, dereference: true });
  copied.add(packageName);

  const dependencies = {
    ...found.manifest.dependencies,
    ...found.manifest.optionalDependencies,
  };
  for (const dependencyName of Object.keys(dependencies)) {
    try {
      vendorPackage(dependencyName, found.root);
    } catch (error) {
      if (found.manifest.optionalDependencies?.[dependencyName]) continue;
      throw error;
    }
  }
}

for (const packageName of requestedPackages) vendorPackage(packageName);
console.log(`Vendored ${copied.size} additional Electron runtime package(s): ${[...copied].join(", ")}`);
