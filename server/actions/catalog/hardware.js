"use strict";

/**
 * Connected devices (lights, plugs, sensors, meters) as Action Engine actions.
 *
 * A device is changed the same way an email is sent: the engine checks the
 * account's permission for "Devices and smart hardware", asks for approval
 * when the level or the action's own flags require it, runs it once, checks
 * the result and records all of it. What is specific to devices:
 *
 *   - There is no action that takes a topic, a register or a URL. An action
 *     names a device and one of the points its profile lists.
 *   - assess() runs the Device Safety Gateway. A change that can't be valid
 *     (a read-only point, a value out of range, a point the person hasn't
 *     allowed, a hub that is away) is refused with the reason and is never
 *     shown for approval.
 *   - "done" means the device itself reported the new value. A write the
 *     device didn't confirm is reported as not confirmed, never as done.
 *   - An automation is created here, so a person approves exactly what it
 *     will do; after that the hub runs it by itself, with no model involved.
 */
const { shown } = require("../../devices/safety");

const fail = (status, message, reason, extra = {}) => Object.assign(new Error(message), { status, reason, ...extra });
const clip = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const DEVICE = { type: "string", description: "The device's name or id, as listed by hardware.list." };
const kindLabel = (device) => (device.profile.simulated ? "SIMULATED DEVICE" : "REAL DEVICE");

function reading(device, point) {
  const value = device.points?.[point.id];
  if (!value) return { point: point.id, name: point.name, value: null, note: "No value has been received." };
  return { point: point.id, name: point.name, value: value.value, unit: point.unit || null, ageSeconds: value.ageS, live: value.live, ...(value.live ? {} : { note: `Not live: this is the last value HANNAH received, ${value.ageS} seconds ago.` }) };
}
const summary = (device) => ({
  id: device.id, name: device.name, location: device.location || null, kind: device.profile.simulated ? "simulated" : "real", type: device.profile.categoryLabel || device.profile.category, maker: `${device.profile.manufacturer} ${device.profile.model}`,
  status: device.status, connection: device.connection, hub: device.hub.name,
  canRead: device.profile.points.map((point) => point.id), canChange: device.profile.points.filter((point) => point.access === "read-write" && (device.writable || []).includes(point.id)).map((point) => point.id),
});
function commandText(command, device, point) {
  const what = `${point.name} on ${device.name}`;
  switch (command.status) {
    case "done": return `${what} is now ${shown(point, command.result?.readback?.value ?? command.value)}. The device reported it.`;
    case "unverified": return command.result?.readback?.confirmed === null ? `${what}: sent. This point reports nothing back, so it can't be confirmed.` : `${what}: sent, but the device still reports ${command.result?.readback?.value === null || command.result?.readback?.value === undefined ? "nothing" : shown(point, command.result.readback.value)}. It is not confirmed.`;
    case "refused": return `${what}: the hub's own checks refused it. ${command.error || ""}`.trim();
    case "failed": return `${what}: it failed. ${command.error || ""}`.trim();
    case "expired": return `${what}: never sent. ${command.error}`;
    case "no-answer": return `${what}: outcome unknown. ${command.error}`;
    default: return `${what}: waiting for the hub (${command.status}). Nothing is confirmed yet.`;
  }
}
function ruleText(rule) {
  const side = (item) => `${item.deviceName} ${item.point}`;
  const value = (item) => (typeof item.value === "boolean" ? (item.value ? "on" : "off") : item.value);
  const when = rule.when.map((item) => `${side(item)} ${item.op} ${value(item)}`).join(" and ");
  const act = (list) => list.map((item) => `set ${side(item)} to ${value(item)}`).join(", ");
  return `When ${when}${rule.forS ? ` for ${rule.forS} s` : ""}: ${act(rule.then)}${rule.otherwise.length ? `. When that stops being true: ${act(rule.otherwise)}` : ""}.`;
}

function hardwareActions({ devices }) {
  const read = ({ id, title, description, input = {}, required = [], run }) => ({
    id, service: "hardware", kind: "read", title, description, needs: "A device added under Devices", input: { type: "object", properties: input, required },
    normalize: (raw) => Object.fromEntries(Object.keys(input).map((key) => [key, input[key].type === "number" ? Number(raw?.[key]) || undefined : clip(raw?.[key], 80)])),
    assess: () => ({}), preview: () => ({ title, lines: [] }), execute: (params, ctx) => run(params, ctx),
    verify: () => ({ confirmed: true, evidence: "Read from what the hub last reported; each value carries its age." }),
  });

  /** One change to one point. `resolve` turns the tool's input into { point, value }. */
  const change = ({ id, title, description, input, required, resolve }) => ({
    id, service: "hardware", kind: "write", title, description, needs: "A device switched on under Devices, with this change allowed", input: { type: "object", properties: { device: DEVICE, ...input }, required: ["device", ...required] },
    normalize: (raw) => ({ device: clip(raw?.device, 80), point: clip(raw?.point, 40), ...(raw?.on === undefined ? {} : { on: raw.on === true || raw.on === "true" || raw.on === "on" }), ...(raw?.value === undefined ? {} : { value: typeof raw.value === "string" && raw.value.trim() !== "" && Number.isFinite(Number(raw.value)) ? Number(raw.value) : raw.value }) }),
    async assess(params, ctx) {
      const device = await devices.resolveDevice(ctx.db, ctx.userId, params.device);
      const target = resolve(params, device);
      const verdict = await devices.assessWrite(ctx.db, ctx.userId, device.id, target.point, target.value);
      const flags = verdict.ok ? verdict.flags : [`forbidden:${verdict.violations.map((item) => item.message).join(" ")}`];
      return { resource: { type: "device", id: device.id }, account: device.name, flags, verdict, target };
    },
    preview(_params, _ctx, assessed) {
      const { verdict } = assessed;
      const device = verdict.device;
      const now = verdict.point ? device.points?.[verdict.point.id] : null;
      return {
        title: verdict.point ? `Set ${verdict.point.name} on ${device.name} to ${verdict.text ?? assessed.target.value}` : `Change ${device.name}`,
        lines: [
          { label: "Device", value: `${device.name} — ${kindLabel(device)} (${device.profile.manufacturer} ${device.profile.model})` },
          ...(verdict.point ? [{ label: "Now", value: now ? `${shown(verdict.point, now.value)}${now.live ? "" : ` (last known, ${now.ageS} s ago)`}` : "unknown" }] : []),
          ...(verdict.risk ? [{ label: "Risk", value: verdict.risk }] : []),
          { label: "Checked", value: verdict.ok ? "The device is on, reporting, and this change is allowed and in range" : "Refused by the Device Safety Gateway" },
          { label: "Confirmed by", value: "Reading the value back from the device" },
        ],
        body: verdict.ok ? "The hub on your network sends it. The command is valid for 20 seconds; if the hub doesn't take it by then, nothing happens." : verdict.violations.map((item) => item.message).join("\n"),
        warnings: verdict.warnings,
      };
    },
    async execute(params, ctx) {
      const device = await devices.resolveDevice(ctx.db, ctx.userId, params.device);
      const target = resolve(params, device);
      const verdict = await devices.assessWrite(ctx.db, ctx.userId, device.id, target.point, target.value);
      if (!verdict.ok) throw fail(409, `Not sent. ${verdict.violations.map((item) => item.message).join(" ")}`, "safety-refused");
      const commandId = await devices.write(ctx.db, ctx.userId, { device, point: verdict.point.id, value: verdict.value, actionId: ctx.record?.id, requestedBy: ctx.record?.agent || "" });
      const command = await devices.waitForCommand(ctx.db, ctx.userId, commandId);
      if (["refused", "failed", "expired"].includes(command.status)) throw fail(409, commandText(command, device, verdict.point), `command-${command.status}`);
      return { commandId, device: { id: device.id, name: device.name, kind: device.profile.simulated ? "simulated" : "real" }, point: verdict.point.id, wanted: verdict.value, status: command.status, readback: command.result?.readback ?? null, note: commandText(command, device, verdict.point) };
    },
    async verify(response, _params, ctx) {
      const command = await devices.getCommand(ctx.db, ctx.userId, response.commandId);
      if (command.status === "done") return { confirmed: true, evidence: `The device reported ${response.point} = ${JSON.stringify(command.result?.readback?.value)} after the write.` };
      return { confirmed: false, evidence: response.note && command.status === response.status ? response.note : `The command is ${command.status}. ${command.error || ""}`.trim() };
    },
  });

  const ruleInput = {
    name: { type: "string", description: "A short name for the automation." },
    when: { type: "object", description: "The condition: { device, point, op, value, hysteresis? }. op is one of > >= < <= == !=. For several conditions: { all: [ … ] }.", properties: {} },
    then: { type: "array", description: "What to change when the condition becomes true: [{ device, point, value }].", items: { type: "object" } },
    otherwise: { type: "array", description: "Optional: what to change when it stops being true.", items: { type: "object" } },
    forS: { type: "number", description: "Optional: seconds the condition must hold first." },
    maxPerHour: { type: "number", description: "Optional: the most times it may act in an hour (default 30)." },
  };
  const ruleChange = ({ id, kind, title, description, apply, past }) => ({
    id, service: "hardware", kind, title, description, needs: "An automation created under Devices", input: { type: "object", properties: { automation: { type: "string", description: "The automation's name or id." } }, required: ["automation"] },
    normalize: (raw) => ({ automation: clip(raw?.automation, 80) }),
    async assess(params, ctx) { const rule = await devices.resolveRule(ctx.db, ctx.userId, params.automation); return { resource: { type: "automation", id: rule.id }, account: rule.name, rule }; },
    preview: (_params, _ctx, assessed) => ({ title: `${title}: ${assessed.rule.name}`, lines: [{ label: "It does", value: ruleText(assessed.rule) }], body: "" }),
    async execute(params, ctx) { const result = await apply(ctx, params.automation); return { ...result, note: `Automation “${result.name}” ${past}.` }; },
    verify: (response) => ({ confirmed: true, evidence: response.note }),
  });

  return [
    read({
      id: "hardware.list", title: "List devices", description: "The devices connected to HANNAH: what each is, whether it is reporting, what can be read from it and what may be changed.",
      run: async (_params, ctx) => { const overview = await devices.overview(ctx.db, ctx.userId); const all = await Promise.all(overview.devices.map((device) => devices.resolveDevice(ctx.db, ctx.userId, device.id))); return { devices: all.map(summary), hubs: overview.hubs.map((hub) => ({ name: hub.name, connection: hub.connection })), automationsPaused: overview.rulesSuspended }; },
    }),
    read({
      id: "hardware.read", title: "Read a device", description: "The latest values from a device: every point, or one. Each value says how old it is and whether it is live.", input: { device: DEVICE, point: { type: "string", description: "Optional: one point, such as temperature." } }, required: ["device"],
      run: async (params, ctx) => {
        const device = await devices.resolveDevice(ctx.db, ctx.userId, params.device);
        const points = device.profile.points.filter((point) => !params.point || point.id === params.point);
        if (!points.length) throw fail(404, `${device.name} has nothing called “${params.point}”. It has: ${device.profile.points.map((point) => point.id).join(", ")}.`, "unknown-point");
        return { device: summary(device), readings: points.map((point) => reading(device, point)), note: device.connection === "online" ? "Live values from the device." : `The device isn't reporting right now (${device.connectionDetail || device.connection}). These are the last values received.` };
      },
    }),
    read({
      id: "hardware.history", title: "A reading over time", description: "The recorded values of one point over the last minutes or hours (up to 24 hours).", input: { device: DEVICE, point: { type: "string", description: "The point, such as temperature." }, minutes: { type: "number", description: "How far back, in minutes (default 180)." } }, required: ["device", "point"],
      run: async (params, ctx) => {
        const device = await devices.resolveDevice(ctx.db, ctx.userId, params.device);
        const point = device.profile.points.find((item) => item.id === params.point);
        if (!point) throw fail(404, `${device.name} has nothing called “${params.point}”.`, "unknown-point");
        const samples = await devices.history(ctx.db, ctx.userId, device.id, point.id, { minutes: params.minutes });
        const numbers = samples.map((sample) => sample.value).filter((value) => typeof value === "number");
        return { device: device.name, point: point.id, unit: point.unit || null, samples: samples.slice(-200), count: samples.length, ...(numbers.length ? { lowest: Math.min(...numbers), highest: Math.max(...numbers), latest: numbers[numbers.length - 1] } : {}), note: samples.length ? "Recorded by the hub; a value is stored when it changes, and at least once a minute." : "Nothing was recorded in that time." };
      },
    }),
    change({
      id: "hardware.switch", title: "Switch a device on or off", description: "Turn a light, plug, fan or relay on or off. The device's own report confirms it.",
      input: { on: { type: "boolean", description: "true for on, false for off." }, point: { type: "string", description: "Optional: which switch, when the device has more than one." } }, required: ["on"],
      resolve(params, device) {
        const switches = device.profile.points.filter((point) => point.type === "boolean" && point.access === "read-write");
        const point = params.point ? switches.find((item) => item.id === params.point) : switches.length === 1 ? switches[0] : switches.find((item) => item.id === "power");
        if (!point) throw fail(400, switches.length ? `${device.name} has more than one switch: ${switches.map((item) => item.id).join(", ")}. Say which.` : `${device.name} has nothing that switches on and off.`, "unknown-point");
        if (typeof params.on !== "boolean") throw fail(400, "Say whether it should be on or off.", "bad-request");
        return { point: point.id, value: params.on };
      },
    }),
    change({
      id: "hardware.set_value", title: "Set a value on a device", description: "Set a level or setpoint (brightness, a limit) to a number inside the range the device allows.",
      input: { point: { type: "string", description: "The point, such as brightness." }, value: { description: "The new value: a number, or one of the point's choices." } }, required: ["point", "value"],
      resolve: (params) => ({ point: params.point, value: params.value }),
    }),
    read({ id: "hardware.automations", title: "List automations", description: "The automations hubs run by themselves: what each watches, what it changes, whether it is on, and when it last acted.", run: async (_params, ctx) => { const rules = await devices.listRules(ctx.db, ctx.userId); return { automations: rules.map((rule) => ({ id: rule.id, name: rule.name, on: rule.enabled, does: ruleText(rule), status: rule.status, detail: rule.detail || null, timesActed: rule.fires, lastActedAt: rule.lastFiredAt, lastProblem: rule.lastError })) }; } }),
    {
      id: "hardware.create_automation", service: "hardware", kind: "write", title: "Create an automation", needs: "Devices switched on under Devices",
      description: "Create a rule a hub runs by itself, with no AI involved: when a reading crosses a value, change something. Example: when the room sensor's temperature is above 28, switch the fan on, and off again when it falls. Only points a person allowed can be changed, and never a high-risk one.",
      input: { type: "object", properties: ruleInput, required: ["name", "when", "then"] },
      normalize: (raw) => ({ name: clip(raw?.name, 80), when: raw?.when && typeof raw.when === "object" ? raw.when : {}, then: Array.isArray(raw?.then) ? raw.then.slice(0, 4) : [], otherwise: Array.isArray(raw?.otherwise) ? raw.otherwise.slice(0, 4) : [], ...(raw?.forS === undefined ? {} : { forS: Number(raw.forS) }), ...(raw?.maxPerHour === undefined ? {} : { maxPerHour: Number(raw.maxPerHour) }) }),
      async assess(params, ctx) {
        const verdict = await devices.assessRule(ctx.db, ctx.userId, params);
        return { resource: verdict.hubId ? { type: "hub", id: verdict.hubId } : null, account: params.name, flags: verdict.ok ? ["an automation acts by itself from now on, without asking each time", ...verdict.flags] : [`forbidden:${verdict.problems.join(" ")}`], verdict };
      },
      preview(_params, _ctx, assessed) {
        const { verdict } = assessed;
        return {
          title: `Create the automation “${verdict.rule.name}”`,
          lines: verdict.ok ? [
            { label: "Runs on", value: "Your hub, by itself. No AI is involved, and it keeps working without the internet" },
            { label: "Acts", value: `On the change, at most ${verdict.rule.maxPerHour} times an hour` },
            { label: "Won't act when", value: `The reading is older than ${verdict.rule.staleAfterS} seconds, or the device isn't reporting` },
          ] : [],
          body: verdict.ok ? "You can switch it off or remove it at any time under Devices." : verdict.problems.join("\n"),
        };
      },
      async execute(params, ctx) {
        const rule = await devices.createRule(ctx.db, ctx.userId, params, { actionId: ctx.record?.id });
        return { automationId: rule.id, name: rule.name, does: ruleText(rule), note: `Automation “${rule.name}” created and sent to the hub. ${ruleText(rule)}` };
      },
      async verify(response, _params, ctx) { const rule = (await devices.listRules(ctx.db, ctx.userId)).find((item) => item.id === response.automationId); return rule ? { confirmed: true, evidence: `The automation is stored and ${rule.status === "not-reported" ? "is being sent to the hub" : `the hub reports it as ${rule.status}`}.` } : { confirmed: false, evidence: "The automation isn't in the registry." }; },
    },
    ruleChange({ id: "hardware.enable_automation", kind: "write", title: "Switch an automation on", description: "Switch on an automation that was switched off.", past: "switched on", apply: (ctx, reference) => devices.setRule(ctx.db, ctx.userId, reference, { enabled: true }) }),
    ruleChange({ id: "hardware.disable_automation", kind: "write", title: "Switch an automation off", description: "Switch an automation off. Devices stay as they are.", past: "switched off; devices stay as they are", apply: (ctx, reference) => devices.setRule(ctx.db, ctx.userId, reference, { enabled: false }) }),
    ruleChange({ id: "hardware.delete_automation", kind: "destroy", title: "Remove an automation", description: "Remove an automation for good.", past: "removed", apply: (ctx, reference) => devices.deleteRule(ctx.db, ctx.userId, reference) }),
  ];
}

module.exports = { commandText, hardwareActions, ruleText };
