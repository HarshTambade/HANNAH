// The hannah CLI against the real server (node server/index.js, SQLite account
// database). The model API is a local OpenAI-compatible stand-in, which
// streams its answer; everything else is HANNAH's real code. A visitor's Groq
// key may only go to Groq's real API (the server enforces that), so chat is
// exercised with the operator token and the server's own (custom) provider.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..", "server");
const work = mkdtempSync(join(tmpdir(), "hannah-cli-"));
const config = join(work, "config.json");
const GROQ_KEY = "gsk_cliTestKey0123456789abcdefghijklmn";
const OPERATOR = "cli-operator-token-0123456789abcdefghijklmnopqrstu";
const seen = [];
let fake;
let server;
let base;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "openai/gpt-oss-120b" }, { id: "llama-3.3-70b-versatile" }] })); }
      const request = JSON.parse(body || "{}");
      seen.push({ auth: req.headers.authorization, messages: request.messages, stream: request.stream });
      const last = request.messages.at(-1).content;
      const answer = /2\+2/.test(last) ? "It's 4." : request.messages.length > 2 ? `You said ${request.messages.filter((m) => m.role === "user").length} things.` : "Hello from HANNAH.";
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of answer.match(/.{1,4}/g)) res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", model: request.model, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
    });
  });
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const port = 5100 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: "development", PORT: String(port), HOST: "127.0.0.1", HANNAH_API_TOKEN: OPERATOR, GROQ_API_KEY: "", GROQ_API_URL: `http://127.0.0.1:${fake.address().port}/openai/v1`, CUSTOM_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, CUSTOM_API_KEY: "stand-in-key", CUSTOM_MODEL: "stand-in-model", HANNAH_DEFAULT_PROVIDER: "custom", DATABASE_URL: `sqlite:${join(work, "hannah.db")}`, HANNAH_VAULT_KEY: "d".repeat(64), POSTGRES_URL: "" };
  server = spawn(process.execPath, ["index.js"], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (chunk) => { log += chunk; });
  server.stderr.on("data", (chunk) => { log += chunk; });
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`The server didn't start.\n${log.slice(-1500)}`);
});
after(() => { server?.kill("SIGKILL"); fake?.close(); rmSync(work, { recursive: true, force: true }); });

function cli(args, { input } = {}) {
  return new Promise((done) => {
    const child = execFile(process.execPath, [join(here, "hannah.mjs"), ...args], { env: { ...process.env, HANNAH_CONFIG: config }, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

test("login with a Groq key or a token: the key is sent but never printed; chat and questions stream through the server", async () => {
  assert.match((await cli(["login", "--server", base, "--groq-key", "not-a-key"])).stderr, /isn't a Groq key/);
  const login = await cli(["login", "--server", base, "--groq-key", GROQ_KEY]);
  assert.equal(login.code, 0, login.stderr);
  assert.ok(!login.stdout.includes(GROQ_KEY), "the key isn't printed");
  assert.equal(statSync(config).mode & 0o777, 0o600, "the config is readable only by you");

  // The server recognised the key (sent as x-groq-api-key) and refused to send it anywhere but Groq.
  assert.match((await cli(["ask", "hi"])).stderr, /official Groq API endpoint/);
  const groqStatus = await cli(["status"]);
  assert.match(groqStatus.stdout, /Using a Groq key \(gsk_…klmn\)/);
  assert.ok(!groqStatus.stdout.includes(GROQ_KEY));
  assert.match((await cli(["workflows"])).stderr, /only unlocks chat/);

  const token = await cli(["login", "--server", base, "--token", OPERATOR]);
  assert.equal(token.code, 0, token.stderr);
  assert.ok(!token.stdout.includes(OPERATOR));
  const ask = await cli(["ask", "What's", "2+2?"]);
  assert.equal(ask.code, 0, ask.stderr);
  assert.equal(ask.stdout.trim(), "It's 4.");
  assert.equal(seen.at(-1).auth, "Bearer stand-in-key", "the server called its provider with its own key");
  assert.equal(seen.at(-1).stream, true, "streamed end to end");

  const chat = await cli(["chat"], { input: "hello\nand again\n/clear\nonce more\n/exit\n" });
  assert.equal(chat.code, 0, chat.stderr);
  assert.match(chat.stdout, /hannah › Hello from HANNAH\./);
  assert.match(chat.stdout, /hannah › You said 2 things\./, "the second turn carries the first");
  assert.match(chat.stdout, /\(started over\)\nhannah › Hello from HANNAH\./, "/clear forgets the conversation");

  assert.match((await cli(["status"])).stdout, /Server: .* up/);
});

test("login with an account: workflows run and are followed step by step; chat apps are listed", async () => {
  const registered = await fetch(`${base}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json", "x-hannah-session": "bearer" }, body: JSON.stringify({ email: "cli@example.com", password: "correct horse battery staple" }) });
  const session = (await registered.json()).sessionToken;
  assert.match((await cli(["login", "--server", base, "--email", "cli@example.com"], { input: "wrong password\n" })).stderr, /\S/);
  const login = await cli(["login", "--server", base, "--email", "cli@example.com", "--password-stdin"], { input: "correct horse battery staple\n" });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stdout, /Signed in to .* as cli@example\.com/);
  const saved = JSON.parse(readFileSync(config, "utf8"));
  assert.equal(saved.kind, "session");
  assert.ok(!login.stdout.includes(saved.secret));

  assert.match((await cli(["status"])).stdout, /Signed in as cli@example\.com\.\nDatabase: ready/);
  assert.equal((await cli(["workflows"])).stdout.trim(), "No workflows yet.");
  const definition = { format: "hannah-workflow", version: 2, nodes: [{ id: "t", name: "Start", type: "trigger.manual", params: {}, position: { x: 0, y: 0 } }, { id: "s", name: "Say hello", type: "data.set", params: { fields: [{ name: "greeting", value: "hello" }] }, position: { x: 260, y: 0 } }], connections: [{ id: "t-s", source: "t", target: "s", sourceOutput: "main", targetInput: "main" }], settings: { timezone: "UTC" } };
  const created = await (await fetch(`${base}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` }, body: JSON.stringify({ name: "CLI check", definition }) })).json();
  const id = created.workflow.id;
  assert.match((await cli(["workflows"])).stdout, new RegExp(`${id}\\s+inactive\\s+CLI check`));
  const run = await cli(["run", id]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /Started ex_/);
  assert.match(run.stdout, /done\s+Start/);
  assert.match(run.stdout, /done\s+Say hello/);
  assert.match(run.stdout, /completed\s*$/);
  assert.equal((await cli(["channels"])).stdout.trim(), "No chat apps connected.");
  assert.match((await cli(["run", "wf_missing"])).stderr, /\S/);
  assert.equal((await cli(["nonsense"])).code, 1);
  assert.equal((await cli(["logout"])).code, 0);
  assert.match((await cli(["workflows"])).stderr, /Not signed in/);
});
