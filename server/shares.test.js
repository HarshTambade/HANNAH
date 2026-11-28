const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, before, after } = require("node:test");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "shares-test-token-0123456789-abcdefghijklmnopq";
const pglite = process.env.HANNAH_TEST_DB === "pglite";
process.env.DATABASE_URL = pglite ? "postgres://pglite.local/hannah" : "sqlite::memory:";
process.env.HANNAH_VAULT_KEY = "b".repeat(64);
process.env.HANNAH_DAILY_BUDGET_USD = "";

const { normalizeSnapshot, redactSecrets, renderMarkdown } = require("./shares");

let server;
let baseUrl;

before(async () => {
  if (pglite) await require("./db").useDatabase(await require("./db/pglite-adapter").createPgliteAdapter());
  const app = require("./index");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await require("./db").resetDatabase();
});

const json = { "Content-Type": "application/json" };
let accounts = 0;

async function signUp() {
  accounts += 1;
  const response = await fetch(`${baseUrl}/api/account/register`, { method: "POST", headers: json, body: JSON.stringify({ email: `share-${accounts}-${Date.now()}@example.com`, password: "correct horse battery" }) });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
  return { ...json, Cookie: cookie };
}

const conversation = [
  { role: "user", content: "Plan a **trip** to Pune. My key is gsk_abcdefghijklmnopqrstuvwxyz123456" },
  { role: "assistant", content: "Here is a plan [1].\n\n- Day 1: <script>alert(1)</script>\n- Day 2: [site](https://example.com/pune)\n\n```\n<b>code</b>\n```", sources: [{ url: "https://example.com/source", title: "A source" }], attachments: ["itinerary.pdf"] },
];

async function share(headers, body = { title: "Pune trip", messages: conversation }) {
  const response = await fetch(`${baseUrl}/api/account/shares`, { method: "POST", headers, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}

test("the renderer escapes markup and links only http(s)", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> **bold** [x](javascript:alert(1)) [ok](https://example.com/a?b="c") `<i>`');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=%22c%22" rel="noopener noreferrer nofollow ugc" target="_blank">ok<\/a>/);
  assert.match(html, /<code>&lt;i&gt;<\/code>/);
  assert.match(renderMarkdown("```\n<script>x</script>\n```"), /<pre><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/);
  assert.match(renderMarkdown("1. one\n2. two"), /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(renderMarkdown("see [1]", [{ url: "https://s.example/", title: "S" }]), /<a class="cite" href="https:\/\/s.example\/"/);
  assert.equal(renderMarkdown("see [2]", [{ url: "https://s.example/", title: "S" }]), "<p>see [2]</p>");
});

test("secrets are masked and only opted-in extras are kept", () => {
  assert.equal(redactSecrets("key sk-proj-abcdefghijklmnopqrstu and AKIAABCDEFGHIJKLMNOP"), "key [hidden secret] and [hidden secret]");
  assert.equal(redactSecrets("my password is hunter22"), "my password is [hidden secret]");
  assert.match(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"), /^\[hidden secret\]$/);
  const plain = normalizeSnapshot({ messages: conversation });
  assert.equal(plain.snapshot.messages[1].sources, undefined);
  assert.equal(plain.snapshot.messages[1].attachments, undefined);
  assert.equal(plain.title, "Shared conversation");
  const extras = normalizeSnapshot({ messages: conversation, include: { sources: true, attachments: true } });
  assert.deepEqual(extras.snapshot.messages[1].sources, [{ url: "https://example.com/source", title: "A source" }]);
  assert.deepEqual(extras.snapshot.messages[1].attachments, ["itinerary.pdf"]);
  assert.throws(() => normalizeSnapshot({ messages: [{ role: "system", content: "tool output" }] }), /Only your messages/);
  assert.throws(() => normalizeSnapshot({ messages: [] }), /at least one/);
  assert.throws(() => normalizeSnapshot({ messages: [{ role: "user", content: "x".repeat(20_001) }] }), /over 20,000/);
});

test("a signed-in person shares a snapshot; the public page is strict, noindex and escaped", async () => {
  const anonymous = await share(json);
  assert.equal(anonymous.response.status, 401);

  const owner = await signUp();
  const created = await share(owner, { title: "Pune trip", messages: conversation, include: { sources: true } });
  assert.equal(created.response.status, 201);
  assert.match(created.body.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(created.body.url, `${baseUrl}/s/${created.body.id}`);
  assert.equal(created.body.messageCount, 2);

  const page = await fetch(created.body.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const html = await page.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /<h1>Pune trip<\/h1>/);
  assert.match(html, /<strong>trip<\/strong>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /gsk_abcdefghijklmnop/);
  assert.match(html, /\[hidden secret\]/);
  assert.match(html, /href="https:\/\/example.com\/source"/);
  // Attachment names weren't opted in.
  assert.doesNotMatch(html, /itinerary\.pdf/);
  // The inline stylesheet is the one the CSP hash allows.
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const hash = require("node:crypto").createHash("sha256").update(css).digest("base64");
  assert.ok(csp.includes(`'sha256-${hash}'`));

  const list = await (await fetch(`${baseUrl}/api/account/shares`, { headers: owner })).json();
  assert.deepEqual(list.shares.map((item) => item.id), [created.body.id]);

  const unknown = await fetch(`${baseUrl}/s/AAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.match(unknown.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await fetch(`${baseUrl}/s/<script>`)).status, 404);
});

test("another account can't see or revoke a link; revoking stops it at once", async () => {
  const owner = await signUp();
  const stranger = await signUp();
  const created = await share(owner);
  assert.equal(created.response.status, 201);
  const { id, url } = created.body;

  const theirs = await (await fetch(`${baseUrl}/api/account/shares`, { headers: stranger })).json();
  assert.deepEqual(theirs.shares, []);
  const refused = await fetch(`${baseUrl}/api/account/shares/${id}`, { method: "DELETE", headers: stranger });
  assert.equal(refused.status, 404);
  assert.equal((await fetch(url)).status, 200);

  // A developer API key can't manage links.
  const key = await (await fetch(`${baseUrl}/api/account/api-keys`, { method: "POST", headers: owner, body: JSON.stringify({ name: "ci" }) })).json();
  const viaKey = await fetch(`${baseUrl}/api/account/shares`, { method: "POST", headers: { ...json, Authorization: `Bearer ${key.key}` }, body: JSON.stringify({ messages: conversation }) });
  assert.equal(viaKey.status, 403);

  const revoked = await fetch(`${baseUrl}/api/account/shares/${id}`, { method: "DELETE", headers: owner });
  assert.equal(revoked.status, 200);
  const gone = await fetch(url);
  assert.equal(gone.status, 404);
  assert.doesNotMatch(await gone.text(), /Pune/);
  assert.equal((await fetch(`${baseUrl}/api/account/shares/${id}`, { method: "DELETE", headers: owner })).status, 404);
});

test("export includes links and deleting the account removes them", async () => {
  const owner = await signUp();
  const created = await share(owner);
  const exported = await (await fetch(`${baseUrl}/api/account/export`, { headers: owner })).json();
  assert.equal(exported.sharedConversations.length, 1);
  assert.equal(exported.sharedConversations[0].id, created.body.id);
  assert.equal(exported.sharedConversations[0].snapshot.messages.length, 2);

  const deleted = await fetch(`${baseUrl}/api/account`, { method: "DELETE", headers: owner, body: JSON.stringify({ password: "correct horse battery" }) });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(created.body.url)).status, 404);
  const db = await require("./db").getDatabase();
  const { rows } = await db.query("SELECT COUNT(*) AS count FROM hannah_shared_conversations WHERE id = $1", [created.body.id]);
  assert.equal(Number(rows[0].count), 0);
});

test("making links is rate limited per account", async () => {
  const owner = await signUp();
  for (let index = 0; index < 20; index += 1) assert.equal((await share(owner)).response.status, 201);
  const limited = await share(owner);
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
  // Another account has its own allowance.
  assert.equal((await share(await signUp())).response.status, 201);
});
