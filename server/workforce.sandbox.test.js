"use strict";
/**
 * A cloud computer's terminal under the host's sandbox, through the real API.
 * On macOS the driver is sandbox-exec; on Linux, bubblewrap when installed.
 * The escape tests run whichever driver this host has and are skipped (with
 * the reason) when it has none.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "workforce-sandbox-token-0123456789-abcdef";
process.env.DATABASE_URL = "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "f".repeat(64);
process.env.WORKFORCE_WORKER = "off";
process.env.HANNAH_WORKFORCE_EXTENDED_COMMANDS = "1";
process.env.HANNAH_WORKFORCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-sandbox-api-"));
delete process.env.HANNAH_WORKFORCE_SANDBOX;
delete process.env.POSTGRES_URL;

const sandbox = require("./workforce/sandbox");

let server;
let base;
let session;
let listener;
let held;

before(async () => {
  held = await sandbox.status();
  server = require("./index").listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}/api`;
  session = (await (await fetch(`${base}/account/register`, { method: "POST", headers: { "Content-Type": "application/json", "x-hannah-session": "bearer" }, body: JSON.stringify({ email: "sandbox@example.com", password: "correct horse battery staple" }) })).json()).sessionToken;
  listener = net.createServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
  await once(listener, "listening");
});

after(async () => {
  delete process.env.HANNAH_WORKFORCE_SANDBOX;
  sandbox.resetForTests();
  server?.close();
  listener?.close();
  await require("./db").resetDatabase();
  fs.rmSync(process.env.HANNAH_WORKFORCE_DIR, { recursive: true, force: true });
});

const api = async (method, route, body) => {
  const response = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const SCRIPT = `
const fs = require("fs"), net = require("net");
const [other, outside, port] = process.argv.slice(2);
const out = {};
const tryIt = (name, action) => { try { action(); out[name] = "ok"; } catch (error) { out[name] = error.code || "error"; } };
tryIt("writeInside", () => fs.writeFileSync("made-here.txt", "x"));
tryIt("readOther", () => fs.readFileSync(other, "utf8"));
tryIt("writeOutside", () => fs.writeFileSync(outside, "x"));
const socket = net.connect(Number(port), "127.0.0.1");
const done = (value) => { out.network = value; console.log(JSON.stringify(out)); process.exit(0); };
socket.on("connect", () => done("ok"));
socket.on("error", (error) => done(error.code || "error"));
setTimeout(() => done("timeout"), 3000);
`;

async function escapeAttempt() {
  const mine = (await api("POST", "/workforce/computers", { name: "Mine", kind: "cloud" })).body.computer;
  const theirs = (await api("POST", "/workforce/computers", { name: "Another", kind: "cloud" })).body.computer;
  await api("PUT", `/workforce/computers/${theirs.id}/files`, { path: "secret.txt", content: "another workspace's secret" });
  const files = fs.readdirSync(process.env.HANNAH_WORKFORCE_DIR, { recursive: true }).map(String);
  const other = path.join(process.env.HANNAH_WORKFORCE_DIR, files.find((file) => file.endsWith("secret.txt")));
  const outside = path.join(process.env.HANNAH_WORKFORCE_DIR, `escaped-${Date.now()}.txt`);
  // Arguments are one line of up to 500 characters, so the script is a file in the workspace.
  assert.equal((await api("PUT", `/workforce/computers/${mine.id}/files`, { path: "escape.js", content: SCRIPT })).status, 200);
  const ran = await api("POST", `/workforce/computers/${mine.id}/terminal`, { command: "node", args: ["escape.js", other, outside, String(listener.address().port)] });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  if (!ran.body.result.stdout.trim()) throw new Error(`No output: ${JSON.stringify(ran.body.result)}`);
  return { result: ran.body.result, checks: JSON.parse(ran.body.result.stdout.trim()), outsideExists: fs.existsSync(outside) };
}

test("the host's sandbox is checked before it's used, and the capabilities say what holds", async () => {
  const caps = (await api("GET", "/workforce/computers/capabilities")).body;
  assert.deepEqual(caps.sandbox, held);
  if (process.platform === "darwin") {
    assert.equal(held.driver, "sandbox-exec", JSON.stringify(held));
    assert.deepEqual(held.checks, { writeInside: "ok", writeOutside: "EPERM", readOther: "EPERM", readServer: "EPERM", listOthers: "EPERM", network: "EPERM" });
    assert.equal(caps.isolation, "workspace-directory + sandbox-exec");
  }
  if (!held.driver) assert.match(caps.note, /aren't sandboxed/);
});

test("under the sandbox a command can't read another workspace, write outside its own, or reach the network", async (t) => {
  if (!held.driver) return t.skip(`no sandbox driver on this host: ${held.reason}`);
  const { result, checks, outsideExists } = await escapeAttempt();
  assert.equal(result.sandbox, held.driver);
  assert.equal(checks.writeInside, "ok");
  assert.notEqual(checks.readOther, "ok");
  assert.notEqual(checks.writeOutside, "ok");
  assert.notEqual(checks.network, "ok");
  assert.equal(outsideExists, false);
});

test("the same command without a sandbox does reach them, which is what the sandbox prevents", async () => {
  process.env.HANNAH_WORKFORCE_SANDBOX = "off";
  sandbox.resetForTests();
  const { result, checks, outsideExists } = await escapeAttempt();
  assert.equal(result.sandbox, null);
  assert.deepEqual([checks.readOther, checks.writeOutside, checks.network], ["ok", "ok", "ok"]);
  assert.equal(outsideExists, true);
  delete process.env.HANNAH_WORKFORCE_SANDBOX;
  sandbox.resetForTests();
});

test("a required sandbox that isn't working refuses commands instead of running them unsandboxed", async () => {
  process.env.HANNAH_WORKFORCE_SANDBOX = process.platform === "linux" ? "sandbox-exec" : "bwrap";
  sandbox.resetForTests();
  const mine = (await api("POST", "/workforce/computers", { name: "Strict", kind: "cloud" })).body.computer;
  const refused = await api("POST", `/workforce/computers/${mine.id}/terminal`, { command: "pwd" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.reason, "sandbox-unavailable");
  delete process.env.HANNAH_WORKFORCE_SANDBOX;
  sandbox.resetForTests();
});

test("bubblewrap's arguments: new namespaces, read-only system, the workspace the only writable bind", () => {
  const args = sandbox.bwrapArgs({ workspace: "/srv/ws/a", cwd: "/srv/ws/a/src", program: "/usr/bin/ls", args: ["-la"], env: { PATH: "/usr/bin", HOME: "/srv/ws/a/.hannah/home" } });
  assert.ok(args.includes("--unshare-all") && args.includes("--die-with-parent") && args.includes("--clearenv"));
  const binds = args.flatMap((arg, index) => (arg === "--bind" ? [[args[index + 1], args[index + 2]]] : []));
  assert.deepEqual(binds, [["/srv/ws/a", "/workspace"]]);
  assert.equal(args[args.indexOf("--chdir") + 1], "/workspace/src");
  assert.equal(args[args.indexOf("HOME") + 1], "/workspace/.hannah/home");
  assert.deepEqual(args.slice(-3), ["--", "/usr/bin/ls", "-la"]);
  assert.ok(!args.includes("--share-net"));
  const profile = sandbox.seatbeltProfile({ workspace: "/w/a", root: "/w", hidden: ["/srv/app"] });
  assert.ok(profile.indexOf("(deny file-read*") < profile.indexOf('(allow file-read* (subpath "/w/a"))'), "the workspace allow comes after the deny");
});
