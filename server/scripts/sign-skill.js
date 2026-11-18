#!/usr/bin/env node
"use strict";

// Sign a HANNAH community skill manifest with Ed25519.
//   node scripts/sign-skill.js keygen <out-dir> [--force]   create a key pair
//   node scripts/sign-skill.js sign <manifest> <key.pem>     print the signed manifest
//   node scripts/sign-skill.js verify <manifest.json>        check its integrity hash and signature
//
// The signature covers the whole manifest (keys sorted, "signature" removed),
// and an integrity hash of the instructions is added first. Keep the private
// key secret; share the public key so people can add you as a trusted publisher.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function rawPublicKey(publicKey) {
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read JSON from ${filePath}: ${error.message}`);
  }
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("manifest must be a JSON object");
    return errors;
  }
  if (manifest.manifestVersion !== 1) errors.push('"manifestVersion" must be 1');
  if (manifest.type !== "instruction-skill") errors.push('"type" must be "instruction-skill"');
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(manifest.id)) errors.push('"id" must be a valid skill id');
  if (typeof manifest.name !== "string" || !manifest.name.trim()) errors.push('"name" is required');
  if (typeof manifest.instructions !== "string" || manifest.instructions.trim().length < 10) errors.push('"instructions" must be at least 10 characters');
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length) errors.push('"permissions" must be an empty list');
  if (!manifest.privacy || typeof manifest.privacy.dataLeavesDevice !== "boolean") errors.push('"privacy.dataLeavesDevice" is required');
  return errors;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "keygen") {
    const dir = path.resolve(args[1] || ".");
    const force = args.includes("--force");
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, "hannah-skill-key.pem");
    if (fs.existsSync(keyPath) && !force) {
      console.error(`Private key already exists: ${keyPath}. Use --force to overwrite it.`);
      process.exitCode = 1;
      return;
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: force ? "w" : "wx" });
    const pub = rawPublicKey(publicKey);
    console.log(`Private key: ${keyPath} (keep it secret)`);
    console.log(`Public key:  ${pub}`);
    console.log("");
    console.log("Add this public key to shared/trusted-publishers.json to be a trusted publisher:");
    console.log(JSON.stringify({ name: "Your publisher name", publicKey: pub }, null, 2));
    return;
  }

  if (command === "sign" && args[1] && args[2]) {
    const manifestPath = args[1];
    const keyPath = args[2];
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    const errors = validateManifestShape(manifest);
    if (errors.length) {
      console.error("Manifest is invalid:");
      for (const error of errors) console.error(`  - ${error}`);
      process.exitCode = 1;
      return;
    }
    delete manifest.signature;
    manifest.integrity = { sha256: createHash("sha256").update(String(manifest.instructions || "").trim()).digest("hex") };
    let privateKey;
    try {
      privateKey = createPrivateKey(fs.readFileSync(keyPath));
    } catch (error) {
      console.error(`Could not read the private key: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const value = sign(null, Buffer.from(canonical(manifest)), privateKey).toString("base64");
    manifest.signature = { alg: "Ed25519", publicKey: rawPublicKey(createPublicKey(privateKey)), value };
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (command === "verify" && args[1]) {
    const manifestPath = args[1];
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    const errors = validateManifestShape(manifest);
    if (errors.length) {
      console.error("Manifest shape is invalid:");
      for (const error of errors) console.error(`  - ${error}`);
      process.exitCode = 1;
      return;
    }
    let ok = true;
    const expectedHash = createHash("sha256").update(String(manifest.instructions || "").trim()).digest("hex");
    if (manifest.integrity?.sha256) {
      if (String(manifest.integrity.sha256).toLowerCase() !== expectedHash) {
        console.error("Integrity: FAILED (instructions changed after signing).");
        ok = false;
      } else {
        console.log("Integrity: OK");
      }
    } else {
      console.log("Integrity: not provided (warning)");
    }
    const signature = manifest.signature;
    if (signature === undefined) {
      console.log("Signature: not signed");
    } else if (signature?.alg !== "Ed25519" || typeof signature.publicKey !== "string" || typeof signature.value !== "string") {
      console.error("Signature: FAILED (malformed)");
      ok = false;
    } else {
      const { signature: _omit, ...signed } = manifest;
      let publicKey = null;
      try {
        const x = Buffer.from(signature.publicKey, "base64").toString("base64url");
        publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
      } catch (error) {
        console.error(`Signature: FAILED (bad public key: ${error.message})`);
        ok = false;
      }
      if (publicKey) {
        const valid = verify(null, Buffer.from(canonical(signed)), publicKey, Buffer.from(signature.value, "base64"));
        if (valid) console.log("Signature: OK");
        else {
          console.error("Signature: FAILED (does not match)");
          ok = false;
        }
      }
    }
    if (!ok) process.exitCode = 1;
    else console.log("Manifest: OK");
    return;
  }

  console.error("Usage:");
  console.error("  node scripts/sign-skill.js keygen <out-dir> [--force]");
  console.error("  node scripts/sign-skill.js sign <manifest.json> <key.pem>");
  console.error("  node scripts/sign-skill.js verify <manifest.json>");
  process.exitCode = 1;
}

main();
