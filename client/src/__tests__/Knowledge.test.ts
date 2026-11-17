import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText, getKnowledgeTools, isTextFile, Knowledge, MAX_DOC_CHARS, MAX_TOTAL_CHARS, UNTRUSTED_NOTE } from "../services/Knowledge";

function memoryStorage() {
  const store = new Map<string, string>();
  return { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, dump: () => Object.fromEntries(store) };
}

let storage = memoryStorage();
const events: string[] = [];
beforeEach(() => {
  storage = memoryStorage();
  events.length = 0;
  vi.stubGlobal("window", { localStorage: storage, dispatchEvent: (event: Event) => { events.push(event.type); return true; } });
  vi.stubGlobal("CustomEvent", class { type: string; constructor(type: string) { this.type = type; } });
  Knowledge.clear();
});

const trip = `Trip notes for Pune.

We land on Friday at 06:40 and take the airport taxi to Koregaon Park. The hotel is Blue Diamond, check-in from noon.

Saturday is Shaniwar Wada in the morning, then lunch at Vaishali on FC Road. Riya joins us at 13:30.

Sunday: Sinhagad fort hike, leave by 06:00 to beat the heat. Train back is 19:15 from Pune Junction.`;

const recipe = `Dal tadka. Soak 1 cup toor dal for 30 minutes. Pressure-cook with turmeric. Temper mustard seeds, cumin, garlic and dried chillies in ghee, pour over the dal, finish with coriander.`;

describe("chunking", () => {
  it("splits long text into overlapping pieces on paragraph and sentence boundaries", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}. ${"Some words about topic number " + (index + 1) + ". "}${"filler ".repeat(40)}`).join("\n\n");
    const chunks = chunkText(paragraphs, 600, 80);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(600);
    // Overlap: the start of each chunk repeats the end of the previous one.
    for (let index = 1; index < chunks.length; index += 1) expect(chunks[index - 1]!.slice(-20).trim().length).toBeGreaterThan(0);
    expect(chunks.join(" ")).toContain("Paragraph 12.");
  });

  it("keeps a short text whole and drops empty input", () => {
    expect(chunkText("just a line")).toEqual(["just a line"]);
    expect(chunkText("   \n\n ")).toEqual([]);
  });

  it("knows which files are text", () => {
    expect(isTextFile("notes.md")).toBe(true);
    expect(isTextFile("src/App.tsx")).toBe(true);
    expect(isTextFile("Dockerfile")).toBe(true);
    expect(isTextFile("photo.JPG")).toBe(false);
    expect(isTextFile("paper.pdf")).toBe(false);
  });
});

describe("knowledge", () => {
  it("adds documents, searches them with citations and persists", () => {
    const added = Knowledge.add({ title: "Trip notes", text: trip, source: { kind: "paste" } });
    expect(added).toMatchObject({ ok: true, replaced: false });
    Knowledge.add({ title: "Dal tadka", text: recipe, source: { kind: "upload", path: "dal.md" } });
    expect(Knowledge.usage()).toMatchObject({ docs: 2 });
    expect(events).toContain("hannah:knowledge");

    const hits = Knowledge.search("when does the train leave Pune");
    expect(hits[0]).toMatchObject({ title: "Trip notes" });
    expect(hits[0]!.citation).toMatch(/^\[Trip notes §\d+\]$/);
    expect(hits[0]!.text).toContain("19:15");
    expect(hits.every((hit) => hit.title === "Trip notes")).toBe(true);

    const cooking = Knowledge.search("tempering mustard seeds in ghee");
    expect(cooking[0]).toMatchObject({ title: "Dal tadka", citation: "[Dal tadka §1]" });

    // Stored under one key, so it survives a reload.
    expect(Object.keys(storage.dump())).toEqual(["hannah.knowledge.v1"]);
    expect(Knowledge.search("")).toEqual([]);
    expect(Knowledge.search("quantum chromodynamics")).toEqual([]);
  });

  it("searches in any script", () => {
    Knowledge.add({ title: "किराना", text: "रविवार को सब्ज़ी मंडी से टमाटर, प्याज़ और धनिया लाना है। दूध सुबह आता है।", source: { kind: "paste" } });
    expect(Knowledge.search("टमाटर प्याज़")[0]).toMatchObject({ title: "किराना" });
  });

  it("replaces a document added again from the same file", () => {
    Knowledge.add({ title: "notes.md", text: "first version", source: { kind: "upload", path: "notes.md" } });
    const again = Knowledge.add({ title: "notes.md", text: "second version with more", source: { kind: "upload", path: "notes.md" } });
    expect(again).toMatchObject({ ok: true, replaced: true });
    expect(Knowledge.list()).toHaveLength(1);
    expect(Knowledge.search("second")[0]!.text).toContain("second version");
  });

  it("refuses empty, binary and oversized documents and enforces the budget", () => {
    expect(Knowledge.add({ title: "Empty", text: "  ", source: { kind: "paste" } })).toMatchObject({ ok: false });
    expect(Knowledge.add({ title: "Binary", text: "PK\u0003\u0004\0\0garbage", source: { kind: "upload", path: "x.zip" } })).toMatchObject({ ok: false, reason: expect.stringContaining("isn't a text file") });
    expect(Knowledge.add({ title: "Huge", text: "x".repeat(MAX_DOC_CHARS + 1), source: { kind: "paste" } })).toMatchObject({ ok: false, reason: expect.stringContaining("limit per document") });
    const big = "word ".repeat(MAX_DOC_CHARS / 5 - 10);
    let refused = "";
    for (let index = 0; index < 10; index += 1) {
      const result = Knowledge.add({ title: `Big ${index}`, text: big, source: { kind: "paste" } });
      if (!result.ok) { refused = result.reason; break; }
    }
    expect(refused).toContain("budget");
    expect(Knowledge.usage().chars).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
  });

  it("removes and clears", () => {
    const added = Knowledge.add({ title: "Trip notes", text: trip, source: { kind: "paste" } });
    if (!added.ok) throw new Error(added.reason);
    expect(Knowledge.remove(added.doc.id)).toBe(true);
    expect(Knowledge.remove(added.doc.id)).toBe(false);
    expect(Knowledge.list()).toEqual([]);
  });

  it("gives the agent passages marked as content, and says when there's nothing", async () => {
    const [search, documents] = getKnowledgeTools();
    expect(await search!.execute({ query: "train" })).toMatchObject({ hits: [], note: expect.stringContaining("hasn't added") });
    Knowledge.add({ title: "Trip notes", text: trip, source: { kind: "paste" } });
    const result = (await search!.execute({ query: "train from Pune Junction", limit: 2 })) as { hits: Array<{ citation: string; passage: string }>; note: string };
    expect(result.note).toBe(UNTRUSTED_NOTE);
    expect(result.hits).toHaveLength(Math.min(2, result.hits.length));
    expect(result.hits[0]!.citation).toMatch(/^\[Trip notes §\d+\]$/);
    expect(search!.requiresApproval).toBeUndefined();
    expect(await documents!.execute({})).toMatchObject({ documents: [{ title: "Trip notes", source: "paste" }] });
  });
});
