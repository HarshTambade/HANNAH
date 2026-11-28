/**
 * Self-diagnostics: each subsystem's checks with what they measured, open
 * incidents with their evidence, possible causes, lifecycle, the recovery
 * that fits and its policy, and what recoveries did.
 *
 * A check with nothing to measure reads "Not measured", never OK. A
 * prohibited recovery has no button: it says what a person does at the
 * hardware. Approval-required recoveries go to Actions for approval.
 */
import { useCallback, useEffect, useState } from "react";
import { RobotHealth, POLICY_TEXT, checkStatusText, recoveryChoice, type Diagnosis, type Incident } from "../../services/RobotHealth";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const button = "rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-40";
const statusTone: Record<string, string> = { ok: "text-emerald-700", degraded: "text-amber-700", failed: "text-rose-700", unknown: "text-slate-500", "not-configured": "text-slate-500", "nothing-to-check": "text-slate-500" };
const severityTone: Record<string, string> = { error: "border-rose-200 bg-rose-50", warning: "border-amber-200 bg-amber-50", info: "border-slate-200 bg-slate-50" };
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const SUBSYSTEMS: Array<[string, string]> = [["os", "Operating system"], ["runtime", "Robotics runtime"], ["hardware", "Hardware"], ["ai", "AI"]];
const detailText = (detail: unknown) => (typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("; ") : JSON.stringify(detail));

function IncidentCard({ incident, admin, onChanged }: { incident: Incident; admin: boolean; onChanged: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const choice = recoveryChoice(incident, admin);
  const suggestion = incident.suggestions[0];
  const act = async () => {
    if (!suggestion) return;
    setBusy(true);
    try {
      const { recovery } = await RobotHealth.recover(suggestion.action, suggestion.params, incident.id);
      onChanged(recovery.status === "waiting-approval" ? "Sent for approval: approve it in Actions. Nothing was done yet." : `Recovery ${recovery.status}${recovery.verification?.evidence ? `: ${recovery.verification.evidence}` : ""}`);
    } catch (reason) { onChanged(message(reason)); } finally { setBusy(false); }
  };
  return (
    <li className={`rounded-xl border px-3 py-2 text-sm ${severityTone[incident.severity] || severityTone.info}`} data-testid="diagnostics-incident" data-status={incident.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase text-slate-600">{incident.severity}</span>
        <span className="text-[11px] text-slate-500">{incident.subsystem} · {incident.status}{incident.server ? " · server" : ""}</span>
        {incident.simulated && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800">Simulation</span>}
      </div>
      <p className="mt-1 font-medium text-slate-900">{incident.title}</p>
      <ul className="text-xs text-slate-700">{incident.evidence.map((line) => <li key={line}>{line}</li>)}</ul>
      <p className="mt-1 text-xs text-slate-700">Possible causes ({incident.causesStatus}): {incident.causes.join("; ") || "none listed"}.</p>
      {suggestion && <p className="text-xs text-slate-700">Recovery: {suggestion.title} — {POLICY_TEXT[suggestion.policy] || suggestion.policy}.</p>}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {(choice.kind === "run" || choice.kind === "ask") && <button type="button" className={button} disabled={busy} onClick={() => void act()}>{choice.label}</button>}
        {(choice.kind === "manual" || choice.kind === "admin" || choice.kind === "none") && <span className="text-xs text-slate-700" data-testid="recovery-note">{choice.label}</span>}
        <button type="button" className="text-xs text-slate-600 underline" onClick={() => setOpen(!open)}>{open ? "Less" : "Lifecycle and recoveries"}</button>
      </div>
      {open && (
        <div className="mt-1 space-y-1 text-xs text-slate-700">
          <ol className="list-decimal pl-5">{incident.lifecycle.map((step) => <li key={step.step}><span className="font-medium">{step.step}</span> ({step.status}): {detailText(step.detail)}</li>)}</ol>
          {incident.recoveries.length > 0 && <ul className="list-disc pl-4">{incident.recoveries.map((item) => <li key={item.id}>{item.action} · {item.policy} · {item.status}{item.verification?.evidence ? `: ${item.verification.evidence}` : ""}{typeof item.result?.reason === "string" ? `: ${item.result.reason}` : ""}</li>)}</ul>}
        </div>
      )}
    </li>
  );
}

export default function DiagnosticsPanel() {
  const [result, setResult] = useState<Diagnosis | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { setResult(await RobotHealth.diagnose()); setError(""); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <section className={`${card} mb-4 space-y-3`} data-testid="diagnostics-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Self-diagnostics{result ? `: ${result.summary}` : ""}</h2>
          {result && <p className="text-xs text-slate-500">{result.basis} Checked {new Date(result.checkedAt).toLocaleString()}.</p>}
        </div>
        <button type="button" className={button} disabled={busy} onClick={() => void load()}>{busy ? "Checking…" : "Run checks"}</button>
      </div>
      {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}
      {note && <p className="text-sm text-slate-800" role="status">{note}</p>}
      {result && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {SUBSYSTEMS.map(([id, label]) => {
              const entry = result.subsystems[id];
              return (
                <div key={id} className="rounded-xl border border-slate-200 p-3" data-testid={`subsystem-${id}`}>
                  <p className={heading}>{label}: <span className={statusTone[entry?.status || "unknown"]}>{checkStatusText(entry?.status || "unknown")}</span></p>
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-700">{(entry?.checks || []).map((item) => <li key={`${item.id}:${item.target}`}><span className={statusTone[item.status]}>{checkStatusText(item.status)}</span> · {item.component}{item.simulated ? " (simulation)" : ""}: {item.evidence.join(" ") || "nothing reported"}</li>)}</ul>
                </div>
              );
            })}
          </div>
          <div>
            <p className={heading}>Open incidents</p>
            {result.incidents.filter((incident) => incident.status !== "resolved").length === 0 ? <p className="text-sm text-slate-600">None open.</p> : (
              <ul className="mt-1 space-y-1.5">{result.incidents.filter((incident) => incident.status !== "resolved").map((incident) => <IncidentCard key={incident.id} incident={incident} admin={Boolean(result.you?.admin)} onChanged={(text) => { setNote(text); void load(); }} />)}</ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
