/**
 * Sim-to-real deployment for one physical robot: the 14-step lifecycle, the
 * simulator run and its regression diff, the parity report (simulation vs
 * this robot) with its unverified assumptions, and the stages, each needing
 * a person's approval. Simulator results are labelled as simulation
 * everywhere; nothing here moves the robot.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, FlaskConical, Loader2, ShieldAlert } from "lucide-react";
import type { Robot } from "../../services/Robotics";
import { RobotOps, STAGE_TITLES, formatValue, lifecycleProgress, nextStage, toneOf, type Deployment, type DeploymentSummary } from "../../services/RobotOps";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";

export default function SimToRealPanel({ robot, robots = [] }: { robot: Robot; robots?: Robot[] }) {
  const [list, setList] = useState<DeploymentSummary[] | null>(null);
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [profiles, setProfiles] = useState<Array<{ name: string; scenarioRunner: boolean }>>([]);
  const [simulatorNote, setSimulatorNote] = useState("");
  const [form, setForm] = useState({ title: "", kind: "configuration", simProfile: "sim-diffdrive", maxLinearSpeed: "" });
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [expandTo, setExpandTo] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [found, sim] = await Promise.all([RobotOps.deployments(robot.id), RobotOps.simulator()]);
      setList(found);
      setProfiles(sim.profiles.filter((profile) => profile.scenarioRunner));
      setSimulatorNote(sim.available.ok ? sim.environment : sim.available.reason || "The simulator isn't available on this server.");
      const open = found.find((item) => item.status === "open") || found[0];
      setDeployment(open ? await RobotOps.deployment(open.id) : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load deployments.");
    }
  }, [robot.id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (label: string, run: () => Promise<Deployment | unknown>) => {
    setBusy(label);
    setError("");
    try {
      const result = await run();
      if (result && typeof result === "object" && "lifecycle" in result) setDeployment(result as Deployment);
      else if (deployment) setDeployment(await RobotOps.deployment(deployment.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That didn't work.");
    } finally {
      setBusy("");
    }
  };

  if (robot.simulated) return null;
  const progress = deployment ? lifecycleProgress(deployment.lifecycle.steps) : null;
  const run = deployment?.latestRun || null;
  const upcoming = deployment ? nextStage(deployment.stage) : null;
  const others = robots.filter((item) => item.id !== robot.id && !item.simulated && item.status === "enrolled");

  return (
    <section className={`${card} space-y-3`} data-testid="sim-to-real">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-slate-900"><FlaskConical className="h-4 w-4" /> Simulation to real</h3>
        {list && list.length > 1 && (
          <select className={input} value={deployment?.id || ""} onChange={(event) => void act("open", () => RobotOps.deployment(event.target.value))}>
            {list.map((item) => <option key={item.id} value={item.id}>{item.title} ({STAGE_TITLES[item.stage]}, {item.status})</option>)}
          </select>
        )}
      </div>
      <p className="text-xs text-slate-600">{simulatorNote} Passing in simulation never authorises anything on {robot.name}: each physical stage needs your approval, commissioning, and a parity check against this robot.</p>
      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{error}</p>}

      {!deployment && list && (
        <form className="grid gap-2 sm:grid-cols-4" onSubmit={(event) => { event.preventDefault(); void act("create", () => RobotOps.createDeployment({ robotId: robot.id, title: form.title, change: { kind: form.kind, simProfile: form.simProfile, overrides: form.maxLinearSpeed ? { limits: { maxLinearSpeed: Number(form.maxLinearSpeed) } } : {} } })); }}>
          <label className="text-xs text-slate-600 sm:col-span-2">What is changing<input className={`${input} mt-1 w-full`} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Lower corridor speed" /></label>
          <label className="text-xs text-slate-600">Kind<select className={`${input} mt-1 w-full`} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>{["configuration", "driver", "model", "software", "mission"].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label className="text-xs text-slate-600">Simulator profile<select className={`${input} mt-1 w-full`} value={form.simProfile} onChange={(event) => setForm({ ...form, simProfile: event.target.value })}>{profiles.map((profile) => <option key={profile.name}>{profile.name}</option>)}</select></label>
          <label className="text-xs text-slate-600">Top speed to try (m/s, optional)<input className={`${input} mt-1 w-full`} type="number" step="0.05" min="0.05" value={form.maxLinearSpeed} onChange={(event) => setForm({ ...form, maxLinearSpeed: event.target.value })} /></label>
          <div className="flex items-end"><button type="submit" className={primary} disabled={busy === "create"}>{busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Start in simulation</button></div>
        </form>
      )}

      {deployment && progress && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-slate-900">{deployment.title}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">Stage: {STAGE_TITLES[deployment.stage]}</span>
            <span className={`text-xs font-medium ${toneOf(deployment.status === "open" ? "pending" : deployment.status)}`}>{deployment.status}</span>
            <span className="text-xs text-slate-600">{progress.done} of {progress.total} steps · next: {progress.next}</span>
          </div>
          <ol className="grid gap-1 text-sm sm:grid-cols-2">
            {deployment.lifecycle.steps.map((step, index) => (
              <li key={step.id} className="flex gap-2">
                {step.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                <span><span className="font-medium text-slate-800">{index + 1}. {step.title}{step.person ? " (you)" : ""}</span><br /><span className="text-xs text-slate-600">{step.detail}</span></span>
              </li>
            ))}
          </ol>

          <div className="rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={heading}>Simulator run (simulation, not hardware)</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={Boolean(busy) || deployment.status !== "open"} onClick={() => void act("simulate", () => RobotOps.simulate(deployment.id))}>{busy === "simulate" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Run scenarios</button>
                {run && run.status === "passed" && !deployment.baseline && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("baseline", () => RobotOps.setBaseline(run.id))}>Use as baseline</button>}
                {run && deployment.inspected?.runId !== run.id && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("inspect", () => RobotOps.inspect(deployment.id, run.id))}>I inspected every result</button>}
              </div>
            </div>
            {run ? (
              <div className="mt-2 space-y-2 text-sm">
                <p className="text-slate-700">Run {run.id}: <span className={toneOf(run.status)}>{run.status}</span>{run.summary ? ` · ${run.summary.scenariosPassed} of ${run.summary.scenarios} scenarios · ${run.summary.trips} trips · ${run.summary.simulatedSeconds} s simulated` : ""}{run.error ? ` · ${run.error}` : ""}</p>
                {run.results?.filter((result) => !result.passed).map((result) => <p key={result.name} className="text-xs text-rose-800">{result.name}: {result.problems.join("; ")}</p>)}
                {deployment.lifecycle.diff.items.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[480px] text-left text-xs">
                      <thead className="text-slate-500"><tr><th className="py-1">Metric</th><th>Kind</th><th>Baseline</th><th>This run</th><th>Result</th></tr></thead>
                      <tbody>{deployment.lifecycle.diff.items.map((item) => <tr key={item.key} className="border-t border-slate-100"><td className="py-1 pr-2">{item.label}</td><td className="pr-2 text-slate-500">{item.kind}</td><td className="pr-2">{formatValue(item.before)}</td><td className="pr-2">{formatValue(item.now)}</td><td className={toneOf(item.status)}>{item.status}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
                {deployment.lifecycle.diff.warnings.map((warning) => <p key={warning} className="text-xs text-amber-800">{warning}</p>)}
              </div>
            ) : <p className="mt-2 text-sm text-slate-600">No run yet.</p>}
          </div>

          {deployment.parity && (
            <div className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={heading}>Parity: simulation vs {robot.name}</p>
                <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("parity", () => RobotOps.refreshParity(deployment.id))}>Compare again</button>
              </div>
              {deployment.parity.blocking.length > 0 && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900"><p className="flex items-center gap-1 font-medium"><ShieldAlert className="h-3.5 w-3.5" />Blocking</p>{deployment.parity.blocking.map((item) => <p key={item}>{item}</p>)}</div>}
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[480px] text-left text-xs">
                  <thead className="text-slate-500"><tr><th className="py-1">Area</th><th>Field</th><th>Simulation</th><th>Robot</th><th>Status</th></tr></thead>
                  <tbody>{deployment.parity.items.filter((item) => item.status !== "unknown").map((item) => <tr key={`${item.area}:${item.field}`} className="border-t border-slate-100"><td className="py-1 pr-2 text-slate-500">{item.area}</td><td className="pr-2">{item.field}</td><td className="pr-2">{formatValue(item.sim)}</td><td className="pr-2">{formatValue(item.physical)}</td><td className={item.blocking ? "text-rose-700" : item.status === "same" ? "text-emerald-700" : "text-amber-700"}>{item.blocking ? "blocking" : item.status}</td></tr>)}</tbody>
                </table>
              </div>
              <p className={`${heading} mt-3`}>Unverified assumptions</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-700">{deployment.parity.assumptions.map((item) => <li key={item.id}>{item.text}</li>)}</ul>
              {deployment.acknowledged ? <p className="mt-1 text-xs text-emerald-700">Acknowledged by {deployment.acknowledged.by}.</p> : <button type="button" className={`${button} mt-2`} disabled={Boolean(busy)} onClick={() => void act("ack", () => RobotOps.acknowledge(deployment.id, deployment.parity!.assumptions.map((item) => item.id)))}>I read these; none was tested</button>}
            </div>
          )}

          {deployment.status === "open" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-sm">
              <p className={heading}>Physical stages (your approval each time)</p>
              {deployment.stage === "simulation" && (
                <button type="button" className={`${primary} mt-2`} disabled={Boolean(busy) || !deployment.lifecycle.readyForApproval} onClick={() => void act("approve", () => RobotOps.approve(deployment.id, "development"))}>Approve a supervised test on {robot.name}</button>
              )}
              {deployment.stage !== "simulation" && (
                <div className="mt-2 space-y-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-xs text-slate-600">What you saw on the robot<input className={`${input} mt-1 w-72`} value={note} onChange={(event) => setNote(event.target.value)} /></label>
                    <button type="button" className={button} disabled={Boolean(busy) || note.trim().length < 3} onClick={() => void act("observe", () => RobotOps.observe(deployment.id, "ok", note))}>Behaved as expected</button>
                    <button type="button" className={button} disabled={Boolean(busy) || note.trim().length < 3} onClick={() => void act("observe", () => RobotOps.observe(deployment.id, "problem", note))}>Problem</button>
                  </div>
                  {upcoming && others.length > 0 && (
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="text-xs text-slate-600">Robots for {STAGE_TITLES[upcoming]}<select multiple className={`${input} mt-1 w-56`} value={expandTo} onChange={(event) => setExpandTo([...event.target.selectedOptions].map((option) => option.value))}>{others.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                      <button type="button" className={primary} disabled={Boolean(busy) || !expandTo.length} onClick={() => void act("expand", () => RobotOps.approve(deployment.id, upcoming, expandTo))}>Approve {STAGE_TITLES[upcoming]}</button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-xs text-slate-600">Why roll back<input className={`${input} mt-1 w-72`} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                    <button type="button" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-900 disabled:opacity-50" disabled={Boolean(busy) || reason.trim().length < 3} onClick={() => void act("rollback", () => RobotOps.rollback(deployment.id, reason))}>Roll back</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {deployment.rollbacks.map((item) => <p key={item.at} className="text-xs text-slate-700">Rolled back by {item.by}: {item.reason}. {item.actions.map((action) => action.how === "manual" ? action.detail : `Robot OS rollback sent to ${action.robotId}.`).join(" ")}</p>)}
        </div>
      )}
    </section>
  );
}
