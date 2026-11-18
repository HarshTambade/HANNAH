"use strict";

/**
 * "Remember on this browser" for a visitor's own Groq key (the website).
 *
 * The key is kept in an HttpOnly cookie: the page's scripts can't read it (so
 * an injected script can't copy it), it's sent only to this server's /api over
 * HTTPS, and SameSite=Strict keeps other sites from sending it. Each request
 * without its own X-Groq-API-Key header uses the remembered key as if the
 * browser had sent it. The server stores nothing.
 *
 *   GET    /api/session/key   { remembered, hint }   (hint like "gsk_…9f2a")
 *   POST   /api/session/key   remember the key sent in X-Groq-API-Key (30 days)
 *   DELETE /api/session/key   forget it
 */
const express = require("express");
const { parseCookies } = require("./accounts");

const COOKIE = "hannah_groq";
const MAX_AGE_S = 30 * 24 * 60 * 60;
const GROQ_KEY = /^gsk_[A-Za-z0-9]{20,200}$/;

const hintFor = (key) => `gsk_…${key.slice(-4)}`;
const secure = (req) => req.secure || req.get("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production";
function cookie(req, value, maxAge) {
  return [`${COOKIE}=${value}`, "Path=/api", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`, ...(secure(req) ? ["Secure"] : [])].join("; ");
}

/** Use the remembered key when the request didn't send one. Not with the operator token. */
function rememberedKeyMiddleware(req, res, next) {
  const authorization = req.get("authorization") || "";
  if (!req.get("x-groq-api-key") && (!authorization || /^Bearer\s+(hs|hk)_/i.test(authorization))) {
    const value = parseCookies(req.get("cookie"))[COOKIE];
    if (value && GROQ_KEY.test(value)) {
      req.headers["x-groq-api-key"] = value;
      res.locals.hannahRememberedKey = value;
    }
  }
  next();
}

function createRememberedKeyRouter() {
  const router = express.Router();
  router.get("/session/key", (_req, res) => {
    const key = res.locals.hannahRememberedKey;
    res.setHeader("Cache-Control", "no-store");
    res.json(key ? { remembered: true, hint: hintFor(key) } : { remembered: false });
  });
  router.post("/session/key", (req, res) => {
    const key = String(req.get("x-groq-api-key") || "").trim();
    if (!GROQ_KEY.test(key)) return res.status(400).json({ error: "Send the Groq key to remember in X-Groq-API-Key.", reason: "invalid-key" });
    res.setHeader("Set-Cookie", cookie(req, key, MAX_AGE_S));
    res.setHeader("Cache-Control", "no-store");
    res.json({ remembered: true, hint: hintFor(key) });
  });
  router.delete("/session/key", (req, res) => {
    res.setHeader("Set-Cookie", cookie(req, "", 0));
    res.json({ remembered: false });
  });
  return router;
}

module.exports = { COOKIE, createRememberedKeyRouter, rememberedKeyMiddleware };
