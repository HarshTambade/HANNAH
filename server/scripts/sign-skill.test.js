"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.resolve(__dirname, "sign-skill.js");
const fixtures = path.resolve(__dirname, "fixtures");

function run(args, options = {}) {
  return execFileSync(process.execPath, [script, ...args], { encoding: "utf8", ...options });
}

test("sign-skill: keygen creates a private key and prints its public key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-keygen-"));
  const output = run(["keygen", dir]);
  assert.match(output, /Private key:/);
  assert.match(output, /Public key:/);
  assert.ok(fs.existsSync(path.join(dir, "hannah-skill-key.pem")));
});

test("sign-skill: keygen refuses to overwrite without --force", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-keygen-"));
  run(["keygen", dir]);
  assert.throws(() => run(["keygen", dir]), /already exists/);
  run(["keygen", dir, "--force"]);
});

test("sign-skill: signs a valid manifest and verify accepts it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-sign-"));
  run(["keygen", dir]);
  const signed = run(["sign", path.join(fixtures, "manifest.json"), path.join(dir, "hannah-skill-key.pem")]);
  const manifest = JSON.parse(signed);
  assert.equal(manifest.integrity.sha256.length, 64);
  assert.equal(manifest.signature.alg, "Ed25519");
  const file = path.join(dir, "signed.json");
  fs.writeFileSync(file, signed);
  const result = run(["verify", file]);
  assert.match(result, /Integrity: OK/);
  assert.match(result, /Signature: OK/);
  assert.match(result, /Manifest: OK/);
});

test("sign-skill: verify rejects a tampered manifest", () => {
  assert.throws(() => run(["verify", path.join(fixtures, "tampered.json")]), (error) => {
    return /Integrity: FAILED/.test(error.stdout || error.stderr || String(error));
  });
});

test("sign-skill: sign rejects an invalid manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-sign-"));
  run(["keygen", dir]);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ manifestVersion: 1, type: "instruction-skill", id: "x" }));
  assert.throws(() => run(["sign", bad, path.join(dir, "hannah-skill-key.pem")]), /Manifest is invalid/);
});

test("sign-skill: committed signed fixture verifies cleanly", () => {
  const result = run(["verify", path.join(fixtures, "signed.json")]);
  assert.match(result, /Manifest: OK/);
});

test("sign-skill: example community skills verify cleanly", () => {
  const dir = path.resolve(__dirname, "..", "..", "examples", "community-skills");
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".signed.json"))) {
    const result = run(["verify", path.join(dir, name)]);
    assert.match(result, /Manifest: OK/, name);
  }
});
