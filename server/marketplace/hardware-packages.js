"use strict";

/**
 * Hardware marketplace packages: signed, checked, installed with only what
 * they declare, revocable and rolled back.
 *
 * A package is a manifest (`hannah-package.json`, formatVersion 2) and the
 * files it lists. The manifest carries every field the marketplace shows:
 * id, name, author, publisher (and the key that signed it), version, kind,
 * compatibility, dependencies, permissions, hardware interfaces, safety
 * constraints, integrity (each file's SHA-256 and size), documentation, test
 * results and a changelog. It is signed with Ed25519 over its canonical JSON
 * (the same scheme as robot packages, robotics/packages.js).
 *
 * verify() answers, from the package alone and what the account trusts:
 *   1. complete and well-formed manifest
 *   2. signature by a publisher key the account added and hasn't revoked, and
 *      the publisher named in the manifest is that key's owner
 *   3. files exactly as listed
 *   4. dependencies present at a version that satisfies the manifest, no cycle
 *   5. only known permissions; anything touching hardware declares the
 *      interfaces it uses; code that runs on a robot states safety constraints
 *   6. security findings from reading the files: raw actuator commands,
 *      process spawning, device paths or network use it didn't declare
 *   7. not revoked
 * Install grants exactly the declared permissions and hardware interfaces;
 * authorizeHardwareAccess() refuses (and audits) everything else.
 *
 * Status shown is factual: "developer-published" unless test results say
 * what was tested, on what and where. There are no certification badges.
 */
const crypto = require("node:crypto");
const { canonical, keyIdOf, sha256 } = require("../robotics/packages");

const MANIFEST = "hannah-package.json";
const KINDS = {
  "robot-adapter": { label: "Robot adapter", runsCode: true },
  "sensor-integration": { label: "Sensor integration", runsCode: true },
  driver: { label: "Driver", runsCode: true },
  "interop-connector": { label: "Interop connector", runsCode: true },
  "diagnostic-extension": { label: "Diagnostic extension", runsCode: true },
  "maintenance-rule": { label: "Maintenance rule", runsCode: false },
  "mission-skill": { label: "Mission skill", runsCode: true },
  "simulation-scenario": { label: "Simulation scenario", runsCode: false },
  "teleop-interface": { label: "Teleoperation interface", runsCode: true },
  "update-package": { label: "Update package", runsCode: true },
  "hardware-profile": { label: "Hardware profile", runsCode: false },
  "workflow-template": { label: "Workflow template", runsCode: false },
};
const PERMISSIONS = {
  "read-state": { label: "Read the robot's state", hardware: false, risk: "low" },
  "read-sensors": { label: "Read sensors", hardware: false, risk: "low" },
  "hardware-access": { label: "Open hardware interfaces it declares (serial, CAN, USB, GPIO…)", hardware: true, risk: "high" },
  navigation: { label: "Send goals to the navigation stack", hardware: false, risk: "moderate" },
  manipulation: { label: "Send goals to the manipulation planner", hardware: false, risk: "high" },
  teleoperation: { label: "Take manual control through the teleoperation safeguards", hardware: false, risk: "high" },
  "network-local": { label: "Talk to devices on the robot's own network", hardware: false, risk: "moderate" },
  "network-internet": { label: "Reach the internet", hardware: false, risk: "high" },
  filesystem: { label: "Read and write its own data directory", hardware: false, risk: "moderate" },
  "workflow-run": { label: "Start workflows a person approved", hardware: false, risk: "moderate" },
};
const INTERFACES = ["serial", "can", "usb", "gpio", "i2c", "spi", "camera", "audio", "network"];
const TEST_LEVELS = ["unit", "simulation", "hardware-in-the-loop", "physical"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const FORBIDDEN = /\b(pwm|duty_cycle|motor_command|actuator_command|raw_torque|set_torque|write_register)\b/i;
const SPAWN = /\b(child_process|subprocess|os\.system|exec\(|popen|spawn\()/;
const DEVICE_PATH = /\/dev\/[A-Za-z0-9_\-/.]+/g;
const URL = /\bhttps?:\/\/[^\s"'`)]+/g;

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const parse = (text, fallback = null) => { try { return text ? JSON.parse(text) ?? fallback : fallback; } catch { return fallback; } };
const signedPart = (manifest) => { const { signature: _signature, ...rest } = manifest; return Buffer.from(canonical(rest), "utf8"); };

function compareVersions(a, b) {
  const x = SEMVER.exec(a); const y = SEMVER.exec(b);
  for (let index = 1; index <= 3; index += 1) { const diff = Number(x[index]) - Number(y[index]); if (diff) return Math.sign(diff); }
  if (x[4] && !y[4]) return -1;
  if (!x[4] && y[4]) return 1;
  return String(x[4] || "").localeCompare(String(y[4] || ""));
}
/** "1.2.3" exact, ">=1.2.0", "^1.2.0" (same major), "~1.2.0" (same minor). */
function satisfies(version, range) {
  if (!SEMVER.test(version)) return false;
  const match = /^(>=|\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(range || ""));
  if (!match) return false;
  const [, op, base] = match;
  const [major, minor] = base.split(".").map(Number);
  const [vMajor, vMinor] = version.split(".").map(Number);
  if (!op) return compareVersions(version, base) === 0;
  if (compareVersions(version, base) < 0) return false;
  if (op === "^") return vMajor === major;
  if (op === "~") return vMajor === major && vMinor === minor;
  return true;
}
/** Does a hardware path match a declared pattern ("/dev/ttyUSB*", "can0")? */
function interfaceMatches(pattern, value) {
  const source = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`).test(String(value));
}

function validateManifest(manifest) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["The manifest isn't an object."];
  need(manifest.formatVersion === 2, "formatVersion must be 2.");
  need(ID.test(String(manifest.id || "")), "id must be a reverse-domain name such as org.example.lidar-driver.");
  need(typeof manifest.name === "string" && manifest.name.trim(), "name is required.");
  need(typeof manifest.author === "string" && manifest.author.trim(), "author is required.");
  need(manifest.publisher && typeof manifest.publisher.name === "string" && typeof manifest.publisher.keyId === "string", "publisher { name, keyId } is required.");
  need(SEMVER.test(String(manifest.version || "")), "version must be an exact version such as 1.2.0.");
  need(Object.hasOwn(KINDS, manifest.kind), `kind must be one of: ${Object.keys(KINDS).join(", ")}.`);
  need(typeof manifest.description === "string" && manifest.description.trim(), "description is required.");
  const compatibility = manifest.compatibility;
  need(compatibility && Array.isArray(compatibility.robotTypes) && Array.isArray(compatibility.hardware) && Array.isArray(compatibility.operatingSystems) && Array.isArray(compatibility.rosDistributions), "compatibility { robotTypes, hardware, operatingSystems, rosDistributions } is required (empty lists mean any).");
  if (compatibility?.hannahMin !== undefined) need(SEMVER.test(String(compatibility.hannahMin)), "compatibility.hannahMin must be a version.");
  if (!Array.isArray(manifest.dependencies)) problems.push("dependencies is required (an empty list when there are none).");
  else for (const dependency of manifest.dependencies) need(dependency && ID.test(String(dependency.id || "")) && /^(>=|\^|~)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(dependency.version || "")), `dependency ${dependency?.id || "(unnamed)"} needs an id and a version or range (1.2.3, >=1.2.3, ^1.2.3, ~1.2.3).`);
  if (!Array.isArray(manifest.permissions)) problems.push("permissions is required (an empty list when it needs none).");
  else for (const permission of manifest.permissions) need(Object.hasOwn(PERMISSIONS, permission), `“${String(permission).slice(0, 40)}” isn't a permission HANNAH knows.`);
  if (!Array.isArray(manifest.hardwareInterfaces)) problems.push("hardwareInterfaces is required (an empty list when it opens none).");
  else for (const item of manifest.hardwareInterfaces) need(item && INTERFACES.includes(item.type) && typeof item.match === "string" && item.match.length <= 120 && !item.match.includes(".."), `hardware interface ${JSON.stringify(item).slice(0, 80)} needs a type (${INTERFACES.join(", ")}) and a match such as /dev/ttyUSB*.`);
  const touchesHardware = Array.isArray(manifest.hardwareInterfaces) && manifest.hardwareInterfaces.some((item) => item?.type !== "network");
  if (touchesHardware && Array.isArray(manifest.permissions) && !manifest.permissions.includes("hardware-access")) problems.push("It declares hardware interfaces but not the hardware-access permission.");
  if (Array.isArray(manifest.permissions) && manifest.permissions.includes("hardware-access") && !touchesHardware) problems.push("It asks for hardware-access without declaring which interfaces it opens.");
  need(Array.isArray(manifest.safetyConstraints), "safetyConstraints is required.");
  if (KINDS[manifest.kind]?.runsCode && Array.isArray(manifest.safetyConstraints) && !manifest.safetyConstraints.length) problems.push("A package that runs code on a robot must state its safety constraints.");
  need(typeof manifest.documentation === "string" && manifest.documentation.trim(), "documentation is required.");
  if (!Array.isArray(manifest.testResults)) problems.push("testResults is required (an empty list when it wasn't tested).");
  else for (const result of manifest.testResults) need(result && TEST_LEVELS.includes(result.level) && Number.isInteger(result.passed) && Number.isInteger(result.total) && result.passed <= result.total && typeof result.target === "string" && typeof result.environment === "string", `each test result needs level (${TEST_LEVELS.join(", ")}), target, environment, passed and total.`);
  need(Array.isArray(manifest.changelog) && manifest.changelog.some((entry) => entry?.version === manifest.version), "changelog must have an entry for this version.");
  const files = manifest.integrity?.files;
  if (!Array.isArray(files) || !files.length) problems.push("integrity.files must list every file with its sha256 and size.");
  else for (const file of files) need(typeof file?.path === "string" && !file.path.startsWith("/") && !file.path.split("/").includes("..") && file.path !== MANIFEST && /^[0-9a-f]{64}$/.test(String(file.sha256 || "")) && Number.isInteger(file.size), `file entry ${String(file?.path).slice(0, 80)} needs a relative path, a sha256 and a size.`);
  const signature = manifest.signature;
  need(signature && signature.algorithm === "ed25519" && typeof signature.keyId === "string" && typeof signature.value === "string", "signature must be { algorithm: \"ed25519\", keyId, value }.");
  if (signature && manifest.publisher && signature.keyId !== manifest.publisher.keyId) problems.push("The signature's key isn't the publisher's key.");
  return problems;
}

/** Sign a manifest (publisher side). */
function signManifest(manifest, privateKey) {
  const { signature: _old, ...rest } = manifest;
  const keyId = keyIdOf(crypto.createPublicKey(privateKey));
  const body = { ...rest, publisher: { ...rest.publisher, keyId } };
  return { ...body, signature: { algorithm: "ed25519", keyId, value: crypto.sign(null, signedPart(body), privateKey).toString("base64") } };
}

/** Findings from reading the files. Not proof of safety: it finds what it looks for. */
function securityFindings(manifest, files) {
  const findings = [];
  const declaredDevices = (manifest.hardwareInterfaces || []).filter((item) => item.type !== "network").map((item) => item.match);
  const network = (manifest.permissions || []).some((item) => item === "network-internet" || item === "network-local");
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes.length > 2_000_000) continue;
    const text = bytes.toString("utf8");
    if (FORBIDDEN.test(text)) findings.push({ severity: "error", file: path, finding: "Writes raw actuator values (PWM, torque, registers). HANNAH sends goals, never actuator values." });
    if (SPAWN.test(text)) findings.push({ severity: "warning", file: path, finding: "Starts other processes. That is outside what its permissions describe; review it." });
    for (const device of new Set(text.match(DEVICE_PATH) || [])) if (!declaredDevices.some((pattern) => interfaceMatches(pattern, device))) findings.push({ severity: "error", file: path, finding: `Opens ${device}, which it doesn't declare in hardwareInterfaces.` });
    if (!network && (text.match(URL) || []).some((url) => !/^https?:\/\/(localhost|127\.0\.0\.1|example\.(com|org|test))/.test(url))) findings.push({ severity: "warning", file: path, finding: "Mentions network addresses but asks for no network permission." });
  }
  return findings;
}

/** What the marketplace shows. Facts only: who tested what, on what, where. */
function marketplaceStatus(manifest) {
  const tests = (manifest.testResults || []).filter((item) => item && item.total > 0);
  if (!tests.length) return { kind: "developer-published", label: "Developer-published", detail: "Published by its developer. No test results were supplied." };
  return {
    kind: "compatibility-tested", label: "Compatibility tested",
    detail: tests.map((item) => `${item.level} on ${item.target} in ${item.environment}: ${item.passed}/${item.total} passed${item.by ? `, by ${item.by}` : ", reported by the developer"}`).join("; "),
    tested: tests.map((item) => ({ level: item.level, target: item.target, environment: item.environment, passed: item.passed, total: item.total, by: item.by || "developer", evidence: item.evidence || null })),
    note: "These are the developer's own reports, not a HANNAH certification.",
  };
}

/** Is a package for this robot? `robot` is a robotics or interop view. Returns { compatible, reasons }. */
function compatibilityWith(manifest, robot, { hannahVersion = null } = {}) {
  const reasons = [];
  const c = manifest.compatibility || {};
  const type = robot?.robotType || robot?.identity?.model || null;
  if (c.robotTypes?.length && !c.robotTypes.includes(robot?.robotType)) reasons.push(`It is made for ${c.robotTypes.join(", ")}; this robot is ${type || "of an unknown type"}.`);
  if (c.rosDistributions?.length && robot?.rosDistro && !c.rosDistributions.includes(robot.rosDistro)) reasons.push(`It supports ROS ${c.rosDistributions.join(", ")}; this robot runs ${robot.rosDistro}.`);
  if (c.rosDistributions?.length && !robot?.rosDistro) reasons.push("It needs ROS; this robot reports none.");
  if (c.operatingSystems?.length && robot?.os && !c.operatingSystems.some((os) => String(robot.os).toLowerCase().includes(String(os).toLowerCase()))) reasons.push(`It supports ${c.operatingSystems.join(", ")}; this robot runs ${robot.os}.`);
  if (c.hardware?.length) {
    const have = [robot?.manufacturer, robot?.model, ...(robot?.sensors || []).map((item) => `${item.type}`), ...(robot?.actuators || []).map((item) => `${item.type}`)].filter(Boolean).map((item) => String(item).toLowerCase());
    const missing = c.hardware.filter((item) => !have.some((value) => value.includes(String(item).toLowerCase())));
    if (missing.length) reasons.push(`It needs ${missing.join(", ")}, which this robot doesn't report.`);
  }
  if (c.hannahMin && hannahVersion && SEMVER.test(hannahVersion) && compareVersions(hannahVersion, c.hannahMin) < 0) reasons.push(`It needs HANNAH ${c.hannahMin} or newer.`);
  return { compatible: reasons.length === 0, reasons };
}

/**
 * Check a package.
 *   files         { path: Buffer } everything but the manifest
 *   trustedKeys   [{ keyId, owner, publicKey, revokedAt }]
 *   available     [{ id, version }] packages present (installed or uploaded) for dependency checks
 *   revoked       [{ packageId, version ('*' = all) }]
 */
function verify({ manifest, files = {}, trustedKeys = [], available = [], revoked = [] }) {
  const problems = validateManifest(manifest);
  const result = { ok: false, problems, findings: [], signedBy: null, review: null, status: null };
  if (problems.length) return result;
  const key = trustedKeys.find((item) => item.keyId === manifest.signature.keyId);
  if (!key) problems.push(`Signed with a key you don't trust (${manifest.signature.keyId}). Add the publisher's key first.`);
  else if (key.revokedAt) problems.push(`Signed with a key revoked on ${new Date(Number(key.revokedAt)).toISOString().slice(0, 10)}.`);
  else if ((() => { try { return keyIdOf(key.publicKey) !== key.keyId; } catch { return true; } })()) problems.push(`The trusted key stored as ${key.keyId} isn't the key with that id. Add the publisher's key again.`);
  else {
    let valid = false;
    try { valid = crypto.verify(null, signedPart(manifest), key.publicKey, Buffer.from(manifest.signature.value, "base64")); } catch { valid = false; }
    if (!valid) problems.push("The signature doesn't match the manifest: it changed after signing, or another key signed it.");
    else if (String(key.owner).trim().toLowerCase() !== String(manifest.publisher.name).trim().toLowerCase()) problems.push(`The manifest names “${manifest.publisher.name}” as publisher, but the key belongs to “${key.owner}”.`);
    else result.signedBy = key.owner;
  }
  const listed = new Map(manifest.integrity.files.map((file) => [file.path, file]));
  for (const [path, file] of listed) {
    const bytes = files[path];
    if (!bytes) problems.push(`Listed but missing: ${path}.`);
    else if (bytes.length !== file.size || sha256(bytes) !== file.sha256) problems.push(`Changed since it was signed: ${path}.`);
  }
  for (const path of Object.keys(files)) if (!listed.has(path)) problems.push(`Not listed in the manifest: ${path}.`);
  for (const dependency of manifest.dependencies) {
    if (dependency.id === manifest.id) { problems.push("It depends on itself."); continue; }
    const candidates = available.filter((item) => item.id === dependency.id);
    if (!candidates.some((item) => satisfies(item.version, dependency.version))) problems.push(`Needs ${dependency.id} ${dependency.version}, which isn't available${candidates.length ? ` (have ${candidates.map((item) => item.version).join(", ")})` : ""}.`);
    if (candidates.some((item) => (item.dependencies || []).some((inner) => inner.id === manifest.id))) problems.push(`${dependency.id} depends back on this package (a cycle).`);
  }
  if (revoked.some((item) => item.packageId === manifest.id && (item.version === "*" || item.version === manifest.version))) problems.push(`${manifest.id} ${manifest.version} was revoked.`);
  result.findings = securityFindings(manifest, files);
  for (const finding of result.findings.filter((item) => item.severity === "error")) problems.push(`${finding.file}: ${finding.finding}`);
  result.status = marketplaceStatus(manifest);
  result.review = {
    id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind, kindLabel: KINDS[manifest.kind].label, author: manifest.author, publisher: manifest.publisher.name,
    runsCodeOnRobot: KINDS[manifest.kind].runsCode,
    permissions: manifest.permissions.map((id) => ({ id, ...PERMISSIONS[id] })), hardwareInterfaces: manifest.hardwareInterfaces,
    safetyConstraints: manifest.safetyConstraints, dependencies: manifest.dependencies, compatibility: manifest.compatibility,
    risk: manifest.permissions.some((id) => PERMISSIONS[id].risk === "high") ? "high" : KINDS[manifest.kind].runsCode ? "moderate" : "low",
    warnings: [
      ...(KINDS[manifest.kind].runsCode && !manifest.testResults.some((item) => ["hardware-in-the-loop", "physical"].includes(item.level)) ? ["No hardware test results: it hasn't been shown to work on hardware."] : []),
      ...manifest.testResults.filter((item) => item.passed < item.total).map((item) => `${item.total - item.passed} of its ${item.level} tests on ${item.target} fail.`),
    ],
  };
  result.ok = problems.length === 0;
  return result;
}

// ---------- the account's store ----------
function createHardwarePackageService({ now = () => Date.now(), trust = null, robots = null, hannahVersion = null } = {}) {
  const trustedKeys = async (db, userId) => (await db.query("SELECT key_id, owner, public_key, revoked_at FROM hannah_publisher_keys WHERE user_id = $1", [userId])).rows.map((row) => ({ keyId: row.key_id, owner: row.owner, publicKey: row.public_key, revokedAt: row.revoked_at ? Number(row.revoked_at) : null }));
  const revocations = async (db, userId) => (await db.query("SELECT package_id, version, reason, revoked_at FROM hannah_hw_revocations WHERE user_id = $1", [userId])).rows.map((row) => ({ packageId: row.package_id, version: row.version, reason: row.reason, revokedAt: Number(row.revoked_at) }));
  const stored = async (db, userId) => (await db.query("SELECT package_id, version, manifest FROM hannah_hw_packages WHERE user_id = $1", [userId])).rows.map((row) => { const manifest = parse(row.manifest, {}); return { id: row.package_id, version: row.version, dependencies: manifest.dependencies || [] }; });
  const decodeFiles = (input = {}) => {
    const files = {};
    for (const [path, value] of Object.entries(input).slice(0, 500)) files[path] = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "base64");
    return files;
  };
  async function check(db, userId, manifest, files) {
    return verify({ manifest, files, trustedKeys: await trustedKeys(db, userId), available: await stored(db, userId), revoked: await revocations(db, userId) });
  }
  const audit = (db, entry) => (trust ? trust.audit(db, entry).catch(() => {}) : Promise.resolve());

  /** Check a package and, when it passes, keep it in the account's store. A failing package is never stored. */
  async function upload(db, userId, { manifest, files }) {
    const decoded = decodeFiles(files);
    const report = await check(db, userId, manifest, decoded);
    if (!report.ok) {
      await audit(db, { userId, deviceId: null, kind: "package-verify", decision: "refused", reason: `${manifest?.id || "package"} ${manifest?.version || ""}: ${report.problems.slice(0, 3).join(" ")}`.slice(0, 400) });
      return { stored: false, ...report };
    }
    await db.query("INSERT INTO hannah_hw_packages (user_id, package_id, version, kind, manifest, files, publisher_key_id, verification, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (user_id, package_id, version) DO NOTHING",
      [userId, manifest.id, manifest.version, manifest.kind, JSON.stringify(manifest), JSON.stringify(Object.fromEntries(Object.entries(decoded).map(([path, bytes]) => [path, bytes.toString("base64")]))), manifest.signature.keyId, JSON.stringify({ ...report, checkedAt: now() }), now()]);
    return { stored: true, ...report };
  }
  async function packageRow(db, userId, id, version) {
    const row = (await db.query("SELECT * FROM hannah_hw_packages WHERE user_id = $1 AND package_id = $2 AND version = $3", [userId, id, version])).rows[0];
    if (!row) throw fail(404, `${id} ${version} isn't in your packages.`, "not-found");
    return row;
  }
  async function list(db, userId) {
    const packages = (await db.query("SELECT package_id, version, kind, manifest, verification, created_at FROM hannah_hw_packages WHERE user_id = $1 ORDER BY package_id, created_at", [userId])).rows;
    const installs = (await db.query("SELECT * FROM hannah_hw_installs WHERE user_id = $1", [userId])).rows;
    const revoked = await revocations(db, userId);
    return packages.map((row) => {
      const manifest = parse(row.manifest, {});
      const isRevoked = revoked.find((item) => item.packageId === row.package_id && (item.version === "*" || item.version === row.version));
      return {
        id: row.package_id, version: row.version, kind: row.kind, kindLabel: KINDS[row.kind]?.label || row.kind, name: manifest.name, author: manifest.author, publisher: manifest.publisher?.name, description: manifest.description,
        compatibility: manifest.compatibility, dependencies: manifest.dependencies, permissions: manifest.permissions, hardwareInterfaces: manifest.hardwareInterfaces, safetyConstraints: manifest.safetyConstraints,
        documentation: manifest.documentation, changelog: manifest.changelog, testResults: manifest.testResults, integrity: { files: manifest.integrity?.files?.length || 0 },
        status: marketplaceStatus(manifest), verification: parse(row.verification, {}), revoked: isRevoked ? { reason: isRevoked.reason, at: isRevoked.revokedAt } : null,
        installedOn: installs.filter((item) => item.package_id === row.package_id && item.version === row.version && item.status === "active").map((item) => item.target),
      };
    });
  }
  async function listInstalls(db, userId) {
    return (await db.query("SELECT * FROM hannah_hw_installs WHERE user_id = $1 ORDER BY updated_at DESC", [userId])).rows.map((row) => ({ packageId: row.package_id, target: row.target, version: row.version, previousVersion: row.previous_version, permissions: parse(row.permissions, []), interfaces: parse(row.interfaces, []), status: row.status, history: parse(row.history, []), installedAt: Number(row.installed_at), updatedAt: Number(row.updated_at) }));
  }

  /** Everything that would stop an install now. The action engine calls this before asking and again before installing. */
  async function assessInstall(db, userId, { packageId, version, target }) {
    const row = await packageRow(db, userId, packageId, version);
    const manifest = parse(row.manifest, {});
    const report = await check(db, userId, manifest, decodeFiles(parse(row.files, {})));
    const problems = [...report.problems];
    const robot = robots ? await robots(db, userId, target).catch(() => null) : null;
    if (robots && !robot) problems.push("That robot isn't in your account.");
    const compatibility = robot ? compatibilityWith(manifest, robot, { hannahVersion }) : { compatible: true, reasons: [] };
    problems.push(...compatibility.reasons);
    const installs = await listInstalls(db, userId);
    for (const dependency of manifest.dependencies) {
      if (!installs.some((item) => item.target === target && item.packageId === dependency.id && item.status === "active" && satisfies(item.version, dependency.version))) problems.push(`Install ${dependency.id} ${dependency.version} on this robot first.`);
    }
    return { ok: problems.length === 0, problems, manifest, robot, report, compatibility };
  }
  async function install(db, userId, { packageId, version, target }) {
    const verdict = await assessInstall(db, userId, { packageId, version, target });
    if (!verdict.ok) throw fail(409, `Not installed. ${verdict.problems.join(" ")}`, "refused", { problems: verdict.problems });
    const at = now();
    const current = (await db.query("SELECT * FROM hannah_hw_installs WHERE user_id = $1 AND package_id = $2 AND target = $3", [userId, packageId, target])).rows[0];
    const history = [...parse(current?.history, []), { version, at, by: "install" }].slice(-30);
    const fields = [userId, packageId, target, version, current && current.status === "active" && current.version !== version ? current.version : current?.previous_version || null, JSON.stringify(verdict.manifest.permissions), JSON.stringify(verdict.manifest.hardwareInterfaces), JSON.stringify(history), at];
    if (current) await db.query("UPDATE hannah_hw_installs SET version = $4, previous_version = $5, permissions = $6, interfaces = $7, status = 'active', history = $8, updated_at = $9 WHERE user_id = $1 AND package_id = $2 AND target = $3", fields);
    else await db.query("INSERT INTO hannah_hw_installs (user_id, package_id, target, version, previous_version, permissions, interfaces, status, history, installed_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $9)", fields);
    await audit(db, { userId, deviceId: target, kind: "package-install", decision: "allowed", reason: `${packageId} ${version} installed with ${verdict.manifest.permissions.join(", ") || "no"} permissions.` });
    return (await listInstalls(db, userId)).find((item) => item.packageId === packageId && item.target === target);
  }
  /** Back to the version before. That version is checked again first: revoked, changed or incompatible means no. */
  async function rollback(db, userId, { packageId, target }) {
    const current = (await db.query("SELECT * FROM hannah_hw_installs WHERE user_id = $1 AND package_id = $2 AND target = $3", [userId, packageId, target])).rows[0];
    if (!current?.previous_version) throw fail(409, "There is no earlier version to go back to.", "no-previous");
    const verdict = await assessInstall(db, userId, { packageId, version: current.previous_version, target });
    if (!verdict.ok) throw fail(409, `Can't roll back to ${current.previous_version}: ${verdict.problems.join(" ")}`, "refused", { problems: verdict.problems });
    const at = now();
    const history = [...parse(current.history, []), { version: current.previous_version, at, by: "rollback", from: current.version }].slice(-30);
    await db.query("UPDATE hannah_hw_installs SET version = $1, previous_version = NULL, permissions = $2, interfaces = $3, status = 'active', history = $4, updated_at = $5 WHERE user_id = $6 AND package_id = $7 AND target = $8",
      [current.previous_version, JSON.stringify(verdict.manifest.permissions), JSON.stringify(verdict.manifest.hardwareInterfaces), JSON.stringify(history), at, userId, packageId, target]);
    await audit(db, { userId, deviceId: target, kind: "package-rollback", decision: "allowed", reason: `${packageId} rolled back from ${current.version} to ${current.previous_version}.` });
    return (await listInstalls(db, userId)).find((item) => item.packageId === packageId && item.target === target);
  }
  /** Revoke a version (or "*" for all). Installs of it stop at once: they get no permission any more. */
  async function revoke(db, userId, { packageId, version = "*", reason }) {
    const text = String(reason || "").trim().slice(0, 300);
    if (!text) throw fail(400, "Say why it is revoked.", "bad-request");
    await db.query("INSERT INTO hannah_hw_revocations (user_id, package_id, version, reason, revoked_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, package_id, version) DO UPDATE SET reason = EXCLUDED.reason", [userId, packageId, version, text, now()]);
    const hit = await db.query(`UPDATE hannah_hw_installs SET status = 'revoked', updated_at = $1 WHERE user_id = $2 AND package_id = $3${version === "*" ? "" : " AND version = $4"}`, version === "*" ? [now(), userId, packageId] : [now(), userId, packageId, version]);
    await audit(db, { userId, kind: "package-revoke", decision: "changed", reason: `${packageId} ${version} revoked: ${text}. ${Number(hit.rowCount) || 0} install(s) disabled.` });
    return { revoked: { packageId, version, reason: text }, disabledInstalls: Number(hit.rowCount) || 0 };
  }
  async function uninstall(db, userId, { packageId, target }) {
    const removed = await db.query("UPDATE hannah_hw_installs SET status = 'removed', updated_at = $1 WHERE user_id = $2 AND package_id = $3 AND target = $4", [now(), userId, packageId, target]);
    if (!Number(removed.rowCount)) throw fail(404, "That package isn't installed there.", "not-found");
    return { removed: true };
  }

  /**
   * Least privilege at run time: may this installed package use this
   * permission, or open this hardware interface? Only what it declared, only
   * while its install is active. Every refusal is audited.
   */
  async function authorize(db, userId, { packageId, target, permission = null, hardware = null }) {
    const row = (await db.query("SELECT * FROM hannah_hw_installs WHERE user_id = $1 AND package_id = $2 AND target = $3", [userId, packageId, target])).rows[0];
    const refuse = async (reason) => { await audit(db, { userId, deviceId: target, kind: "package-access", decision: "refused", reason: `${packageId}: ${reason}`, detail: { permission, hardware } }); return { allowed: false, reason }; };
    if (!row) return refuse("not installed on this robot.");
    if (row.status !== "active") return refuse(`its install is ${row.status}.`);
    const permissions = parse(row.permissions, []);
    if (permission && !permissions.includes(permission)) return refuse(`it didn't declare the “${permission}” permission.`);
    if (hardware) {
      if (!permissions.includes("hardware-access") && hardware.type !== "network") return refuse("it didn't declare hardware-access.");
      const declared = parse(row.interfaces, []).filter((item) => item.type === hardware.type);
      if (!declared.some((item) => interfaceMatches(item.match, hardware.path))) return refuse(`${hardware.type} ${String(hardware.path).slice(0, 80)} isn't among the interfaces it declared.`);
    }
    return { allowed: true };
  }

  return { assessInstall, authorize, install, list, listInstalls, revoke, rollback, uninstall, upload };
}

module.exports = { INTERFACES, KINDS, MANIFEST, PERMISSIONS, TEST_LEVELS, compareVersions, compatibilityWith, createHardwarePackageService, interfaceMatches, marketplaceStatus, satisfies, securityFindings, signManifest, validateManifest, verify };
