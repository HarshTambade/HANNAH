const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "orchestrate-test-token-0123456789-abcdefghijk";
delete process.env.DATABASE_URL;

let planReply = "";
const prompts = [];
const fake = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const system = body.messages?.[0]?.role === "system" ? body.messages[0].content : "";
  prompts.push({ system, user: body.messages?.at(-1)?.content || "" });
  let content = "ok";
  if (system.includes("planner for HANNAH")) content = planReply;
  if (system.includes("verification agent")) {
    content = body.messages.at(-1).content.includes("WRONG")
      ? JSON.stringify({ verdict: "revise", issues: ["s2 contradicts s1"], revise: [{ stepId: "s2", feedback: "Recheck the date." }, { stepId: "s9", feedback: "unknown" }], reply: "Draft", emotion: "thinking" })
      : JSON.stringify({ verdict: "pass", issues: [], reply: "Here's your plan for Pune.", emotion: "happy" });
  }
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
});

let server;
let baseUrl;
const headers = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}`, "Content-Type": "application/json" };
const agents = [
  { id: "research", name: "Research", description: "Finds and explains information." },
  { id: "coding", name: "Coding", description: "Writes and reviews code." },
  { id: "tasks", name: "Tasks", description: "Reminders and device actions." },
];

before(async () => {
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.CUSTOM_MODEL = "test-model";
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fake.close();
});

const post = (body) => fetch(`${baseUrl}/api/orchestrate`, { method: "POST", headers, body: JSON.stringify({ provider: "custom", ...body }) });

test("validatePlan keeps known agents, renumbers steps and drops forward or unknown dependencies", () => {
  const { validatePlan } = require("./orchestrate");
  const steps = validatePlan({ steps: [
    { id: "a", agent: "research", task: "Find train times", dependsOn: ["b"] },
    { id: "b", agent: "hacker", task: "Do something else" },
    { id: "c", agent: "tasks", task: "Set a reminder", dependsOn: ["a", "zzz"] },
  ] }, agents);
  assert.deepEqual(steps, [
    { id: "s1", agent: "research", task: "Find train times", dependsOn: [] },
    { id: "s3", agent: "tasks", task: "Set a reminder", dependsOn: ["s1"] },
  ]);
});

test("plan returns validated parallel steps from the model", async () => {
  planReply = "```json\n" + JSON.stringify({ summary: "Trip prep", steps: [
    { id: "s1", agent: "research", task: "Weekend weather in Pune" },
    { id: "s2", agent: "research", task: "Train options Mumbai to Pune" },
    { id: "s3", agent: "tasks", task: "Remind me Friday 6pm to pack", dependsOn: ["s1", "s2"] },
  ] }) + "\n```";
  const response = await post({ phase: "plan", task: "Plan my weekend trip to Pune and remind me to pack", agents });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.fallback, false);
  assert.equal(body.steps.length, 3);
  assert.deepEqual(body.steps[2].dependsOn, ["s1", "s2"]);
  assert.match(prompts.at(-1).system, /- research: Finds and explains information\./);
});

test("an unusable plan falls back to a single step", async () => {
  planReply = "I can't plan this";
  const body = await post({ phase: "plan", task: "Fix this python bug please", agents }).then((r) => r.json());
  assert.equal(body.fallback, true);
  assert.deepEqual(body.steps, [{ id: "s1", agent: "coding", task: "Fix this python bug please", dependsOn: [] }]);
});

test("verify passes or asks to revise only known steps", async () => {
  const results = [{ stepId: "s1", agent: "research", task: "Weather", output: "Sunny" }, { stepId: "s2", agent: "research", task: "Trains", output: "WRONG date" }];
  const revise = await post({ phase: "verify", task: "Plan my trip", agents, results }).then((r) => r.json());
  assert.equal(revise.verdict, "revise");
  assert.deepEqual(revise.revise, [{ stepId: "s2", feedback: "Recheck the date." }]);
  assert.match(prompts.at(-1).user, /untrusted data/);

  const pass = await post({ phase: "verify", task: "Plan my trip", agents, results: [results[0]] }).then((r) => r.json());
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.reply, "Here's your plan for Pune.");
  assert.equal(pass.emotion, "happy");
});

test("bad input is rejected", async () => {
  assert.equal((await post({ phase: "dance", task: "x", agents })).status, 400);
  assert.equal((await post({ phase: "plan", task: "x", agents: [{ id: "BAD ID", description: "x" }] })).status, 400);
  assert.equal((await post({ phase: "verify", task: "x", agents })).status, 400);
});

test("/api/agent honors a specialist's route hint for auto", async () => {
  const tool = [{ type: "function", function: { name: "get_time", description: "Time", parameters: { type: "object", properties: {} } } }];
  const body = await fetch(`${baseUrl}/api/agent`, { method: "POST", headers, body: JSON.stringify({ provider: "custom", model: "auto", routeHint: "complex", messages: [{ role: "user", content: "hi" }], tools: tool }) }).then((r) => r.json());
  assert.equal(body.routing.level, "complex");
  assert.ok(body.routing.reasons.some((reason) => reason.includes("specialist")));
});
