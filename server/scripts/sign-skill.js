#!/usr/bin/env node
"use strict";

// Sign a HANNAH community skill manifest with Ed25519.
//   node scripts/sign-skill.js keygen <out-dir>          create a key pair
//   node scripts/sign-skill.js sign <manifest> <key.pem>  print the signed manifest
// The signature covers the whole manifest (keys sorted, "signature" removed),
// and an integrity hash of the instructions is added first. Keep the private
// key secret; share the public key so people can add you as a trusted publisher.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function rawPublicKey(publicKey) {
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
}

function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === "keygen") {
    const dir = path.resolve(first || ".");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyPath = path.join(dir, "hannah-skill-key.pem");
    fs.writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    console.log(`Private key: ${keyPath} (keep it secret)`);
    console.log(`Public key:  ${rawPublicKey(publicKey)}`);
    return;
  }
  if (command === "sign" && first && second) {
    const manifest = JSON.parse(fs.readFileSync(first, "utf8"));
    delete manifest.signature;
    manifest.integrity = { sha256: createHash("sha256").update(String(manifest.instructions || "").trim()).digest("hex") };
    const privateKey = createPrivateKey(fs.readFileSync(second));
    const value = sign(null, Buffer.from(canonical(manifest)), privateKey).toString("base64");
    manifest.signature = { alg: "Ed25519", publicKey: rawPublicKey(createPublicKey(privateKey)), value };
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  console.error("Usage: node scripts/sign-skill.js keygen <out-dir> | sign <manifest.json> <key.pem>");
  process.exitCode = 1;
}

main();
