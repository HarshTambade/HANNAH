"use strict";

/**
 * Word documents (.docx) from the document model. Everything stays editable:
 * real heading styles (so Word's navigation pane and table of contents work),
 * real lists and tables, a contents field Word fills in, a running header and
 * "Page x of y" footer, live reference links and the person's own images.
 *
 * Charts: Word's native chart objects need a full embedded workbook, which
 * this file doesn't write. A chart is shown as a bar table (label, bar, value)
 * that stays editable text, and says so in its caption.
 */
const {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, LevelFormat, Packer, PageBreak, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableOfContents, TableRow, TextRun, VerticalAlign, WidthType,
} = require("docx");
const { normalizeDocument } = require("./model");
const { themeFor } = require("./theme");

const hex = (color) => String(color).replace("#", "");
const display = (cell) => (typeof cell === "number" ? cell.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(cell ?? ""));
const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };

/** Width and height of a PNG or JPEG, read from its own header. */
function imageSize(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: "png" };
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), type: "jpg" };
      offset += 2 + length;
    }
  }
  return null;
}

async function renderDocx(input) {
  const model = normalizeDocument(input);
  const theme = themeFor(model.theme);
  const accent = hex(theme.accent);
  const text = (value, options = {}) => new TextRun({ text: String(value ?? ""), ...options });
  const para = (value, options = {}) => new Paragraph({ children: [text(value, options.run)], spacing: { after: 140, line: 300 }, ...options.paragraph });
  const cell = (children, options = {}) => new TableCell({ children: Array.isArray(children) ? children : [children], margins: { top: 70, bottom: 70, left: 110, right: 110 }, verticalAlign: VerticalAlign.CENTER, ...options });
  const caption = (value) => (value ? [new Paragraph({ children: [text(value, { italics: true, size: 18, color: hex(theme.muted) })], alignment: AlignmentType.CENTER, spacing: { before: 80, after: 200 } })] : [new Paragraph({ children: [], spacing: { after: 120 } })]);

  const tableOf = (block) => {
    const numeric = block.columns.map((_column, at) => block.rows.every((row) => row[at] === "" || typeof row[at] === "number" || /^[-+]?[$€£₹]?[\d,.]+%?$/.test(String(row[at]))));
    const size = block.columns.length > 6 ? 16 : 19;
    const header = new TableRow({
      tableHeader: true,
      children: block.columns.map((column) => cell(new Paragraph({ children: [text(column, { bold: true, color: "FFFFFF", size })] }), { shading: { type: ShadingType.CLEAR, color: "auto", fill: accent } })),
    });
    const rows = block.rows.map((row, index) => new TableRow({
      cantSplit: true,
      children: row.map((value, at) => cell(new Paragraph({ children: [text(display(value), { size })], alignment: numeric[at] ? AlignmentType.RIGHT : AlignmentType.LEFT }), index % 2 ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) } } : {})),
    }));
    const line = { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) };
    return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows], borders: { top: line, bottom: line, left: NONE, right: NONE, insideHorizontal: line, insideVertical: NONE } }), ...caption(block.caption)];
  };

  const chartOf = (block) => {
    const max = Math.max(...block.series.flatMap((series) => series.values.map((value) => Math.abs(value))), 1);
    const size = 18;
    const rows = [];
    block.categories.forEach((category, at) => {
      block.series.forEach((series, index) => {
        const value = series.values[at];
        rows.push(new TableRow({
          cantSplit: true,
          children: [
            cell(new Paragraph({ children: [text(index === 0 ? category : "", { bold: true, size })] }), { borders: NO_BORDERS, width: { size: 24, type: WidthType.PERCENTAGE } }),
            ...(block.series.length > 1 ? [cell(new Paragraph({ children: [text(series.name, { size, color: hex(theme.muted) })] }), { borders: NO_BORDERS, width: { size: 16, type: WidthType.PERCENTAGE } })] : []),
            cell(new Paragraph({ children: [text("█".repeat(Math.max(1, Math.round((Math.abs(value) / max) * 28))), { color: hex(theme.series[index % theme.series.length]), size: 16 })] }), { borders: NO_BORDERS }),
            cell(new Paragraph({ children: [text(`${display(value)}${block.unit ? ` ${block.unit}` : ""}`, { size })], alignment: AlignmentType.RIGHT }), { borders: NO_BORDERS, width: { size: 14, type: WidthType.PERCENTAGE } }),
          ],
        }));
      });
    });
    const note = block.chart === "bar" ? "" : ` (${block.chart} chart data shown as bars)`;
    return [
      ...(block.title ? [new Paragraph({ children: [text(block.title, { bold: true, size: 22, color: hex(theme.dark) })], spacing: { before: 120, after: 80 }, keepNext: true })] : []),
      new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows, borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE } }),
      ...caption(`${block.caption || ""}${note}`.trim()),
    ];
  };

  const blocksOf = (section) => section.blocks.flatMap((block) => {
    if (block.type === "paragraph") return [para(block.text)];
    if (block.type === "bullets") {
      return block.items.map((item) => new Paragraph({ children: [text(item)], spacing: { after: 80, line: 290 }, ...(block.ordered ? { numbering: { reference: "numbered", level: 0 } } : { bullet: { level: 0 } }) }));
    }
    if (block.type === "table") return tableOf(block);
    if (block.type === "chart") return chartOf(block);
    if (block.type === "callout") {
      return [new Paragraph({ children: [text(block.text, { color: hex(theme.dark) })], shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 8 } }, spacing: { before: 120, after: 200, line: 300 }, indent: { left: 160, right: 160 } })];
    }
    if (block.type === "comparison") {
      const side = (value, color) => cell([
        new Paragraph({ children: [text(value.title || "", { bold: true, size: 22, color: hex(theme.dark) })], spacing: { after: 80 } }),
        ...value.items.map((item) => new Paragraph({ children: [text(item)], bullet: { level: 0 }, spacing: { after: 60 } })),
      ], { verticalAlign: VerticalAlign.TOP, width: { size: 50, type: WidthType.PERCENTAGE }, borders: { top: { style: BorderStyle.SINGLE, size: 18, color }, bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) }, left: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) }, right: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) } } });
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [side(block.left, accent), side(block.right, hex(theme.series[1]))] })] }), ...caption("")];
    }
    if (block.type === "diagram") {
      const cells = [];
      block.steps.forEach((step, index) => {
        cells.push(cell(new Paragraph({ children: [text(`${index + 1}. `, { bold: true, color: accent, size: 18 }), text(step, { bold: true, size: 18, color: hex(theme.dark) })], alignment: AlignmentType.CENTER }), { shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) }, borders: { top: { style: BorderStyle.SINGLE, size: 6, color: accent }, bottom: { style: BorderStyle.SINGLE, size: 6, color: accent }, left: { style: BorderStyle.SINGLE, size: 6, color: accent }, right: { style: BorderStyle.SINGLE, size: 6, color: accent } } }));
        if (index < block.steps.length - 1) cells.push(cell(new Paragraph({ children: [text("→", { bold: true, color: accent, size: 24 })], alignment: AlignmentType.CENTER }), { borders: NO_BORDERS, width: { size: 4, type: WidthType.PERCENTAGE } }));
      });
      return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: cells })], borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE } }), ...caption(block.caption)];
    }
    if (block.type === "image") {
      const data = Buffer.from(block.data.split(",")[1], "base64");
      const size = imageSize(data);
      if (!size) return [para(`[Image not included: ${block.alt || block.caption || "the file couldn't be read"}]`, { run: { italics: true } })];
      const scale = Math.min(600 / size.width, 380 / size.height, 1);
      return [new Paragraph({ children: [new ImageRun({ data, type: size.type, transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }, altText: { title: block.alt || block.caption || "Image", description: block.alt || block.caption || "Image", name: "Image" } })], alignment: AlignmentType.CENTER, spacing: { before: 120 } }), ...caption(block.caption)];
    }
    if (block.type === "pagebreak") return [new Paragraph({ children: [new PageBreak()] })];
    return [];
  });

  const body = [];
  if (model.contents && model.sections.length >= 3) {
    body.push(new Paragraph({ children: [text("Contents", { bold: true, size: 36, color: hex(theme.dark) })], spacing: { after: 200 } }));
    body.push(new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }));
    body.push(new Paragraph({ children: [new PageBreak()] }));
  }
  for (const section of model.sections) {
    body.push(new Paragraph({ text: section.heading, heading: section.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1 }));
    body.push(...blocksOf(section));
  }
  if (model.references.length) {
    body.push(new Paragraph({ text: "References", heading: HeadingLevel.HEADING_1 }));
    model.references.forEach((reference, index) => {
      const facts = [reference.publisher, reference.date].filter(Boolean).join(", ");
      body.push(new Paragraph({
        children: [
          text(`[${index + 1}] `, { bold: true, color: accent }), text(`${reference.title}${facts ? ` (${facts})` : ""}${reference.url ? ". " : ""}`),
          ...(reference.url ? [new ExternalHyperlink({ link: reference.url, children: [text(reference.url, { style: "Hyperlink" })] })] : []),
        ],
        spacing: { after: 100 }, indent: { left: 420, hanging: 420 },
      }));
    });
  }

  const logo = theme.logo ? Buffer.from(theme.logo.split(",")[1], "base64") : null;
  const logoSize = logo ? imageSize(logo) : null;
  const cover = model.cover ? [{
    properties: { page: { margin: { top: 2600, bottom: 1440, left: 1300, right: 1300 } } },
    children: [
      ...(logo && logoSize ? [new Paragraph({ children: [new ImageRun({ data: logo, type: logoSize.type, transformation: { width: Math.round(logoSize.width * Math.min(160 / logoSize.width, 64 / logoSize.height, 1)), height: Math.round(logoSize.height * Math.min(160 / logoSize.width, 64 / logoSize.height, 1)) } })], spacing: { after: 400 } })] : []),
      new Paragraph({ children: [text(model.title, { bold: true, size: 64, color: hex(theme.dark) })], spacing: { after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 12 } } }),
      ...(model.subtitle ? [new Paragraph({ children: [text(model.subtitle, { size: 30, color: hex(theme.ink) })], spacing: { before: 240, after: 600 } })] : []),
      ...[model.author && `Prepared by ${model.author}`, model.audience && `For ${model.audience}`, model.date].filter(Boolean).map((line) => new Paragraph({ children: [text(line, { size: 22, color: hex(theme.muted) })], spacing: { after: 80 } })),
    ],
  }] : [];

  const document = new Document({
    creator: model.author || "HANNAH",
    title: model.title,
    description: model.subtitle,
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: theme.font.body, size: 22, color: hex(theme.ink) } },
        heading1: { run: { font: theme.font.heading, size: 34, bold: true, color: hex(theme.dark) }, paragraph: { spacing: { before: 360, after: 160 }, keepNext: true } },
        heading2: { run: { font: theme.font.heading, size: 26, bold: true, color: hex(theme.dark) }, paragraph: { spacing: { before: 260, after: 120 }, keepNext: true } },
      },
    },
    numbering: { config: [{ reference: "numbered", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [
      ...cover,
      {
        properties: { page: { margin: { top: 1500, bottom: 1300, left: 1300, right: 1300 }, pageNumbers: { start: 1 } } },
        headers: { default: new Header({ children: [new Paragraph({ children: [text(model.title, { size: 17, color: hex(theme.muted) })], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line), space: 6 } } })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 17, color: hex(theme.muted) })] })] }) },
        children: body,
      },
    ],
  });
  const buffer = await Packer.toBuffer(document);
  return { buffer, report: { headings: model.sections.length + (model.references.length ? 1 : 0), contents: model.contents && model.sections.length >= 3 }, model };
}

module.exports = { imageSize, renderDocx };
