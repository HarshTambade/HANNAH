// HANNAH's browser: one visible, signed-out window HANNAH drives for you.
//
// - You see it: the window is on screen and its title says HANNAH is using it.
// - Signed out: its session is in memory and new each time (no cookies or
//   sign-ins from your own browser, nothing kept after it closes).
// - Sandboxed with context isolation and no Node.js; no pop-up windows
//   (links that open one load in this window), downloads or permissions.
// - Requests to this computer itself and link-local or metadata addresses
//   are cancelled, as in the workflow page reader.
//
// This file only performs actions. What HANNAH may do (and what needs your
// yes) is decided in core.mjs.

import { randomUUID } from "node:crypto";
import { classifyAddress } from "./core.mjs";

export const BROWSER_LIMITS = Object.freeze({ loadMs: 30_000, settleMs: 900, textChars: 20_000, elements: 120, screenshotWidth: 1568 });

const blockedHost = (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") return true;
  const kind = classifyAddress(host);
  return kind === "loopback" || kind === "link-local";
};
const allowedRequest = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;
    return !blockedHost(parsed.hostname);
  } catch {
    return false;
  }
};

// ----- scripts run in the page (isolated world: the page's own scripts can't see or change them) -----

/** Visible controls, each tagged with a stable ref. In-view ones first. */
const ELEMENTS = (limit) => `(() => {
  let counter = Number(document.documentElement.getAttribute("data-hannah-refs") || 0);
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const nameOf = (el) => clean(el.getAttribute("aria-label") || el.innerText || (el.tagName === "INPUT" && ["submit", "button"].includes(el.type) ? el.value : "") || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (el.labels && el.labels[0] && el.labels[0].innerText));
  const selector = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=searchbox], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=""], [contenteditable=true]';
  const found = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const explicitRole = el.getAttribute("role");
    const role = explicitRole || (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "select" : tag === "textarea" ? "textbox" : tag === "input" ? (["submit", "button", "reset", "image"].includes(type) ? "button" : ["checkbox", "radio"].includes(type) ? type : type === "search" ? "searchbox" : "textbox") : el.isContentEditable ? "textbox" : "control");
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
    const ids = ((el.getAttribute("name") || "") + " " + (el.id || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase();
    const sensitive = type === "password" || /(^|\\s)(cc-|one-time-code|current-password|new-password)/.test(autocomplete) || /card ?number|cardnumber|\\bcvv\\b|\\bcvc\\b|security code|\\botp\\b|one.?time|passw|\\bpin\\b|upi|account number|routing/.test(ids);
    const form = el.closest("form");
    const submits = type === "submit" || type === "image" || (tag === "button" && (type === "" || type === "submit") && Boolean(form));
    const search = role === "searchbox" || type === "search" || /(^|[\\s_-])(q|query|search|search_query|searchbox)([\\s_-]|$)/.test(ids) || (form && /search/.test((form.getAttribute("role") || "") + " " + (form.getAttribute("action") || "")));
    let ref = el.getAttribute("data-hannah-ref");
    if (!ref) { counter += 1; ref = "e" + counter; el.setAttribute("data-hannah-ref", ref); }
    const rect = el.getBoundingClientRect();
    const inView = rect.bottom > 0 && rect.top < innerHeight;
    found.push({ ref, role, name: nameOf(el), type: type || undefined, href: tag === "a" ? el.href : undefined, value: role === "textbox" || role === "searchbox" ? (sensitive ? undefined : clean(el.value || "")) || undefined : undefined, submits, search: Boolean(search), sensitive, inView });
  }
  document.documentElement.setAttribute("data-hannah-refs", String(counter));
  found.sort((a, b) => Number(b.inView) - Number(a.inView));
  return found.slice(0, ${limit});
})()`;

const TEXT = (limit) => `(() => {
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { title: document.title || "", url: location.href, text: text.slice(0, ${limit}), textTruncated: text.length > ${limit}, scrolledTo: Math.round(scrollY), pageHeight: Math.round(document.documentElement.scrollHeight), viewport: innerHeight };
})()`;

const byRef = (ref) => `document.querySelector('[data-hannah-ref="${String(ref).replace(/[^\w-]/g, "")}"]')`;

const DESCRIBE = (ref) => `(() => {
  const el = ${byRef(ref)};
  if (!el) return null;
  const all = ${ELEMENTS(100_000)};
  return all.find((item) => item.ref === ${JSON.stringify(String(ref))}) || null;
})()`;

/**
 * Bring the element into view and say where to click it. If something else
 * covers it there, the page's own click is used instead of the mouse.
 */
const CLICK_POINT = (ref) => `(async () => {
  const el = ${byRef(ref)};
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const hit = document.elementFromPoint(x, y);
  if (x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight && hit && (hit === el || el.contains(hit) || hit.contains(el))) return { x, y };
  el.click();
  return { clicked: true };
})()`;

const FOCUS = (ref) => `(() => {
  const el = ${byRef(ref)};
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (typeof el.select === "function") el.select();
  else if (el.isContentEditable) document.execCommand("selectAll");
  return true;
})()`;

const SELECT_OPTION = (ref, label) => `(() => {
  const el = ${byRef(ref)};
  if (!el || el.tagName !== "SELECT") return null;
  const wanted = ${JSON.stringify(String(label).toLowerCase())};
  const option = [...el.options].find((item) => item.text.trim().toLowerCase() === wanted) || [...el.options].find((item) => item.text.trim().toLowerCase().includes(wanted));
  if (!option) return [...el.options].map((item) => item.text.trim());
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

// YouTube sometimes escapes text twice ("&amp;amp;"), so decode until it stops changing.
const DECODE = `const decode = (value) => { let text = String(value || ""); for (let i = 0; i < 3 && /&(amp|quot|#39|lt|gt);/.test(text); i += 1) text = text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); return text; };`;

/** YouTube search results as they appear on the page. */
const YOUTUBE_RESULTS = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 40 && !document.querySelector("ytd-video-renderer"); i += 1) await sleep(250);
  ${DECODE}
  const clean = (value) => decode(String(value || "").replace(/\\s+/g, " ").trim());
  return [...document.querySelectorAll("ytd-video-renderer")].slice(0, 12).map((item) => {
    const link = item.querySelector("a#video-title");
    return {
      title: clean(link && (link.getAttribute("title") || link.innerText)),
      url: link ? link.href.split("&pp=")[0] : "",
      channel: clean((item.querySelector("ytd-channel-name a") || item.querySelector("#channel-name")) && (item.querySelector("ytd-channel-name a") || item.querySelector("#channel-name")).innerText),
      duration: clean(item.querySelector("ytd-thumbnail-overlay-time-status-renderer, badge-shape .badge-shape-wiz__text, .yt-badge-shape__text") && item.querySelector("ytd-thumbnail-overlay-time-status-renderer, badge-shape .badge-shape-wiz__text, .yt-badge-shape__text").innerText),
      details: clean(item.querySelector("#metadata-line") && item.querySelector("#metadata-line").innerText),
    };
  }).filter((item) => item.title && /\\/watch\\?v=/.test(item.url));
})()`;


/**
 * A YouTube video's details, and where its "Show transcript" button is: the
 * same panel anyone can open under the video. Clicked with the mouse next.
 */
const YOUTUBE_PREPARE = `(async () => {
  ${DECODE}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const q = (selector) => document.querySelector(selector);
  const clean = (value) => decode(String(value || "").replace(/\\s+/g, " ").trim());
  for (let i = 0; i < 60 && !q("ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1"); i += 1) await sleep(250);
  const video = q("video");
  if (video) { video.muted = true; video.pause(); }
  const title = clean((q("ytd-watch-metadata h1") || q("h1.ytd-watch-metadata") || q("#title h1") || {}).innerText) || document.title.replace(/ - YouTube$/, "");
  const channel = clean((q("ytd-video-owner-renderer #channel-name a") || q("#owner #channel-name a") || q("ytd-channel-name a") || {}).innerText);
  const expand = q("ytd-text-inline-expander #expand, #description-inline-expander #expand, tp-yt-paper-button#expand");
  if (expand) { expand.click(); await sleep(700); }
  const description = clean((q("ytd-text-inline-expander #attributed-snippet-text, #description-inline-expander, ytd-text-inline-expander") || {}).innerText).slice(0, 4000);
  let button = null;
  for (let i = 0; i < 20 && !button; i += 1) {
    button = [...document.querySelectorAll("button")].find((el) => /show transcript/i.test(el.getAttribute("aria-label") || el.innerText || ""));
    if (!button) await sleep(250);
  }
  if (!button) return { title, channel, description, point: null };
  button.scrollIntoView({ block: "center" });
  await sleep(400);
  const rect = button.getBoundingClientRect();
  return { title, channel, description, point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } };
})()`;

/** The transcript segments shown in the panel, in either of YouTube's layouts. */
const YOUTUBE_SEGMENTS = `(async () => {
  ${DECODE}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => decode(String(value || "").replace(/\\s+/g, " ").trim());
  const read = () => {
    const modern = [...document.querySelectorAll("transcript-segment-view-model")].map((seg) => {
      const stamp = seg.querySelector("[class*=Timestamp]");
      const time = clean(stamp && stamp.textContent);
      const all = clean(seg.innerText || seg.textContent);
      // Each segment also carries a screen-reader label such as "1 minute, 47 seconds"; drop it.
      const rest = clean(all.startsWith(time) ? all.slice(time.length) : all.replace(time, ""));
      return { time, text: rest.replace(/^(\\d+ hours?,? )?(\\d+ minutes?,? )?(\\d+ seconds? )?/, "").trim() };
    });
    if (modern.length) return modern;
    return [...document.querySelectorAll("ytd-transcript-segment-renderer")].map((seg) => ({ time: clean((seg.querySelector(".segment-timestamp") || {}).textContent), text: clean((seg.querySelector(".segment-text, yt-formatted-string") || {}).textContent) }));
  };
  let segments = [];
  for (let i = 0; i < 60; i += 1) {
    segments = read().filter((seg) => seg.text);
    if (segments.length) break;
    await sleep(250);
  }
  return segments.slice(0, 5000);
})()`;

export function createBrowser({ BrowserWindow, session }) {
  let win = null;
  let partition = null;
  let downloadsBlocked = 0;
  let lastStatus = null;

  const contents = () => {
    if (!win || win.isDestroyed()) throw Object.assign(new Error("HANNAH's browser isn't open."), { code: "BROWSER_CLOSED" });
    return win.webContents;
  };
  // HANNAH's scripts run in their own isolated world: the page's scripts can't
  // replace the functions they call or read what they return.
  const run = (script) => contents().executeJavaScriptInIsolatedWorld(4242, [{ code: script }], true);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function settle() {
    const web = contents();
    const deadline = Date.now() + BROWSER_LIMITS.loadMs;
    await wait(250);
    while (web.isLoading() && Date.now() < deadline) await wait(150);
    await wait(BROWSER_LIMITS.settleMs);
  }

  /** A real mouse click at a point in the page, like a person's. */
  function mouseClick({ x, y }) {
    const web = contents();
    web.sendInputEvent({ type: "mouseMove", x, y });
    web.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    web.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }

  async function snapshot() {
    const page = await run(TEXT(BROWSER_LIMITS.textChars));
    return { ...page, status: lastStatus };
  }

  return {
    isOpen: () => Boolean(win && !win.isDestroyed()),

    async open({ onClosed } = {}) {
      if (win && !win.isDestroyed()) { win.show(); return; }
      partition = `hannah-browser-${randomUUID()}`;
      const pageSession = session.fromPartition(partition, { cache: true });
      pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      pageSession.setPermissionCheckHandler(() => false);
      pageSession.on("will-download", (event) => { event.preventDefault(); downloadsBlocked += 1; });
      pageSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url) }));
      win = new BrowserWindow({
        show: true,
        width: 1280,
        height: 860,
        title: "HANNAH browser (signed out)",
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true, spellcheck: false },
      });
      const web = win.webContents;
      web.setAudioMuted(true);
      // A link that would open a new window loads here instead, after the same checks.
      web.setWindowOpenHandler(({ url }) => {
        if (allowedRequest(url) && /^https?:/.test(url)) void web.loadURL(url);
        return { action: "deny" };
      });
      web.on("will-navigate", (event, next) => { if (!/^https?:/.test(next) || !allowedRequest(next)) event.preventDefault(); });
      web.on("did-navigate", (_event, _url, code) => { lastStatus = code; });
      // Keep the window's title saying who is driving it.
      win.on("page-title-updated", (event, title) => { event.preventDefault(); win.setTitle(`HANNAH browser (signed out) — ${title}`); });
      win.on("closed", () => {
        win = null;
        session.fromPartition(partition).clearStorageData().catch(() => {});
        onClosed?.();
      });
    },

    async navigate(url) {
      const web = contents();
      lastStatus = null;
      try {
        await Promise.race([web.loadURL(url), wait(BROWSER_LIMITS.loadMs).then(() => { throw new Error("timeout"); })]);
      } catch (error) {
        if (!web.getURL() || web.getURL() === "about:blank") throw new Error(`The page couldn't be opened: ${error.message}`);
      }
      await settle();
      return snapshot();
    },

    read: () => snapshot(),
    elements: () => run(ELEMENTS(BROWSER_LIMITS.elements)),
    describe: (ref) => run(DESCRIBE(ref)),

    async click(ref) {
      const before = contents().getURL();
      const point = await run(CLICK_POINT(ref));
      if (!point) throw Object.assign(new Error(`There's no element ${ref} on the page any more. Read the page again.`), { code: "NO_ELEMENT" });
      if (!point.clicked) mouseClick(point);
      await settle();
      const page = await snapshot();
      return { ...page, navigated: page.url !== before };
    },

    async type(ref, text, { submit = false } = {}) {
      const described = await run(DESCRIBE(ref));
      if (!described) throw Object.assign(new Error(`There's no element ${ref} on the page any more. Read the page again.`), { code: "NO_ELEMENT" });
      if (described.role === "select") {
        const chosen = await run(SELECT_OPTION(ref, text));
        if (Array.isArray(chosen)) throw new Error(`“${text}” isn't one of the choices: ${chosen.slice(0, 20).join(", ")}.`);
      } else {
        if (!(await run(FOCUS(ref)))) throw new Error("That field couldn't be selected.");
        await contents().insertText(String(text));
      }
      const before = contents().getURL();
      if (submit) {
        const web = contents();
        web.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        web.sendInputEvent({ type: "char", keyCode: "\r" });
        web.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      }
      await settle();
      const page = await snapshot();
      const now = await run(DESCRIBE(ref)).catch(() => null);
      return { ...page, navigated: page.url !== before, fieldValue: now && !now.sensitive ? now.value ?? null : null };
    },

    async scroll(direction) {
      const amount = direction === "up" ? -0.85 : direction === "top" ? null : 0.85;
      await run(amount === null ? "scrollTo(0, 0)" : `scrollBy(0, Math.round(innerHeight * ${amount}))`);
      await wait(700);
      return snapshot();
    },

    async back() {
      const web = contents();
      if (!web.navigationHistory.canGoBack()) throw new Error("There's no earlier page.");
      web.navigationHistory.goBack();
      await settle();
      return snapshot();
    },

    async screenshot() {
      const image = await contents().capturePage();
      if (image.isEmpty()) throw new Error("The page couldn't be captured.");
      const size = image.getSize();
      const scaled = size.width > BROWSER_LIMITS.screenshotWidth ? image.resize({ width: BROWSER_LIMITS.screenshotWidth }) : image;
      return { image: scaled.toJPEG(72).toString("base64"), mediaType: "image/jpeg", ...scaled.getSize() };
    },

    youtubeResults: () => run(YOUTUBE_RESULTS),
    async youtubeVideo() {
      const video = await run(YOUTUBE_PREPARE);
      if (!video.point) return { title: video.title, channel: video.channel, description: video.description, transcript: [], reason: "YouTube doesn't show a transcript for this video." };
      mouseClick(video.point);
      const transcript = await run(YOUTUBE_SEGMENTS);
      return { title: video.title, channel: video.channel, description: video.description, transcript, reason: transcript.length ? undefined : "The transcript panel opened but showed no text." };
    },
    url: () => contents().getURL(),
    downloadsBlocked: () => downloadsBlocked,

    close() {
      if (win && !win.isDestroyed()) win.close();
    },
  };
}

/**
 * Print HTML to a PDF in a hidden window with no scripts and no network,
 * so the notes can't load anything. Returns the PDF bytes.
 */
export function createPdfRenderer({ BrowserWindow, session }) {
  return async function renderPdf(html) {
    const partition = `hannah-pdf-${randomUUID()}`;
    const pdfSession = session.fromPartition(partition, { cache: false });
    pdfSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") }));
    const win = new BrowserWindow({ show: false, webPreferences: { partition, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`);
      return await win.webContents.printToPDF({ pageSize: "A4", printBackground: true, margins: { marginType: "default" }, generateDocumentOutline: true, generateTaggedPDF: true });
    } finally {
      win.destroy();
    }
  };
}
