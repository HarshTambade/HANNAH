import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_VERSION, BackupError, canonical, collect, createBackup, mergeLists, NEVER_BACKED_UP, readBackup, restoreBackup } from "../services/Backup";

/** localStorage with length/key, which the backup enumerates. */
function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    dump: () => Object.fromEntries(store),
  };
}

const seed = {
  "hannah.chat.history.v1": JSON.stringify([{ id: "m1", role: "user", content: "Plan my Pune trip" }]),
  "hannah.memory.v1": JSON.stringify([{ id: "mem-1", layer: "long_term", content: "I live in Pune", updatedAt: "2026-11-01T00:00:00Z" }]),
  "hannah.reminders.v1": JSON.stringify([{ id: "r1", text: "Call Riya", dueAt: 1 }]),
  "hannah.tasks.v1": JSON.stringify([{ id: "workflow-1", kind: "workflow", title: "Morning plan", workflow: { id: "workflow-1", nodes: [], edges: [] } }]),
  "hannah.automations.v1": JSON.stringify([{ workflowId: "workflow-1", enabled: true, nextRunAt: 5 }]),
  "hannah.specialists.v1": JSON.stringify({ research: { enabled: false } }),
  "hannah.routing.v1": JSON.stringify({ mode: "private" }),
  "hannah.chat.mode": "cloud",
  "hannah.cloudProvider": "groq",
  "hannah.cloudModel:groq": "llama-3.3-70b-versatile",
  // Must never be in a backup.
  "hannah.session.groqKey": "gsk_SECRETSECRETSECRETSECRET0123",
  "hannah.session.apiToken": "token-secret-0123456789",
  "hannah.account.v1": JSON.stringify({ email: "me@example.com", sessionToken: "sess-secret-0123456789" }),
  "hannah.device.v1": JSON.stringify({ id: "dev-abcdefghijkl", name: "MacBook" }),
  "hannah.sync.base.memories": "[]",
  "hannah.credentials.v1": JSON.stringify({ anthropic: "sk-ant-secret" }),
};

let storage = memoryStorage(seed);
beforeEach(() => {
  storage = memoryStorage(seed);
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent: () => true });
});

const secrets = ["gsk_SECRET", "token-secret", "sess-secret", "me@example.com", "dev-abcdefghijkl", "sk-ant-secret"];

describe("backup", () => {
  it("backs up everything but credentials, and restores it on a blank device", async () => {
    const text = await createBackup();
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).toContain("I live in Pune");
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ format: "hannah-backup", version: BACKUP_VERSION, platform: "Web" });
    expect(Object.keys(parsed.sections).sort()).toEqual(["agents", "automations", "conversation", "memories", "providers", "reminders", "settings"]);

    const fresh = memoryStorage();
    vi.stubGlobal("window", { localStorage: fresh, dispatchEvent: () => true });
    const backup = await readBackup(text);
    expect(backup.manifest.sections.find((section) => section.id === "memories")?.items).toBe(1);
    expect(restoreBackup(backup)).toHaveLength(7);
    const restored = fresh.dump();
    for (const key of Object.keys(seed)) {
      if (NEVER_BACKED_UP.some((pattern) => pattern.test(key))) expect(restored[key]).toBeUndefined();
      else expect(restored[key]).toBe(seed[key as keyof typeof seed]);
    }
    expect(restored["hannah.chat.mode"]).toBe("cloud");
    expect(restored["hannah.cloudModel:groq"]).toBe("llama-3.3-70b-versatile");
  });

  it("refuses a file that was changed after it was made", async () => {
    const text = await createBackup();
    const tampered = JSON.parse(text);
    tampered.sections.memories["hannah.memory.v1"][0].content = "I live in Mumbai";
    await expect(readBackup(JSON.stringify(tampered))).rejects.toMatchObject({ reason: "corrupt" });
    await expect(readBackup("{\"hello\": 1}")).rejects.toMatchObject({ reason: "not-a-backup" });
    await expect(readBackup("not json")).rejects.toBeInstanceOf(BackupError);
  });

  it("encrypts with a passphrase and opens only with the right one", async () => {
    const text = await createBackup({ passphrase: "chai 4 life" });
    expect(text).not.toContain("I live in Pune");
    expect(JSON.parse(text)).toMatchObject({ encrypted: true, kdf: { name: "PBKDF2", iterations: 310000 }, cipher: { name: "AES-GCM" } });
    await expect(readBackup(text)).rejects.toMatchObject({ reason: "needs-passphrase" });
    await expect(readBackup(text, "wrong")).rejects.toMatchObject({ reason: "wrong-passphrase" });
    const backup = await readBackup(text, "chai 4 life");
    expect(backup.manifest.encrypted).toBe(true);
    expect((backup.sections.memories!["hannah.memory.v1"] as Array<{ content: string }>)[0].content).toBe("I live in Pune");
  }, 20_000);

  it("refuses a backup from a newer HANNAH instead of half-restoring it", async () => {
    const newer = { ...JSON.parse(await createBackup()), version: BACKUP_VERSION + 1 };
    await expect(readBackup(JSON.stringify(newer))).rejects.toMatchObject({ reason: "newer-version" });
  });

  it("merge keeps local data and the newer copy; replace makes the device match", async () => {
    const text = await createBackup();
    const backup = await readBackup(text);
    const local = memoryStorage({
      "hannah.memory.v1": JSON.stringify([
        { id: "mem-1", layer: "long_term", content: "I live in Pune (old)", updatedAt: "2026-10-01T00:00:00Z" },
        { id: "mem-local", layer: "long_term", content: "Only on this device", updatedAt: "2026-11-10T00:00:00Z" },
      ]),
      "hannah.routing.v1": JSON.stringify({ mode: "budget" }),
      "hannah.cloudModel:openai": "gpt-4.1",
    });
    vi.stubGlobal("window", { localStorage: local, dispatchEvent: () => true });
    restoreBackup(backup, { mode: "merge" });
    const merged = JSON.parse(local.getItem("hannah.memory.v1")!) as Array<{ id: string; content: string }>;
    expect(merged.map((item) => item.id).sort()).toEqual(["mem-1", "mem-local"]);
    expect(merged.find((item) => item.id === "mem-1")?.content).toBe("I live in Pune");
    // Settings already here are kept in a merge; missing ones are added.
    expect(JSON.parse(local.getItem("hannah.routing.v1")!)).toEqual({ mode: "budget" });
    expect(local.getItem("hannah.cloudModel:openai")).toBe("gpt-4.1");
    expect(local.getItem("hannah.cloudModel:groq")).toBe("llama-3.3-70b-versatile");

    restoreBackup(backup, { mode: "replace", sections: ["memories", "providers"] });
    expect((JSON.parse(local.getItem("hannah.memory.v1")!) as unknown[]).length).toBe(1);
    expect(local.getItem("hannah.cloudModel:openai")).toBeNull();
    expect(JSON.parse(local.getItem("hannah.routing.v1")!)).toEqual({ mode: "budget" });
  });

  it("merges lists by id, newest wins, and never drops anonymous items", () => {
    expect(mergeLists([{ id: 1, updatedAt: 5 }, { x: 1 }], [{ id: 1, updatedAt: 9 }, { id: 2 }, { x: 1 }, { y: 2 }])).toEqual([{ id: 1, updatedAt: 9 }, { id: 2 }, { x: 1 }, { y: 2 }]);
    expect(canonical({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe('{"a":[3,{"c":2,"d":1}],"b":1}');
  });

  it("only collects what a section lists", () => {
    const sections = collect(["providers"]);
    expect(Object.keys(sections)).toEqual(["providers"]);
    expect(Object.keys(sections.providers!).sort()).toEqual(["hannah.cloudModel:groq", "hannah.cloudProvider"]);
  });
});
