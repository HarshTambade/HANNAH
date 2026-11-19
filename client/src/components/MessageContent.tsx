import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe Markdown for chat replies. It builds React elements directly
 * (never innerHTML), so model output cannot inject markup or scripts.
 * Supports paragraphs, line breaks, headings, bullet/numbered lists, fenced
 * code, inline code, bold, italics, and https links. With `citations` (a
 * research answer's sources by number), each [n] becomes a link to that
 * source; a number with no source stays plain text.
 */
type Citations = Record<number, { url: string; title: string }>;

const inlinePattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\)|\[\d{1,3}\])/g;

function renderInline(text: string, keyPrefix: string, citations?: Citations): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  inlinePattern.lastIndex = 0;
  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    const cited = /^\[(\d{1,3})\]$/.exec(token);
    if (cited) {
      const source = citations?.[Number(cited[1])];
      nodes.push(source
        ? <a key={key} href={source.url} target="_blank" rel="noopener noreferrer" title={source.title} aria-label={`Source ${cited[1]}: ${source.title}`} className="mx-0.5 rounded bg-brand-50 px-1 py-0.5 align-baseline text-[0.8em] font-semibold text-brand-700 no-underline hover:bg-brand-100">{cited[1]}</a>
        : token);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key} className="rounded bg-slate-200/70 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key} className="font-semibold">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      nodes.push(<a key={key} href={match[2]} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 underline decoration-brand-300 underline-offset-2 hover:text-brand-800">{label}</a>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderLines(lines: string[], keyPrefix: string, citations?: Citations) {
  return lines.map((line, index) => (
    <Fragment key={`${keyPrefix}-${index}`}>
      {index > 0 && <br />}
      {renderInline(line, `${keyPrefix}-${index}`, citations)}
    </Fragment>
  ));
}

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; lines: string[] };

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: "heading", text: heading[1] }); index += 1; continue; }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && bullet.test(lines[index])) {
        items.push(lines[index].replace(bullet, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^\s*```/.test(lines[index]) && !bullet.test(lines[index]) && !/^\s{0,3}#{1,6}\s+/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

export default function MessageContent({ text, citations }: { text: string; citations?: Citations }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2 break-words [overflow-wrap:anywhere]">
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        if (block.kind === "code") {
          return <pre key={key} className="overflow-x-auto rounded-xl bg-slate-900 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-slate-100"><code>{block.text}</code></pre>;
        }
        if (block.kind === "heading") return <p key={key} className="font-semibold text-ink">{renderInline(block.text, key, citations)}</p>;
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className={`space-y-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-slate-400`}>
              {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`, citations)}</li>)}
            </ListTag>
          );
        }
        return <p key={key}>{renderLines(block.lines, key, citations)}</p>;
      })}
    </div>
  );
}
