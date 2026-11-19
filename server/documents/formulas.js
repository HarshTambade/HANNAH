"use strict";

/**
 * Works out what each formula in a workbook computes to, before the file is
 * written. Two reasons:
 *   - the result is stored beside the formula, so previews and viewers that
 *     don't recalculate show numbers (Excel recalculates on open anyway);
 *   - a formula that doesn't parse, points at a sheet that doesn't exist or
 *     ends in an error (#REF!, #NAME?, #DIV/0!) is reported instead of shipped.
 *
 * The formula itself is always what's written to the cell; the computed value
 * is never put in its place.
 */
const FormulaParser = require("fast-formula-parser");

const { FormulaError } = FormulaParser;
const isFormula = (value) => typeof value === "string" && value.startsWith("=") && value.length > 1;

// Common functions the evaluator lacks. Arguments arrive as { value } wrappers; ranges as nested arrays.
const flat = (args) => {
  const out = [];
  const walk = (value) => { if (Array.isArray(value)) value.forEach(walk); else out.push(value); };
  args.forEach((arg) => walk(arg && typeof arg === "object" && !Array.isArray(arg) && "value" in arg ? arg.value : arg));
  return out;
};
const numbers = (args) => flat(args).filter((value) => typeof value === "number" && Number.isFinite(value));
const one = (arg) => flat([arg])[0];
const need = (list) => { if (!list.length) throw new FormulaError("#NUM!"); return list; };
const variance = (list, sample) => {
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
  return list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (list.length - (sample ? 1 : 0));
};
const sorted = (args) => need(numbers(args)).sort((a, b) => a - b);
const percentile = (list, k) => {
  const position = (list.length - 1) * k;
  const low = Math.floor(position);
  return list[low] + (list[Math.min(low + 1, list.length - 1)] - list[low]) * (position - low);
};
// Payment per period for a loan or annuity (Excel's sign convention: money paid out is negative).
const pmt = (rate, periods, present, future = 0, due = 0) => (rate === 0 ? -(present + future) / periods : -(rate * (present * (1 + rate) ** periods + future)) / ((1 + rate * due) * ((1 + rate) ** periods - 1)));
const EXTRA_FUNCTIONS = {
  MIN: (...args) => { const list = numbers(args); return list.length ? Math.min(...list) : 0; },
  MAX: (...args) => { const list = numbers(args); return list.length ? Math.max(...list) : 0; },
  COUNTA: (...args) => flat(args).filter((value) => value !== null && value !== undefined && value !== "").length,
  MEDIAN: (...args) => percentile(sorted(args), 0.5),
  LARGE: (range, k) => { const list = sorted([range]); const at = list.length - Number(one(k)); if (at < 0 || at >= list.length) throw new FormulaError("#NUM!"); return list[at]; },
  SMALL: (range, k) => { const list = sorted([range]); const at = Number(one(k)) - 1; if (at < 0 || at >= list.length) throw new FormulaError("#NUM!"); return list[at]; },
  PERCENTILE: (range, k) => percentile(sorted([range]), Number(one(k))),
  QUARTILE: (range, q) => percentile(sorted([range]), Number(one(q)) / 4),
  STDEV: (...args) => Math.sqrt(variance(need(numbers(args)), true)),
  "STDEV.S": (...args) => Math.sqrt(variance(need(numbers(args)), true)),
  "STDEV.P": (...args) => Math.sqrt(variance(need(numbers(args)), false)),
  VAR: (...args) => variance(need(numbers(args)), true),
  "VAR.S": (...args) => variance(need(numbers(args)), true),
  RANK: (value, range, order) => { const list = numbers([range]); const target = Number(one(value)); const ascending = Number(one(order) || 0) !== 0; return 1 + list.filter((item) => (ascending ? item < target : item > target)).length; },
  PMT: (rate, periods, present, future, due) => pmt(Number(one(rate)), Number(one(periods)), Number(one(present)), Number(one(future) || 0), Number(one(due) || 0)),
  FV: (rate, periods, payment, present, due) => { const r = Number(one(rate)); const n = Number(one(periods)); const p = Number(one(payment)); const pv = Number(one(present) || 0); const d = Number(one(due) || 0); return r === 0 ? -(pv + p * n) : -(pv * (1 + r) ** n + (p * (1 + r * d) * ((1 + r) ** n - 1)) / r); },
  PV: (rate, periods, payment, future, due) => { const r = Number(one(rate)); const n = Number(one(periods)); const p = Number(one(payment)); const fv = Number(one(future) || 0); const d = Number(one(due) || 0); return r === 0 ? -(fv + p * n) : -(fv + (p * (1 + r * d) * ((1 + r) ** n - 1)) / r) / (1 + r) ** n; },
  NPV: (rate, ...flows) => numbers(flows).reduce((sum, value, index) => sum + value / (1 + Number(one(rate))) ** (index + 1), 0),
  UPPER: (text) => String(one(text) ?? "").toUpperCase(),
  SUBSTITUTE: (text, from, to) => String(one(text) ?? "").split(String(one(from) ?? "")).join(String(one(to) ?? "")),
  VALUE: (text) => { const value = Number(String(one(text) ?? "").replace(/[,\s]/g, "")); if (!Number.isFinite(value)) throw new FormulaError("#VALUE!"); return value; },
  CHOOSE: (index, ...options) => { const at = Number(one(index)); if (!(at >= 1 && at <= options.length)) throw new FormulaError("#VALUE!"); return one(options[at - 1]); },
  MATCH: (value, range, type) => {
    const list = flat([range]);
    const target = one(value);
    const same = (item) => (typeof item === "string" && typeof target === "string" ? item.toLowerCase() === target.toLowerCase() : item === target);
    let at = -1;
    if (Number(one(type) ?? 1) === 0) at = list.findIndex(same);
    else list.forEach((item, index) => { if (item !== null && item <= target) at = index; });
    if (at < 0) throw new FormulaError("#N/A");
    return at + 1;
  },
};

function evaluateWorkbook(sheets) {
  const byName = new Map(sheets.map((sheet, index) => [sheet.name.toLowerCase(), index]));
  const values = sheets.map((sheet) => sheet.grid.map((row) => row.map(() => undefined)));
  const errors = [];
  const unchecked = [];
  const working = new Set();
  let count = 0;
  const address = (row, col) => {
    let name = "";
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return `${name}${row + 1}`;
  };

  const read = (sheetName, row, col) => {
    const index = byName.get(String(sheetName).toLowerCase());
    if (index === undefined) throw new FormulaError("#REF!", `There is no sheet called “${sheetName}”.`);
    const raw = sheets[index].grid[row]?.[col];
    if (!isFormula(raw)) return raw === "" || raw === undefined ? null : raw;
    return compute(index, row, col);
  };

  // Working out one formula can mean working out another first (a total of a column of formulas). The parser
  // can't be re-entered while it is parsing, so each level of that nesting gets its own.
  const parsers = [];
  let depth = 0;
  const makeParser = () => new FormulaParser({
    functions: EXTRA_FUNCTIONS,
    onCell: ({ sheet, row, col }) => read(sheet, row - 1, col - 1),
    onRange: ({ sheet, from, to }) => {
      const index = byName.get(String(sheet).toLowerCase());
      if (index === undefined) throw new FormulaError("#REF!", `There is no sheet called “${sheet}”.`);
      // A whole-column reference (A:A) covers a million rows; only the used ones matter.
      const lastRow = Math.min(to.row, sheets[index].grid.length);
      const lastCol = Math.min(to.col, Math.max(...sheets[index].grid.map((row) => row.length), 1));
      const block = [];
      for (let row = from.row; row <= lastRow; row += 1) {
        const line = [];
        for (let col = from.col; col <= lastCol; col += 1) line.push(read(sheet, row - 1, col - 1));
        block.push(line);
      }
      return block;
    },
  });

  function compute(index, row, col) {
    const known = values[index][row][col];
    if (known !== undefined) return known instanceof Error ? null : known;
    const key = `${index}:${row}:${col}`;
    const formula = sheets[index].grid[row][col];
    const fail = (error) => {
      // A function this checker doesn't know isn't a broken formula: Excel computes it; it's listed as not checked.
      const text = `${error?.details?.message || ""} ${error?.message || ""}`;
      if (/is not implemented/i.test(text)) {
        unchecked.push({ sheet: sheets[index].name, cell: address(row, col), formula });
        values[index][row][col] = new Error("unchecked");
        return null;
      }
      const message = error instanceof FormulaError ? `${error.error || error.name}${error.details ? ` (${String(error.details.message || error.details).slice(0, 160)})` : ""}` : String(error?.message || error).split("\n")[0].slice(0, 200);
      errors.push({ sheet: sheets[index].name, cell: address(row, col), formula, error: message });
      values[index][row][col] = new Error(message);
      return null;
    };
    if (working.has(key)) return fail(new Error("This formula refers back to itself."));
    working.add(key);
    try {
      const parser = parsers[depth] || (parsers[depth] = makeParser());
      depth += 1;
      let result;
      try { result = parser.parse(formula.slice(1), { sheet: sheets[index].name, row: row + 1, col: col + 1 }); } finally { depth -= 1; }
      if (result instanceof FormulaError) return fail(result);
      if (Array.isArray(result)) result = Array.isArray(result[0]) ? result[0][0] : result[0];
      if (typeof result === "number" && !Number.isFinite(result)) return fail(new Error("#NUM!"));
      values[index][row][col] = result ?? "";
      return values[index][row][col];
    } catch (error) {
      return fail(error);
    } finally {
      working.delete(key);
    }
  }

  sheets.forEach((sheet, index) => sheet.grid.forEach((row, rowIndex) => row.forEach((value, col) => {
    if (!isFormula(value)) return;
    count += 1;
    compute(index, rowIndex, col);
  })));
  // Failed formulas keep their formula in the file with no stored value.
  const clean = values.map((grid) => grid.map((row) => row.map((value) => (value instanceof Error ? undefined : value))));
  return { values: clean, count, errors, unchecked };
}

module.exports = { evaluateWorkbook, isFormula };
