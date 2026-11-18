"use strict";

/**
 * Self-hosting (Docker, a VPS): serve the built web app from the same server.
 * Off unless HANNAH_SERVE_CLIENT names a built client folder (client/dist).
 * On Vercel the client is served by Vercel itself.
 *
 * - Files are served as they are; hashed assets (/assets/…) are cached for a year.
 * - Page routes (/chat, /marketplace …) get their prerendered page
 *   (<route>/index.html) if the build made one, otherwise index.html.
 * - Never shadows the server: /api, /v1, /mcp, /download, /.well-known, /a2a
 *   and /hooks are left to their own routers (and their 404s).
 */
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const RESERVED = /^\/(?:api|v1|mcp|download|\.well-known|a2a|hooks)(?:\/|$)/;

function serveClient(directory) {
  const root = path.resolve(directory);
  const indexFile = path.join(root, "index.html");
  if (!fs.existsSync(indexFile)) throw new Error(`HANNAH_SERVE_CLIENT is set, but ${root} has no index.html. Build the client first (cd client && npm run build).`);
  const router = express.Router();
  const files = express.static(root, {
    index: false,
    redirect: false,
    fallthrough: true,
    setHeaders(res, file) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  });
  router.use((req, res, next) => (RESERVED.test(req.path) ? next() : files(req, res, next)));
  router.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || RESERVED.test(req.path)) return next();
    // A prerendered page for this route, if the build made one; never outside the folder.
    let page = indexFile;
    try {
      const candidate = path.resolve(root, `.${decodeURIComponent(req.path)}`, "index.html");
      if (candidate.startsWith(root + path.sep) && fs.existsSync(candidate)) page = candidate;
    } catch {
      return next();
    }
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(page);
  });
  return router;
}

module.exports = { serveClient, RESERVED };
