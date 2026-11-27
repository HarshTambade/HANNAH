"use strict";

/**
 * The workforce browser driver.
 *
 * Playwright drives a real Chromium with a persistent profile per computer, so
 * cookies and sessions survive between tasks. Every request passes a network
 * policy first: only http(s), and private addresses are refused unless the
 * operator explicitly allows them for a self-hosted deployment.
 *
 * What this driver deliberately doesn't do:
 *   - it never tries to solve a CAPTCHA, passkey or MFA prompt;
 *   - it never types a password from model context: the caller passes a vault
 *     reference and the value is injected here, then discarded;
 *   - it never evaluates arbitrary JavaScript supplied by a model.
 */
const fsp = require("node:fs/promises");
const path = require("node:path");
const dns = require("node:dns/promises");
const crypto = require("node:crypto");
const net = require("node:net");
const { isBlockedAddress } = require("../net-guard");
const { clean, fail } = require("./common");

let playwright = null;
let playwrightError = null;
const sessions = new Map();
const privateCache = new Map();
const IDLE_MS = 10 * 60_000;
const MAX_TEXT = 30_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function loadPlaywright() {
  if (playwright || playwrightError) return playwright;
  try {
    playwright = require("playwright");
  } catch (error) {
    playwrightError = error;
  }
  return playwright;
}

function browserAvailable() {
  return Boolean(loadPlaywright()?.chromium);
}

/** Loopback, private, link-local, metadata and reserved addresses, in every spelling. */
function isPrivateAddress(address) {
  return isBlockedAddress(address);
}

const RESOLVE_TTL_MS = 60_000;

async function refusedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // An address written in the URL is judged as written: no lookup to fail open.
  if (net.isIP(host)) return isPrivateAddress(host);
  const cached = privateCache.get(host);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.refused;
  let refused;
  try {
    const answers = await dns.lookup(host, { all: true, verbatim: true });
    refused = !answers.length || answers.some((answer) => isPrivateAddress(answer.address));
  } catch {
    // Fail closed: a name we can't check isn't opened.
    refused = true;
  }
  if (privateCache.size > 500) privateCache.clear();
  privateCache.set(host, { refused, at: Date.now() });
  return refused;
}

function allowPrivateNetwork() {
  return process.env.HANNAH_WORKFORCE_ALLOW_PRIVATE === "1" || process.env.WORKFORCE_ALLOW_PRIVATE_NETWORK === "true";
}

function normalizeUrl(input) {
  const raw = clean(input, 2000);
  if (!raw) throw fail(400, "Enter a URL.", "invalid");
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw fail(400, "That isn't a valid URL.", "invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail(400, "Only http and https pages can be opened.", "invalid-url");
  return url.toString();
}

/** The computer's network and download settings, as the browser applies them. */
function normalizePolicy(policy) {
  const value = policy && typeof policy === "object" ? policy : {};
  return {
    network: ["public", "allowlist", "none"].includes(value.network) ? value.network : "public",
    allowedHosts: Array.isArray(value.allowedHosts) ? value.allowedHosts.map((host) => String(host).toLowerCase()) : [],
    downloads: value.downloads !== false,
  };
}

/** "none" reaches nothing; "allowlist" reaches the listed hosts and their subdomains. */
function networkAllows(policy, hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (policy.network === "none") return false;
  if (policy.network === "allowlist") return policy.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  return true;
}

async function guardRoute(route, entry = null) {
  const policy = normalizePolicy(entry?.policy);
  const request = route.request();
  let url;
  try {
    url = new URL(request.url());
  } catch {
    return route.abort("blockedbyclient");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return route.abort("blockedbyclient");
  if (!networkAllows(policy, url.hostname)) return route.abort("blockedbyclient");
  if (allowPrivateNetwork() && policy.network === "public") return route.continue();
  if (!allowPrivateNetwork() && (await refusedHost(url.hostname))) return route.abort("blockedbyclient");
  // Playwright routes only the first request of a redirect chain, and a
  // redirect handed back with route.fulfill is followed without routing either
  // (checked with Chromium). So page and frame loads follow their redirects
  // here, checking every hop before it is fetched.
  if (request.isNavigationRequest()) {
    try {
      let target = request.url();
      let method = request.method();
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await route.fetch({ url: target, method, maxRedirects: 0 });
        const status = response.status();
        const location = response.headers().location;
        if (status < 300 || status >= 400 || !location) return route.fulfill({ response });
        const next = new URL(location, target);
        if ((next.protocol !== "http:" && next.protocol !== "https:") || !networkAllows(policy, next.hostname)) return route.abort("blockedbyclient");
        if (!allowPrivateNetwork() && (await refusedHost(next.hostname))) return route.abort("blockedbyclient");
        if (status === 301 || status === 302 || status === 303) method = method === "HEAD" ? "HEAD" : "GET";
        target = next.toString();
      }
      return route.abort("failed");
    } catch {
      return route.abort("failed");
    }
  }
  return route.continue();
}

function sessionKey(userId, computerId) {
  return `${userId}:${computerId}`;
}

async function contextFor({ userId, computerId, workspace, profile = "default" }) {
  const library = loadPlaywright();
  if (!library?.chromium) throw fail(503, "Browser automation isn't available on this server: Playwright isn't installed.", "browser-unavailable");
  const key = sessionKey(userId, computerId);
  let entry = sessions.get(key);
  if (entry) {
    entry.lastUse = Date.now();
    return entry;
  }
  const profileDir = path.join(workspace, ".hannah", "browser", clean(profile, 40) || "default");
  await fsp.mkdir(profileDir, { recursive: true });
  let context;
  try {
    context = await library.chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      serviceWorkers: "block",
      args: ["--disable-dev-shm-usage"],
    });
  } catch (error) {
    throw fail(503, `The browser couldn't start (${error?.message?.split("\n")[0] || "launch failed"}).`, "browser-unavailable");
  }
  await context.route("**/*", (route) => guardRoute(route, entry)).catch(() => {});
  context.setDefaultTimeout(15_000);
  // A page can start a download without the download action: cancel it when downloads are off.
  const watchDownloads = (tab) => tab.on("download", (download) => {
    if (entry && !normalizePolicy(entry.policy).downloads) download.cancel().catch(() => {});
  });
  context.pages().forEach(watchDownloads);
  context.on("page", watchDownloads);
  const page = context.pages()[0] || (await context.newPage());
  entry = { context, page, lastUse: Date.now(), userId, computerId, policy: {} };
  sessions.set(key, entry);
  return entry;
}

async function closeComputer(userId, computerId) {
  const key = sessionKey(userId, computerId);
  const entry = sessions.get(key);
  if (!entry) return false;
  sessions.delete(key);
  await entry.context.close().catch(() => {});
  return true;
}

async function closeAll() {
  await Promise.all([...sessions.values()].map((entry) => entry.context.close().catch(() => {})));
  sessions.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUse > IDLE_MS) {
      sessions.delete(key);
      entry.context.close().catch(() => {});
    }
  }
}, 60_000).unref?.();

async function pageState(page) {
  let url = "";
  try { url = page.url(); } catch { url = ""; }
  let title = "";
  try { title = await page.title(); } catch { title = ""; }
  const tabs = page.context().pages().map((item) => ({ url: item.url(), closed: item.isClosed() }));
  return { url, title: clean(title, 300), tabs, activeTab: page.context().pages().indexOf(page) };
}

async function detectChallenge(page) {
  let text = "";
  try { text = (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 5000); } catch { return null; }
  if (/captcha|verify (?:that )?you are (?:a )?human|are you a robot|two[- ]factor|one[- ]time (?:code|password)|passkey|authenticator/i.test(text)) {
    return { needed: true, reason: "The page is asking for a human verification step. Finish it in the live preview, then resume." };
  }
  return null;
}

function selectorFor(action) {
  const selector = clean(action.selector, 400);
  if (!selector) throw fail(400, "A selector is required for this action.", "invalid");
  return selector;
}

async function saveScreenshot(page, workspace) {
  const dir = path.join(workspace, ".hannah", "screenshots");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "latest.png");
  await page.screenshot({ path: file, fullPage: false });
  const buffer = await fsp.readFile(file);
  return { file, sha256: crypto.createHash("sha256").update(buffer).digest("hex"), size: buffer.length, capturedAt: Date.now() };
}

/**
 * Run one browser action. `secrets.resolve(ref)` returns a secret value for a
 * vault reference, or throws. It is called here, never returned to the caller.
 */
async function act({ userId, computerId, workspace, action, secrets = null, policy = null }) {
  const kind = clean(action?.action || action?.type, 40);
  if (kind === "download" && policy && !normalizePolicy(policy).downloads) throw fail(403, "Downloads are turned off for this computer.", "downloads-off");
  const entry = await contextFor({ userId, computerId, workspace });
  // The computer's settings are read on every action, so a change applies at once.
  if (policy) entry.policy = policy;
  const page = entry.page;
  entry.lastUse = Date.now();
  const result = { action: kind, at: Date.now(), masked: false };
  const state = async () => Object.assign(result, await pageState(page));

  switch (kind) {
    case "navigate": {
      const url = normalizeUrl(action.url);
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      result.status = response ? response.status() : null;
      result.requestedUrl = url;
      break;
    }
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      break;
    case "forward":
      await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
      break;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      break;
    case "click": {
      const selector = selectorFor(action);
      const target = page.locator(selector).first();
      await target.click({ timeout: Number(action.timeoutMs) || 15_000 });
      result.selector = selector;
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      break;
    }
    case "fill": {
      const selector = selectorFor(action);
      const locator = page.locator(selector).first();
      if (/password/i.test(selector) && !action.secretRef) throw fail(400, "Fill a password field with a Secure Vault reference, never a value.", "secret-required");
      let value = "";
      if (action.secretRef) {
        if (!secrets) throw fail(503, "The Secure Vault isn't available.", "vault-unavailable");
        let host = "";
        try { host = new URL(page.url()).hostname.toLowerCase(); } catch { host = ""; }
        value = await secrets.resolve(action.secretRef, { host });
        result.masked = true;
        result.secretRef = clean(action.secretRef, 80);
      } else {
        value = clean(action.value, 4000);
      }
      await locator.fill(value, { timeout: 15_000 });
      value = "";
      result.selector = selector;
      break;
    }
    case "press": {
      const selector = clean(action.selector, 400);
      const key = clean(action.key, 40);
      if (!key) throw fail(400, "Name a key to press.", "invalid");
      if (selector) await page.locator(selector).first().press(key);
      else await page.keyboard.press(key);
      result.key = key;
      break;
    }
    case "select": {
      const selector = selectorFor(action);
      const values = Array.isArray(action.values) ? action.values.map((item) => clean(item, 200)).slice(0, 20) : [clean(action.value, 200)];
      await page.locator(selector).first().selectOption(values);
      result.selector = selector;
      break;
    }
    case "extract": {
      const selector = clean(action.selector, 400) || "body";
      const text = await page.locator(selector).first().innerText({ timeout: 15_000 }).catch(() => "");
      result.text = text.slice(0, MAX_TEXT);
      result.selector = selector;
      break;
    }
    case "aria": {
      const text = await page.locator(clean(action.selector, 400) || "body").first().ariaSnapshot().catch(() => "");
      result.aria = String(text).slice(0, MAX_TEXT);
      break;
    }
    case "screenshot": {
      result.screenshot = await saveScreenshot(page, workspace);
      break;
    }
    case "upload": {
      const selector = selectorFor(action);
      // The same check as the file tools: no ".hannah" (the saved browser
      // sessions live there) and no link that leads outside the workspace.
      const { safePath } = require("./computers");
      const file = (await safePath(workspace, clean(action.path, 1000))).absolute;
      const info = await fsp.stat(file).catch(() => null);
      if (!info || !info.isFile()) throw fail(404, "That file isn't in this computer's workspace.", "not-found");
      if (info.size > 25 * 1024 * 1024) throw fail(413, "Uploads are limited to 25 MB.", "too-large");
      await page.locator(selector).first().setInputFiles(file);
      result.selector = selector;
      result.path = clean(action.path, 1000);
      break;
    }
    case "download": {
      const selector = selectorFor(action);
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.locator(selector).first().click()]);
      const name = clean(download.suggestedFilename(), 160) || `download-${Date.now()}`;
      const dir = path.join(workspace, "downloads");
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`);
      await download.saveAs(target);
      const saved = await fsp.stat(target);
      if (saved.size > MAX_DOWNLOAD_BYTES) {
        await fsp.rm(target, { force: true });
        throw fail(413, `Downloads are limited to ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB.`, "too-large");
      }
      const buffer = await fsp.readFile(target);
      result.download = { name, path: path.relative(workspace, target), size: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
      break;
    }
    case "new-tab": {
      entry.page = await entry.context.newPage();
      if (action.url) await entry.page.goto(normalizeUrl(action.url), { waitUntil: "domcontentloaded" });
      break;
    }
    case "switch-tab": {
      const index = Number(action.index);
      const pages = entry.context.pages().filter((item) => !item.isClosed());
      if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw fail(400, "That tab doesn't exist.", "invalid");
      entry.page = pages[index];
      await entry.page.bringToFront();
      break;
    }
    case "close-tab": {
      const pages = entry.context.pages().filter((item) => !item.isClosed());
      if (pages.length <= 1) throw fail(400, "The last tab can't be closed.", "invalid");
      await entry.page.close();
      entry.page = entry.context.pages().find((item) => !item.isClosed());
      break;
    }
    case "wait": {
      if (action.selector) await page.locator(clean(action.selector, 400)).first().waitFor({ timeout: Number(action.timeoutMs) || 15_000 });
      else await page.waitForTimeout(Math.min(15_000, Math.max(100, Number(action.ms) || 1000)));
      break;
    }
    default:
      throw fail(400, `Unknown browser action: ${kind}.`, "invalid");
  }
  const challenge = await detectChallenge(entry.page).catch(() => null);
  if (challenge) result.challenge = challenge;
  await state();
  const stateFile = path.join(workspace, ".hannah", "browser", "state.json");
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  await entry.context.storageState({ path: stateFile }).catch(() => {});
  return result;
}

/**
 * The computer's screen. `live` captures the open browser page now (for the
 * live preview) and falls back to the last stored screenshot; otherwise the
 * stored one comes first.
 */
async function latestScreenshot({ userId, computerId, workspace, live = false }) {
  const entry = sessions.get(sessionKey(userId, computerId));
  if (live && entry) {
    const now = await entry.page.screenshot({ type: "png" }).catch(() => null);
    if (now) return now;
  }
  const file = path.join(workspace, ".hannah", "screenshots", "latest.png");
  const buffer = await fsp.readFile(file).catch(() => null);
  if (buffer) return buffer;
  if (!entry) return null;
  return entry.page.screenshot({ type: "png" }).catch(() => null);
}

async function status() {
  const library = loadPlaywright();
  if (!library?.chromium) return { available: false, reason: "Playwright isn't installed on this server." };
  try {
    return { available: true, engine: "chromium", version: library.chromium.name?.() || "playwright", liveSessions: sessions.size };
  } catch {
    return { available: true, engine: "chromium", liveSessions: sessions.size };
  }
}

module.exports = { networkAllows, normalizePolicy, act, browserAvailable, closeAll, closeComputer, latestScreenshot, normalizeUrl, status, isPrivateAddress, refusedHost };
