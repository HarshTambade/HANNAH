const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "accounts-test-token-0123456789-abcdefghijklmnop";
const pglite = process.env.HANNAH_TEST_DB === "pglite";
process.env.DATABASE_URL = pglite ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "a".repeat(64);
process.env.HANNAH_DAILY_BUDGET_USD = "";

// A fake hosted provider over HTTPS with a throwaway self-signed certificate,
// so stored keys go through the same HTTPS-only path as in production.
let openssl = true;
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-accounts-"));
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
} catch {
  openssl = false;
}
const seenKeys = [];
let fake;
let server;
let baseUrl;

before(async () => {
  if (openssl) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    fake = https.createServer({ key: fs.readFileSync(path.join(certDir, "key.pem")), cert: fs.readFileSync(path.join(certDir, "cert.pem")) }, async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
      seenKeys.push(key);
      if (key.endsWith("bad")) { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: "invalid key" } })); }
      if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
      const body = JSON.parse(raw || "{}");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `stored-key-reply:${body.messages.at(-1).content}` } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));
    });
    fake.listen(0, "localhost");
    await once(fake, "listening");
    process.env.OPENAI_BASE_URL = `https://localhost:${fake.address().port}/v1`;
  }
  if (pglite) await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  fake?.close();
  await require("./db").resetDatabase();
  fs.rmSync(certDir, { recursive: true, force: true });
});

const json = { "Content-Type": "application/json" };
const operator = { ...json, Authorization: `Bearer ${process.env.HANNAH_API_TOKEN}` };
const tool = [{ type: "function", function: { name: "get_time", description: "Time", parameters: { type: "object", properties: {} } } }];

function cookieFrom(response) {
  const header = response.headers.get("set-cookie") || "";
  return header.split(";")[0];
}

async function register(email, password = "correct horse battery") {
  const response = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: json, body: JSON.stringify({ email, password, displayName: "Test" }) });
  return { response, body: await response.json(), cookie: cookieFrom(response) };
}

test("vault round-trips, binds to the owner and rotates keys", () => {
  const vault = require("./vault");
  const sealed = vault.encryptSecret("sk-secret-value-1234", { userId: "u1", providerId: "openai" });
  assert.notEqual(sealed.ciphertext.includes("secret"), true);
  assert.equal(vault.decryptSecret({ key_id: sealed.keyId, wrapped_key: sealed.wrappedKey, ciphertext: sealed.ciphertext }, { userId: "u1", providerId: "openai" }).secret, "sk-secret-value-1234");
  assert.throws(() => vault.decryptSecret({ key_id: sealed.keyId, wrapped_key: sealed.wrappedKey, ciphertext: sealed.ciphertext }, { userId: "u2", providerId: "openai" }));
  assert.equal(vault.secretHint("sk-secret-value-1234"), "sk-…1234");

  const original = process.env.HANNAH_VAULT_KEY;
  process.env.HANNAH_VAULT_PREVIOUS_KEYS = original;
  process.env.HANNAH_VAULT_KEY = "b".repeat(64);
  try {
    const opened = vault.decryptSecret({ key_id: sealed.keyId, wrapped_key: sealed.wrappedKey, ciphertext: sealed.ciphertext }, { userId: "u1", providerId: "openai" });
    assert.equal(opened.secret, "sk-secret-value-1234");
    assert.equal(opened.rewrap, true);
  } finally {
    process.env.HANNAH_VAULT_KEY = original;
    delete process.env.HANNAH_VAULT_PREVIOUS_KEYS;
  }
});

test("database URLs are recognized by provider", () => {
  const { detectProvider, parseDatabaseUrl, redact } = require("./db");
  assert.equal(detectProvider("postgresql://u:p@db.abcd.supabase.co:5432/postgres"), "supabase");
  assert.equal(detectProvider("postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), "supabase");
  assert.equal(detectProvider("postgres://u:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb?sslmode=require"), "neon");
  assert.equal(parseDatabaseUrl("sqlite:./data/hannah.db").kind, "sqlite");
  assert.throws(() => parseDatabaseUrl("mysql://x"), /postgres/);
  assert.equal(redact("postgres://user:hunter2@host/db"), "postgres://user:***@host/db");
});

test("status is public and reports the database", async () => {
  const response = await fetch(`${baseUrl}/api/account/status`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.database.ready, true);
  assert.equal(body.database.kind, pglite ? "postgres" : "sqlite");
  assert.equal(body.accounts.enabled, true);
  assert.equal(body.vault, true);
  assert.equal(body.user, null);
});

test("register, sign in, session cookie, sign out", async () => {
  const weak = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: json, body: JSON.stringify({ email: "a@example.com", password: "short" }) });
  assert.equal(weak.status, 400);

  const created = await register("Ada@Example.com");
  assert.equal(created.response.status, 200);
  assert.equal(created.body.user.email, "ada@example.com");
  assert.match(created.response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.equal(created.body.sessionToken, undefined, "web clients never see the token");

  const duplicate = await register("ada@example.com");
  assert.equal(duplicate.response.status, 409);

  const wrong = await fetch(`${baseUrl}/api/account/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "ada@example.com", password: "nope nope nope" }) });
  assert.equal(wrong.status, 401);

  const native = await fetch(`${baseUrl}/api/account/login`, { method: "POST", headers: { ...json, "X-HANNAH-Session": "bearer" }, body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery" }) });
  const nativeBody = await native.json();
  assert.match(nativeBody.sessionToken, /^hs_/);

  const me = await fetch(`${baseUrl}/api/account/status`, { headers: { Cookie: created.cookie } }).then((r) => r.json());
  assert.equal(me.user.email, "ada@example.com");
  const viaBearer = await fetch(`${baseUrl}/api/account/status`, { headers: { Authorization: `Bearer ${nativeBody.sessionToken}` } }).then((r) => r.json());
  assert.equal(viaBearer.user.email, "ada@example.com");

  // Accounts can't reach operator-only routes.
  const operatorOnly = await fetch(`${baseUrl}/api/desktop/computer`, { method: "POST", headers: { ...json, Cookie: created.cookie }, body: "{}" });
  assert.equal(operatorOnly.status, 403);

  await fetch(`${baseUrl}/api/account/logout`, { method: "POST", headers: { Cookie: created.cookie } });
  const after = await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: created.cookie } });
  assert.equal(after.status, 401);
  assert.equal((await after.json()).reason, "session-invalid");
});

test("accounts never fall back to the server's provider keys", async () => {
  const { cookie } = await register("nokeys@example.com");
  const providers = await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.deepEqual(providers.providers, []);
  const agent = await fetch(`${baseUrl}/api/agent`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ provider: "groq", messages: [{ role: "user", content: "hi" }], tools: tool }) });
  assert.equal(agent.status, 400);
  assert.match((await agent.json()).error, /Add your Groq API key/);
});

test("stored provider keys are verified, encrypted and used for that user only", { skip: !openssl && "openssl is not available" }, async () => {
  const { cookie } = await register("keys@example.com");
  const rejected = await fetch(`${baseUrl}/api/account/credentials/openai`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ apiKey: "sk-test-key-bad" }) });
  assert.equal(rejected.status, 400);

  const saved = await fetch(`${baseUrl}/api/account/credentials/openai`, { method: "PUT", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ apiKey: "sk-test-key-good1234" }) });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.equal(savedBody.hint, "sk-…1234");
  assert.equal(savedBody.verified, true);

  const db = await require("./db").getDatabase();
  const { rows } = await db.query("SELECT ciphertext, wrapped_key FROM hannah_credentials WHERE provider_id = 'openai'");
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes("sk-test-key-good1234"), "no plaintext in the database");

  const list = await fetch(`${baseUrl}/api/account/credentials`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.deepEqual(list.credentials.map((item) => [item.providerId, item.hint]), [["openai", "sk-…1234"]]);

  const providers = await fetch(`${baseUrl}/api/providers`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(providers.defaultProvider, "openai");

  seenKeys.length = 0;
  const agent = await fetch(`${baseUrl}/api/agent`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], tools: tool, model: "gpt-4o-mini" }) });
  const agentBody = await agent.json();
  assert.equal(agent.status, 200, JSON.stringify(agentBody));
  assert.match(agentBody.message.content, /stored-key-reply:hello/);
  assert.deepEqual(seenKeys, ["sk-test-key-good1234"]);

  // Spend is persisted per user in the database.
  const spend = await db.query("SELECT usd FROM hannah_spend WHERE credential_id LIKE 'user:%'");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = await db.query("SELECT usd FROM hannah_spend WHERE credential_id LIKE 'user:%'");
  assert.ok(Number((again.rows[0] || spend.rows[0])?.usd) > 0);

  const removed = await fetch(`${baseUrl}/api/account/credentials/openai`, { method: "DELETE", headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(removed.removed, true);
});

test("developer API keys work on /v1, are shown once and can be revoked", async () => {
  const { cookie } = await register("dev@example.com");
  const created = await fetch(`${baseUrl}/api/account/api-keys`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ name: "CLI" }) });
  const { key, id } = await created.json();
  assert.equal(created.status, 201);
  assert.match(key, /^hk_/);

  const listed = await fetch(`${baseUrl}/api/account/api-keys`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(listed.keys.length, 1);
  assert.ok(!JSON.stringify(listed).includes(key), "the full key is never listed");

  const models = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(models.status, 200);
  const usage = await fetch(`${baseUrl}/v1/usage`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(usage.status, 200);

  // An API key can call the model API but not manage the account.
  const manage = await fetch(`${baseUrl}/api/account/api-keys`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(manage.status, 403);

  await fetch(`${baseUrl}/api/account/api-keys/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
  const revoked = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(revoked.status, 401);
});

test("sync documents use optimistic versions", async () => {
  const { cookie } = await register("sync@example.com");
  const headers = { ...json, Cookie: cookie };
  const empty = await fetch(`${baseUrl}/api/account/data/reminders`, { headers }).then((r) => r.json());
  assert.equal(empty.version, 0);
  const first = await fetch(`${baseUrl}/api/account/data/reminders`, { method: "PUT", headers, body: JSON.stringify({ baseVersion: 0, value: [{ id: "r1" }] }) }).then((r) => r.json());
  assert.equal(first.version, 1);
  const stale = await fetch(`${baseUrl}/api/account/data/reminders`, { method: "PUT", headers, body: JSON.stringify({ baseVersion: 0, value: [] }) });
  assert.equal(stale.status, 409);
  const read = await fetch(`${baseUrl}/api/account/data/reminders`, { headers }).then((r) => r.json());
  assert.deepEqual(read.value, [{ id: "r1" }]);
  const unknown = await fetch(`${baseUrl}/api/account/data/secrets`, { headers });
  assert.equal(unknown.status, 404);
});

test("encrypted memory sync blobs persist in the database", async () => {
  const syncId = "sync_0123456789abcdef";
  const saved = await fetch(`${baseUrl}/api/sync/memory`, { method: "POST", headers: operator, body: JSON.stringify({ syncId, blob: "opaque" }) });
  assert.equal(saved.status, 200);
  const db = await require("./db").getDatabase();
  const { rows } = await db.query("SELECT blob FROM hannah_sync_blobs WHERE sync_id = $1", [syncId]);
  assert.equal(rows[0].blob, "opaque");
});

test("export excludes secrets and deletion needs the password", async () => {
  const { cookie } = await register("leaving@example.com");
  const headers = { ...json, Cookie: cookie };
  const exported = await fetch(`${baseUrl}/api/account/export`, { headers }).then((r) => r.json());
  assert.equal(exported.user.email, "leaving@example.com");
  assert.ok(!JSON.stringify(exported).includes("password"));
  const audit = await fetch(`${baseUrl}/api/account/audit`, { headers }).then((r) => r.json());
  assert.ok(audit.events.some((event) => event.event === "account.created"));

  const denied = await fetch(`${baseUrl}/api/account`, { method: "DELETE", headers, body: JSON.stringify({ password: "wrong password" }) });
  assert.equal(denied.status, 401);
  const deleted = await fetch(`${baseUrl}/api/account`, { method: "DELETE", headers, body: JSON.stringify({ password: "correct horse battery" }) });
  assert.equal(deleted.status, 200);
  const relogin = await fetch(`${baseUrl}/api/account/login`, { method: "POST", headers: json, body: JSON.stringify({ email: "leaving@example.com", password: "correct horse battery" }) });
  assert.equal(relogin.status, 401);
});

test("only the operator can test a database URL", async () => {
  const { cookie } = await register("tester@example.com");
  const asUser = await fetch(`${baseUrl}/api/db/test`, { method: "POST", headers: { ...json, Cookie: cookie }, body: JSON.stringify({ url: "sqlite::memory:" }) });
  assert.equal(asUser.status, 403);
  const ok = await fetch(`${baseUrl}/api/db/test`, { method: "POST", headers: operator, body: JSON.stringify({ url: "sqlite::memory:" }) }).then((r) => r.json());
  assert.equal(ok.ok, true);
  const bad = await fetch(`${baseUrl}/api/db/test`, { method: "POST", headers: operator, body: JSON.stringify({ url: "mysql://nope" }) }).then((r) => r.json());
  assert.equal(bad.ok, false);
  assert.match(bad.error, /postgres/);
});

test("webhooks: https on public addresses only, secret shown once", async () => {
  const { cookie } = await register("hooks@example.com");
  const headers = { ...json, Cookie: cookie };
  const local = await fetch(`${baseUrl}/api/account/webhooks`, { method: "POST", headers, body: JSON.stringify({ url: "https://127.0.0.1/hook", events: ["reminder.fired"] }) });
  assert.equal(local.status, 400);
  const metadata = await fetch(`${baseUrl}/api/account/webhooks`, { method: "POST", headers, body: JSON.stringify({ url: "https://169.254.169.254/latest", events: ["reminder.fired"] }) });
  assert.equal(metadata.status, 400);
  const plain = await fetch(`${baseUrl}/api/account/webhooks`, { method: "POST", headers, body: JSON.stringify({ url: "http://93.184.215.14/hook", events: ["reminder.fired"] }) });
  assert.equal(plain.status, 400);
  const created = await fetch(`${baseUrl}/api/account/webhooks`, { method: "POST", headers, body: JSON.stringify({ url: "https://93.184.215.14/hook", events: ["team.completed", "bogus"] }) });
  const body = await created.json();
  assert.equal(created.status, 201, JSON.stringify(body));
  assert.match(body.secret, /^whsec_/);
  assert.deepEqual(body.events, ["team.completed"]);
  const listed = await fetch(`${baseUrl}/api/account/webhooks`, { headers }).then((r) => r.json());
  assert.equal(listed.webhooks.length, 1);
  assert.ok(!JSON.stringify(listed).includes(body.secret), "the secret is never listed");
  const removed = await fetch(`${baseUrl}/api/account/webhooks/${body.id}`, { method: "DELETE", headers }).then((r) => r.json());
  assert.equal(removed.removed, true);
});

test("webhook helpers: private ranges, DNS checks and signatures", async () => {
  const { assertPublicUrl, privateAddress, sign } = require("./webhooks");
  for (const address of ["10.1.2.3", "192.168.0.1", "172.20.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.equal(privateAddress(address), true, address);
  for (const address of ["8.8.8.8", "93.184.215.14", "2606:4700::1111"]) assert.equal(privateAddress(address), false, address);
  await assert.rejects(() => assertPublicUrl("https://sneaky.example", { lookup: async () => [{ address: "10.0.0.5" }] }), /private/);
  assert.equal(await assertPublicUrl("https://hooks.example/x", { lookup: async () => [{ address: "8.8.8.8" }] }), "https://hooks.example/x");
  assert.match(sign("whsec_test", "1700000000", "{}"), /^sha256=[0-9a-f]{64}$/);
});

test("a signed-in browser's change from another site is refused; the same request from HANNAH's page works", async () => {
  const registered = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "csrf@example.com", password: "correct horse battery" }) });
  const cookie = registered.headers.get("set-cookie").split(";")[0];
  const create = (origin) => fetch(`${baseUrl}/api/account/api-keys`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ name: "k" }) });
  const crossSite = await create("https://evil.example");
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).reason, "cross-site");
  assert.equal((await create(baseUrl)).status, 201);
  assert.equal((await create(undefined)).status, 201);
  // Reading is unaffected, and a developer key (no cookie) isn't a browser session.
  assert.equal((await fetch(`${baseUrl}/api/account/status`, { headers: { Cookie: cookie, Origin: "https://evil.example" } })).status, 200);
});

test("sign-in attempts are counted across server instances that share a database", async () => {
  const express = require("express");
  const { createAccountRouter } = require("./accounts");
  // Two instances: each router has its own memory, as two serverless functions would.
  const instance = async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createAccountRouter({ isOperator: () => false, verifyProviderKey: async () => ({ ok: true }) }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, url: `http://127.0.0.1:${server.address().port}/api/account/login` };
  };
  const first = await instance();
  const second = await instance();
  const attempt = (target) => fetch(target.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "shared-limit@example.com", password: "wrong password here" }) });
  try {
    for (let index = 0; index < 6; index += 1) assert.equal((await attempt(first)).status, 401);
    for (let index = 0; index < 4; index += 1) assert.equal((await attempt(second)).status, 401);
    // The eleventh attempt for this email from this address is refused, on either instance.
    assert.equal((await attempt(second)).status, 429);
    assert.equal((await attempt(first)).status, 429);
    const db = await require("./db").getDatabase();
    const keys = (await db.query("SELECT key FROM hannah_rate_limits WHERE key LIKE 'signin-%'")).rows.map((row) => row.key);
    assert.ok(keys.length > 0);
    assert.equal(keys.some((key) => key.includes("shared-limit@example.com")), false, "no email address is stored in the limits table");
  } finally {
    first.server.close();
    second.server.close();
  }
});
