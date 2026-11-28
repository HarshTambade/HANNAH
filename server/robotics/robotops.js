"use strict";

/**
 * Robot operations: sim-to-real deployments (PART 4), update packages and
 * staged rollouts (PART 10), and firmware operations, stored per account.
 *
 * The decisions are in simtoreal.js, update_packages.js, rollout.js and
 * firmware.js; this file keeps the records, runs the built-in simulator
 * (simulator.js), and talks to robots only through Robot OS signed commands
 * (robot_os_commands.js), which each robot verifies against its own safety
 * state before applying anything.
 *
 * Who may do what:
 *   - reading anything: any credential of the account;
 *   - running the simulator, setting a baseline: any credential (it moves nothing);
 *   - pinning keys, uploading packages, approving a stage or a wave,
 *     acknowledging assumptions, recording observations, rolling back,
 *     authorising firmware: a signed-in person (`actor.via === "session"`).
 *     The router enforces it and so does this file.
 */
const crypto = require("node:crypto");
const simtoreal = require("./simtoreal");
const updates = require("./update_packages");
const rollout = require("./rollout");
const firmware = require("./firmware");
const defaultSimulator = require("./simulator");
const { keyIdOf } = require("./packages");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const parse = (text, fallback = null) => { if (text === null || text === undefined || text === "") return fallback; try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
const MAX_MANIFEST = 200_000;
const MAX_DEPLOYMENTS = 200;
const actorName = (actor) => actor?.email || actor?.displayName || actor?.id || "unknown";

function requirePerson(actor, what) {
  if (actor?.via !== "session") throw fail(403, `Only a signed-in person, in the app, can ${what}. A developer key or an agent can't.`, "session-required");
}

function createRobotOps({ robotics, robotOSCommands = null, simulator = defaultSimulator, now = () => Date.now() } = {}) {
  async function audit(db, userId, subjectType, subjectId, event, actor, detail = {}) {
    await db.query("INSERT INTO hannah_robotops_audit (user_id, id, at, subject_type, subject_id, event, actor, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [userId, newId("au"), now(), subjectType, subjectId, event, typeof actor === "string" ? actor : actorName(actor), JSON.stringify(detail).slice(0, 4000)]);
  }
  async function auditTrail(db, userId, subjectType, subjectId, limit = 100) {
    const { rows } = await db.query("SELECT * FROM hannah_robotops_audit WHERE user_id = $1 AND subject_type = $2 AND subject_id = $3 ORDER BY at DESC LIMIT $4", [userId, subjectType, subjectId, limit]);
    return rows.map((row) => ({ at: Number(row.at), event: row.event, actor: row.actor, detail: parse(row.detail, {}) }));
  }
  const robotOf = (db, userId, id) => robotics.getRobot(db, userId, id).catch(() => null);

  // ---------- publisher keys (pinned per account) ----------
  async function listKeys(db, userId) {
    const { rows } = await db.query("SELECT * FROM hannah_robotops_keys WHERE user_id = $1 ORDER BY added_at", [userId]);
    return rows.map((row) => ({ keyId: row.key_id, owner: row.owner, publicKey: row.public_key, addedAt: Number(row.added_at), revokedAt: row.revoked_at ? Number(row.revoked_at) : null }));
  }
  async function addKey(db, userId, actor, { owner, publicKey } = {}) {
    requirePerson(actor, "pin a publisher key");
    const name = clean(owner, 80);
    if (!name) throw fail(400, "Say whose key this is (the publisher's name, as their manifests state it).", "bad-request");
    let key;
    try { key = crypto.createPublicKey(String(publicKey || "")); } catch { throw fail(400, "That isn't a public key in PEM form.", "bad-key"); }
    if (key.asymmetricKeyType !== "ed25519") throw fail(400, "Publisher keys are Ed25519.", "bad-key");
    const keyId = keyIdOf(key);
    const pem = key.export({ type: "spki", format: "pem" });
    const existing = (await listKeys(db, userId)).find((item) => item.keyId === keyId);
    if (existing) throw fail(409, existing.revokedAt ? "That key was revoked. A revoked key can't be pinned again." : "That key is already pinned.", "duplicate-key");
    await db.query("INSERT INTO hannah_robotops_keys (user_id, key_id, owner, public_key, added_at) VALUES ($1, $2, $3, $4, $5)", [userId, keyId, name, pem, now()]);
    await audit(db, userId, "key", keyId, "key-pinned", actor, { owner: name });
    return (await listKeys(db, userId)).find((item) => item.keyId === keyId);
  }
  async function revokeKey(db, userId, actor, keyId) {
    requirePerson(actor, "revoke a publisher key");
    const result = await db.query("UPDATE hannah_robotops_keys SET revoked_at = $1 WHERE user_id = $2 AND key_id = $3 AND revoked_at IS NULL", [now(), userId, String(keyId || "")]);
    if (!Number(result.rowCount)) throw fail(404, "No pinned key with that id.", "not-found");
    await audit(db, userId, "key", keyId, "key-revoked", actor);
    return (await listKeys(db, userId)).find((item) => item.keyId === keyId);
  }

  // ---------- update packages ----------
  const publicPackage = (row) => ({ id: row.id, packageId: row.package_id, version: row.version, kind: row.kind, keyId: row.key_id, uploadedAt: Number(row.uploaded_at), manifest: parse(row.manifest, {}) });
  async function listPackages(db, userId) {
    const { rows } = await db.query("SELECT * FROM hannah_robotops_packages WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 200", [userId]);
    return rows.map(publicPackage);
  }
  async function getPackage(db, userId, id) {
    const row = (await db.query("SELECT * FROM hannah_robotops_packages WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    if (!row) throw fail(404, "No package with that id in your account.", "not-found");
    return publicPackage(row);
  }
  /** Store a signed manifest. It is refused unless it is complete and signed by a key pinned to this account. */
  async function uploadPackage(db, userId, actor, manifest) {
    requirePerson(actor, "add an update package");
    if (JSON.stringify(manifest ?? null).length > MAX_MANIFEST) throw fail(413, "The manifest is too large.", "too-large");
    const problems = updates.validateManifest(manifest);
    if (problems.length) throw fail(400, problems.join(" "), "bad-manifest", { problems });
    const verdict = updates.verifySignature(manifest, await listKeys(db, userId));
    if (!verdict.signature.ok || !verdict.publisher.ok) throw fail(422, `${verdict.signature.detail} ${verdict.publisher.ok ? "" : verdict.publisher.detail}`.trim(), "untrusted-package");
    const exists = (await db.query("SELECT id FROM hannah_robotops_packages WHERE user_id = $1 AND package_id = $2 AND version = $3", [userId, manifest.id, manifest.version])).rows[0];
    if (exists) throw fail(409, `${manifest.id} ${manifest.version} is already here. A version is never replaced; publish a new one.`, "duplicate-version");
    const id = newId("pkg");
    await db.query("INSERT INTO hannah_robotops_packages (user_id, id, package_id, version, kind, manifest, key_id, uploaded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [userId, id, manifest.id, manifest.version, manifest.kind, JSON.stringify(manifest), manifest.signature.keyId, now()]);
    await audit(db, userId, "package", id, "package-added", actor, { packageId: manifest.id, version: manifest.version, keyId: manifest.signature.keyId });
    return getPackage(db, userId, id);
  }
  async function installedOn(db, userId, robotId) {
    const { rows } = await db.query("SELECT * FROM hannah_robotops_installed WHERE user_id = $1 AND robot_id = $2", [userId, robotId]);
    return Object.fromEntries(rows.map((row) => [row.package_id, { version: row.version, previous: row.previous_version || null }]));
  }
  async function robotOSReported(db, userId, robotId) {
    const row = (await db.query("SELECT COUNT(*) AS n FROM hannah_robot_os_envelopes WHERE user_id = $1 AND robot_id = $2", [userId, robotId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
    return Number(row?.n || 0) > 0;
  }
  /** Validation of one package for one robot: every PART 10 check, with what it found. */
  async function validateFor(db, userId, pkg, robot, { backup = null, approval = null } = {}) {
    const installed = await installedOn(db, userId, robot.id);
    const versions = Object.fromEntries(Object.entries(installed).map(([id, item]) => [id, item.version]));
    const available = (await listPackages(db, userId)).map((item) => item.manifest);
    const robotOS = await robotOSReported(db, userId, robot.id);
    const report = updates.validate(pkg.manifest, { robot: { ...robot, robotOS }, trustedKeys: await listKeys(db, userId), available, installed: versions, backup, previous: installed[pkg.packageId]?.version || null, approval });
    if (pkg.kind === "firmware") report.checks.push({ id: "firmware", ok: false, detail: "Firmware goes through the separate firmware flow, never a rollout." });
    if (robot.status !== "enrolled") report.checks.push({ id: "enrolled", ok: false, detail: `${robot.name} isn't enrolled.` });
    const blocking = report.checks.filter((check) => !check.ok && !check.pending);
    return { robotId: robot.id, robotName: robot.name, simulated: robot.simulated, ok: blocking.length === 0, problems: blocking.map((check) => check.detail), checks: report.checks };
  }
  async function validatePackage(db, userId, id, robotIds = null) {
    const pkg = await getPackage(db, userId, id);
    const robots = (await robotics.listRobots(db, userId)).filter((robot) => !robotIds || robotIds.includes(robot.id));
    return { package: pkg, robots: await Promise.all(robots.map((robot) => validateFor(db, userId, pkg, robot))) };
  }

  // ---------- rollouts ----------
  const rolloutRow = async (db, userId, id) => (await db.query("SELECT * FROM hannah_robotops_rollouts WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  async function saveRollout(db, userId, record) {
    const at = now();
    const settled = rollout.settle(record, at);
    await db.query("UPDATE hannah_robotops_rollouts SET status = $1, record = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [settled.status, JSON.stringify(settled), at, userId, settled.id]);
    return settled;
  }
  async function createRollout(db, userId, actor, { packageId, picked, allowAllAtOnce = false, autoRollback = true } = {}) {
    requirePerson(actor, "plan a rollout");
    const pkg = await getPackage(db, userId, packageId);
    if (pkg.kind === "firmware") throw fail(400, "Firmware is flashed through the firmware flow, one robot at a time, never rolled out.", "firmware-separate");
    const validation = (await validatePackage(db, userId, pkg.id)).robots;
    const eligible = validation.filter((item) => item.ok).map((item) => item.robotId);
    const plan = rollout.planWaves(picked, eligible, { allowAllAtOnce: allowAllAtOnce === true });
    if (!plan.ok) throw fail(400, plan.problems.join(" "), "bad-plan", { problems: plan.problems, validation });
    const id = newId("ro");
    const at = now();
    const targets = {};
    plan.waves.forEach((wave, index) => { for (const robotId of wave.robotIds) targets[robotId] = rollout.newTarget(robotId, index); });
    const record = { id, packageRow: pkg.id, package: { id: pkg.packageId, version: pkg.version, kind: pkg.kind, name: pkg.manifest.name }, status: "planned", allowAllAtOnce: allowAllAtOnce === true, autoRollback: autoRollback !== false, waves: plan.waves, targets, createdBy: actorName(actor), createdAt: at, validation };
    await db.query("INSERT INTO hannah_robotops_rollouts (user_id, id, package_row, status, record, created_at, updated_at) VALUES ($1, $2, $3, 'planned', $4, $5, $5)", [userId, id, pkg.id, JSON.stringify(record), at]);
    await audit(db, userId, "rollout", id, "rollout-planned", actor, { package: record.package, waves: plan.waves.map((wave) => ({ stage: wave.stage, robots: wave.robotIds })) });
    return getRollout(db, userId, id);
  }
  async function issue(db, userId, robotId, capability, params) {
    if (!robotOSCommands) throw fail(503, "Robot OS commands aren't available on this server.", "not-configured");
    return robotOSCommands.issue(db, { userId, robotId, capability, params });
  }
  /** Send the next command for a target, and set its deadline. Errors become a failed target. */
  async function advanceTarget(db, userId, record, robotId, step) {
    const pkg = await getPackage(db, userId, record.packageRow);
    let target = record.targets[robotId];
    const at = now();
    try {
      if (step === "stage") {
        const robot = await robotOf(db, userId, robotId);
        const backup = { id: newId("bk"), at, configVersion: robot?.configVersion ?? null, safety: robot?.safety ?? null, versions: { runtime: robot?.runtimeVersion, software: robot?.softwareVersion, firmware: robot?.firmwareVersion }, installed: await installedOn(db, userId, robotId) };
        const command = await issue(db, userId, robotId, "update.stage", { version: pkg.version, packageId: pkg.packageId, kind: pkg.kind, manifest: pkg.manifest, backup: { id: backup.id } });
        target = rollout.move(target, "staging", at, "", { backup, commands: { ...target.commands, stage: command.id }, deadlineAt: at + rollout.COMMAND_TIMEOUT_MS });
      } else if (step === "activate") {
        const command = await issue(db, userId, robotId, "update.activate", { version: pkg.version, healthChecks: pkg.manifest.healthChecks.map((check) => check.id) });
        const verifyMs = Math.max(...pkg.manifest.healthChecks.map((check) => check.timeoutS)) * 1000;
        target = rollout.move(target, "activating", at, "", { commands: { ...target.commands, activate: command.id }, deadlineAt: at + rollout.COMMAND_TIMEOUT_MS + verifyMs });
      } else if (step === "rollback") {
        const command = await issue(db, userId, robotId, "update.rollback", { reason: clean(target.reason || "the update failed", 400), version: pkg.version, backup: target.backup ? { id: target.backup.id } : null });
        target = rollout.move(target, "rolling-back", at, target.reason, { commands: { ...target.commands, rollback: command.id }, deadlineAt: at + rollout.COMMAND_TIMEOUT_MS });
      }
    } catch (error) {
      target = rollout.move(target, step === "rollback" ? "rollback-failed" : "failed", at, `Couldn't send the ${step} command: ${error.message}`);
    }
    return { ...record, targets: { ...record.targets, [robotId]: target } };
  }
  /** A person approves one wave; its robots start at once. */
  async function approveWave(db, userId, actor, id, index, { attest = false, statement = "" } = {}) {
    requirePerson(actor, "approve a rollout wave");
    const row = await rolloutRow(db, userId, id);
    if (!row) throw fail(404, "No rollout with that id.", "not-found");
    let record = parse(row.record);
    const wave = Number(index);
    const check = rollout.canStart(record, wave);
    if (!check.ok) throw fail(409, check.reason, "wave-blocked");
    if (attest !== true) throw fail(400, "Confirm that the robots in this wave may be updated now: each will be stopped, updated and checked.", "not-attested");
    // Validate again now: a robot's versions, keys or commissioning may have changed since planning.
    const pkg = await getPackage(db, userId, record.packageRow);
    for (const robotId of record.waves[wave].robotIds) {
      const robot = await robotOf(db, userId, robotId);
      const result = robot ? await validateFor(db, userId, pkg, robot) : { ok: false, problems: ["The robot is no longer in your account."] };
      if (!result.ok) throw fail(409, `${robot?.name || robotId} no longer passes validation: ${result.problems.join(" ")}`, "validation-failed");
    }
    const at = now();
    const approval = { by: actorName(actor), at, statement: clean(statement, 300) || `Update ${record.waves[wave].robotIds.length} robot(s) in the ${rollout.STAGE_TITLES[record.waves[wave].stage]} wave to ${record.package.id} ${record.package.version}${record.autoRollback ? "; roll back automatically if a health check fails" : ""}.` };
    record = { ...record, waves: record.waves.map((item, position) => (position === wave ? { ...item, status: "installing", approval, startedAt: at } : item)) };
    for (const robotId of record.waves[wave].robotIds) {
      record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(record.targets[robotId], "queued", at) } };
      record = await advanceTarget(db, userId, record, robotId, "stage");
    }
    await audit(db, userId, "rollout", id, "wave-approved", actor, { wave, stage: record.waves[wave].stage, robots: record.waves[wave].robotIds, statement: approval.statement });
    await saveRollout(db, userId, record);
    return getRollout(db, userId, id);
  }
  /** Failed-update detection: anything past its deadline has failed; roll it back when that is allowed. */
  async function sweepRollout(db, userId, record) {
    const at = now();
    let changed = false;
    for (const target of rollout.overdue(record, at)) {
      changed = true;
      const wasRollingBack = target.status === "rolling-back";
      const reason = wasRollingBack ? "The robot didn't confirm the rollback in time." : `No confirmation from the robot while ${target.status}; an update that isn't confirmed healthy has failed.`;
      record = { ...record, targets: { ...record.targets, [target.robotId]: rollout.move(target, wasRollingBack ? "rollback-failed" : "failed", at, reason) } };
      await audit(db, userId, "rollout", record.id, "target-timed-out", "HANNAH", { robotId: target.robotId, status: target.status });
      if (!wasRollingBack && record.autoRollback && target.commands.stage) record = await advanceTarget(db, userId, record, target.robotId, "rollback");
    }
    return changed ? saveRollout(db, userId, record) : record;
  }
  async function getRollout(db, userId, id) {
    const row = await rolloutRow(db, userId, id);
    if (!row) throw fail(404, "No rollout with that id.", "not-found");
    const record = await sweepRollout(db, userId, parse(row.record));
    return { ...rollout.settle(record, now()), audit: await auditTrail(db, userId, "rollout", id, 60) };
  }
  async function listRollouts(db, userId) {
    const { rows } = await db.query("SELECT id FROM hannah_robotops_rollouts WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50", [userId]);
    return Promise.all(rows.map((row) => getRollout(db, userId, row.id)));
  }
  async function cancelRollout(db, userId, actor, id) {
    requirePerson(actor, "cancel a rollout");
    const row = await rolloutRow(db, userId, id);
    if (!row) throw fail(404, "No rollout with that id.", "not-found");
    const record = parse(row.record);
    if (Object.values(record.targets).some((target) => rollout.ACTIVE_TARGET.has(target.status))) throw fail(409, "Robots in this rollout are being updated now. Wait for them, or roll them back.", "busy");
    const at = now();
    const next = { ...record, status: "cancelled", waves: record.waves.map((wave) => (wave.status === "planned" ? { ...wave, status: "cancelled" } : wave)), cancelledAt: at };
    await db.query("UPDATE hannah_robotops_rollouts SET status = 'cancelled', record = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(next), at, userId, id]);
    await audit(db, userId, "rollout", id, "rollout-cancelled", actor);
    return { ...next, audit: await auditTrail(db, userId, "rollout", id, 60) };
  }
  /** A person rolls one robot back. */
  async function rollbackTarget(db, userId, actor, id, robotId, { reason = "" } = {}) {
    requirePerson(actor, "roll a robot back");
    const row = await rolloutRow(db, userId, id);
    if (!row) throw fail(404, "No rollout with that id.", "not-found");
    let record = parse(row.record);
    const target = record.targets[String(robotId)];
    if (!target || !target.commands?.stage) throw fail(409, "That robot hasn't been sent this update.", "not-started");
    if (["rolled-back", "rolling-back"].includes(target.status)) throw fail(409, `That robot is already ${target.status}.`, "already");
    record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "failed", now(), clean(reason, 300) || `Rolled back by ${actorName(actor)}.`) } };
    record = await advanceTarget(db, userId, record, robotId, "rollback");
    await audit(db, userId, "rollout", id, "rollback-requested", actor, { robotId, reason: clean(reason, 300) });
    await saveRollout(db, userId, record);
    return getRollout(db, userId, id);
  }
  async function markInstalled(db, userId, record, robotId) {
    const existing = (await db.query("SELECT version FROM hannah_robotops_installed WHERE user_id = $1 AND robot_id = $2 AND package_id = $3", [userId, robotId, record.package.id])).rows[0];
    await db.query("DELETE FROM hannah_robotops_installed WHERE user_id = $1 AND robot_id = $2 AND package_id = $3", [userId, robotId, record.package.id]);
    await db.query("INSERT INTO hannah_robotops_installed (user_id, robot_id, package_id, version, previous_version, rollout_id, installed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [userId, robotId, record.package.id, record.package.version, existing?.version || null, record.id, now()]);
  }
  async function markRolledBack(db, userId, record, robotId) {
    const row = (await db.query("SELECT * FROM hannah_robotops_installed WHERE user_id = $1 AND robot_id = $2 AND package_id = $3 AND rollout_id = $4", [userId, robotId, record.package.id, record.id])).rows[0];
    if (!row) return;
    await db.query("DELETE FROM hannah_robotops_installed WHERE user_id = $1 AND robot_id = $2 AND package_id = $3", [userId, robotId, record.package.id]);
    if (row.previous_version) await db.query("INSERT INTO hannah_robotops_installed (user_id, robot_id, package_id, version, previous_version, rollout_id, installed_at) VALUES ($1, $2, $3, $4, NULL, NULL, $5)", [userId, robotId, record.package.id, row.previous_version, now()]);
  }
  /** Rollouts with a robot in an active state, for this robot. */
  async function activeRolloutsFor(db, userId, robotId) {
    const { rows } = await db.query("SELECT record FROM hannah_robotops_rollouts WHERE user_id = $1 AND status IN ('in-progress', 'halted', 'planned', 'paused')", [userId]);
    return rows.map((row) => parse(row.record)).filter((record) => record?.targets?.[robotId] && rollout.ACTIVE_TARGET.has(record.targets[robotId].status));
  }
  /** What a robot answered: Robot OS acks carry the command id, and may carry its update state and health checks. */
  async function onCommandAck(db, { userId, robotId, commandId, ok, reason = "", health = null }) {
    for (let record of await activeRolloutsFor(db, userId, robotId)) {
      const target = record.targets[robotId];
      const step = Object.entries(target.commands || {}).find(([, id]) => id === commandId)?.[0];
      if (!step) continue;
      const at = now();
      const pkg = await getPackage(db, userId, record.packageRow);
      if (step === "stage") {
        if (!ok) record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "failed", at, `The robot refused to stage it: ${clean(reason, 300)}`) } };
        else {
          record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "staged", at) } };
          record = await advanceTarget(db, userId, record, robotId, "activate");
        }
      } else if (step === "activate") {
        if (!ok) record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "failed", at, `The robot refused to activate it: ${clean(reason, 300)}`) } };
        else {
          const judged = rollout.judgeHealth(pkg.manifest.healthChecks, health?.checks);
          if (judged.ok) {
            record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "healthy", at, "", { health: { ...judged, at }, deadlineAt: null }) } };
            await markInstalled(db, userId, record, robotId);
          } else if (health?.checks) record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "failed", at, `Health checks failed: ${judged.results.filter((item) => !item.ok).map((item) => `${item.id} (${item.detail})`).join(", ")}`, { health: { ...judged, at } }) } };
          else record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "verifying", at) } };
        }
      } else if (step === "rollback") {
        record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, ok ? "rolled-back" : "rollback-failed", at, ok ? target.reason : `The robot refused the rollback: ${clean(reason, 300)}`, { deadlineAt: null }) } };
        if (ok) await markRolledBack(db, userId, record, robotId);
      }
      const after = record.targets[robotId];
      await audit(db, userId, "rollout", record.id, `target-${after.status}`, "robot", { robotId, step, ok, reason: clean(reason, 200) });
      if (after.status === "failed" && record.autoRollback && step !== "rollback" && target.commands.stage) record = await advanceTarget(db, userId, record, robotId, "rollback");
      await saveRollout(db, userId, record);
    }
  }
  /** A Robot OS event envelope: `update_status` after a reboot, with its health checks. */
  async function onRobotEvent(db, { userId, robotId, payload }) {
    if (!userId || payload?.type !== "update_status") return;
    for (let record of await activeRolloutsFor(db, userId, robotId)) {
      const target = record.targets[robotId];
      if (payload.version && payload.version !== record.package.version) continue;
      const pkg = await getPackage(db, userId, record.packageRow);
      const at = now();
      if (payload.outcome === "rolled-back") {
        record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "rolled-back", at, "The robot came back up on its previous version (its boot loader fell back).", { deadlineAt: null }) } };
        await markRolledBack(db, userId, record, robotId);
      } else if (["verifying", "activating", "staged"].includes(target.status)) {
        const judged = rollout.judgeHealth(pkg.manifest.healthChecks, payload.checks);
        if (judged.ok) {
          record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "healthy", at, "", { health: { ...judged, at }, deadlineAt: null }) } };
          await markInstalled(db, userId, record, robotId);
        } else if (payload.checks) {
          record = { ...record, targets: { ...record.targets, [robotId]: rollout.move(target, "failed", at, `Health checks failed: ${judged.results.filter((item) => !item.ok).map((item) => item.id).join(", ")}`, { health: { ...judged, at } }) } };
          if (record.autoRollback) record = await advanceTarget(db, userId, record, robotId, "rollback");
        } else continue;
      } else continue;
      await audit(db, userId, "rollout", record.id, `target-${record.targets[robotId].status}`, "robot", { robotId, outcome: clean(payload.outcome, 40) });
      await saveRollout(db, userId, record);
    }
  }

  // ---------- simulator runs and baselines ----------
  const suiteOf = (profile, scenarios) => `${profile}:${[...scenarios].sort().join(",")}`;
  const publicRun = (row, { full = false } = {}) => row && ({
    id: row.id, deploymentId: row.deployment_id || null, suite: row.suite, profile: row.profile, overrides: parse(row.overrides, {}), status: row.status,
    summary: parse(row.summary), error: row.error || null, createdAt: Number(row.created_at), finishedAt: row.finished_at ? Number(row.finished_at) : null,
    simulator: "hannah-kinematic", physical: false,
    ...(full ? (() => { const report = parse(row.report, {}); return { results: report.results || [], config: report.config || null, environment: report.environment || "" }; })() : {}),
  });
  async function getRun(db, userId, id, { full = true } = {}) {
    const row = (await db.query("SELECT * FROM hannah_robotops_sim_runs WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0];
    return row ? publicRun(row, { full }) : null;
  }
  async function listRuns(db, userId, { deploymentId = null, suite = null, limit = 20 } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (deploymentId) { values.push(deploymentId); where += ` AND deployment_id = $${values.length}`; }
    if (suite) { values.push(suite); where += ` AND suite = $${values.length}`; }
    values.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const { rows } = await db.query(`SELECT * FROM hannah_robotops_sim_runs WHERE ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return rows.map((row) => publicRun(row));
  }
  /** Run the suite in the built-in simulator and store what it reported. */
  async function runSimulation(db, userId, actor, { profile, scenarios = [], overrides = {}, deploymentId = null } = {}) {
    const names = scenarios.length ? scenarios : simulator.scenarios().map((item) => item.name);
    const suite = suiteOf(profile, names);
    const id = newId("sim");
    const at = now();
    await db.query("INSERT INTO hannah_robotops_sim_runs (user_id, id, deployment_id, suite, profile, overrides, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)", [userId, id, deploymentId, suite, clean(profile, 60), JSON.stringify(overrides || {}), at]);
    try {
      const report = await simulator.runScenarios({ profile, scenarios: names, overrides });
      await db.query("UPDATE hannah_robotops_sim_runs SET status = $1, summary = $2, report = $3, finished_at = $4 WHERE user_id = $5 AND id = $6", [report.summary.scenariosPassed === report.summary.scenarios ? "passed" : "failed", JSON.stringify(report.summary), JSON.stringify({ results: report.results, config: report.config, environment: report.environment }), now(), userId, id]);
    } catch (error) {
      await db.query("UPDATE hannah_robotops_sim_runs SET status = 'error', error = $1, finished_at = $2 WHERE user_id = $3 AND id = $4", [clean(error.message, 400), now(), userId, id]);
      await audit(db, userId, "sim-run", id, "sim-run-error", actor, { error: clean(error.message, 200) });
      throw error;
    }
    await audit(db, userId, "sim-run", id, "sim-run", actor, { suite, deploymentId });
    return getRun(db, userId, id);
  }
  async function baselineFor(db, userId, suite) {
    const row = (await db.query("SELECT * FROM hannah_robotops_baselines WHERE user_id = $1 AND suite = $2", [userId, suite])).rows[0];
    if (!row) return null;
    const run = await getRun(db, userId, row.run_id);
    return run ? { ...run, baselineSetBy: row.set_by, baselineSetAt: Number(row.set_at) } : null;
  }
  async function setBaseline(db, userId, actor, runId) {
    const run = await getRun(db, userId, runId);
    if (!run) throw fail(404, "No simulator run with that id.", "not-found");
    if (run.status !== "passed") throw fail(409, "Only a run in which every scenario passed can be the baseline.", "run-not-passed");
    await db.query("DELETE FROM hannah_robotops_baselines WHERE user_id = $1 AND suite = $2", [userId, run.suite]);
    await db.query("INSERT INTO hannah_robotops_baselines (user_id, suite, run_id, set_by, set_at) VALUES ($1, $2, $3, $4, $5)", [userId, run.suite, run.id, actorName(actor), now()]);
    await audit(db, userId, "sim-run", run.id, "baseline-set", actor, { suite: run.suite });
    return baselineFor(db, userId, run.suite);
  }

  // ---------- sim-to-real deployments ----------
  const deploymentRow = async (db, userId, id) => (await db.query("SELECT * FROM hannah_robotops_deployments WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  async function saveDeployment(db, userId, record) {
    await db.query("UPDATE hannah_robotops_deployments SET stage = $1, status = $2, record = $3, updated_at = $4 WHERE user_id = $5 AND id = $6", [record.stage, record.status, JSON.stringify(record), now(), userId, record.id]);
  }
  async function loadDeployment(db, userId, id) {
    const row = await deploymentRow(db, userId, id);
    if (!row) throw fail(404, "No deployment with that id.", "not-found");
    return parse(row.record);
  }
  async function createDeployment(db, userId, actor, { robotId, title, change = {} } = {}) {
    requirePerson(actor, "start a sim-to-real deployment");
    const robot = await robotics.getRobot(db, userId, robotId);
    if (robot.simulated) throw fail(400, `${robot.name} is a simulated robot. A sim-to-real deployment takes a change to a physical robot.`, "not-physical");
    const kind = simtoreal.CHANGE_KINDS.includes(change.kind) ? change.kind : null;
    if (!kind) throw fail(400, `Say what kind of change it is: ${simtoreal.CHANGE_KINDS.join(", ")}.`, "bad-request");
    const count = Number((await db.query("SELECT COUNT(*) AS n FROM hannah_robotops_deployments WHERE user_id = $1", [userId])).rows[0].n);
    if (count >= MAX_DEPLOYMENTS) throw fail(400, `You have ${MAX_DEPLOYMENTS} deployments.`, "too-many");
    const known = simulator.scenarios().map((item) => item.name);
    const scenarios = (Array.isArray(change.scenarios) && change.scenarios.length ? change.scenarios : known).map((item) => clean(item, 60));
    for (const name of scenarios) if (!known.includes(name)) throw fail(404, `There is no scenario called “${name}”.`, "unknown-scenario");
    const id = newId("dep");
    const at = now();
    const record = {
      id, robotId: robot.id, robotName: robot.name, title: clean(title, 120) || `${kind} change for ${robot.name}`,
      change: { kind, description: clean(change.description, 1000), simProfile: clean(change.simProfile, 60), scenarios, overrides: change.overrides && typeof change.overrides === "object" ? change.overrides : {}, capabilities: (Array.isArray(change.capabilities) ? change.capabilities : []).map((item) => clean(item, 40)).filter(Boolean), packageRow: change.packageRow ? clean(change.packageRow, 40) : null },
      stage: "simulation", status: "open", sim: null, parity: null, runIds: [], inspected: null, acknowledged: null, approvals: [], observations: [], stages: {}, rollbacks: [], createdBy: actorName(actor), createdAt: at,
    };
    if (record.change.packageRow) await getPackage(db, userId, record.change.packageRow);
    await db.query("INSERT INTO hannah_robotops_deployments (user_id, id, robot_id, title, stage, status, record, created_at, updated_at) VALUES ($1, $2, $3, $4, 'simulation', 'open', $5, $6, $6)", [userId, id, robot.id, record.title, JSON.stringify(record), at]);
    await audit(db, userId, "deployment", id, "deployment-created", actor, { robotId: robot.id, change: record.change });
    try { await loadSimulation(db, userId, actor, id); } catch (error) { await audit(db, userId, "deployment", id, "sim-load-failed", "HANNAH", { error: clean(error.message, 200) }); }
    return getDeployment(db, userId, id);
  }
  /** Load the simulator's description of the profile, and compare it with the robot. */
  async function loadSimulation(db, userId, actor, id) {
    const record = await loadDeployment(db, userId, id);
    const sim = await simulator.describe(record.change.simProfile);
    const robot = await robotics.getRobot(db, userId, record.robotId);
    const parity = simtoreal.parityReport(sim, record.change.overrides, robot);
    const kept = record.acknowledged && record.parity?.hash === parity.hash ? record.acknowledged : null;
    const next = { ...record, sim, parity: { ...parity, at: now() }, acknowledged: kept };
    await saveDeployment(db, userId, next);
    await audit(db, userId, "deployment", id, "parity-report", actor, { ok: parity.ok, blocking: parity.blocking.length, assumptions: parity.assumptions.length });
    return next;
  }
  async function simulateDeployment(db, userId, actor, id) {
    const record = await loadDeployment(db, userId, id);
    if (record.status !== "open") throw fail(409, `This deployment is ${record.status}.`, "closed");
    const run = await runSimulation(db, userId, actor, { profile: record.change.simProfile, scenarios: record.change.scenarios, overrides: record.change.overrides, deploymentId: id });
    const fresh = await loadDeployment(db, userId, id);
    await saveDeployment(db, userId, { ...fresh, runIds: [run.id, ...fresh.runIds].slice(0, 30) });
    return getDeployment(db, userId, id);
  }
  async function inspectRun(db, userId, actor, id, { runId, attest = false } = {}) {
    requirePerson(actor, "record that you inspected the results");
    const record = await loadDeployment(db, userId, id);
    if (record.runIds[0] !== runId) throw fail(409, "Inspect the latest run of this deployment.", "not-latest");
    if (attest !== true) throw fail(400, "Confirm that you looked at the results of every scenario.", "not-attested");
    await saveDeployment(db, userId, { ...record, inspected: { runId, by: actorName(actor), at: now() } });
    await audit(db, userId, "deployment", id, "run-inspected", actor, { runId });
    return getDeployment(db, userId, id);
  }
  async function acknowledgeAssumptions(db, userId, actor, id, { ids = [], attest = false } = {}) {
    requirePerson(actor, "acknowledge unverified assumptions");
    const record = await loadDeployment(db, userId, id);
    if (!record.parity) throw fail(409, "There is no parity report yet.", "no-parity");
    if (attest !== true) throw fail(400, "Confirm that you read each assumption: none of them was tested.", "not-attested");
    const all = record.parity.assumptions.map((item) => item.id);
    const missing = all.filter((item) => !ids.includes(item));
    if (missing.length) throw fail(400, `Acknowledge every assumption (${missing.length} left).`, "incomplete");
    await saveDeployment(db, userId, { ...record, acknowledged: { ids: all, by: actorName(actor), at: now(), parityHash: record.parity.hash } });
    await audit(db, userId, "deployment", id, "assumptions-acknowledged", actor, { count: all.length });
    return getDeployment(db, userId, id);
  }
  const NEXT_STAGE = { development: "test", test: "limited", limited: "wider" };
  /**
   * Explicit human approval for a physical stage. The development stage
   * needs every lifecycle step before it; later stages need the stage before
   * to have been observed as fine, and each robot added commissioned with a
   * parity report that has no blocking difference.
   */
  async function approveStage(db, userId, actor, id, { stage, robotIds = [], attest = false, statement = "" } = {}) {
    requirePerson(actor, "approve a physical stage");
    if (attest !== true) throw fail(400, "Confirm that you approve new physical behaviour on these robots, supervised, and that passing in simulation doesn't make it safe.", "not-attested");
    const record = await loadDeployment(db, userId, id);
    if (record.status !== "open") throw fail(409, `This deployment is ${record.status}.`, "closed");
    const view = await getDeployment(db, userId, id);
    const at = now();
    let next;
    if (stage === "development") {
      if (record.stage !== "simulation") throw fail(409, "The development stage was already approved.", "already");
      if (!view.lifecycle.readyForApproval) throw fail(409, `Not ready for a physical stage: ${view.lifecycle.steps.filter((step) => !step.ok).slice(0, 4).map((step) => `${step.title}: ${step.detail}`).join(" ")}`, "not-ready");
      next = { ...record, stage: "development", approvals: [...record.approvals, { stage, by: actorName(actor), at, runId: record.runIds[0], parityHash: record.parity.hash, robotIds: [record.robotId], statement: clean(statement, 300) || `Supervised limited physical test of “${record.title}” on ${record.robotName}.` }], stages: { ...record.stages, development: { robots: [{ robotId: record.robotId, status: "active", at }] } } };
    } else if (NEXT_STAGE[record.stage] === stage) {
      const observed = record.observations.find((item) => item.stage === record.stage);
      if (observed?.outcome !== "ok") throw fail(409, `Record that the ${simtoreal.STAGE_TITLES[record.stage]} stage behaved as expected first.`, "not-observed");
      const ids = [...new Set(robotIds.map(String))];
      if (!ids.length) throw fail(400, "Pick the robots for this stage.", "bad-request");
      const checked = [];
      for (const robotId of ids) {
        const robot = await robotOf(db, userId, robotId);
        const ready = simtoreal.robotReady(robot);
        if (!ready.ok) throw fail(409, ready.problems.join(" "), "robot-not-ready");
        const parity = simtoreal.parityReport(record.sim, record.change.overrides, robot);
        if (!parity.ok) throw fail(409, `${robot.name} differs from the simulation: ${parity.blocking.join("; ")}`, "parity-blocking");
        checked.push({ robotId, status: "active", at, parityHash: parity.hash, assumptions: parity.assumptions.length });
      }
      next = { ...record, stage, approvals: [...record.approvals, { stage, by: actorName(actor), at, robotIds: ids, statement: clean(statement, 300) || `${simtoreal.STAGE_TITLES[stage]} of “${record.title}” on ${ids.length} robot(s).` }], stages: { ...record.stages, [stage]: { robots: checked } } };
    } else throw fail(409, `The next stage after ${simtoreal.STAGE_TITLES[record.stage]} is ${NEXT_STAGE[record.stage] ? simtoreal.STAGE_TITLES[NEXT_STAGE[record.stage]] : "none"}.`, "wrong-stage");
    await saveDeployment(db, userId, next);
    await audit(db, userId, "deployment", id, "stage-approved", actor, { stage, robots: next.stages[stage].robots.map((item) => item.robotId) });
    return getDeployment(db, userId, id);
  }
  async function observe(db, userId, actor, id, { outcome, note } = {}) {
    requirePerson(actor, "record an observation");
    const record = await loadDeployment(db, userId, id);
    if (record.stage === "simulation") throw fail(409, "Nothing physical has been approved yet; there is nothing to observe on a robot.", "no-physical-stage");
    if (!["ok", "problem"].includes(outcome)) throw fail(400, "Say whether it behaved as expected (ok) or not (problem).", "bad-request");
    const text = clean(note, 1000);
    if (text.length < 3) throw fail(400, "Write down what you saw.", "note-missing");
    const view = await getDeployment(db, userId, id);
    if (record.stage === "development" && outcome === "ok" && !view.lifecycle.steps.find((step) => step.id === "physical-test").ok) throw fail(409, "There is no verified mission on the robot since the approval; run the supervised test first.", "no-physical-test");
    const observations = [...record.observations.filter((item) => item.stage !== record.stage), { stage: record.stage, outcome, note: text, by: actorName(actor), at: now() }];
    const stages = { ...record.stages, [record.stage]: { ...record.stages[record.stage], robots: (record.stages[record.stage]?.robots || []).map((item) => ({ ...item, status: outcome === "ok" ? "validated" : "problem" })) } };
    const next = { ...record, observations, stages, status: record.stage === "wider" && outcome === "ok" ? "completed" : record.status };
    await saveDeployment(db, userId, next);
    await audit(db, userId, "deployment", id, "observation", actor, { stage: record.stage, outcome });
    return getDeployment(db, userId, id);
  }
  /**
   * Roll the deployment back on its robots. When the change was delivered as
   * an update package through a rollout, that robot is rolled back through
   * Robot OS; otherwise HANNAH didn't apply it and says the person has to.
   */
  async function rollbackDeployment(db, userId, actor, id, { reason = "", robotIds = null } = {}) {
    requirePerson(actor, "roll a deployment back");
    const record = await loadDeployment(db, userId, id);
    if (record.stage === "simulation") throw fail(409, "Nothing physical was approved; there is nothing to roll back.", "nothing-to-roll-back");
    const why = clean(reason, 300);
    if (why.length < 3) throw fail(400, "Say why it is being rolled back.", "reason-missing");
    const affected = Object.values(record.stages).flatMap((stage) => stage.robots || []).map((item) => item.robotId).filter((robotId) => !robotIds || robotIds.includes(robotId));
    const actions = [];
    for (const robotId of [...new Set(affected)]) {
      let done = null;
      if (record.change.packageRow) {
        const { rows } = await db.query("SELECT id, record FROM hannah_robotops_rollouts WHERE user_id = $1 AND package_row = $2", [userId, record.change.packageRow]);
        const match = rows.map((row) => parse(row.record)).find((item) => item.targets?.[robotId]?.commands?.stage && !["rolled-back", "rolling-back"].includes(item.targets[robotId].status));
        if (match) { await rollbackTarget(db, userId, actor, match.id, robotId, { reason: why }); done = { robotId, how: "robot-os", rolloutId: match.id }; }
      }
      actions.push(done || { robotId, how: "manual", detail: "HANNAH didn't apply this change to the robot, so it can't undo it. Restore the previous configuration on the robot yourself; it may need commissioning again." });
    }
    const stages = Object.fromEntries(Object.entries(record.stages).map(([name, stage]) => [name, { ...stage, robots: (stage.robots || []).map((item) => (affected.includes(item.robotId) ? { ...item, status: "rolled-back" } : item)) }]));
    const next = { ...record, stages, status: robotIds ? record.status : "rolled-back", rollbacks: [...record.rollbacks, { at: now(), by: actorName(actor), reason: why, actions }] };
    await saveDeployment(db, userId, next);
    await audit(db, userId, "deployment", id, "rolled-back", actor, { reason: why, actions });
    return getDeployment(db, userId, id);
  }
  async function getDeployment(db, userId, id) {
    const record = await loadDeployment(db, userId, id);
    const robot = await robotOf(db, userId, record.robotId);
    const run = record.runIds[0] ? await getRun(db, userId, record.runIds[0]) : null;
    const baseline = await baselineFor(db, userId, suiteOf(record.change.simProfile, record.change.scenarios));
    const missions = robot ? await robotics.listMissions(db, userId, { robotId: robot.id, limit: 50 }) : [];
    const lifecycle = simtoreal.evaluate(record, { robot, run, baseline, missions });
    return { ...record, robot: robot ? { id: robot.id, name: robot.name, simulated: robot.simulated, commissioning: robot.commissioning, online: robot.online } : null, latestRun: run, baseline: baseline ? { id: baseline.id, summary: baseline.summary, setBy: baseline.baselineSetBy, setAt: baseline.baselineSetAt } : null, lifecycle, audit: await auditTrail(db, userId, "deployment", id, 60) };
  }
  async function listDeployments(db, userId, { robotId = null } = {}) {
    const values = [userId];
    let where = "user_id = $1";
    if (robotId) { values.push(String(robotId)); where += " AND robot_id = $2"; }
    const { rows } = await db.query(`SELECT record FROM hannah_robotops_deployments WHERE ${where} ORDER BY updated_at DESC LIMIT 50`, values);
    return rows.map((row) => { const record = parse(row.record, {}); return { id: record.id, title: record.title, robotId: record.robotId, robotName: record.robotName, stage: record.stage, status: record.status, change: { kind: record.change?.kind, simProfile: record.change?.simProfile }, createdAt: record.createdAt }; });
  }

  // ---------- firmware ----------
  const firmwareRow = async (db, userId, id) => (await db.query("SELECT * FROM hannah_robotops_firmware WHERE user_id = $1 AND id = $2", [userId, String(id || "")])).rows[0] || null;
  async function firmwareView(db, userId, record) {
    const robot = await robotOf(db, userId, record.robotId);
    const pkg = await getPackage(db, userId, record.packageRow).catch(() => null);
    let current = [];
    if (robot && pkg && !["flashed", "simulated-flashed", "blocked", "failed", "cancelled"].includes(record.status)) {
      const active = await robotics.listMissions(db, userId, { robotId: robot.id, active: true, limit: 5 });
      current = firmware.checks({ request: record.request, manifest: pkg.manifest, verified: updates.verifySignature(pkg.manifest, await listKeys(db, userId)), robot, activeMissions: active.length });
    }
    const driver = robot ? firmware.flasherFor(robot) : null;
    return { ...record, checks: current.length ? current : record.checks || [], driver: driver ? { id: driver.id, title: driver.title, simulated: driver.simulated } : null, blockedReason: robot && !driver ? `${firmware.BLOCKED}: no firmware flashing driver for a physical robot exists in HANNAH. The checks and the authorisation are recorded; flash it with the vendor's tool, following the recovery procedure.` : null, audit: await auditTrail(db, userId, "firmware", record.id, 40) };
  }
  async function createFirmwareOp(db, userId, actor, { robotId, packageId, request = {} } = {}) {
    requirePerson(actor, "start a firmware operation");
    const robot = await robotics.getRobot(db, userId, robotId);
    const pkg = await getPackage(db, userId, packageId);
    const problems = firmware.firmwareProblems(pkg.manifest);
    if (problems.length) throw fail(400, problems.join(" "), "not-firmware");
    const id = newId("fw");
    const at = now();
    const record = { id, robotId: robot.id, robotName: robot.name, packageRow: pkg.id, package: { id: pkg.packageId, version: pkg.version, controller: pkg.manifest.firmware.controller }, request: { manufacturer: clean(request.manufacturer, 80), model: clean(request.model, 80), serialNumber: clean(request.serialNumber, 60), controllerHardwareId: clean(request.controllerHardwareId, 80) }, status: "checking", createdBy: actorName(actor), createdAt: at, authorization: null, result: null };
    await db.query("INSERT INTO hannah_robotops_firmware (user_id, id, robot_id, status, record, created_at, updated_at) VALUES ($1, $2, $3, 'checking', $4, $5, $5)", [userId, id, robot.id, JSON.stringify(record), at]);
    await audit(db, userId, "firmware", id, "firmware-requested", actor, { robotId: robot.id, package: record.package, request: record.request });
    return firmwareView(db, userId, record);
  }
  async function getFirmwareOp(db, userId, id) {
    const row = await firmwareRow(db, userId, id);
    if (!row) throw fail(404, "No firmware operation with that id.", "not-found");
    return firmwareView(db, userId, parse(row.record));
  }
  async function listFirmwareOps(db, userId) {
    const { rows } = await db.query("SELECT record FROM hannah_robotops_firmware WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 30", [userId]);
    return rows.map((row) => parse(row.record, {}));
  }
  /** Authorise and flash. Every check must hold now; the flash runs through the robot's driver, or stops at BLOCKED_EXTERNAL_DEPENDENCY. */
  async function authorizeFirmware(db, userId, actor, id, { confirmName, confirmSerial, atRobot } = {}) {
    const row = await firmwareRow(db, userId, id);
    if (!row) throw fail(404, "No firmware operation with that id.", "not-found");
    const record = parse(row.record);
    if (record.status !== "checking") throw fail(409, `This firmware operation is ${record.status}.`, "closed");
    const robot = await robotics.getRobot(db, userId, record.robotId);
    const authorization = firmware.authorize({ caller: actor, robot, confirmName, confirmSerial, atRobot, now: now() });
    const view = await firmwareView(db, userId, record);
    const failing = view.checks.filter((check) => !check.ok);
    if (failing.length) {
      await audit(db, userId, "firmware", id, "firmware-refused", actor, { failing: failing.map((check) => check.id) });
      throw fail(409, `Not flashed. ${failing.map((check) => `${check.id}: ${check.detail}`).join(" ")}`, "checks-failed", { checks: view.checks });
    }
    const pkg = await getPackage(db, userId, record.packageRow);
    const driver = firmware.flasherFor(robot);
    let result;
    let status;
    if (!driver) {
      status = "blocked";
      result = { ok: false, status: firmware.BLOCKED, simulated: false, detail: view.blockedReason };
    } else {
      result = await driver.flash({ robot, manifest: pkg.manifest });
      status = result.ok ? result.status : "failed";
    }
    const next = { ...record, status, authorization, checks: view.checks, result: { ...result, driver: driver?.id || null, at: now() } };
    await db.query("UPDATE hannah_robotops_firmware SET status = $1, record = $2, updated_at = $3 WHERE user_id = $4 AND id = $5", [status, JSON.stringify(next), now(), userId, id]);
    await audit(db, userId, "firmware", id, `firmware-${status}`, actor, { driver: driver?.id || null, simulated: Boolean(result.simulated), detail: clean(result.detail, 300) });
    return firmwareView(db, userId, next);
  }
  async function cancelFirmwareOp(db, userId, actor, id) {
    requirePerson(actor, "cancel a firmware operation");
    const row = await firmwareRow(db, userId, id);
    if (!row) throw fail(404, "No firmware operation with that id.", "not-found");
    const record = parse(row.record);
    if (record.status !== "checking") throw fail(409, `This firmware operation is ${record.status}.`, "closed");
    const next = { ...record, status: "cancelled" };
    await db.query("UPDATE hannah_robotops_firmware SET status = 'cancelled', record = $1, updated_at = $2 WHERE user_id = $3 AND id = $4", [JSON.stringify(next), now(), userId, id]);
    await audit(db, userId, "firmware", id, "firmware-cancelled", actor);
    return firmwareView(db, userId, next);
  }

  return {
    addKey, listKeys, revokeKey,
    uploadPackage, listPackages, getPackage, validatePackage,
    createRollout, approveWave, getRollout, listRollouts, cancelRollout, rollbackTarget, onCommandAck, onRobotEvent,
    runSimulation, getRun, listRuns, setBaseline, baselineFor,
    createDeployment, loadSimulation, simulateDeployment, inspectRun, acknowledgeAssumptions, approveStage, observe, rollbackDeployment, getDeployment, listDeployments,
    createFirmwareOp, getFirmwareOp, listFirmwareOps, authorizeFirmware, cancelFirmwareOp,
  };
}

module.exports = { createRobotOps, requirePerson };
