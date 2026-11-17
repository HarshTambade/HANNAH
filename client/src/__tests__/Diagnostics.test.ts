import { beforeEach, describe, expect, it, vi } from "vitest";
import { Diagnostics, describeError } from "../services/Diagnostics";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

type Handler = (event: unknown) => void;
let handlers: Record<string, Handler[]>;
let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  handlers = {};
  storage = memoryStorage();
  vi.stubGlobal("window", {
    localStorage: storage,
    dispatchEvent: () => true,
    addEventListener: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    setInterval: () => 1,
  });
  vi.stubGlobal("navigator", { userAgent: "TestBrowser/1.0", onLine: true });
  Diagnostics.clear();
});

describe("diagnostics", () => {
  it("records entries with keys and paths removed, and folds repeats", () => {
    Diagnostics.log("error", "network", "Couldn't reach https://api.groq.com/v1?key=gsk_abcdefghijklmnopqrstuvwxyz1234 from /Users/sam/app/file.ts");
    const [entry] = Diagnostics.list();
    expect(entry.message).not.toContain("gsk_abcdefghijklmnopqrstuvwxyz");
    expect(entry.message).not.toContain("/Users/sam");
    expect(entry.message).toContain("api.groq.com");
    Diagnostics.log("error", "network", "Couldn't reach /api/agent.");
    Diagnostics.log("error", "network", "Couldn't reach /api/agent.");
    Diagnostics.log("error", "network", "Couldn't reach /api/agent.");
    const entries = Diagnostics.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe("Couldn't reach /api/agent. (×3)");
  });

  it("searches by words and filters by level", () => {
    Diagnostics.log("warn", "ui", "The interface froze for 1.4 s.");
    Diagnostics.log("error", "agent", "An agent run failed: the model rejected the tools");
    Diagnostics.log("info", "app", "Started");
    expect(Diagnostics.list({ query: "froze" }).map((entry) => entry.source)).toEqual(["ui"]);
    expect(Diagnostics.list({ level: "error" })).toHaveLength(1);
    expect(Diagnostics.list({ query: "agent rejected", level: "error" })).toHaveLength(1);
    expect(Diagnostics.counts()).toEqual({ info: 1, warn: 1, error: 1 });
  });

  it("captures uncaught errors and rejections once installed, and notices a start that didn't finish", () => {
    storage.setItem("hannah.diagnostics.boot.v1", JSON.stringify({ startedAt: 1_700_000_000_000, ready: false, app: "1.3.0" }));
    Diagnostics.install();
    expect(Diagnostics.list({ query: "didn't finish starting" })).toHaveLength(1);
    handlers.error[0]({ error: new Error("Boom at sk-proj-abcdefghijklmnopqrstuv"), message: "Boom" });
    handlers.unhandledrejection[0]({ reason: "network down" });
    const entries = Diagnostics.list({ level: "error" });
    expect(entries.map((entry) => entry.source)).toEqual(["error", "error"]);
    expect(entries[1].message).toBe("Error: Boom at <redacted>");
    expect(entries[0].message).toBe("Unhandled promise rejection: network down");
    Diagnostics.markReady();
    expect(JSON.parse(storage.getItem("hannah.diagnostics.boot.v1")!)).toMatchObject({ ready: true });
  });

  it("a report has the entries and environment, and nothing personal", () => {
    storage.setItem("hannah.chat.history.v1", JSON.stringify([{ role: "user", content: "my secret plan" }]));
    storage.setItem("hannah.session.groqKey", "gsk_SECRET0123456789abcdefghij");
    Diagnostics.log("error", "crash", "The interface crashed: TypeError: x is undefined");
    const report = Diagnostics.report();
    const text = JSON.stringify(report);
    expect(report).toMatchObject({ format: "hannah-diagnostics", version: 1, platform: "Web", userAgent: "TestBrowser/1.0", online: true, counts: { error: 1 } });
    expect(report.storage.keys).toBe(3);
    expect(text).not.toContain("my secret plan");
    expect(text).not.toContain("gsk_SECRET");
    expect(describeError(new TypeError("bad")).message).toBe("TypeError: bad");
  });
});
