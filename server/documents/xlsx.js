"use strict";

/**
 * Excel workbooks (.xlsx), written directly as SpreadsheetML.
 *
 * A workbook model in, a real workbook out:
 *   - several sheets, typed columns (text, number, integer, currency, percent, date);
 *   - formulas stay formulas ("=SUM(B2:B13)"), each with the value it computes
 *     to (see formulas.js), so viewers that don't recalculate still show numbers
 *     and Excel recalculates on open;
 *   - Excel tables (sort and filter buttons, banded rows), frozen header rows,
 *     conditional formatting, data validation and native charts.
 *
 * Nothing here calls a model. The model (or the person's own data) supplies the
 * workbook description; this file only lays it out.
 */
const JSZip = require("jszip");
const { evaluateWorkbook } = require("./formulas");
const { themeFor } = require("./theme");

const MAX_SHEETS = 12;
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 60;
const FORMATS = new Set(["text", "number", "integer", "currency", "percent", "date"]);

const xml = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[char]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const hex = (color) => String(color || "").replace("#", "").toUpperCase().padStart(6, "0").slice(0, 6);

function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
const cellRef = (row, col) => `${columnName(col)}${row + 1}`;
const absolute = (sheet, range) => `'${sheet.replace(/'/g, "''")}'!${range.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`;

function parseRange(range) {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/.exec(String(range || "").trim().toUpperCase());
  if (!match) return null;
  const col = (letters) => [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const from = { row: Number(match[2]) - 1, col: col(match[1]) };
  const to = match[3] ? { row: Number(match[4]) - 1, col: col(match[3]) } : from;
  return { from, to, text: match[3] ? `${match[1]}${match[2]}:${match[3]}${match[4]}` : `${match[1]}${match[2]}` };
}

/** Excel's day number for a calendar date (1900 date system). */
function dateSerial(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) + 25_569 : null;
}

/**
 * Text from outside (a row of someone's file, a table a model wrote) that
 * happens to begin with "=" is text, not a formula: writing it as a formula
 * would let a spreadsheet's contents run in the reader's Excel. Wrap such
 * values with literal(); only formulas HANNAH builds, or that a caller puts in
 * their own workbook description, are written as formulas.
 */
const literal = (value) => (typeof value === "string" && value.startsWith("=") ? { text: value } : value);
const isLiteral = (value) => Boolean(value) && typeof value === "object" && typeof value.text === "string";

function sheetName(raw, taken) {
  let name = String(raw || "Sheet").replace(/[[\]:*?/\\]/g, " ").replace(/^'+|'+$/g, "").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${name.slice(0, 31 - String(n).length - 1)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Check and tidy a workbook description. Throws an Error whose message a person
 * (or the model that wrote the description) can act on.
 */
function normalizeWorkbook(input) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400, reason: "invalid-workbook" }); };
  if (!input || typeof input !== "object" || !Array.isArray(input.sheets) || !input.sheets.length) fail("A workbook needs at least one sheet.");
  if (input.sheets.length > MAX_SHEETS) fail(`A workbook can have up to ${MAX_SHEETS} sheets.`);
  const taken = new Set();
  const renamed = new Map();
  const sheets = input.sheets.map((raw, index) => {
    if (!raw || typeof raw !== "object") fail(`Sheet ${index + 1} is not an object.`);
    const name = sheetName(raw.name || `Sheet ${index + 1}`, taken);
    if (raw.name && raw.name !== name) renamed.set(String(raw.name), name);
    const columns = (Array.isArray(raw.columns) ? raw.columns : []).slice(0, MAX_COLUMNS).map((column, at) => {
      const item = typeof column === "string" ? { header: column } : column || {};
      return {
        header: String(item.header ?? `Column ${at + 1}`).slice(0, 120),
        format: FORMATS.has(item.format) ? item.format : "text",
        width: Number.isFinite(item.width) ? Math.max(6, Math.min(80, Number(item.width))) : null,
      };
    });
    if (!columns.length) fail(`Sheet “${name}” needs its columns.`);
    const headers = new Set();
    for (const column of columns) {
      // Excel tables need distinct header names.
      let header = column.header || "Column";
      for (let n = 2; headers.has(header.toLowerCase()); n += 1) header = `${column.header} ${n}`;
      headers.add(header.toLowerCase());
      column.header = header;
    }
    // A cell may carry its own number format ({ value, format }), for a column that mixes money, counts and percentages.
    const cellFormats = new Map();
    const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, MAX_ROWS).map((row, rowAt) => {
      const cells = Array.isArray(row) ? row : columns.map((column) => row?.[column.header]);
      return columns.map((_column, at) => {
        let value = cells[at];
        if (value && typeof value === "object" && "value" in value) { if (FORMATS.has(value.format)) cellFormats.set(`${rowAt}:${at}`, value.format); value = value.value; }
        if (isLiteral(value)) return { text: value.text.slice(0, 8000) };
        if (value === null || value === undefined) return "";
        if (typeof value === "number") return Number.isFinite(value) ? value : "";
        if (typeof value === "boolean") return value;
        return String(value).slice(0, 8000);
      });
    });
    // A column of numbers typed as text would sum to zero: read it as numbers.
    columns.forEach((column, at) => {
      const values = rows.map((row) => row[at]).filter((value) => value !== "" && !isLiteral(value) && !(typeof value === "string" && value.startsWith("=")));
      if (column.format === "text" && values.length && values.every((value) => typeof value === "number" || /^-?\d+(\.\d+)?$/.test(String(value)))) column.format = values.every((value) => Number.isInteger(Number(value))) ? "integer" : "number";
      if (column.format !== "text" && column.format !== "date") rows.forEach((row) => { if (typeof row[at] === "string" && /^-?[\d,]+(\.\d+)?%?$/.test(row[at].trim()) && !row[at].startsWith("=")) row[at] = Number(row[at].replace(/[,%]/g, "")) / (row[at].trim().endsWith("%") ? 100 : 1); });
    });
    const totals = raw.totals && typeof raw.totals === "object" && rows.length ? {
      label: String(raw.totals.label || "Total").slice(0, 60),
      functions: Object.fromEntries(Object.entries(raw.totals.functions || raw.totals.formulas || {}).map(([key, fn]) => {
        const at = /^\d+$/.test(key) ? Number(key) : columns.findIndex((column) => column.header.toLowerCase() === String(key).toLowerCase());
        const name = String(fn).toUpperCase();
        return at >= 0 && at < columns.length && ["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "MEDIAN"].includes(name) ? [at, name] : null;
      }).filter(Boolean)),
    } : null;
    const lastRow = rows.length + (totals ? 1 : 0);
    const inSheet = (range) => {
      const parsed = parseRange(range);
      return parsed && parsed.to.col < Math.max(columns.length, 26) && parsed.to.row <= lastRow + 200 ? parsed : null;
    };
    const conditional = (Array.isArray(raw.conditional) ? raw.conditional : []).slice(0, 20).map((rule) => {
      const range = inSheet(rule?.range);
      const kind = String(rule?.rule || "");
      if (!range || !["greaterThan", "lessThan", "between", "equal", "colorScale", "dataBar"].includes(kind)) return null;
      return { range: range.text, rule: kind, value: Number(rule.value), value2: Number(rule.value2), color: ["green", "red", "amber"].includes(rule.color) ? rule.color : kind === "lessThan" ? "red" : "green" };
    }).filter((rule) => rule && (["colorScale", "dataBar"].includes(rule.rule) || Number.isFinite(rule.value)));
    const validation = (Array.isArray(raw.validation) ? raw.validation : []).slice(0, 20).map((rule) => {
      const range = inSheet(rule?.range);
      if (!range) return null;
      if (rule.type === "list" && Array.isArray(rule.values) && rule.values.length) {
        const values = rule.values.map((value) => String(value).replace(/[",]/g, " ").trim()).filter(Boolean).slice(0, 40);
        return values.join(",").length <= 250 ? { range: range.text, type: "list", values } : null;
      }
      if (["whole", "decimal"].includes(rule.type) && Number.isFinite(Number(rule.min)) && Number.isFinite(Number(rule.max))) return { range: range.text, type: rule.type, min: Number(rule.min), max: Number(rule.max) };
      return null;
    }).filter(Boolean);
    const charts = (Array.isArray(raw.charts) ? raw.charts : []).slice(0, 6).map((chart) => {
      const categories = inSheet(chart?.categories);
      const series = (Array.isArray(chart?.series) ? chart.series : []).slice(0, 8).map((item) => {
        const values = inSheet(item?.values);
        return values ? { name: String(item.name || "").slice(0, 80), values } : null;
      }).filter(Boolean);
      if (!categories || !series.length) return null;
      return { type: ["bar", "line", "pie"].includes(chart.type) ? chart.type : "bar", title: String(chart.title || "").slice(0, 120), categories, series: chart.type === "pie" ? series.slice(0, 1) : series, sheet: chart.sourceSheet ? String(chart.sourceSheet) : null };
    }).filter(Boolean);
    return {
      name, columns, rows, totals, conditional, validation, charts, cellFormats,
      freezeRows: raw.freeze === false ? 0 : 1,
      freezeColumns: Number.isInteger(raw.freeze?.columns) ? Math.max(0, Math.min(5, raw.freeze.columns)) : 0,
      // Rows become an Excel table (sort and filter buttons, banded rows) unless the sheet asks not to.
      table: raw.table !== false && rows.length > 0,
      note: raw.note ? String(raw.note).slice(0, 400) : "",
    };
  });
  // Formulas and chart sources that named a sheet we had to rename follow the rename.
  if (renamed.size) {
    const rename = (text) => { let out = text; for (const [from, to] of renamed) out = out.split(`'${from}'!`).join(`'${to}'!`).split(`${from}!`).join(`'${to}'!`); return out; };
    for (const sheet of sheets) {
      sheet.rows = sheet.rows.map((row) => row.map((cell) => (typeof cell === "string" && cell.startsWith("=") ? rename(cell) : cell)));
      for (const chart of sheet.charts) if (chart.sheet && renamed.has(chart.sheet)) chart.sheet = renamed.get(chart.sheet);
    }
  }
  for (const sheet of sheets) for (const chart of sheet.charts) if (!chart.sheet || !sheets.some((item) => item.name === chart.sheet)) chart.sheet = sheet.name;
  return { kind: "workbook", title: String(input.title || sheets[0].name).slice(0, 200), theme: input.theme || {}, sheets };
}

// Cell styles (indexes into cellXfs below).
const STYLE = { plain: 0, header: 1, number: 2, currency: 3, percent: 4, date: 5, integer: 6, totalLabel: 7, totalNumber: 8, totalCurrency: 9, totalPercent: 10, totalInteger: 11, wrap: 12, note: 13 };
const styleFor = (format, total) => (total
  ? ({ number: STYLE.totalNumber, currency: STYLE.totalCurrency, percent: STYLE.totalPercent, integer: STYLE.totalInteger })[format] ?? STYLE.totalLabel
  : ({ number: STYLE.number, currency: STYLE.currency, percent: STYLE.percent, integer: STYLE.integer, date: STYLE.date })[format] ?? STYLE.plain);

function stylesXml(theme) {
  const accent = hex(theme.accent);
  const xf = (numFmtId, fontId, fillId, borderId, extra = "") => `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${extra ? " applyAlignment=\"1\"" : ""}>${extra}</xf>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="166" formatCode="0.0%"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd"/></numFmts>
<fonts count="4"><font><sz val="11"/><color rgb="FF1F2937"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF111827"/><name val="Arial"/><family val="2"/></font><font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Arial"/><family val="2"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${accent}"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF6B7280"/></top><bottom style="double"><color rgb="FF6B7280"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
${xf(0, 0, 0, 0)}
${xf(0, 1, 2, 0, "<alignment vertical=\"center\" wrapText=\"1\"/>")}
${xf(164, 0, 0, 0)}
${xf(165, 0, 0, 0)}
${xf(166, 0, 0, 0)}
${xf(167, 0, 0, 0)}
${xf(3, 0, 0, 0)}
${xf(0, 2, 3, 2)}
${xf(164, 2, 3, 2)}
${xf(165, 2, 3, 2)}
${xf(166, 2, 3, 2)}
${xf(3, 2, 3, 2)}
${xf(0, 0, 0, 0, "<alignment vertical=\"top\" wrapText=\"1\"/>")}
${xf(0, 3, 0, 0)}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="3"><dxf><font><color rgb="FF166534"/></font><fill><patternFill><bgColor rgb="FFDCFCE7"/></patternFill></fill></dxf><dxf><font><color rgb="FF991B1B"/></font><fill><patternFill><bgColor rgb="FFFEE2E2"/></patternFill></fill></dxf><dxf><font><color rgb="FF92400E"/></font><fill><patternFill><bgColor rgb="FFFEF3C7"/></patternFill></fill></dxf></dxfs>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

function cellXml(ref, value, style, computed) {
  if (value === "" || value === null || value === undefined) return style ? `<c r="${ref}" s="${style}"/>` : "";
  if (isLiteral(value)) return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value.text)}</t></is></c>`;
  if (typeof value === "string" && value.startsWith("=")) {
    const formula = xml(value.slice(1));
    if (computed === undefined || computed === null) return `<c r="${ref}" s="${style}"><f>${formula}</f></c>`;
    if (typeof computed === "number") return `<c r="${ref}" s="${style}"><f>${formula}</f><v>${computed}</v></c>`;
    if (typeof computed === "boolean") return `<c r="${ref}" s="${style}" t="b"><f>${formula}</f><v>${computed ? 1 : 0}</v></c>`;
    return `<c r="${ref}" s="${style}" t="str"><f>${formula}</f><v>${xml(computed)}</v></c>`;
  }
  if (typeof value === "number") return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

/** The rows of a sheet as they sit in the file: header, data, then the totals row. */
function layout(sheet) {
  const grid = [sheet.columns.map((column) => column.header)];
  for (const row of sheet.rows) {
    grid.push(row.map((value, at) => {
      if (sheet.columns[at].format === "date" && typeof value === "string" && !value.startsWith("=")) return dateSerial(value) ?? value;
      return value;
    }));
  }
  if (sheet.totals) {
    const first = 2;
    const last = sheet.rows.length + 1;
    grid.push(sheet.columns.map((_column, at) => {
      if (sheet.totals.functions[at]) return `=${sheet.totals.functions[at]}(${columnName(at)}${first}:${columnName(at)}${last})`;
      return at === 0 ? sheet.totals.label : "";
    }));
  }
  return grid;
}

function chartXml(chart, values) {
  const cache = (range, kind) => {
    const points = [];
    for (let row = range.from.row; row <= range.to.row; row += 1) for (let col = range.from.col; col <= range.to.col; col += 1) points.push(values(chart.sheet, row, col));
    const body = points.map((point, index) => `<c:pt idx="${index}"><c:v>${xml(kind === "num" ? (typeof point === "number" ? point : Number(point) || 0) : point ?? "")}</c:v></c:pt>`).join("");
    return kind === "num" ? `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${points.length}"/>${body}</c:numCache>` : `<c:strCache><c:ptCount val="${points.length}"/>${body}</c:strCache>`;
  };
  const series = chart.series.map((item, index) => `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${xml(item.name || `Series ${index + 1}`)}</c:v></c:tx>${chart.type === "line" ? "<c:marker><c:symbol val=\"circle\"/><c:size val=\"5\"/></c:marker>" : ""}<c:cat><c:strRef><c:f>${xml(absolute(chart.sheet, chart.categories.text))}</c:f>${cache(chart.categories, "str")}</c:strRef></c:cat><c:val><c:numRef><c:f>${xml(absolute(chart.sheet, item.values.text))}</c:f>${cache(item.values, "num")}</c:numRef></c:val>${chart.type === "line" ? "<c:smooth val=\"0\"/>" : ""}</c:ser>`).join("");
  const axes = "<c:catAx><c:axId val=\"111111111\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"b\"/><c:numFmt formatCode=\"General\" sourceLinked=\"0\"/><c:majorTickMark val=\"none\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"222222222\"/><c:crosses val=\"autoZero\"/><c:auto val=\"1\"/><c:lblAlgn val=\"ctr\"/><c:lblOffset val=\"100\"/><c:noMultiLvlLbl val=\"0\"/></c:catAx><c:valAx><c:axId val=\"222222222\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling><c:delete val=\"0\"/><c:axPos val=\"l\"/><c:majorGridlines/><c:numFmt formatCode=\"General\" sourceLinked=\"0\"/><c:majorTickMark val=\"none\"/><c:minorTickMark val=\"none\"/><c:tickLblPos val=\"nextTo\"/><c:crossAx val=\"111111111\"/><c:crosses val=\"autoZero\"/><c:crossBetween val=\"between\"/></c:valAx>";
  const plot = chart.type === "pie"
    ? `<c:pieChart><c:varyColors val="1"/>${series}<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`
    : chart.type === "line"
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="111111111"/><c:axId val="222222222"/></c:lineChart>${axes}`
      : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/><c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>${axes}`;
  const title = chart.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1300" b="1"/><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : "<c:autoTitleDeleted val=\"1\"/>";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

/**
 * Write a workbook. Resolves to { buffer, report }: the report says what the
 * file holds (sheets, formulas, charts) and lists any formula that didn't
 * compute, so nothing is shipped silently broken.
 */
async function renderXlsx(input) {
  const workbook = normalizeWorkbook(input);
  const theme = themeFor(workbook.theme);
  const grids = workbook.sheets.map(layout);
  // For working out formulas, literal text is just text (never something to evaluate).
  const evaluated = evaluateWorkbook(workbook.sheets.map((sheet, index) => ({ name: sheet.name, grid: grids[index].map((row) => row.map((cell) => (isLiteral(cell) ? `'${cell.text}` : cell))) })));
  const valueAt = (sheetNameText, row, col) => {
    const index = workbook.sheets.findIndex((sheet) => sheet.name === sheetNameText);
    if (index < 0) return "";
    const raw = grids[index][row]?.[col];
    if (isLiteral(raw)) return raw.text;
    if (typeof raw === "string" && raw.startsWith("=")) return evaluated.values[index][row]?.[col] ?? "";
    return raw ?? "";
  };

  const zip = new JSZip();
  const overrides = [];
  let tableCount = 0;
  let chartCount = 0;
  let drawingCount = 0;
  const report = { sheets: [], formulas: evaluated.count, formulaErrors: evaluated.errors, formulasNotChecked: evaluated.unchecked, charts: 0, tables: 0 };

  workbook.sheets.forEach((sheet, index) => {
    const grid = grids[index];
    const lastCol = sheet.columns.length - 1;
    const dataEnd = sheet.rows.length; // zero-based row index of the last data row
    const rels = [];
    const rowsXml = grid.map((row, rowIndex) => {
      const header = rowIndex === 0;
      const total = Boolean(sheet.totals) && rowIndex === grid.length - 1;
      const cells = row.map((value, col) => {
        const format = sheet.cellFormats.get(`${rowIndex - 1}:${col}`) || sheet.columns[col].format;
        const style = header ? STYLE.header : total ? styleFor(format, true) : isLiteral(value) ? STYLE.plain : typeof value === "string" && !value.startsWith("=") && value.length > 60 ? STYLE.wrap : styleFor(format, false);
        return cellXml(cellRef(rowIndex, col), value, style, evaluated.values[index][rowIndex]?.[col]);
      }).join("");
      return `<row r="${rowIndex + 1}"${header ? " ht=\"22\" customHeight=\"1\"" : ""}>${cells}</row>`;
    });
    let noteRow = "";
    if (sheet.note) noteRow = `<row r="${grid.length + 2}"><c r="A${grid.length + 2}" s="${STYLE.note}" t="inlineStr"><is><t xml:space="preserve">${xml(sheet.note)}</t></is></c></row>`;

    const widths = sheet.columns.map((column, col) => {
      if (column.width) return column.width;
      const longest = grid.reduce((max, row) => {
        const value = row[col];
        const text = isLiteral(value) ? value.text : typeof value === "string" && value.startsWith("=") ? String(evaluated.values[index][grid.indexOf(row)]?.[col] ?? "") : String(value ?? "");
        return Math.max(max, Math.min(text.length, 60));
      }, column.header.length);
      return Math.max(9, Math.min(48, longest + 3));
    });

    const parts = [];
    parts.push(`<dimension ref="A1:${cellRef(Math.max(grid.length - 1, 0), lastCol)}"/>`);
    const frozen = sheet.freezeRows || sheet.freezeColumns;
    const pane = frozen ? `<pane${sheet.freezeColumns ? ` xSplit="${sheet.freezeColumns}"` : ""}${sheet.freezeRows ? ` ySplit="${sheet.freezeRows}"` : ""} topLeftCell="${cellRef(sheet.freezeRows, sheet.freezeColumns)}" activePane="${sheet.freezeColumns && sheet.freezeRows ? "bottomRight" : sheet.freezeRows ? "bottomLeft" : "topRight"}" state="frozen"/>` : "";
    parts.push(`<sheetViews><sheetView workbookViewId="0"${index === 0 ? " tabSelected=\"1\"" : ""}>${pane}</sheetView></sheetViews>`);
    parts.push("<sheetFormatPr defaultRowHeight=\"15\"/>");
    parts.push(`<cols>${widths.map((width, col) => `<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`);
    parts.push(`<sheetData>${rowsXml.join("")}${noteRow}</sheetData>`);
    const tableRef = `A1:${cellRef(dataEnd, lastCol)}`;
    if (!sheet.table && sheet.rows.length) parts.push(`<autoFilter ref="${tableRef}"/>`);
    let priority = 1;
    for (const rule of sheet.conditional) {
      const dxf = { green: 0, red: 1, amber: 2 }[rule.color];
      let body;
      if (rule.rule === "colorScale") body = `<cfRule type="colorScale" priority="${priority}"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule>`;
      else if (rule.rule === "dataBar") body = `<cfRule type="dataBar" priority="${priority}"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF${hex(theme.accent)}"/></dataBar></cfRule>`;
      else body = `<cfRule type="cellIs" dxfId="${dxf}" priority="${priority}" operator="${rule.rule}"><formula>${rule.value}</formula>${rule.rule === "between" ? `<formula>${Number.isFinite(rule.value2) ? rule.value2 : rule.value}</formula>` : ""}</cfRule>`;
      parts.push(`<conditionalFormatting sqref="${rule.range}">${body}</conditionalFormatting>`);
      priority += 1;
    }
    if (sheet.validation.length) {
      parts.push(`<dataValidations count="${sheet.validation.length}">${sheet.validation.map((rule) => (rule.type === "list"
        ? `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${rule.range}"><formula1>"${xml(rule.values.join(","))}"</formula1></dataValidation>`
        : `<dataValidation type="${rule.type}" operator="between" allowBlank="1" showErrorMessage="1" errorTitle="Out of range" error="Enter a value from ${rule.min} to ${rule.max}." sqref="${rule.range}"><formula1>${rule.min}</formula1><formula2>${rule.max}</formula2></dataValidation>`)).join("")}</dataValidations>`);
    }
    parts.push("<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>");

    if (sheet.charts.length) {
      drawingCount += 1;
      const drawingRels = [];
      const anchors = sheet.charts.map((chart, at) => {
        chartCount += 1;
        zip.file(`xl/charts/chart${chartCount}.xml`, chartXml(chart, valueAt));
        overrides.push(`<Override PartName="/xl/charts/chart${chartCount}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        drawingRels.push(`<Relationship Id="rId${at + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartCount}.xml"/>`);
        // Charts sit to the right of the data, stacked two per row.
        const col = lastCol + 2 + (at % 2) * 9;
        const row = 1 + Math.floor(at / 2) * 18;
        return `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 16}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${at + 2}" name="Chart ${at + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${at + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
      });
      zip.file(`xl/drawings/drawing${drawingCount}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join("")}</xdr:wsDr>`);
      zip.file(`xl/drawings/_rels/drawing${drawingCount}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join("")}</Relationships>`);
      overrides.push(`<Override PartName="/xl/drawings/drawing${drawingCount}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      rels.push(`<Relationship Id="rId${rels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingCount}.xml"/>`);
      parts.push(`<drawing r:id="rId${rels.length}"/>`);
    }
    if (sheet.table) {
      tableCount += 1;
      zip.file(`xl/tables/table${tableCount}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableCount}" name="Table${tableCount}" displayName="Table${tableCount}" ref="${tableRef}" totalsRowShown="0"><autoFilter ref="${tableRef}"/><tableColumns count="${sheet.columns.length}">${sheet.columns.map((column, col) => `<tableColumn id="${col + 1}" name="${xml(column.header)}"/>`).join("")}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`);
      overrides.push(`<Override PartName="/xl/tables/table${tableCount}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`);
      rels.push(`<Relationship Id="rId${rels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableCount}.xml"/>`);
      parts.push(`<tableParts count="1"><tablePart r:id="rId${rels.length}"/></tableParts>`);
    }
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${parts.join("")}</worksheet>`);
    if (rels.length) zip.file(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
    overrides.push(`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    report.sheets.push({ name: sheet.name, rows: sheet.rows.length, columns: sheet.columns.length, charts: sheet.charts.length, table: sheet.table, conditional: sheet.conditional.length, validation: sheet.validation.length });
  });
  report.charts = chartCount;
  report.tables = tableCount;

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${overrides.join("")}</Types>`);
  zip.file("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>");
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(workbook.title)}</dc:title><dc:creator>HANNAH</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews><sheets>${workbook.sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbook.sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${workbook.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("xl/styles.xml", stylesXml(theme));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { buffer, report, model: workbook };
}

module.exports = { MAX_ROWS, cellRef, columnName, dateSerial, isLiteral, literal, normalizeWorkbook, parseRange, renderXlsx };
