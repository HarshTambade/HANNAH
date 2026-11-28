import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookmarkPlus, CheckCircle2, ChevronDown, Download, ExternalLink, FileSpreadsheet, FileText, FileType2, Loader2, Presentation, Search, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { FORMAT_LABELS, STUDIO_EVENT, deleteFile, downloadFile, getFile, getResearch, isMediaFile, type DocumentFormat, type ResearchResult, type StudioEvent, type StudioFile } from "../services/Studio";

const FORMAT_ICON: Record<DocumentFormat, typeof FileText> = { pptx: Presentation, pdf: FileType2, docx: FileText, xlsx: FileSpreadsheet };
const FORMAT_TONE: Record<DocumentFormat, string> = { pptx: "bg-orange-50 text-orange-700 border-orange-100", pdf: "bg-rose-50 text-rose-700 border-rose-100", docx: "bg-sky-50 text-sky-700 border-sky-100", xlsx: "bg-emerald-50 text-emerald-700 border-emerald-100" };
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

/** Each step the server reports, as it happens. Nothing here is drawn before it occurred. */
export function StudioProgress({ events }: { events: StudioEvent[] }) {
  const lines = useMemo(() => {
    const out: Array<{ key: string; state: "running" | "done" | "failed" | "info"; text: string }> = [];
    const at = new Map<string, number>();
    const put = (key: string, state: "running" | "done" | "failed" | "info", text: string) => {
      if (at.has(key)) out[at.get(key)!] = { key, state, text }; else { at.set(key, out.length); out.push({ key, state, text }); }
    };
    events.forEach((event, index) => {
      if (event.type === "status") { if (event.stage !== "done") put(`status-${event.stage}-${event.stage === "waiting" || event.stage === "writing" || event.stage === "rendering" ? index : ""}`, event.stage === "waiting" ? "info" : "running", event.message); }
      else if (event.type === "plan") { if (event.queries.length) put("plan", "done", `Plan: ${event.queries.length} search${event.queries.length === 1 ? "" : "es"}${event.subquestions.length ? `, ${event.subquestions.length} sub-questions` : ""}`); }
      else if (event.type === "search") put(`search-${event.provider}-${event.query}`, event.state === "done" ? "done" : event.state === "failed" ? "failed" : "running", event.state === "done" ? `Searched ${event.provider} for “${event.query}”: ${event.results} result${event.results === 1 ? "" : "s"}` : event.state === "failed" ? `${event.provider} search for “${event.query}” didn't run (${event.error})` : event.state === "waiting" ? `${event.provider} is busy; trying “${event.query}” again in ${event.seconds} s` : `Searching ${event.provider} for “${event.query}”`);
      else if (event.type === "candidates") put("candidates", "done", `${event.found} pages found; opening the ${event.opening} most relevant`);
      else if (event.type === "read") put(`read-${event.url}`, event.state === "done" ? "done" : event.state === "failed" ? "failed" : "running", event.state === "done" ? `Read ${host(event.url)}${event.basis === "abstract" ? " (abstract)" : ""}` : event.state === "failed" ? `Couldn't read ${host(event.url)}: ${event.reason}` : `Opening ${host(event.url)}`);
      else if (event.type === "follow") put(`follow-${event.url}`, "info", `Following a link to ${host(event.url)}`);
      else if (event.type === "evidence") put("evidence", "done", `${event.passages} passages from ${event.sources} source${event.sources === 1 ? "" : "s"} selected as evidence`);
      else if (event.type === "outline") put("outline", "done", `Outline: ${event.sections.length} sections for “${event.title}”`);
      else if (event.type === "note") put(`note-${index}`, "info", event.message);
    });
    // Anything still "running" when a later stage began has finished.
    const lastStatus = out.map((line) => line.key.startsWith("status-")).lastIndexOf(true);
    return out.map((line, index) => (line.state === "running" && line.key.startsWith("status-") && index < lastStatus ? { ...line, state: "done" as const } : line));
  }, [events]);
  if (!lines.length) return null;
  return (
    <ol aria-label="What HANNAH is doing" aria-live="polite" className="mx-2 space-y-1 rounded-xl border border-sky-100 bg-sky-50/60 px-3 py-2.5 text-xs text-slate-700 sm:mx-8">
      {lines.slice(-9).map((line) => (
        <li key={line.key} className="flex items-start gap-2">
          {line.state === "running" ? <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-sky-600" aria-hidden="true" /> : line.state === "done" ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" /> : line.state === "failed" ? <XCircle size={13} className="mt-0.5 shrink-0 text-rose-500" aria-hidden="true" /> : <Search size={13} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />}
          <span className="min-w-0 break-words">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Sources by number, for turning the answer's [n] into links. */
export function citationsOf(result: ResearchResult | null) {
  if (!result) return undefined;
  return Object.fromEntries(result.sources.map((source) => [source.n, { url: source.url, title: source.title }]));
}

const BASIS: Record<string, string> = { verified: "Independent sources agree", reported: "One source", analysis: "HANNAH's analysis" };

type ResearchCardProps = {
  researchId: string;
  onMakeDocument?: (format: DocumentFormat, result: ResearchResult) => void;
  onAsk?: (question: string) => void;
  onSave?: (result: ResearchResult) => void;
  busy?: boolean;
};

/** A research answer's sources, with what was read from each, what couldn't be read, and how the work was done. */
export function ResearchCard({ researchId, onMakeDocument, onAsk, onSave, busy = false }: ResearchCardProps) {
  const [result, setResult] = useState<ResearchResult | null>(() => getResearch(researchId));
  const [saved, setSaved] = useState(false);
  useEffect(() => { setResult(getResearch(researchId)); }, [researchId]);
  if (!result) return <p className="ml-9 text-xs text-slate-500">This research is no longer in this device's history.</p>;
  if (!result.sources.length) return null;
  const warnings = [
    ...(result.quality.unsupported.length ? [`Not found in the cited passages, so check at the source: ${result.quality.unsupported.slice(0, 6).map((item) => item.value).join(", ")}.`] : []),
    ...(result.quality.staleSources?.length ? [`${result.quality.staleSources.length === 1 ? "A cited source is" : "Some cited sources are"} more than two years old (${result.quality.staleSources.map((item) => `[${item.n}] ${item.published}`).join(", ")}).`] : []),
    ...(result.stats.searchesFailed ? [`${result.stats.searchesFailed} of ${result.stats.searches} searches didn't run.`] : []),
  ];
  return (
    <section aria-label={`Sources for: ${result.question}`} className="ml-9 mr-1 rounded-2xl border border-slate-200 bg-white text-sm">
      <details open={result.sources.length <= 4}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-xs font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
          <Search size={13} className="text-brand-600" aria-hidden="true" />
          <span>{result.sources.length} source{result.sources.length === 1 ? "" : "s"} · {result.modeLabel}</span>
          <span className="font-normal text-slate-500">{result.stats.read} pages read{result.failed.length ? `, ${result.failed.length} couldn't be` : ""} · {result.stats.seconds} s</span>
          <ChevronDown size={14} className="ml-auto text-slate-400" aria-hidden="true" />
        </summary>
        <ol className="divide-y divide-slate-100 border-t border-slate-100" aria-label="Sources">
          {result.sources.map((source) => (
            <li key={source.n} className="px-3.5 py-2.5">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded bg-brand-50 px-1 text-[11px] font-semibold text-brand-700" aria-hidden="true">{source.n}</span>
                <div className="min-w-0 flex-1">
                  <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-start gap-1 text-[13px] font-medium text-ink underline decoration-slate-300 underline-offset-2 hover:decoration-ink">
                    <span className="break-words">{source.title}</span><ExternalLink size={11} className="mt-1 shrink-0 text-slate-400" aria-hidden="true" />
                  </a>
                  <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
                    {source.domain}{source.author ? ` · ${source.author}` : ""} · {source.published ? `published ${source.published}` : "no publication date found"} · {source.scores.authorityReason}{source.basis === "abstract" ? " · abstract only" : ""}{source.scores.corroboratedBy ? ` · ${source.scores.corroboratedBy} other site${source.scores.corroboratedBy === 1 ? "" : "s"} agree` : ""}
                  </p>
                  {source.flagged && <p className="mt-1 flex items-start gap-1 text-[11px] leading-4 text-amber-800"><ShieldAlert size={12} className="mt-0.5 shrink-0" aria-hidden="true" />{source.flagged}</p>}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] font-medium text-slate-600">What HANNAH read here</summary>
                    {source.evidence.map((item, index) => <blockquote key={index} className="mt-1 border-l-2 border-slate-200 pl-2 text-[12px] leading-5 text-slate-600">{item.text}</blockquote>)}
                    <p className="mt-1 text-[11px] text-slate-400">Opened {source.accessed} · found by {source.foundBy.join(", ")}</p>
                  </details>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {(result.findings.length > 0 || result.conflicts.length > 0 || result.gaps.length > 0) && (
          <div className="space-y-2 border-t border-slate-100 px-3.5 py-2.5 text-[12px] leading-5 text-slate-700">
            {result.findings.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">Findings and what each rests on</summary>
                <ul className="mt-1 space-y-1">{result.findings.map((item, index) => <li key={index}><span className={`mr-1.5 rounded px-1 py-0.5 text-[10px] font-semibold ${item.basis === "verified" ? "bg-emerald-50 text-emerald-700" : item.basis === "reported" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{BASIS[item.basis]}</span>{item.claim} {item.citations.map((n) => `[${n}]`).join("")}</li>)}</ul>
              </details>
            )}
            {result.conflicts.map((conflict, index) => (
              <div key={index} className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-amber-900"><p className="font-semibold">Sources disagree: {conflict.topic}</p><ul className="list-disc pl-4">{conflict.positions.map((position, at) => <li key={at}>{position.claim} {position.citations.map((n) => `[${n}]`).join("")}</li>)}</ul></div>
            ))}
            {result.gaps.length > 0 && <p className="text-slate-600"><span className="font-semibold">Not covered by what was found:</span> {result.gaps.join("; ")}</p>}
          </div>
        )}
        {warnings.length > 0 && <div className="border-t border-slate-100 px-3.5 py-2 text-[12px] leading-5 text-amber-800">{warnings.map((warning) => <p key={warning} className="flex items-start gap-1.5"><AlertTriangle size={12} className="mt-1 shrink-0" aria-hidden="true" />{warning}</p>)}</div>}
        {result.failed.length > 0 && (
          <details className="border-t border-slate-100 px-3.5 py-2 text-[12px] text-slate-600">
            <summary className="cursor-pointer text-[11px] font-semibold">Pages that couldn't be read ({result.failed.length})</summary>
            <ul className="mt-1 space-y-0.5">{result.failed.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer" className="underline decoration-slate-300">{host(item.url)}</a>: {item.reason}</li>)}</ul>
          </details>
        )}
        <details className="border-t border-slate-100 px-3.5 py-2 text-[12px] text-slate-600">
          <summary className="cursor-pointer text-[11px] font-semibold">How this was researched</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{result.methodology.map((line) => <li key={line}>{line}</li>)}</ul>
        </details>
      </details>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3.5 py-2.5">
        {onMakeDocument && (["pptx", "pdf", "docx", "xlsx"] as const).map((format) => {
          const Icon = FORMAT_ICON[format];
          return <button key={format} type="button" disabled={busy} onClick={() => onMakeDocument(format, result)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition hover:border-brand-300 hover:text-ink disabled:opacity-50"><Icon size={12} aria-hidden="true" /> {FORMAT_LABELS[format]}</button>;
        })}
        {onSave && <button type="button" disabled={saved} onClick={() => { onSave(result); setSaved(true); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition hover:border-brand-300 disabled:text-emerald-700"><BookmarkPlus size={12} aria-hidden="true" /> {saved ? "Saved to memory" : "Save to memory"}</button>}
      </div>
      {onAsk && result.followUps.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-3.5 py-2.5" aria-label="Follow-up questions">
          {result.followUps.map((question) => <button key={question} type="button" disabled={busy} onClick={() => onAsk(question)} className="rounded-full border border-brand-100 bg-brand-50/60 px-2.5 py-1 text-left text-[11px] text-brand-700 transition hover:bg-brand-50 disabled:opacity-50">{question}</button>)}
        </div>
      )}
    </section>
  );
}

function facts(file: StudioFile) {
  const summary = file.summary || {};
  return [
    typeof summary.slides === "number" ? `${summary.slides} slides` : "", typeof summary.pages === "number" ? `${summary.pages} pages` : "",
    Array.isArray(summary.sheets) ? `${summary.sheets.length} sheet${summary.sheets.length === 1 ? "" : "s"}` : "", typeof summary.formulas === "number" && summary.formulas ? `${summary.formulas} formulas` : "",
    typeof summary.charts === "number" && summary.charts ? `${summary.charts} chart${summary.charts === 1 ? "" : "s"}` : "", typeof summary.tables === "number" && summary.tables ? `${summary.tables} table${summary.tables === 1 ? "" : "s"}` : "",
    typeof summary.references === "number" && summary.references ? `${summary.references} reference${summary.references === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
}

/** One generated file: what it is, what was checked, and the button that hands it over. */
export function FileCard({ fileId, onDeleted, compact = false }: { fileId: string; onDeleted?: () => void; compact?: boolean }) {
  const [file, setFile] = useState<StudioFile | null | undefined>(undefined);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    const load = () => void getFile(fileId).then((found) => { if (active) setFile(found?.file ?? null); });
    load();
    window.addEventListener(STUDIO_EVENT, load);
    return () => { active = false; window.removeEventListener(STUDIO_EVENT, load); };
  }, [fileId]);
  if (file === undefined) return null;
  if (file === null) return <p className={`${compact ? "" : "ml-9"} text-xs text-slate-500`}>This file is no longer on this device.</p>;
  if (isMediaFile(file)) return <MediaCard file={file} onDeleted={onDeleted} compact={compact} />;
  const format = file.format as DocumentFormat;
  const Icon = FORMAT_ICON[format];
  const passed = file.checks.filter((check) => check.ok).length;
  return (
    <article aria-label={file.name} className={`${compact ? "" : "ml-9 mr-1"} rounded-2xl border border-slate-200 bg-white p-3`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${FORMAT_TONE[format]}`} aria-hidden="true"><Icon size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-ink" title={file.name}>{file.name}</p>
          <p className="text-[11px] text-slate-500">{FORMAT_LABELS[format]} · {size(file.bytes)}{facts(file).length ? ` · ${facts(file).join(" · ")}` : ""}{file.version && file.version > 1 ? ` · version ${file.version}` : ""}</p>
        </div>
        <button type="button" onClick={() => void downloadFile(file.id).then(setStatus).catch((error: Error) => setStatus(error.message))} className="btn-primary inline-flex shrink-0 items-center gap-1.5 !px-3 !py-2 text-xs"><Download size={13} aria-hidden="true" /> Download</button>
        {onDeleted && <button type="button" aria-label={`Delete ${file.name}`} onClick={() => void deleteFile(file.id).then(onDeleted)} className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>}
      </div>
      <details className="mt-2 text-[11px] text-slate-600">
        <summary className="cursor-pointer"><CheckCircle2 size={11} className="mr-1 inline text-emerald-600" aria-hidden="true" />Opened again and checked: {passed} of {file.checks.length} checks passed</summary>
        <ul className="mt-1 space-y-0.5 pl-4">{file.checks.map((check) => <li key={check.name}>{check.ok ? "✓" : "✗"} {check.name}: {check.detail}</li>)}</ul>
      </details>
      {status && <p role="status" className="mt-1.5 text-[11px] text-emerald-700">{status}</p>}
      {!compact && <p className="mt-1.5 text-[11px] text-slate-400">Kept on this device{file.serverId ? " and in your account for 30 days (Library → Files to keep it longer or delete it)" : ""}.</p>}
    </article>
  );
}

/** A picture or clip HANNAH generated, shown inline, with its download. */
export function MediaCard({ file, onDeleted, compact = false }: { file: StudioFile; onDeleted?: () => void; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let made = "";
    let active = true;
    void getFile(file.id).then((found) => {
      if (!active || !found) return;
      made = URL.createObjectURL(new Blob([found.data as BlobPart], { type: file.mime }));
      setUrl(made);
    });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [file.id, file.mime]);
  const summary = file.summary || {};
  const made = [typeof summary.provider === "string" ? summary.provider : "", typeof summary.model === "string" ? summary.model : ""].filter(Boolean).join(" · ");
  const prompt = typeof summary.prompt === "string" ? summary.prompt : file.request;
  return (
    <figure aria-label={file.name} className={`${compact ? "" : "ml-9 mr-1"} max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white`}>
      {url
        ? file.format === "video"
          ? <video src={url} controls playsInline loop className="block max-h-[420px] w-full bg-black" aria-label={prompt} />
          : <img src={url} alt={prompt} className="block max-h-[480px] w-full bg-slate-50 object-contain" />
        : <div className="flex h-40 items-center justify-center bg-slate-50 text-slate-400"><Loader2 size={18} className="animate-spin" aria-hidden="true" /></div>}
      <figcaption className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] text-ink" title={prompt}>{prompt}</p>
          <p className="text-[11px] text-slate-500">{file.format === "video" ? `Video${typeof summary.seconds === "number" ? ` · ${summary.seconds}s` : ""}` : "Image"} · {size(file.bytes)}{made ? ` · ${made}` : ""}</p>
        </div>
        <button type="button" onClick={() => void downloadFile(file.id).then(setStatus).catch((error: Error) => setStatus(error.message))} className="btn-primary inline-flex shrink-0 items-center gap-1.5 !px-3 !py-2 text-xs"><Download size={13} aria-hidden="true" /> Download</button>
        {onDeleted && <button type="button" aria-label={`Delete ${file.name}`} onClick={() => void deleteFile(file.id).then(onDeleted)} className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>}
      </figcaption>
      {status && <p role="status" className="px-3 pb-2 text-[11px] text-emerald-700">{status}</p>}
      {!compact && <p className="px-3 pb-2 text-[11px] text-slate-400">AI-generated. Kept on this device (Library → Files).</p>}
    </figure>
  );
}
