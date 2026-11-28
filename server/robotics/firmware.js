"use strict";

/**
 * Firmware flashing: a separate, higher-risk operation (PART 10).
 *
 * Writing firmware to a controller can leave a machine that doesn't boot, or
 * one whose motor controller behaves differently from the one that was
 * commissioned. So it is never part of an ordinary update, and a flash is
 * allowed only when all of these hold at the moment it is authorised:
 *
 *   identity       the robot's reported manufacturer, model and serial number
 *                  are exactly what the request names, and the controller's
 *                  hardware id is one the firmware package was built for
 *   firmware       the image is a signed firmware package (update_packages)
 *                  for exactly this hardware, and the robot's current firmware
 *                  is one it may be flashed from
 *   compatibility  the robot's runtime and software are in the ranges the
 *                  package names
 *   power          the robot is online, reports external power or a battery
 *                  at or above the package's minimum, is stopped (idle or
 *                  docked, no mission) and its software stop is engaged
 *   recovery       the package gives a recovery procedure and a recovery
 *                  method (how a failed flash is undone at the bench)
 *   authorisation  a signed-in person, in the app, typed the robot's name and
 *                  serial number and stated they are at the robot
 *
 * Nothing a model, an agent or a developer key does can start one: there is no
 * action for it in the Action Engine, the routes take only a signed-in
 * session, and `authorize` refuses any other caller.
 *
 * The flash itself goes through a driver (`FLASHERS`). The only driver in this
 * repository is the simulated one, which works on a simulated robot and writes
 * nothing anywhere. For a physical robot there is no driver:
 * the operation stops at BLOCKED_EXTERNAL_DEPENDENCY with every check
 * recorded, and says so.
 */
const crypto = require("node:crypto");
const semver = require("./semver");

const BLOCKED = "BLOCKED_EXTERNAL_DEPENDENCY";
const RECOVERY_METHODS = ["bootloader-dfu", "swd-jtag", "dual-bank", "removable-media", "vendor-tool"];
const STOPPED_MODES = new Set(["idle", "docked", "estopped", "paused"]);
const AUTH_WINDOW_MS = 15 * 60_000;
const lower = (value) => String(value ?? "").trim().toLowerCase();
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** Fields a firmware package has on top of the update manifest. */
function firmwareProblems(manifest) {
  const problems = [];
  const fw = manifest?.firmware;
  if (manifest?.kind !== "firmware") problems.push("This isn't a firmware package (kind must be \"firmware\").");
  if (!fw || typeof fw !== "object") return [...problems, "firmware { controller, hardwareIds, fromVersions, minBatteryPercent, recoveryMethod } is required."];
  if (!String(fw.controller || "").trim()) problems.push("firmware.controller must name the controller it is for.");
  if (!Array.isArray(fw.hardwareIds) || !fw.hardwareIds.length || !fw.hardwareIds.every((id) => typeof id === "string" && id.trim())) problems.push("firmware.hardwareIds must list the exact controller hardware ids.");
  if (!Array.isArray(fw.fromVersions) || !fw.fromVersions.length) problems.push("firmware.fromVersions must list the firmware versions it may be flashed over.");
  if (!Number.isSafeInteger(fw.minBatteryPercent) || fw.minBatteryPercent < 20 || fw.minBatteryPercent > 100) problems.push("firmware.minBatteryPercent must be 20 to 100.");
  if (!RECOVERY_METHODS.includes(fw.recoveryMethod)) problems.push(`firmware.recoveryMethod must be one of: ${RECOVERY_METHODS.join(", ")}.`);
  return problems;
}

/**
 * Every check, from the request, the package and the robot as it is now.
 *   request  { serialNumber, controllerHardwareId, manufacturer, model }
 *   verified the update package validation (signature and publisher)
 */
function checks({ request, manifest, verified, robot, activeMissions = 0 }) {
  const out = [];
  const add = (id, ok, detail) => out.push({ id, ok: Boolean(ok), detail });
  const fw = manifest.firmware || {};
  const state = robot.state || {};
  const sameIdentity = lower(request.manufacturer) === lower(robot.manufacturer) && lower(request.model) === lower(robot.model) && String(request.serialNumber || "") === String(robot.serialNumber || "") && String(request.serialNumber || "").length > 0;
  const target = (manifest.targets?.hardware || []).some((item) => lower(item.manufacturer) === lower(robot.manufacturer) && lower(item.model) === lower(robot.model));
  const controllerId = String(request.controllerHardwareId || "");
  const reportedController = (robot.actuators || []).concat(robot.sensors || []).find((part) => part.model && part.model === controllerId) || (state.controller?.hardwareId === controllerId ? { id: "controller" } : null);
  add("identity", sameIdentity && target && (fw.hardwareIds || []).includes(controllerId) && reportedController, !sameIdentity ? `The request names ${request.manufacturer} ${request.model} serial ${request.serialNumber || "(none)"}; the robot reports ${robot.manufacturer || "?"} ${robot.model || "?"} serial ${robot.serialNumber || "(none)"}. They must match exactly.` : !target ? `The package isn't built for ${robot.manufacturer} ${robot.model}.` : !(fw.hardwareIds || []).includes(controllerId) ? `The controller ${controllerId || "(none)"} isn't one the package was built for (${(fw.hardwareIds || []).join(", ")}).` : !reportedController ? `The robot doesn't report a controller with hardware id ${controllerId}.` : `Exactly ${robot.manufacturer} ${robot.model}, serial ${robot.serialNumber}, controller ${controllerId}.`);
  const signed = verified?.signature?.ok && verified?.publisher?.ok;
  const fromOk = (fw.fromVersions || []).includes(robot.firmwareVersion);
  add("firmware", signed && fromOk, !signed ? "The firmware package isn't signed by a publisher key pinned to this account." : !fromOk ? `The robot has firmware ${robot.firmwareVersion || "(not reported)"}; this image may only be flashed over ${(fw.fromVersions || []).join(", ")}.` : `Signed firmware ${manifest.version} for ${fw.controller}, over ${robot.firmwareVersion}.`);
  const runtimeOk = semver.satisfies(robot.runtimeVersion, manifest.targets?.runtime || "");
  const softwareOk = !manifest.targets?.software || semver.satisfies(robot.softwareVersion, manifest.targets.software);
  add("compatibility", runtimeOk && softwareOk, runtimeOk && softwareOk ? `Runtime ${robot.runtimeVersion} and software ${robot.softwareVersion || "(none)"} work with it.` : `It needs runtime ${manifest.targets?.runtime}${manifest.targets?.software ? ` and software ${manifest.targets.software}` : ""}; the robot reports ${robot.runtimeVersion || "?"} / ${robot.softwareVersion || "?"}.`);
  const battery = state.battery?.percent;
  const external = state.power?.external === true || state.battery?.charging === true;
  const powered = external || (finite(battery) && battery >= (fw.minBatteryPercent || 100));
  const stopped = STOPPED_MODES.has(state.mode) && !activeMissions && (state.estop?.engaged === true || state.softwareStop === true || state.mode === "estopped");
  add("power", robot.online && powered && stopped, !robot.online ? "The robot isn't connected; its power and state can't be read." : !powered ? `Battery ${finite(battery) ? `${battery}%` : "not reported"} and no external power; at least ${fw.minBatteryPercent}% or external power is needed.` : !stopped ? "The robot must be stopped (idle or docked, no mission) with its stop engaged." : `${external ? "On external power" : `Battery ${battery}%`}, stopped, stop engaged.`);
  const recovery = String(manifest.recovery?.procedure || "").trim();
  add("recovery", recovery.length >= 20 && RECOVERY_METHODS.includes(fw.recoveryMethod), recovery.length >= 20 && RECOVERY_METHODS.includes(fw.recoveryMethod) ? `Recovery by ${fw.recoveryMethod}: ${recovery.slice(0, 300)}` : "The package doesn't give a usable recovery procedure and method.");
  return out;
}

/**
 * A signed-in person's authorisation. `caller` must be a session; the
 * confirmation must repeat the robot's name and serial number.
 */
function authorize({ caller, robot, confirmName, confirmSerial, atRobot, now }) {
  if (caller?.via !== "session") throw Object.assign(new Error("Only a signed-in person, in the app, can authorise flashing firmware. A developer key, an agent or a model can't."), { status: 403, reason: "session-required" });
  if (atRobot !== true) throw Object.assign(new Error("Confirm that you are at the robot and can recover it by hand."), { status: 400, reason: "not-attested" });
  if (String(confirmName || "").trim() !== robot.name || String(confirmSerial || "").trim() !== String(robot.serialNumber || "")) throw Object.assign(new Error("Type the robot's name and serial number exactly to authorise this flash."), { status: 400, reason: "confirmation-mismatch" });
  return { by: caller.email || caller.id, at: now, statement: `I am at ${robot.name} (serial ${robot.serialNumber}) and can recover it if the flash fails.`, expiresAt: now + AUTH_WINDOW_MS };
}

/**
 * Flasher drivers. A driver answers { ok, status, detail, simulated }.
 * Only the simulated driver exists; it refuses a physical robot.
 */
const FLASHERS = {
  simulated: {
    id: "simulated",
    simulated: true,
    title: "Simulated flasher (writes nothing)",
    supports: (robot) => Boolean(robot.simulated),
    async flash({ robot, manifest, image }) {
      if (!robot.simulated) return { ok: false, status: "refused", simulated: true, detail: "The simulated flasher only runs against a simulated robot." };
      const digest = image ? crypto.createHash("sha256").update(image).digest("hex") : manifest.artifacts[0].sha256;
      if (digest !== manifest.artifacts[0].sha256) return { ok: false, status: "failed", simulated: true, detail: "The image doesn't match the package's SHA-256." };
      return { ok: true, status: "simulated-flashed", simulated: true, detail: `Simulated: firmware ${manifest.version} (${digest.slice(0, 12)}…) would be written to ${manifest.firmware.controller}. Nothing was written to any hardware.`, newFirmwareVersion: manifest.version };
    },
  },
};

function flasherFor(robot) {
  return Object.values(FLASHERS).find((driver) => driver.supports(robot)) || null;
}

module.exports = { AUTH_WINDOW_MS, BLOCKED, FLASHERS, RECOVERY_METHODS, authorize, checks, firmwareProblems, flasherFor };
