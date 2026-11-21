"use strict";

/**
 * Robot packages: what a developer ships (a driver, a sensor adapter, a robot
 * profile, a simulation world, a mission template) and how HANNAH checks one
 * before anyone decides to install it.
 *
 * A package is a folder with a manifest, `hannah-robot-package.json`. The
 * manifest lists every file with its SHA-256 and is signed with Ed25519 by its
 * author. verifyPackage() answers, in this order:
 *
 *   1. Is the manifest well-formed and complete? (who, what, which hardware,
 *      which ROS distributions, exact dependency versions, permissions,
 *      safety constraints, test evidence)
 *   2. Was it signed by a key the owner trusts, that hasn't been revoked?
 *   3. Are the files exactly the ones the manifest lists, unchanged?
 *   4. Does it stay inside HANNAH's rules? (only capabilities in the contract,
 *      no capability that reaches an actuator directly, honest test levels)
 *
 * and returns what a person needs to review: the permissions it asks for, its
 * risk, and every problem found.
 *
 * What this is not: an installer. Nothing here copies code onto a robot or
 * runs it. Installing a driver on a physical robot is a decision for a person
 * after review, and that step is not built.
 */
const crypto = require("node:crypto");
const contract = require("./contract");

const MANIFEST = "hannah-robot-package.json";
const KINDS = ["driver", "sensor-adapter", "actuator-adapter", "ros2-package", "capability", "navigation-skill", "manipulation-skill", "perception-skill", "mission-template", "simulation-environment", "hardware-profile"];
/** Kinds that put code on the robot's computer, as opposed to data it reads. */
const CODE_KINDS = new Set(["driver", "sensor-adapter", "actuator-adapter", "ros2-package", "capability", "navigation-skill", "manipulation-skill", "perception-skill"]);
const PERMISSIONS = {
  "read-sensors": "Read the robot's sensors",
  "read-state": "Read the robot's state",
  "navigation": "Send goals to the robot's navigation stack",
  "manipulation": "Send goals to the robot's manipulation planner",
  "devices": "Switch listed on/off devices",
  "network-local": "Talk to devices on the robot's own network",
  "network-internet": "Reach the internet from the robot",
  "filesystem": "Read and write files on the robot's computer",
};
const TEST_LEVELS = ["unit", "simulation", "hardware-in-the-loop", "physical"];
const FORBIDDEN = /pwm|duty|torque|current|effort|raw|cmd_vel|actuator_command|motor_command/i;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** JSON with keys in a fixed order, so the same manifest always signs to the same bytes. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const signedPart = (manifest) => { const { signature: _signature, ...rest } = manifest; return Buffer.from(canonical(rest), "utf8"); };

function validateManifest(manifest) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  if (!manifest || typeof manifest !== "object") return ["The manifest isn't an object."];
  need(ID.test(String(manifest.id || "")), "id must be a reverse-domain name such as org.example.lidar-driver.");
  need(typeof manifest.name === "string" && manifest.name.trim(), "name is required.");
  need(typeof manifest.author === "string" && manifest.author.trim(), "author is required.");
  need(SEMVER.test(String(manifest.version || "")), "version must be an exact version such as 1.2.0.");
  need(KINDS.includes(manifest.kind), `kind must be one of: ${KINDS.join(", ")}.`);
  need(Array.isArray(manifest.supportedHardware) && manifest.supportedHardware.length, "supportedHardware must name the hardware it was made for.");
  need(Array.isArray(manifest.operatingSystems) && manifest.operatingSystems.length, "operatingSystems is required.");
  need(Array.isArray(manifest.rosDistributions), "rosDistributions is required (an empty list when it doesn't use ROS).");
  need(typeof manifest.documentation === "string" && manifest.documentation.trim(), "documentation is required.");
  for (const dependency of Array.isArray(manifest.dependencies) ? manifest.dependencies : [null]) {
    if (dependency === null) { if (!Array.isArray(manifest.dependencies)) problems.push("dependencies is required (an empty list when there are none)."); continue; }
    if (!dependency?.name || !SEMVER.test(String(dependency.version || ""))) problems.push(`dependency ${dependency?.name || "(unnamed)"} must be pinned to an exact version, not a range.`);
  }
  for (const permission of Array.isArray(manifest.permissions) ? manifest.permissions : [null]) {
    if (permission === null) { if (!Array.isArray(manifest.permissions)) problems.push("permissions is required (an empty list when it needs none)."); continue; }
    if (!Object.hasOwn(PERMISSIONS, permission)) problems.push(`“${String(permission).slice(0, 40)}” isn't a permission HANNAH knows.`);
  }
  for (const id of Array.isArray(manifest.capabilities) ? manifest.capabilities : []) {
    if (FORBIDDEN.test(String(id))) problems.push(`“${String(id).slice(0, 40)}” names a raw actuator command. A package can't add one.`);
    else if (!contract.capability(id)) problems.push(`“${String(id).slice(0, 40)}” isn't in HANNAH's capability contract. New capabilities are added to the contract first.`);
  }
  need(Array.isArray(manifest.safetyConstraints), "safetyConstraints is required (an empty list is allowed only for data packages).");
  if (CODE_KINDS.has(manifest.kind) && Array.isArray(manifest.safetyConstraints) && !manifest.safetyConstraints.length) problems.push("A package that runs code on a robot must state its safety constraints.");
  const tests = manifest.tests;
  if (!tests || !TEST_LEVELS.includes(tests.level) || !Number.isInteger(tests.passed) || !Number.isInteger(tests.total) || tests.passed > tests.total || typeof tests.evidence !== "string") problems.push(`tests must give level (${TEST_LEVELS.join(", ")}), passed, total and evidence.`);
  if (!Array.isArray(manifest.files) || !manifest.files.length) problems.push("files must list every file with its sha256 and size.");
  else for (const file of manifest.files) {
    if (typeof file?.path !== "string" || file.path.startsWith("/") || file.path.split("/").includes("..") || !/^[0-9a-f]{64}$/.test(String(file.sha256 || "")) || !Number.isInteger(file.size)) problems.push(`file entry ${String(file?.path).slice(0, 80)} needs a relative path, a sha256 and a size.`);
  }
  const signature = manifest.signature;
  if (!signature || signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") problems.push("signature must be { algorithm: \"ed25519\", keyId, value }.");
  return problems;
}

/** Sign a manifest (developer side). `privateKey` is a PEM or KeyObject. Returns the manifest with its signature. */
function signManifest(manifest, privateKey, keyId) {
  const { signature: _old, ...rest } = manifest;
  const value = crypto.sign(null, signedPart(rest), privateKey).toString("base64");
  return { ...rest, signature: { algorithm: "ed25519", keyId, value } };
}
/** The id HANNAH uses for a public key: the start of its SHA-256. */
const keyIdOf = (publicKey) => {
  const key = publicKey instanceof crypto.KeyObject && publicKey.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
  return sha256(key.export({ type: "spki", format: "der" })).slice(0, 16);
};

/**
 * Check a package before a person decides about it.
 *   files         { "relative/path": Buffer } everything in the package except the manifest
 *   trustedKeys   [{ keyId, publicKey (PEM), owner, revokedAt? }]
 */
function verifyPackage({ manifest, files = {}, trustedKeys = [] }) {
  const problems = validateManifest(manifest);
  const result = { ok: false, problems, signedBy: null, review: null };
  if (problems.length) return result;
  const key = trustedKeys.find((item) => item.keyId === manifest.signature.keyId);
  if (!key) problems.push(`Signed with a key you don't trust (${manifest.signature.keyId}).`);
  else if (key.revokedAt) problems.push(`Signed with a key that was revoked on ${new Date(key.revokedAt).toISOString().slice(0, 10)}.`);
  else {
    let valid = false;
    try { valid = crypto.verify(null, signedPart(manifest), key.publicKey, Buffer.from(manifest.signature.value, "base64")); } catch { valid = false; }
    if (!valid) problems.push("The signature doesn't match the manifest: it was changed after signing, or signed with another key.");
    else result.signedBy = key.owner || key.keyId;
  }
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  for (const [path, file] of listed) {
    const bytes = files[path];
    if (!bytes) problems.push(`Listed but missing: ${path}.`);
    else if (bytes.length !== file.size || sha256(bytes) !== file.sha256) problems.push(`Changed since it was signed: ${path}.`);
  }
  for (const path of Object.keys(files)) if (!listed.has(path)) problems.push(`Not listed in the manifest: ${path}.`);
  const runsCode = CODE_KINDS.has(manifest.kind);
  const hardwareTested = ["hardware-in-the-loop", "physical"].includes(manifest.tests.level);
  result.review = {
    id: manifest.id, name: manifest.name, version: manifest.version, author: manifest.author, kind: manifest.kind, runsCodeOnRobot: runsCode,
    permissions: manifest.permissions.map((id) => ({ id, meaning: PERMISSIONS[id] })),
    capabilities: (manifest.capabilities || []).map((id) => ({ id, risk: contract.capability(id).risk })),
    safetyConstraints: manifest.safetyConstraints,
    tested: `${manifest.tests.passed} of ${manifest.tests.total} tests, ${manifest.tests.level}`,
    risk: !runsCode ? "low: data only" : manifest.permissions.some((id) => ["manipulation", "filesystem", "network-internet"].includes(id)) ? "high" : "moderate",
    warnings: [
      ...(runsCode && !hardwareTested ? ["Its tests ran in simulation or as unit tests only. It has not been shown to work on hardware."] : []),
      ...(runsCode ? ["It runs code on the robot's computer. Review it before installing it on a physical robot."] : []),
      ...(manifest.tests.passed < manifest.tests.total ? [`${manifest.tests.total - manifest.tests.passed} of its own tests fail.`] : []),
    ],
  };
  result.ok = problems.length === 0;
  return result;
}

module.exports = { CODE_KINDS, KINDS, MANIFEST, PERMISSIONS, TEST_LEVELS, canonical, keyIdOf, sha256, signManifest, validateManifest, verifyPackage };
