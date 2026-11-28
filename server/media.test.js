const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test, after } = require("node:test");
const express = require("express");

process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
delete process.env.HANNAH_DAILY_BUDGET_USD;

const { createMediaRouter, checkMediaPrompt } = require("./media");
const { getProvider } = require("./providers/catalog");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(64, 2)]);

/** A stub of provider HTTP: records every call, answers from `routes`. */
function stubFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null });
    for (const [pattern, answer] of routes) if (pattern.test(String(url))) return typeof answer === "function" ? answer(String(url), init) : answer;
    return new Response("{}", { status: 404 });
  };
  return { calls, fetchImpl };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const servers = [];
after(() => { for (const server of servers) server.close(); });

/** A small app with the media router, keys for the given providers, and a credential per request. */
async function app({ keys = { openai: "sk-openai-test", xai: "xai-test-key", together: "tg-test" }, routes = [], credential = "test:media" } = {}) {
  const { calls, fetchImpl } = stubFetch(routes);
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => { res.locals.hannahApiTokenId = credential; next(); });
  server.use("/api", createMediaRouter({
    getRequestProvider: (_req, id) => ({ provider: getProvider(id), apiKey: keys[id] || "" }),
    allowedProviderIds: () => new Set(Object.keys(keys)),
    fetchImpl,
    lookup: async () => [{ address: "93.184.216.34" }],
  }));
  const listening = server.listen(0, "127.0.0.1");
  servers.push(listening);
  await once(listening, "listening");
  const origin = `http://127.0.0.1:${listening.address().port}`;
  const call = async (path, body) => {
    const response = await fetch(`${origin}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return { status: response.status, body: await response.json() };
  };
  return { calls, call };
}

test("providers lists only engines the caller has a key for", async () => {
  const { call } = await app({ keys: { xai: "xai-test-key" } });
  const { body } = await call("/api/media/providers");
  assert.deepEqual(body.image.map((item) => [item.id, item.available]), [["openai", false], ["xai", true], ["together", false]]);
  assert.equal(body.video[0].id, "xai");
  assert.equal(body.video[0].available, true);
  assert.equal(body.video[0].maxSeconds, 15);
});

test("an image comes back as base64 from OpenAI's /images/generations, with the caller's key", async () => {
  const { calls, call } = await app({ routes: [[/api\.openai\.com\/v1\/images\/generations$/, () => json({ data: [{ b64_json: PNG.toString("base64") }] })]] });
  const { status, body } = await call("/api/media/image", { prompt: "a red fox in snow", provider: "openai", aspect: "16:9" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, "openai");
  assert.equal(body.images.length, 1);
  assert.equal(body.images[0].mime, "image/png");
  assert.deepEqual(Buffer.from(body.images[0].data, "base64"), PNG);
  assert.equal(calls[0].auth, "Bearer sk-openai-test");
  assert.equal(calls[0].body.prompt, "a red fox in snow");
  assert.equal(calls[0].body.size, "1536x1024");
  assert.equal(calls[0].body.response_format, undefined, "GPT image models don't take response_format");
});

test("xAI is asked for b64_json with an aspect ratio, and its reported cost counts toward the budget", async () => {
  process.env.HANNAH_DAILY_BUDGET_USD = "0.05";
  try {
    const { calls, call } = await app({ credential: "test:xai-budget", routes: [[/api\.x\.ai\/v1\/images\/generations$/, () => json({ data: [{ b64_json: PNG.toString("base64"), mime_type: "image/png" }], usage: { cost_in_usd_ticks: 700_000_000 } })]] });
    const first = await call("/api/media/image", { prompt: "a lighthouse at dusk", provider: "xai" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.costUsd, 0.07);
    assert.equal(calls[0].body.response_format, "b64_json");
    assert.equal(calls[0].body.aspect_ratio, "1:1");
    assert.equal(calls[0].body.model, "grok-imagine-image-2.0");
    // $0.07 spent against a $0.05 cap: the next one is stopped before any provider call.
    const second = await call("/api/media/image", { prompt: "another lighthouse", provider: "xai" });
    assert.equal(second.status, 429);
    assert.equal(second.body.reason, "budget-exceeded");
    assert.equal(calls.length, 1);
  } finally {
    delete process.env.HANNAH_DAILY_BUDGET_USD;
  }
});

test("Together is asked for base64 with pixel dimensions; a returned URL is downloaded instead", async () => {
  const { calls, call } = await app({ keys: { together: "tg-test" }, routes: [
    [/api\.together\.xyz\/v1\/images\/generations$/, () => json({ data: [{ index: 0, type: "url", url: "https://cdn.example.org/out.png" }] })],
    [/cdn\.example\.org\/out\.png$/, () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })],
  ] });
  const { status, body } = await call("/api/media/image", { prompt: "watercolour mountains", aspect: "9:16" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.provider, "together");
  assert.deepEqual(Buffer.from(body.images[0].data, "base64"), PNG);
  assert.equal(calls[0].body.response_format, "base64");
  assert.deepEqual([calls[0].body.width, calls[0].body.height], [720, 1280]);
});

test("a provider link to a private address is not fetched", async () => {
  const { calls, call } = await app({ keys: { together: "tg-test" }, routes: [[/images\/generations$/, () => json({ data: [{ url: "http://169.254.169.254/latest/meta-data" }] })]] });
  const { status, body } = await call("/api/media/image", { prompt: "a cat" });
  assert.equal(status, 502);
  assert.match(body.error, /isn't a public https address/);
  assert.equal(calls.length, 1);
});

test("a provider's safety refusal is passed on in its own words", async () => {
  const { call } = await app({ routes: [[/images\/generations$/, () => json({ error: { message: "Your request was rejected by the safety system." } }, 400)]] });
  const { status, body } = await call("/api/media/image", { prompt: "a dragon", provider: "openai" });
  assert.equal(status, 400);
  assert.equal(body.reason, "provider-refused");
  assert.equal(body.error, "OpenAI declined this request: Your request was rejected by the safety system.");
});

test("no usable key is a clear 403, and nothing is sent", async () => {
  const { calls, call } = await app({ keys: {} });
  const image = await call("/api/media/image", { prompt: "a boat" });
  assert.equal(image.status, 403);
  assert.equal(image.body.reason, "media-unavailable");
  const video = await call("/api/media/video", { prompt: "waves" });
  assert.equal(video.status, 403);
  assert.match(video.body.error, /xAI key/);
  assert.equal(calls.length, 0);
});

test("refused prompts never reach a provider", async () => {
  const { calls, call } = await app();
  for (const prompt of ["a naked 15 year old", "sexy schoolgirl", "my neighbour Sarah in her garden", "a nude photo of my ex", "Taylor Swift topless"]) {
    const { status, body } = await call("/api/media/image", { prompt });
    assert.equal(status, 422, prompt);
    assert.ok(["minor-sexual", "private-person", "real-person-sexual"].includes(body.reason), prompt);
  }
  assert.equal(calls.length, 0);
  assert.equal((await call("/api/media/image", { prompt: "" })).status, 400);
});

test("checkMediaPrompt allows ordinary requests", () => {
  for (const prompt of ["a red fox in snow", "a 5-second clip of waves", "a birthday card for my friend with balloons", "kids playing football in a park, cartoon style", "the Eiffel Tower at night", "a cute baby elephant"]) {
    assert.equal(checkMediaPrompt(prompt), null, prompt);
  }
});

test("a video starts as an xAI job, reports progress, then arrives as an mp4 and is charged once", async () => {
  let polls = 0;
  const { calls, call } = await app({ credential: "test:video", routes: [
    [/api\.x\.ai\/v1\/videos\/generations$/, () => json({ request_id: "req_abc123" })],
    [/api\.x\.ai\/v1\/videos\/req_abc123$/, () => { polls += 1; return polls === 1 ? json({ status: "pending", progress: 40 }) : json({ status: "done", model: "grok-imagine-video-1.5", video: { url: "https://vidgen.x.ai/bucket/req_abc123.mp4", duration: 5, respect_moderation: true }, usage: { cost_in_usd_ticks: 2_500_000_000 } }); }],
    [/vidgen\.x\.ai\/bucket\/req_abc123\.mp4$/, () => new Response(MP4, { status: 200, headers: { "content-type": "video/mp4" } })],
  ] });
  const started = await call("/api/media/video", { prompt: "waves on a beach at sunset", seconds: 5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(started.body.job, { provider: "xai", id: "req_abc123" });
  assert.deepEqual(calls[0].body, { model: "grok-imagine-video-1.5", prompt: "waves on a beach at sunset", duration: 5, aspect_ratio: "16:9", resolution: "720p" });
  assert.equal(calls[0].auth, "Bearer xai-test-key");

  const pending = await call("/api/media/video/xai/req_abc123");
  assert.deepEqual(pending.body, { status: "pending", progress: 40 });
  const done = await call("/api/media/video/xai/req_abc123");
  assert.equal(done.body.status, "done", JSON.stringify(done.body));
  assert.equal(done.body.video.mime, "video/mp4");
  assert.equal(done.body.video.duration, 5);
  assert.deepEqual(Buffer.from(done.body.video.data, "base64"), MP4);
  // Collecting it again (a retry, a second tab) doesn't charge again.
  await call("/api/media/video/xai/req_abc123");
  assert.equal(require("./gateway").budgetStatus("test:video").spentUsd, 0.25);
});

test("video seconds are clamped to the provider's limit and bad job ids are rejected", async () => {
  const { calls, call } = await app({ routes: [[/videos\/generations$/, () => json({ request_id: "r1" })]] });
  await call("/api/media/video", { prompt: "a timelapse of clouds", seconds: 60 });
  assert.equal(calls[0].body.duration, 15);
  assert.equal((await call("/api/media/video/xai/..%2Fetc")).status, 400);
  assert.equal((await call("/api/media/video/sora/abc")).status, 400);
});

test("a failed or moderated video job says why", async () => {
  const { call } = await app({ routes: [
    [/videos\/failed1$/, () => json({ status: "failed", error: { code: "permission_denied", message: "Prompt violates usage policy." } })],
    [/videos\/withheld1$/, () => json({ status: "done", video: { url: null, duration: 5, respect_moderation: false } })],
    [/videos\/old1$/, () => json({ status: "expired" })],
  ] });
  const failed = await call("/api/media/video/xai/failed1");
  assert.equal(failed.status, 422);
  assert.equal(failed.body.reason, "provider-refused");
  assert.match(failed.body.error, /Prompt violates usage policy/);
  const withheld = await call("/api/media/video/xai/withheld1");
  assert.match(withheld.body.error, /moderation withheld/);
  assert.equal((await call("/api/media/video/xai/old1")).status, 410);
});
