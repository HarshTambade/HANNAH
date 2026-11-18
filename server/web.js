"use strict";

/**
 * The web for HANNAH on every platform (the desktop app also has its own
 * visible browser, see client/src/services/BrowserTools.ts):
 *
 *   POST /api/web/search  { query }  → { answer, sources: [{ title, url }], model }
 *     Groq's built-in browser search (GPT-OSS models) with the request's own
 *     Groq key: Groq searches and reads pages server-side and answers with
 *     citations. Nothing else to set up.
 *   POST /api/web/read    { url }    → { url, title, text, truncated }
 *     Fetches a public page through the SSRF-safe client (no internal
 *     addresses, size and time limits) and returns its readable text.
 *
 * Page text is data for the model, never instructions (the agent's system
 * prompt says so; the client labels it too).
 */
const express = require("express");
const { RequestBlockedError, safeRequest } = require("./workflows/http");

const SEARCH_MODEL = process.env.WEB_SEARCH_MODEL || "openai/gpt-oss-20b";
const MAX_TEXT = 20_000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Readable text from HTML: drops scripts, styles, navigation and markup; keeps headings, paragraphs and list items as lines. */
function htmlToText(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim());
  let body = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] || /<article[\s\S]*?<\/article>/i.exec(html)?.[0] || /<body[\s\S]*<\/body>/i.exec(html)?.[0] || html;
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt|figcaption)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level) => `\n${"#".repeat(Number(level))} `)
    .replace(/<[^>]+>/g, " ");
  const text = decode(body).split("\n").map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim()).filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");
  return { title, text };
}

/** Sources from Groq's executed tools when present, else the URLs cited in the answer. */
function sourcesFrom(message) {
  const sources = [];
  const seen = new Set();
  const add = (url, title) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || seen.has(url) || sources.length >= 10) return;
    seen.add(url);
    sources.push({ title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : new URL(url).host, url });
  };
  for (const tool of Array.isArray(message?.executed_tools) ? message.executed_tools : []) {
    const results = tool?.search_results?.results || tool?.search_results || tool?.results || [];
    if (Array.isArray(results)) for (const result of results) add(result?.url, result?.title);
  }
  for (const match of String(message?.content || "").matchAll(/https?:\/\/[^\s)\]>"'】]+/g)) add(match[0].replace(/[.,;:]+$/, ""));
  return sources;
}

function createWebRouter({ getRequestProvider, fetchImpl = (...args) => fetch(...args) } = {}) {
  const router = express.Router();
  const json = express.json({ limit: "64kb" });
  const hits = new Map();
  const limited = (req, max) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.at > 60_000) { hits.set(key, { at: now, n: 1 }); return false; }
    entry.n += 1;
    if (hits.size > 5000) hits.clear();
    return entry.n > max;
  };

  router.post("/web/search", json, async (req, res) => {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query || query.length > 500) return res.status(400).json({ error: "Give a search query (up to 500 characters).", reason: "invalid" });
    if (limited(req, 20)) return res.status(429).json({ error: "Too many searches. Wait a minute.", reason: "rate-limited" });
    let target;
    try {
      target = getRequestProvider(req, "groq");
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message, reason: error.reason || "no-key" });
    }
    if (!target?.apiKey) return res.status(400).json({ error: "Web search uses Groq: connect with your Groq key.", reason: "no-key" });
    try {
      const response = await fetchImpl(`${target.provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: SEARCH_MODEL,
          messages: [
            { role: "system", content: "Search the web to answer. Reply in a few short paragraphs or bullets with the facts found, newest first when it matters, and name each source with its full URL. Say plainly if the search found nothing reliable." },
            { role: "user", content: query },
          ],
          tools: [{ type: "browser_search" }],
          tool_choice: "required",
          reasoning_effort: "low",
          max_completion_tokens: 1500,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = response.status === 429 ? 429 : response.status === 401 ? 401 : 502;
        if (status === 429 && response.headers.get("retry-after")) res.setHeader("Retry-After", response.headers.get("retry-after"));
        return res.status(status).json({ error: status === 429 ? "Groq is busy right now. Try the search again in a moment." : status === 401 ? "Groq rejected the key." : `Web search failed (Groq answered ${response.status}).`, reason: status === 429 ? "rate-limited" : "upstream" });
      }
      const message = body?.choices?.[0]?.message || {};
      const answer = String(message.content || "").trim();
      if (!answer) return res.status(502).json({ error: "The search came back empty. Try different words.", reason: "empty" });
      res.json({ answer: answer.slice(0, 12_000), sources: sourcesFrom(message), model: body.model || SEARCH_MODEL });
    } catch (error) {
      res.status(502).json({ error: error?.name === "TimeoutError" ? "The search took too long." : "Web search couldn't reach Groq.", reason: "upstream" });
    }
  });

  router.post("/web/read", json, async (req, res) => {
    const raw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!raw || raw.length > 2048) return res.status(400).json({ error: "Give the page's URL.", reason: "invalid" });
    if (limited(req, 30)) return res.status(429).json({ error: "Too many pages. Wait a minute.", reason: "rate-limited" });
    try {
      const page = await safeRequest(raw, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HANNAH/1.0; +https://hannah.eliteforums.in)", Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" }, timeoutMs: 20_000, maxBytes: 3 * 1024 * 1024 });
      if (page.status >= 400) return res.status(502).json({ error: `The page answered ${page.status}.`, reason: "upstream" });
      const type = String(page.headers["content-type"] || "");
      if (!/html|text\/plain|xml|json/i.test(type)) return res.status(415).json({ error: `That's a ${type.split(";")[0] || "file"}, not a page HANNAH can read.`, reason: "unsupported" });
      const source = page.body.toString("utf8");
      const { title, text } = /html|xml/i.test(type) ? htmlToText(source) : { title: "", text: source };
      res.json({ url: page.url, title, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT || page.truncated });
    } catch (error) {
      if (error instanceof RequestBlockedError) return res.status(400).json({ error: error.message, reason: "blocked" });
      res.status(502).json({ error: error?.code === "timeout" ? "The page took too long to answer." : "Couldn't load that page.", reason: "upstream" });
    }
  });

  return router;
}

module.exports = { createWebRouter, htmlToText, sourcesFrom };
