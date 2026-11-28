"use strict";

/**
 * Turn what a robot or Robot OS reported into maintenance measurements.
 *
 * Only numbers the device itself sent are used. A field that is missing,
 * not a finite number, or outside a physically possible range is dropped,
 * never filled in. Nothing here estimates a value.
 *
 * Accepted in a robot's state report (all optional):
 *   battery:     { voltageV, currentA, temperatureC }           (voltage, current, temperature)
 *   motors:      [{ id, temperatureC, currentA, voltageV, encoderResidualMps, vibrationRms, errorCount }] or { id: {...} }
 *   controllers: [{ id, temperatureC, voltageV, errorCount }] or { id: {...} }
 *   vibration:   { rms }                                         (the base, in g)
 *   compute:     { cpuTemperatureC, cpuPercent, memoryPercent }
 *   sensors:     { <id>: { bias…, drift…, offset…, calibrationError… } }   (sensor drift fields)
 *   faults:      [{ code, message, source }]                     (fault codes; source must name the controller that reported it)
 * snake_case spellings (temperature_c, current_a, voltage_v) are accepted too.
 *
 * Robot OS sends pre-aggregated windows (services/maintenance_features.py):
 *   { window_ms, controllers: { <id>: { temperature_c: { n, mean, min, max, last }, … } }, fault_codes: [...] }
 */

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const slug = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

// Physically possible ranges: a value outside is a broken reading, not a measurement.
const RANGES = {
  temperatureC: [-60, 250], currentA: [-500, 500], voltageV: [0, 1000], encoderResidualMps: [0, 20], vibrationRms: [0, 50],
  errorCount: [0, 1e9], cpuPercent: [0, 100], memoryPercent: [0, 100], sensorBias: [-1e6, 1e6],
};
const UNITS = { temperatureC: "°C", currentA: "A", voltageV: "V", encoderResidualMps: "m/s", vibrationRms: "g", errorCount: "errors", cpuPercent: "%", memoryPercent: "%", sensorBias: "" };
const ALIASES = {
  temperatureC: ["temperatureC", "temperature_c", "tempC", "temp_c", "temp_motor_c"], currentA: ["currentA", "current_a", "motor_current_a"],
  voltageV: ["voltageV", "voltage_v", "input_voltage_v"], encoderResidualMps: ["encoderResidualMps", "encoder_residual_mps"],
  vibrationRms: ["vibrationRms", "vibration_rms"], errorCount: ["errorCount", "error_count"],
};

function valid(metric, value) {
  if (!finite(value)) return false;
  const [low, high] = RANGES[metric] || [-Infinity, Infinity];
  return value >= low && value <= high;
}
function read(source, metric) {
  for (const key of ALIASES[metric] || [metric]) if (finite(source?.[key])) return source[key];
  return undefined;
}
function entries(group) {
  if (Array.isArray(group)) return group.filter((item) => item && typeof item === "object").map((item, index) => [slug(item.id ?? item.name ?? index), item]);
  if (group && typeof group === "object") return Object.entries(group).filter(([, item]) => item && typeof item === "object").map(([id, item]) => [slug(id), item]);
  return [];
}

/** Measurements in one robot state report: [{ component, metric, value, unit }]. */
function fromRobotState(state) {
  const out = [];
  const push = (component, metric, value) => { if (valid(metric, value)) out.push({ component, metric, value, unit: UNITS[metric] ?? "" }); };
  if (!state || typeof state !== "object") return out;
  for (const metric of ["voltageV", "currentA", "temperatureC"]) push("battery", metric, read(state.battery, metric));
  for (const [id, motor] of entries(state.motors).slice(0, 16)) for (const metric of ["temperatureC", "currentA", "voltageV", "encoderResidualMps", "vibrationRms", "errorCount"]) push(`motor:${id}`, metric, read(motor, metric));
  for (const [id, controller] of entries(state.controllers).slice(0, 8)) for (const metric of ["temperatureC", "voltageV", "currentA", "errorCount"]) push(`controller:${id}`, metric, read(controller, metric));
  push("base", "vibrationRms", finite(state.vibration?.rms) ? state.vibration.rms : read(state.vibration, "vibrationRms"));
  if (state.compute && typeof state.compute === "object") {
    push("computer", "temperatureC", finite(state.compute.cpuTemperatureC) ? state.compute.cpuTemperatureC : read(state.compute, "temperatureC"));
    push("computer", "cpuPercent", state.compute.cpuPercent);
    push("computer", "memoryPercent", state.compute.memoryPercent);
  }
  for (const [id, sensor] of entries(state.sensors).slice(0, 16)) {
    for (const [key, value] of Object.entries(sensor).slice(0, 30)) {
      if (/^(bias|drift|offset|calibration_?error)/i.test(key) && valid("sensorBias", value)) out.push({ component: `sensor:${id}`, metric: `sensorBias.${slug(key)}`, value, unit: "" });
    }
  }
  return out;
}

// A fault counts as a controller-reported fault code only when the robot says a controller (or the
// battery's management system, or firmware) reported it. A runtime's own observation ("odometry-stale")
// is not a fault code and never becomes a confirmed fault.
const CONTROLLER_SOURCE = /controller|motor|drive|firmware|bms|battery-management/i;

/** Fault codes a robot's controllers reported: [{ component, code, message, source }]. */
function faultsFromRobotState(state) {
  const faults = Array.isArray(state?.faults) ? state.faults : [];
  return faults.filter((fault) => fault && (typeof fault.code === "string" || finite(fault.code)) && CONTROLLER_SOURCE.test(String(fault.source || ""))).slice(0, 20).map((fault) => ({
    component: fault.component ? slug(fault.component) : fault.motor ? `motor:${slug(fault.motor)}` : fault.controller ? `controller:${slug(fault.controller)}` : "robot",
    code: String(fault.code).slice(0, 60), message: String(fault.message || "").slice(0, 200), source: String(fault.source || "robot").slice(0, 40),
  }));
}

const OS_METRICS = { temperature_c: "temperatureC", temp_motor_c: "temperatureC", current_a: "currentA", motor_current_a: "currentA", voltage_v: "voltageV", input_voltage_v: "voltageV", encoder_residual_mps: "encoderResidualMps", vibration_rms: "vibrationRms", error_count: "errorCount", temp_fet_c: "temperatureC" };

/**
 * Robot OS's pre-aggregated window: [{ component, metric, unit, stats: { n, mean, min, max, last } }].
 * A window whose statistics don't hang together (min > max, mean outside them) is dropped whole.
 */
function fromRobotOSFeatures(payload) {
  const out = [];
  for (const [id, metrics] of entries(payload?.controllers).slice(0, 16)) {
    for (const [key, stats] of Object.entries(metrics).slice(0, 20)) {
      const metric = OS_METRICS[key];
      if (!metric || !stats || typeof stats !== "object") continue;
      const { n, mean, min, max } = stats;
      const last = finite(stats.last) ? stats.last : mean;
      if (!(Number.isInteger(n) && n > 0 && n <= 1e6) || ![mean, min, max, last].every((value) => valid(metric, value)) || min > max || mean < min - 1e-9 || mean > max + 1e-9) continue;
      const component = key === "temp_fet_c" || key === "input_voltage_v" ? `controller:${id}` : `motor:${id}`;
      out.push({ component, metric, unit: UNITS[metric], stats: { n, mean, min, max, last, sumsq: finite(stats.std) && n > 1 ? (stats.std ** 2) * (n - 1) + n * mean * mean : n * mean * mean } });
    }
  }
  return out;
}
function faultsFromRobotOS(payload) {
  const list = Array.isArray(payload?.fault_codes) ? payload.fault_codes : [];
  return list.filter((item) => item && item.fault).slice(0, 20).map((item) => ({ component: `controller:${slug(item.controller_id)}`, code: String(item.fault).slice(0, 60), message: String(item.detail || "").slice(0, 200), source: "robot-os motor controller" }));
}

module.exports = { RANGES, UNITS, faultsFromRobotOS, faultsFromRobotState, fromRobotOSFeatures, fromRobotState, valid };
