import { useState } from "react";
import { Activity } from "lucide-react";
import { runSetupCheck, type CheckStatus, type SetupReport } from "../services/SetupCheck";

const STATUS: Record<CheckStatus, { label: string; tone: string }> = {
  ok: { label: "OK", tone: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  warn: { label: "Check", tone: "bg-amber-50 text-amber-900 border-amber-200" },
  fail: { label: "Problem", tone: "bg-rose-50 text-rose-800 border-rose-200" },
  skip: { label: "Not used", tone: "bg-slate-100 text-slate-600 border-slate-200" },
};

/** Settings → Setup check: run every check and show each verdict with what to do. */
export default function SetupCheckPanel() {
  const [report, setReport] = useState<SetupReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      setReport(await runSetupCheck());
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void run()} disabled={running} className="btn-outline !py-1.5 text-xs disabled:opacity-40"><Activity size={13} /> {running ? "Checking…" : "Check my setup"}</button>
        {report && (
          <p className="text-xs text-slate-500" role="status">
            {report.counts.fail ? `${report.counts.fail} problem${report.counts.fail === 1 ? "" : "s"}` : "No problems"}{report.counts.warn ? `, ${report.counts.warn} to check` : ""} · {new Date(report.at).toLocaleTimeString()}
          </p>
        )}
      </div>
      {report && (
        <ul className="mt-3 space-y-1.5" aria-label="Setup check results">
          {report.results.map((result) => (
            <li key={result.id} className="rounded-xl border border-slate-100 bg-white px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${STATUS[result.status].tone}`}>{STATUS[result.status].label}</span>
                <span className="font-medium text-ink">{result.label}</span>
              </p>
              <p className="mt-1 text-slate-700">{result.detail}</p>
              {result.fix && <p className="mt-0.5 text-xs text-slate-500">{result.fix}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
