"use strict";

/**
 * The document model: one description of a piece of writing that renders as a
 * PowerPoint deck, a PDF or a Word document (and whose tables can become an
 * Excel workbook). A model, or code that read the person's own file, produces
 * it; the renderers only lay it out.
 *
 *   { title, subtitle, author, date, audience, theme, sections: [
 *       { heading, level: 1|2, layout?, notes?, blocks: [
 *           { type: "paragraph", text }
 *           { type: "bullets", items: [...], ordered? }
 *           { type: "table", columns: [...], rows: [[...]], caption? }
 *           { type: "chart", chart: "bar"|"line"|"pie", title?, categories: [...], series: [{ name, values: [...] }], caption? }
 *           { type: "comparison", left: { title, items }, right: { title, items } }
 *           { type: "diagram", steps: [...] }            a left-to-right process
 *           { type: "callout", text }
 *           { type: "image", data: "data:image/png;base64,…", caption?, alt? }   the person's own image
 *           { type: "pagebreak" }
 *       ] } ],
 *     references: [{ title, url, publisher?, date? }] }
 */
const LIMITS = { sections: 60, blocks: 40, text: 6000, items: 24, item: 600, rows: 400, columns: 12, cell: 400, categories: 40, series: 8, references: 80 };

const fail = (message) => { throw Object.assign(new Error(message), { status: 400, reason: "invalid-document" }); };
/** Plain text: control characters, Markdown emphasis marks and the model's reference codes removed. */
function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/【\s*(\d{1,3})\s*(?:†[^】\n]{0,40})?】/g, "[$1]").replace(/【[^】\n]{1,40}】/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, "$1$2").replace(/^#{1,6}\s+/gm, "").replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+/g, " ").trim().slice(0, max);
}
const list = (value) => (Array.isArray(value) ? value : []);

function normalizeBlock(raw) {
  if (typeof raw === "string") raw = { type: "paragraph", text: raw };
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "paragraph": {
      const text = clean(raw.text, LIMITS.text);
      return text ? { type: "paragraph", text } : null;
    }
    case "bullets": {
      const items = list(raw.items).map((item) => clean(typeof item === "string" ? item : item?.text, LIMITS.item)).filter(Boolean).slice(0, LIMITS.items);
      return items.length ? { type: "bullets", items, ordered: raw.ordered === true } : null;
    }
    case "table": {
      const columns = list(raw.columns).map((column) => clean(typeof column === "string" ? column : column?.header, 120)).slice(0, LIMITS.columns);
      if (!columns.length) return null;
      const rows = list(raw.rows).slice(0, LIMITS.rows).map((row) => {
        const cells = Array.isArray(row) ? row : columns.map((column) => row?.[column]);
        return columns.map((_column, at) => (typeof cells[at] === "number" && Number.isFinite(cells[at]) ? cells[at] : clean(cells[at], LIMITS.cell)));
      });
      return rows.length ? { type: "table", columns, rows, caption: clean(raw.caption, 240) } : null;
    }
    case "chart": {
      const categories = list(raw.categories).map((item) => clean(item, 80)).slice(0, LIMITS.categories);
      const series = list(raw.series).slice(0, LIMITS.series).map((item, index) => ({
        name: clean(item?.name, 80) || `Series ${index + 1}`,
        values: categories.map((_category, at) => { const value = Number(list(item?.values)[at]); return Number.isFinite(value) ? value : 0; }),
      })).filter((item) => item.values.some((value) => value !== 0));
      if (categories.length < 2 || !series.length) return null;
      const chart = ["bar", "line", "pie"].includes(raw.chart) ? raw.chart : "bar";
      return { type: "chart", chart, title: clean(raw.title, 140), categories, series: chart === "pie" ? series.slice(0, 1) : series, caption: clean(raw.caption, 240), unit: clean(raw.unit, 20) };
    }
    case "comparison": {
      const side = (value) => ({ title: clean(value?.title, 120), items: list(value?.items).map((item) => clean(item, LIMITS.item)).filter(Boolean).slice(0, 8) });
      const left = side(raw.left);
      const right = side(raw.right);
      return left.items.length && right.items.length ? { type: "comparison", left, right } : null;
    }
    case "diagram": {
      const steps = list(raw.steps).map((step) => clean(typeof step === "string" ? step : step?.label || step?.text, 90)).filter(Boolean).slice(0, 6);
      return steps.length >= 2 ? { type: "diagram", steps, caption: clean(raw.caption, 240) } : null;
    }
    case "callout": {
      const text = clean(raw.text, 900);
      return text ? { type: "callout", text } : null;
    }
    case "image": {
      const data = typeof raw.data === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(raw.data) && raw.data.length < 6_000_000 ? raw.data : null;
      return data ? { type: "image", data, caption: clean(raw.caption, 240), alt: clean(raw.alt, 240) } : null;
    }
    case "pagebreak":
      return { type: "pagebreak" };
    default:
      return null;
  }
}

function normalizeDocument(input) {
  if (!input || typeof input !== "object") fail("The document description is missing.");
  const title = clean(input.title, 200);
  if (!title) fail("A document needs a title.");
  const sections = list(input.sections).slice(0, LIMITS.sections).map((raw) => {
    if (!raw || typeof raw !== "object") return null;
    const heading = clean(raw.heading || raw.title, 160);
    const blocks = list(raw.blocks).slice(0, LIMITS.blocks).map(normalizeBlock).filter(Boolean);
    if (!heading && !blocks.length) return null;
    return {
      heading: heading || "Untitled section",
      level: raw.level === 2 ? 2 : 1,
      layout: ["section", "content", "comparison", "chart", "conclusion"].includes(raw.layout) ? raw.layout : "content",
      notes: clean(raw.notes, 2000),
      blocks,
    };
  }).filter(Boolean);
  if (!sections.length) fail("A document needs at least one section with content.");
  const seen = new Set();
  const references = list(input.references).map((raw) => {
    const url = typeof raw?.url === "string" && /^https?:\/\/[^\s<>"]{4,2000}$/i.test(raw.url.trim()) ? raw.url.trim() : "";
    const refTitle = clean(raw?.title, 240) || url;
    if (!refTitle || (url && seen.has(url))) return null;
    if (url) seen.add(url);
    return { title: refTitle, url, publisher: clean(raw?.publisher, 120), date: clean(raw?.date, 40) };
  }).filter(Boolean).slice(0, LIMITS.references);
  return {
    kind: "document",
    title,
    subtitle: clean(input.subtitle, 240),
    author: clean(input.author, 120),
    date: clean(input.date, 40) || new Date().toISOString().slice(0, 10),
    audience: clean(input.audience, 160),
    theme: input.theme && typeof input.theme === "object" ? input.theme : typeof input.theme === "string" ? { name: input.theme } : {},
    cover: input.cover !== false,
    contents: input.contents !== false,
    sections,
    references,
  };
}

/** What a document holds, for the validation report and for the model when it revises one. */
function outline(document) {
  const count = (type) => document.sections.reduce((sum, section) => sum + section.blocks.filter((block) => block.type === type).length, 0);
  return {
    title: document.title,
    sections: document.sections.map((section, index) => ({ index, heading: section.heading, level: section.level, blocks: section.blocks.map((block) => block.type) })),
    tables: count("table"), charts: count("chart"), images: count("image"), references: document.references.length,
    words: document.sections.reduce((sum, section) => sum + section.blocks.reduce((inner, block) => inner + String(block.text || (block.items || []).join(" ")).split(/\s+/).filter(Boolean).length, 0), 0),
  };
}

/** Every table and chart of a document as a workbook description (for "put this in Excel"). */
function tablesAsWorkbook(document) {
  const sheets = [];
  for (const section of document.sections) {
    for (const block of section.blocks) {
      // Table text is content, never a formula, whatever it begins with.
      if (block.type === "table") sheets.push({ name: block.caption || section.heading, columns: block.columns.map((header) => ({ header })), rows: block.rows.map((row) => row.map((cell) => (typeof cell === "string" && cell.startsWith("=") ? { text: cell } : cell))) });
      if (block.type === "chart") {
        const last = block.categories.length + 1;
        const letter = (index) => String.fromCharCode(66 + index);
        sheets.push({
          name: block.title || section.heading,
          columns: [{ header: "Category" }, ...block.series.map((series) => ({ header: series.name, format: "number" }))],
          rows: block.categories.map((category, at) => [category, ...block.series.map((series) => series.values[at])]),
          charts: [{ type: block.chart, title: block.title, categories: `A2:A${last}`, series: block.series.map((series, index) => ({ name: series.name, values: `${letter(index)}2:${letter(index)}${last}` })) }],
        });
      }
    }
  }
  return sheets.length ? { title: document.title, theme: document.theme, sheets: sheets.slice(0, 12) } : null;
}

module.exports = { LIMITS, clean, normalizeBlock, normalizeDocument, outline, tablesAsWorkbook };
