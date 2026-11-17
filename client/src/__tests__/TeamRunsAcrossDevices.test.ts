/**
 * Durable team runs across devices, end to end: two simulated devices (their
 * own storage and their own copy of the app's modules) signed in to one
 * account on the real HANNAH server router, with an in-memory database.
 * Models are faked; checkpoints, leases, claims and cancels are real.
 */
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  baseUrl: "",
  cookie: "",
  offline: false,
  plan: [] as unknown[],
  verify: [] as unknown[],
  agentCalls: [] as string[],
  onStep: async (_task: string, _onActivity?: (activity: { phase: string; message: string }) => void) => undefined as void,
}));

vi.mock("../services/api", () => ({
  getAccountHint: () => ({ email: "runs@example.com", displayName: "" }),
  setAccountHint: () => undefined,
  usesBearerSession: () => false,
  apiUrl: (path: string) => path,
  apiFetch: async (url: string, init: RequestInit = {}) => {
    if (url === "/api/orchestrate") {
      const body = JSON.parse(String(init.body));
      const payload = body.phase === "plan" ? { summary: "plan", steps: net.plan, fallback: false } : net.verify.shift();
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (net.offline) throw new TypeError("Failed to fetch");
    return fetch(`${net.baseUrl}${url}`, { method: init.method, body: init.body, headers: { ...(init.headers as Record<string, string>), Cookie: net.cookie } });
  },
}));
vi.mock("../services/LLMRouter", () => ({ DAILY_BUDGET_KEY: "hannah.budget.dailyUsd" }));
vi.mock("../services/AgentRuntime", () => ({
  runAgentTurn: async (options: { messages: Array<{ content: string }>; onActivity?: (activity: { phase: string; message: string }) => void }) => {
    const task = options.messages[0].content.match(/Your step: (.*)/)?.[1] ?? "";
    net.agentCalls.push(task);
    await net.onStep(task, options.onActivity);
    return { reply: `result of ${task}`, emotion: "neutral" };
  },
}));

const require = createRequire(import.meta.url);
let server: { close: () => void; address: () => { port: number } } | undefined;

function memoryStorage(device: { id: string; name: string }) {
  const store = new Map<string, string>([["hannah.device.v1", JSON.stringify(device)]]);
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
}

type Modules = { Orchestrator: typeof import("../services/Orchestrator"); TaskRecords: typeof import("../services/TaskRecords")["TaskRecords"] };
type Device = { storage: ReturnType<typeof memoryStorage>; modules: Modules };

/** A fresh app instance: its own storage and module state, as on a separate device. */
async function boot(device: { id: string; name: string }): Promise<Device> {
  const storage = memoryStorage(device);
  use({ storage } as Device);
  vi.resetModules();
  const [Orchestrator, records] = await Promise.all([import("../services/Orchestrator"), import("../services/TaskRecords")]);
  return { storage, modules: { Orchestrator, TaskRecords: records.TaskRecords } };
}

function use(device: Device) {
  vi.stubGlobal("window", { localStorage: device.storage, dispatchEvent: () => true });
}

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${net.baseUrl}/api${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: net.cookie } });
  return { status: response.status, body: await response.json() };
}

const phoneDevice = { id: "phone-device-00001", name: "Pixel" };
const laptopDevice = { id: "laptop-device-0001", name: "MacBook" };
const pass = (reply: string) => ({ verdict: "pass", issues: [], revise: [], reply, emotion: "happy" });
const base = { mode: "cloud" as const, providerId: "groq", generateLocal: async () => "" };

beforeAll(async () => {
  process.env.HANNAH_API_TOKEN = "team-runs-devices-test-token-0123456789-abcdef";
  process.env.DATABASE_URL = "sqlite::memory:";
  process.env.HANNAH_VAULT_KEY = "d".repeat(64);
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
  const response = await fetch(`${net.baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `devices${accounts}@example.com`, password: "correct horse battery" }) });
  expect(response.status).toBe(200);
  net.cookie = response.headers.get("set-cookie")!.split(";")[0];
  net.offline = false;
  net.agentCalls = [];
  net.verify = [];
  net.onStep = async () => undefined;
});

describe("team runs across devices", () => {
  it("a run stopped on the laptop resumes on the phone from its checkpoint, without redoing finished steps", async () => {
    net.plan = [
      { id: "s1", agent: "research", task: "First", dependsOn: [] },
      { id: "s2", agent: "research", task: "Second", dependsOn: ["s1"] },
    ];
    const laptop = await boot(laptopDevice);
    const controller = new AbortController();
    net.onStep = async (task) => { if (task === "First") controller.abort(); };
    const stopped = await laptop.modules.Orchestrator.runTeamTask({ ...base, signal: controller.signal, messages: [{ role: "user", content: "Two things" }] });
    expect(stopped.outcome).toBe("stopped");
    const [laptopRun] = laptop.modules.Orchestrator.TeamRuns.list();
    await laptop.modules.TaskRecords.settled(laptopRun.id);

    const saved = (await api(`/account/runs/${laptopRun.id}`)).body.run;
    expect(saved.status).toBe("paused");
    expect(saved.lease).toBeNull();
    expect(saved.record.steps.map((step: { status: string }) => step.status)).toEqual(["done", "stopped"]);

    // The phone has never seen this run: it comes from the account.
    const phone = await boot(phoneDevice);
    await phone.modules.Orchestrator.TeamRuns.syncFromAccount();
    const [onPhone] = phone.modules.Orchestrator.TeamRuns.list();
    expect(onPhone.id).toBe(laptopRun.id);
    expect(onPhone.steps[0].output).toBe("result of First");

    net.agentCalls = [];
    net.verify = [pass("Both done")];
    const resumed = await phone.modules.Orchestrator.resumeTeamRun(onPhone.id, { generateLocal: async () => "" });
    expect(resumed.reply).toBe("Both done");
    expect(net.agentCalls).toEqual(["Second"]);
    await phone.modules.TaskRecords.settled(onPhone.id);
    const finished = (await api(`/account/runs/${onPhone.id}`)).body.run;
    expect(finished.status).toBe("completed");
    expect(finished.lastDevice).toBe("Pixel");
    expect(finished.record.reply).toBe("Both done");

    // Back on the laptop, the run shows as done.
    use(laptop);
    await laptop.modules.Orchestrator.TeamRuns.syncFromAccount();
    expect(laptop.modules.Orchestrator.TeamRuns.get(laptopRun.id)?.status).toBe("succeeded");
  });

  it("while the laptop works, the phone can't take the run, and a cancel from the phone stops the laptop", async () => {
    net.plan = [
      { id: "s1", agent: "research", task: "First", dependsOn: [] },
      { id: "s2", agent: "research", task: "Second", dependsOn: ["s1"] },
    ];
    const laptop = await boot(laptopDevice);
    let runId = "";
    let refusal = "";
    net.onStep = async (task) => {
      if (task !== "First") return;
      [{ id: runId }] = laptop.modules.Orchestrator.TeamRuns.list();
      await laptop.modules.TaskRecords.settled(runId);
      const listed = (await api("/account/runs")).body.runs[0];
      expect(listed.lease.deviceName).toBe("MacBook");
      const claim = await api(`/account/runs/${runId}/claim`, { method: "POST", body: JSON.stringify({ deviceId: phoneDevice.id, deviceName: phoneDevice.name }) });
      expect(claim.status).toBe(409);
      refusal = claim.body.error;
      expect((await api(`/account/runs/${runId}/cancel`, { method: "POST", body: JSON.stringify({ deviceId: phoneDevice.id, deviceName: phoneDevice.name }) })).status).toBe(200);
    };
    const reply = await laptop.modules.Orchestrator.runTeamTask({ ...base, messages: [{ role: "user", content: "Long task" }] });
    expect(refusal).toMatch(/running on MacBook/);
    expect(reply.outcome).toBe("stopped");
    expect(reply.reply).toMatch(/cancelled from Pixel/);
    expect(net.agentCalls).toEqual(["First"]);
    const local = laptop.modules.Orchestrator.TeamRuns.get(runId)!;
    expect(local.status).toBe("cancelled");
    await expect(laptop.modules.Orchestrator.resumeTeamRun(runId, { generateLocal: async () => "" })).rejects.toThrow(/cancelled/);
    expect((await api(`/account/runs/${runId}`)).body.run.status).toBe("cancelled");
  });

  it("a step waiting for your approval shows as waiting-approval in your account, and the device keeps the run", async () => {
    net.plan = [{ id: "s1", agent: "tasks", task: "Send the summary", dependsOn: [] }];
    net.verify = [pass("Sent")];
    const laptop = await boot(laptopDevice);
    const seen: Array<{ status: string; step: string; lease: string | null }> = [];
    net.onStep = async (_task, onActivity) => {
      const [{ id }] = laptop.modules.Orchestrator.TeamRuns.list();
      const snapshot = async () => {
        await laptop.modules.TaskRecords.settled(id);
        const run = (await api(`/account/runs/${id}`)).body.run;
        seen.push({ status: run.status, step: run.record.steps[0].status, lease: run.lease?.deviceName ?? null });
      };
      onActivity?.({ phase: "waiting-approval", message: "Waiting for your approval: send email" });
      await snapshot();
      onActivity?.({ phase: "acting", message: "Using send email…" });
      await snapshot();
    };
    await laptop.modules.Orchestrator.runTeamTask({ ...base, messages: [{ role: "user", content: "Send it" }] });
    expect(seen).toEqual([
      { status: "waiting-approval", step: "waiting-approval", lease: "MacBook" },
      { status: "running", step: "running", lease: "MacBook" },
    ]);
  });

  it("checkpoints made offline go out when the device is back", async () => {
    net.plan = [{ id: "s1", agent: "research", task: "Only", dependsOn: [] }];
    net.verify = [pass("Done offline")];
    const laptop = await boot(laptopDevice);
    let runId = "";
    net.onStep = async () => {
      [{ id: runId }] = laptop.modules.Orchestrator.TeamRuns.list();
      await laptop.modules.TaskRecords.settled(runId);
      net.offline = true;
    };
    const reply = await laptop.modules.Orchestrator.runTeamTask({ ...base, messages: [{ role: "user", content: "One thing" }] });
    expect(reply.reply).toBe("Done offline");
    net.offline = false;
    expect((await api(`/account/runs/${runId}`)).body.run.status).toBe("running");

    await laptop.modules.Orchestrator.TeamRuns.syncFromAccount();
    const synced = (await api(`/account/runs/${runId}`)).body.run;
    expect(synced.status).toBe("completed");
    expect(synced.record.reply).toBe("Done offline");
    expect(laptop.modules.Orchestrator.TeamRuns.get(runId)?.status).toBe("succeeded");
  });
});
