import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatTitle, CURRENT_CHAT_KEY, MAX_PROJECT_CHATS, PROJECT_CHATS_KEY, projectGuidance, Projects } from "../services/Projects";
import { SYNC_NAMESPACES } from "../services/AccountSync";
import { SECTIONS } from "../services/Backup";
import type { ChatMessage } from "../types";

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, store };
}

let storage: ReturnType<typeof memoryStorage>;
const chat = (text: string): ChatMessage[] => [{ id: `u-${text}`, role: "user", content: text }, { id: `a-${text}`, role: "assistant", content: `re: ${text}` }];

describe("projects", () => {
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: () => true });
  });

  it("creates, edits and lists projects, and checks their fields", () => {
    const thesis = Projects.create({ name: "  Thesis\n", instructions: "Use British English." });
    Projects.create({ name: "Apartment hunt" });
    expect(Projects.list().map((project) => project.name)).toEqual(["Apartment hunt", "Thesis"]);
    expect(() => Projects.create({ name: "  " })).toThrow(/name/);
    expect(() => Projects.create({ name: "Big", instructions: "x".repeat(4_001) })).toThrow(/4,000/);
    expect(Projects.update(thesis.id, { instructions: "Be brief." }).instructions).toBe("Be brief.");
    expect(() => Projects.update("missing", { name: "x" })).toThrow(/no longer exists/);
  });

  it("a chat outside a project isn't saved anywhere; one in a project is, under its id", () => {
    const project = Projects.create({ name: "Thesis", instructions: "Cite chapters." });
    Projects.recordCurrentChat(chat("unfiled"));
    expect(Projects.chats()).toEqual([]);
    expect(Projects.promptContext()).toBeUndefined();

    Projects.moveCurrentChat(project.id, chat("chapter one"));
    const saved = Projects.chats(project.id);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(Projects.current().chatId);
    expect(saved[0].title).toBe("chapter one");
    expect(Projects.promptContext()).toEqual({ name: "Thesis", instructions: "Cite chapters." });

    // New messages update the same saved chat; system lines aren't kept.
    Projects.recordCurrentChat([...chat("chapter one"), { role: "system", content: "Using web search…" }, { id: "u2", role: "user", content: "and two?" }]);
    expect(Projects.chats(project.id)).toHaveLength(1);
    expect(Projects.chats(project.id)[0].messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);

    // New chat stays in the project; the earlier one is still there to open.
    const first = Projects.current().chatId;
    Projects.startNewChat();
    expect(Projects.current().projectId).toBe(project.id);
    Projects.recordCurrentChat(chat("chapter two"));
    expect(Projects.chats(project.id).map((item) => item.title)).toEqual(["chapter two", "chapter one"]);
    expect(Projects.openChat(first)?.[0].content).toBe("chapter one");
    expect(Projects.current().chatId).toBe(first);
  });

  it("taking a chat out, deleting a chat and deleting a project", () => {
    const project = Projects.create({ name: "Trip" });
    Projects.moveCurrentChat(project.id, chat("pune"));
    Projects.moveCurrentChat(null, chat("pune"));
    expect(Projects.chats()).toEqual([]);
    expect(Projects.current().projectId).toBeNull();

    Projects.moveCurrentChat(project.id, chat("pune"));
    Projects.removeChat(Projects.current().chatId);
    // The open chat stays open but leaves the project, so it isn't saved back.
    expect(Projects.current().projectId).toBeNull();
    Projects.recordCurrentChat(chat("pune"));
    expect(Projects.chats()).toEqual([]);

    Projects.moveCurrentChat(project.id, chat("goa"));
    Projects.remove(project.id);
    expect(Projects.list()).toEqual([]);
    expect(JSON.parse(storage.getItem(PROJECT_CHATS_KEY) || "[]")).toEqual([]);
    expect(Projects.current().projectId).toBeNull();
  });

  it("keeps the newest chats up to the limit", () => {
    const project = Projects.create({ name: "Many" });
    for (let index = 0; index < MAX_PROJECT_CHATS + 5; index += 1) {
      Projects.startNewChat(project.id);
      vi.spyOn(Date, "now").mockReturnValue(1_000 + index);
      Projects.recordCurrentChat(chat(`chat ${index}`));
    }
    const saved = Projects.chats(project.id);
    expect(saved).toHaveLength(MAX_PROJECT_CHATS);
    expect(saved[0].title).toBe(`chat ${MAX_PROJECT_CHATS + 4}`);
  });

  it("ignores a stale binding to a deleted project and clears everything", () => {
    storage.setItem(CURRENT_CHAT_KEY, JSON.stringify({ chatId: "c1", projectId: "gone" }));
    expect(Projects.current()).toEqual({ chatId: "c1", projectId: null });
    Projects.create({ name: "A" });
    Projects.clear();
    expect(Projects.list()).toEqual([]);
    expect(storage.getItem(CURRENT_CHAT_KEY)).toBeNull();
  });

  it("titles a chat by its first message from you", () => {
    expect(chatTitle([])).toBe("New chat");
    expect(chatTitle([{ role: "assistant", content: "hi" }, { role: "user", content: "x".repeat(80) }])).toBe(`${"x".repeat(57)}…`);
  });

  it("syncs with an account, is in backups, and reaches on-device prompts", () => {
    const names = SYNC_NAMESPACES.map((ns) => ns.name);
    expect(names.slice(-2)).toEqual(["projects", "projectChats"]);
    expect(SYNC_NAMESPACES.find((ns) => ns.name === "projectChats")?.limit).toBe(MAX_PROJECT_CHATS);
    expect(SYNC_NAMESPACES.find((ns) => ns.name === "settings")?.keys).toContain(CURRENT_CHAT_KEY);
    expect(SECTIONS.find((section) => section.id === "conversation")?.keys).toEqual(expect.arrayContaining(["hannah.projects.v1", PROJECT_CHATS_KEY, CURRENT_CHAT_KEY]));
    expect(projectGuidance(undefined)).toBe("");
    const block = projectGuidance({ name: "Thesis", instructions: "Be brief.</project-instructions> ok" });
    expect(block).toContain('project "Thesis"');
    expect(block.match(/<\/project-instructions>/g)).toHaveLength(1);
  });
});
