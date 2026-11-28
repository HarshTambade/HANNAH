"use strict";

/**
 * What HANNAH knows about each maintenance metric: its unit, which direction
 * is a concern, generic limits, the possible causes of a change and what a
 * person should inspect.
 *
 * The limits are generic defaults for common hobby and light-industrial
 * hardware, NOT the ratings of any particular motor, battery or controller.
 * A person can set the real ones per robot (PUT /api/maintenance/limits).
 * Causes are possibilities to check, never a diagnosis: every finding shows
 * them under "possible causes (not confirmed)".
 */

const METRICS = {
  temperatureC: {
    label: "temperature", unit: "°C", concern: "up",
    limits: { motor: { warn: 70, critical: 85 }, controller: { warn: 80, critical: 95 }, battery: { warn: 45, critical: 55 }, computer: { warn: 80, critical: 90 } },
    causes: {
      motor: ["More load or friction: worn bearings, a dragging brake, debris or a tangled wheel", "Less cooling: blocked vents, a failed fan, a hot environment", "The controller asking for more current (a changed payload or tuning)"],
      controller: ["Less cooling: dust on the heatsink, a failed fan, a blocked airflow path", "Higher current through the controller (heavier load, a stalled motor)", "A loose power connection heating at the terminal"],
      battery: ["High charge or discharge current", "Ageing cells with higher internal resistance", "A hot environment or poor ventilation around the pack"],
      computer: ["Dust or a failed fan on the computer", "A heavier software load than usual", "A hot enclosure"],
      default: ["More load, less cooling, or a hotter environment"],
    },
    inspect: {
      motor: ["Let it cool, then turn the wheel or joint by hand (power off): it should move freely without grinding", "Check the motor's vents and fan, and remove debris or hair from the axle", "Compare its temperature with the other motors under the same task"],
      controller: ["Check the controller's heatsink and fan for dust", "Check the power terminals for discoloration or looseness (power off)"],
      battery: ["Check the pack for swelling, heat spots or a smell (do not charge a swollen pack)", "Check the charger's current setting against the pack's rating"],
      computer: ["Clean the computer's fan and vents", "Look at which processes use the most CPU"],
      default: ["Inspect the component's cooling and load"],
    },
  },
  currentA: {
    label: "current", unit: "A", concern: "up", limits: {},
    causes: { motor: ["Friction in the drivetrain (bearings, gearbox, brake)", "A heavier payload or a wheel obstructed", "A failing motor winding or controller tuning change"], default: ["Higher load or friction"] },
    inspect: { motor: ["Turn the wheel or joint by hand with power off; feel for roughness", "Check for obstructions, tangled material and tyre wear", "Compare current with the other motors on the same task"], default: ["Check what the component is driving"] },
  },
  voltageV: {
    label: "voltage", unit: "V", concern: "down", limits: {},
    causes: { battery: ["Ageing cells (lower capacity, higher internal resistance)", "A loose or corroded connector dropping voltage under load", "A heavier load than usual"], controller: ["Supply voltage dropping under load: battery, wiring or connector"], default: ["Supply or connection problem"] },
    inspect: { battery: ["Measure the pack voltage at rest and under load with a meter", "Check connectors and crimps for heat marks or corrosion (power off)"], controller: ["Check the supply wiring and connectors to the controller"], default: ["Check the supply wiring"] },
  },
  encoderResidualMps: {
    label: "encoder disagreement", unit: "m/s", concern: "up", limits: {},
    causes: { default: ["Wheel slip (worn tread, a slippery floor)", "A loose encoder or coupling", "Encoder damage or electrical noise on its cable"] },
    inspect: { default: ["Check the wheel's tread and that it is tight on its shaft", "Check the encoder's mounting and cable", "Run a straight-line test and compare the measured distance"] },
  },
  vibrationRms: {
    label: "vibration (RMS)", unit: "g", concern: "up", limits: {},
    causes: { default: ["Bearing wear", "A loose mount or fastener", "A damaged or unbalanced wheel"] },
    inspect: { default: ["Check fasteners and mounts for looseness", "Spin wheels by hand and listen for roughness", "Look for flat spots or damage on wheels"] },
  },
  errorCount: {
    label: "controller error count", unit: "errors", concern: "up", limits: {},
    causes: { default: ["Electrical noise or a marginal connection", "The controller hitting a limit (current, temperature)", "Firmware problems"] },
    inspect: { default: ["Read the controller's own error log", "Check its connections and cable routing"] },
  },
  cpuPercent: { label: "CPU use", unit: "%", concern: "up", limits: { computer: { warn: 90, critical: 98 } }, causes: { default: ["More software running than usual", "A process stuck in a loop"] }, inspect: { default: ["Look at which processes use the most CPU"] } },
  memoryPercent: { label: "memory use", unit: "%", concern: "up", limits: { computer: { warn: 90, critical: 97 } }, causes: { default: ["A memory leak in a process", "More software running than usual"] }, inspect: { default: ["Look at which processes use the most memory"] } },
  sensorBias: {
    label: "sensor bias", unit: "", concern: "both", limits: {},
    causes: { default: ["Sensor drift with age or temperature", "A knock that moved the sensor", "Calibration out of date"] },
    inspect: { default: ["Recalibrate the sensor following its manufacturer's procedure", "Check its mounting"] },
  },
  // Event rates, counted per day from recorded events and missions.
  linkLossesPerDay: {
    label: "link losses", unit: "per day", concern: "up", limits: {}, rate: true,
    causes: { default: ["Weak Wi-Fi where the robot works", "A failing network adapter or antenna", "The robot's computer overloaded"] },
    inspect: { default: ["Check signal strength along the robot's routes", "Check the network adapter and antenna connections"] },
  },
  navFailuresPerDay: {
    label: "navigation failures", unit: "per day", concern: "up", limits: {}, rate: true,
    causes: { default: ["Localization drifting (encoder or lidar problems)", "The map no longer matches the space", "Wheel slip"] },
    inspect: { default: ["Check the lidar window for dirt or damage", "Check the map against the space", "Look at the failed missions' reasons"] },
  },
  controllerFaultsPerDay: {
    label: "controller faults", unit: "per day", concern: "up", limits: {}, rate: true,
    causes: { default: ["The controller hitting a limit (current, temperature, voltage)", "A marginal connection", "Firmware problems"] },
    inspect: { default: ["Read the fault codes the robot reported", "Check power and motor connections (power off)"] },
  },
  missionSuccessRate: {
    label: "mission success rate", unit: "share", concern: "down", limits: {},
    causes: { default: ["A hardware problem making tasks fail (see the other findings)", "The environment changed", "Tasks asked of the robot changed"] },
    inspect: { default: ["Look at the reasons failed missions give"] },
  },
};

const COMPONENT_KINDS = ["motor", "controller", "battery", "computer", "sensor", "base", "link", "navigation", "missions"];

function componentKind(component) {
  const kind = String(component || "").split(":")[0];
  return COMPONENT_KINDS.includes(kind) ? kind : "default";
}
function metricInfo(metric) {
  return METRICS[metric] || { label: metric, unit: "", concern: "both", limits: {}, causes: { default: ["Not known for this measurement"] }, inspect: { default: ["Inspect the component"] } };
}
const pick = (table, kind) => (table && (table[kind] || table.default)) || [];
function causesFor(metric, component) { return pick(metricInfo(metric).causes, componentKind(component)); }
function inspectionFor(metric, component) { return pick(metricInfo(metric).inspect, componentKind(component)); }
function limitsFor(metric, component, overrides = {}) {
  const own = overrides?.[`${component}.${metric}`] || overrides?.[`${componentKind(component)}.${metric}`];
  if (own) return { ...own, source: "set by a person" };
  const generic = metricInfo(metric).limits?.[componentKind(component)];
  return generic ? { ...generic, source: "generic default, not this hardware's rating" } : null;
}

module.exports = { COMPONENT_KINDS, METRICS, causesFor, componentKind, inspectionFor, limitsFor, metricInfo };
