// Reads one web page for a workflow in a hidden Electron window.
//
// The window is isolated from the app and from the person's browsing:
// - Its session is in memory and new every time: no cookies or sign-ins, nothing kept.
// - It has no Node.js access, runs sandboxed with context isolation, and can't
//   open pop-ups, download files or get permissions (camera, location and so on).
// - Navigation stays on http and https, and requests to this computer itself
//   (localhost, loopback) and link-local or metadata addresses are cancelled,
//   including from scripts on the page.
// What comes back is the page's title, final address, description, visible
// text and links, and optionally a JPEG screenshot.

import { randomUUID } from "node:crypto";
import { classifyAddress } from "./core.mjs";

export const PAGE_LIMITS = Object.freeze({ loadMs: 30_000, settleMs: 1_200, waitForMs: 10_000, textChars: 50_000, links: 200, screenshotBytes: 700_000 });

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

const EXTRACT = (limits) => `(() => {
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  const links = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.href;
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: (anchor.innerText || anchor.getAttribute("aria-label") || "").trim().slice(0, 200), href });
    if (links.length >= ${limits.links}) break;
  }
  return { title: document.title || "", url: location.href, description: meta ? (meta.getAttribute("content") || "").slice(0, 500) : "", text: text.slice(0, ${limits.textChars}), textTruncated: text.length > ${limits.textChars}, links };
})()`;

export function createPageLoader({ BrowserWindow, session }) {
  return async function loadPage({ url, waitFor = "", screenshot = false }) {
    const partition = `hannah-workflow-${randomUUID()}`;
    const pageSession = session.fromPartition(partition, { cache: false });
    pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    pageSession.setPermissionCheckHandler(() => false);
    pageSession.on("will-download", (event) => event.preventDefault());
    pageSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url) }));

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { partition, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, webSecurity: true, spellcheck: false },
    });
    const contents = win.webContents;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, next) => { if (!allowedRequest(next) || next.startsWith("data:") || next.startsWith("blob:")) event.preventDefault(); });
    let status = null;
    contents.on("did-navigate", (_event, _url, code) => { status = code; });

    const started = Date.now();
    try {
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The page didn't load within ${PAGE_LIMITS.loadMs / 1000} seconds.`)), PAGE_LIMITS.loadMs); });
      try {
        await Promise.race([win.loadURL(url), timeout]);
      } catch (error) {
        // A redirect or a slow subresource can reject loadURL even though the page is there.
        if (!contents.getURL() || contents.getURL() === "about:blank") throw new Error(`The page couldn't be opened: ${error.message}`);
      } finally {
        clearTimeout(timer);
      }
      if (waitFor) {
        const deadline = Date.now() + PAGE_LIMITS.waitForMs;
        let found = false;
        while (Date.now() < deadline && !found) {
          found = await contents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(waitFor)}))`, true).catch(() => false);
          if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!found) throw new Error(`“${waitFor}” didn't appear on the page within ${PAGE_LIMITS.waitForMs / 1000} seconds.`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, PAGE_LIMITS.settleMs));
      }
      const page = await contents.executeJavaScript(EXTRACT(PAGE_LIMITS), true);
      let image = null;
      if (screenshot) {
        const captured = await contents.capturePage();
        if (!captured.isEmpty()) {
          const size = captured.getSize();
          const jpeg = (size.width > 1280 ? captured.resize({ width: 1280 }) : captured).toJPEG(70);
          if (jpeg.length <= PAGE_LIMITS.screenshotBytes) image = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
        }
      }
      return { ...page, status, loadedInMs: Date.now() - started, ...(screenshot ? { screenshot: image } : {}) };
    } finally {
      win.destroy();
      pageSession.clearStorageData().catch(() => {});
    }
  };
}
