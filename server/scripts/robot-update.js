#!/usr/bin/env node
"use strict";

/**
 * Build, sign and verify a HANNAH update package (server/robotics/update_packages.js).
 *
 *   node server/scripts/robot-update.js keygen <name>
 *       writes <name>.private.pem (mode 600) and <name>.public.pem; pin the public
 *       key in HANNAH (Robot OS → Updates → Publisher keys) under the publisher's name
 *   node server/scripts/robot-update.js build <folder>
 *       fills in `artifacts` in <folder>/hannah-update.json from every other file
 *       in the folder (path, SHA-256, size) and checks the manifest
 *   node server/scripts/robot-update.js sign <folder> <private.pem>
 *       builds, then signs the manifest with Ed25519
 *   node server/scripts/robot-update.js verify <folder> <public.pem> <publisher>
 *       checks the manifest, the signature, the publisher and every file
 *
 * Keep the private key off any server and off the robots. Nothing here installs
 * anything; upload the signed hannah-update.json in the app, where it is checked
 * again against the keys pinned to your account.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const updates = require("../robotics/update_packages");
const { keyIdOf, sha256 } = require("../robotics/packages");

function filesOf(folder) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(folder, full).split(path.sep).join("/");
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && relative !== updates.MANIFEST) out[relative] = fs.readFileSync(full);
    }
  };
  walk(folder);
  return out;
}
const manifestPath = (folder) => path.join(folder, updates.MANIFEST);
const readManifest = (folder) => JSON.parse(fs.readFileSync(manifestPath(folder), "utf8"));
const write = (folder, manifest) => fs.writeFileSync(manifestPath(folder), `${JSON.stringify(manifest, null, 2)}\n`);

function build(folder) {
  const manifest = readManifest(folder);
  const files = filesOf(folder);
  if (!Object.keys(files).length) throw new Error(`No files next to ${updates.MANIFEST} in ${folder}.`);
  manifest.artifacts = Object.keys(files).sort().map((file) => ({ path: file, sha256: sha256(files[file]), size: files[file].length }));
  const { signature: _signature, ...unsigned } = manifest;
  const problems = updates.validateManifest({ ...unsigned, signature: { algorithm: "ed25519", keyId: "unsigned", value: "" } });
  if (problems.length) throw new Error(problems.join("\n"));
  return unsigned;
}

function main(argv) {
  const [command, first, second, third] = argv;
  if (command === "keygen" && first) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(`${first}.private.pem`, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(`${first}.public.pem`, publicKey.export({ type: "spki", format: "pem" }));
    console.log(`Key id ${keyIdOf(publicKey)}. Keep ${first}.private.pem off any server and any robot.`);
    return 0;
  }
  if (command === "build" && first) {
    const manifest = build(first);
    write(first, manifest);
    console.log(`Built ${manifest.id} ${manifest.version}: ${manifest.artifacts.length} file(s). Not signed yet.`);
    return 0;
  }
  if (command === "sign" && first && second) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(second));
    const signed = updates.signManifest(build(first), privateKey);
    const problems = updates.validateManifest(signed);
    if (problems.length) throw new Error(problems.join("\n"));
    write(first, signed);
    console.log(`Signed ${signed.id} ${signed.version}: ${signed.artifacts.length} file(s), key ${signed.signature.keyId}.`);
    return 0;
  }
  if (command === "verify" && first && second && third) {
    const publicKey = fs.readFileSync(second, "utf8");
    const manifest = readManifest(first);
    const problems = updates.validateManifest(manifest);
    const verdict = problems.length ? null : updates.verifySignature(manifest, [{ keyId: keyIdOf(publicKey), publicKey, owner: third }]);
    const integrity = problems.length ? null : updates.verifyArtifacts(manifest, filesOf(first));
    const ok = !problems.length && verdict.signature.ok && verdict.publisher.ok && integrity.ok;
    console.log(JSON.stringify({ ok, problems, signature: verdict?.signature, publisher: verdict?.publisher, integrity }, null, 2));
    return ok ? 0 : 1;
  }
  console.error("Usage: robot-update.js keygen <name> | build <folder> | sign <folder> <private.pem> | verify <folder> <public.pem> <publisher>");
  return 2;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { build, main };
