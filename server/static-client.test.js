"use strict";

/**
 * Self-hosted web app (HANNAH_SERVE_CLIENT) on the real server: pages and
 * assets are served, prerendered routes get their own page, unknown routes get
 * the app, and nothing under /api, /v1, /mcp, /download, /.well-known or
 * /hooks is ever answered with the web app.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { after, before, test } = require("node:test");

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "hannah-dist-"));
fs.mkdirSync(path.join(dist, "assets"));
fs.mkdirSync(path.join(dist, "marketplace"));
fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>HANNAH app</title>");
fs.writeFileSync(path.join(dist, "marketplace", "index.html"), "<!doctype html><title>HANNAH Marketplace</title>");
fs.writeFileSync(path.join(dist, "assets", "main-abc123.js"), "console.log('hannah')");
fs.writeFileSync(path.join(os.tmpdir(), "hannah-outside-secret.txt"), "outside");

process.env.NODE_ENV = "test";
process.env.HANNAH_API_TOKEN = "static-client-test-token-0123456789-abcdefgh";
process.env.HANNAH_SERVE_CLIENT = dist;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

let server;
let base;
before(async () => {
  server = require("./index").listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(dist, { recursive: true, force: true }); });

const get = async (url) => {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, type: response.headers.get("content-type") || "", cache: response.headers.get("cache-control") || "", body: await response.text() };
};

test("serves the app, prerendered pages and long-cached assets", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /HANNAH app/);
  assert.match(home.cache, /no-cache/);
  assert.match((await get("/chat")).body, /HANNAH app/, "an app route without its own page gets the app");
  assert.match((await get("/marketplace")).body, /HANNAH Marketplace/, "a prerendered route gets its own page");
  const asset = await get("/assets/main-abc123.js");
  assert.equal(asset.status, 200);
  assert.match(asset.type, /javascript/);
  assert.match(asset.cache, /immutable/);
});

test("never answers server routes with the web app, and never leaves the folder", async () => {
  const health = await get("/api/health");
  assert.equal(health.status, 200);
  assert.match(health.type, /json/);
  for (const url of ["/api/does-not-exist", "/v1/nope", "/mcp", "/download/nothing", "/.well-known/nothing", "/hooks/x", "/s/x"]) {
    const response = await get(url);
    assert.doesNotMatch(response.body, /HANNAH app/, `${url} isn't the web app`);
  }
  for (const url of ["/..%2Fhannah-outside-secret.txt", "/%2e%2e/hannah-outside-secret.txt", "/assets/..%2F..%2Fhannah-outside-secret.txt"]) {
    assert.doesNotMatch((await get(url)).body, /outside/, `${url} stays inside the build folder`);
  }
});
