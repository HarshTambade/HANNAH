"use strict";

/**
 * Document Studio: one way in for making and converting documents.
 *
 *   createDocument({ format, spec })    a document or workbook description → a validated file
 *   convertFile({ buffer, name, to })   a file the person gave → the same content in another format
 *
 * Nothing leaves here unvalidated: a file that doesn't open again, has a
 * broken formula or has an over-full slide is an error, not a download.
 */
const { normalizeDocument, outline, tablesAsWorkbook } = require("./model");
const { renderDocx } = require("./docx");
const { renderPdf } = require("./pdf");
const { renderPptx } = require("./pptx");
const { isLiteral, literal, normalizeWorkbook, renderXlsx } = require("./xlsx");
const { readFile } = require("./read");
const { validateFile } = require("./validate");

const FORMATS = {
  pptx: { label: "PowerPoint", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  pdf: { label: "PDF", mime: "application/pdf" },
  docx: { label: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { label: "Excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
};
const RENDER = { pptx: renderPptx, pdf: renderPdf, docx: renderDocx, xlsx: renderXlsx };

const fail = (message, reason, extra = {}) => Object.assign(new Error(message), { status: 422, reason, ...extra });
function fileName(title, format) {
  const base = String(title || "Document").normalize("NFKD").replace(/[^\p{L}\p{N} _.-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Document";
  return `${base}.${format}`;
}

/**
 * Make one file. `spec` is a document description for pptx, pdf and docx, and a
 * workbook description for xlsx (a document description is also accepted for
 * xlsx: its tables and chart data become sheets).
 */
async function createDocument({ format, spec }) {
  if (!FORMATS[format]) throw Object.assign(new Error("Choose pptx, pdf, docx or xlsx."), { status: 400, reason: "unknown-format" });
  let input = spec;
  if (format === "xlsx" && !Array.isArray(spec?.sheets)) {
    input = tablesAsWorkbook(normalizeDocument(spec));
    if (!input) throw fail("There are no tables or chart data in this document to put in a workbook.", "no-tables");
  }
  if (format !== "xlsx" && Array.isArray(spec?.sheets)) input = documentFromWorkbook(spec);
  const { buffer, report, model } = await RENDER[format](input);
  const validation = await validateFile(format, buffer, { report, model });
  if (!validation.ok) {
    const failed = validation.checks.filter((check) => !check.ok);
    throw fail(`The ${FORMATS[format].label} file didn't pass its checks: ${failed.map((check) => `${check.name} (${check.detail})`).join("; ")}`, "validation-failed", { validation, report });
  }
  return {
    buffer, format, mime: FORMATS[format].mime, name: fileName(model.title, format), bytes: buffer.length, model, report, validation,
    summary: format === "xlsx" ? { title: model.title, sheets: report.sheets, formulas: report.formulas, charts: report.charts, formulasNotChecked: report.formulasNotChecked.length } : { ...outline(model), ...(format === "pptx" ? { slides: report.slides.length } : {}), ...(format === "pdf" ? { pages: report.pages } : {}) },
  };
}

/** A workbook description as a document: one section per sheet, computed values in place of formulas. */
function documentFromWorkbook(spec) {
  const workbook = normalizeWorkbook(spec);
  const { evaluateWorkbook } = require("./formulas");
  const grids = workbook.sheets.map((sheet) => [sheet.columns.map((column) => column.header), ...sheet.rows]);
  const evaluated = evaluateWorkbook(workbook.sheets.map((sheet, index) => ({ name: sheet.name, grid: grids[index] })));
  return {
    title: workbook.title, theme: workbook.theme,
    sections: workbook.sheets.map((sheet, index) => ({
      heading: sheet.name,
      blocks: [{ type: "table", columns: sheet.columns.map((column) => column.header), rows: sheet.rows.slice(0, 300).map((row, at) => row.map((cell, col) => (isLiteral(cell) ? cell.text : typeof cell === "string" && cell.startsWith("=") ? evaluated.values[index][at + 1]?.[col] ?? "" : cell))) }],
    })),
  };
}

/** What was read from a file, as a document description: headings become sections, tables stay tables. */
function documentFromExtraction(extraction, { title } = {}) {
  const sections = [];
  let current = null;
  const open = (heading, level = 1) => { current = { heading, level: level > 1 ? 2 : 1, blocks: [] }; sections.push(current); return current; };
  let bullets = null;
  const tables = new Map(extraction.tables.map((table, index) => [index + 1, table]));
  const placed = new Set();
  for (const raw of extraction.text.split("\n")) {
    const line = raw.trim();
    if (!line) { bullets = null; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // "Slide 3: Results" → "Results"; "Sheet: Sales (12 rows × 4 columns)" → "Sales".
      const name = heading[2].replace(/^Slide \d+: /, "").replace(/^Sheet: (.*?) \(\d+ rows × \d+ columns\)$/, "$1").replace(/^\d+ rows × \d+ columns$/, "Data");
      open(name.slice(0, 160), extraction.kind === "pptx" ? 1 : heading[1].length);
      bullets = null;
      continue;
    }
    const target = current || open(extraction.kind === "xlsx" || extraction.kind === "csv" ? "Data" : "Overview");
    const marker = /^\[Table (\d+):/.exec(line);
    if (marker && tables.has(Number(marker[1]))) { const table = tables.get(Number(marker[1])); placed.add(Number(marker[1])); target.blocks.push({ type: "table", columns: table.columns, rows: table.rows.slice(0, 400), caption: "" }); bullets = null; continue; }
    const item = /^(?:[•\-*–]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { if (!bullets) { bullets = { type: "bullets", items: [] }; target.blocks.push(bullets); } bullets.items.push(item[1]); continue; }
    bullets = null;
    if (/^Speaker notes: /.test(line)) { target.notes = `${target.notes ? `${target.notes} ` : ""}${line.slice(15)}`; continue; }
    // Spreadsheet text is a preview of the tables below; the tables themselves carry the data.
    if ((extraction.kind === "xlsx" || extraction.kind === "csv") && (line.includes(" | ") || /^(…|Formulas:)/.test(line))) continue;
    target.blocks.push({ type: "paragraph", text: line });
  }
  extraction.tables.forEach((table, index) => {
    if (placed.has(index + 1)) return;
    const home = sections.find((section) => section.heading.includes(table.name)) || open(table.name);
    home.blocks.push({ type: "table", columns: table.columns, rows: table.rows.slice(0, 400), caption: "" });
  });
  const kept = sections.filter((section) => section.blocks.length || section.notes);
  return {
    title: title || extraction.meta?.title || String(extraction.name).replace(/\.[^.]+$/, ""),
    subtitle: `Converted from ${extraction.name}`,
    sections: kept.length ? kept : [{ heading: "Content", blocks: [{ type: "paragraph", text: extraction.text.slice(0, 6000) || "This file had no readable text." }] }],
  };
}

/**
 * The content of a file in another format. The words, headings and tables are
 * kept; the layout is HANNAH's, not a copy of the original's. The original
 * file is never changed. Resolves to the new file plus what was (and wasn't) read.
 */
async function convertFile({ buffer, name, to, title }) {
  const extraction = await readFile(buffer, name);
  if (extraction.coverage.read === 0) throw fail(extraction.coverage.notes[0] || "Nothing in this file could be read.", "nothing-read");
  let spec;
  if (to === "xlsx") {
    if (!extraction.tables.length) throw fail("This file has no tables to put in a workbook.", "no-tables");
    spec = { title: title || String(name).replace(/\.[^.]+$/, ""), sheets: extraction.tables.slice(0, 12).map((table) => ({ name: table.name, columns: table.columns.map((header) => ({ header })), rows: table.rows.map((row) => row.map(literal)) })) };
  } else {
    spec = documentFromExtraction(extraction, { title });
  }
  const file = await createDocument({ format: to, spec });
  return { ...file, source: { name: extraction.name, kind: extraction.kind, coverage: extraction.coverage } };
}

module.exports = { FORMATS, convertFile, createDocument, documentFromExtraction, documentFromWorkbook, fileName };
