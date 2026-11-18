// Study notes as a PDF: Markdown in, safe HTML out, and checks on the PDF
// that comes back. No Electron imports, so it can be tested with plain Node.
//
// The HTML is built from escaped text only (no raw HTML from the model passes
// through), and the PDF is printed with scripts and network off.

const escape = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  let out = escape(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  // Links are shown as text with the address, never made clickable to scripts.
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/** A small, safe Markdown subset: headings, paragraphs, lists, quotes, code blocks, rules and simple tables. */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let list = null;
  let paragraph = [];
  let code = null;
  let codeIndent = 0;
  let table = null;
  const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; } };
  const flushList = () => {
    if (!list) return;
    // A numbered list split by a code block carries on from its number.
    const start = list.tag === "ol" && list.start > 1 ? ` start="${list.start}"` : "";
    html.push(`<${list.tag}${start}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
    html.push(`<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    table = null;
  };
  const flushAll = () => { flushParagraph(); flushList(); flushTable(); };
  for (const line of lines) {
    if (code !== null) {
      if (/^\s*```/.test(line)) { html.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`); code = null; } else code.push(line.slice(Math.min(codeIndent, line.length - line.trimStart().length)));
      continue;
    }
    // A fence may be indented (inside a list item); its lines lose that indent.
    const fence = /^(\s*)```/.exec(line);
    if (fence) { flushAll(); code = []; codeIndent = fence[1].length; continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flushAll(); const level = Math.min(4, heading[1].length + 1); html.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushParagraph(); flushList(); (table ??= []).push(line.trim().slice(1, -1).split("|").map((cell) => cell.trim())); continue; }
    flushTable();
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      (list ??= { tag, items: [], start: numbered ? Number(/^\s*(\d+)/.exec(line)[1]) : 1 }).items.push((bullet || numbered)[1]);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushAll(); html.push("<hr>"); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flushAll(); html.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    flushList();
    paragraph.push(line.trim());
  }
  if (code !== null) html.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  flushAll();
  return html.join("\n");
}

/**
 * The full notes page. `transcriptBased` false puts a notice at the top that
 * the notes come from the title and description only.
 */
export function notesDocument({ title, creator, sourceUrl, topic, markdown, transcriptBased, generatedAt = new Date() }) {
  const date = generatedAt.toISOString().slice(0, 10);
  const source = sourceUrl ? `<a href="${escape(sourceUrl)}">${escape(sourceUrl)}</a>` : "Not given";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { font: 11pt/1.55 -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; color: #1f2430; margin: 0; }
  header { border-bottom: 2px solid #6d5bd0; padding-bottom: 10px; margin-bottom: 16px; }
  h1 { font-size: 20pt; margin: 0 0 6px; } h2 { font-size: 14pt; color: #4b3fb0; margin: 20px 0 6px; border-bottom: 1px solid #e3e0f5; padding-bottom: 3px; }
  h3 { font-size: 12pt; margin: 14px 0 4px; } h4, h5 { font-size: 11pt; margin: 10px 0 4px; }
  dl { display: grid; grid-template-columns: 7em 1fr; gap: 2px 10px; margin: 0; font-size: 9.5pt; color: #4a5060; } dt { font-weight: 600; } dd { margin: 0; word-break: break-all; }
  .notice { background: #fff6e0; border: 1px solid #f0c060; border-radius: 6px; padding: 8px 10px; font-size: 10pt; margin: 0 0 14px; }
  code { font-family: Menlo, Consolas, monospace; font-size: 9.5pt; background: #f3f2f8; padding: 0 3px; border-radius: 3px; }
  pre { background: #f3f2f8; padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 10pt; } th, td { border: 1px solid #d8d6e6; padding: 4px 6px; text-align: left; } th { background: #f3f2f8; }
  blockquote { border-left: 3px solid #6d5bd0; margin: 8px 0; padding: 2px 10px; color: #444; }
  li { margin: 2px 0; } a { color: #4b3fb0; } footer { margin-top: 24px; font-size: 8.5pt; color: #7a8090; }
</style></head><body>
<header><h1>${escape(title)}</h1><dl>
<dt>Creator</dt><dd>${escape(creator || "Not given")}</dd>
<dt>Source</dt><dd>${source}</dd>
${topic ? `<dt>Topic</dt><dd>${escape(topic)}</dd>` : ""}
<dt>Prepared</dt><dd>${date}, by HANNAH</dd>
</dl></header>
${transcriptBased ? "" : '<p class="notice"><strong>No transcript was available.</strong> These notes are based only on the video\'s title and description, not on what is said in it.</p>'}
${markdownToHtml(markdown)}
<footer>Generated by HANNAH from ${transcriptBased ? "the video's transcript as shown on YouTube" : "the title and description"}. Check important facts against the source.</footer>
</body></html>`;
}

/** Check bytes are a complete PDF and count its pages. */
export function inspectPdf(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const head = bytes.subarray(0, 5).toString("latin1");
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1");
  const body = bytes.toString("latin1");
  const pages = (body.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return { valid: head === "%PDF-" && tail.includes("%%EOF") && pages > 0, pages, bytes: bytes.length };
}

/** A safe file name ending in .pdf. */
export function pdfFileName(input) {
  const base = String(input || "notes").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "notes";
  return `${base}.pdf`;
}
