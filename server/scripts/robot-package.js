#!/usr/bin/env node
"use strict";

/**
 * Sign and verify a HANNAH robot package from the command line.
 *
 *   node server/scripts/robot-package.js keygen <name>              writes <name>.private.pem and <name>.public.pem
 *   node server/scripts/robot-package.js sign <folder> <private.pem> fills in file hashes and signs the manifest
 *   node server/scripts/robot-package.js verify <folder> <public.pem> [owner]
 *
 * Keep the private key off any server. Verifying installs nothing.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const packages = require("../robotics/packages");

function filesOf(folder) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && path.relative(folder, full) !== packages.MANIFEST) out[path.relative(folder, full).split(path.sep).join("/")] = fs.readFileSync(full);
    }
  };
  walk(folder);
  return out;
}

const [command, first, second, third] = process.argv.slice(2);
if (command === "keygen" && first) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(`${first}.private.pem`, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(`${first}.public.pem`, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`Key id ${packages.keyIdOf(publicKey)}. Keep ${first}.private.pem off any server.`);
} else if (command === "sign" && first && second) {
  const manifestPath = path.join(first, packages.MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = filesOf(first);
  manifest.files = Object.keys(files).sort().map((file) => ({ path: file, sha256: packages.sha256(files[file]), size: files[file].length }));
  const privateKey = crypto.createPrivateKey(fs.readFileSync(second));
  const signed = packages.signManifest(manifest, privateKey, packages.keyIdOf(crypto.createPublicKey(privateKey)));
  const problems = packages.validateManifest(signed);
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  fs.writeFileSync(manifestPath, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`Signed ${signed.id} ${signed.version}: ${signed.files.length} files, key ${signed.signature.keyId}.`);
} else if (command === "verify" && first && second) {
  const publicKey = fs.readFileSync(second, "utf8");
  const result = packages.verifyPackage({ manifest: JSON.parse(fs.readFileSync(path.join(first, packages.MANIFEST), "utf8")), files: filesOf(first), trustedKeys: [{ keyId: packages.keyIdOf(publicKey), publicKey, owner: third || "the key you gave" }] });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} else {
  console.error("Usage: robot-package.js keygen <name> | sign <folder> <private.pem> | verify <folder> <public.pem> [owner]");
  process.exit(2);
}
