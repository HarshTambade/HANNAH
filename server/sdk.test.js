const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "sdk-test-token-0123456789-abcdefghijklmnopqrs";
delete process.env.DATABASE_URL;

const fake = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
  if (body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    for (const piece of ["Hel", "lo"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  const system = body.messages?.[0]?.role === "system" ? body.messages[0].content : "";
  const content = system.includes("A2A") ? JSON.stringify({ reply: "agent hi", emotion: "happy" }) : `echo:${body.messages.at(-1).content}`;
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
});

let server;
let Hannah;
let client;

before(async () => {
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  process.env.CUSTOM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.CUSTOM_MODEL = "test-model";
  process.env.HANNAH_DEFAULT_PROVIDER = "custom";
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  ({ Hannah } = await import("../sdk/js/index.js"));
  client = new Hannah({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: process.env.HANNAH_API_TOKEN });
});

after(() => {
  server?.close();
  fake.close();
});

test("the SDK chats, streams, lists models and reads usage", async () => {
  const result = await client.chat("hi there", { model: "custom/test-model" });
  assert.equal(result.text, "echo:hi there");
  let streamed = "";
  for await (const piece of client.stream("go", { model: "custom/test-model" })) streamed += piece;
  assert.equal(streamed, "Hello");
  assert.ok((await client.models()).some((model) => model.id === "hannah-auto"));
  assert.equal(typeof (await client.usage()).spentUsd, "number");
});

test("the SDK talks A2A and surfaces errors", async () => {
  assert.equal((await client.sendAgentMessage("hello")).text, "agent hi");
  const anonymous = new Hannah({ baseUrl: client.baseUrl });
  await assert.rejects(() => anonymous.chat("hi"), (error) => error.name === "HannahError" && error.status === 401);
});
