/** Drafting a workflow from a description: what the AI tends to get wrong is put right before the editor opens it. */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { draftFromText, normalizeDays } = require("./workflows/router");

const aiReturning = (draft) => ({ ai: async () => ({ text: JSON.stringify(draft) }) });

test("day names become the schedule's day numbers", () => {
  assert.deepEqual(normalizeDays(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]), [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeDays("sat, sun"), [0, 6]);
  assert.deepEqual(normalizeDays([1, 3, "5", 7, "Funday"]), [0, 1, 3, 5]);
});

test("a draft's invented model becomes Auto, its days numbers, and a placeholder address is cleared with a note", async () => {
  const result = await draftFromText(aiReturning({
    name: "Tech news",
    notes: "Runs on weekdays.",
    nodes: [
      { id: "t", name: "Start", type: "trigger.schedule", params: { mode: "weekly", days: ["Monday", "Friday"], time: "09:00" } },
      { id: "f", name: "FetchNews", type: "action.http", params: { method: "GET", url: "https://example.com/api/news" } },
      { id: "s", name: "Summarize", type: "ai.prompt", params: { model: "gpt-4o-mini", prompt: "Summarize {{ json($json) }}" } },
      { id: "k", name: "Keep", type: "ai.prompt", params: { model: "groq:openai/gpt-oss-20b", prompt: "x" } },
    ],
    connections: [{ source: "t", target: "f", sourceOutput: "main", targetInput: "main" }, { source: "f", target: "s", sourceOutput: "main", targetInput: "main" }],
  }), "weekday tech news", "UTC");
  const byName = Object.fromEntries(result.definition.nodes.map((node) => [node.name, node.params]));
  assert.deepEqual(byName.Start.days, [1, 5]);
  assert.equal(byName.FetchNews.url, "");
  assert.equal(byName.Summarize.model, "auto");
  assert.equal(byName.Keep.model, "groq:openai/gpt-oss-20b");
  assert.match(result.notes, /Runs on weekdays\. Set the address in FetchNews/);
});

test("the drafting prompt offers web search and forbids invented addresses", async () => {
  let seen;
  await draftFromText({ ai: async (request) => { seen = request; return { text: JSON.stringify({ name: "x", nodes: [{ id: "t", name: "Start", type: "trigger.manual", params: {} }], connections: [] }) }; } }, "news", "UTC");
  assert.match(seen.prompt, /web\.search: Search the web/);
  assert.match(seen.system, /Never invent web addresses/);
  assert.match(seen.prompt, /0=Sunday … 6=Saturday/);
});
