"use strict";

/**
 * One answer to "may the server connect to this IP address?", shared by every
 * outbound path (workflow HTTP, web reading, connectors, webhooks, the
 * workforce browser).
 *
 * IPv6 is parsed to its 16 bytes before it is judged, so every spelling of an
 * address gets the same answer. That matters: the URL parser rewrites
 * [::ffff:127.0.0.1] as [::ffff:7f00:1], and a check that only recognised the
 * dotted form let loopback and cloud metadata through.
 */
const net = require("node:net");

function blockedIPv4Bytes(a, b) {
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0) // IETF protocol assignments, documentation
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224; // multicast and reserved
}

function ipv4Bytes(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/** The 16 bytes of an IPv6 address, or null when it isn't one. */
function ipv6Bytes(address) {
  let text = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (net.isIPv6(text) === false) return null;
  let tail = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = ipv4Bytes(dotted[1]);
    if (!v4) return null;
    tail = v4;
    text = text.slice(0, -dotted[1].length);
    text = text.endsWith("::") ? text : text.replace(/:$/, "");
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const words = (part) => (part ? part.split(":").filter((item) => item !== "") : []);
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const groups = 8 - tail.length / 2;
  const fill = halves.length === 2 ? groups - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== groups) return null;
  const bytes = [];
  for (const word of all) {
    const value = parseInt(word, 16);
    if (!/^[0-9a-f]{1,4}$/.test(word) || Number.isNaN(value)) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return [...bytes, ...tail];
}

function blockedIPv6Bytes(bytes) {
  const zeroUpTo = (end) => bytes.slice(0, end).every((value) => value === 0);
  if (zeroUpTo(16)) return true; // ::
  if (zeroUpTo(15) && bytes[15] === 1) return true; // ::1
  // IPv4-mapped (::ffff:0:0/96) and the old IPv4-compatible form (::/96): judge the IPv4 address.
  if (zeroUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) return blockedIPv4Bytes(bytes[12], bytes[13]);
  if (zeroUpTo(12)) return blockedIPv4Bytes(bytes[12], bytes[13]);
  // NAT64 (64:ff9b::/96 and 64:ff9b:1::/48) can reach anything behind the translator.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;
  // 6to4 (2002::/16) embeds an IPv4 address.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return blockedIPv4Bytes(bytes[2], bytes[3]);
  if ((bytes[0] & 0xfe) === 0xfc) return true; // unique local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // site-local fec0::/10 (deprecated)
  if (bytes[0] === 0xff) return true; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  return false;
}

/**
 * True when the address is loopback, private, link-local, metadata, CGNAT,
 * multicast, reserved, or not an IP address at all (fail closed).
 */
function isBlockedAddress(address) {
  const text = String(address || "").trim().replace(/^\[|\]$/g, "");
  if (net.isIPv4(text)) {
    const [a, b] = ipv4Bytes(text);
    return blockedIPv4Bytes(a, b);
  }
  const bytes = ipv6Bytes(text);
  if (!bytes) return true;
  return blockedIPv6Bytes(bytes);
}

module.exports = { isBlockedAddress, ipv6Bytes };
