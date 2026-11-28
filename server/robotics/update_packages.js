"use strict";

/**
 * Update packages: what is shipped to a robot's computer (a Robot OS image,
 * the HANNAH runtime, a driver, an application, a configuration, firmware) and
 * how HANNAH decides whether one may go to a given robot.
 *
 * A package is described by a manifest, `hannah-update.json`, signed with
 * Ed25519 by its publisher. The manifest has every field the owner's spec
 * asks for (PART 10):
 *
 *   identity        schema, id (reverse-domain), name, kind, publisher, releasedAt
 *   version         an exact version
 *   targets         hardware (manufacturer + model, or a robot type), operating
 *                   systems, ROS distributions ([] when it doesn't use ROS),
 *                   the runtime versions it works with, and optionally the
 *                   software and firmware versions it was tested on
 *   dependencies    other packages by id and version range
 *   artifacts       every file with its SHA-256 and size (integrity)
 *   signature       { algorithm: "ed25519", keyId, value } over everything else
 *   changelog       what changed
 *   install         instructions, whether the robot must be stopped, whether it reboots
 *   recovery        the procedure, and how it is rolled back (A/B slot,
 *                   previous version, configuration restore, or not at all)
 *   healthChecks    what must pass after installing before it counts as healthy
 *   tests           level, passed, total and where the evidence is
 *   config          (optional) limits the package sets on the robot
 *
 * The same canonical form is signed here and checked on the robot by Robot OS
 * (robot-os/src/hannah_robot_os/updates/package.py). To keep the bytes the
 * same in both languages, numbers are integers, or decimals between 0.0001
 * and 10^15.
 *
 * A publisher key is pinned to the account: a package signed by any other
 * key, by a revoked key, or naming a different publisher than the key's owner
 * is refused. Nothing here installs anything.
 */
const crypto = require("node:crypto");
const semver = require("./semver");
const { canonical, keyIdOf, sha256 } = require("./packages");

const MANIFEST = "hannah-update.json";
const SCHEMA = "hannah-update/1";
const KINDS = {
  "os-image": "Robot OS disk image (A/B slot)",
  runtime: "HANNAH robot runtime",
  driver: "Driver",
  application: "Application",
  configuration: "Configuration",
  firmware: "Firmware for a controller on the robot",
};
const ROLLBACK = {
  "ab-slot": "The boot loader falls back to the other slot; the previous image stays installed.",
  "previous-version": "The previous version is kept on the robot and restored.",
  "config-restore": "The configuration backed up before installing is restored, after it is validated.",
  none: "This package can't be rolled back.",
};
const TEST_LEVELS = ["unit", "simulation", "hardware-in-the-loop", "physical"];
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;
const LIMIT_KEYS = ["maxLinearSpeed", "maxAngularSpeed", "maxLinearAccel", "maxJointSpeed", "robotRadius", "minBatteryPercent", "linkTimeoutS"];

const text = (value) => typeof value === "string" && value.trim().length > 0;
const signedPart = (manifest) => { const { signature: _signature, ...rest } = manifest; return Buffer.from(canonical(rest), "utf8"); };

/** Numbers that print the same in JavaScript and Python. */
function portableNumbers(value, path = "manifest", problems = []) {
  if (typeof value === "number") {
    const ok = Number.isFinite(value) && (Number.isSafeInteger(value) || (Math.abs(value) >= 1e-4 && Math.abs(value) < 1e15));
    if (!ok) problems.push(`${path} must be an integer or a decimal between 0.0001 and 10^15.`);
  } else if (Array.isArray(value)) value.forEach((item, index) => portableNumbers(item, `${path}[${index}]`, problems));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) portableNumbers(item, `${path}.${key}`, problems);
  return problems;
}

function validateManifest(manifest) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["The manifest isn't an object."];
  need(manifest.schema === SCHEMA, `schema must be "${SCHEMA}".`);
  need(ID.test(String(manifest.id || "")), "id must be a reverse-domain name such as org.example.nav-tuning.");
  need(text(manifest.name), "name is required.");
  need(Object.hasOwn(KINDS, manifest.kind), `kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
  need(semver.EXACT.test(String(manifest.version || "")), "version must be an exact version such as 1.4.0.");
  need(text(manifest.publisher), "publisher is required.");
  need(DATE.test(String(manifest.releasedAt || "")), "releasedAt must be a date such as 2026-11-28.");
  const targets = manifest.targets;
  if (!targets || typeof targets !== "object") problems.push("targets is required.");
  else {
    const hardware = Array.isArray(targets.hardware) ? targets.hardware : [];
    need(hardware.length > 0, "targets.hardware must name the hardware it is for.");
    for (const item of hardware) need((text(item?.manufacturer) && text(item?.model)) || text(item?.robotType), "each targets.hardware entry needs a manufacturer and a model, or a robotType.");
    if (["firmware", "driver"].includes(manifest.kind)) need(hardware.every((item) => text(item?.manufacturer) && text(item?.model)), `a ${manifest.kind} package must name an exact manufacturer and model, not only a robot type.`);
    need(Array.isArray(targets.os) && targets.os.length > 0 && targets.os.every((item) => text(item?.name) && (item.range === undefined || semver.validRange(item.range)) && (item.versions === undefined || (Array.isArray(item.versions) && item.versions.every(text)))), "targets.os must list operating systems as { name, versions?, range? }.");
    need(Array.isArray(targets.ros) && targets.ros.every(text), "targets.ros is required: the ROS distributions it works with, or [] when it doesn't use ROS.");
    need(semver.validRange(targets.runtime), "targets.runtime must be a version range for the HANNAH runtime, such as >=0.1.0 <0.3.0 (or *).");
    need(targets.software === undefined || semver.validRange(targets.software), "targets.software must be a version range.");
    need(targets.firmware === undefined || (Array.isArray(targets.firmware) && targets.firmware.every(text)), "targets.firmware must list exact firmware versions.");
  }
  if (!Array.isArray(manifest.dependencies)) problems.push("dependencies is required (an empty list when there are none).");
  else for (const dependency of manifest.dependencies) need(ID.test(String(dependency?.id || "")) && semver.validRange(dependency?.range), `dependency ${String(dependency?.id || "(unnamed)").slice(0, 60)} needs an id and a version range.`);
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) problems.push("artifacts must list every file with its sha256 and size.");
  else for (const file of manifest.artifacts) {
    if (typeof file?.path !== "string" || !file.path || file.path.startsWith("/") || file.path.split("/").includes("..") || !/^[0-9a-f]{64}$/.test(String(file.sha256 || "")) || !Number.isSafeInteger(file.size) || file.size < 0) problems.push(`artifact ${String(file?.path).slice(0, 80)} needs a relative path, a sha256 and a size.`);
  }
  need(text(manifest.changelog), "changelog is required.");
  const install = manifest.install;
  need(install && text(install.instructions) && typeof install.requiresStop === "boolean" && typeof install.reboot === "boolean", "install must give instructions, requiresStop and reboot.");
  const recovery = manifest.recovery;
  need(recovery && text(recovery.procedure) && Object.hasOwn(ROLLBACK, recovery.rollback), `recovery must give a procedure and rollback (${Object.keys(ROLLBACK).join(", ")}).`);
  if (manifest.kind === "os-image" && recovery?.rollback && recovery.rollback !== "ab-slot") problems.push("an os-image package rolls back through its A/B slot (recovery.rollback \"ab-slot\").");
  need(Array.isArray(manifest.healthChecks) && manifest.healthChecks.length > 0 && manifest.healthChecks.every((check) => /^[a-z0-9-]{2,40}$/.test(String(check?.id || "")) && text(check.description) && Number.isSafeInteger(check.timeoutS) && check.timeoutS > 0 && check.timeoutS <= 3600), "healthChecks must list at least one { id, description, timeoutS } (1 to 3600 s).");
  const tests = manifest.tests;
  need(tests && TEST_LEVELS.includes(tests.level) && Number.isSafeInteger(tests.passed) && Number.isSafeInteger(tests.total) && tests.passed <= tests.total && text(tests.evidence), `tests must give level (${TEST_LEVELS.join(", ")}), passed, total and evidence.`);
  if (manifest.config !== undefined) {
    const limits = manifest.config?.limits;
    need(limits && typeof limits === "object" && Object.keys(limits).length > 0 && Object.entries(limits).every(([key, value]) => LIMIT_KEYS.includes(key) && typeof value === "number" && value > 0), `config.limits may set: ${LIMIT_KEYS.join(", ")} (positive numbers).`);
  }
  if (manifest.kind === "configuration") need(manifest.config !== undefined, "a configuration package must say what it sets (config.limits).");
  problems.push(...portableNumbers(manifest));
  const signature = manifest.signature;
  need(signature && signature.algorithm === "ed25519" && typeof signature.keyId === "string" && typeof signature.value === "string", "signature must be { algorithm: \"ed25519\", keyId, value }.");
  return problems;
}

/** Sign a manifest (publisher side). `privateKey` is a PEM or KeyObject. */
function signManifest(manifest, privateKey, keyId) {
  // Signed as it will travel: through JSON, so a key set to undefined is dropped here too.
  const { signature: _old, ...rest } = JSON.parse(JSON.stringify(manifest));
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  const id = keyId || keyIdOf(crypto.createPublicKey(key));
  return { ...rest, signature: { algorithm: "ed25519", keyId: id, value: crypto.sign(null, signedPart(rest), key).toString("base64") } };
}

/**
 * The signature and the publisher. `trustedKeys` are the keys pinned to the
 * account: [{ keyId, publicKey (PEM), owner, revokedAt? }].
 */
function verifySignature(manifest, trustedKeys = []) {
  const keyId = manifest?.signature?.keyId;
  const key = trustedKeys.find((item) => item.keyId === keyId);
  const signature = { id: "signature", ok: false, detail: "" };
  const publisher = { id: "publisher", ok: false, detail: "" };
  if (!key) {
    signature.detail = `Signed with a key that isn't pinned to this account (${String(keyId || "none").slice(0, 32)}).`;
    publisher.detail = "Unknown: the key isn't pinned.";
    return { signature, publisher, key: null };
  }
  if (key.revokedAt) {
    signature.detail = `Signed with a key that was revoked on ${new Date(Number(key.revokedAt)).toISOString().slice(0, 10)}.`;
    publisher.detail = `${key.owner}'s key is revoked.`;
    return { signature, publisher, key };
  }
  let valid = false;
  try { valid = crypto.verify(null, signedPart(manifest), key.publicKey, Buffer.from(String(manifest.signature.value), "base64")); } catch { valid = false; }
  signature.ok = valid;
  signature.detail = valid ? `Valid Ed25519 signature by key ${key.keyId}.` : "The signature doesn't match: the manifest was changed after signing, or signed with another key.";
  publisher.ok = valid && String(manifest.publisher || "").trim().toLowerCase() === String(key.owner || "").trim().toLowerCase();
  publisher.detail = !valid ? "Not checked: the signature is invalid." : publisher.ok ? `Published by ${key.owner}, the owner of the pinned key.` : `The manifest says it is from “${String(manifest.publisher).slice(0, 80)}”, but the key is pinned to ${key.owner}.`;
  return { signature, publisher, key };
}

/** Files against the manifest, when the server has them. `files`: { path: Buffer }. */
function verifyArtifacts(manifest, files = {}) {
  const problems = [];
  const listed = new Map(manifest.artifacts.map((file) => [file.path, file]));
  for (const [path, file] of listed) {
    const bytes = files[path];
    if (!bytes) problems.push(`Listed but missing: ${path}.`);
    else if (bytes.length !== file.size || sha256(bytes) !== file.sha256) problems.push(`Changed since it was signed: ${path}.`);
  }
  for (const path of Object.keys(files)) if (!listed.has(path)) problems.push(`Not listed in the manifest: ${path}.`);
  return { ok: problems.length === 0, problems };
}

const lower = (value) => String(value ?? "").trim().toLowerCase();

/** Does the robot, as it reported itself, match what the package targets? */
function compatibility(manifest, robot) {
  const targets = manifest.targets;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  const hardware = targets.hardware.find((item) => (item.manufacturer ? lower(item.manufacturer) === lower(robot.manufacturer) && lower(item.model) === lower(robot.model) : true) && (item.robotType ? item.robotType === robot.robotType : true));
  add("hardware", Boolean(hardware), hardware ? `Made for ${hardware.manufacturer ? `${hardware.manufacturer} ${hardware.model}` : hardware.robotType}; the robot reports ${robot.manufacturer || "?"} ${robot.model || "?"} (${robot.robotType || "?"}).` : `Made for ${targets.hardware.map((item) => item.manufacturer ? `${item.manufacturer} ${item.model}` : item.robotType).join(", ")}; the robot reports ${robot.manufacturer || "no manufacturer"} ${robot.model || "no model"} (${robot.robotType || "no type"}).`);
  const reportedOs = String(robot.os || "");
  const os = targets.os.find((item) => {
    if (!lower(reportedOs).includes(lower(item.name))) return false;
    if (item.versions && !item.versions.some((version) => new RegExp(`(^|[^0-9.])${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9]|$)`).test(reportedOs))) return false;
    if (item.range) {
      const found = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(reportedOs.slice(lower(reportedOs).indexOf(lower(item.name)) + item.name.length));
      if (!found || !semver.satisfies(found[1], item.range)) return false;
    }
    return true;
  });
  add("os", Boolean(os), os ? `The robot runs ${reportedOs}.` : `It needs ${targets.os.map((item) => `${item.name}${item.versions ? ` ${item.versions.join("/")}` : ""}${item.range ? ` ${item.range}` : ""}`).join(" or ")}; the robot reports ${reportedOs || "no operating system"}.`);
  if (!targets.ros.length) add("ros", true, "Doesn't use ROS.");
  else add("ros", targets.ros.includes(lower(robot.rosDistro)), targets.ros.includes(lower(robot.rosDistro)) ? `ROS 2 ${robot.rosDistro}.` : `It needs ROS 2 ${targets.ros.join(" or ")}; the robot reports ${robot.rosDistro || "no ROS"}.`);
  add("runtime", semver.satisfies(robot.runtimeVersion, targets.runtime), semver.satisfies(robot.runtimeVersion, targets.runtime) ? `Runtime ${robot.runtimeVersion} is in ${targets.runtime}.` : `It needs runtime ${targets.runtime}; the robot reports ${robot.runtimeVersion || "no runtime version"}.`);
  if (targets.software) add("software", semver.satisfies(robot.softwareVersion, targets.software), semver.satisfies(robot.softwareVersion, targets.software) ? `Software ${robot.softwareVersion} is in ${targets.software}.` : `It needs software ${targets.software}; the robot reports ${robot.softwareVersion || "none"}.`);
  if (targets.firmware) add("firmware", targets.firmware.includes(robot.firmwareVersion), targets.firmware.includes(robot.firmwareVersion) ? `Tested with firmware ${robot.firmwareVersion}.` : `Tested with firmware ${targets.firmware.join(", ")}; the robot reports ${robot.firmwareVersion || "none"}.`);
  if (manifest.kind !== "os-image" && manifest.version && robot.installed?.[manifest.id] && semver.compare(manifest.version, robot.installed[manifest.id]) <= 0) add("version", false, `The robot already has ${manifest.id} ${robot.installed[manifest.id]}; this is ${manifest.version}. Downgrades go through rollback.`);
  return { ok: checks.every((check) => check.ok), checks };
}

/**
 * Dependencies, depth first. `available` is every package manifest in the
 * account; `installed` is { id: version } on the robot. Returns the packages
 * to install before this one, in order, or the problems.
 */
function resolveDependencies(manifest, { available = [], installed = {} } = {}) {
  const problems = [];
  const order = [];
  const visiting = new Set();
  const done = new Set();
  const visit = (item, path) => {
    for (const dependency of item.dependencies || []) {
      if (installed[dependency.id] && semver.satisfies(installed[dependency.id], dependency.range)) {
        if (!order.some((entry) => entry.id === dependency.id)) order.push({ id: dependency.id, version: installed[dependency.id], source: "installed" });
        continue;
      }
      if (visiting.has(dependency.id)) { problems.push(`Dependency cycle: ${[...path, dependency.id].join(" → ")}.`); continue; }
      const versions = available.filter((candidate) => candidate.id === dependency.id).map((candidate) => candidate.version);
      const version = semver.maxSatisfying(versions, dependency.range);
      if (!version) {
        problems.push(installed[dependency.id] ? `${item.id} needs ${dependency.id} ${dependency.range}; the robot has ${installed[dependency.id]} and no matching package is available.` : `${item.id} needs ${dependency.id} ${dependency.range}; no matching package is available.`);
        continue;
      }
      if (done.has(`${dependency.id}@${version}`)) continue;
      visiting.add(dependency.id);
      visit(available.find((candidate) => candidate.id === dependency.id && candidate.version === version), [...path, dependency.id]);
      visiting.delete(dependency.id);
      done.add(`${dependency.id}@${version}`);
      order.push({ id: dependency.id, version, source: "package" });
    }
  };
  visiting.add(manifest.id);
  visit(manifest, [manifest.id]);
  return { ok: problems.length === 0, order, problems };
}

/** How this package can be undone on this robot, if at all. */
function rollbackAvailability(manifest, robot, { backup = null, previous = null } = {}) {
  const how = manifest.recovery.rollback;
  if (how === "none") return { ok: false, how, detail: ROLLBACK.none };
  if (how === "ab-slot") {
    const ok = Boolean(robot.robotOS);
    return { ok, how, detail: ok ? ROLLBACK["ab-slot"] : "It rolls back through the A/B slots of a Robot OS image; this robot hasn't reported Robot OS update state." };
  }
  if (how === "config-restore") return { ok: Boolean(backup), how, detail: backup ? `${ROLLBACK["config-restore"]} Backup ${backup.id} taken ${new Date(backup.at).toISOString()}.` : "Needs a configuration backup first." };
  return { ok: Boolean(previous), how, detail: previous ? `${ROLLBACK["previous-version"]} The previous version is ${previous}.` : "The robot has no earlier version of this package to go back to." };
}

/** Configuration the package sets, against what the robot was commissioned with. */
function configCheck(manifest, robot) {
  const limits = manifest.config?.limits;
  if (!limits) return { id: "config", ok: true, detail: "It doesn't change the robot's limits.", recommission: false };
  const reported = robot.safety?.reported || robot.limits || {};
  const raised = Object.entries(limits).filter(([key, value]) => key !== "minBatteryPercent" && typeof reported[key] === "number" && value > reported[key] + 1e-9);
  if (raised.length) return { id: "config", ok: false, recommission: !robot.simulated, detail: `It raises ${raised.map(([key, value]) => `${key} from ${reported[key]} to ${value}`).join(", ")}. Limits can only be raised on the robot itself, and a physical robot is then commissioned again.` };
  return { id: "config", ok: true, recommission: false, detail: `Sets ${Object.entries(limits).map(([key, value]) => `${key} ${value}`).join(", ")}, within the limits the robot reported.` };
}

/**
 * Everything PART 10 asks to be checked before a package goes to a robot:
 * signature, publisher, compatibility, dependencies, tests, configuration,
 * backup, rollback availability and approval. Each check says what it found.
 */
function validate(manifest, { robot, trustedKeys = [], available = [], installed = {}, backup = null, previous = null, approval = null, files = null } = {}) {
  const problems = validateManifest(manifest);
  if (problems.length) return { ok: false, problems, checks: [{ id: "manifest", ok: false, detail: problems.join(" ") }] };
  const { signature, publisher } = verifySignature(manifest, trustedKeys);
  const checks = [{ id: "manifest", ok: true, detail: `${manifest.name} ${manifest.version} (${KINDS[manifest.kind]}).` }, signature, publisher];
  if (files) {
    const integrity = verifyArtifacts(manifest, files);
    checks.push({ id: "integrity", ok: integrity.ok, detail: integrity.ok ? `${manifest.artifacts.length} file(s) match their SHA-256.` : integrity.problems.join(" ") });
  } else checks.push({ id: "integrity", ok: true, detail: `${manifest.artifacts.length} file(s) listed with their SHA-256; the robot checks each one before it stages anything.` });
  if (robot) {
    const compatible = compatibility(manifest, { ...robot, installed });
    checks.push({ id: "compatibility", ok: compatible.ok, detail: compatible.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.detail}`).join(" "), items: compatible.checks });
  }
  const deps = resolveDependencies(manifest, { available, installed });
  checks.push({ id: "dependencies", ok: deps.ok, detail: deps.ok ? (deps.order.length ? `Needs ${deps.order.map((item) => `${item.id} ${item.version}${item.source === "installed" ? " (installed)" : ""}`).join(", ")}.` : "No dependencies.") : deps.problems.join(" "), order: deps.order });
  const tests = manifest.tests;
  const testsOk = tests.passed === tests.total && tests.total > 0;
  checks.push({ id: "tests", ok: testsOk, detail: `${tests.passed} of ${tests.total} tests passed, ${tests.level}${["unit", "simulation"].includes(tests.level) ? " (not shown on hardware)" : ""}. Evidence: ${tests.evidence}.` });
  if (robot) {
    const config = configCheck(manifest, robot);
    checks.push(config);
    const needsBackup = manifest.recovery.rollback === "config-restore" || Boolean(manifest.config);
    checks.push({ id: "backup", ok: !needsBackup || Boolean(backup), detail: backup ? `Configuration backup ${backup.id} taken.` : needsBackup ? "A configuration backup is taken when the rollout starts on this robot." : "Nothing to back up on the server side; the robot keeps its current slot." , pending: needsBackup && !backup });
    const rollback = rollbackAvailability(manifest, robot, { backup: backup || (needsBackup ? { id: "taken at rollout", at: Date.now() } : null), previous });
    checks.push({ id: "rollback", ok: rollback.ok, detail: rollback.detail, how: rollback.how });
  }
  checks.push({ id: "approval", ok: Boolean(approval), detail: approval ? `Approved by ${approval.by} on ${new Date(approval.at).toISOString()}.` : "A signed-in person must approve it.", pending: !approval });
  // Approval and a backup that is taken when the rollout starts are pending, not failures. Everything else must hold.
  const blocking = checks.filter((check) => !check.ok && !check.pending);
  return { ok: blocking.length === 0, problems: blocking.map((check) => check.detail), checks };
}

module.exports = { KINDS, LIMIT_KEYS, MANIFEST, ROLLBACK, SCHEMA, TEST_LEVELS, compatibility, configCheck, keyIdOf, portableNumbers, resolveDependencies, rollbackAvailability, signManifest, signedPart, validate, validateManifest, verifyArtifacts, verifySignature };
