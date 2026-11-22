import { beforeEach, describe, expect, it, vi } from "vitest";

// The Devices client and its agent tools against a scripted server: which
// tools an agent gets, what each asks of the Action Engine, what a model is
// told afterwards, and what the Hardware Studio produces. No hub, device or
// server runs here.
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } });
vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: globalThis.localStorage, confirm: vi.fn(() => true) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" }, registerPlugin: () => ({}) }));
vi.mock("@capacitor/dialog", () => ({ Dialog: { confirm: vi.fn() } }));
vi.mock("../services/DesktopBridge", () => ({ getDesktopBridge: () => null }));
vi.mock("../services/DeviceTasks", () => ({ DeviceTasks: { requestApproval: async () => null } }));
let signedIn = true;
vi.mock("../services/api", async (original) => ({ ...(await original<typeof import("../services/api")>()), isAccountSession: () => signedIn, usesBearerSession: () => false }));

type Call = { path: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];
let respond: (call: Call) => unknown = () => ({});
vi.mock("../services/Account", () => ({
  AccountError: class AccountError extends Error {},
  accountRequest: async (path: string, init: RequestInit = {}) => {
    const call = { path, method: init.method || "GET", body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result;
  },
}));

const { Devices, getHardwareTools, HARDWARE_TOOL_NAMES } = await import("../services/Devices");
const { ApprovalCenter } = await import("../services/ApprovalCenter");
const { SPECIALISTS, activeSpecialists } = await import("../services/SpecialistAgents");
const { selectToolsForRequest } = await import("../services/AgentRouter");
const { getDeviceTools } = await import("../services/DeviceTools");
const { HITLDeniedError } = await import("../services/SafetyGuard");
const { screenForLocation, pathForScreen } = await import("../routes");
const { studioProfile } = await import("../components/DeviceSetup");
const { automationText } = await import("../components/DevicesPage");

const device = (extra: Record<string, unknown> = {}) => ({ id: "dev_1", name: "Fan", status: "active", profile: { categoryLabel: "Switch or plug" }, ...extra });
const overview = (devices: unknown[]) => ({ hubs: [], devices, rules: [], counts: {}, rulesSuspended: false, canEnroll: true });
const record = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "act-1", action: "hardware.switch", service: "hardware", kind: "write", status, executor: "server", request: "", intent: "", agent: "IoT agent", source: "chat", taskId: null, resource: { type: "device", id: "dev_1" }, account: "Fan",
  preview: { title: "Set Power on Fan to on", lines: [{ label: "Device", value: "Fan — SIMULATED DEVICE (HANNAH (simulated) SIM-FAN)" }], warnings: [] },
  permission: { outcome: "ask", reason: "Devices and smart hardware is set to Approval before action." }, approval: null, response: null, verification: null, error: null, outcome: "", final: status !== "waiting-approval", createdAt: 1, updatedAt: 1, executedAt: null, expiresAt: null, ...extra,
});
const tool = (name: string) => getHardwareTools().find((item) => item.name === name)!;
/** Stand in for the screen that shows approval cards: answer every request the same way, and count them. */
function host(answer: boolean) {
  const seen: string[] = [];
  const detach = ApprovalCenter.attachHost((requests) => { for (const request of requests) { seen.push(request.message); queueMicrotask(() => ApprovalCenter.respond(request.id, answer)); } });
  return { seen, detach };
}
const have = async (devices: unknown[]) => { respond = () => overview(devices); await Devices.overview(); calls.length = 0; };

beforeEach(async () => { signedIn = true; calls.length = 0; storage.clear(); respond = () => overview([]); await Devices.overview(); calls.length = 0; });

describe("device tools are offered only to an account with a device switched on", () => {
  it("offers none without one, and all of them with one", async () => {
    expect(getHardwareTools()).toEqual([]);
    expect(getDeviceTools().some((item) => item.name.startsWith("hardware_"))).toBe(false);
    await have([device({ status: "verified" })]);
    expect(getHardwareTools()).toEqual([]);
    await have([device()]);
    expect(getHardwareTools().map((item) => item.name)).toEqual(HARDWARE_TOOL_NAMES);
    expect(getDeviceTools().filter((item) => item.name.startsWith("hardware_")).length).toBe(HARDWARE_TOOL_NAMES.length);
    signedIn = false;
    await Devices.refresh();
    expect(getHardwareTools()).toEqual([]);
  });

  it("the Devices agent appears with a device, lists only tools that exist, and carries the rules that matter", async () => {
    const agent = SPECIALISTS.find((item) => item.id === "devices")!;
    expect(activeSpecialists().some((item) => item.id === "devices")).toBe(false);
    await have([device()]);
    expect(activeSpecialists().some((item) => item.id === "devices")).toBe(true);
    expect(agent.tools.filter((name) => !HARDWARE_TOOL_NAMES.includes(name))).toEqual([]);
    expect(agent.instructions).toMatch(/repeat its reason and stop/);
    expect(agent.instructions).toMatch(/never say it worked/);
    expect(agent.instructions).toMatch(/not a safety system/);
  });

});

describe("what each tool asks for, and what the model is told", () => {
  beforeEach(async () => { await have([device()]); });

  it("a schema names devices and points only", () => {
    for (const item of getHardwareTools()) {
      const properties = Object.keys(item.inputSchema.properties || {});
      expect(properties.filter((name) => /topic|register|address|url|path|host|port/i.test(name)), item.name).toEqual([]);
    }
    expect(tool("hardware_switch").asksUser).toBe(true);
    expect(tool("hardware_set").description).toMatch(/report that reason word for word/);
    expect(tool("hardware_read").description).toMatch(/Never present an old value as current/);
  });

  it("switching goes through the Action Engine, waits for the user, and reports what the device confirmed", async () => {
    const asked = host(true);
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval") } : call.path.endsWith("/decision") ? { record: record("done", { outcome: "Done and confirmed: Set Power on Fan to on.", response: { status: "done", readback: { confirmed: true, value: true } }, verification: { confirmed: true, evidence: "The device reported power = true after the write." } }) } : {});
    const result = await tool("hardware_switch").execute({ device: "Fan", on: true }) as Record<string, unknown>;
    expect(calls[0]).toMatchObject({ path: "/api/actions", method: "POST", body: { action: "hardware.switch", params: { device: "Fan", on: true }, agent: "IoT agent" } });
    asked.detach();
    expect(asked.seen.length).toBe(1);
    expect(asked.seen[0]).toMatch(/Set Power on Fan to on/);
    expect(calls[1].body).toEqual({ approve: true });
    expect(result).toMatchObject({ status: "done", confirmed: "The device reported power = true after the write." });
  });

  it("a declined change is a refusal the model can't talk around, and an unconfirmed one is never called done", async () => {
    const no = host(false);
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval") } : { record: record("declined", { outcome: "You declined: Set Power on Fan to on." }) });
    await expect(tool("hardware_switch").execute({ device: "Fan", on: true })).rejects.toBeInstanceOf(HITLDeniedError);
    no.detach();
    const yes = host(true);
    respond = (call) => (call.path === "/api/actions" ? { record: record("waiting-approval") } : { record: record("unverified", { outcome: "Sent, not confirmed.", response: { status: "unverified", note: "Power on Fan: sent, but the device still reports off. It is not confirmed." } }) });
    const result = await tool("hardware_switch").execute({ device: "Fan", on: true }) as Record<string, unknown>;
    yes.detach();
    expect(result.status).toBe("unverified");
    expect(result.note).toMatch(/Do not say it is done/);
  });

  it("a refusal by the gateway reaches the model as it was given", async () => {
    respond = () => ({ record: record("refused", { outcome: "Not allowed: Brightness accepts 0 to 100 %; 140 is outside that." }) });
    const result = await tool("hardware_set").execute({ device: "Lamp", point: "brightness", value: 140 }) as Record<string, unknown>;
    expect(calls[0].body).toMatchObject({ action: "hardware.set_value", params: { device: "Lamp", point: "brightness", value: 140 } });
    expect(result.outcome).toBe("Not allowed: Brightness accepts 0 to 100 %; 140 is outside that.");
    expect(result.note).toMatch(/did NOT happen/);
  });

  it("an automation is sent as the model gave it, for the server to check", async () => {
    respond = () => ({ record: record("waiting-approval", { action: "hardware.create_automation" }) });
    const no = host(false);
    const rule = { name: "Cool the room", when: { device: "Room sensor", point: "temperature", op: ">", value: 28 }, then: [{ device: "Fan", point: "power", value: true }] };
    await tool("hardware_create_automation").execute(rule).catch(() => null);
    no.detach();
    expect(calls[0].body).toMatchObject({ action: "hardware.create_automation", params: rule });
    expect(tool("hardware_create_automation").description).toMatch(/no AI involved afterwards/);
  });
});

describe("what a person says brings the right tools", () => {
  beforeEach(async () => { await have([device()]); });
  const pick = (request: string) => selectToolsForRequest(getDeviceTools(), request).map((item) => item.name).filter((name) => name.startsWith("hardware_"));

  it("questions and commands", () => {
    for (const said of ["Turn on the lights", "Switch the fan off please", "What's the temperature in the living room?", "Is the lamp on?", "Dim the lamp to 30", "How warm is it in here?", "Check the humidity sensor"]) {
      expect(pick(said), said).toEqual(expect.arrayContaining(["hardware_list", "hardware_read", "hardware_switch", "hardware_set"]));
    }
  });
  it("automations", () => {
    for (const said of ["When the temperature goes above 28 turn on the fan", "Create an automation that turns on the fan when it gets too hot", "Turn off the lamp whenever the room is bright", "Show my automations"]) {
      expect(pick(said), said).toEqual(expect.arrayContaining(["hardware_list", "hardware_create_automation", "hardware_automations"]));
    }
  });
  it("history", () => {
    expect(pick("How warm has it been today?")).toEqual(expect.arrayContaining(["hardware_history"]));
    expect(pick("Show the temperature over the last hour")).toEqual(expect.arrayContaining(["hardware_history"]));
  });
  it("nothing about devices brings none of them", () => {
    expect(pick("Write a poem about autumn")).toEqual([]);
    expect(pick("What's on my calendar tomorrow?")).toEqual([]);
  });
});

describe("the screen's own pieces", () => {
  it("has a route", () => {
    expect(pathForScreen("devices")).toBe("/devices");
    expect(screenForLocation({ pathname: "/devices", hash: "" })).toBe("devices");
    expect(screenForLocation({ pathname: "/iot", hash: "" })).toBe("devices");
  });

  it("an automation reads as a sentence", () => {
    const rule = { when: [{ device: "d1", deviceName: "Room sensor", point: "temperature", op: ">", value: 27 }], then: [{ device: "d2", deviceName: "Fan", point: "power", value: true }], otherwise: [{ device: "d2", deviceName: "Fan", point: "power", value: false }] };
    expect(automationText(rule)).toBe("When Room sensor temperature > 27: set Fan power to on. When that stops being true: set Fan power to off.");
  });

  it("the Hardware Studio turns a form into a profile, with a range only where one was entered", () => {
    const blank = { name: "", changes: false, type: "number" as const, unit: "", low: "", high: "", a: "", b: "", c: "", table: "holding", format: "uint16", scale: "" };
    const mqtt = studioProfile({ name: "", maker: "Acme", model: "TH-1", category: "sensor", protocol: "mqtt" }, [
      { ...blank, name: "Temperature", unit: "°C", low: "-20", high: "60", a: "home/th1/state", b: "temperature" },
      { ...blank, name: "Relay", type: "boolean", changes: true, a: "home/th1/relay", c: "home/th1/relay/set" },
      { ...blank, name: "" },
    ]);
    expect(mqtt.id).toBe("user.studio.acme-th-1");
    expect(mqtt.points).toEqual([
      { id: "temperature", name: "Temperature", kind: "sensor", type: "number", access: "read", unit: "°C", range: [-20, 60], binding: { state: { topic: "home/th1/state", json: "temperature" } } },
      { id: "relay", name: "Relay", kind: "actuator", type: "boolean", access: "read-write", binding: { state: { topic: "home/th1/relay", on: "ON", off: "OFF" }, command: { topic: "home/th1/relay/set", on: "ON", off: "OFF" } } },
    ]);
    expect(mqtt.permissions).toEqual(["network-local"]);
    const modbus = studioProfile({ name: "Meter", maker: "Acme", model: "PM", category: "energy-meter", protocol: "modbus-tcp" }, [{ ...blank, name: "Limit", changes: true, unit: "W", a: "10", table: "holding", format: "uint16" }]);
    expect(modbus.domain).toBe("industrial");
    expect(modbus.points[0]).toMatchObject({ access: "read-write", binding: { register: { table: "holding", address: 10, type: "uint16" } } });
    expect("range" in modbus.points[0]).toBe(false); // the server refuses this: a writable number needs a range
    expect(modbus.constraints[0]).toMatch(/no sign-in or encryption/);
  });
});
