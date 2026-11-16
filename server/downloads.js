"use strict";

/**
 * Download links on HANNAH's own domain.
 *
 *   GET /download/:package   for example /download/android or /download/macos-arm64
 *
 * The installers are published as GitHub release assets (100 MB or more, too
 * large to serve from a serverless function). This route finds the newest
 * published release that actually contains the requested package and
 * redirects the browser straight to the file, so the download starts without
 * showing a GitHub page. Older releases used other file names (for example
 * "Shanaya-Android.apk"), so each package also has fallback patterns.
 *
 * If no release has the package, it answers with a short page that says so
 * instead of GitHub's 404.
 */
const express = require("express");

const REPOSITORY = (process.env.HANNAH_RELEASES_REPOSITORY || "HarshTambade/Shanaya-Your-AI-companion").trim();
const CACHE_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const RELEASE_LOOKBACK = 10;

/** Exact name the release workflow publishes first, then older or looser names. */
const PACKAGES = {
  android: { label: "Android APK", exact: "HANNAH-Android.apk", patterns: [/android.*\.apk$/i, /\.apk$/i] },
  "macos-arm64": { label: "macOS (Apple silicon)", exact: "HANNAH-macOS-AppleSilicon.dmg", patterns: [/(arm64|apple ?silicon).*\.dmg$/i, /^(?!.*(x64|intel)).*\.dmg$/i] },
  "macos-intel": { label: "macOS (Intel)", exact: "HANNAH-macOS-Intel.dmg", patterns: [/(x64|intel).*\.dmg$/i] },
  windows: { label: "Windows installer", exact: "HANNAH-Windows.exe", patterns: [/win.*\.exe$/i, /\.exe$/i] },
  "linux-appimage": { label: "Linux AppImage", exact: "HANNAH-Linux.AppImage", patterns: [/\.AppImage$/i] },
  "linux-deb": { label: "Linux .deb", exact: "HANNAH-Linux.deb", patterns: [/\.deb$/i] },
};

function pickAsset(releases, spec) {
  const published = releases.filter((release) => release && !release.draft && !release.prerelease && Array.isArray(release.assets));
  for (const release of published) {
    const exact = release.assets.find((asset) => asset.name === spec.exact);
    if (exact) return { release, asset: exact };
  }
  for (const release of published) {
    for (const pattern of spec.patterns) {
      const asset = release.assets.find((item) => pattern.test(item.name) && !/\.(blockmap|yml|sig|asc)$/i.test(item.name));
      if (asset) return { release, asset };
    }
  }
  return null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function unavailablePage(label, releasesUrl) {
  const title = `${escapeHtml(label)} isn't available yet`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · HANNAH</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef0f4;color:#0f172a;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:32rem;margin:1rem;padding:2rem;border-radius:1.5rem;background:#fff;box-shadow:0 24px 60px -34px rgba(38,44,74,.35)}h1{margin:0 0 .5rem;font-size:1.4rem}p{margin:.5rem 0;color:#475569}a{color:#0369a1;font-weight:600}</style></head>
<body><main><h1>${title}</h1><p>No published HANNAH release includes this package right now. It may still be building, or this platform isn't packaged yet.</p><p><a href="/#download">Back to downloads</a> · <a href="${escapeHtml(releasesUrl)}" rel="noreferrer">All releases</a></p></main></body></html>`;
}

/**
 * @param {{ fetchImpl?: typeof fetch, repository?: string, token?: string, now?: () => number }} [options]
 */
function createDownloadRouter(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const repository = options.repository || REPOSITORY;
  const token = (options.token ?? process.env.GITHUB_TOKEN ?? "").trim();
  const now = options.now || Date.now;
  const releasesUrl = `https://github.com/${repository}/releases`;
  let cache = { at: 0, ttl: 0, releases: null };

  async function releases() {
    if (cache.releases && now() - cache.at < cache.ttl) return cache.releases;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=${RELEASE_LOOKBACK}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "HANNAH-Downloads",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const list = await response.json();
      if (!Array.isArray(list)) throw new Error("Unexpected GitHub response");
      cache = { at: now(), ttl: CACHE_MS, releases: list };
    } catch (error) {
      // Keep serving the last good list; otherwise remember the failure briefly.
      if (cache.releases) {
        cache = { ...cache, at: now(), ttl: FAILURE_CACHE_MS };
      } else {
        cache = { at: now(), ttl: FAILURE_CACHE_MS, releases: null };
        throw error;
      }
    }
    return cache.releases;
  }

  const router = express.Router();

  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ packages: Object.entries(PACKAGES).map(([id, spec]) => ({ id, label: spec.label, path: `/download/${id}` })) });
  });

  router.get("/:package", async (req, res) => {
    const spec = Object.prototype.hasOwnProperty.call(PACKAGES, req.params.package) ? PACKAGES[req.params.package] : null;
    if (!spec) return res.status(404).type("html").send(unavailablePage("That package", releasesUrl));
    let match = null;
    try {
      match = pickAsset(await releases(), spec);
    } catch {
      // GitHub's API is unreachable or rate-limited: its own "latest" link still works for current names.
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, `${releasesUrl}/latest/download/${spec.exact}`);
    }
    if (!match) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).type("html").send(unavailablePage(spec.label, releasesUrl));
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-HANNAH-Release", String(match.release.tag_name || ""));
    return res.redirect(302, match.asset.browser_download_url);
  });

  return router;
}

module.exports = { createDownloadRouter, pickAsset, PACKAGES };
