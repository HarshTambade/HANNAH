import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Research and Document Studio in the chat, as a person uses them. The server
 * is a stand-in that answers the Studio's routes the way the real one does
 * (an event stream of steps, then a result), so what is checked here is the
 * app: what it sends, what it shows, and that the file really downloads.
 */
const groqKey = "gsk_e2eStudioKey0123456789abcdefghijklmnop";
const sse = (events: unknown[]) => ({ status: 200, contentType: "text/event-stream", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
const pdfBytes = Buffer.from("%PDF-1.4\n% a small stand-in file\n%%EOF\n");

const research = {
  id: "r_00112233445566778899", question: "What changed in Rust 1.95?", mode: "deep", modeLabel: "Deep research", createdAt: Date.UTC(2026, 10, 19, 10),
  answer: "Rust 1.95 stabilizes async closures in traits [1]. Compile times fell by 12 percent [1][2].", summary: "Async closures in traits are stable, and builds are faster [1].",
  findings: [{ claim: "Compile times fell by 12 percent", citations: [1, 2], basis: "verified" }], conflicts: [], gaps: ["Benchmarks on Windows"], recommendations: [], followUps: ["How do I upgrade to Rust 1.95?"], table: null,
  sources: [
    { n: 1, title: "Announcing Rust 1.95.0", url: "https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/", domain: "blog.rust-lang.org", author: "The Rust Release Team", publisher: "Rust Blog", published: "2026-10-09", accessed: "2026-11-19", kind: "", basis: "page", foundBy: ["Test search"], scores: { relevance: 1, authority: 0.85, authorityReason: "official documentation", freshness: 0.85, ageDays: 41, corroboratedBy: 1, overall: 0.8 }, evidence: [{ text: "Rust 1.95.0 stabilizes async closures in traits and lowers compile times by 12 percent." }] },
    { n: 2, title: "Rust 1.95 is out", url: "https://example-news.test/rust-195", domain: "example-news.test", author: "", publisher: "", published: "2026-10-10", accessed: "2026-11-19", kind: "", basis: "page", foundBy: ["Test search"], scores: { relevance: 0.6, authority: 0.5, authorityReason: "website", freshness: 0.85, ageDays: 40, corroboratedBy: 1, overall: 0.6 }, evidence: [{ text: "The project says compile times dropped by 12 percent." }] },
  ],
  failed: [{ url: "https://paywalled.test/rust", title: "Analysis", reason: "access refused (HTTP 403); it may need a sign-in or subscription" }],
  searches: [{ query: "rust 1.95 changes", provider: "Test search", results: 5, error: "" }], plan: { subquestions: [], queries: ["rust 1.95 changes"] },
  methodology: ["Deep research, run on 2026-11-19. Search providers: Test search.", "1 page could not be read: paywalled.test (access refused)."],
  stats: { searches: 1, searchesFailed: 0, found: 5, read: 2, failed: 1, sources: 2, seconds: 12 },
  quality: { grounded: true, citations: 3, removed: 0, unsupported: [], uncitedWithNumbers: 0, staleSources: [], flaggedSources: [] },
};
const file = (format: string, name: string, summary: Record<string, unknown>, data = pdfBytes) => ({ name, format, label: format, mime: format === "pdf" ? "application/pdf" : "application/octet-stream", bytes: data.length, data: data.toString("base64"), summary, checks: [{ name: "Opens again after writing", ok: true, detail: "ok" }, { name: "Text is readable", ok: true, detail: "120 characters" }] });

type Calls = { research: Array<Record<string, any>>; compose: Array<Record<string, any>>; read: Array<Record<string, any>>; agent: number };
async function studio(page: Page): Promise<Calls> {
  const calls: Calls = { research: [], compose: [], read: [], agent: 0 };
  await page.route(/\/(api|v1)\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === "POST" ? request.postDataJSON?.() ?? {} : {};
    if (path === "/api/health") return route.fulfill({ json: { status: "ok", provider: "Groq", ready: true } });
    if (path === "/api/providers") return route.fulfill({ json: { defaultProvider: "groq", providers: [{ id: "groq", label: "Groq", local: false, configured: true }] } });
    if (path === "/api/models") return route.fulfill({ json: { provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] } });
    if (path === "/api/research") {
      calls.research.push(body);
      return route.fulfill(sse([{ type: "status", stage: "planning", message: "Planning the research" }, { type: "search", query: "rust 1.95 changes", provider: "Test search", state: "done", results: 5 }, { type: "read", url: "https://paywalled.test/rust", title: "Analysis", state: "failed", reason: "access refused (HTTP 403)" }, { type: "result", result: { ...research, question: body.question, mode: body.mode } }]));
    }
    if (path === "/api/documents/compose") {
      calls.compose.push(body);
      const format = body.formats?.[0] || "pdf";
      const made = format === "xlsx" ? file("xlsx", "Sales analysis.xlsx", { sheets: [{ name: "Summary" }, { name: "Sales" }], formulas: 14, charts: 1 }) : format === "pptx" ? file("pptx", "Rust 1.95.pptx", { slides: 6, charts: 0 }) : file("pdf", "Rust 1.95.pdf", { pages: 4, references: 2 });
      return route.fulfill(sse([{ type: "status", stage: "outline", message: "Planning the structure" }, { type: "result", files: [made], spec: { title: "Rust 1.95", sections: [{ heading: "What changed", blocks: [{ type: "paragraph", text: "Async closures." }] }] }, notes: body.base ? [] : format === "xlsx" ? ["Left out — chart “Bad chart” on Sales: its columns aren't in the sheet or aren't numbers."] : [], ...(body.base ? { changed: ["rewrote “What changed”"] } : {}) }]));
    }
    if (path === "/api/documents/read") {
      calls.read.push(body);
      return route.fulfill({ json: { kind: "csv", name: body.name, bytes: 60, text: "## 3 rows × 2 columns", tables: [{ name: "sales", columns: ["Month", "Revenue"], rows: [["Jan", 10], ["Feb", 12], ["Mar", 9]] }], meta: {}, coverage: { unit: "rows", total: 3, read: 3, truncated: false, notes: [] } } });
    }
    if (path === "/api/agent") {
      calls.agent += 1;
      return route.fulfill({ json: { message: { content: JSON.stringify({ reply: "Hello! How can I help?", emotion: "happy" }), tool_calls: [] } } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.addInitScript((key) => { sessionStorage.setItem("hannah.session.groqKey", key); localStorage.setItem("hannah.onboarding.v1", "complete"); }, groqKey);
  await page.goto("/chat");
  await expect(page.getByRole("textbox", { name: "Message HANNAH" })).toBeVisible();
  return calls;
}
const send = async (page: Page, text: string) => { await page.getByRole("textbox", { name: "Message HANNAH" }).fill(text); await page.getByRole("button", { name: "Send message" }).click(); };

test("web search: the switch, a mode, an answer whose citations open the sources, and what couldn't be read", async ({ page }) => {
  const calls = await studio(page);
  // Off by default: an ordinary message goes to the agent, not to research.
  await send(page, "hello there");
  await expect(page.getByText("Hello! How can I help?")).toBeVisible();
  expect(calls.research).toHaveLength(0);

  await page.getByRole("button", { name: "Search the web" }).click();
  await expect(page.getByRole("button", { name: "Search the web" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Research mode").selectOption("deep");
  await send(page, "What changed in Rust 1.95?");
  await expect(page.getByText("Rust 1.95 stabilizes async closures in traits")).toBeVisible();
  expect(calls.research[0]).toMatchObject({ question: "What changed in Rust 1.95?", mode: "deep" });

  // Each [n] in the answer is a link to the source it cites.
  const citation = page.getByRole("link", { name: "Source 1: Announcing Rust 1.95.0" }).first();
  await expect(citation).toHaveAttribute("href", "https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/");
  await expect(citation).toHaveAttribute("target", "_blank");
  const sources = page.getByRole("region", { name: "Sources for: What changed in Rust 1.95?" });
  await expect(sources).toContainText("2 sources · Deep research");
  await expect(sources.getByRole("link", { name: /Announcing Rust 1\.95\.0/ })).toHaveAttribute("href", "https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/");
  await expect(sources).toContainText("blog.rust-lang.org · The Rust Release Team · published 2026-10-09 · official documentation · 1 other site agree");
  await sources.getByText("What HANNAH read here").first().click();
  await expect(sources).toContainText("Rust 1.95.0 stabilizes async closures in traits and lowers compile times by 12 percent.");
  await sources.getByText("Pages that couldn't be read (1)").click();
  await expect(sources).toContainText("paywalled.test: access refused (HTTP 403)");
  await sources.getByText("Findings and what each rests on").click();
  await expect(sources).toContainText("Independent sources agree");
  await expect(sources).toContainText("Not covered by what was found: Benchmarks on Windows");

  // A follow-up keeps the context: the earlier sources go with the next question, in the same mode.
  await page.getByRole("button", { name: "Search the web" }).click();
  await sources.getByRole("button", { name: "How do I upgrade to Rust 1.95?" }).click();
  await expect.poll(() => calls.research.length).toBe(2);
  expect(calls.research[1].mode).toBe("deep");
  expect(calls.research[1].previous.question).toBe("What changed in Rust 1.95?");
  expect(calls.research[1].previous.sources[0].url).toBe("https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/");
});

test("research becomes a PDF with one press, and the file really downloads", async ({ page }) => {
  const calls = await studio(page);
  await page.getByRole("button", { name: "Search the web" }).click();
  await send(page, "What changed in Rust 1.95?");
  const sources = page.getByRole("region", { name: /^Sources for:/ });
  await sources.getByRole("button", { name: "PDF" }).click();
  const card = page.getByRole("article", { name: "Rust 1.95.pdf" });
  await expect(card).toContainText("PDF · 1 KB · 4 pages · 2 references");
  await expect(card).toContainText("Opened again and checked: 2 of 2 checks passed");
  // The report is written from that research: its sources travel with the request.
  expect(calls.compose[0].formats).toEqual(["pdf"]);
  expect(calls.compose[0].context.research.sources.map((source: { url: string }) => source.url)).toEqual(["https://blog.rust-lang.org/2026/10/09/Rust-1.95.0/", "https://example-news.test/rust-195"]);
  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe("Rust 1.95.pdf");
  expect(readFileSync(await download.path()).equals(pdfBytes)).toBe(true);
  await expect(card.getByRole("status")).toHaveText("Downloaded Rust 1.95.pdf");

  // Saving to memory happens only when asked, and says so.
  await sources.getByRole("button", { name: "Save to memory" }).click();
  await expect(sources.getByRole("button", { name: "Saved to memory" })).toBeDisabled();
  expect(await page.evaluate(() => JSON.stringify(localStorage)).then((text) => text.includes("Research on 2026-11-19"))).toBe(true);
});

test("“research X and make a deck” in one message, then a change to it", async ({ page }) => {
  const calls = await studio(page);
  await send(page, "Research what changed in Rust 1.95 and create a 6-slide presentation");
  const card = page.getByRole("article", { name: "Rust 1.95.pptx" });
  await expect(card).toContainText("PowerPoint · 1 KB · 6 slides");
  await expect(page.getByText(/I wrote this up from the 2 sources I read: Rust 1\.95\.pptx \(6 slides\)/)).toBeVisible();
  await expect(page.getByRole("region", { name: /^Sources for:/ })).toBeVisible();
  expect(calls.research).toHaveLength(1);
  expect(calls.compose[0]).toMatchObject({ formats: ["pptx"], request: "Research what changed in Rust 1.95 and create a 6-slide presentation" });
  expect(calls.compose[0].context.research.id).toBe(research.id);

  await send(page, "Make it more professional");
  await expect(page.getByText(/Done\. I rewrote “What changed”\. Everything else is as it was/)).toBeVisible();
  expect(calls.compose[1].base.sections[0].heading).toBe("What changed");
  expect(calls.research).toHaveLength(1);
});

test("an attached file is read, shown with how much was read, and turned into a workbook", async ({ page }) => {
  const calls = await studio(page);
  await page.getByLabel("Attach files").setInputFiles({ name: "sales.csv", mimeType: "text/csv", buffer: Buffer.from("Month,Revenue\nJan,10\nFeb,12\nMar,9\n") });
  const attached = page.getByRole("list", { name: "Attached files" });
  await expect(attached).toContainText("sales.csv");
  await expect(attached).toContainText("3/3 rows · 1 table");
  expect(Buffer.from(calls.read[0].data, "base64").toString()).toBe("Month,Revenue\nJan,10\nFeb,12\nMar,9\n");

  await send(page, "Analyze this data, calculate monthly growth and build an Excel dashboard");
  const card = page.getByRole("article", { name: "Sales analysis.xlsx" });
  await expect(card).toContainText("Excel · 1 KB · 2 sheets · 14 formulas · 1 chart");
  expect(calls.compose[0].formats).toEqual(["xlsx"]);
  expect(calls.compose[0].context.files[0]).toMatchObject({ name: "sales.csv", tables: [{ columns: ["Month", "Revenue"], rows: [["Jan", 10], ["Feb", 12], ["Mar", 9]] }] });
  // What the Studio left out is passed on, not hidden.
  await expect(page.getByText("Left out — chart “Bad chart” on Sales")).toBeVisible();
  expect(calls.research).toHaveLength(0);

  await attached.getByRole("button", { name: "Remove sales.csv" }).click();
  await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
});

test("the library keeps the files and the research on this device, across a reload, until deleted", async ({ page }) => {
  await studio(page);
  await send(page, "Research what changed in Rust 1.95 and create a 6-slide presentation");
  await expect(page.getByRole("article", { name: "Rust 1.95.pptx" })).toBeVisible();
  await page.reload();
  // The chat still shows the file and the sources after a reload.
  await expect(page.getByRole("article", { name: "Rust 1.95.pptx" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Sources for:/ })).toBeVisible();

  await page.getByRole("button", { name: "Library" }).click();
  const library = page.getByRole("dialog", { name: "Library" });
  await expect(library.getByRole("article", { name: "Rust 1.95.pptx" })).toBeVisible();
  await library.getByRole("tab", { name: "Research" }).click();
  await library.getByRole("button", { name: /^Research what changed in Rust 1\.95/ }).click();
  await expect(library).toContainText("Rust 1.95 stabilizes async closures in traits");
  await expect(library.getByRole("link", { name: "Source 1: Announcing Rust 1.95.0" }).first()).toBeVisible();
  await library.getByRole("button", { name: "← All research" }).click();
  await library.getByRole("button", { name: /^Delete research:/ }).click();
  await expect(library).toContainText("No research yet.");
  await library.getByRole("tab", { name: "Files" }).click();
  await library.getByRole("button", { name: "Delete Rust 1.95.pptx" }).click();
  await expect(library).toContainText("No files yet.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Library" })).toHaveCount(0);
  // The chat says so honestly once the file is gone.
  await expect(page.getByText("This file is no longer on this device.")).toBeVisible();
});

test("after a reload the conversation still knows its last file, so a change request revises it", async ({ page }) => {
  const calls = await studio(page);
  await send(page, "Create a presentation about what changed in Rust 1.95");
  await expect(page.getByRole("article", { name: "Rust 1.95.pptx" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("article", { name: "Rust 1.95.pptx" })).toBeVisible();
  await send(page, "Change the theme and shorten the first slide");
  await expect(page.getByText(/Done\. I rewrote “What changed”/)).toBeVisible();
  // The second request carried the first document's description: it was revised, not written again from nothing.
  expect(calls.compose).toHaveLength(2);
  expect(calls.compose[1].base.title).toBe("Rust 1.95");
  expect(calls.agent).toBe(0);
});

test("when research can't be done, the reply says so and shows no sources", async ({ page }) => {
  await studio(page);
  await page.unroute(/\/(api|v1)\//);
  await page.route(/\/(api|v1)\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/research") return route.fulfill(sse([{ type: "search", query: "x", provider: "Groq browser search", state: "failed", error: "rate limited" }, { type: "result", result: { ...research, answer: "I couldn't research this: none of the 1 searches could run (rate limited). Nothing below is from the web, so I'm not answering from memory as if it were.", sources: [], failed: [], findings: [], followUps: [], quality: { ...research.quality, grounded: false } } }]));
    if (path === "/api/health") return route.fulfill({ json: { status: "ok", provider: "Groq", ready: true } });
    if (path === "/api/models") return route.fulfill({ json: { provider: "Groq", defaultModel: "openai/gpt-oss-120b", models: ["openai/gpt-oss-120b"] } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.getByRole("button", { name: "Search the web" }).click();
  await send(page, "What happened in the markets today?");
  await expect(page.getByText(/I couldn't research this: none of the 1 searches could run \(rate limited\)/)).toBeVisible();
  await expect(page.getByRole("region", { name: /^Sources for:/ })).toHaveCount(0);
  await expect(page.getByText("no longer in this device's history")).toHaveCount(0);
});
