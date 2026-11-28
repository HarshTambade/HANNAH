/**
 * Predictive maintenance for one robot or device: what its reported
 * measurements show, labelled measured anomaly / suspected cause / confirmed
 * fault, with evidence, possible causes and what to inspect; people's
 * verdicts and the precision they give; tasks and the service history.
 *
 * Every number shown is one the device reported (or a statistic of them).
 * There is never a failure date. Nothing here changes the robot.
 */
import { useCallback, useEffect, useState } from "react";
import { RobotHealth, LABEL_TEXT, measuredText, precisionText, sortFindings, type MaintenanceFinding, type MaintenanceReport } from "../../services/RobotHealth";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const button = "rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-40";
const input = "rounded-lg border border-slate-300 px-2 py-1 text-sm";
const tone: Record<string, string> = { "confirmed-fault": "border-rose-200 bg-rose-50", "suspected-cause": "border-amber-200 bg-amber-50", "measured-anomaly": "border-slate-200 bg-slate-50" };
const day = (at: number | null | undefined) => (at ? new Date(at).toISOString().slice(0, 10) : "—");
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

function FindingCard({ finding, onChanged }: { finding: MaintenanceFinding; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const run = (work: () => Promise<unknown>) => { setError(""); void work().then(onChanged).catch((reason) => setError(message(reason))); };
  const unit = finding.measurements?.unit || "";
  return (
    <li className={`rounded-xl border px-3 py-2 text-sm ${tone[finding.label]}`} data-testid="maintenance-finding" data-label={finding.label}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700">{LABEL_TEXT[finding.label]}</span>
        <span className="text-[11px] uppercase text-slate-500">{finding.priority} priority</span>
        {finding.simulated && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">Simulation</span>}
        {finding.feedback && <span className="text-[11px] text-slate-500">Your verdict: {finding.feedback}</span>}
      </div>
      <p className="mt-1 font-medium text-slate-900">{finding.title}</p>
      {finding.description && <p className="text-slate-800">{finding.description}</p>}
      {finding.measurements?.baseline && <p className="mt-0.5 text-xs text-slate-600">Last 24 h average {measuredText(finding.measurements.recent?.mean, unit)} (peak {measuredText(finding.measurements.recentPeak, unit)}) against a usual {measuredText(finding.measurements.baseline.median, unit)} from {finding.measurements.baseline.n} earlier periods.</p>}
      <p className="text-xs text-slate-600">Confidence {Math.round(finding.confidence * 100)}%: {finding.confidenceMeans} First seen {day(finding.firstSeenAt)}, last {day(finding.lastSeenAt)}.</p>
      {finding.confirmation && <p className="text-xs text-slate-700">Confirmed by {finding.confirmation.by === "controller" ? `the controller (fault code ${finding.confirmation.code})` : `a person: ${finding.confirmation.note}`}.</p>}
      <button type="button" className="mt-1 text-xs text-slate-600 underline" onClick={() => setOpen(!open)}>{open ? "Less" : "Evidence, possible causes and what to inspect"}</button>
      {open && (
        <div className="mt-1 space-y-1 text-xs text-slate-700">
          <ul className="list-disc pl-4">{(finding.evidence || []).map((item) => <li key={item.statement}>{item.detector}: {item.statement}</li>)}</ul>
          <p className="font-medium">Possible causes ({finding.causesStatus})</p>
          <ul className="list-disc pl-4">{(finding.possibleCauses || []).map((item) => <li key={item}>{item}</li>)}</ul>
          <p className="font-medium">Inspect</p>
          <ul className="list-disc pl-4">{(finding.inspection || []).map((item) => <li key={item}>{item}</li>)}</ul>
          <p>{finding.failureDateNote}</p>
          {finding.simulationNote && <p>{finding.simulationNote}</p>}
        </div>
      )}
      {finding.status !== "resolved" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button type="button" className={button} onClick={() => run(() => RobotHealth.feedback(finding.id, "true-positive"))}>Real</button>
          <button type="button" className={button} onClick={() => run(() => RobotHealth.feedback(finding.id, "false-positive", note))}>False alarm</button>
          <button type="button" className={button} onClick={() => run(() => RobotHealth.createTask({ assetId: finding.assetId, findingId: finding.id, kind: "inspection", remind: true, dueAt: Date.now() + 7 * 86_400_000 }))}>Plan an inspection (reminder in 7 days)</button>
          {finding.label !== "confirmed-fault" && (
            <>
              <input className={`${input} min-w-[12rem] flex-1`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="What the inspection found" aria-label="Inspection note" />
              <button type="button" className={button} disabled={!note.trim()} onClick={() => run(() => RobotHealth.confirm(finding.id, note))}>Confirm fault</button>
            </>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-700" role="alert">{error}</p>}
    </li>
  );
}

export default function MaintenancePanel({ assetId }: { assetId: string }) {
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const load = useCallback(() => { void RobotHealth.maintenance(assetId).then((next) => { setReport(next); setError(""); }).catch((reason) => setError(message(reason))); }, [assetId]);
  useEffect(() => { load(); const timer = window.setInterval(() => { if (!document.hidden) load(); }, 60_000); return () => window.clearInterval(timer); }, [load]);
  if (!report) return error ? <section className={card}><p className="text-sm text-rose-700" role="alert">{error}</p></section> : null;
  const findings = sortFindings(report.findings);
  return (
    <section className={`${card} space-y-3`} data-testid="maintenance-panel">
      <div>
        <h3 className="font-semibold text-slate-900">Wear and maintenance</h3>
        <p className="text-sm text-slate-700">{report.summary}</p>
        <p className="text-xs text-slate-500">{report.basis}</p>
      </div>
      {findings.length > 0 && <ul className="space-y-1.5">{findings.map((finding) => <FindingCard key={finding.id} finding={finding} onChanged={load} />)}</ul>}
      <div>
        <p className={heading}>Detector precision</p>
        <p className="text-sm text-slate-800" data-testid="maintenance-precision">{precisionText(report.precision.overall)}{report.precision.awaitingVerdict ? `; ${report.precision.awaitingVerdict} finding${report.precision.awaitingVerdict === 1 ? "" : "s"} without a verdict` : ""}.</p>
      </div>
      <div>
        <p className={heading}>Measured</p>
        {report.coverage.length === 0 ? <p className="text-sm text-slate-600">Nothing measured yet. Motor, battery and controller readings appear here once the robot or its Robot OS reports them.</p> : (
          <ul className="mt-1 grid gap-x-4 text-xs text-slate-700 sm:grid-cols-2">{report.coverage.map((entry) => <li key={`${entry.component}.${entry.metric}`}>{entry.component} · {entry.metric}: {entry.buckets} periods{entry.baselineReady ? "" : " (baseline not ready)"}{entry.source === "simulation" ? " · simulated" : ""}{entry.sinceReason ? ` · since ${entry.sinceReason}` : ""}</li>)}</ul>
        )}
      </div>
      <div>
        <p className={heading}>Open tasks</p>
        {report.tasks.length === 0 ? <p className="text-sm text-slate-600">None.</p> : (
          <ul className="mt-1 space-y-1 text-sm">{report.tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center gap-2" data-testid="maintenance-task">
              <span className={task.overdue ? "text-rose-700" : "text-slate-800"}>{task.title} · due {day(task.dueAt)}{task.overdue ? " (overdue)" : ""}</span>
              <input className={`${input} w-48`} value={note[task.id] || ""} onChange={(event) => setNote({ ...note, [task.id]: event.target.value })} placeholder="What was done" aria-label="What was done" />
              <button type="button" className={button} onClick={() => { void RobotHealth.completeTask(task.id, note[task.id] || "").then(load).catch((reason) => setError(message(reason))); }}>Done</button>
            </li>
          ))}</ul>
        )}
      </div>
      <div>
        <p className={heading}>Service history</p>
        {report.history.length === 0 ? <p className="text-sm text-slate-600">No entries.</p> : <ul className="mt-1 space-y-0.5 text-sm text-slate-800">{report.history.slice(0, 8).map((entry) => <li key={entry.id}><span className="text-slate-500">{day(entry.at)} · {entry.kind}{entry.component ? ` · ${entry.component}` : ""} · </span>{entry.note}</li>)}</ul>}
      </div>
      {error && <p className="text-xs text-rose-700" role="alert">{error}</p>}
    </section>
  );
}
