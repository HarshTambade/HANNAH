/**
 * Feedback and AI content reports kept in HANNAH's own database, which works
 * on serverless hosts where a local file can't be kept. Nothing identifying
 * (account id, IP, chat text) is stored.
 */
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.HANNAH_TEST_DB === "pglite" ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "c".repeat(64);

const { getDatabase, resetDatabase } = require("./db");
const { createFeedbackHandler } = require("./feedback");
const { createContentReportHandler } = require("./content-reports");

before(async () => {
  if (process.env.HANNAH_TEST_DB === "pglite") await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
});
after(async () => { await resetDatabase(); });

function invoke(handler, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve({ status: this.statusCode, body: payload }); return this; } };
    handler({ body, ip: "203.0.113.9", get: () => "Mozilla/5.0" }, res);
  });
}

test("feedback is saved to the database when no other channel is set up", async () => {
  const handler = createFeedbackHandler({ env: {}, useDatabase: () => true });
  const saved = await invoke(handler, { message: "The voice stops halfway through long answers.", category: "bug", appVersion: "1.5.0", platform: "Web", inferenceMode: "Cloud" });
  assert.equal(saved.status, 202, JSON.stringify(saved.body));
  const db = await getDatabase();
  const { rows } = await db.query("SELECT * FROM hannah_feedback WHERE id = $1", [saved.body.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, "The voice stops halfway through long answers.");
  assert.equal(rows[0].category, "bug");
  assert.doesNotMatch(JSON.stringify(rows[0]), /203\.0\.113\.9|Mozilla/);
  // Without any channel it still says so.
  assert.equal((await invoke(createFeedbackHandler({ env: {}, useDatabase: () => false }), { message: "hi there", category: "idea", appVersion: "1", platform: "Web", inferenceMode: "Cloud" })).status, 503);
});

test("an AI content report is saved to the database without the reply's text", async () => {
  const handler = createContentReportHandler({ useDatabase: () => true });
  const saved = await invoke(handler, { messageId: "msg_0123456789abcdef", reason: "harmful", appVersion: "1.5.0", platform: "Android", inferenceMode: "Cloud", message: "the private reply text" });
  assert.equal(saved.status, 202, JSON.stringify(saved.body));
  const db = await getDatabase();
  const { rows } = await db.query("SELECT * FROM hannah_content_reports WHERE id = $1", [saved.body.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, "msg_0123456789abcdef");
  assert.equal(rows[0].reason, "harmful");
  assert.doesNotMatch(JSON.stringify(rows[0]), /private reply text/);
});

test("large diagnostics are trimmed by whole entries and always stay valid JSON", () => {
  const { diagnosticsJson } = require("./feedback");
  const entries = Array.from({ length: 100 }, (_, index) => ({ level: "error", source: "net", message: `"quoted" \\ ${"x".repeat(1200)} ${index}` }));
  const text = diagnosticsJson({ entries, userAgent: "test" }, 50_000);
  assert.ok(text.length <= 50_000);
  const parsed = JSON.parse(text);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.entries.length > 0 && parsed.entries.length < 100);
  assert.match(parsed.entries.at(-1).message, / 99$/, "the newest entries are kept");
});

test("public write routes are limited per network address, so made-up keys can't get around it", async () => {
  const { createAddressRateLimiter } = require("./api-security");
  const limiter = createAddressRateLimiter({ limit: 3, windowMs: 60_000 });
  const run = (address) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json() { resolve(this.statusCode); } };
    limiter({ get: () => undefined, socket: { remoteAddress: address } }, res, () => resolve(200));
  });
  assert.deepEqual([await run("198.51.100.7"), await run("198.51.100.7"), await run("198.51.100.7"), await run("198.51.100.7")], [200, 200, 200, 429]);
  assert.equal(await run("198.51.100.8"), 200, "another address has its own allowance");
  // A forged X-Forwarded-For doesn't change the address unless the operator trusts a proxy.
  const forged = await new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json() { resolve(this.statusCode); } };
    limiter({ get: (name) => (name === "x-forwarded-for" ? "203.0.113.50" : undefined), socket: { remoteAddress: "198.51.100.7" } }, res, () => resolve(200));
  });
  assert.equal(forged, 429);
});

test("behind a local reverse proxy each visitor has their own allowance; IPv6 is counted per /64", async () => {
  const { createAddressRateLimiter } = require("./api-security");
  const limiter = createAddressRateLimiter({ limit: 1, windowMs: 60_000 });
  const run = (peer, forwarded) => new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json() { resolve(this.statusCode); } };
    limiter({ get: (name) => (name === "x-forwarded-for" ? forwarded : undefined), socket: { remoteAddress: peer } }, res, () => resolve(200));
  });
  // Caddy or nginx on the same machine (127.0.0.1) forwards two different visitors.
  assert.equal(await run("127.0.0.1", "198.51.100.20"), 200);
  assert.equal(await run("127.0.0.1", "198.51.100.21"), 200);
  assert.equal(await run("127.0.0.1", "198.51.100.20"), 429);
  // Rotating addresses inside one IPv6 /64 doesn't buy more requests.
  assert.equal(await run("2001:db8:1:2::10"), 200);
  assert.equal(await run("2001:db8:1:2:ffff::99"), 429);
  assert.equal(await run("2001:db8:1:3::10"), 200);
});

test("the address table stays bounded under a flood of new addresses", async () => {
  const { createAddressRateLimiter } = require("./api-security");
  const limiter = createAddressRateLimiter({ limit: 5, windowMs: 60_000, maxBuckets: 100 });
  const started = Date.now();
  for (let index = 0; index < 5_000; index += 1) {
    await new Promise((resolve) => limiter({ get: () => undefined, socket: { remoteAddress: `198.18.${index >> 8}.${index & 255}` } }, { setHeader() {}, status() { return this; }, json: resolve }, resolve));
  }
  assert.ok(Date.now() - started < 2_000, "no full rescan on every request");
});

test("on serverless hosts two instances share one per-address count through the database", async () => {
  const { createAddressRateLimiter } = require("./api-security");
  const options = { limit: 3, windowMs: 60_000, name: "feedback-test", shared: () => true };
  const instanceA = createAddressRateLimiter(options);
  const instanceB = createAddressRateLimiter(options);
  const run = (limiter) => new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json() { resolve(this.statusCode); } };
    limiter({ get: () => undefined, socket: { remoteAddress: "198.51.100.77" } }, res, () => resolve(200));
  });
  assert.deepEqual([await run(instanceA), await run(instanceB), await run(instanceA), await run(instanceB)], [200, 200, 200, 429]);
  const db = await getDatabase();
  const { rows } = await db.query("SELECT count FROM hannah_rate_limits WHERE key = $1", ["feedback-test:198.51.100.77"]);
  assert.equal(Number(rows[0].count), 4);
  // A database error falls back to counting in memory rather than refusing everyone.
  const broken = createAddressRateLimiter({ ...options, name: "broken", database: async () => { throw new Error("down"); } });
  assert.equal(await run(broken), 200);
});
