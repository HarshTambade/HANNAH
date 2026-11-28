"use strict";

/**
 * Shared conversation links.
 *
 * Chat history lives on the person's device. A link is made only when a
 * signed-in person picks messages and presses Publish: the client uploads that
 * snapshot, and the server keeps exactly that copy. Later messages are never
 * added; sharing again makes a new link. Revoking deletes the row, so the page
 * stops working on the next request (the page is sent with no-store).
 *
 * The public page (/s/<id>) is rendered here with no scripts at all, under a
 * CSP that allows only its own inline stylesheet (by hash). Message text is
 * escaped first and then given the same small Markdown subset as the app's
 * message renderer (client/src/components/MessageContent.tsx): paragraphs,
 * headings, lists, fenced and inline code, bold, italics, http(s) links and
 * numbered citations. Recognizable secrets (API keys, tokens, private keys,
 * "password is …") are masked on the server whatever the client sent.
 */

const express = require("express");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { databaseConfigured, getDatabase } = require("./db");

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_LINKS_PER_ACCOUNT = 100;
const CREATE_LIMIT = { count: 20, windowMs: 60 * 60 * 1000 };

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// ---------- secrets ----------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:gsk|sk|rk|pk|hk|hs)_[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
const PASSWORD_PATTERN = /\b(password|passcode|passwd|pwd|otp|cvv|pin(?!\s*code))(\s*(?:is|=|:|-|was)\s*)\S{3,}/gi;

/** Mask what looks like a key, token or password. Exported for tests. */
function redactSecrets(text) {
  let result = String(text);
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[hidden secret]");
  return result.replace(PASSWORD_PATTERN, (_match, word, joiner) => `${word}${joiner}[hidden secret]`);
}

// ---------- the snapshot ----------

const fail = (status, message) => Object.assign(new Error(message), { status });

function cleanTitle(value) {
  const title = typeof value === "string" ? redactSecrets(value).replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) : "";
  return title || "Shared conversation";
}

function httpUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Check what the client sent and keep only what the person opted in to.
 * Messages: user and assistant text only (no system or tool lines). Research
 * sources and attachment names go in only with include.sources /
 * include.attachments; file contents, memories and tool results never do.
 * Exported for tests.
 */
function normalizeSnapshot(body) {
  const include = { sources: body?.include?.sources === true, attachments: body?.include?.attachments === true };
  const list = body?.messages;
  if (!Array.isArray(list) || list.length < 1) throw fail(400, "Choose at least one message to share.");
  if (list.length > MAX_MESSAGES) throw fail(400, `A shared link holds up to ${MAX_MESSAGES} messages.`);
  const messages = [];
  for (const item of list) {
    if (!item || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") throw fail(400, "Only your messages and HANNAH's replies can be shared.");
    const content = redactSecrets(item.content.trim());
    if (!content) continue;
    if (content.length > MAX_MESSAGE_CHARS) throw fail(400, `One message is over ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`);
    const message = { role: item.role, content };
    if (include.sources && Array.isArray(item.sources)) {
      const sources = item.sources.slice(0, 30).map((source) => {
        const url = httpUrl(source?.url);
        return url ? { url, title: redactSecrets(typeof source.title === "string" ? source.title : url).replace(/[\r\n]+/g, " ").slice(0, 200) } : null;
      });
      if (sources.some(Boolean)) message.sources = sources;
    }
    if (include.attachments && Array.isArray(item.attachments)) {
      const names = item.attachments.filter((name) => typeof name === "string" && name.trim()).slice(0, 10).map((name) => redactSecrets(name).replace(/[\r\n/\\]+/g, " ").trim().slice(0, 120));
      if (names.length) message.attachments = names;
    }
    messages.push(message);
  }
  if (!messages.length) throw fail(400, "Choose at least one message to share.");
  const snapshot = { version: 1, include, messages };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) throw fail(413, "This conversation is over the 512 KB share limit. Share fewer messages.");
  return { title: cleanTitle(body?.title), snapshot, serialized };
}

// ---------- the public page ----------

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const INLINE_PATTERN = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\)|\[\d{1,3}\])/g;
const LINK_ATTRIBUTES = 'rel="noopener noreferrer nofollow ugc" target="_blank"';

function renderInline(text, sources) {
  let html = "";
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    html += escapeHtml(text.slice(lastIndex, match.index));
    const token = match[0];
    const cited = /^\[(\d{1,3})\]$/.exec(token);
    if (cited) {
      const source = sources?.[Number(cited[1]) - 1];
      html += source ? `<a class="cite" href="${escapeHtml(source.url)}" title="${escapeHtml(source.title)}" ${LINK_ATTRIBUTES}>${cited[1]}</a>` : escapeHtml(token);
    } else if (token.startsWith("`")) {
      html += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("**") || token.startsWith("__")) {
      html += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith("[")) {
      const url = httpUrl(match[2]);
      const label = token.slice(1, token.indexOf("]"));
      html += url ? `<a href="${escapeHtml(url)}" ${LINK_ATTRIBUTES}>${escapeHtml(label)}</a>` : escapeHtml(token);
    } else {
      html += `<em>${escapeHtml(token.slice(1, -1))}</em>`;
    }
    lastIndex = match.index + token.length;
  }
  return html + escapeHtml(text.slice(lastIndex));
}

/** The app's Markdown subset, as escaped HTML. Exported for tests. */
function renderMarkdown(source, sources) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) { blocks.push(`<p class="heading">${renderInline(heading[1], sources)}</p>`); index += 1; continue; }
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (index < lines.length && bullet.test(lines[index])) items.push(`<li>${renderInline(lines[index++].replace(bullet, ""), sources)}</li>`);
      blocks.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^\s*```/.test(lines[index]) && !bullet.test(lines[index]) && !/^\s{0,3}#{1,6}\s+/.test(lines[index])) paragraph.push(renderInline(lines[index++], sources));
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return blocks.join("\n");
}

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--you:#eef2ff;--link:#4338ca;--code:#0f172a;--codeink:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--ink:#e5e7eb;--muted:#94a3b8;--line:#1f2937;--you:#1e1b4b;--link:#a5b4fc;--code:#020617;--codeink:#e2e8f0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}header{border-bottom:1px solid var(--line);margin-bottom:24px;padding-bottom:16px}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 6px;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:.875rem;margin:0}
.note{background:var(--card);border:1px solid var(--line);border-radius:12px;color:var(--muted);font-size:.875rem;margin:16px 0 0;padding:10px 14px}
article{background:var(--card);border:1px solid var(--line);border-radius:16px;margin:0 0 14px;padding:14px 18px;overflow-wrap:anywhere}
article.user{background:var(--you)}.who{color:var(--muted);font-size:.75rem;font-weight:600;letter-spacing:.04em;margin:0 0 4px;text-transform:uppercase}
article p{margin:.4em 0}.heading{font-weight:700}ul,ol{margin:.4em 0;padding-left:1.4em}a{color:var(--link)}
a.cite{border-radius:4px;font-size:.8em;font-weight:600;padding:0 3px;text-decoration:none;vertical-align:super}
code{background:rgba(127,127,127,.18);border-radius:4px;font:.875em ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 4px}
pre{background:var(--code);border-radius:10px;color:var(--codeink);overflow-x:auto;padding:10px 12px}pre code{background:none;padding:0}
.files,.sources{color:var(--muted);font-size:.8125rem;margin:8px 0 0}.sources ol{margin:4px 0 0}
footer{color:var(--muted);font-size:.8125rem;margin-top:32px;text-align:center}`;
const PAGE_CSS_HASH = createHash("sha256").update(PAGE_CSS).digest("base64");
const PAGE_CSP = `default-src 'none'; style-src 'sha256-${PAGE_CSS_HASH}'; img-src 'none'; script-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function setPageHeaders(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", PAGE_CSP);
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  // Never cached anywhere, so a revoked link stops working at once.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
${body}
<footer>Shared from HANNAH. A read-only copy; the person who shared it can remove it at any time.</footer>
</main>
</body>
</html>`;
}

/** The public page for one snapshot. Exported for tests. */
function renderSharePage({ title, snapshot, createdAt }) {
  const date = new Date(Number(createdAt)).toISOString().slice(0, 10);
  const messages = snapshot.messages.map((message) => {
    const who = message.role === "user" ? "User" : "HANNAH";
    const files = message.attachments?.length ? `<p class="files">Attached: ${message.attachments.map(escapeHtml).join(", ")} (names only; the files aren't shared)</p>` : "";
    const sources = message.sources?.length
      ? `<div class="sources">Sources<ol>${message.sources.map((source) => (source ? `<li><a href="${escapeHtml(source.url)}" ${LINK_ATTRIBUTES}>${escapeHtml(source.title)}</a></li>` : "<li>(not shared)</li>")).join("")}</ol></div>`
      : "";
    return `<article class="${message.role}"><p class="who">${who}</p>${renderMarkdown(message.content, message.sources)}${files}${sources}</article>`;
  }).join("\n");
  const count = snapshot.messages.length;
  return pageShell(`${title} · Shared from HANNAH`, `<header>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${count} message${count === 1 ? "" : "s"} · shared ${date}</p>
<p class="note">A copy made when this link was created. Messages written after that aren't included. Replies were written by an AI and may be wrong.</p>
</header>
${messages}`);
}

function missingPage(message) {
  return pageShell("Link not available · HANNAH", `<header><h1>This link isn't available</h1><p class="meta">${escapeHtml(message)}</p></header>`);
}

// ---------- routes ----------

function shareUrl(req, id) {
  const configured = String(process.env.HANNAH_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (configured) return `${configured}/s/${id}`;
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("x-forwarded-host") || req.get("host")}/s/${id}`;
}

async function audit(db, userId, event, detail) {
  try {
    await db.query("INSERT INTO hannah_audit (id, user_id, event, detail, created_at) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), userId, event, JSON.stringify(detail).slice(0, 2000), Date.now()]);
  } catch {
    // The audit log never blocks the request.
  }
}

/** Owner routes, mounted under /api: create, list and revoke links. Session only. */
function createShareRouter() {
  const router = express.Router();
  const withSession = (handler) => async (req, res) => {
    if (!databaseConfigured()) return res.status(503).json({ error: "Sharing needs the server's database. The operator can connect one in Integrations → Database.", reason: "database-unconfigured" });
    const account = res.locals.hannahAccount;
    if (!account) return res.status(401).json({ error: "Sign in to share a conversation.", reason: "signin-required" });
    if (account.via !== "session") return res.status(403).json({ error: "Share from the app, not with an API key." });
    try {
      return await handler(req, res, await getDatabase(), account);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error(`Share request failed (${error?.code || error?.name || "error"}).`);
      return res.status(500).json({ error: "The share request couldn't be completed." });
    }
  };

  router.post("/account/shares", withSession(async (req, res, db, account) => {
    const { countInDatabase } = require("./api-security");
    const now = Date.now();
    const counted = await countInDatabase(db, `share-create:${sha256(account.id)}`, CREATE_LIMIT.windowMs, now);
    if (counted.count > CREATE_LIMIT.count) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((counted.resetAt - now) / 1000))));
      return res.status(429).json({ error: `You can make up to ${CREATE_LIMIT.count} links an hour. Try again later.` });
    }
    const { title, snapshot, serialized } = normalizeSnapshot(req.body);
    const { rows } = await db.query("SELECT COUNT(*) AS count FROM hannah_shared_conversations WHERE user_id = $1", [account.id]);
    if (Number(rows[0]?.count) >= MAX_LINKS_PER_ACCOUNT) return res.status(400).json({ error: `You have ${MAX_LINKS_PER_ACCOUNT} shared links. Delete one first.` });
    const id = randomBytes(16).toString("base64url");
    await db.query("INSERT INTO hannah_shared_conversations (id, user_id, title, snapshot, message_count, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, account.id, title, serialized, snapshot.messages.length, now]);
    await audit(db, account.id, "share.created", { id: id.slice(0, 6), messages: snapshot.messages.length });
    res.status(201).json({ id, url: shareUrl(req, id), title, messageCount: snapshot.messages.length, createdAt: now, include: snapshot.include });
  }));

  router.get("/account/shares", withSession(async (req, res, db, account) => {
    const { rows } = await db.query("SELECT id, title, message_count, created_at FROM hannah_shared_conversations WHERE user_id = $1 ORDER BY created_at DESC", [account.id]);
    res.json({ shares: rows.map((row) => ({ id: row.id, url: shareUrl(req, row.id), title: row.title, messageCount: Number(row.message_count), createdAt: Number(row.created_at) })) });
  }));

  router.delete("/account/shares/:id", withSession(async (req, res, db, account) => {
    const id = String(req.params.id || "");
    if (!SHARE_ID_PATTERN.test(id)) return res.status(404).json({ error: "Unknown link." });
    // Only the owner's row matches, so another account's id is "unknown", not "forbidden".
    const result = await db.query("DELETE FROM hannah_shared_conversations WHERE id = $1 AND user_id = $2", [id, account.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Unknown link." });
    await audit(db, account.id, "share.revoked", { id: id.slice(0, 6) });
    res.json({ ok: true, revoked: true });
  }));

  return router;
}

/** The public read-only page, mounted at /s. `limiter` caps page views per network address. */
function createSharePageRouter({ limiter } = {}) {
  const router = express.Router();
  router.get("/:id", ...(limiter ? [limiter] : []), async (req, res) => {
    setPageHeaders(res);
    const id = String(req.params.id || "");
    if (!SHARE_ID_PATTERN.test(id) || !databaseConfigured()) return res.status(404).send(missingPage("It was removed by the person who shared it, or the address is wrong."));
    try {
      const db = await getDatabase();
      const { rows } = await db.query("SELECT title, snapshot, created_at FROM hannah_shared_conversations WHERE id = $1", [id]);
      if (!rows[0]) return res.status(404).send(missingPage("It was removed by the person who shared it, or the address is wrong."));
      return res.send(renderSharePage({ title: rows[0].title, snapshot: JSON.parse(rows[0].snapshot), createdAt: rows[0].created_at }));
    } catch (error) {
      console.error(`Shared page failed (${error?.code || error?.name || "error"}).`);
      return res.status(503).send(missingPage("The server couldn't load it right now. Try again in a moment."));
    }
  });
  return router;
}

/** For the account export: every link with the snapshot it publishes. */
async function exportShares(db, userId) {
  const { rows } = await db.query("SELECT id, title, snapshot, message_count, created_at FROM hannah_shared_conversations WHERE user_id = $1 ORDER BY created_at", [userId]);
  return rows.map((row) => ({ id: row.id, path: `/s/${row.id}`, title: row.title, messageCount: Number(row.message_count), createdAt: Number(row.created_at), snapshot: JSON.parse(row.snapshot) }));
}

module.exports = { createShareRouter, createSharePageRouter, exportShares, normalizeSnapshot, redactSecrets, renderMarkdown, renderSharePage, PAGE_CSP, SHARE_ID_PATTERN };
