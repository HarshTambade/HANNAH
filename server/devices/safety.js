"use strict";

/**
 * The Device Safety Gateway: every check between "change this" and a signed
 * command to a hub. It is pure: it takes what the registry knows and answers.
 *
 * A write is refused, with the reason, when:
 *   - the device isn't active (it was never verified, or a person disabled it);
 *   - its hub is away, or the device itself isn't reporting;
 *   - the point doesn't exist, is read-only, or a person hasn't allowed HANNAH
 *     to change it on this device;
 *   - the value isn't the point's type, or is outside its range or step.
 *
 * A write that passes may still have to ask, whatever the permission level:
 *   - a high-risk point (a lock, an actuator, a controller) asks every time;
 *   - an elevated one (industrial equipment, mains loads) asks every time;
 *   - a point the person set to always ask.
 *
 * The hub repeats the checks it can make itself (allow-list, type, range)
 * because it must not rely on this server. Neither is a safety function:
 * interlocks, guards and emergency stops stay in the equipment.
 */
const { riskOf } = require("./profiles");

const ONLINE_MS = 20_000;
const STALE_MS = 120_000;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Is `value` acceptable for `point`? Returns { ok, value } or { ok: false, code, message }. Mirrors the hub's check_value. */
function checkValue(point, value) {
  const name = point.name || point.id;
  const no = (code, message) => ({ ok: false, code, message });
  if (point.type === "boolean") return typeof value === "boolean" ? { ok: true, value } : no("bad-value", `${name} is on or off.`);
  if (point.type === "number") {
    if (!isNumber(value)) return no("bad-value", `${name} needs a number.`);
    if (!Array.isArray(point.range)) return no("no-range", `${name} has no allowed range, so nothing can be written to it.`);
    const [low, high] = point.range;
    if (value < low || value > high) return no("out-of-range", `${name} accepts ${low} to ${high}${point.unit ? ` ${point.unit}` : ""}; ${value} is outside that.`);
    if (point.step) { const turns = (value - low) / point.step; if (Math.abs(turns - Math.round(turns)) > 1e-6) return no("bad-step", `${name} moves in steps of ${point.step}.`); }
    return { ok: true, value };
  }
  if (point.type === "enum") return (point.choices || []).includes(value) ? { ok: true, value } : no("bad-value", `${name} accepts: ${(point.choices || []).join(", ")}.`);
  return no("not-writable", `${name} can't be written.`);
}

const shown = (point, value) => (typeof value === "boolean" ? (value ? "on" : "off") : `${value}${point.unit ? ` ${point.unit}` : ""}`);

/**
 * May this write be sent?
 *   device   the registry's view of the device (status, hub, profile, writable, alwaysAsk, connection, points)
 * Returns { ok, violations: [{ code, message }], flags, warnings, point, value, risk }.
 */
function assessWrite(device, pointId, value, { at = Date.now(), forRule = false } = {}) {
  const violations = [];
  const flags = [];
  const warnings = [];
  const point = (device.profile.points || []).find((item) => item.id === pointId) || null;
  if (!point) return { ok: false, violations: [{ code: "unknown-point", message: `${device.name} has nothing called “${String(pointId).slice(0, 40)}”. It has: ${device.profile.points.map((item) => item.id).join(", ")}.` }], flags, warnings, point: null, value, risk: null };
  const risk = riskOf(device.profile, point);
  if (point.access !== "read-write") violations.push({ code: "read-only", message: `${point.name} on ${device.name} can only be read.` });
  else {
    if (!(device.writable || []).includes(point.id)) violations.push({ code: "not-allowed", message: `You haven't allowed HANNAH to change ${point.name} on ${device.name}. Turn it on for this device under Devices.` });
    const checked = checkValue(point, value);
    if (!checked.ok) violations.push({ code: checked.code, message: checked.message });
  }
  if (!forRule) {
    if (device.status !== "active") violations.push({ code: "not-active", message: device.status === "disabled" ? `${device.name} is switched off in HANNAH.` : `${device.name} hasn't been checked and switched on yet.` });
    if (!device.hub?.online) violations.push({ code: "hub-offline", message: `The hub ${device.hub?.name || ""} isn't connected, so nothing can reach ${device.name}. Nothing is queued for later.`.replace("  ", " ") });
    else if (device.connection !== "online") violations.push({ code: "device-offline", message: `${device.name} isn't reporting (${device.connectionDetail || device.connection}).` });
    const reading = device.points?.[point.id];
    if (reading && at - reading.at > STALE_MS) warnings.push(`The last value HANNAH has for ${point.name} is ${Math.round((at - reading.at) / 1000)} seconds old.`);
  }
  if (risk === "high") flags.push(`${point.name} on ${device.name} is high risk (${device.profile.categoryLabel || device.profile.category}); it asks every time`);
  else if (risk === "elevated") flags.push(`${point.name} on ${device.name} is ${device.profile.domain === "industrial" ? "industrial equipment" : "marked elevated risk"}; it asks every time`);
  if ((device.alwaysAsk || []).includes(point.id)) flags.push(`you set ${point.name} on ${device.name} to always ask`);
  if (device.profile.simulated) warnings.push("This is a simulated device.");
  return { ok: violations.length === 0, violations, flags, warnings, point, value, risk, text: shown(point, value) };
}

const OPS = [">", ">=", "<", "<=", "==", "!="];
/**
 * Is this rule one a hub may run? `devices` are the registry's views, by id.
 * Returns { ok, problems, flags, rule } with the rule normalized to ids and typed values.
 */
function assessRule(input, devices) {
  const problems = [];
  const flags = [];
  const find = (reference) => devices.find((device) => device.id === reference) || devices.filter((device) => device.name.toLowerCase() === String(reference || "").toLowerCase())[0] || null;
  const name = String(input?.name || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  if (!name) problems.push("Give the automation a name.");
  const conditions = Array.isArray(input?.when?.all) ? input.when.all : input?.when ? [input.when] : [];
  if (!conditions.length || conditions.length > 4) problems.push("An automation needs one to four conditions.");
  let hubId = null;
  const sameHub = (device) => { if (hubId && device.hub?.id !== hubId) problems.push("Every device in one automation must be on the same hub: the hub runs it by itself."); hubId = hubId || device.hub?.id; };
  const when = [];
  for (const condition of conditions) {
    const device = find(condition?.device);
    if (!device) { problems.push(`There is no device called “${String(condition?.device).slice(0, 60)}”.`); continue; }
    sameHub(device);
    const point = device.profile.points.find((item) => item.id === condition.point);
    if (!point) { problems.push(`${device.name} has nothing called “${String(condition.point).slice(0, 40)}”. It has: ${device.profile.points.map((item) => item.id).join(", ")}.`); continue; }
    if (!OPS.includes(condition.op)) { problems.push(`The comparison must be one of: ${OPS.join(" ")}`); continue; }
    if (point.type === "number" ? !isNumber(condition.value) : point.type === "boolean" ? typeof condition.value !== "boolean" : typeof condition.value !== "string") { problems.push(`${point.name} is ${point.type === "number" ? "a number" : point.type === "boolean" ? "on or off" : "text"}; the value to compare with must be too.`); continue; }
    if (point.type !== "number" && !["==", "!="].includes(condition.op)) { problems.push(`${point.name} can only be compared with == or !=.`); continue; }
    if (device.status !== "active") problems.push(`${device.name} isn't switched on in HANNAH yet.`);
    const hysteresis = condition.hysteresis === undefined ? 0 : Number(condition.hysteresis);
    if (!isNumber(hysteresis) || hysteresis < 0) { problems.push("The margin must be zero or more."); continue; }
    when.push({ device: device.id, point: point.id, op: condition.op, value: condition.value, ...(hysteresis ? { hysteresis } : {}) });
  }
  const actions = (list, label, required) => {
    const out = [];
    if (list !== undefined && !Array.isArray(list)) { problems.push(`“${label}” must be a list of changes.`); return out; }
    if (required && !(list || []).length) problems.push("An automation needs at least one thing to do.");
    if ((list || []).length > 4) problems.push("An automation can change at most four things.");
    for (const action of (list || []).slice(0, 4)) {
      const device = find(action?.device);
      if (!device) { problems.push(`There is no device called “${String(action?.device).slice(0, 60)}”.`); continue; }
      sameHub(device);
      const verdict = assessWrite(device, action.point, action.value, { forRule: true });
      if (!verdict.ok) { problems.push(...verdict.violations.map((item) => item.message)); continue; }
      if (verdict.risk === "high") { problems.push(`${verdict.point.name} on ${device.name} is high risk. An automation can't change it; it needs a person each time.`); continue; }
      if (verdict.risk === "elevated") flags.push(`this automation will change ${verdict.point.name} on ${device.name} by itself, and that point is ${device.profile.domain === "industrial" ? "industrial equipment" : "marked elevated risk"}`);
      if (device.status !== "active") problems.push(`${device.name} isn't switched on in HANNAH yet.`);
      out.push({ device: device.id, point: verdict.point.id, value: action.value });
    }
    return out;
  };
  const then = actions(input?.then, "then", true);
  const otherwise = actions(input?.otherwise, "otherwise", false);
  const bounded = (value, low, high, fallback) => { const number = value === undefined ? fallback : Number(value); return isNumber(number) ? Math.max(low, Math.min(high, number)) : fallback; };
  const rule = {
    name, when: when.length === 1 ? when[0] : { all: when }, then, otherwise,
    forS: bounded(input?.forS, 0, 3600, 0), staleAfterS: bounded(input?.staleAfterS, 5, 3600, 120), maxPerHour: Math.round(bounded(input?.maxPerHour, 1, 120, 30)),
  };
  return { ok: problems.length === 0, problems: [...new Set(problems)], flags, rule, hubId };
}

module.exports = { ONLINE_MS, OPS, STALE_MS, assessRule, assessWrite, checkValue, shown };
