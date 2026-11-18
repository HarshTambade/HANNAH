#!/usr/bin/env node
/**
 * hannah: HANNAH from the terminal. No dependencies; Node 20+.
 *
 *   hannah login [--server URL] (--groq-key KEY | --email EMAIL [--password-stdin] | --token TOKEN)
 *   hannah logout
 *   hannah status
 *   hannah ask "question"          one answer, streamed
 *   hannah chat                    a conversation (/clear starts over, /exit or Ctrl+D leaves)
 *   hannah workflows               your workflows
 *   hannah run <workflowId> [--published]   run one and follow its steps
 *   hannah channels                your chat apps
 *
 * Credentials: a Groq key (sent as x-groq-api-key, chat only), an account
 * session from email and password (POST /api/account/login), or a developer
 * key / operator token (Bearer). They're kept in ~/.config/hannah/config.json
 * (or $HANNAH_CONFIG) with permissions 0600, and never printed.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";

const DEFAULT_SERVER = "https://hannah.eliteforums.in";
const configPath = () => process.env.HANNAH_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hannah", "config.json");
const out = (text = "") => process.stdout.write(`${text}\n`);
class CliError extends Error {}
const fail = (message) => { throw new CliError(message); };

function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return null; }
}
function writeConfig(config) {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
const hint = (secret) => (secret ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : "");

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

function headersFor(config, { chat = false } = {}) {
  if (!config) fail("Not signed in. Run: hannah login");
  if (config.kind === "groq") {
    if (!chat) fail("A Groq key only unlocks chat. Sign in with your HANNAH account (hannah login --email …) for workflows and chat apps.");
    return { "x-groq-api-key": config.secret };
  }
  return { Authorization: `Bearer ${config.secret}` };
}

async function request(config, method, path, { body, chat = false, auth = true, stream = false } = {}) {
  const base = (config?.server || DEFAULT_SERVER).replace(/\/$/, "");
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(auth ? headersFor(config, { chat }) : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(stream ? 300_000 : 60_000),
    });
  } catch (error) {
    fail(`Couldn't reach ${base}: ${error.cause?.code || error.message}`);
  }
  if (stream && response.ok) return response;
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  if (!response.ok) fail(data.error?.message || data.error || `The server answered ${response.status}.`);
  return data;
}

/** Stream a chat completion, printing it as it arrives. Returns the full text. */
async function complete(config, messages, write = (text) => process.stdout.write(text)) {
  const response = await request(config, "POST", "/v1/chat/completions", { body: { model: "auto", messages, stream: true }, chat: true, stream: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (payload.error) fail(payload.error.message || "The model failed.");
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) { text += delta; write(delta); }
      }
    }
  }
  return text;
}

async function readSecretLine(prompt) {
  if (!process.stdin.isTTY) {
    // --password-stdin: the first line of standard input.
    let data = "";
    for await (const chunk of process.stdin) { data += chunk; if (data.includes("\n")) break; }
    return data.split(/\r?\n/)[0];
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => { if (text.includes(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const commands = {
  async login({ flags }) {
    const server = String(flags.server || readConfig()?.server || DEFAULT_SERVER).replace(/\/$/, "");
    if (!/^https?:\/\//.test(server)) fail("--server must be an http(s) address.");
    if (flags["groq-key"]) {
      const key = String(flags["groq-key"]).trim();
      if (!/^gsk_[A-Za-z0-9]{20,200}$/.test(key)) fail("That isn't a Groq key (it starts with gsk_).");
      writeConfig({ server, kind: "groq", secret: key });
      return out(`Saved a Groq key (${hint(key)}) for ${server}. It unlocks chat; sign in with --email for workflows and chat apps.`);
    }
    if (flags.token) {
      const token = String(flags.token).trim();
      writeConfig({ server, kind: "token", secret: token });
      const status = await request({ server, kind: "token", secret: token }, "GET", "/api/account/status");
      return out(`Saved the token for ${server}${status.user?.email ? ` (signed in as ${status.user.email})` : ""}.`);
    }
    if (flags.email) {
      const email = String(flags.email).trim();
      const password = flags.password ? fail("Don't put passwords on the command line; use --password-stdin or the prompt.") : await readSecretLine("Password: ");
      let response;
      try {
        response = await fetch(`${server}/api/account/login`, { method: "POST", headers: { "Content-Type": "application/json", "x-hannah-session": "bearer" }, body: JSON.stringify({ email, password }) });
      } catch (error) {
        fail(`Couldn't reach ${server}: ${error.cause?.code || error.message}`);
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.sessionToken) fail(data.error || `Sign-in failed (${response.status}).`);
      writeConfig({ server, kind: "session", secret: data.sessionToken, email: data.user?.email || email, expiresAt: data.expiresAt || null });
      return out(`Signed in to ${server} as ${data.user?.email || email}.`);
    }
    fail("Use one of: --groq-key gsk_…, --email you@example.com, or --token <developer key>.");
  },

  async logout() {
    rmSync(configPath(), { force: true });
    out("Signed out on this computer.");
  },

  async status() {
    const config = readConfig() || { server: DEFAULT_SERVER };
    const health = await request(config, "GET", "/api/health", { auth: false });
    out(`Server: ${config.server}  ${health.status === "ok" ? "up" : health.status}${health.provider ? ` · ${health.provider}` : ""}`);
    if (!config.kind) return out("Not signed in. Run: hannah login");
    if (config.kind === "groq") return out(`Using a Groq key (${hint(config.secret)}) for chat.`);
    const account = await request(config, "GET", "/api/account/status", { auth: true });
    out(account.user?.email ? `Signed in as ${account.user.email}.` : "Signed in with a token.");
    out(`Database: ${account.database?.configured ? (account.database.ready ? "ready" : "not ready") : "not configured"}${account.vault === false ? " · vault key missing" : ""}`);
  },

  async ask({ positional }) {
    const question = positional.join(" ").trim();
    if (!question) fail('Ask something: hannah ask "What can you do?"');
    await complete(readConfig(), [{ role: "user", content: question }]);
    out();
  },

  async chat() {
    const config = readConfig();
    headersFor(config, { chat: true });
    out("HANNAH chat · /clear starts over · /exit leaves");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    const history = [];
    const prompt = () => { if (process.stdin.isTTY) rl.setPrompt("you › "), rl.prompt(); };
    prompt();
    for await (const line of rl) {
      const text = line.trim();
      if (text === "/exit" || text === "/quit") break;
      if (text === "/clear") { history.length = 0; out("(started over)"); prompt(); continue; }
      if (!text) { prompt(); continue; }
      history.push({ role: "user", content: text });
      process.stdout.write("hannah › ");
      try {
        const reply = await complete(config, history.slice(-20));
        history.push({ role: "assistant", content: reply });
      } catch (error) {
        history.pop();
        process.stdout.write(`(${error.message})`);
      }
      out();
      prompt();
    }
    rl.close();
  },

  async workflows() {
    const { workflows } = await request(readConfig(), "GET", "/api/workflows");
    if (!workflows.length) return out("No workflows yet.");
    for (const workflow of workflows) out(`${workflow.id}  ${workflow.active ? "active  " : "inactive"}  ${workflow.name}${workflow.lastRun ? `  · last run ${workflow.lastRun.status}` : ""}`);
  },

  async run({ positional, flags }) {
    const id = positional[0];
    if (!id) fail("Which workflow? hannah run <workflowId> (see hannah workflows)");
    const config = readConfig();
    const { executionId } = await request(config, "POST", `/api/workflows/${encodeURIComponent(id)}/run`, { body: { draft: !flags.published } });
    out(`Started ${executionId}`);
    const shown = new Map();
    const until = Date.now() + 15 * 60_000;
    while (Date.now() < until) {
      const detail = await request(config, "GET", `/api/workflows/executions/${encodeURIComponent(executionId)}`);
      for (const node of detail.nodes || []) {
        const line = `${node.status.padEnd(9)} ${node.name}${node.attempts > 1 ? ` (attempt ${node.attempts})` : ""}${node.error ? ` — ${node.error}` : ""}`;
        if (shown.get(node.nodeId) !== line) { shown.set(node.nodeId, line); out(`  ${line}`); }
      }
      const status = detail.execution?.status;
      if (["completed", "failed", "cancelled", "timed-out"].includes(status)) {
        out(`${status}${detail.execution.error ? `: ${detail.execution.error}` : ""}`);
        if (status !== "completed") process.exitCode = 1;
        return;
      }
      if (status === "waiting") out(`  waiting${detail.execution.waiting?.kind ? ` (${detail.execution.waiting.kind})` : ""}…`);
      await new Promise((resolve) => setTimeout(resolve, status === "waiting" ? 5000 : 1000));
    }
    fail("Still running after 15 minutes; check it in HANNAH → Workflows.");
  },

  async channels() {
    const { channels } = await request(readConfig(), "GET", "/api/channels");
    if (!channels.length) return out("No chat apps connected.");
    for (const channel of channels) out(`${(channel.label || channel.kind).padEnd(16)} ${channel.name}  ${channel.paired ? `paired with ${channel.pairedName}` : "not paired"}${channel.pending?.length ? `  · ${channel.pending.length} asking` : ""}`);
  },

  help() {
    out(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith(" *   hannah")).map((line) => line.slice(3)).join("\n"));
  },
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const name = positional.shift() || "help";
const command = commands[name] || (["-h", "--help"].includes(name) ? commands.help : null);
try {
  if (!command) fail(`Unknown command “${name}”. Run: hannah help`);
  await command({ positional, flags });
} catch (error) {
  process.stderr.write(`${error instanceof CliError ? error.message : `Something went wrong: ${error.message}`}\n`);
  process.exitCode = 1;
}
