"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isBlockedAddress, ipv6Bytes } = require("./net-guard");
const { checkUrl } = require("./workflows/http");
const { assertPublicUrl } = require("./webhooks");
const { refusedHost } = require("./workforce/browser");

const BLOCKED = [
  "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
  "::", "::1", "0:0:0:0:0:0:0:1", "[::1]",
  // IPv4-mapped, in the dotted form and the hex form the URL parser produces
  "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::FFFF:7F00:1",
  // IPv4-compatible (deprecated) and 6to4 around a private address
  "::7f00:1", "::127.0.0.1", "2002:7f00:1::",
  "64:ff9b::7f00:1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "2001:db8::1",
  "not-an-ip", "", "1:2:3:4:5:6:7:8:9",
];
const ALLOWED = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808", "2002:808:808::1"];

test("every spelling of an internal address is refused", () => {
  for (const address of BLOCKED) assert.equal(isBlockedAddress(address), true, address);
  for (const address of ALLOWED) assert.equal(isBlockedAddress(address), false, address);
});

test("IPv6 parses to the same bytes whatever the spelling", () => {
  assert.deepEqual(ipv6Bytes("::ffff:127.0.0.1"), ipv6Bytes("::ffff:7f00:1"));
  assert.deepEqual(ipv6Bytes("::1"), [...Array(15).fill(0), 1]);
  assert.equal(ipv6Bytes("1.2.3.4"), null);
});

test("workflow URLs, webhooks and the workforce browser refuse mapped loopback and metadata", async () => {
  for (const url of ["http://[::ffff:127.0.0.1]:3001/", "http://[::ffff:a9fe:a9fe]/latest/meta-data/", "http://[::7f00:1]/"]) {
    assert.throws(() => checkUrl(url), /internal network address/, url);
  }
  await assert.rejects(assertPublicUrl("https://[::ffff:127.0.0.1]:8443/x"), /private or local/);
  assert.equal(await refusedHost("[::1]"), true);
  assert.equal(await refusedHost("[::ffff:7f00:1]"), true);
  assert.equal(await refusedHost("no-such-host.invalid"), true, "a name that can't be checked isn't opened");
});

test("a computer's network setting decides which hosts its browser reaches", () => {
  const { networkAllows, normalizePolicy } = require("./workforce/browser");
  const none = normalizePolicy({ network: "none" });
  const list = normalizePolicy({ network: "allowlist", allowedHosts: ["example.com"] });
  const open = normalizePolicy({});
  assert.equal(networkAllows(none, "example.com"), false);
  assert.equal(networkAllows(list, "example.com"), true);
  assert.equal(networkAllows(list, "docs.example.com"), true);
  assert.equal(networkAllows(list, "example.com.evil.net"), false);
  assert.equal(networkAllows(list, "notexample.com"), false);
  assert.equal(networkAllows(open, "anything.org"), true);
  assert.equal(open.downloads, true);
  assert.equal(normalizePolicy({ downloads: false }).downloads, false);
});

test("downloads are refused before the browser starts when a computer turns them off", async () => {
  const { act } = require("./workforce/browser");
  await assert.rejects(
    act({ userId: "u", computerId: "c", workspace: "/nonexistent", action: { action: "download", selector: "a" }, policy: { downloads: false } }),
    (error) => error.reason === "downloads-off",
  );
});

test("with httpsOnly, a redirect to a plain http address isn't followed", async () => {
  const http = require("node:http");
  const { once } = require("node:events");
  const { safeRequest } = require("./workflows/http");
  const previous = process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK;
  process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = "true";
  const target = http.createServer((req, res) => res.end("plain")).listen(0, "127.0.0.1");
  await once(target, "listening");
  const redirector = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` }); res.end(); }).listen(0, "127.0.0.1");
  await once(redirector, "listening");
  try {
    const start = `http://127.0.0.1:${redirector.address().port}/`;
    assert.equal(String((await safeRequest(start)).body), "plain");
    await assert.rejects(safeRequest(start, { httpsOnly: true }), /plain http address/);
  } finally {
    target.close();
    redirector.close();
    if (previous === undefined) delete process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK; else process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK = previous;
  }
});

test("the browser's proxy refuses internal addresses for plain requests and tunnels alike", async () => {
  const http = require("node:http");
  const net = require("node:net");
  const { once } = require("node:events");
  const { createEgressProxy } = require("./workforce/egress-proxy");
  const hits = [];
  const target = http.createServer((req, res) => { hits.push(req.url); res.end("reached"); }).listen(0, "127.0.0.1");
  await once(target, "listening");
  const port = target.address().port;
  // For the test, "127.0.0.1" stands for an internal host and "localhost" for a public one.
  const proxy = await createEgressProxy({ check: async (host) => (host === "127.0.0.1" ? "internal" : "") });
  const proxyPort = Number(new URL(proxy.url).port);
  const viaProxy = (url) => new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
  const tunnel = (authority) => new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.once("data", (chunk) => { resolve(String(chunk).split("\r\n")[0]); socket.destroy(); });
    socket.on("error", reject);
  });
  try {
    assert.deepEqual(await viaProxy(`http://localhost:${port}/ok`), { status: 200, body: "reached" });
    assert.equal((await viaProxy(`http://127.0.0.1:${port}/secret`)).status, 403);
    assert.match(await tunnel(`127.0.0.1:${port}`), /403/);
    assert.match(await tunnel(`localhost:${port}`), /200 Connection Established/);
    assert.deepEqual(hits, ["/ok"], "the internal address was never reached");
  } finally {
    await proxy.close();
    target.close();
  }
});

test("the proxy's rules: network setting, internal names and addresses", async () => {
  const { egressRefusal, normalizePolicy } = require("./workforce/browser");
  const open = normalizePolicy({});
  assert.equal(await egressRefusal(open, "example.com", "93.184.215.14"), "");
  assert.match(await egressRefusal(open, "rebound.example", "127.0.0.1"), /internal network address/);
  assert.match(await egressRefusal(open, "rebound.example", "::ffff:a9fe:a9fe"), /internal network address/);
  assert.match(await egressRefusal(open, "printer.local", "93.184.215.14"), /internal host name/);
  assert.match(await egressRefusal(normalizePolicy({ network: "allowlist", allowedHosts: ["example.com"] }), "example.org", "93.184.215.15"), /network setting/);
});
