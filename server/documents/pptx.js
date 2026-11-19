"use strict";

/**
 * PowerPoint decks (.pptx) from the document model (PptxGenJS). Slides are
 * editable: text is text, tables are tables, charts are native charts with
 * their data, and process diagrams are shapes.
 *
 * A deck is planned, not poured: text is measured against the space it has,
 * the type size steps down to a floor, and what still doesn't fit continues
 * on the next slide. Each slide's fill is recorded so validation can refuse a
 * deck with clipped content.
 */
const PptxGenJS = require("pptxgenjs");
const { normalizeDocument } = require("./model");
const { themeFor } = require("./theme");

const W = 13.333;
const H = 7.5;
const MARGIN = 0.6;
const BODY = { x: MARGIN, y: 1.55, w: W - MARGIN * 2, h: 4.95 };
const hex = (color) => String(color).replace("#", "");
const display = (cell) => (typeof cell === "number" ? cell.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(cell ?? ""));

/** Lines a text takes at a type size in a box this wide (average glyph is about half an em). */
const linesFor = (text, size, width) => Math.max(1, Math.ceil(String(text).length / Math.max(8, Math.floor((width * 72) / (size * 0.52)))));
const sentences = (text) => String(text).match(/[^.!?।]+[.!?।]+(?:\s|$)|[^.!?।]+$/g)?.map((part) => part.trim()).filter(Boolean) || [String(text)];

/** Split a section into slides: runs of text together, each table, chart, diagram, comparison or image on its own. */
function plan(section) {
  const slides = [];
  let text = null;
  const flush = () => { if (text && (text.lead || text.items.length)) slides.push(text); text = null; };
  const open = () => { text ??= { kind: "text", lead: "", items: [], ordered: false, callout: "" }; return text; };
  for (const block of section.blocks) {
    if (block.type === "paragraph") {
      const target = open();
      if (!target.lead && !target.items.length && block.text.length <= 260) target.lead = block.text;
      else target.items.push(...sentences(block.text));
    } else if (block.type === "bullets") {
      const target = open();
      target.items.push(...block.items);
      target.ordered = target.ordered || block.ordered;
    } else if (block.type === "callout") {
      const target = open();
      if (!target.callout) target.callout = block.text; else target.items.push(block.text);
    } else if (block.type === "pagebreak") {
      flush();
    } else {
      // A short run of text just before a chart sits beside it as its takeaways.
      const beside = block.type === "chart" && text && !text.callout && text.items.length <= 4 && `${text.lead}${text.items.join("")}`.length <= 320 ? text : null;
      if (beside) text = null; else flush();
      slides.push({ kind: block.type, block, beside });
    }
  }
  flush();
  return slides.length ? slides : [{ kind: "text", lead: "", items: [], ordered: false, callout: "" }];
}

async function renderPptx(input) {
  const model = normalizeDocument(input);
  const theme = themeFor(model.theme);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = model.title;
  pptx.author = model.author || "HANNAH";
  pptx.company = "HANNAH";
  pptx.subject = model.subtitle;
  const font = theme.font.body;
  const report = { slides: [], charts: 0, tables: 0, notes: 0 };

  pptx.defineSlideMaster({
    title: "CONTENT",
    background: { color: hex(theme.paper) },
    objects: [
      { rect: { x: 0, y: 0, w: W, h: 0.12, fill: { color: hex(theme.accent) } } },
      { text: { text: model.title, options: { x: MARGIN, y: H - 0.5, w: W - 3, h: 0.3, fontSize: 10, fontFace: font, color: hex(theme.muted) } } },
    ],
    slideNumber: { x: W - 1.2, y: H - 0.5, w: 0.6, h: 0.3, fontSize: 10, fontFace: font, color: hex(theme.muted), align: "right" },
  });
  pptx.defineSlideMaster({ title: "DARK", background: { color: hex(theme.dark) }, objects: [{ rect: { x: MARGIN, y: H - 1.1, w: 1.4, h: 0.08, fill: { color: hex(theme.accent) } } }] });

  const record = (slide, title, kind, fill = 0) => { report.slides.push({ number: report.slides.length + 1, title, kind, fill: Math.round(fill * 100) / 100 }); return slide; };
  const titled = (title, kind, fill) => {
    const slide = pptx.addSlide({ masterName: "CONTENT" });
    const size = title.length > 70 ? 24 : title.length > 46 ? 28 : 32;
    slide.addText(title, { x: MARGIN, y: 0.42, w: W - MARGIN * 2, h: 0.95, fontSize: size, fontFace: theme.font.heading, bold: true, color: hex(theme.dark), valign: "middle", fit: "shrink" });
    return record(slide, title, kind, fill);
  };
  // Title slide.
  if (model.cover) {
    const slide = record(pptx.addSlide({ masterName: "DARK" }), model.title, "title");
    if (theme.logo) slide.addImage({ data: theme.logo, x: MARGIN, y: 0.55, w: 1.6, h: 0.64, sizing: { type: "contain", w: 1.6, h: 0.64 } });
    slide.addText(model.title, { x: MARGIN, y: 1.9, w: W - MARGIN * 2 - 1, h: 2.2, fontSize: model.title.length > 60 ? 38 : 46, fontFace: theme.font.heading, bold: true, color: "FFFFFF", valign: "bottom", fit: "shrink" });
    if (model.subtitle) slide.addText(model.subtitle, { x: MARGIN, y: 4.25, w: W - MARGIN * 2 - 2, h: 1.0, fontSize: 20, fontFace: font, color: "E2E8F0", valign: "top", fit: "shrink" });
    slide.addText([model.author && `Prepared by ${model.author}`, model.audience && `For ${model.audience}`, model.date].filter(Boolean).join("   ·   "), { x: MARGIN + 1.7, y: H - 1.28, w: W - MARGIN * 2 - 1.7, h: 0.4, fontSize: 13, fontFace: font, color: "CBD5E1" });
  }

  // Agenda.
  const chapters = model.sections.filter((section) => section.level === 1);
  if (model.cover && model.contents && chapters.length >= 4) {
    const slide = titled("Agenda", "agenda", Math.min(chapters.length, 10) / 10);
    const shown = chapters.slice(0, 10);
    const half = Math.ceil(shown.length / (shown.length > 5 ? 2 : 1));
    [shown.slice(0, half), shown.slice(half)].forEach((column, at) => {
      if (!column.length) return;
      slide.addText(column.map((section, index) => ({ text: section.heading, options: { bullet: { type: "number", startAt: at * half + index + 1 }, breakLine: true, paraSpaceAfter: 10 } })), { x: BODY.x + at * (BODY.w / 2 + 0.1), y: BODY.y, w: shown.length > 5 ? BODY.w / 2 - 0.2 : BODY.w, h: BODY.h, fontSize: 20, fontFace: font, color: hex(theme.ink), valign: "top" });
    });
  }

  /** Bulleted text sized to its box; resolves to what didn't fit. */
  const textInto = (slide, unit, box) => {
    let y = box.y;
    let room = box.h;
    if (unit.lead) {
      const size = 18;
      const height = Math.min(room, linesFor(unit.lead, size, box.w) * size * 1.35 / 72 + 0.15);
      slide.addText(unit.lead, { x: box.x, y, w: box.w, h: height, fontSize: size, fontFace: font, color: hex(theme.ink), valign: "top", fit: "shrink" });
      y += height + 0.15;
      room -= height + 0.15;
    }
    let calloutHeight = 0;
    if (unit.callout) calloutHeight = Math.min(1.6, linesFor(unit.callout, 15, box.w - 0.5) * 15 * 1.35 / 72 + 0.35);
    room -= calloutHeight ? calloutHeight + 0.15 : 0;
    let rest = [];
    let used = 0;
    if (unit.items.length && room > 0.6) {
      let size = 20;
      let take = unit.items.length;
      const need = (count, at) => unit.items.slice(0, count).reduce((sum, item) => sum + linesFor(item, at, box.w - 0.45) * at * 1.3 / 72 + 0.13, 0);
      for (const candidate of [20, 18, 16, 14]) { size = candidate; if (need(Math.min(take, 8), candidate) <= room) break; }
      take = Math.min(take, 8);
      while (take > 1 && need(take, size) > room) take -= 1;
      rest = unit.items.slice(take);
      used = need(take, size);
      slide.addText(unit.items.slice(0, take).map((item) => ({ text: item, options: { bullet: unit.ordered ? { type: "number" } : { code: "25CF", indent: 18 }, breakLine: true, paraSpaceAfter: 8 } })), { x: box.x, y, w: box.w, h: Math.max(0.5, Math.min(room, used + 0.2)), fontSize: size, fontFace: font, color: hex(theme.ink), valign: "top", fit: "shrink" });
      y += used + 0.25;
    } else {
      rest = unit.items;
    }
    if (unit.callout) {
      const top = Math.min(y, box.y + box.h - calloutHeight);
      slide.addShape(pptx.ShapeType.rect, { x: box.x, y: top, w: box.w, h: calloutHeight, fill: { color: hex(theme.soft) }, line: { color: hex(theme.soft), width: 0 } });
      slide.addShape(pptx.ShapeType.rect, { x: box.x, y: top, w: 0.07, h: calloutHeight, fill: { color: hex(theme.accent) }, line: { color: hex(theme.accent), width: 0 } });
      slide.addText(unit.callout, { x: box.x + 0.25, y: top, w: box.w - 0.4, h: calloutHeight, fontSize: 15, fontFace: font, color: hex(theme.dark), valign: "middle", fit: "shrink" });
    }
    const fill = Math.min(1, (box.h - room + used + (calloutHeight ? calloutHeight + 0.15 : 0)) / box.h);
    return { rest, fill };
  };

  const chartInto = (slide, block, box) => {
    const data = block.series.map((series) => ({ name: series.name, labels: block.categories, values: series.values }));
    const common = { x: box.x, y: box.y, w: box.w, h: box.h, chartColors: theme.series.map(hex), showTitle: Boolean(block.title), title: block.title, titleFontSize: 14, titleFontFace: font, titleColor: hex(theme.dark), legendFontSize: 11, legendFontFace: font, legendPos: "b" };
    if (block.chart === "pie") slide.addChart(pptx.ChartType.pie, data, { ...common, showLegend: true, showPercent: true, dataLabelColor: "FFFFFF", dataLabelFontSize: 11 });
    else slide.addChart(block.chart === "line" ? pptx.ChartType.line : pptx.ChartType.bar, data, { ...common, barDir: "col", barGapWidthPct: 60, showLegend: block.series.length > 1, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11, catAxisLabelFontFace: font, valAxisLabelFontFace: font, valGridLine: { color: hex(theme.line), width: 0.75 }, lineSize: 2.5, lineDataSymbolSize: 7 });
    report.charts += 1;
  };

  for (const section of model.sections) {
    if (section.layout === "section") {
      const slide = record(pptx.addSlide({ masterName: "DARK" }), section.heading, "section");
      slide.addText(section.heading, { x: MARGIN, y: 2.4, w: W - MARGIN * 2, h: 2, fontSize: 40, fontFace: theme.font.heading, bold: true, color: "FFFFFF", valign: "middle", fit: "shrink" });
    }
    const units = plan(section);
    let first = true;
    const notes = (slide) => { if (first && section.notes) { slide.addNotes(section.notes); report.notes += 1; } first = false; };
    for (const unit of units) {
      if (unit.kind === "text") {
        let pending = unit;
        for (let page = 0; page < 12; page += 1) {
          const slide = titled(page ? `${section.heading} (continued)` : section.heading, section.layout === "conclusion" ? "conclusion" : "content");
          notes(slide);
          const { rest, fill } = textInto(slide, pending, BODY);
          report.slides[report.slides.length - 1].fill = Math.round(fill * 100) / 100;
          if (!rest.length) break;
          pending = { kind: "text", lead: "", items: rest, ordered: pending.ordered, callout: "" };
        }
      } else if (unit.kind === "chart") {
        const slide = titled(section.heading, "chart", 0.9);
        notes(slide);
        if (unit.beside) {
          textInto(slide, unit.beside, { x: BODY.x, y: BODY.y, w: BODY.w * 0.36, h: BODY.h });
          chartInto(slide, unit.block, { x: BODY.x + BODY.w * 0.4, y: BODY.y - 0.1, w: BODY.w * 0.6, h: BODY.h });
        } else {
          chartInto(slide, unit.block, { x: BODY.x + 0.6, y: BODY.y - 0.1, w: BODY.w - 1.2, h: BODY.h - (unit.block.caption ? 0.35 : 0) });
        }
        if (unit.block.caption) slide.addText(unit.block.caption, { x: BODY.x, y: BODY.y + BODY.h - 0.3, w: BODY.w, h: 0.3, fontSize: 11, fontFace: font, italic: true, color: hex(theme.muted), align: "center" });
      } else if (unit.kind === "table") {
        const { columns, rows } = unit.block;
        const size = columns.length > 6 ? 11 : 13;
        const lengths = columns.map((column, at) => Math.max(column.length, ...rows.slice(0, 40).map((row) => Math.min(display(row[at]).length, 40)), 5));
        const total = lengths.reduce((sum, value) => sum + value, 0);
        const colW = lengths.map((value) => Math.max(0.9, (value / total) * BODY.w));
        const scale = BODY.w / colW.reduce((sum, value) => sum + value, 0);
        const widths = colW.map((value) => value * scale);
        const rowHeight = (row) => Math.max(...row.map((cell, at) => linesFor(display(cell), size, widths[at] - 0.2))) * size * 1.3 / 72 + 0.16;
        const numeric = columns.map((_column, at) => rows.every((row) => row[at] === "" || typeof row[at] === "number" || /^[-+]?[$€£₹]?[\d,.]+%?$/.test(String(row[at]))));
        const header = columns.map((column) => ({ text: column, options: { bold: true, color: "FFFFFF", fill: { color: hex(theme.accent) }, fontFace: font, fontSize: size, valign: "middle" } }));
        let at = 0;
        let page = 0;
        while (at < rows.length) {
          const budget = BODY.h - (unit.block.caption ? 0.4 : 0) - rowHeight(columns);
          const chunk = [];
          let used = 0;
          while (at < rows.length && (chunk.length === 0 || used + rowHeight(rows[at]) <= budget)) { used += rowHeight(rows[at]); chunk.push(rows[at]); at += 1; }
          const slide = titled(page ? `${section.heading} (continued)` : section.heading, "table", Math.min(1, (used + rowHeight(columns)) / BODY.h));
          notes(slide);
          slide.addTable([header, ...chunk.map((row, index) => row.map((cell, col) => ({ text: display(cell), options: { fontFace: font, fontSize: size, color: hex(theme.ink), align: numeric[col] ? "right" : "left", valign: "middle", fill: { color: index % 2 ? hex(theme.soft) : hex(theme.paper) } } })))], { x: BODY.x, y: BODY.y, w: BODY.w, colW: widths, border: { type: "solid", pt: 0.5, color: hex(theme.line) }, margin: [0.05, 0.1, 0.05, 0.1] });
          if (unit.block.caption) slide.addText(unit.block.caption, { x: BODY.x, y: BODY.y + BODY.h - 0.3, w: BODY.w, h: 0.3, fontSize: 11, fontFace: font, italic: true, color: hex(theme.muted), align: "center" });
          report.tables += 1;
          page += 1;
        }
      } else if (unit.kind === "comparison") {
        const slide = titled(section.heading, "comparison", 0.85);
        notes(slide);
        const colW = (BODY.w - 0.4) / 2;
        [unit.block.left, unit.block.right].forEach((side, index) => {
          const x = BODY.x + index * (colW + 0.4);
          slide.addShape(pptx.ShapeType.rect, { x, y: BODY.y, w: colW, h: BODY.h, fill: { color: hex(theme.paper) }, line: { color: hex(theme.line), width: 1 } });
          slide.addShape(pptx.ShapeType.rect, { x, y: BODY.y, w: colW, h: 0.1, fill: { color: hex(index ? theme.series[1] : theme.accent) }, line: { color: hex(index ? theme.series[1] : theme.accent), width: 0 } });
          slide.addText(side.title || (index ? "Option B" : "Option A"), { x: x + 0.25, y: BODY.y + 0.2, w: colW - 0.5, h: 0.6, fontSize: 20, bold: true, fontFace: theme.font.heading, color: hex(theme.dark), valign: "middle", fit: "shrink" });
          const size = side.items.reduce((sum, item) => sum + linesFor(item, 17, colW - 0.9), 0) > 11 ? 14 : 17;
          slide.addText(side.items.map((item) => ({ text: item, options: { bullet: { code: "25CF", indent: 16 }, breakLine: true, paraSpaceAfter: 8 } })), { x: x + 0.25, y: BODY.y + 0.9, w: colW - 0.5, h: BODY.h - 1.05, fontSize: size, fontFace: font, color: hex(theme.ink), valign: "top", fit: "shrink" });
        });
      } else if (unit.kind === "diagram") {
        const slide = titled(section.heading, "diagram", 0.6);
        notes(slide);
        const steps = unit.block.steps;
        const arrow = 0.45;
        const box = (BODY.w - arrow * (steps.length - 1)) / steps.length;
        const y = BODY.y + 1.3;
        steps.forEach((step, index) => {
          const x = BODY.x + index * (box + arrow);
          slide.addShape(pptx.ShapeType.roundRect, { x, y, w: box, h: 1.7, fill: { color: hex(theme.soft) }, line: { color: hex(theme.accent), width: 1.5 }, rectRadius: 0.08 });
          slide.addText(String(index + 1), { x: x + 0.12, y: y + 0.08, w: 0.5, h: 0.35, fontSize: 13, bold: true, fontFace: font, color: hex(theme.accent) });
          slide.addText(step, { x: x + 0.1, y: y + 0.4, w: box - 0.2, h: 1.2, fontSize: step.length > 40 ? 13 : 16, bold: true, fontFace: font, color: hex(theme.dark), align: "center", valign: "middle", fit: "shrink" });
          if (index < steps.length - 1) slide.addShape(pptx.ShapeType.rightArrow, { x: x + box + 0.08, y: y + 0.68, w: arrow - 0.16, h: 0.34, fill: { color: hex(theme.accent) }, line: { color: hex(theme.accent), width: 0 } });
        });
        if (unit.block.caption) slide.addText(unit.block.caption, { x: BODY.x, y: y + 2.0, w: BODY.w, h: 0.4, fontSize: 13, fontFace: font, italic: true, color: hex(theme.muted), align: "center" });
      } else if (unit.kind === "image") {
        const slide = titled(section.heading, "image", 0.8);
        notes(slide);
        slide.addImage({ data: unit.block.data, x: BODY.x + 1, y: BODY.y, w: BODY.w - 2, h: BODY.h - 0.5, sizing: { type: "contain", w: BODY.w - 2, h: BODY.h - 0.5 }, altText: unit.block.alt || unit.block.caption || "Image" });
        if (unit.block.caption) slide.addText(unit.block.caption, { x: BODY.x, y: BODY.y + BODY.h - 0.35, w: BODY.w, h: 0.35, fontSize: 11, fontFace: font, italic: true, color: hex(theme.muted), align: "center" });
      }
    }
  }

  // References, eight to a slide, each a live link.
  for (let at = 0; at < model.references.length; at += 8) {
    const chunk = model.references.slice(at, at + 8);
    const slide = titled(at ? "References (continued)" : "References", "references", chunk.length / 8);
    slide.addText(chunk.flatMap((reference, index) => {
      const facts = [reference.publisher, reference.date].filter(Boolean).join(", ");
      return [
        { text: `[${at + index + 1}] ${reference.title}${facts ? ` (${facts})` : ""}`, options: { breakLine: Boolean(reference.url), color: hex(theme.ink) } },
        ...(reference.url ? [{ text: reference.url.length > 110 ? `${reference.url.slice(0, 107)}…` : reference.url, options: { hyperlink: { url: reference.url }, color: hex(theme.accent), fontSize: 10, breakLine: true, paraSpaceAfter: 8 } }] : [{ text: "", options: { breakLine: true, paraSpaceAfter: 8 } }]),
      ];
    }), { x: BODY.x, y: BODY.y, w: BODY.w, h: BODY.h, fontSize: 13, fontFace: font, valign: "top", fit: "shrink" });
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return { buffer, report, model };
}

module.exports = { renderPptx };
