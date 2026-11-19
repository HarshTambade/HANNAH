"use strict";

/**
 * PDF reports from the document model (PDFKit): cover page, table of
 * contents with page numbers and links, running header and "Page x of y"
 * footer, headings, paragraphs, lists, tables that repeat their header across
 * pages, vector charts, process diagrams, two-column comparisons, the
 * person's own images, and a numbered reference list with live links.
 *
 * Text is set in Noto Sans (bundled, SIL Open Font License), with Noto Sans
 * Devanagari for Hindi and Marathi, so the file doesn't depend on fonts the
 * reader's device has.
 */
const path = require("node:path");
const PDFDocument = require("pdfkit");
const { normalizeDocument } = require("./model");
const { themeFor } = require("./theme");

const FONTS = path.join(__dirname, "fonts");
const PAGE = { size: "A4", margins: { top: 78, bottom: 70, left: 58, right: 58 } };
// eslint-disable-next-line no-misleading-character-class -- a whole script block (letters and their combining signs) is meant
const DEVANAGARI = /[ऀ-ॿ᳐-᳿꣠-ꣿ]/;
// Characters the bundled fonts can't draw (emoji and pictographs) are left out instead of printing as boxes.
// eslint-disable-next-line no-misleading-character-class -- a whole script block (letters and their combining signs) is meant
const UNDRAWABLE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/gu;

const tidy = (text) => String(text ?? "").replace(UNDRAWABLE, "").replace(/[\u2028\u2029]/g, " ");
/** Runs of one script each, so every run is drawn with a font that has its letters. */
function runs(text) {
  const out = [];
  // eslint-disable-next-line no-misleading-character-class -- a whole script block (letters and their combining signs) is meant
  for (const part of tidy(text).split(/([ऀ-ॿ᳐-᳿꣠-ꣿ][ऀ-ॿ᳐-᳿꣠-ꣿ\s‌.,;:!?()\-–—'"0-9]*)/)) {
    if (!part) continue;
    out.push({ text: part, script: DEVANAGARI.test(part) ? "deva" : "latin" });
  }
  return out;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}
const short = (value) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(abs < 10 ? 2 : 1);
};
const display = (cell) => (typeof cell === "number" ? cell.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(cell ?? ""));

async function renderPdf(input) {
  const model = normalizeDocument(input);
  const theme = themeFor(model.theme);
  const doc = new PDFDocument({ ...PAGE, bufferPages: true, autoFirstPage: false, info: { Title: model.title, Author: model.author || "HANNAH", Creator: "HANNAH", Subject: model.subtitle || "" } });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { doc.on("end", resolve); doc.on("error", reject); });
  doc.registerFont("body", path.join(FONTS, "NotoSans-Regular.ttf"));
  doc.registerFont("bold", path.join(FONTS, "NotoSans-Bold.ttf"));
  doc.registerFont("deva", path.join(FONTS, "NotoSansDevanagari-Regular.ttf"));
  doc.registerFont("devaBold", path.join(FONTS, "NotoSansDevanagari-Bold.ttf"));

  const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = () => doc.page.margins.left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const fontName = (script, bold) => (script === "deva" ? (bold ? "devaBold" : "deva") : bold ? "bold" : "body");
  /** Draw text that may mix Latin and Devanagari. */
  const write = (text, { bold = false, size = 10.5, color = theme.ink, x, y, ...options } = {}) => {
    const parts = runs(text);
    if (!parts.length) return;
    doc.fontSize(size).fillColor(color);
    parts.forEach((part, index) => {
      doc.font(fontName(part.script, bold));
      const opts = { ...options, continued: index < parts.length - 1 };
      if (index === 0 && x !== undefined) doc.text(part.text, x, y, opts);
      else doc.text(part.text, opts);
    });
  };
  const measure = (text, { bold = false, size = 10.5, ...options } = {}) => {
    const clean = tidy(text);
    doc.font(fontName(DEVANAGARI.test(clean) ? "deva" : "latin", bold)).fontSize(size);
    return doc.heightOfString(clean || " ", options);
  };
  const room = (height) => { if (doc.y + height > bottom()) doc.addPage(); };
  const gap = (points) => { doc.y += points; };

  // Cover.
  let coverPages = 0;
  if (model.cover) {
    doc.addPage({ ...PAGE, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    coverPages = 1;
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(theme.paper);
    doc.rect(0, 0, doc.page.width, 250).fill(theme.dark);
    doc.rect(58, 250, 90, 5).fill(theme.accent);
    if (theme.logo) { try { doc.image(Buffer.from(theme.logo.split(",")[1], "base64"), 58, 56, { fit: [150, 60] }); } catch { /* an unreadable logo is left out */ } }
    write(model.title, { bold: true, size: 30, color: "#FFFFFF", x: 58, y: 138, width: doc.page.width - 116, lineGap: 2, height: 100, ellipsis: true });
    doc.y = 290;
    if (model.subtitle) { write(model.subtitle, { size: 15, color: theme.ink, x: 58, y: doc.y, width: doc.page.width - 116, lineGap: 3 }); gap(18); }
    const facts = [model.author && `Prepared by ${model.author}`, model.audience && `For ${model.audience}`, model.date].filter(Boolean);
    for (const fact of facts) write(fact, { size: 11, color: theme.muted, x: 58, y: doc.y + 4, width: doc.page.width - 116 });
    write("Made with HANNAH", { size: 9, color: theme.muted, x: 58, y: doc.page.height - 70, width: 300 });
  }

  // Table of contents: its pages are kept now and filled in once the page numbers are known.
  const headings = [];
  const wantContents = model.contents && model.sections.length >= 3;
  const contentsLines = model.sections.length + (model.references.length ? 1 : 0);
  const contentsPages = wantContents ? Math.ceil(contentsLines / 32) : 0;
  for (let page = 0; page < contentsPages; page += 1) doc.addPage(PAGE);
  doc.addPage(PAGE);

  const heading = (text, level, anchor) => {
    room(level === 1 ? 90 : 60);
    if (level === 1 && doc.y > doc.page.margins.top + 4) gap(10);
    doc.addNamedDestination(anchor);
    headings.push({ text, level, anchor, page: doc.bufferedPageRange().count - 1 });
    if (level === 1) {
      write(text, { bold: true, size: 18, color: theme.dark, x: left(), y: doc.y, width: width(), lineGap: 1 });
      doc.rect(left(), doc.y + 4, 44, 2.5).fill(theme.accent);
      gap(16);
    } else {
      write(text, { bold: true, size: 13, color: theme.dark, x: left(), y: doc.y + 2, width: width() });
      gap(7);
    }
  };

  const paragraph = (text) => {
    room(Math.min(measure(text, { width: width(), lineGap: 3.5 }), 60));
    write(text, { x: left(), y: doc.y, width: width(), lineGap: 3.5, align: "left" });
    gap(9);
  };

  const bullets = (items, ordered, x = left(), w = width()) => {
    items.forEach((item, index) => {
      const height = measure(item, { width: w - 18, lineGap: 3 });
      room(Math.min(height, 40) + 4);
      const y = doc.y;
      write(ordered ? `${index + 1}.` : "•", { bold: ordered, color: theme.accent, x, y, width: 16 });
      write(item, { x: x + 18, y, width: w - 18, lineGap: 3 });
      gap(4.5);
    });
    gap(5);
  };

  const caption = (text) => { if (!text) return; write(text, { size: 9, color: theme.muted, x: left(), y: doc.y + 3, width: width(), align: "center" }); gap(6); };

  const table = (block) => {
    const pad = 5;
    const lengths = block.columns.map((column, at) => Math.max(column.length, ...block.rows.slice(0, 60).map((row) => Math.min(display(row[at]).length, 46)), 4));
    const total = lengths.reduce((sum, value) => sum + value, 0);
    const widths = lengths.map((value) => Math.max(38, (value / total) * width()));
    const scale = width() / widths.reduce((sum, value) => sum + value, 0);
    widths.forEach((_value, at) => { widths[at] *= scale; });
    const numeric = block.columns.map((_column, at) => block.rows.every((row) => row[at] === "" || typeof row[at] === "number" || /^[-+]?[$€£₹]?[\d,.]+%?$/.test(String(row[at]))));
    const size = block.columns.length > 6 ? 8 : 9;
    const drawRow = (cells, header, shade) => {
      const height = Math.max(...cells.map((cell, at) => measure(display(cell), { bold: header, size, width: widths[at] - pad * 2, lineGap: 1.5 }))) + pad * 2;
      if (doc.y + height > bottom()) { doc.addPage(); if (!header) drawRow(block.columns, true, false); }
      const y = doc.y;
      if (header) doc.rect(left(), y, width(), height).fill(theme.accent);
      else if (shade) doc.rect(left(), y, width(), height).fill(theme.soft);
      let x = left();
      cells.forEach((cell, at) => {
        write(display(cell), { bold: header, size, color: header ? "#FFFFFF" : theme.ink, x: x + pad, y: y + pad, width: widths[at] - pad * 2, lineGap: 1.5, align: numeric[at] && !header ? "right" : "left" });
        x += widths[at];
      });
      doc.moveTo(left(), y + height).lineTo(left() + width(), y + height).lineWidth(0.5).strokeColor(theme.line).stroke();
      doc.y = y + height;
    };
    room(70);
    drawRow(block.columns, true, false);
    block.rows.forEach((row, index) => drawRow(row, false, index % 2 === 1));
    caption(block.caption);
    gap(10);
  };

  const chart = (block) => {
    const height = 230;
    room(height + 54);
    if (block.title) { write(block.title, { bold: true, size: 11, color: theme.dark, x: left(), y: doc.y, width: width() }); gap(6); }
    const top = doc.y;
    const colors = theme.series;
    if (block.chart === "pie") {
      const values = block.series[0].values.map((value) => Math.max(0, value));
      const sum = values.reduce((total, value) => total + value, 0) || 1;
      const cx = left() + 120;
      const cy = top + height / 2;
      const radius = 92;
      let angle = -Math.PI / 2;
      values.forEach((value, index) => {
        const sweep = (value / sum) * Math.PI * 2;
        if (sweep <= 0) return;
        const end = angle + sweep;
        doc.moveTo(cx, cy).lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
        // An arc drawn as short straight steps: exact enough at this size and free of curve-fitting edge cases.
        for (let step = 1; step <= Math.max(2, Math.ceil(sweep / 0.08)); step += 1) {
          const at = angle + (sweep * step) / Math.max(2, Math.ceil(sweep / 0.08));
          doc.lineTo(cx + radius * Math.cos(at), cy + radius * Math.sin(at));
        }
        doc.closePath().fillAndStroke(colors[index % colors.length], "#FFFFFF");
        angle = end;
      });
      let y = top + 18;
      block.categories.forEach((category, index) => {
        if (y > top + height - 14) return;
        doc.rect(left() + 250, y + 2, 9, 9).fill(colors[index % colors.length]);
        write(`${category}: ${short(values[index])}${block.unit ? ` ${block.unit}` : ""} (${((values[index] / sum) * 100).toFixed(1)}%)`, { size: 9, x: left() + 265, y, width: width() - 270, height: 12, ellipsis: true });
        y += 16;
      });
    } else {
      const plot = { x: left() + 44, y: top + 8, w: width() - 54, h: height - 62 };
      const all = block.series.flatMap((series) => series.values);
      const max = niceMax(Math.max(...all, 0));
      const min = Math.min(0, ...all) < 0 ? -niceMax(Math.abs(Math.min(...all))) : 0;
      const yOf = (value) => plot.y + plot.h - ((value - min) / (max - min || 1)) * plot.h;
      // As many divisions as give round tick labels (0, 3, 6 … rather than 3.75, 7.5 …).
      const round = (step) => { const unit = step / 10 ** Math.floor(Math.log10(step)); return [1, 2, 2.5, 5].some((nice) => Math.abs(unit - nice) < 1e-9); };
      const divisions = [4, 5, 3, 6].find((count) => round((max - min) / count)) || 4;
      for (let tick = 0; tick <= divisions; tick += 1) {
        const value = min + ((max - min) * tick) / divisions;
        const y = yOf(value);
        doc.moveTo(plot.x, y).lineTo(plot.x + plot.w, y).lineWidth(0.5).strokeColor(theme.line).stroke();
        write(short(value), { size: 8, color: theme.muted, x: left(), y: y - 5, width: 38, align: "right" });
      }
      const slot = plot.w / block.categories.length;
      const every = Math.ceil(block.categories.length / 12);
      block.categories.forEach((category, index) => {
        if (index % every) return;
        write(category, { size: 8, color: theme.muted, x: plot.x + slot * index - slot * (every - 1) * 0, y: plot.y + plot.h + 5, width: slot * every, align: "center", height: 20, ellipsis: true });
      });
      if (block.chart === "line") {
        block.series.forEach((series, at) => {
          const color = colors[at % colors.length];
          series.values.forEach((value, index) => {
            const x = plot.x + slot * (index + 0.5);
            if (index === 0) doc.moveTo(x, yOf(value)); else doc.lineTo(x, yOf(value));
          });
          doc.lineWidth(1.8).strokeColor(color).stroke();
          series.values.forEach((value, index) => doc.circle(plot.x + slot * (index + 0.5), yOf(value), 2.4).fill(color));
        });
      } else {
        const group = slot * 0.72;
        const bar = group / block.series.length;
        block.series.forEach((series, at) => {
          series.values.forEach((value, index) => {
            const x = plot.x + slot * index + (slot - group) / 2 + bar * at;
            const y = yOf(Math.max(value, 0));
            doc.rect(x, y, Math.max(bar - 1.5, 1), Math.max(Math.abs(yOf(value) - yOf(0)), 0.5)).fill(colors[at % colors.length]);
          });
        });
      }
      doc.moveTo(plot.x, yOf(0)).lineTo(plot.x + plot.w, yOf(0)).lineWidth(0.8).strokeColor(theme.muted).stroke();
      let x = plot.x;
      block.series.forEach((series, at) => {
        doc.rect(x, top + height - 16, 9, 9).fill(colors[at % colors.length]);
        write(series.name, { size: 9, x: x + 13, y: top + height - 18, width: 120, height: 12, ellipsis: true });
        x += Math.min(140, doc.widthOfString(tidy(series.name)) + 30);
      });
    }
    doc.y = top + height;
    caption(block.caption);
    gap(12);
  };

  const diagram = (block) => {
    const count = block.steps.length;
    const arrow = 16;
    const box = (width() - arrow * (count - 1)) / count;
    const height = Math.max(46, ...block.steps.map((step) => measure(step, { bold: true, size: 9, width: box - 12 }) + 20));
    room(height + 30);
    const y = doc.y;
    block.steps.forEach((step, index) => {
      const x = left() + index * (box + arrow);
      doc.roundedRect(x, y, box, height, 6).fillAndStroke(theme.soft, theme.accent);
      write(`${index + 1}`, { bold: true, size: 8, color: theme.accent, x: x + 6, y: y + 5, width: 20 });
      write(step, { bold: true, size: 9, color: theme.dark, x: x + 6, y: y + 17, width: box - 12, align: "center" });
      if (index < count - 1) {
        const ax = x + box + 3;
        const ay = y + height / 2;
        doc.moveTo(ax, ay).lineTo(ax + arrow - 6, ay).lineWidth(1.2).strokeColor(theme.accent).stroke();
        doc.moveTo(ax + arrow - 6, ay - 3.5).lineTo(ax + arrow - 1, ay).lineTo(ax + arrow - 6, ay + 3.5).fill(theme.accent);
      }
    });
    doc.y = y + height + 6;
    caption(block.caption);
    gap(10);
  };

  const comparison = (block) => {
    const colWidth = (width() - 16) / 2;
    const heightOf = (side) => 30 + side.items.reduce((sum, item) => sum + measure(item, { width: colWidth - 38, lineGap: 3 }) + 4.5, 0) + 8;
    const height = Math.max(heightOf(block.left), heightOf(block.right));
    room(Math.min(height, 240) + 10);
    const y = doc.y;
    [block.left, block.right].forEach((side, index) => {
      const x = left() + index * (colWidth + 16);
      doc.roundedRect(x, y, colWidth, height, 6).lineWidth(0.8).strokeColor(theme.line).stroke();
      doc.rect(x, y, colWidth, 4).fill(index === 0 ? theme.accent : theme.series[1]);
      write(side.title || (index === 0 ? "Option A" : "Option B"), { bold: true, size: 11, color: theme.dark, x: x + 10, y: y + 11, width: colWidth - 20 });
      doc.y = y + 30;
      bullets(side.items, false, x + 10, colWidth - 20);
    });
    doc.y = y + height + 12;
  };

  const callout = (block) => {
    const height = measure(block.text, { width: width() - 30, lineGap: 3 }) + 18;
    room(height + 10);
    const y = doc.y;
    doc.rect(left(), y, width(), height).fill(theme.soft);
    doc.rect(left(), y, 4, height).fill(theme.accent);
    write(block.text, { color: theme.dark, x: left() + 16, y: y + 9, width: width() - 30, lineGap: 3 });
    doc.y = y + height + 12;
  };

  const image = (block) => {
    try {
      const data = Buffer.from(block.data.split(",")[1], "base64");
      const opened = doc.openImage(data);
      const scale = Math.min(width() / opened.width, 300 / opened.height, 1);
      const w = opened.width * scale;
      const h = opened.height * scale;
      room(h + 30);
      doc.image(opened, left() + (width() - w) / 2, doc.y, { width: w, height: h });
      doc.y += h + 4;
      caption(block.caption);
      gap(8);
    } catch {
      paragraph(`[Image not included: ${block.alt || block.caption || "the file couldn't be read"}]`);
    }
  };

  model.sections.forEach((section, index) => {
    heading(section.heading, section.level, `section-${index}`);
    for (const block of section.blocks) {
      if (block.type === "paragraph") paragraph(block.text);
      else if (block.type === "bullets") bullets(block.items, block.ordered);
      else if (block.type === "table") table(block);
      else if (block.type === "chart") chart(block);
      else if (block.type === "diagram") diagram(block);
      else if (block.type === "comparison") comparison(block);
      else if (block.type === "callout") callout(block);
      else if (block.type === "image") image(block);
      else if (block.type === "pagebreak") doc.addPage();
    }
    gap(6);
  });

  if (model.references.length) {
    heading("References", 1, "references");
    model.references.forEach((reference, index) => {
      const facts = [reference.publisher, reference.date].filter(Boolean).join(", ");
      const line = `${reference.title}${facts ? ` (${facts})` : ""}`;
      room(measure(line, { size: 9.5, width: width() - 26 }) + (reference.url ? 14 : 0) + 6);
      const y = doc.y;
      write(`[${index + 1}]`, { bold: true, size: 9.5, color: theme.accent, x: left(), y, width: 24 });
      write(line, { size: 9.5, x: left() + 26, y, width: width() - 26, lineGap: 2 });
      if (reference.url) {
        doc.font("body").fontSize(8.5).fillColor(theme.accent).text(reference.url, left() + 26, doc.y + 1, { width: width() - 26, link: reference.url, underline: false, height: 22, ellipsis: true });
      }
      gap(6);
    });
  }

  // Contents, with the page numbers that are now known.
  const range = doc.bufferedPageRange();
  if (wantContents) {
    const entries = headings.filter((item) => item.level === 1 || contentsLines <= 32);
    entries.forEach((entry, index) => {
      const page = coverPages + Math.floor(index / 32);
      doc.switchToPage(page);
      if (index % 32 === 0) {
        doc.y = doc.page.margins.top;
        write(index === 0 ? "Contents" : "Contents (continued)", { bold: true, size: 18, color: theme.dark, x: left(), y: doc.y, width: width() });
        doc.rect(left(), doc.y + 4, 44, 2.5).fill(theme.accent);
        gap(22);
      }
      const y = doc.y;
      const number = String(entry.page + 1 - coverPages);
      write(entry.text, { bold: entry.level === 1, size: 10.5, color: theme.ink, x: left() + (entry.level === 2 ? 14 : 0), y, width: width() - 50 - (entry.level === 2 ? 14 : 0), height: 14, ellipsis: true, goTo: entry.anchor });
      write(number, { size: 10.5, color: theme.muted, x: left() + width() - 40, y, width: 40, align: "right" });
      doc.y = y + 19;
    });
  }

  // Running header and footer on every page after the cover.
  for (let page = coverPages; page < range.count; page += 1) {
    doc.switchToPage(page);
    const margins = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: margins.left, right: margins.right };
    write(model.title, { size: 8.5, color: theme.muted, x: margins.left, y: 40, width: doc.page.width - margins.left - margins.right - 90, height: 12, ellipsis: true });
    if (theme.logo) { try { doc.image(Buffer.from(theme.logo.split(",")[1], "base64"), doc.page.width - margins.right - 70, 30, { fit: [70, 26], align: "right" }); } catch { /* skip */ } }
    doc.moveTo(margins.left, 58).lineTo(doc.page.width - margins.right, 58).lineWidth(0.5).strokeColor(theme.line).stroke();
    write(`Page ${page + 1 - coverPages} of ${range.count - coverPages}`, { size: 8.5, color: theme.muted, x: margins.left, y: doc.page.height - 44, width: doc.page.width - margins.left - margins.right, align: "right" });
    write(model.date, { size: 8.5, color: theme.muted, x: margins.left, y: doc.page.height - 44, width: 200 });
    doc.page.margins = margins;
  }

  doc.end();
  await done;
  return { buffer: Buffer.concat(chunks), report: { pages: range.count, contents: wantContents, headings: headings.length }, model };
}

module.exports = { renderPdf };
