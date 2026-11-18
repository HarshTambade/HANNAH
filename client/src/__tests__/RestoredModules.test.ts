import { beforeEach, describe, expect, it, vi } from "vitest";

// The modules that were placeholders, now working: each test checks the real behavior.
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web", isPluginAvailable: () => false }, registerPlugin: () => ({}) }));

const storage = () => { const store = new Map<string, string>(); return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, clear: () => store.clear() }; };
const stubWindow = () => vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: storage(), sessionStorage: storage(), location: { origin: "https://app.example", href: "https://app.example/" } }));
stubWindow();

const { SyncService, encryptForSync, decryptFromSync } = await import("../services/SyncService");
const { CRDTSyncProvider, compareClocks } = await import("../services/CRDTSyncProvider");
const { mergeAll, mergeMemories } = await import("../services/memorySync");
const { AgentOrchestrator } = await import("../services/AgentOrchestrator");
const { checkServer } = await import("../services/AgentNativeHomeService");
const { PAPAdapter } = await import("../services/PAPAdapter");
const { AgentInteropService } = await import("../services/AgentInteropService");
const { WebSocketHardwareAdapter, checkDeviceAddress } = await import("../services/HardwareAdapter");
const { ResearchAgent, FreelanceAgent, RouterAgent, defaultAgentProfiles } = await import("../services/AgentRouter");
const { ChaosEngine } = await import("../services/ChaosEngine");
const { MemoryService } = await import("../services/MemoryService");
const { selectMemoriesForPrompt } = await import("../services/MemoryStore");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(stubWindow);

describe("sync is end-to-end encrypted", () => {
  it("encrypts with AES-GCM under the passphrase; the relay never sees the text; a wrong passphrase fails", async () => {
    const envelope = await encryptForSync([{ note: "My dog Bruno" }], "correct horse battery", 1_000);
    expect(JSON.stringify(envelope)).not.toMatch(/Bruno/);
    expect(atob(envelope.ciphertext)).not.toMatch(/Bruno/);
    expect(await decryptFromSync(envelope, "correct horse battery")).toEqual([{ note: "My dog Bruno" }]);
    await expect(decryptFromSync(envelope, "wrong passphrase!")).rejects.toThrow(/wrong, or the data was changed/);
    await expect(encryptForSync([], "short")).rejects.toThrow(/at least 8/);
  });

  it("keeps the queue when the relay refuses, and clears only what the relay stored", async () => {
    SyncService.enqueue({ type: "memory" });
    const refused = await SyncService.sync("https://relay.example/sync", "correct horse battery", { fetchImpl: async () => new Response("", { status: 500 }), iterations: 1_000 });
    expect(refused).toMatchObject({ ok: false, pendingOps: 1, connected: false });
    const bodies: string[] = [];
    const stored = await SyncService.sync("https://relay.example/sync", "correct horse battery", { fetchImpl: async (_url, init) => { bodies.push(String(init?.body)); return new Response("{}", { status: 200 }); }, iterations: 1_000 });
    expect(stored).toMatchObject({ ok: true, pendingOps: 0, connected: true });
    expect(JSON.parse(bodies[0]).envelope.alg).toBe("AES-256-GCM");
    expect(bodies[0]).not.toMatch(/"memory"/);
  });
});

describe("CRDT sync converges", () => {
  const update = (device: string, clock: Record<string, number>, data: unknown, operation: "insert" | "update" | "delete" = "update", timestamp = 1) =>
    ({ id: `${device}-${JSON.stringify(clock)}-${operation}`, collection: "memory" as const, operation, data, timestamp, vectorClock: clock, deviceId: device });

  it("orders by vector clock, resolves concurrent writes the same way in any order, keeps deletes, ignores repeats", () => {
    expect(compareClocks({ a: 1 }, { a: 2 })).toBe(-1);
    expect(compareClocks({ a: 2, b: 0 }, { a: 1, b: 1 })).toBe(0);
    const first = update("a", { a: 1 }, { id: "m1", content: "Pune" });
    const later = update("a", { a: 2 }, { id: "m1", content: "Mumbai" });
    const concurrentB = update("b", { a: 1, b: 1 }, { id: "m1", content: "Delhi" }, "update", 5);
    const results: unknown[] = [];
    for (const order of [[first, later, concurrentB], [concurrentB, later, first], [later, first, concurrentB]]) {
      CRDTSyncProvider.reset("device-x");
      for (const item of order) CRDTSyncProvider.applyUpdate(item);
      results.push(CRDTSyncProvider.values("memory"));
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0]).toEqual([{ id: "m1", content: "Delhi" }]);
    // A delete that follows wins, and an older copy arriving later doesn't bring it back.
    CRDTSyncProvider.applyUpdate(update("b", { a: 2, b: 2 }, { id: "m1" }, "delete", 6));
    CRDTSyncProvider.applyUpdate(update("a", { a: 1 }, { id: "m1", content: "old copy" }, "insert", 0));
    expect(CRDTSyncProvider.values("memory")).toEqual([]);
    expect(CRDTSyncProvider.applyUpdate(concurrentB)).toBe(false);
  });

  it("sends encrypted updates, merges other devices' envelopes, and keeps its own queued if the relay fails", async () => {
    CRDTSyncProvider.reset("device-x");
    CRDTSyncProvider.createUpdate("memory", "insert", { id: "m2", content: "Gym at 7" });
    const remote = await encryptForSync([update("device-y", { "device-y": 1 }, { id: "m3", content: "Call Aman" }, "insert")], "correct horse battery", 1_000);
    const failing = await CRDTSyncProvider.sync("https://relay.example", "correct horse battery", { iterations: 1_000, fetchImpl: async (url) => (String(url).includes("/sync/") ? json({ envelopes: [remote] }) : new Response("", { status: 503 })) });
    expect(failing).toEqual({ synced: 0, merged: 1, pending: 1 });
    expect(CRDTSyncProvider.values("memory")).toEqual(expect.arrayContaining([{ id: "m2", content: "Gym at 7" }, { id: "m3", content: "Call Aman" }]));
    const ok = await CRDTSyncProvider.sync("https://relay.example", "correct horse battery", { iterations: 1_000, fetchImpl: async (url) => (String(url).includes("/sync/") ? json({ envelopes: [] }) : json({})) });
    expect(ok.pending).toBe(0);
  });
});

describe("memory sync keeps deletes", () => {
  it("a delete on one device isn't undone by another's older copy", () => {
    const deleted = { id: "a", content: "x", updatedAt: 20, deleted: true };
    const older = { id: "a", content: "x", updatedAt: 10 };
    expect(mergeAll([older], [deleted])).toEqual([deleted]);
    expect(mergeMemories([older], [deleted])).toEqual([]);
    expect(mergeAll([{ id: "b", content: "y", updatedAt: 5 }], [{ id: "b", content: "y", updatedAt: 5, deleted: true }])[0].deleted).toBe(true);
  });
});

describe("orchestration runs real agent turns", () => {
  it("each step's answer comes from the model, with what earlier steps found; reviewers' points reach the synthesis", async () => {
    const prompts: string[] = [];
    const ask = async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.startsWith("You are a skeptical reviewer")) return '{"points": ["The price is from 2023"]}';
      if (prompt.startsWith("You are a devil's advocate")) return '{"points": []}';
      if (prompt.startsWith("Write the final answer")) return "Final: compare prices; note the 2023 figure may be outdated.";
      return `answer for: ${/Your step: (.*)/.exec(prompt)?.[1]}`;
    };
    const result = await AgentOrchestrator.orchestrate("research and compare electric scooters", { ask });
    const steps = prompts.filter((prompt) => prompt.startsWith("You are HANNAH's"));
    expect(steps.length).toBe(result.dag.nodes.length);
    expect(result.dag.nodes.every((node) => node.status === "completed")).toBe(true);
    if (result.dag.nodes.some((node) => node.dependencies.length)) expect(steps.some((prompt) => prompt.includes("What earlier steps found"))).toBe(true);
    expect(result.reviews[0].skepticFeedback).toBe("The price is from 2023");
    expect(result.finalResponse).toMatch(/2023 figure/);
    expect(result.reviews[0].confidence).toBeLessThan(0.95);
  });
});

describe("the home server is checked, not imagined", () => {
  it("reports a healthy server with what it offers, and an unreachable one with the reason", async () => {
    const healthy = await checkServer("https://hannah.example", async (url) => (String(url).endsWith("/api/health") ? json({ status: "ok", ready: true, provider: "Groq" }) : json({ accounts: { enabled: false }, database: { ready: false }, vault: false })));
    expect(healthy).toMatchObject({ ready: true, provider: "Groq", accounts: false, database: false });
    expect(healthy.error).toBeUndefined();
    const down = await checkServer("https://down.example", async () => { throw new TypeError("fetch failed"); });
    expect(down.error).toMatch(/fetch failed/);
  });
});

describe("PAP sign-in is real OAuth with PKCE", () => {
  const profile = { name: "Shop", client_id: "hannah-app", actions_endpoint: "https://shop.example/pap/actions", oauth: { authorization_endpoint: "https://shop.example/oauth/authorize", token_endpoint: "https://shop.example/oauth/token" } };
  it("sends a S256 challenge, exchanges the code with the matching verifier, rejects a foreign state, and acts only when confirmed", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/.well-known/pap.json")) return json(profile);
      if (url.endsWith("/oauth/token")) return json({ access_token: "at-123", expires_in: 3600 });
      if (url.endsWith("/pap/actions")) return json({ orderId: "o1" });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const { url, state } = await PAPAdapter.beginAuth("shop.example", ["orders"], { fetchImpl });
    const authorize = new URL(url);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("client_id")).toBe("hannah-app");
    await expect(PAPAdapter.completeAuth("shop.example", "code-1", "not-the-state", ["orders"], { fetchImpl })).rejects.toThrow(/wasn't started here/);
    const session = await PAPAdapter.completeAuth("shop.example", "code-1", state, ["orders"], { fetchImpl });
    expect(session.accessToken).toBe("at-123");
    const exchange = new URLSearchParams(String(calls.find((call) => call.url.endsWith("/oauth/token"))!.init!.body));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier")!)));
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(authorize.searchParams.get("code_challenge"));
    expect(await PAPAdapter.execute("shop.example", "order", { item: "tea" }, { fetchImpl })).toMatchObject({ status: "pending_user_confirmation" });
    expect(calls.some((call) => call.url.endsWith("/pap/actions"))).toBe(false);
    const done = await PAPAdapter.execute("shop.example", "order", { item: "tea" }, { confirmed: true, fetchImpl });
    expect(done).toMatchObject({ status: "done", result: { orderId: "o1" } });
    expect((calls.find((call) => call.url.endsWith("/pap/actions"))!.init!.headers as Record<string, string>).Authorization).toBe("Bearer at-123");
  });
});

describe("the agent card is the real one", () => {
  it("lists the device's actual tools and the server's A2A endpoint", async () => {
    const card = await AgentInteropService.expose({ tools: [{ name: "calendar_events" }, { name: "phone_call", requiresApproval: true }], fetchImpl: (async () => json({ name: "HANNAH", url: "https://hannah.example/api/a2a", skills: [{ id: "chat", name: "Chat" }] })) as typeof fetch });
    expect(card).toMatchObject({ source: "server", url: "https://hannah.example/api/a2a", skills: [{ id: "chat", name: "Chat" }] });
    expect(card.capabilities).toEqual(["chat", "memory", "calendar_events", "phone_call"]);
    const offline = await AgentInteropService.expose({ tools: [], fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
    expect(offline.source).toBe("device-only");
  });
});

describe("hardware pairs and commands only with the device's own answer", () => {
  function fakeDevice(reply: (message: Record<string, unknown>) => Record<string, unknown> | null) {
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: 0, onopen: null as ((event: unknown) => void) | null, onmessage: null as ((event: { data: unknown }) => void) | null, onerror: null as ((event: unknown) => void) | null, onclose: null as ((event: unknown) => void) | null,
      send(data: string) { const message = JSON.parse(data); sent.push(message); const answer = reply(message); if (answer) setTimeout(() => socket.onmessage?.({ data: JSON.stringify(answer) }), 1); },
      close() { socket.readyState = 3; },
    };
    const factory = () => { setTimeout(() => { socket.readyState = 1; socket.onopen?.({}); }, 1); return socket; };
    return { factory, sent };
  }

  it("pairs when the device welcomes the pairing code, sends commands that are acknowledged, and refuses unsafe addresses", async () => {
    const device = fakeDevice((message) => message.type === "hello" ? (message.pairingCode === "4821" ? { type: "welcome", deviceId: "esp32-1", name: "Desk speaker", modalities: ["audio", "expression"], battery: 77 } : { type: "refused", reason: "wrong pairing code" }) : message.type === "command" ? { type: "ack", id: message.id, status: "ok" } : null);
    const adapter = new WebSocketHardwareAdapter(device.factory, 500);
    await expect(adapter.pair("ws://speaker.local:8765#0000")).rejects.toThrow(/refused pairing/);
    await adapter.pair("ws://speaker.local:8765#4821");
    expect(adapter.isPaired()).toBe(true);
    expect(await adapter.getHealth()).toMatchObject({ battery: 77, connected: true });
    expect(await adapter.sendCommand({ type: "audio", payload: { say: "hi" } })).toEqual({ status: "acknowledged" });
    await expect(adapter.sendCommand({ type: "vision", payload: {} })).rejects.toThrow(/doesn't support vision/);
    expect(() => checkDeviceAddress("ws://203.0.113.9:8765")).toThrow(/wss:\/\//);
    expect(checkDeviceAddress("wss://203.0.113.9:8765#77")).toMatchObject({ pairingCode: "77" });
  });

  it("a command the device never confirms fails instead of claiming it was sent", async () => {
    const device = fakeDevice((message) => (message.type === "hello" ? { type: "welcome", deviceId: "d", name: "Lamp", modalities: [] } : null));
    const adapter = new WebSocketHardwareAdapter(device.factory, 50);
    await adapter.pair("ws://lamp.local");
    await expect(adapter.sendCommand({ type: "expression", payload: {} })).rejects.toThrow(/didn't confirm/);
  });
});

describe("delegated agents do real work", () => {
  it("research runs a web worker per part of the question and combines them with sources; a quick answer is one model turn", async () => {
    const turns: Array<{ prompt: string; tools: string }> = [];
    const turn = async (input: { prompt: string; tools: "none" | "web" }) => {
      turns.push(input);
      if (input.tools === "web") return /Ather/.test(input.prompt) ? "Ather 450X costs ₹1.5 lakh (https://ather.example/450x)." : "Ola S1 costs ₹1.2 lakh (https://ola.example/s1).";
      if (/research notes/.test(input.prompt)) return "Ola is cheaper; Ather costs more (sources: ather.example, ola.example).";
      return "Hello!";
    };
    const research = new RouterAgent(defaultAgentProfiles).delegate("research", undefined, turn) as InstanceType<typeof ResearchAgent>;
    const result = await research.run("Ather 450X vs Ola S1");
    expect(turns.filter((item) => item.tools === "web")).toHaveLength(2);
    expect(result.reply).toMatch(/Ola is cheaper/);
    expect(result.sources).toEqual(["https://ather.example/450x", "https://ola.example/s1"]);
    const quick = new FreelanceAgent(defaultAgentProfiles.chat ?? defaultAgentProfiles.default, turn);
    expect((await quick.run("hi")).reply).toBe("Hello!");
  });
});

describe("memories are checked again before they reach the model", () => {
  it("chaos mode's corrupted-memory fault sends none; normally they go", () => {
    MemoryService.remember("My dog Bruno is a beagle", { source: { kind: "you" } });
    expect(selectMemoriesForPrompt("what breed is bruno").texts).toEqual(["My dog Bruno is a beagle"]);
    vi.spyOn(ChaosEngine, "consume").mockImplementation((fault) => fault === "corrupted-memory");
    expect(selectMemoriesForPrompt("what breed is bruno").texts).toEqual([]);
    vi.restoreAllMocks();
  });
});
