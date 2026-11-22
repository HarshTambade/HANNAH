/**
 * The client side of HANNAH's device registry (server/devices).
 *
 * A device never connects to this app, and this app never connects to a
 * device. A hub on the person's own network (HANNAH Edge) talks to the
 * devices and to the server; this file reads the server's record and asks for
 * changes through the Action Engine, so every change goes through the same
 * permission levels, approval and history as anything else HANNAH does.
 *
 * What is true of every answer here:
 *   - a value says how old it is, and whether it is live or only the last one
 *     known;
 *   - a change is "done" only when the device itself reported the new value;
 *   - nothing here carries a topic, a register or a URL: a device is a name
 *     and a list of named points.
 */
import { accountRequest } from "./Account";
import { isAccountSession } from "./api";
import type { HANNAHTool } from "./DeviceTools";
import { Operator, toolResult, type ActionRecord } from "./Operator";
import { MemoryService } from "./MemoryService";

export type Level = "plug-and-play" | "guided" | "experimental" | "simulation" | "developer-required" | "unsupported";
export type Compatibility = { level: Level; label: string; reasons: string[] };
export type PointInfo = { id: string; name: string; kind: "sensor" | "actuator"; type: "boolean" | "number" | "enum" | "text"; unit: string | null; range: [number, number] | null; step: number | null; choices: string[] | null; access: "read" | "read-write"; risk: "low" | "elevated" | "high" | null };
export type SettingField = { id: string; label: string; type: "text" | "number" | "secret" | "toggle" | "choice"; required: boolean; default?: string | number | boolean; help?: string; min?: number; max?: number; choices?: string[] };
export type Evidence = { document: { name: string; pages: number; source?: { id: string; name: string; mediaType: string; bytes: number } }; facts: Array<{ field: string; label: string; value: string | number; page: number; quote: string; confidence: string; state: string; hazardous?: boolean }> };
export type Profile = {
  id: string; version: string; name: string; author: string; manufacturer: string; model: string; category: string; categoryLabel: string; domain: string; simulated: boolean;
  protocol: { adapter: string; label: string; version: string | null }; connection: { instructions: string[]; fields: SettingField[] }; points: PointInfo[]; constraints: string[];
  tests: { level: string; passed: number; total: number } | null; documentation: string; source?: "builtin" | "studio" | "manual"; compatibility?: Compatibility; evidence?: Evidence;
};
export type Hub = {
  id: string; name: string; status: "pending" | "enrolled" | "revoked"; online: boolean; lastSeenAt: number | null; connection: "awaiting-enrollment" | "revoked" | "online" | "offline" | "never-connected";
  software: string | null; system: string | null; adapters: string[]; fingerprint: string | null; rulesSuspended: boolean; upToDate: boolean; enrollmentExpiresAt: number | null;
  discovered: { kind: string; at: number; note?: string; topics?: Array<{ topic: string; messages: number; sample?: string }>; ports?: Array<{ path: string }>; services?: Array<{ name: string; service?: string; address?: string; port?: number }>; devices?: Array<{ path: string; vendorId?: string | null; productId?: string | null; product?: string | null; manufacturer?: string | null; serial?: string | null; version?: string | null }>; service?: string } | null;
  updateStatus?: { current?: string | null; previous?: string | null; pending?: { version: string; since: number; starts: number } | null; last?: unknown } | null;
};
export type UpdateRollout = {
  id: string; version: string; cohortSize: number; kind: "update" | "rollback"; rollbackTo: string | null;
  status: string; detail: string | null; createdAt: number; updatedAt: number;
  targets: Array<{ hubId: string; hubName: string; ordinal: number; status: string; commandId: string | null; detail: string | null; updatedAt: number }>;
};
export type Check = { id: string; label: string; result: "pass" | "fail" | "warn" | "note" | "not-checked"; detail: string };
export type Verification = { at: number; level: "verified" | "partial" | "failed"; passed: boolean; heard?: number; expected?: number; checks: Check[]; simulated?: boolean; activatedAt?: number; acceptedPartial?: boolean };
export type Reading = { value: boolean | number | string; at: number; ageS: number; live: boolean; unit: string | null };
export type Device = {
  id: string; name: string; location: string; status: "added" | "verified" | "failed" | "active" | "disabled"; hub: { id: string; name: string; online: boolean };
  profile: Profile; profileSource: string; compatibility: Compatibility; settings: Record<string, string | number | boolean>; hasSecrets: boolean; writable: string[]; alwaysAsk: string[];
  verification: Verification | null; connection: "not-running" | "hub-offline" | "waiting" | "online" | "offline" | "no-data" | "error"; connectionDetail: string; points: Record<string, Reading>; rejected: number; lastSeenAt: number | null;
};
export type RulePart = { device: string; deviceName: string; point: string; value: boolean | number | string; op?: string; hysteresis?: number };
export type Automation = { id: string; hubId: string; name: string; enabled: boolean; when: RulePart[]; then: RulePart[]; otherwise: RulePart[]; forS: number; maxPerHour: number; status: string; detail: string; fires: number; lastFiredAt: number | null; lastError: string | null };
export type DeviceEvent = { id: string; hubId: string | null; deviceId: string | null; ruleId: string | null; at: number; type: string; severity: "info" | "warning" | "error"; message: string; source: string };
export type Change = { id: string; point: string | null; value: boolean | number | string | null; status: string; createdAt: number; error: string | null };
export type Overview = { hubs: Hub[]; devices: Device[]; rules: Automation[]; counts: Record<string, number>; rulesSuspended: boolean; canEnroll: boolean };
export type InventoryItem = {
  id: string; kind: "robot" | "hub" | "device"; name: string; status: string; connection: string; category: string;
  manufacturer: string | null; model: string | null; simulated: boolean; lastSeenAt: number | null; compatibility?: Level;
};
export type HardwareInventory = {
  items: InventoryItem[];
  counts: { total: number; online: number; robots: number; robotsOnline: number; hubs: number; hubsOnline: number; devices: number; devicesOnline: number };
};
export type HubEnrollment = { hub: Hub; enrollment: { code: string; expiresAt: number }; command: string };
export type Fact = { id: string; field: string; label: string; value: string | number; shown?: string; page: number; quote: string; confidence: "high" | "medium" | "low"; state: string; hazardous?: boolean; note?: string };
export type ManualAnalysis = {
  document: { name: string; kind: string; pages: number; pagesWithText: number; notes: string[]; source?: { id: string; name: string; mediaType: string; bytes: number } }; facts: Fact[];
  proposal: { profile: Record<string, unknown>; public: Profile; compatibility: Compatibility; notes: string[] } | null;
  missing: string[]; request: { manufacturer: string; model: string; protocolsFound: string[]; needs: string[] } | null; reminder: string;
};
export type AutomationInput = { name: string; when: { device: string; point: string; op: string; value: boolean | number | string; hysteresis?: number }; then: Array<{ device: string; point: string; value: boolean | number | string }>; otherwise?: Array<{ device: string; point: string; value: boolean | number | string }> };

export const DEVICES_EVENT = "hannah:devices";
const HINT = "hannah.devices.v1";
const json = (value: unknown) => JSON.stringify(value);
const id = (value: string) => encodeURIComponent(value);
const LONG = () => AbortSignal.timeout(45_000);
let known: Array<{ id: string; name: string; type: string }> = [];
try { known = JSON.parse(globalThis.localStorage?.getItem(HINT) || "[]"); } catch { known = []; }

function remember(devices: Device[]) {
  const next = devices.filter((device) => device.status === "active").map((device) => ({ id: device.id, name: device.name, type: device.profile.categoryLabel }));
  const changed = json(next) !== json(known);
  known = next;
  try { globalThis.localStorage?.setItem(HINT, json(known)); } catch { /* storage is a convenience */ }
  if (changed && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DEVICES_EVENT));
}

/** Best-effort: record a device lifecycle event in the user's memory. Never fails the device operation. */
function rememberDevice(kind: "added" | "activated" | "changed" | "removed", device: Device, detail?: string) {
  try {
    const verb = kind === "added" ? "Added device" : kind === "activated" ? "Switched on device" : kind === "removed" ? "Removed device" : "Changed device";
    const text = `${verb}: ${device.name} (${device.profile.manufacturer} ${device.profile.model}) through ${device.hub.name}${detail ? ". " + detail : ""}`;
    MemoryService.remember(text, { source: { kind: "you" }, layer: "long_term", category: "project", sensitivity: "normal" });
  } catch {
    // Memory is best-effort: a device change must never fail because remembering it did.
  }
}

export const Devices = {
  available: () => isAccountSession(),
  /** Devices switched on when the list was last read: decides whether device tools and the IoT agent are offered. */
  known: () => known,
  async overview() {
    const answer = await accountRequest<Overview>("/api/devices/overview");
    remember(answer.devices);
    return answer;
  },
  inventory: () => accountRequest<HardwareInventory>("/api/inventory"),
  refresh: async () => {
    if (!isAccountSession()) { remember([]); return; }
    await Devices.overview().catch(() => null);
  },
  get: (deviceId: string) => accountRequest<{ device: Device; events: DeviceEvent[]; changes: Change[] }>(`/api/devices/${id(deviceId)}`),
  profiles: (hub?: string) => accountRequest<{ profiles: Profile[] }>(`/api/devices/profiles${hub ? `?hub=${id(hub)}` : ""}`),
  saveProfile: (profile: Record<string, unknown>) => accountRequest<{ profile: Profile }>("/api/devices/profiles", { method: "POST", body: json({ profile }) }),
  deleteProfile: (profileId: string) => accountRequest<{ removed: boolean }>(`/api/devices/profiles/${id(profileId)}`, { method: "DELETE" }),
  listPublishers: () => accountRequest<{ keys: Array<{ keyId: string; owner: string; publicKey: string; revokedAt: number | null; createdAt: number }> }>("/api/devices/publishers"),
  addPublisher: (keyId: string, owner: string, publicKey: string) => accountRequest<{ keyId: string; owner: string }>("/api/devices/publishers", { method: "POST", body: json({ keyId, owner, publicKey }) }),
  revokePublisher: (keyId: string) => accountRequest<{ revoked: boolean }>(`/api/devices/publishers/${id(keyId)}`, { method: "DELETE" }),
  installProfile: (profile: Record<string, unknown>) => accountRequest<{ profile: Profile; signedBy: string; review: unknown }>("/api/devices/profiles/install", { method: "POST", body: json({ profile }) }),
  protocols: () => accountRequest<{ available: Array<{ id: string; label: string }>; notBuilt: Array<{ id: string; reason: string }> }>("/api/devices/protocols"),
  events: () => accountRequest<{ events: DeviceEvent[] }>("/api/devices/events?limit=40"),
  history: (deviceId: string, point: string, minutes = 180) => accountRequest<{ samples: Array<{ at: number; value: number | boolean }> }>(`/api/devices/${id(deviceId)}/history?point=${id(point)}&minutes=${minutes}`),
  add: async (input: { hub?: string; profileId: string; name: string; location?: string; settings: Record<string, unknown> }) => {
    const answer = await accountRequest<{ device: Device }>("/api/devices", { method: "POST", body: json(input) });
    rememberDevice("added", answer.device);
    return answer;
  },
  update: async (deviceId: string, change: { name?: string; location?: string; settings?: Record<string, unknown>; writable?: string[]; alwaysAsk?: string[]; disabled?: boolean }) => {
    const answer = await accountRequest<{ device: Device }>(`/api/devices/${id(deviceId)}`, { method: "PATCH", body: json(change) });
    rememberDevice("changed", answer.device);
    return answer;
  },
  remove: async (deviceId: string) => {
    const device = (await Devices.get(deviceId).catch(() => null))?.device ?? null;
    const answer = await accountRequest<{ removed: boolean }>(`/api/devices/${id(deviceId)}`, { method: "DELETE" });
    await Devices.refresh();
    if (device) rememberDevice("removed", device);
    return answer;
  },
  test: (deviceId: string) => accountRequest<{ device: Device; pending: boolean }>(`/api/devices/${id(deviceId)}/test`, { method: "POST", signal: LONG() }),
  activate: async (deviceId: string, writable: string[], acceptPartial = false) => {
    const answer = await accountRequest<{ device: Device }>(`/api/devices/${id(deviceId)}/activate`, { method: "POST", body: json({ writable, acceptPartial }) });
    await Devices.refresh();
    const detail = answer.device.verification?.level === "partial" ? "Some readings were not heard; switched on anyway." : acceptPartial ? "Accepted partial verification." : undefined;
    rememberDevice("activated", answer.device, detail);
    return answer;
  },
  /** Ask for a change. The answer is the action's record: usually waiting for approval. */
  set: (deviceId: string, point: string, value: boolean | number | string) => accountRequest<{ record: ActionRecord }>(`/api/devices/${id(deviceId)}/set`, { method: "POST", body: json({ point, value }), signal: LONG() }),
  createAutomation: (input: AutomationInput) => accountRequest<{ record: ActionRecord }>("/api/devices/automations", { method: "POST", body: json(input), signal: LONG() }),
  setAutomation: (ruleId: string, enabled: boolean) => accountRequest<{ record: ActionRecord }>(`/api/devices/automations/${id(ruleId)}`, { method: "PATCH", body: json({ enabled }), signal: LONG() }),
  removeAutomation: (ruleId: string) => accountRequest<{ record: ActionRecord }>(`/api/devices/automations/${id(ruleId)}`, { method: "DELETE", signal: LONG() }),
  pauseAutomations: (pause: boolean) => accountRequest<{ paused: boolean }>(`/api/devices/automations/${pause ? "pause" : "resume"}`, { method: "POST" }),
  createHub: (name: string) => accountRequest<HubEnrollment>("/api/hubs", { method: "POST", body: json({ name }) }),
  newHubCode: (hubId: string) => accountRequest<HubEnrollment>(`/api/hubs/${id(hubId)}/enrollment`, { method: "POST" }),
  revokeHub: (hubId: string) => accountRequest<{ hub: Hub }>(`/api/hubs/${id(hubId)}/revoke`, { method: "POST" }),
  removeHub: async (hubId: string) => { const answer = await accountRequest<{ removed: boolean }>(`/api/hubs/${id(hubId)}`, { method: "DELETE" }); await Devices.refresh(); return answer; },
  look: (hubId: string, kind: "mqtt" | "serial" | "mdns" | "usb", settings: Record<string, unknown> = {}) => accountRequest<{ pending: boolean; discovered: Hub["discovered"] }>(`/api/hubs/${id(hubId)}/discover`, { method: "POST", body: json({ kind, settings }), signal: LONG() }),
  updateHub: (hubId: string, version: string, size: number, sha256: string, url: string) => accountRequest<{ commandId: string; command: unknown }>(`/api/hubs/${id(hubId)}/update`, { method: "POST", body: json({ version, size, sha256, url }), signal: LONG() }),
  updates: () => accountRequest<{ hubs: Array<{ id: string; name: string; software: string | null; updateStatus: Hub["updateStatus"] }> }>("/api/hubs/updates"),
  rollouts: () => accountRequest<{ rollouts: UpdateRollout[] }>("/api/hubs/rollouts"),
  createRollout: (version: string, size: number, sha256: string, url: string, cohortSize: number) => accountRequest<{ rollout: UpdateRollout; excluded: Array<{ hubId: string; hubName: string; reason: string }> }>("/api/hubs/rollouts", { method: "POST", body: json({ version, size, sha256, url, cohortSize }), signal: LONG() }),
  pauseRollout: (rolloutId: string) => accountRequest<{ rollout: UpdateRollout }>(`/api/hubs/rollouts/${id(rolloutId)}/pause`, { method: "POST", signal: LONG() }),
  resumeRollout: (rolloutId: string) => accountRequest<{ rollout: UpdateRollout }>(`/api/hubs/rollouts/${id(rolloutId)}/resume`, { method: "POST", signal: LONG() }),
  rollbackRollout: (rolloutId: string) => accountRequest<{ rollout: UpdateRollout }>(`/api/hubs/rollouts/${id(rolloutId)}/rollback`, { method: "POST", signal: LONG() }),
  readManual: (name: string, data: string) => accountRequest<ManualAnalysis>("/api/devices/manuals", { method: "POST", body: json({ name, data }), signal: LONG() }),
  keepManualProfile: (name: string, data: string, confirmed: string[], profile?: Record<string, unknown>) => accountRequest<{ profile: Profile }>("/api/devices/manuals/save", { method: "POST", body: json({ name, data, confirmed, ...(profile ? { profile } : {}) }), signal: LONG() }),
};

// ---------- tools for the model ----------

const str = (value: unknown) => (typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value));
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
const AGENT = { agent: "IoT agent" };
const deviceProp = { type: "string", description: "The device's name or id, exactly as hardware_list gives it." };
const CHANGES = " The user sees the device, whether it is SIMULATED or REAL, the value now and the new value, and approves it unless one of their standing permissions covers it. The Device Safety Gateway refuses a change the device can't take (out of range, read-only, not allowed by the user, hub away) and says why: report that reason word for word and do not try another value or another device on your own. “done” means the device itself reported the new value. If the result says it was not confirmed, tell the user exactly that; never say it worked.";
const run = async (action: string, params: Record<string, unknown>) => toolResult(await Operator.perform(action, compact(params), AGENT));
/** A model may send { all: [...] } or one condition; either is passed as it is and checked by the server. */
const object = (value: unknown) => (value && typeof value === "object" ? value : undefined);

const tools: HANNAHTool[] = [
  {
    name: "hardware_list", description: "The user's connected devices (lights, plugs, fans, sensors, meters): what each is, whether it is reporting, which points can be read and which the user has allowed to be changed. Call this first for any request about a device; use the exact names it returns.",
    inputSchema: { type: "object", properties: {} }, execute: async () => run("hardware.list", {}),
  },
  {
    name: "hardware_read", description: "The latest values from one device (for example a temperature). Every value comes with its age in seconds and whether it is live; if it is not live, say it is the last known value and how old it is. Never present an old value as current.",
    inputSchema: { type: "object", properties: { device: deviceProp, point: { type: "string", description: "Optional: one point, such as temperature." } }, required: ["device"] },
    execute: async (args) => run("hardware.read", { device: str(args.device), point: str(args.point) }),
  },
  {
    name: "hardware_history", description: "How one reading changed over the last minutes or hours (up to 24 hours): lowest, highest, latest and the samples. Use it for “has it been warm today”.",
    inputSchema: { type: "object", properties: { device: deviceProp, point: { type: "string" }, minutes: { type: "number", description: "How far back (default 180)." } }, required: ["device", "point"] },
    execute: async (args) => run("hardware.history", { device: str(args.device), point: str(args.point), minutes: typeof args.minutes === "number" ? args.minutes : undefined }),
  },
  {
    name: "hardware_switch", description: `Switch a device on or off (a light, a plug, a fan, a relay).${CHANGES}`, asksUser: true,
    inputSchema: { type: "object", properties: { device: deviceProp, on: { type: "boolean", description: "true for on, false for off." }, point: { type: "string", description: "Only when the device has more than one switch." } }, required: ["device", "on"] },
    execute: async (args) => run("hardware.switch", { device: str(args.device), on: args.on === true || args.on === "true" || args.on === "on", point: str(args.point) }),
  },
  {
    name: "hardware_set", description: `Set a level or setpoint on a device (brightness, a limit) to a number inside the range hardware_list shows for that point.${CHANGES}`, asksUser: true,
    inputSchema: { type: "object", properties: { device: deviceProp, point: { type: "string", description: "The point, such as brightness." }, value: { type: "number", description: "The new value." } }, required: ["device", "point", "value"] },
    execute: async (args) => run("hardware.set_value", { device: str(args.device), point: str(args.point), value: typeof args.value === "number" || typeof args.value === "boolean" ? args.value : str(args.value) }),
  },
  { name: "hardware_automations", description: "The automations the user's hub runs by itself: what each watches and changes, whether it is on, how often it has acted and any problem it reported.", inputSchema: { type: "object", properties: {} }, execute: async () => run("hardware.automations", {}) },
  {
    name: "hardware_create_automation", asksUser: true,
    description: "Create an automation that the user's hub runs by itself, with no AI involved afterwards: when a reading crosses a value, change something, and optionally change it back when it stops being true. Example: when the Room sensor's temperature is above 28, switch the Fan on; otherwise switch it off. Use exact device names and point ids from hardware_list. It can only change points the user allowed, and never a high-risk one (a lock, a controller). The user approves exactly what it will do. If the server refuses it, report the reason word for word.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "A short name." },
      when: { type: "object", description: "{ device, point, op, value, hysteresis? }. op is one of > >= < <= == !=. hysteresis is a margin that stops it switching back and forth." },
      then: { type: "array", description: "[{ device, point, value }] to change when the condition becomes true.", items: { type: "object" } },
      otherwise: { type: "array", description: "Optional: [{ device, point, value }] to change when it stops being true.", items: { type: "object" } },
    }, required: ["name", "when", "then"] },
    execute: async (args) => run("hardware.create_automation", { name: str(args.name), when: object(args.when), then: Array.isArray(args.then) ? args.then : undefined, otherwise: Array.isArray(args.otherwise) ? args.otherwise : undefined }),
  },
  { name: "hardware_enable_automation", asksUser: true, description: "Switch an automation back on.", inputSchema: { type: "object", properties: { automation: { type: "string", description: "Its name or id from hardware_automations." } }, required: ["automation"] }, execute: async (args) => run("hardware.enable_automation", { automation: str(args.automation) }) },
  { name: "hardware_disable_automation", asksUser: true, description: "Switch an automation off. Devices stay as they are.", inputSchema: { type: "object", properties: { automation: { type: "string", description: "Its name or id from hardware_automations." } }, required: ["automation"] }, execute: async (args) => run("hardware.disable_automation", { automation: str(args.automation) }) },
  { name: "hardware_delete_automation", asksUser: true, description: "Remove an automation for good.", inputSchema: { type: "object", properties: { automation: { type: "string", description: "Its name or id from hardware_automations." } }, required: ["automation"] }, execute: async (args) => run("hardware.delete_automation", { automation: str(args.automation) }) },
];

/** Device tools exist only for an account that has a device switched on: nobody else's prompts carry them. */
export function getHardwareTools(): HANNAHTool[] {
  return Devices.known().length ? tools : [];
}
export const HARDWARE_TOOL_NAMES = tools.map((tool) => tool.name);
