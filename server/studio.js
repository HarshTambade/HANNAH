"use strict";

/**
 * Research and Document Studio over HTTP.
 *
 * For anyone who can chat (their own key, an account, or the operator):
 *   POST /api/research            { question, mode, previous? }            event stream → result
 *   POST /api/documents/compose   { request, formats?, context?, options?, base?, revises? }   event stream → files
 *   POST /api/documents/create    { format | formats, spec }               files, from a ready description
 *   POST /api/documents/read      { name, data }                           what was read from an uploaded file
 *   POST /api/documents/convert   { name, data, to }                       the same content in another format
 *
 * For signed-in accounts (their own rows only):
 *   GET    /api/account/documents                 list, newest first
 *   GET    /api/account/documents/:id             its record and description
 *   GET    /api/account/documents/:id/download    the file
 *   PATCH  /api/account/documents/:id             { keep }  keep it, or let it expire after 30 days
 *   DELETE /api/account/documents/:id
 *   GET    /api/account/research, GET/DELETE /api/account/research/:id
 *
 * The two long-running routes stream what they are doing as server-sent
 * events: each event is a step that really happened (a search that ran, a page
 * that was opened or refused, a section being written), then one "result" or
 * "error" event. Files come back as base64 in the result, and are also kept
 * in the account when the caller has one, so they can be fetched again.
 *
 * `data` is the file's bytes as base64. Uploaded files are read in memory and
 * never written to disk or kept.
 */
const express = require("express");
const { getDatabase, databaseConfigured } = require("./db");
const { FORMATS, convertFile, createDocument } = require("./documents");
const { composeDocument } = require("./documents/compose");
const { MAX_BYTES, readFile } = require("./documents/read");
const store = require("./documents/store");
const { createAsk, patient } = require("./llm");
const { MODES, methodology, runResearch } = require("./research/engine");
const { createProviders } = require("./research/providers");

const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });

function decode(body) {
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
  const data = typeof body?.data === "string" ? body.data.replace(/^data:[^;,]*;base64,/, "") : "";
  if (!name || !data) throw fail(400, "Send the file's name and its contents.", "bad-request");
  if (data.length > MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 2000))) throw fail(413, `Files up to ${Math.floor(MAX_BYTES / 1024 / 1024)} MB can be read.`, "too-large");
  return { name, buffer: Buffer.from(data, "base64") };
}

/** A generated file as the client receives it. */
const outgoing = (file, saved) => ({
  ...(saved ? { id: saved.id, version: saved.version, familyId: saved.familyId, expiresAt: saved.expiresAt } : {}),
  name: file.name, format: file.format, label: FORMATS[file.format].label, mime: file.mime, bytes: file.bytes,
  data: file.buffer.toString("base64"), summary: file.summary, checks: file.validation.checks,
  ...(file.source ? { source: file.source } : {}),
});

function createStudioRouter({ getRequestProvider, preferredProviderId, timeoutMs = 90_000, providers = createProviders(), request } = {}) {
  const router = express.Router();
  const account = (res) => (res.locals.hannahAccount && databaseConfigured() ? res.locals.hannahAccount : null);
  const database = async () => getDatabase().catch(() => null);

  /** Keep the file in the caller's account when they have one. Never fails the request: the file is in the response either way. */
  async function keep(res, file, extra) {
    const user = account(res);
    if (!user) return null;
    try {
      const db = await database();
      return db ? await store.saveDocument(db, user.id, { file, ...extra }) : null;
    } catch (error) {
      return { notSaved: error.status ? error.message : "The file couldn't be kept in your account; download it now." };
    }
  }
  const send = (res, error, fallback) => {
    if (!error.status) console.error(`Studio request failed (${error?.code || error?.name || "error"}).`);
    res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.reason ? { reason: error.reason } : {}), ...(error.validation ? { checks: error.validation.checks } : {}) });
  };

  /** Start an event stream; resolves helpers to write events and to finish. */
  function stream(req, res) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    let open = true;
    const beat = setInterval(() => { if (open) res.write(": still working\n\n"); }, 15_000);
    res.on("close", () => { open = false; clearInterval(beat); });
    return {
      emit: (event) => { if (open) res.write(`data: ${JSON.stringify(event)}\n\n`); },
      end: () => { clearInterval(beat); if (open) { open = false; res.end(); } },
      get closed() { return !open; },
    };
  }
  const describe = (error) => ({ type: "error", message: error.status || error.code ? error.message : "Something went wrong on the server while doing this.", reason: error.reason || error.code || "failed", ...(error.validation ? { checks: error.validation.checks } : {}) });

  function modelFor(req, res, emit) {
    const ask = createAsk({ req, res, getRequestProvider, preferredProviderId, timeoutMs, providerId: req.body?.provider, model: req.body?.model, budgetUsd: req.body?.budget?.dailyUsd });
    return patient(ask, { emit });
  }

  router.post("/research", async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    const mode = MODES[req.body?.mode] ? req.body.mode : "quick";
    if (question.length < 3 || question.length > 2000) return res.status(400).json({ error: "Ask a question to research (up to 2,000 characters).", reason: "bad-request" });
    let ask;
    let groq = null;
    // The model caller reports its waits through the stream, which opens only once the caller is known to have a model.
    const progress = { emit: () => {} };
    try {
      ask = modelFor(req, res, (event) => progress.emit(event));
      try { const target = getRequestProvider(req, "groq"); if (target?.apiKey) groq = { baseUrl: target.provider.baseUrl, apiKey: target.apiKey }; } catch { groq = null; }
    } catch (error) {
      return send(res, error, "Research couldn't start.");
    }
    const channel = stream(req, res);
    progress.emit = channel.emit;
    try {
      const result = await runResearch({ question, mode, previous: req.body?.previous && typeof req.body.previous === "object" ? req.body.previous : null, services: { ask, providers, context: { groq }, request }, emit: channel.emit });
      result.methodology = methodology(result);
      const user = account(res);
      if (user && result.sources.length) { const db = await database(); if (db) await store.saveResearch(db, user.id, result).catch(() => null); }
      channel.emit({ type: "result", result });
    } catch (error) {
      channel.emit(describe(error));
    }
    channel.end();
  });

  router.post("/documents/compose", async (req, res) => {
    const body = req.body || {};
    if (typeof body.request !== "string" || !body.request.trim()) return res.status(400).json({ error: "Say what document you want.", reason: "bad-request" });
    let ask;
    const progress = { emit: () => {} };
    try { ask = modelFor(req, res, (event) => progress.emit(event)); } catch (error) { return send(res, error, "The document couldn't be started."); }
    const channel = stream(req, res);
    progress.emit = channel.emit;
    try {
      let base = body.base && typeof body.base === "object" ? body.base : null;
      const user = account(res);
      // "Revise the deck you made": the description kept with the file is the starting point.
      if (!base && typeof body.revises === "string" && user) { const db = await database(); const previous = db ? await store.getDocument(db, user.id, body.revises) : null; if (previous?.spec) base = previous.spec; }
      const made = await composeDocument({ request: body.request, formats: Array.isArray(body.formats) ? body.formats : undefined, context: body.context && typeof body.context === "object" ? body.context : {}, options: body.options && typeof body.options === "object" ? body.options : {}, base, ask, emit: channel.emit });
      const files = [];
      for (const file of made.files) {
        const saved = await keep(res, file, { spec: file.format === "xlsx" ? file.model : made.spec, source: base ? "revision" : "chat", request: body.request, revises: typeof body.revises === "string" ? body.revises : null });
        files.push({ ...outgoing(file, saved?.id ? saved : null), ...(saved?.notSaved ? { notSaved: saved.notSaved } : {}) });
      }
      channel.emit({ type: "result", files, spec: made.spec, notes: made.notes, ...(made.changed ? { changed: made.changed } : {}) });
    } catch (error) {
      channel.emit(describe(error));
    }
    channel.end();
  });

  router.post("/documents/create", async (req, res) => {
    try {
      const formats = (Array.isArray(req.body?.formats) ? req.body.formats : [req.body?.format]).filter((format, index, all) => FORMATS[format] && all.indexOf(format) === index);
      if (!formats.length || !req.body?.spec || typeof req.body.spec !== "object") throw fail(400, "Send a format (pptx, pdf, docx or xlsx) and the document description.", "bad-request");
      const files = [];
      for (const format of formats) {
        const file = await createDocument({ format, spec: req.body.spec });
        const saved = await keep(res, file, { spec: file.model, source: "api", request: "", revises: typeof req.body.revises === "string" ? req.body.revises : null });
        files.push({ ...outgoing(file, saved?.id ? saved : null), ...(saved?.notSaved ? { notSaved: saved.notSaved } : {}) });
      }
      res.json({ files });
    } catch (error) {
      send(res, error, "The document couldn't be made.");
    }
  });

  router.post("/documents/read", async (req, res) => {
    try {
      const { name, buffer } = decode(req.body);
      const read = await readFile(buffer, name, { maxText: 120_000 });
      // Tables travel whole up to 2,000 rows each; beyond that the coverage notes say so.
      const tables = read.tables.map((table) => ({ ...table, rows: table.rows.slice(0, 2000) }));
      const notes = [...read.coverage.notes, ...read.tables.filter((table) => table.rows.length > 2000).map((table) => `“${table.name}” has ${table.rows.length.toLocaleString("en")} rows; the first 2,000 are used.`)];
      res.json({ ...read, tables, coverage: { ...read.coverage, truncated: read.coverage.truncated || notes.length > read.coverage.notes.length, notes } });
    } catch (error) {
      send(res, error, "The file couldn't be read.");
    }
  });

  router.post("/documents/convert", async (req, res) => {
    try {
      const { name, buffer } = decode(req.body);
      if (!FORMATS[req.body?.to]) throw fail(400, "Choose what to convert to: pptx, pdf, docx or xlsx.", "bad-request");
      const file = await convertFile({ buffer, name, to: req.body.to, title: typeof req.body.title === "string" ? req.body.title.slice(0, 200) : undefined });
      const saved = await keep(res, file, { spec: file.model, source: "conversion", request: `Converted from ${name}` });
      res.json({ files: [{ ...outgoing(file, saved?.id ? saved : null), ...(saved?.notSaved ? { notSaved: saved.notSaved } : {}) }] });
    } catch (error) {
      send(res, error, "The file couldn't be converted.");
    }
  });

  const withUser = (handler) => async (req, res) => {
    const user = res.locals.hannahAccount;
    if (!user) return res.status(401).json({ error: "Sign in to keep files and research in your account.", reason: "signin-required" });
    const db = await database();
    if (!db) return res.status(503).json({ error: "Saved files need the account database.", reason: "no-database" });
    try { return await handler(req, res, db, user); } catch (error) { return send(res, error, "That request failed."); }
  };

  router.get("/account/documents", withUser(async (_req, res, db, user) => res.json({ documents: await store.listDocuments(db, user.id), keepDays: Math.round(store.KEEP_MS / 86_400_000) })));
  router.get("/account/documents/:id", withUser(async (req, res, db, user) => {
    const found = await store.getDocument(db, user.id, req.params.id);
    if (!found) throw fail(404, "That file isn't in your account (it may have expired or been deleted).", "not-found");
    const record = { ...found };
    delete record.buffer;
    res.json({ document: record });
  }));
  router.get("/account/documents/:id/download", withUser(async (req, res, db, user) => {
    const found = await store.getDocument(db, user.id, req.params.id);
    if (!found) throw fail(404, "That file isn't in your account (it may have expired or been deleted).", "not-found");
    res.setHeader("Content-Type", found.mime);
    res.setHeader("Content-Disposition", `attachment; filename="${found.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(found.name)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(found.buffer);
  }));
  router.patch("/account/documents/:id", withUser(async (req, res, db, user) => {
    if (typeof req.body?.keep !== "boolean") throw fail(400, "Send { keep: true } to keep the file, or { keep: false } to let it expire.", "bad-request");
    const updated = await store.setKept(db, user.id, req.params.id, req.body.keep);
    if (!updated) throw fail(404, "That file isn't in your account.", "not-found");
    res.json({ document: updated });
  }));
  router.delete("/account/documents/:id", withUser(async (req, res, db, user) => {
    if (!(await store.deleteDocument(db, user.id, req.params.id))) throw fail(404, "That file isn't in your account.", "not-found");
    res.json({ ok: true });
  }));
  router.get("/account/research", withUser(async (_req, res, db, user) => res.json({ research: await store.listResearch(db, user.id) })));
  router.get("/account/research/:id", withUser(async (req, res, db, user) => {
    const found = await store.getResearch(db, user.id, req.params.id);
    if (!found) throw fail(404, "That research isn't in your account.", "not-found");
    res.json({ result: found });
  }));
  router.delete("/account/research/:id", withUser(async (req, res, db, user) => {
    if (!(await store.deleteResearch(db, user.id, req.params.id))) throw fail(404, "That research isn't in your account.", "not-found");
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createStudioRouter };
