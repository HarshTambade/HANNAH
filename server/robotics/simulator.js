"use strict";

/**
 * HANNAH's built-in simulator, run from the server for the sim-to-real
 * pipeline. It runs robotics/runtime (Python) as a child process:
 *
 *   describe   python3 -m hannah_robot describe --profile <profile>
 *   scenarios  python3 -m hannah_robot.scenarios --json --profile <profile> --overrides <json> <scenario files>
 *
 * Only profiles in robotics/profiles and scenarios in robotics/scenarios are
 * used: a name from a request is looked up in those folders, never treated
 * as a path. Nothing here is Gazebo or a physical robot, and every result
 * says so (`physical: false`).
 *
 * A server without Python or without the robotics folder (a serverless host,
 * for example) can't run the simulator; `available()` says so and the run is
 * refused with that reason instead of pretending.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(process.env.HANNAH_ROBOTICS_DIR || path.join(__dirname, "..", "..", "robotics"));
const RUNTIME = path.join(ROOT, "runtime");
const PROFILES = path.join(ROOT, "profiles");
const SCENARIOS = path.join(ROOT, "scenarios");
const PYTHON = process.env.HANNAH_SIMULATOR_PYTHON || "python3";
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const TIMEOUT_MS = Math.max(5_000, Number(process.env.HANNAH_SIMULATOR_TIMEOUT_MS) || 180_000);
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

const listJson = (dir) => { try { return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).filter((name) => NAME.test(name)).sort(); } catch { return []; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

function profiles() {
  return listJson(PROFILES).map((name) => {
    const profile = readJson(path.join(PROFILES, `${name}.json`)) || {};
    return { name, adapter: profile.adapter || "", model: profile.identity?.model || "", robotType: profile.identity?.robotType || "", scenarioRunner: profile.adapter === "kinematic" };
  });
}
function scenarios() {
  return listJson(SCENARIOS).map((name) => {
    const scenario = readJson(path.join(SCENARIOS, `${name}.json`)) || {};
    return { name, title: scenario.name || name, description: scenario.description || "", robotTypes: ["differential-drive"] };
  });
}
function profilePath(name) {
  if (!NAME.test(String(name || "")) || !listJson(PROFILES).includes(name)) throw fail(404, `There is no simulator profile called “${String(name || "").slice(0, 60)}”. Profiles: ${listJson(PROFILES).join(", ")}.`, "unknown-profile");
  return path.join(PROFILES, `${name}.json`);
}
function scenarioPaths(names) {
  const known = listJson(SCENARIOS);
  const wanted = Array.isArray(names) && names.length ? [...new Set(names.map(String))] : known;
  for (const name of wanted) if (!known.includes(name)) throw fail(404, `There is no scenario called “${name.slice(0, 60)}”. Scenarios: ${known.join(", ")}.`, "unknown-scenario");
  if (!wanted.length) throw fail(503, "No scenarios are installed on this server.", "no-scenarios");
  return wanted.map((name) => path.join(SCENARIOS, `${name}.json`));
}

function run(args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(PYTHON, args, { cwd: RUNTIME, env: { PATH: process.env.PATH || "", PYTHONDONTWRITEBYTECODE: "1", HOME: os.tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(fail(503, "This server can't start the built-in simulator (no Python).", "simulator-unavailable"));
      return;
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(fail(504, `The simulator didn't finish in ${Math.round(timeoutMs / 1000)} s.`, "simulator-timeout")); }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (out.length < 8_000_000) out += chunk; });
    child.stderr.on("data", (chunk) => { if (err.length < 20_000) err += chunk; });
    child.on("error", () => { clearTimeout(timer); reject(fail(503, "This server can't start the built-in simulator (no Python).", "simulator-unavailable")); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

let availability = null;
/** Whether this server can run the simulator. Checked once. */
async function available() {
  if (availability) return availability;
  if (!fs.existsSync(path.join(RUNTIME, "hannah_robot", "scenarios.py"))) {
    availability = { ok: false, reason: "The robotics runtime isn't installed next to this server, so the built-in simulator can't run here. Run the server from a full HANNAH checkout." };
    return availability;
  }
  try {
    const { code, out } = await run(["-c", "import hannah_robot.scenarios, sys; print(sys.version.split()[0])"], { timeoutMs: 20_000 });
    availability = code === 0 ? { ok: true, python: out.trim() } : { ok: false, reason: "Python is here but the robotics runtime doesn't import." };
  } catch (error) {
    availability = { ok: false, reason: error.message };
  }
  return availability;
}

/** What the simulated robot says about itself: the "sim" side of a parity report. */
async function describe(profileName) {
  const file = profilePath(profileName);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-sim-"));
  try {
    const { code, out, err } = await run(["-m", "hannah_robot", "describe", "--profile", file, "--state-dir", state], { timeoutMs: 30_000 });
    if (code !== 0) throw fail(422, `The simulator couldn't load the profile: ${err.trim().slice(0, 200) || `exit ${code}`}`, "profile-invalid");
    const descriptor = JSON.parse(out);
    const profile = readJson(file) || {};
    delete descriptor.hostname;
    return { profile: profileName, adapter: profile.adapter, robot: profile.robot || {}, descriptor, simulator: profile.adapter === "arm-kinematic" ? "hannah-arm-kinematic" : "hannah-kinematic", physical: false };
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
}

/** Run scenarios with a profile and the change's overrides. The report is the simulator's own. */
async function runScenarios({ profile, scenarios: names, overrides = {} }) {
  const check = await available();
  if (!check.ok) throw fail(503, check.reason, "simulator-unavailable");
  const args = ["-m", "hannah_robot.scenarios", "--json", "--profile", profilePath(profile), "--overrides", JSON.stringify(overrides || {}), ...scenarioPaths(names)];
  const startedAt = Date.now();
  const { code, out, err } = await run(args);
  let report = null;
  try { report = JSON.parse(out.trim().split("\n").pop()); } catch { report = null; }
  if (!report) throw fail(500, `The simulator stopped without a report (exit ${code}). ${err.trim().slice(-200)}`, "simulator-failed");
  if (!report.ok) throw fail(422, `The simulator refused the configuration: ${report.error}`, "simulator-config");
  return { ...report, physical: false, exitCode: code, startedAt, finishedAt: Date.now() };
}

module.exports = { PROFILES, SCENARIOS, available, describe, profiles, runScenarios, scenarios, _reset: () => { availability = null; } };
