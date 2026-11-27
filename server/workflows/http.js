"use strict";

/**
 * Outbound HTTP for workflows, safe against server-side request forgery.
 *
 * - Only http and https.
 * - The address is checked when the socket connects (a `lookup` hook on the
 *   request), so a host can't pass the check and then re-resolve to an
 *   internal address (DNS rebinding). Loopback, private, link-local (including
 *   cloud metadata at 169.254.169.254), carrier-grade NAT, multicast and
 *   reserved ranges are refused, for IPv4, IPv6 and IPv4-mapped IPv6.
 * - Redirects are followed manually (at most 3), each one checked the same way.
 * - Responses are cut at a size limit and a timeout.
 *
 * Self-hosters who need workflows to reach services on their own network set
 * WORKFLOW_ALLOW_PRIVATE_NETWORK=true. The public deployment never should.
 */
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { isBlockedAddress } = require("../net-guard");

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function addressBlocked(address) {
  if (process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK === "true") return false;
  return isBlockedAddress(address);
}

class RequestBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequestBlockedError";
    this.code = "request-blocked";
  }
}

/** A dns.lookup replacement that refuses internal addresses. */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find((entry) => addressBlocked(entry.address));
    if (bad || !list.length) return callback(new RequestBlockedError(`${hostname} resolves to an internal network address, which workflows can't reach.`));
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RequestBlockedError(`“${String(raw).slice(0, 120)}” isn't a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RequestBlockedError("Workflows can only call http and https URLs.");
  if (url.username || url.password) throw new RequestBlockedError("Put credentials in a saved credential, not in the URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && addressBlocked(host)) throw new RequestBlockedError(`${host} is an internal network address, which workflows can't reach.`);
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host) && process.env.WORKFLOW_ALLOW_PRIVATE_NETWORK !== "true") {
    throw new RequestBlockedError(`${host} is an internal host name, which workflows can't reach.`);
  }
  return url;
}

function once(url, { method, headers, body, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, { method, headers, lookup: guardedLookup, timeout: timeoutMs, signal }, (response) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      response.on("data", (chunk) => {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - maxBytes))));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      const finish = () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks), truncated });
      response.on("end", finish);
      response.on("close", finish);
      response.on("error", (error) => (truncated ? finish() : reject(error)));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error(`No response within ${Math.round(timeoutMs / 1000)} seconds.`), { code: "timeout" })));
    request.on("error", reject);
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

/**
 * Make a request. Returns { status, headers, body (Buffer), truncated, url }.
 * Throws RequestBlockedError for addresses workflows may not reach.
 */
async function safeRequest(rawUrl, { method = "GET", headers = {}, body, timeoutMs = 30_000, maxBytes = DEFAULT_MAX_BYTES, signal } = {}) {
  let url = checkUrl(rawUrl);
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await once(url, { method: currentMethod, headers, body: currentBody, timeoutMs, maxBytes, signal });
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location && hop < MAX_REDIRECTS) {
      const nextUrl = checkUrl(new URL(location, url).toString());
      // Never forward credentials to a different host.
      if (nextUrl.host !== url.host) {
        for (const key of Object.keys(headers)) if (/^(authorization|cookie|x-api-key|api-key)$/i.test(key) || /token|secret/i.test(key)) delete headers[key];
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
      }
      url = nextUrl;
      continue;
    }
    return { ...response, url: url.toString() };
  }
  throw new Error("Too many redirects.");
}

module.exports = { RequestBlockedError, addressBlocked, checkUrl, safeRequest };
