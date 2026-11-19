# Research and Document Studio

HANNAH can research a question on the web and cite what it read, read files you give it, and make PowerPoint, PDF, Word and Excel files. This page describes how those two capabilities are built, what they guarantee, their API, and their limits.

## One service each, used by everything

Research and document-making are platform services, not features of one agent. Each is implemented once on the server, and every part of HANNAH reaches it the same way.

| Service | Code | What it does |
|---|---|---|
| Research engine | `server/research/` | Plans searches, runs them on interchangeable providers, opens and reads pages, picks evidence, scores sources, writes an answer and checks its citations |
| Document Studio | `server/documents/` | Writes a document from a request and source material, renders PPTX, PDF, DOCX and XLSX, reads uploaded files, converts between formats, validates every file |
| HTTP API and storage | `server/studio.js`, `server/documents/store.js` | Streams progress, keeps files and research per account |
| Model calls | `server/llm.js` | One model caller for both: the caller's provider and budget, patient with rate limits |

| Who uses them | How |
|---|---|
| Chat and voice | `client/src/services/Studio.ts`: a message that plainly asks for research or a file goes straight to the service. Voice transcripts take the same path |
| The agent loop, Team specialists, marketplace agents | Four shared tools from `getStudioTools()`: `research`, `create_document`, `read_attached_files`, `convert_file`. No agent has its own search or export code |
| Workflows | Steps `research.run` and `document.create` call the same engine and Studio through the workflow runtime's `research` and `document` services |
| MCP hosts | Tools `hannah_research` and `hannah_create_document` call the API with the caller's credential |
| Your own code | The HTTP routes below |

The older `web_search` tool and "Search the web" workflow step are single lookups through the same Groq search function the research engine uses as one of its providers.

## Research

### Pipeline

1. **Plan.** For deep, academic and compare modes, a model call turns the question into sub-questions and keyword queries. Quick and latest modes search the question itself.
2. **Search.** Every query runs on every provider chosen for the mode, in parallel. A provider that spends the caller's model quota (Groq browser search) runs one search at a time.
3. **Deduplicate.** Addresses are compared without tracking parameters, fragment, `www.` and trailing slash. The same article syndicated on another domain is kept once. At most two pages per site are opened.
4. **Open and read.** `robots.txt` is fetched per site and obeyed. Pages go through the SSRF-safe client. HTML is reduced to readable text; PDFs are read as PDFs. A page that can't be read is recorded with the reason and replaced by the next candidate.
5. **Follow up (deep mode).** A link from a strong source that bears on the question is followed. A sub-question nothing answered gets its own search.
6. **Evidence.** Each page is split into passages; BM25 picks the passages that bear on the question. Sentences addressed to an AI model are removed and the source is flagged.
7. **Score sources.** Relevance, kind of publisher, freshness (from the page's own publication date), and corroboration (how many other sites share its figures and distinctive terms). For questions about what is current, freshness weighs most.
8. **Answer.** The model sees only the numbered evidence passages, labelled as untrusted data, and is told to cite them.
9. **Check citations.** A citation to a source that doesn't exist is removed. A number or quotation that isn't in the cited passages is reported, and an unsupported quotation loses its quotation marks. "Verified" is granted only when two independent sites support a finding.

### Modes

| Mode | Searches | Pages | Notes |
|---|---|---|---|
| Quick search | 1 | 4 | A direct answer |
| Latest information | 2 | 5 | Recency filter; newest sources rank first |
| Deep research | up to 5 | 9 | Plan, follow-ups, a full report |
| Academic and technical | up to 3 | 9 | OpenAlex and arXiv; says original research, review or preprint |
| Compare and analyze | up to 6 | 9 | One query per subject at least; a comparison table |

### Search providers

Providers share one shape (`server/research/providers.js`), so adding one is one object.

| Provider | Kind | Needs |
|---|---|---|
| Tavily | Web | `TAVILY_API_KEY` |
| Brave Search | Web | `BRAVE_SEARCH_API_KEY` |
| SearXNG | Web | `SEARXNG_URL` (an instance you run) |
| Groq browser search | Web | The caller's Groq key |
| Wikipedia | Reference | Nothing |
| OpenAlex | Academic | Nothing |
| arXiv | Academic | Nothing |

One web provider is used per run: the first configured, in the order above. With only a Groq key, each web search is a model call and counts against that key's per-minute limit, so on a free Groq plan several searches in a row can be refused. The engine waits out a short limit once, falls back to Wikipedia when no web search could run, and lists every search that didn't run. A search API key removes this limit.

### What a result contains

`answer` (Markdown with `[n]` citations), `summary`, `findings` (each with its citations and whether it is verified, reported or analysis), `conflicts`, `gaps`, `recommendations`, `table`, `followUps`, `sources` (title, address, author, publisher, publication and access dates, kind, scores, the evidence passages), `failed` (pages that couldn't be read, with reasons), `searches`, `plan`, `methodology` (written from the run's own record), `quality` (citations kept and removed, unsupported figures, stale and flagged sources) and `stats`.

When nothing could be retrieved, the answer says so and is not written from the model's memory.

## Document Studio

### Two descriptions, four formats

A model never writes file bytes. It produces one of two descriptions, and code renders them.

- **Document model** (`server/documents/model.js`): title, sections, and blocks (paragraph, bullets, table, chart, comparison, diagram, callout, image, page break) plus references. Renders as PPTX, PDF or DOCX, so a deck and its PDF are the same content.
- **Workbook model** (`server/documents/xlsx.js`): sheets, typed columns, rows, formulas, totals, charts, conditional formatting, data validation.

| Format | Library | What the file has |
|---|---|---|
| PowerPoint | PptxGenJS 4.0.1 | Editable text, tables and native charts with their data; shape diagrams; speaker notes; title, agenda and reference slides; text measured against its box, continuing on a new slide instead of clipping |
| PDF | PDFKit 0.20.2 | Cover, contents with page numbers and links, header and "Page x of y" footer, tables that repeat their header, vector charts, live reference links; Noto Sans and Noto Sans Devanagari embedded |
| Word | docx 9.15.2 | Heading styles, a contents field, real lists and tables, header and page-number footer, live links |
| Excel | Written directly as SpreadsheetML | Formulas kept as formulas with their computed values, Excel tables with filters, frozen headers, conditional formatting, data validation, native charts |

### Writing pipeline

`composeDocument` in `server/documents/compose.js`: request and source material → outline → sections, a few per model call → document model → render → validate.

Rules enforced in code, not left to the prompt:

- A dataset from an uploaded file is copied into the workbook from the file. The model sees column names and five sample rows and chooses what to compute; it never retypes values.
- The model names columns (`[Revenue]`, `[Revenue@prev]`, `[Revenue@all]`); code turns those into cell references. Every formula is computed before the file is accepted. One that fails is left out and named in the reply.
- References are the research's own sources. A citation that points at none of them is removed.
- With no data in the source material, the writer is told not to produce figures, and any chart of numbers it returns anyway is dropped. The reply says no charts were made and why.
- A deck asked for by slide count has exactly that many slides.

### Validation

Every file is opened again by code that shares nothing with what wrote it (`server/documents/validate.js`). A file that fails is an error, not a download.

| Format | Checks |
|---|---|
| All Office files | Is a ZIP package; every relationship target exists; every XML part is well-formed |
| PDF | Header and trailer; page count; text is extractable; every section heading is present |
| Word | Heading styles used; tables are tables; text is text |
| PowerPoint | Slide count; charts are chart parts with embedded data; notes present; no slide over-full |
| Excel | Sheet count and names; the number of formulas in the file equals the number written; no formula ends in an error; charts are chart parts |

### Reading and converting files

`server/documents/read.js` reads PDF, DOCX, PPTX, XLSX, CSV, TSV, text, Markdown and JSON into text and tables, with a `coverage` record: how much was read, whether it was cut, and notes such as "3 of 12 pages have no text (scanned)". That record is passed to the model and shown on the attachment, so HANNAH doesn't claim to have read what it didn't. Images are described by a vision model and labelled as a description.

Conversion keeps the words, headings and tables and applies HANNAH's layout. It does not reproduce the original's design. The original file is never modified.

### Revisions and versions

A file is kept with the description it was built from. "Make it more professional" produces an edit plan (rewrite, add or remove sections; theme; title), and only those sections are rewritten. The result is a new version in the same family; earlier versions stay.

## HTTP API

All routes are under `/api` and accept the credentials chat accepts: a Groq key in `X-Groq-API-Key`, a developer key or session, or the operator token.

| Route | Body | Returns |
|---|---|---|
| `POST /research` | `{ question, mode?, previous? }` | Event stream, then `{ type: "result", result }` |
| `POST /documents/compose` | `{ request, formats?, context?, options?, base?, revises? }` | Event stream, then `{ type: "result", files, spec, notes, changed? }` |
| `POST /documents/create` | `{ format \| formats, spec }` | `{ files }`, from a ready description, no model call |
| `POST /documents/read` | `{ name, data }` (base64) | Text, tables and coverage |
| `POST /documents/convert` | `{ name, data, to }` | `{ files }` |
| `GET /account/documents` | | The account's files |
| `GET /account/documents/:id` | | Its record and description |
| `GET /account/documents/:id/download` | | The file |
| `PATCH /account/documents/:id` | `{ keep }` | Keep it, or let it expire |
| `DELETE /account/documents/:id` | | |
| `GET /account/research`, `GET` and `DELETE /account/research/:id` | | Research history |

`context` is `{ research?, files?, conversation? }`: a research result, extractions from `/documents/read`, and recent turns. Each file in a response has `name`, `format`, `mime`, `bytes`, `data` (base64), `summary`, `checks`, and `id` when it was kept in an account.

Stream events are steps that happened: `status`, `plan`, `search` (running, waiting, done, failed), `candidates`, `read` (running, done, failed with a reason), `follow`, `evidence`, `outline`, `note`. The stream ends with one `result` or `error` event.

## Privacy, permissions and security

- **Untrusted input.** Web pages and uploaded files are data. They reach a model only inside a block labelled as untrusted, and sentences that address the model are removed from web evidence first. Tools still need approval where they did before; nothing a page or file says can grant one.
- **What leaves the device.** A file you attach is sent to HANNAH's server to be read and is not stored there. Its text is then sent to your AI provider when you ask HANNAH to use it. A research question is sent to the search provider. Private files are not included in search queries.
- **Outbound requests.** Page fetches use the SSRF-safe client (no internal addresses, size and time limits) and obey `robots.txt`. Sign-in walls and paywalls are reported, not worked around. Making a document fetches nothing: images must be the person's own PNG or JPEG data.
- **Storage.** Files and research are per account; every query filters by user, and another account's id answers 404. Files expire after 30 days unless kept. An account holds up to 200 files and 250 MB; each file up to 12 MB. Deleting a file in the app deletes the account's copy. Visitors without an account get the file in the response and nothing is stored.
- **On the device.** Files are kept in IndexedDB and the last 30 research results in local storage, until deleted in Library.
- **Uploads.** 20 MB per file on the server (9 MB from the app); ZIP-based files that unpack beyond 150 MB are refused; old binary Office formats are refused with what to do.
- **Nothing is sent anywhere else.** HANNAH doesn't email, publish or upload a generated file. You download it.

## Limits to know

| Limit | Detail |
|---|---|
| Charts in Word | Shown as an editable bar table, not a native Word chart |
| Converted files | Content is kept; the original's layout is not reproduced |
| Scanned PDFs | No text layer means nothing to read; reported, no OCR |
| Scholarly sources | Represented by their abstracts, not full text |
| PDF text in Indic scripts | Drawn correctly; text copied out of the PDF comes in drawing order |
| Excel functions | Formulas using functions the checker doesn't implement (for example `XLOOKUP`) are kept and listed as not checked |
| Long jobs on serverless hosting | A deep research or a long deck is several model calls; a host with a short request limit can cut it off |
| Free Groq plans | Per-minute limits slow multi-step work; the progress display says when HANNAH is waiting |
| Visual verification | Generated files were opened with macOS Quick Look, Apple's Word importer and PDFKit here, not with Microsoft Office |
