import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, Loader2, Play, WifiOff } from "lucide-react";
import { CodeRunner, attachedRunFiles, getRecordedRun, type CodeLanguage, type RunResult } from "../services/CodeRunner";
import { STUDIO_EVENT, getAttachments } from "../services/Studio";

const LABEL: Record<CodeLanguage, string> = { python: "Python", javascript: "JavaScript" };

/**
 * A code block in a reply. Python and JavaScript get a Run button: the code
 * runs in a sandbox in this browser (services/CodeRunner.ts) and the output
 * shows underneath. `runId` shows a run HANNAH already made with run_code.
 */
export default function CodeBlock({ code, language, tag, runId, caption }: { code: string; language: CodeLanguage | null; tag?: string; runId?: string; caption?: string }) {
  const [result, setResult] = useState<RunResult | null>(() => (runId ? getRecordedRun(runId)?.result ?? null : null));
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [attachmentNames, setAttachmentNames] = useState(() => getAttachments().map((item) => item.name));
  const [useFiles, setUseFiles] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const update = () => setAttachmentNames(getAttachments().map((item) => item.name));
    window.addEventListener(STUDIO_EVENT, update);
    return () => { mounted.current = false; window.removeEventListener(STUDIO_EVENT, update); };
  }, []);

  const run = async () => {
    if (!language || running) return;
    setRunning(true);
    setStatus(language === "python" ? "Starting Python…" : "Running…");
    try {
      const files = useFiles && attachmentNames.length ? await attachedRunFiles() : [];
      const next = await CodeRunner.run({ language, code, files, onStatus: (text) => { if (mounted.current) setStatus(text); } });
      if (mounted.current) setResult(next);
    } finally {
      if (mounted.current) { setRunning(false); setStatus(""); }
    }
  };

  const label = language ? LABEL[language] : tag;
  return (
    <div className="overflow-hidden rounded-xl bg-slate-900 text-slate-100" data-testid="code-block">
      {(label || language || caption) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[11px] text-slate-400">
          <span className="font-medium">{caption ? `${caption}${label ? ` · ${label}` : ""}` : label}</span>
          {language && (
            <div className="ml-auto flex items-center gap-2">
              {attachmentNames.length > 0 && (
                <label className="flex cursor-pointer items-center gap-1" title={attachmentNames.join(", ")}>
                  <input type="checkbox" className="h-3 w-3 accent-brand-500" checked={useFiles} onChange={(event) => setUseFiles(event.target.checked)} />
                  Use attached files
                </label>
              )}
              <button
                type="button"
                onClick={() => void run()}
                disabled={running}
                aria-label={`Run this ${LABEL[language]} code`}
                className="inline-flex items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 font-semibold text-slate-100 hover:bg-white/20 disabled:opacity-60"
              >
                {running ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Play className="h-3 w-3" aria-hidden="true" />}
                {result ? "Run again" : "Run"}
              </button>
            </div>
          )}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed"><code>{code}</code></pre>
      {running && status && <p role="status" className="border-t border-white/10 px-3 py-1.5 text-[11px] text-slate-400">{status}</p>}
      {result && !running && <RunOutput result={result} />}
    </div>
  );
}

export function RunOutput({ result }: { result: RunResult }) {
  const empty = !result.stdout && !result.stderr && result.result === undefined && !result.error && !result.images.length && !result.table;
  const Icon = result.status === "timeout" ? Clock : result.status === "unavailable" ? WifiOff : AlertTriangle;
  return (
    <div className="space-y-2 border-t border-white/10 bg-slate-950/60 px-3 py-2.5 text-[12px]" data-testid="code-output" aria-live="polite">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">
        Output · {result.status === "ok" ? "ran" : result.status === "error" ? "error" : result.status === "timeout" ? "stopped" : "couldn't run"} in this browser{result.durationMs >= 1 ? ` · ${result.durationMs < 1000 ? `${Math.round(result.durationMs)} ms` : `${(result.durationMs / 1000).toFixed(1)} s`}` : ""}
        {result.files.length > 0 && ` · files: ${result.files.join(", ")}`}
      </p>
      {result.stdout && <pre className="whitespace-pre-wrap break-words font-mono text-slate-100">{result.stdout}</pre>}
      {result.stderr && <pre className="whitespace-pre-wrap break-words font-mono text-amber-300">{result.stderr}</pre>}
      {result.result !== undefined && <pre className="whitespace-pre-wrap break-words font-mono text-emerald-300">{result.result}</pre>}
      {result.table && (
        <div className="overflow-x-auto rounded-md border border-white/10">
          <table className="min-w-full text-left font-mono text-[11px]">
            <thead className="bg-white/5 text-slate-300"><tr>{result.table.columns.map((column, index) => <th key={index} className="px-2 py-1 font-semibold">{column}</th>)}</tr></thead>
            <tbody>{result.table.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-white/5">{row.map((cell, cellIndex) => <td key={cellIndex} className="whitespace-nowrap px-2 py-1 text-slate-200">{cell}</td>)}</tr>)}</tbody>
          </table>
          {result.table.truncated && <p className="px-2 py-1 text-[10px] text-slate-500">Only the first rows and columns are shown.</p>}
        </div>
      )}
      {result.images.map((image, index) => <img key={index} src={`data:image/png;base64,${image}`} alt={`Chart ${index + 1} made by the code`} className="max-w-full rounded-md bg-white" />)}
      {result.error && (
        <div className="flex gap-1.5 text-rose-300">
          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <pre className="whitespace-pre-wrap break-words font-mono">{result.error}</pre>
        </div>
      )}
      {empty && <p className="text-slate-500">No output. End with print() or an expression to see a value.</p>}
      {result.truncated && <p className="text-[10px] text-slate-500">Some output was cut to stay within the sandbox's limits.</p>}
    </div>
  );
}
