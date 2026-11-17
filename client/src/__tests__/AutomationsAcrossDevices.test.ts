/**
 * Automations across devices, end to end: two simulated devices (their own
 * storage and module state) signed in to one account on the real HANNAH
 * server with an in-memory database. The AI is faked; account sync, run
 * records, leases, claims and cancels are real.
 */
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationDeps } from "../services/AutomationService";
import type { WorkflowSchema } from "../services/WorkflowSchema";

const net = vi.hoisted(() => ({ baseUrl: "", cookie: "", offline: false }));

vi.mock("../services/api", () => ({
  getAccountHint: () => ({ email: "auto@example.com", displayName: "" }),
  setAccountHint: () => undefined,
  usesBearerSession: () => false,
  isAccountSession: () => true,
  getSessionGroqKey: () => "",
  apiUrl: (path: string) => path,
  apiFetch: async (url: string, init: RequestInit = {}) => {
    if (net.offline) throw new TypeError("Failed to fetch");
    return fetch(`${net.baseUrl}${url}`, { method: init.method, body: init.body, headers: { ...(init.headers as Record<string, string>), Cookie: net.cookie } });
  },
}));

const require = createRequire(import.meta.url);
let server: { close: () => void; address: () => { port: number } } | undefined;

function memoryStorage(device: { id: string; name: string }) {
  const store = new Map<string, string>([["hannah.device.v1", JSON.stringify(device)]]);
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

type Modules = {
  AutomationService: typeof import("../services/AutomationService")["AutomationService"];
  TaskSpineService: typeof import("../services/TaskSpineService")["TaskSpineService"];
  TaskRecords: typeof import("../services/TaskRecords")["TaskRecords"];
  syncNow: typeof import("../services/AccountSync")["syncNow"];
};
type Device = { name: string; storage: ReturnType<typeof memoryStorage>; modules: Modules };

/** A fresh app instance: its own storage and module state, as on a separate device. */
async function boot(device: { id: string; name: string }): Promise<Device> {
  const storage = memoryStorage(device);
  use({ storage } as Device);
  vi.resetModules();
  const [automation, spine, records, sync] = await Promise.all([import("../services/AutomationService"), import("../services/TaskSpineService"), import("../services/TaskRecords"), import("../services/AccountSync")]);
  return { name: device.name, storage, modules: { AutomationService: automation.AutomationService, TaskSpineService: spine.TaskSpineService, TaskRecords: records.TaskRecords, syncNow: sync.syncNow } };
}

function use(device: Device) {
  vi.stubGlobal("window", { localStorage: device.storage, dispatchEvent: () => true });
  vi.stubGlobal("document", { visibilityState: "visible" });
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${net.baseUrl}/api${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: net.cookie } });
  return { status: response.status, body: await response.json() };
}

/** Simulates the running device disappearing: its lease runs out. */
async function expireLease(id: string) {
  const db = await require("../../../server/db").getDatabase();
  await db.query("UPDATE hannah_task_runs SET lease_expires_at = 0 WHERE id = $1", [id]);
}

const laptopDevice = { id: "laptop-device-0001", name: "MacBook" };
const phoneDevice = { id: "phone-device-00001", name: "Pixel" };
const at = (iso: string) => new Date(iso).getTime();

const node = (id: string, kind: WorkflowSchema["nodes"][number]["kind"], label: string, config: Record<string, unknown> = {}) => ({ id, kind, label, config, position: { x: 0, y: 0 } });
function workflow(id: string, withAction: boolean): WorkflowSchema {
  const nodes = [node("t", "trigger", "Weekdays at 08:00", { schedule: { type: "daily", time: "08:00", days: [1, 2, 3, 4, 5] } }), node("a", "agent-task", "Plan my day", { task: "Plan my day" }), ...(withAction ? [node("m", "tool-action", "Save the result to memory", { action: "save-memory" })] : []), node("o", "output", "Log", { channel: "log" })];
  const chain = nodes.map((item) => item.id);
  return { version: 1, id, name: "Morning plan", nodes, edges: chain.slice(1).map((target, index) => ({ id: `e${index}`, source: chain[index], target })), createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
}

function deps(device: Device, overrides: Partial<AutomationDeps> = {}) {
  let clock = at("2026-11-16T08:00:30");
  const calls = { ask: [] as string[], memory: [] as string[] };
  const value: AutomationDeps = {
    ask: async (prompt) => { calls.ask.push(`${device.name}: ${prompt.split("\n")[0]}`); return `plan from ${device.name}`; },
    notify: () => undefined,
    speak: async () => undefined,
    saveMemory: (text) => { calls.memory.push(`${device.name}: ${text}`); },
    createReminder: () => undefined,
    now: () => clock,
    ...overrides,
  };
  return { deps: value, calls, setNow: (iso: string) => { clock = at(iso); } };
}

beforeAll(async () => {
  process.env.HANNAH_API_TOKEN = "automations-devices-test-token-0123456789-abc";
  process.env.DATABASE_URL = "sqlite::memory:";
  process.env.HANNAH_VAULT_KEY = "e".repeat(64);
  const app = require("../../../server/index.js");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => (server as unknown as { once: (event: string, fn: () => void) => void }).once("listening", () => resolve(undefined)));
  net.baseUrl = `http://127.0.0.1:${server!.address().port}`;
});

afterAll(async () => {
  server?.close();
  await require("../../../server/db").resetDatabase();
});

let accounts = 0;
beforeEach(async () => {
  accounts += 1;
  const response = await fetch(`${net.baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `auto${accounts}@example.com`, password: "correct horse battery" }) });
  expect(response.status).toBe(200);
  net.cookie = response.headers.get("set-cookie")!.split(";")[0];
  net.offline = false;
  vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36).slice(2) });
});

describe("automations across devices", () => {
  it("an automation saved on the laptop reaches the phone, and a due slot runs on only one of them", async () => {
    const laptop = await boot(laptopDevice);
    const flow = workflow("workflow-shared-1", false);
    laptop.modules.TaskSpineService.createWorkflow(flow);
    laptop.modules.TaskSpineService.create("Memory consolidation", "a plain task that stays on this device");
    laptop.modules.AutomationService.setEnabled(flow, true, at("2026-11-13T12:00:00"));
    expect((await laptop.modules.syncNow()).ok).toBe(true);

    const phone = await boot(phoneDevice);
    expect(phone.modules.AutomationService.workflows()).toEqual([]);
    expect((await phone.modules.syncNow()).ok).toBe(true);
    expect(phone.modules.AutomationService.workflows().map((item) => item.id)).toEqual(["workflow-shared-1"]);
    expect(phone.modules.TaskSpineService.list().filter((task) => task.kind !== "workflow")).toEqual([]);
    const slot = phone.modules.AutomationService.state("workflow-shared-1").nextRunAt;
    expect(slot).toBe(at("2026-11-16T08:00:00"));

    // Both devices are open when the slot comes. Whoever creates the run first does it; the other skips.
    const onPhone = deps(phone);
    const phoneRuns = await phone.modules.AutomationService.runDue(onPhone.deps);
    expect(phoneRuns.map((run) => run.status)).toEqual(["done"]);
    expect(onPhone.calls.ask).toEqual(["Pixel: Plan my day"]);
    await phone.modules.TaskRecords.settled(phoneRuns[0].id);

    use(laptop);
    const onLaptop = deps(laptop);
    expect(laptop.modules.AutomationService.state("workflow-shared-1").nextRunAt).toBe(slot);
    const laptopRuns = await laptop.modules.AutomationService.runDue(onLaptop.deps);
    expect(laptopRuns).toEqual([]);
    expect(onLaptop.calls.ask).toEqual([]);
    // The laptop moved on to the next slot all the same.
    expect(laptop.modules.AutomationService.state("workflow-shared-1").nextRunAt).toBe(at("2026-11-17T08:00:00"));

    // The phone's run shows up in the laptop's history, from the account.
    await laptop.modules.AutomationService.syncFromAccount();
    const [seen] = laptop.modules.AutomationService.runs();
    expect(seen).toMatchObject({ id: `auto-${slot}-workflow-shared-1`, status: "done", trigger: "schedule", lastDevice: "Pixel", durable: true });
    expect(seen.steps.find((step) => step.kind === "agent-task")?.output).toBe("plan from Pixel");
  });

  it("a run waiting for approval on a laptop that went quiet is approved and finished on the phone", async () => {
    const laptop = await boot(laptopDevice);
    const flow = workflow("workflow-shared-2", true);
    laptop.modules.TaskSpineService.createWorkflow(flow);
    await laptop.modules.syncNow();
    const onLaptop = deps(laptop);
    const paused = await laptop.modules.AutomationService.run(flow, "manual", onLaptop.deps);
    expect(paused.status).toBe("waiting-approval");
    await laptop.modules.TaskRecords.settled(paused.id);
    const saved = (await api(`/account/runs/${paused.id}`)).body.run;
    expect(saved).toMatchObject({ status: "waiting-approval", kind: "automation" });
    expect(saved.lease.deviceName).toBe("MacBook");

    const phone = await boot(phoneDevice);
    await phone.modules.syncNow();
    await phone.modules.AutomationService.syncFromAccount();
    const [onPhoneBefore] = phone.modules.AutomationService.runs();
    expect(onPhoneBefore).toMatchObject({ id: paused.id, status: "waiting-approval", runningOn: "MacBook" });

    // While the laptop holds the run, the phone can't take it over.
    const onPhone = deps(phone);
    await expect(phone.modules.AutomationService.decide(paused.id, true, onPhone.deps)).rejects.toThrow(/running on MacBook/);

    // The laptop goes to sleep. The phone takes the run over, approves, and finishes it.
    await expireLease(paused.id);
    await phone.modules.AutomationService.syncFromAccount();
    expect(phone.modules.AutomationService.runs()[0].runningOn).toBeUndefined();
    const finished = await phone.modules.AutomationService.decide(paused.id, true, onPhone.deps);
    expect(finished.status).toBe("done");
    expect(onPhone.calls.memory).toEqual(["Pixel: plan from MacBook"]);
    expect(onPhone.calls.ask).toEqual([]);
    await phone.modules.TaskRecords.settled(paused.id);
    expect((await api(`/account/runs/${paused.id}`)).body.run).toMatchObject({ status: "completed", lastDevice: "Pixel" });

    // The laptop wakes up: its copy is updated from the account, and its own late save is refused.
    use(laptop);
    await laptop.modules.AutomationService.syncFromAccount();
    expect(laptop.modules.AutomationService.runs()[0]).toMatchObject({ status: "done", lastDevice: "Pixel" });
  });

  it("a run cut off on the laptop can be continued on the phone without redoing finished steps", async () => {
    const laptop = await boot(laptopDevice);
    const flow = workflow("workflow-shared-3", false);
    laptop.modules.TaskSpineService.createWorkflow(flow);
    await laptop.modules.syncNow();
    let runId = "";
    const onLaptop = deps(laptop, { ask: () => new Promise<string>(() => undefined) });
    void laptop.modules.AutomationService.run(flow, "manual", onLaptop.deps);
    await vi.waitFor(() => { [{ id: runId }] = laptop.modules.AutomationService.runs(); expect(runId).toBeTruthy(); });
    await laptop.modules.TaskRecords.settled(runId);
    expect((await api(`/account/runs/${runId}`)).body.run.record.run.steps.map((step: { status: string }) => step.status)).toEqual(["done", "running", "pending"]);
    await expireLease(runId);

    const phone = await boot(phoneDevice);
    await phone.modules.syncNow();
    await phone.modules.AutomationService.syncFromAccount();
    expect(phone.modules.AutomationService.runs()[0]).toMatchObject({ id: runId, status: "running", lastDevice: "MacBook" });
    expect(phone.modules.AutomationService.runs()[0].runningOn).toBeUndefined();
    const onPhone = deps(phone);
    const finished = await phone.modules.AutomationService.continueRun(runId, onPhone.deps);
    expect(finished.status).toBe("done");
    expect(finished.steps.map((step) => step.status)).toEqual(["done", "done", "done"]);
    expect(onPhone.calls.ask).toEqual(["Pixel: Plan my day"]);
  });

  it("cancelling from the phone stops the laptop before its next step", async () => {
    const laptop = await boot(laptopDevice);
    const flow = workflow("workflow-shared-4", true);
    laptop.modules.TaskSpineService.createWorkflow(flow);
    const phone = await boot(phoneDevice);
    use(laptop);
    const onLaptop = deps(laptop, {
      ask: async () => {
        const [{ id }] = laptop.modules.AutomationService.runs();
        await laptop.modules.TaskRecords.settled(id);
        use(phone);
        await phone.modules.AutomationService.syncFromAccount();
        expect(phone.modules.AutomationService.runs()[0].runningOn).toBe("MacBook");
        await phone.modules.AutomationService.cancelElsewhere(id);
        expect(phone.modules.AutomationService.runs()[0].status).toBe("cancelled");
        use(laptop);
        return "plan";
      },
    });
    const run = await laptop.modules.AutomationService.run(flow, "manual", onLaptop.deps);
    expect(run.status).toBe("cancelled");
    expect(run.error).toMatch(/cancelled from Pixel/i);
    expect(run.steps.map((step) => step.status)).toEqual(["done", "done", "skipped", "skipped"]);
    expect(laptop.modules.AutomationService.isLive(run.id)).toBe(false);
  });

  it("signed in but offline, a manual run happens on this device only", async () => {
    const laptop = await boot(laptopDevice);
    const flow = workflow("workflow-shared-5", false);
    laptop.modules.TaskSpineService.createWorkflow(flow);
    net.offline = true;
    const onLaptop = deps(laptop);
    const run = await laptop.modules.AutomationService.run(flow, "manual", onLaptop.deps);
    expect(run.status).toBe("done");
    expect(run.durable).toBeUndefined();
    net.offline = false;
    expect((await api("/account/runs")).body.runs).toEqual([]);
  });
});
