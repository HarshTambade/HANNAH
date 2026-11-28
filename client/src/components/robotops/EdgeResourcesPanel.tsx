/**
 * A robot's computing resources as its onboard Edge Resource Manager measured
 * them, the warnings and recovery policies it reported, its workload classes,
 * a short history, and which model fits it now (server/edge).
 *
 * Every figure shows its source; one the robot can't measure says so. A
 * report from a simulated robot measured the computer running the simulation
 * and is labelled that way, never as robot hardware.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cpu, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { EdgeResources, metricNote, metricText, type EdgeMetric, type RobotResources } from "../../services/EdgeGraph";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";

function Reading({ label, metric, digits }: { label: string; metric: EdgeMetric | undefined; digits?: number }) {
  const measured = Boolean(metric?.available);
  return (
    <div className="rounded-xl bg-slate-50 p-2" data-testid={`edge-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className={heading}>{label}</p>
      <p className={measured ? "text-base font-semibold text-slate-900" : "text-sm text-slate-500"}>{metricText(metric, digits)}</p>
      <p className="truncate text-[11px] text-slate-500" title={metricNote(metric)}>{metricNote(metric)}</p>
    </div>
  );
}

const LEVEL: Record<string, string> = { normal: "Normal", reduced: "Reduced: smaller model", minimal: "Minimal: optional load shed" };
const STATUS_TONE: Record<string, string> = { ok: "bg-emerald-50 text-emerald-800 border-emerald-200", warning: "bg-amber-50 text-amber-900 border-amber-200", critical: "bg-rose-50 text-rose-800 border-rose-200", unknown: "bg-slate-100 text-slate-800 border-slate-200" };

export function EdgeResourcesPanel({ robotId, initial = null }: { robotId: string; initial?: RobotResources | null }) {
  const [data, setData] = useState<RobotResources | null>(initial);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await EdgeResources.get(robotId));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The resources couldn't be loaded.");
    } finally {
      setLoading(false);
    }
  }, [robotId]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const latest = data?.latest;
  const snap = latest?.snapshot;
  const gpu = snap?.gpu?.devices?.[0];
  const disk = snap?.storage?.[0];
  const advice = data?.advice;
  return (
    <section className={`${card} space-y-3`} aria-labelledby={`edge-${robotId}`} data-testid="edge-resources-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`edge-${robotId}`} className="flex items-center gap-2 font-semibold text-slate-900"><Cpu className="h-4 w-4" aria-hidden="true" />Computing resources</h3>
        <button type="button" className={button} onClick={() => void refresh()} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Refresh</button>
      </div>
      {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}
      {data && !latest && <p className="text-sm text-slate-600">{data.note}</p>}
      {latest && snap && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full border px-2 py-0.5 font-medium ${STATUS_TONE[latest.evaluation.status] || STATUS_TONE.unknown}`}>{latest.evaluation.status === "ok" ? "No warnings" : latest.evaluation.status}</span>
            <span className={`rounded-full border px-2 py-0.5 ${latest.simulatedHost ? "border-violet-200 bg-violet-50 text-violet-900" : "border-slate-200 bg-slate-50 text-slate-700"}`}>Measured on {latest.measuredOn}</span>
            <span className={latest.fresh ? "text-slate-600" : "font-medium text-amber-800"}>{latest.fresh ? `${latest.ageS} s ago` : `${latest.ageS} s old — last known, not current`}</span>
            <span className="text-slate-600">Policies: {latest.enforcement === "applied" ? "applied on the robot" : "recommended only (enforcement off)"}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Reading label="CPU use" metric={snap.cpu?.utilization_pct} />
            <Reading label="CPU temperature" metric={snap.cpu?.temperature_c} />
            <Reading label="Memory used" metric={snap.memory?.used_pct} />
            <Reading label="Memory free" metric={snap.memory?.available_mb} digits={0} />
            <Reading label="GPU use" metric={gpu?.utilization_pct ?? snap.gpu?.status} />
            <Reading label="GPU memory" metric={gpu?.memory_total_mb ?? snap.gpu?.status} digits={0} />
            <Reading label={`Storage used${disk ? ` (${disk.path})` : ""}`} metric={disk?.used_pct} />
            <Reading label="Network link" metric={snap.network?.link_up} />
            <Reading label="Battery" metric={snap.battery?.percent} />
            <Reading label="External power" metric={snap.power?.external_power} />
            <Reading label="Processes" metric={snap.processes?.count} digits={0} />
            <Reading label="Inference p50" metric={snap.inference?.latency_ms_p50} />
          </div>
          {latest.evaluation.warnings.length > 0 && (
            <div className="space-y-1">
              <p className={heading}>Warnings</p>
              <ul className="space-y-1 text-sm">
                {latest.evaluation.warnings.map((warning) => (
                  <li key={warning.metric} className={`flex items-start gap-2 rounded-lg px-2 py-1 ${warning.severity === "critical" ? "bg-rose-50 text-rose-900" : "bg-amber-50 text-amber-900"}`}>
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{warning.message} <span className="text-xs opacity-80">({warning.severity}, threshold {warning.threshold}, {warning.source})</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {latest.actions.filter((action) => action.policy !== "warn").length > 0 && (
            <div className="space-y-1">
              <p className={heading}>Recovery policies</p>
              <ul className="space-y-1 text-sm text-slate-800">
                {latest.actions.filter((action) => action.policy !== "warn").map((action) => (
                  <li key={action.policy} className="rounded-lg bg-slate-50 px-2 py-1">
                    <span className="font-medium">{action.policy.replace(/_/g, " ")}</span>
                    {action.targets.length > 0 && <span> — {action.targets.join(", ")}</span>}
                    {action.status && <span className="text-slate-600"> · {action.status}</span>}
                    {action.detail && <span className="block text-xs text-slate-600">{action.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {latest.evaluation.unmeasured.length > 0 && <p className="text-xs text-slate-600">Can't be checked on this robot (not measurable): {latest.evaluation.unmeasured.join(", ")}.</p>}
          {latest.workloads.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-slate-800">Workload classes</summary>
              <ul className="mt-1 space-y-1">
                {latest.workloads.map((workload) => (
                  <li key={workload.cls} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-2 py-1">
                    {workload.protected && <ShieldCheck className="h-4 w-4 text-emerald-700" aria-label="protected" />}
                    <span className="font-medium">{workload.description}</span>
                    <span className="text-xs text-slate-600">{workload.slice} · nice {workload.nice} · weight {workload.cpu_weight}{workload.cpu_quota_pct ? ` · quota ${workload.cpu_quota_pct}%` : " · no quota"}{workload.shed ? " · shed now" : ""}</span>
                    {workload.services.length > 0 && <span className="text-xs text-slate-500">{workload.services.join(", ")}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {data.history.length > 1 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-slate-800">History ({data.history.length} reports)</summary>
              <table className="mt-1 w-full text-left text-xs">
                <thead><tr className="text-slate-500"><th className="py-0.5">Measured</th><th>CPU</th><th>Temp</th><th>Memory</th><th>Storage</th><th>Battery</th><th>Status</th></tr></thead>
                <tbody>
                  {data.history.slice(0, 20).map((row) => (
                    <tr key={row.id} className="border-t border-slate-100">
                      <td className="py-0.5">{new Date(row.measuredAt).toLocaleTimeString()}</td>
                      {[row.cpuPct, row.cpuTempC, row.memoryPct, row.storagePct, row.batteryPct].map((value, index) => <td key={index}>{value === null ? "n/m" : Math.round(value)}</td>)}
                      <td>{row.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-500">n/m: not measurable on this device.</p>
            </details>
          )}
        </>
      )}
      {advice && advice.available && advice.degradation && (
        <div className="space-y-1" data-testid="edge-model-advice">
          <p className={heading}>Model on this robot · {LEVEL[advice.degradation.level]}</p>
          {advice.chosen ? <p className="text-sm text-slate-900"><span className="font-semibold">{advice.chosen.label}</span> <span className="text-slate-600">({advice.chosen.model}, {advice.chosen.placement})</span></p> : <p className="text-sm text-slate-700">No local model is recommended.</p>}
          <ul className="space-y-1 text-sm text-slate-700">
            {advice.degradation.decisions.map((decision) => <li key={decision.workload}><span className="font-medium">{decision.workload.replace(/_/g, " ")}</span>: {decision.action.replace(/-/g, " ")} — {decision.reason}</li>)}
          </ul>
          {advice.notes.map((note) => <p key={note} className="text-xs text-slate-600">{note}</p>)}
        </div>
      )}
    </section>
  );
}

export default EdgeResourcesPanel;
