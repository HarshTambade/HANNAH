import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../services/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args), apiUrl: (path: string) => path }));
vi.mock("../services/ModelRouting", () => ({ readRoutingPreferences: () => ({ mode: "balanced" }) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/filesystem", () => ({ Directory: { Documents: "DOCUMENTS" }, Filesystem: { writeFile: vi.fn() } }));

// A small window: storage and events. There is no IndexedDB here, so files are held for the session, as in a private window.
function storage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, String(value)), removeItem: (key) => void data.delete(key), clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; } };
}
const target = new EventTarget();
(globalThis as { window?: unknown }).window = { localStorage: storage(), sessionStorage: storage(), addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target), setTimeout };

import { STUDIO_EVENT, clearConversationState, composeDocument, deleteResearch, formatsIn, getAttachments, getFile, getLastFiles, getStudioTools, listFiles, readUpload, research, researchHistory, runStudioTurn, studioIntent, type ResearchResult, type StudioEvent } from "../services/Studio";
import { summarizeToolResult } from "../services/ToolResultSummary";
import { CORE_TOOLS } from "../services/AgentRouter";
import { SPECIALISTS } from "../services/SpecialistAgents";
import catalog from "../../../shared/marketplace-catalog.json";

const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const result = (extra: Partial<ResearchResult> = {}): ResearchResult => ({
  id: "r_0011223344556677", question: "What changed in Rust 1.95?", mode: "latest", modeLabel: "Latest information", createdAt: Date.UTC(2026, 10, 19),
  answer: "Rust 1.95 stabilizes async closures in traits [1].", summary: "Async closures in traits are stable [1].", findings: [], conflicts: [], gaps: [], recommendations: [], followUps: ["How do I upgrade?"], table: null,
  sources: [{ n: 1, title: "Announcing Rust 1.95.0", url: "https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/", domain: "blog.rust-lang.org", author: "", publisher: "Rust Blog", published: "2026-10-09", accessed: "2026-11-19", kind: "", basis: "page", foundBy: ["Test"], scores: { relevance: 1, authority: 0.85, authorityReason: "official documentation", freshness: 0.85, ageDays: 41, corroboratedBy: 0, overall: 0.8 }, evidence: [{ text: "Rust 1.95.0 stabilizes async closures in traits." }] }],
  failed: [{ url: "https://paywalled.test/rust", title: "x", reason: "access refused (HTTP 403)" }], searches: [], plan: { subquestions: [], queries: ["rust 1.95"] }, methodology: ["Latest information, run on 2026-11-19."],
  stats: { searches: 2, searchesFailed: 0, found: 5, read: 1, failed: 1, sources: 1, seconds: 9 }, quality: { grounded: true, citations: 1, removed: 0, unsupported: [], uncitedWithNumbers: 0 }, ...extra,
});
const file = (format: string, name: string, extra = {}) => ({ id: `d_${format}0123456789abcdef`, version: 1, name, format, mime: "application/octet-stream", bytes: 5, data: btoa("hello"), summary: format === "pptx" ? { slides: 6, charts: 1 } : { sheets: [{ name: "Data" }], formulas: 4, charts: 1 }, checks: [{ name: "Opens as an Office package", ok: true, detail: "9 parts" }], ...extra });
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

beforeEach(() => { apiFetch.mockReset(); apiFetch.mockImplementation(async () => json({})); clearConversationState(); window.localStorage.clear(); });

describe("what a chat message asks of the Studio", () => {
  it("reads the format, or formats, out of ordinary words", () => {
    expect(formatsIn("Create a PPT on machine learning")).toEqual(["pptx"]);
    expect(formatsIn("Create a presentation and a PDF version of the same report")).toEqual(["pptx", "pdf"]);
    expect(formatsIn("Prepare a Word report from this research")).toEqual(["docx"]);
    expect(formatsIn("Build an Excel financial dashboard using this uploaded CSV")).toEqual(["xlsx"]);
    expect(formatsIn("What's the weather like?")).toEqual([]);
  });

  it("a request for a file is a document; research words mean research first, then the file", () => {
    expect(studioIntent("Create a 15-slide presentation on artificial intelligence in healthcare")).toEqual({ kind: "document", formats: ["pptx"] });
    expect(studioIntent("Research the latest AI agent frameworks and create a comparison report as a PDF")).toEqual({ kind: "research", mode: "compare", then: ["pdf"] });
    expect(studioIntent("Research this topic and give me both a detailed Word report and a presentation")).toEqual({ kind: "research", mode: "deep", then: ["pptx", "docx"] });
    expect(studioIntent("Find papers on retrieval augmented generation")).toEqual({ kind: "research", mode: "academic", then: [] });
    expect(studioIntent("What's new in Postgres?")).toEqual({ kind: "research", mode: "latest", then: [] });
  });

  it("the search switch researches the message in the chosen mode; without it, ordinary chat goes to the agent", () => {
    expect(studioIntent("How tall is Kangchenjunga?", { searchMode: "quick" })).toEqual({ kind: "research", mode: "quick", then: [] });
    expect(studioIntent("How tall is Kangchenjunga?", { searchMode: "deep" })).toEqual({ kind: "research", mode: "deep", then: [] });
    for (const message of ["How tall is Kangchenjunga?", "Remind me to call mum at 6", "I read a great PDF yesterday", "Can you explain what a pitch deck is?", "My presentation went badly today"]) expect(studioIntent(message), message).toEqual({ kind: "none" });
  });

  it("after a file was made, a change request revises it; a request for something new doesn't", () => {
    for (const message of ["Make it more professional", "Add more technical detail to the deck", "Change the theme", "Regenerate the third slide", "Remove the last section and shorten the report"]) expect(studioIntent(message, { recentFile: true }), message).toEqual({ kind: "revise" });
    expect(studioIntent("Make it more professional")).toEqual({ kind: "none" });
    expect(studioIntent("Create a new presentation about tides", { recentFile: true })).toEqual({ kind: "document", formats: ["pptx"] });
  });
});

describe("research through the shared service", () => {
  it("streams each step, keeps the result in this device's history, and carries the sources into a follow-up", async () => {
    const steps: StudioEvent[] = [];
    const heard: string[] = [];
    window.addEventListener(STUDIO_EVENT, (event) => heard.push((event as CustomEvent<{ kind: string }>).detail.kind));
    apiFetch.mockResolvedValueOnce(sse([{ type: "status", stage: "planning", message: "Planning the research" }, { type: "search", query: "rust 1.95", provider: "Test", state: "done", results: 5 }, { type: "read", url: "https://paywalled.test/rust", title: "x", state: "failed", reason: "access refused (HTTP 403)" }, { type: "result", result: result() }]));
    const first = await research("What changed in Rust 1.95?", "latest", { onEvent: (event) => steps.push(event) });
    expect(steps.map((event) => event.type)).toEqual(["status", "search", "read"]);
    expect(first.sources[0].url).toBe("https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/");
    expect(researchHistory().map((item) => item.id)).toEqual(["r_0011223344556677"]);
    expect(heard).toContain("progress");
    expect(bodyOf(apiFetch.mock.calls[0])).toMatchObject({ question: "What changed in Rust 1.95?", mode: "latest", previous: null });

    apiFetch.mockResolvedValueOnce(sse([{ type: "result", result: result({ id: "r_8899aabbccddeeff", question: "How do I upgrade?" }) }]));
    await research("How do I upgrade?", "latest");
    const sent = bodyOf(apiFetch.mock.calls[1]);
    expect(sent.previous.question).toBe("What changed in Rust 1.95?");
    expect(sent.previous.sources[0]).toMatchObject({ url: "https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/", evidence: [{ text: "Rust 1.95.0 stabilizes async closures in traits." }] });
    deleteResearch("r_0011223344556677");
    expect(researchHistory().map((item) => item.id)).toEqual(["r_8899aabbccddeeff"]);
  });

  it("a failure from the server is the error the person sees; nothing is added to history", async () => {
    apiFetch.mockResolvedValueOnce(sse([{ type: "status", stage: "planning", message: "Planning" }, { type: "error", message: "Groq rejected the API key. Check that it's valid and active.", reason: "auth" }]));
    await expect(research("anything at all", "quick")).rejects.toThrow("Groq rejected the API key");
    apiFetch.mockResolvedValueOnce(json({ error: "Add your Groq API key or a HANNAH access token.", reason: "credentials-required" }, 401));
    await expect(research("anything at all", "quick")).rejects.toThrow("Add your Groq API key");
    apiFetch.mockResolvedValueOnce(sse([{ type: "status", stage: "planning", message: "Planning" }]));
    await expect(research("anything at all", "quick")).rejects.toThrow("ended before the work finished");
    expect(researchHistory()).toEqual([]);
  });
});

describe("documents through the shared service", () => {
  it("“research X and make a deck” runs research, then writes the deck from it, and returns both for the reply", async () => {
    apiFetch.mockResolvedValueOnce(sse([{ type: "result", result: result() }]));
    apiFetch.mockResolvedValueOnce(sse([{ type: "outline", title: "Rust 1.95", sections: ["What changed"] }, { type: "result", files: [file("pptx", "Rust 1.95.pptx")], spec: { title: "Rust 1.95", sections: [] }, notes: [] }]));
    const text = "Research what changed in Rust 1.95 and create a 6-slide presentation";
    const intent = studioIntent(text);
    expect(intent).toEqual({ kind: "research", mode: "deep", then: ["pptx"] });
    const turn = await runStudioTurn(text, intent as Exclude<typeof intent, { kind: "none" }>);
    expect(turn.researchId).toBe("r_0011223344556677");
    expect(turn.fileIds).toHaveLength(1);
    expect(turn.reply).toMatch(/I wrote this up from the 1 sources I read: Rust 1\.95\.pptx \(6 slides, 1 chart\)/);
    // The deck was written from the research: its sources travel with the request.
    const sent = bodyOf(apiFetch.mock.calls[1]);
    expect(apiFetch.mock.calls[1][0]).toBe("/api/documents/compose");
    expect(sent.formats).toEqual(["pptx"]);
    expect(sent.context.research.sources[0].url).toBe("https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/");
    // The file is in this device's files, bytes and all, with what it was built from.
    const kept = await getFile(turn.fileIds![0]);
    expect(new TextDecoder().decode(kept!.data)).toBe("hello");
    expect(kept!.file).toMatchObject({ name: "Rust 1.95.pptx", format: "pptx", serverId: "d_pptx0123456789abcdef", spec: { title: "Rust 1.95", sections: [] } });
    expect((await listFiles()).map((item) => item.name)).toContain("Rust 1.95.pptx");
  });

  it("a change request sends the last document's description back, not a new request from scratch", async () => {
    apiFetch.mockResolvedValueOnce(sse([{ type: "result", files: [file("pptx", "Tides.pptx")], spec: { title: "Tides", sections: [{ heading: "Why tides happen", blocks: [] }] }, notes: [] }]));
    await composeDocument("Create a presentation about tides", { formats: ["pptx"] });
    apiFetch.mockResolvedValueOnce(sse([{ type: "result", files: [file("pptx", "Tides.pptx", { id: "d_pptxffffffffffffffff", version: 2 })], spec: { title: "Tides", sections: [] }, notes: [], changed: ["rewrote “Why tides happen”"] }]));
    const turn = await runStudioTurn("Make it more professional", { kind: "revise" });
    const sent = bodyOf(apiFetch.mock.calls[1]);
    expect(sent.base).toEqual({ title: "Tides", sections: [{ heading: "Why tides happen", blocks: [] }] });
    expect(sent.revises).toBe("d_pptx0123456789abcdef");
    expect(turn.reply).toMatch(/I rewrote “Why tides happen”\. Everything else is as it was/);
    expect(getLastFiles()[0].version).toBe(2);
  });

  it("an attached file is read once, described honestly, and used for the workbook and for conversion", async () => {
    const extraction = { kind: "csv", name: "sales.csv", bytes: 60, text: "## 3 rows × 2 columns", tables: [{ name: "sales", columns: ["Month", "Revenue"], rows: [["Jan", 10], ["Feb", 12], ["Mar", 9]] }], meta: {}, coverage: { unit: "rows", total: 3, read: 3, truncated: false, notes: [] } };
    apiFetch.mockResolvedValueOnce(json(extraction));
    const upload = new File(["Month,Revenue\nJan,10\nFeb,12\nMar,9\n"], "sales.csv", { type: "text/csv" });
    await readUpload(upload);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/documents/read");
    expect(atob(bodyOf(apiFetch.mock.calls[0]).data)).toBe("Month,Revenue\nJan,10\nFeb,12\nMar,9\n");
    expect(getAttachments().map((item) => item.name)).toEqual(["sales.csv"]);

    apiFetch.mockResolvedValueOnce(sse([{ type: "result", files: [file("xlsx", "Sales analysis.xlsx")], spec: { title: "Sales analysis", sheets: [] }, notes: ["Left out — chart “Bad chart”."] }]));
    const text = "Analyze this data, calculate monthly growth and build an Excel dashboard";
    const turn = await runStudioTurn(text, studioIntent(text) as { kind: "document"; formats: ["xlsx"] });
    expect(bodyOf(apiFetch.mock.calls[1]).context.files[0].tables[0].rows).toEqual([["Jan", 10], ["Feb", 12], ["Mar", 9]]);
    expect(turn.reply).toMatch(/Sales analysis\.xlsx \(1 sheet, 4 formulas, 1 chart\)\. Written from sales\.csv/);
    expect(turn.reply).toContain("- Left out — chart “Bad chart”.");

    // "Convert this to PDF" with one file attached is a conversion of that file, not a new document.
    expect(studioIntent("Convert this to PDF")).toEqual({ kind: "convert", file: "sales.csv", to: "pdf" });
    apiFetch.mockResolvedValueOnce(json({ files: [file("pdf", "sales.pdf", { summary: { pages: 1 } })] }));
    const converted = await runStudioTurn("Convert this to PDF", { kind: "convert", file: "sales.csv", to: "pdf" });
    expect(apiFetch.mock.calls[2][0]).toBe("/api/documents/convert");
    expect(bodyOf(apiFetch.mock.calls[2])).toMatchObject({ name: "sales.csv", to: "pdf" });
    expect(converted.reply).toMatch(/Your original file is unchanged/);
    await expect(readUpload(new File([new Uint8Array(10 * 1024 * 1024)], "huge.pdf"))).rejects.toThrow("larger than 9 MB");
  });
});

describe("one set of tools for every agent", () => {
  it("the Studio's four tools exist once, and every kind of agent is given them rather than its own", () => {
    const tools = getStudioTools();
    expect(tools.map((tool) => tool.name)).toEqual(["research", "create_document", "read_attached_files", "convert_file"]);
    expect(CORE_TOOLS).toEqual(expect.arrayContaining(["research", "create_document"]));
    const specialist = (id: string) => SPECIALISTS.find((item) => item.id === id)!.tools;
    expect(specialist("research")).toEqual(expect.arrayContaining(["research", "create_document", "read_attached_files", "convert_file"]));
    expect(specialist("coding")).toEqual(expect.arrayContaining(["research", "create_document"]));
    expect(specialist("tasks")).toEqual(expect.arrayContaining(["create_document"]));
    const agent = (id: string) => (catalog.find((item) => item.id === id) as { tools: string[] }).tools;
    expect(agent("research-analyst")).toEqual(expect.arrayContaining(["research", "create_document"]));
    expect(agent("data-analyst")).toEqual(expect.arrayContaining(["read_attached_files", "create_document", "convert_file"]));
  });

  it("the research tool returns the checked answer with its sources and what couldn't be read", async () => {
    apiFetch.mockResolvedValueOnce(sse([{ type: "result", result: result({ quality: { grounded: true, citations: 1, removed: 0, unsupported: [{ kind: "number", value: "42", sentence: "x" }], uncitedWithNumbers: 0 } }) }]));
    const tool = getStudioTools().find((item) => item.name === "research")!;
    const output = await tool.execute({ question: "What changed in Rust 1.95?", mode: "latest" }) as { message: string };
    expect(output.message).toContain("Rust 1.95 stabilizes async closures in traits [1].");
    expect(output.message).toContain("[1] Announcing Rust 1.95.0 — https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/ (2026-10-09)");
    expect(output.message).toContain("Could not be read: https://paywalled.test/rust (access refused (HTTP 403))");
    expect(output.message).toContain("say they are unconfirmed: 42");
    expect(summarizeToolResult("research", output)).toBe("Researched the web · 1 source read and cited");
  });

  it("the document tool asks the Studio to write it; the file tool says plainly when nothing is attached", async () => {
    apiFetch.mockResolvedValueOnce(sse([{ type: "result", files: [file("pptx", "Tides.pptx")], spec: { title: "Tides", sections: [] }, notes: [] }]));
    const create = getStudioTools().find((item) => item.name === "create_document")!;
    const output = await create.execute({ request: "A presentation about tides", formats: ["pptx", "odt"] }) as { message: string };
    expect(bodyOf(apiFetch.mock.calls[0]).formats).toEqual(["pptx"]);
    expect(summarizeToolResult("create_document", output)).toBe("Created: Tides.pptx (6 slides, 1 chart)");
    await expect(create.execute({ request: "x", formats: [] })).rejects.toThrow("Say which format");
    const read = getStudioTools().find((item) => item.name === "read_attached_files")!;
    expect(((await read.execute({})) as { message: string }).message).toMatch(/No files are attached/);
  });
});
