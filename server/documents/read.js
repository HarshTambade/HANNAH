"use strict";

/**
 * Reads the files people give HANNAH: PDF, Word, PowerPoint, Excel, CSV, text,
 * Markdown and JSON. Each comes back as plain text plus any tables, with an
 * honest account of how much was read:
 *
 *   { kind, name, text, tables: [{ name, columns, rows }], meta, coverage: { read, total, unit, truncated, notes: [...] } }
 *
 * "truncated" and the notes are what the model is told, so it never claims to
 * have read a whole file when it saw part of it. Scanned PDFs (pictures of
 * pages) have no text layer; that is reported, not guessed at.
 *
 * File contents are data. Nothing in a file is treated as an instruction.
 */
const JSZip = require("jszip");

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 400_000;
const MAX_TABLE_ROWS = 5_000;
const MAX_UNZIPPED = 150 * 1024 * 1024;

const fail = (message, reason = "unreadable") => Object.assign(new Error(message), { status: 400, reason });
const ENTITY = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const unxml = (text) => String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code) => {
  if (code[0] === "#") { const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match; }
  return ENTITY[code.toLowerCase()];
});

function kindOf(name, buffer) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1]?.toLowerCase() || "";
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const zip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (zip && ["docx", "pptx", "xlsx"].includes(ext)) return ext;
  if (zip) return "zip";
  if (["csv", "tsv"].includes(ext)) return "csv";
  if (ext === "json") return "json";
  if (["txt", "md", "markdown", "log", "text", "rtf", "html", "htm", "xml", "yaml", "yml"].includes(ext) || !ext) return "text";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(ext)) return "image";
  if (["doc", "ppt", "xls"].includes(ext)) throw fail(`.${ext} is the old Office format. Save it as .${ext}x and add it again.`, "old-format");
  return "text";
}

/** Text of a buffer, or an error if it's binary. */
function decodeText(buffer) {
  let text = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? buffer.subarray(3).toString("utf8") : buffer.toString("utf8");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  const sample = text.slice(0, 4000);
  const odd = [...sample].filter((char) => char === "\ufffd" || (char < " " && !"\n\r\t\f".includes(char))).length;
  if (sample.length && odd / sample.length > 0.1) throw fail("This file isn't text HANNAH can read.", "binary");
  return text;
}

/** CSV or TSV with quoted fields, into rows. */
function parseDelimited(text) {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const delimiter = [",", "\t", ";", "|"].map((char) => [char, firstLine.split(char).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === "\"" && text[at + 1] === "\"") { field += "\""; at += 1; } else if (char === "\"") quoted = false; else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}
const typed = (cell) => { const value = String(cell ?? "").trim(); return /^-?\d{1,15}(\.\d+)?$/.test(value) ? Number(value) : value; };

async function openZip(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw fail("This file is damaged or isn't the format its name says."); }
  // A small file that unpacks to something enormous is refused before it's unpacked.
  let total = 0;
  zip.forEach((_path, entry) => { total += entry._data?.uncompressedSize || 0; });
  if (total > MAX_UNZIPPED) throw fail("This file unpacks to more than HANNAH will read.", "too-large");
  return zip;
}
const part = async (zip, name) => (zip.file(name) ? zip.file(name).async("string") : "");

async function readDocx(buffer) {
  const zip = await openZip(buffer);
  const xml = await part(zip, "word/document.xml");
  if (!xml) throw fail("This Word file has no document inside.");
  const tables = [];
  const lines = [];
  const textOf = (fragment) => unxml(fragment.replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "").replace(/<[^>]+>/g, ""));
  const body = xml.slice(xml.indexOf("<w:body"));
  // Walk the body in order: paragraphs become lines, tables become tables (and a line saying where they sat).
  const pattern = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const match of body.matchAll(pattern)) {
    const chunk = match[0];
    if (chunk.startsWith("<w:tbl>")) {
      const rows = [...chunk.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((row) => [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((cell) => textOf(cell[0].replace(/<\/w:p>/g, "\n")).trim().replace(/\n+/g, " ")));
      if (rows.length > 1 && tables.length < 40) {
        tables.push({ name: `Table ${tables.length + 1}`, columns: rows[0], rows: rows.slice(1, MAX_TABLE_ROWS + 1).map((row) => row.map(typed)) });
        lines.push(`[Table ${tables.length}: ${rows[0].join(" | ")}]`);
      } else for (const row of rows) lines.push(row.join(" | "));
    } else {
      const style = /<w:pStyle w:val="([^"]+)"/.exec(chunk)?.[1] || "";
      const text = textOf(chunk).trim();
      if (!text) continue;
      const level = /^Heading(\d)$/i.exec(style)?.[1] || (/^Title$/i.test(style) ? "1" : "");
      lines.push(level ? `${"#".repeat(Number(level))} ${text}` : text);
    }
  }
  const title = unxml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(await part(zip, "docProps/core.xml"))?.[1] || "");
  return { text: lines.join("\n"), tables, meta: { title, paragraphs: lines.length }, unit: "paragraphs", total: lines.length };
}

async function readPptx(buffer) {
  const zip = await openZip(buffer);
  const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  if (!names.length) throw fail("This PowerPoint file has no slides inside.");
  const lines = [];
  const tables = [];
  const paragraphs = (xml) => [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((match) => unxml([...match[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((run) => run[1]).join("")).trim()).filter(Boolean);
  for (const [index, name] of names.entries()) {
    const xml = await part(zip, name);
    // The slide's own title, when it has one, names it; the rest of its text follows.
    const title = unxml([.../<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph[^>]*type="(?:title|ctrTitle)"[\s\S]*?<\/p:sp>/.exec(xml)?.[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g) || []].map((run) => run[1]).join("")).trim();
    const body = paragraphs(xml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/g, ""));
    const heading = title || (body[0] && body[0].length <= 90 ? body[0] : "");
    lines.push(`## Slide ${index + 1}${heading ? `: ${heading}` : ""}`);
    for (const frame of xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)) {
      const rows = [...frame[0].matchAll(/<a:tr[ >][\s\S]*?<\/a:tr>/g)].map((row) => [...row[0].matchAll(/<a:tc[ >][\s\S]*?<\/a:tc>/g)].map((cell) => paragraphs(cell[0]).join(" ")));
      if (rows.length > 1 && tables.length < 40) tables.push({ name: `Slide ${index + 1} table`, columns: rows[0], rows: rows.slice(1).map((row) => row.map(typed)) });
    }
    lines.push(...body.filter((line, at) => !(at === 0 && line === heading)));
    const notes = await part(zip, `ppt/notesSlides/notesSlide${/(\d+)\.xml$/.exec(name)[1]}.xml`);
    const noteText = notes ? paragraphs(notes).filter((line) => !/^\d+$/.test(line)).join(" ") : "";
    if (noteText) lines.push(`Speaker notes: ${noteText}`);
  }
  return { text: lines.join("\n"), tables, meta: { slides: names.length }, unit: "slides", total: names.length };
}

async function readXlsx(buffer) {
  const zip = await openZip(buffer);
  const workbook = await part(zip, "xl/workbook.xml");
  if (!workbook) throw fail("This Excel file has no workbook inside.");
  const rels = Object.fromEntries([...(await part(zip, "xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)].map((match) => [/Id="([^"]+)"/.exec(match[0])?.[1], /Target="([^"]+)"/.exec(match[0])?.[1]]));
  const shared = [...(await part(zip, "xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => unxml([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((run) => run[1]).join("")));
  const tables = [];
  const lines = [];
  let formulas = 0;
  let totalRows = 0;
  let readRows = 0;
  const column = (ref) => [...ref.replace(/\d+/g, "")].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(/name="([^"]*)"/.exec(sheet[0])?.[1] || "Sheet");
    const target = rels[/r:id="([^"]+)"/.exec(sheet[0])?.[1]];
    if (!target || tables.length >= 20) continue;
    const xml = await part(zip, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    const rows = [];
    const sheetFormulas = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      totalRows += 1;
      if (rows.length > MAX_TABLE_ROWS) continue;
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(cell[1])?.[1];
        const type = /t="(\w+)"/.exec(cell[1])?.[1] || "n";
        const inner = cell[2] || "";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = unxml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((run) => run[1]).join(""));
        else if (type === "b") value = raw === "1";
        else if (type === "str" || type === "e") value = unxml(raw ?? "");
        else if (raw !== undefined && raw !== "") value = Number(raw);
        const at = ref ? column(ref) : cells.length;
        if (at > 200) continue;
        while (cells.length < at) cells.push("");
        cells[at] = value;
        if (formula) { formulas += 1; if (sheetFormulas.length < 40) sheetFormulas.push(`${ref}: =${unxml(formula)}`); }
      }
      if (cells.some((cell) => cell !== "")) { rows.push(cells); readRows += 1; }
    }
    if (!rows.length) continue;
    const width = Math.max(...rows.map((row) => row.length));
    const filled = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
    tables.push({ name, columns: filled[0].map((cell, index) => String(cell || `Column ${index + 1}`)), rows: filled.slice(1), formulas: sheetFormulas });
    lines.push(`## Sheet: ${name} (${filled.length - 1} rows × ${width} columns)`, filled.slice(0, 40).map((row) => row.join(" | ")).join("\n"));
    if (filled.length > 40) lines.push(`… ${filled.length - 40} more rows are in the table data.`);
    if (sheetFormulas.length) lines.push(`Formulas: ${sheetFormulas.slice(0, 12).join("; ")}`);
  }
  if (!tables.length) throw fail("This workbook has no data in it.");
  return { text: lines.join("\n"), tables, meta: { sheets: tables.length, formulas }, unit: "rows", total: totalRows, read: readRows };
}

async function readPdf(buffer) {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  let pdf;
  try { pdf = await getDocumentProxy(new Uint8Array(buffer)); } catch (error) {
    if (/password/i.test(String(error?.message))) throw fail("This PDF is password-protected. Remove the password and add it again.", "protected");
    throw fail("This PDF is damaged or isn't a PDF.");
  }
  const { text: pages, totalPages } = await extractText(pdf, { mergePages: false });
  const meta = await getMeta(pdf).catch(() => ({}));
  const lines = [];
  let withText = 0;
  pages.forEach((page, index) => {
    const text = String(page || "").replace(/[ \t]+\n/g, "\n").trim();
    if (text) withText += 1;
    lines.push(`## Page ${index + 1}`, text || "[No text on this page: it may be a scanned image.]");
  });
  const notes = [];
  if (withText === 0) notes.push("This PDF has no text layer (it looks like scanned pages), so its content couldn't be read.");
  else if (withText < totalPages) notes.push(`${totalPages - withText} of ${totalPages} pages have no text (scanned or image-only).`);
  return { text: lines.join("\n"), tables: [], meta: { pages: totalPages, title: meta?.info?.Title || "", author: meta?.info?.Author || "" }, unit: "pages", total: totalPages, read: withText, notes };
}

/**
 * Read one file. `buffer` is its bytes, `name` its file name.
 * `maxText` caps how much text comes back (the rest is counted, not dropped silently).
 */
async function readFile(buffer, name, { maxText = MAX_TEXT } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail("The file is empty.", "empty");
  if (buffer.length > MAX_BYTES) throw fail(`Files up to ${MAX_BYTES / 1024 / 1024} MB can be read.`, "too-large");
  const kind = kindOf(name, buffer);
  let result;
  if (kind === "pdf") result = await readPdf(buffer);
  else if (kind === "docx") result = await readDocx(buffer);
  else if (kind === "pptx") result = await readPptx(buffer);
  else if (kind === "xlsx") result = await readXlsx(buffer);
  else if (kind === "zip") throw fail("HANNAH reads .docx, .pptx and .xlsx files, not other archives.", "unsupported");
  else if (kind === "image") throw fail("Images are described by the vision model, not read as documents.", "image");
  else if (kind === "csv") {
    const rows = parseDelimited(decodeText(buffer));
    if (!rows.length) throw fail("This file has no rows.", "empty");
    const width = Math.max(...rows.slice(0, 200).map((row) => row.length));
    const columns = Array.from({ length: width }, (_unused, index) => String(rows[0][index] || `Column ${index + 1}`).trim());
    const data = rows.slice(1, MAX_TABLE_ROWS + 1).map((row) => columns.map((_column, index) => typed(row[index])));
    result = { text: [`## ${rows.length - 1} rows × ${width} columns`, rows.slice(0, 40).map((row) => row.join(" | ")).join("\n"), rows.length > 40 ? `… ${rows.length - 40} more rows are in the table data.` : ""].filter(Boolean).join("\n"), tables: [{ name: String(name || "Data").replace(/\.[^.]+$/, ""), columns, rows: data }], meta: { rows: rows.length - 1, columns: width }, unit: "rows", total: rows.length - 1, read: data.length };
  } else if (kind === "json") {
    const text = decodeText(buffer);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw fail("This file isn't valid JSON."); }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.rows) ? parsed.rows : null;
    const tables = [];
    if (list?.length && list.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const columns = [...new Set(list.slice(0, 200).flatMap((item) => Object.keys(item)))].slice(0, 60);
      tables.push({ name: String(name || "Data").replace(/\.[^.]+$/, ""), columns, rows: list.slice(0, MAX_TABLE_ROWS).map((item) => columns.map((column) => (typeof item[column] === "object" && item[column] !== null ? JSON.stringify(item[column]) : item[column] ?? ""))) });
    }
    result = { text: JSON.stringify(parsed, null, 1), tables, meta: { records: list?.length ?? null }, unit: "characters", total: text.length };
  } else {
    const text = decodeText(buffer).replace(/\r\n?/g, "\n");
    result = { text, tables: [], meta: { lines: text.split("\n").length }, unit: "characters", total: text.length };
  }
  const notes = [...(result.notes || [])];
  const full = result.text;
  let truncated = false;
  if (full.length > maxText) { truncated = true; notes.push(`Only the first ${maxText.toLocaleString("en")} of ${full.length.toLocaleString("en")} characters of text were read.`); }
  for (const table of result.tables) if (table.rows.length >= MAX_TABLE_ROWS) { truncated = true; notes.push(`“${table.name}” was read up to row ${MAX_TABLE_ROWS.toLocaleString("en")}.`); }
  return {
    kind, name: String(name || "file").slice(0, 200), bytes: buffer.length,
    text: full.slice(0, maxText), tables: result.tables, meta: result.meta,
    coverage: { unit: result.unit, total: result.total, read: result.read ?? result.total, truncated, notes },
  };
}

module.exports = { MAX_BYTES, kindOf, parseDelimited, readFile };
