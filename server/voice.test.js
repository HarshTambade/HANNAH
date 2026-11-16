const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "voice-test-token-0123456789-abcdefghijklmnopq";
delete process.env.DATABASE_URL;
process.env.GROQ_API_KEY = "gsk_servertestkey0123456789abcdef";
process.env.OPENAI_API_KEY = "sk-server-openai-test";

const seen = [];
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], raw });
  if (req.url.endsWith("/audio/transcriptions")) return res.end(JSON.stringify({ text: " hello hannah " }));
  if (req.url.endsWith("/audio/speech")) { res.setHeader("Content-Type", "audio/mpeg"); return res.end(Buffer.from("ID3fake-mp3-bytes")); }
  res.end("{}");
});

let server;
let baseUrl;
const operator = { Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}` };

before(async () => {
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const url = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.GROQ_API_URL = url;
  process.env.OPENAI_BASE_URL = url;
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fake.close();
});

test("providers report hosted engines the caller can use", async () => {
  const operatorView = await fetch(`${baseUrl}/api/voice/providers`, { headers: operator }).then((r) => r.json());
  assert.equal(operatorView.tts[0].available, true);
  assert.equal(operatorView.stt[0].available, true);
  assert.ok(operatorView.tts[0].voices.includes("coral"));
  const visitor = await fetch(`${baseUrl}/api/voice/providers`, { headers: { "X-Groq-API-Key": "gsk_visitorkey0123456789abcdefgh" } }).then((r) => r.json());
  assert.equal(visitor.tts[0].available, false, "a visitor's Groq key can't pay for OpenAI voices");
  // Groq points at a local fake here, and a visitor's key only ever goes to api.groq.com.
  assert.equal(visitor.stt[0].available, false);
});

test("transcribe forwards audio to Whisper", async () => {
  seen.length = 0;
  const audio = Buffer.alloc(2048, 7);
  const response = await fetch(`${baseUrl}/api/voice/transcribe?language=en`, { method: "POST", headers: { ...operator, "Content-Type": "audio/webm" }, body: audio });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.text, "hello hannah");
  assert.equal(seen[0].auth, "Bearer gsk_servertestkey0123456789abcdef");
  assert.match(seen[0].type, /multipart\/form-data/);
  const form = seen[0].raw.toString("latin1");
  assert.match(form, /whisper-large-v3-turbo/);
  assert.match(form, /name="language"\r\n\r\nen/);

  seen.length = 0;
  const visitor = await fetch(`${baseUrl}/api/voice/transcribe`, { method: "POST", headers: { "X-Groq-API-Key": "gsk_visitorkey0123456789abcdefgh", "Content-Type": "audio/webm" }, body: audio });
  assert.equal(visitor.status, 403);
  assert.equal(seen.length, 0, "the visitor's key never left the server");
});

test("transcribe rejects non-audio and empty recordings", async () => {
  assert.equal((await fetch(`${baseUrl}/api/voice/transcribe`, { method: "POST", headers: { ...operator, "Content-Type": "text/plain" }, body: "hi" })).status, 415);
  assert.equal((await fetch(`${baseUrl}/api/voice/transcribe`, { method: "POST", headers: { ...operator, "Content-Type": "audio/webm" }, body: Buffer.alloc(10) })).status, 400);
});

test("speak returns OpenAI audio and validates the voice", async () => {
  seen.length = 0;
  const response = await fetch(`${baseUrl}/api/voice/speak`, { method: "POST", headers: { ...operator, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi there", voice: "nova" }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "ID3fake-mp3-bytes");
  const sent = JSON.parse(seen[0].raw.toString());
  assert.equal(sent.voice, "nova");
  assert.equal(sent.model, "gpt-4o-mini-tts");
  assert.equal(seen[0].auth, "Bearer sk-server-openai-test");

  const visitor = await fetch(`${baseUrl}/api/voice/speak`, { method: "POST", headers: { "X-Groq-API-Key": "gsk_visitorkey0123456789abcdefgh", "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi" }) });
  assert.equal(visitor.status, 403);
});
