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
