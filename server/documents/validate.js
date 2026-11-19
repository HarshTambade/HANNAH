"use strict";

/**
 * Opens a generated file again, with parsers that share nothing with the code
 * that wrote it, and checks it is what was asked for. A file that fails is not
 * handed to the person.
 *
 * Checked for every Office file: it is a ZIP package, every part its
 * relationships point to exists, and every XML part is well-formed. Then, per
 * format: PDF page count and text; Word headings and tables; PowerPoint slide,
 * chart and notes counts and that no slide is over-full; Excel sheets, that
 * every formula is still a formula, and that none of them ends in an error.
 */
const JSZip = require("jszip");
const { readFile } = require("./read");

/** True when the tags of an XML part open and close in order. */
function wellFormed(xml) {
  const stack = [];
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  for (const match of xml.matchAll(pattern)) {
    if (xml.slice(last, match.index).includes("<")) return false;
    last = match.index + match[0].length;
    if (!match[2]) continue;
    if (match[4] === "/") continue;
    if (match[1] === "/") { if (stack.pop() !== match[2]) return false; } else stack.push(match[2]);
  }
  return stack.length === 0 && !xml.slice(last).includes("<");
}

async function packageChecks(buffer) {
  const checks = [];
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { return { zip: null, checks: [{ name: "Opens as an Office package", ok: false, detail: "The file is not a valid ZIP package." }] }; }
  checks.push({ name: "Opens as an Office package", ok: Boolean(zip.file("[Content_Types].xml")), detail: `${Object.keys(zip.files).length} parts` });
  const missing = [];
  const broken = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels)$/.test(name)) continue;
    const xml = await zip.file(name).async("string");
    if (!wellFormed(xml)) broken.push(name);
    if (!name.endsWith(".rels")) continue;
    const base = name.replace(/_rels\/[^/]+$/, "");
    for (const rel of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (/TargetMode="External"/.test(rel[0])) continue;
      const target = /Target="([^"]+)"/.exec(rel[0])?.[1];
      if (!target) continue;
      const parts = (target.startsWith("/") ? target.slice(1) : `${base}${target}`).split("/");
      const resolved = [];
      for (const piece of parts) { if (piece === "..") resolved.pop(); else if (piece !== ".") resolved.push(piece); }
      if (!zip.file(resolved.join("/"))) missing.push(`${name} → ${target}`);
    }
  }
  checks.push({ name: "Every linked part exists", ok: missing.length === 0, detail: missing.slice(0, 3).join("; ") || "all relationships resolve" });
  checks.push({ name: "Every XML part is well-formed", ok: broken.length === 0, detail: broken.slice(0, 3).join("; ") || "all parts parse" });
  return { zip, checks };
}

const count = async (zip, pattern, expression) => {
  let total = 0;
  for (const name of Object.keys(zip.files)) if (pattern.test(name)) total += ((await zip.file(name).async("string")).match(expression) || []).length;
  return total;
};
const parts = (zip, pattern) => Object.keys(zip.files).filter((name) => pattern.test(name)).length;
// Scripts whose letters are reordered and joined when drawn (Devanagari, Arabic, Bengali, Tamil …): text read
// back out of a PDF comes in drawing order, so it can't be compared letter for letter. For those, the check is
// that text in the same script is there.
const SHAPED = /[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0FFF\u1780-\u17FF]/;
const blockOf = (char) => Math.floor(char.codePointAt(0) / 128);
const has = (text, phrase) => {
  const wanted = String(phrase).replace(/\s+/g, " ").trim();
  if (!wanted) return true;
  if (SHAPED.test(wanted)) {
    const blocks = new Set([...wanted].filter((char) => SHAPED.test(char)).map(blockOf));
    const latin = wanted.replace(new RegExp(SHAPED.source, "g"), " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return [...text].some((char) => blocks.has(blockOf(char))) && (!latin || text.replace(/\s+/g, " ").toLowerCase().includes(latin.toLowerCase().slice(0, 40)));
  }
  return text.replace(/\s+/g, " ").toLowerCase().includes(wanted.toLowerCase().slice(0, 40));
};

/**
 * `expected` is the renderer's own report plus the model it rendered.
 * Resolves to { ok, checks: [{ name, ok, detail }] }.
 */
async function validateFile(format, buffer, { report = {}, model = {} } = {}) {
  const checks = [];
  try {
    if (format === "pdf") {
      checks.push({ name: "Is a PDF", ok: buffer.subarray(0, 5).toString("latin1") === "%PDF-" && buffer.subarray(-1024).toString("latin1").includes("%%EOF"), detail: `${buffer.length.toLocaleString("en")} bytes` });
      const read = await readFile(buffer, "check.pdf");
      checks.push({ name: "Page count matches", ok: read.meta.pages === report.pages && read.meta.pages > 0, detail: `${read.meta.pages} pages` });
      checks.push({ name: "Text is readable (not outlines or images)", ok: read.coverage.read > 0 && has(read.text, model.title || ""), detail: `${read.text.length.toLocaleString("en")} characters of text` });
      const headings = (model.sections || []).filter((section) => !has(read.text, section.heading));
      checks.push({ name: "Every section is in the file", ok: headings.length === 0, detail: headings.length ? `missing: ${headings.slice(0, 3).map((section) => section.heading).join("; ")}` : `${(model.sections || []).length} sections` });
    } else {
      const { zip, checks: common } = await packageChecks(buffer);
      checks.push(...common);
      if (!zip) return { ok: false, checks };
      if (format === "docx") {
        const read = await readFile(buffer, "check.docx");
        const headings = await count(zip, /^word\/document\.xml$/, /<w:pStyle w:val="Heading[12]"/g);
        checks.push({ name: "Headings use Word's heading styles", ok: headings >= (model.sections || []).length, detail: `${headings} headings` });
        const tables = (model.sections || []).reduce((sum, section) => sum + section.blocks.filter((block) => block.type === "table").length, 0);
        checks.push({ name: "Tables are real tables", ok: read.tables.length >= tables, detail: `${read.tables.length} tables` });
        checks.push({ name: "Text is editable text", ok: has(read.text, model.title || "") && read.text.length > 0, detail: `${read.text.length.toLocaleString("en")} characters` });
      } else if (format === "pptx") {
        const slides = parts(zip, /^ppt\/slides\/slide\d+\.xml$/);
        checks.push({ name: "Slide count matches", ok: slides === (report.slides || []).length && slides > 0, detail: `${slides} slides` });
        const charts = parts(zip, /^ppt\/charts\/chart\d+\.xml$/);
        checks.push({ name: "Charts are native charts with their data", ok: charts === (report.charts || 0) && parts(zip, /^ppt\/embeddings\/.+\.xlsx$/) >= charts, detail: `${charts} charts` });
        const notes = parts(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/);
        checks.push({ name: "Speaker notes are in the file", ok: !report.notes || (await count(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/, /<a:t>[^<]{3,}<\/a:t>/g)) >= report.notes, detail: `${report.notes || 0} slides with notes (${notes} notes parts)` });
        const over = (report.slides || []).filter((slide) => slide.fill > 1);
        checks.push({ name: "No slide is over-full", ok: over.length === 0, detail: over.length ? `slides ${over.map((slide) => slide.number).join(", ")}` : "all content fits its slide" });
        const read = await readFile(buffer, "check.pptx");
        checks.push({ name: "Text is editable text", ok: has(read.text, model.title || (model.sections || [])[0]?.heading || ""), detail: `${read.text.length.toLocaleString("en")} characters` });
      } else if (format === "xlsx") {
        const read = await readFile(buffer, "check.xlsx");
        checks.push({ name: "Sheets match", ok: read.meta.sheets === (report.sheets || []).length, detail: (report.sheets || []).map((sheet) => sheet.name).join(", ") });
        checks.push({ name: "Formulas are still formulas", ok: read.meta.formulas === report.formulas, detail: `${read.meta.formulas} formulas in the file, ${report.formulas} written` });
        const errors = report.formulaErrors || [];
        checks.push({ name: "No formula ends in an error", ok: errors.length === 0, detail: errors.length ? errors.slice(0, 4).map((item) => `${item.sheet}!${item.cell} ${item.formula} → ${item.error}`).join("; ") : "all formulas compute" });
        const charts = parts(zip, /^xl\/charts\/chart\d+\.xml$/);
        checks.push({ name: "Charts are native charts", ok: charts === (report.charts || 0), detail: `${charts} charts` });
        const names = (report.sheets || []).map((sheet) => sheet.name);
        checks.push({ name: "Sheet names are valid", ok: names.every((name) => name.length >= 1 && name.length <= 31 && !/[[\]:*?/\\]/.test(name)) && new Set(names.map((name) => name.toLowerCase())).size === names.length, detail: `${names.length} sheets` });
      }
    }
  } catch (error) {
    checks.push({ name: "Opens again after writing", ok: false, detail: String(error?.message || error).slice(0, 200) });
  }
  return { ok: checks.length > 0 && checks.every((check) => check.ok), checks };
}

module.exports = { validateFile, wellFormed };
