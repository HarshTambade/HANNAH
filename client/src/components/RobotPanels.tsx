/**
 * Panels of the Robots screen beyond the live view: commissioning a physical
 * robot, its destinations, what its sensors detect, its condition, and the
 * fleet. Each one shows the server's record (services/Robotics.ts) and every
 * button is a real request; nothing here holds invented robot data.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, MapPin, Trash2, XCircle } from "lucide-react";
import { Robotics, type Commissioning, type Destinations, type Diagnostics, type FleetRow, type MaintenanceEntry, type Robot } from "../services/Robotics";
import type { ActionRecord } from "../services/Operator";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const fixed = (value: number | null | undefined, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "–");
const day = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "rose" | "amber" }) {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-700", rose: "border-rose-200 bg-rose-50 text-rose-800", amber: "border-amber-200 bg-amber-50 text-amber-900" };
  return <p role={tone === "rose" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

/** The seven checks a physical robot passes before it may move. */
export function CommissioningPanel({ robot, onChanged }: { robot: Robot; onChanged: () => void }) {
  const [view, setView] = useState<Commissioning | null>(null);
  const [note, setNote] = useState("");
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => { void Robotics.commissioning(robot.id).then(setView).catch((reason) => setError(message(reason))); }, [robot.id]);
  useEffect(() => { load(); const timer = window.setInterval(() => { if (!document.hidden) load(); }, 3000); return () => window.clearInterval(timer); }, [load]);
  if (robot.simulated || !view?.steps) return null;
  const confirm = async (step: string) => {
    setBusy(true); setError("");
    try { setView(await Robotics.confirmStep(robot.id, step, note)); setNote(""); setAttest(false); onChanged(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const status = { required: "Not started", "in-progress": "In progress", trial: `Trial: movement allowed at ${view.trialSpeed} m/s only`, approved: "Approved for operation", "not-required": "" }[view.status];
  return (
    <section className={`${card} space-y-3`} data-testid="commissioning" data-status={view.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900">Commissioning</h3>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${view.status === "approved" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{status} · {view.done} of {view.total}</span>
      </div>
      <p className="text-sm text-slate-700">A physical robot may not be moved until a person has taken it through these checks, in order. Where HANNAH can see something for itself it checks, and a tick alone doesn't pass. This is not a safety assessment: it records that the obvious things were looked at, by whom and when.</p>
      {view.resetReason && view.status !== "approved" && <Notice tone="amber">Commissioning was withdrawn: {view.resetReason}</Notice>}
      <ol className="space-y-2">
        {view.steps.map((step, index) => (
          <li key={step.id} className={`rounded-xl border p-3 text-sm ${step.available ? "border-sky-300 bg-sky-50" : "border-slate-200"}`} data-testid="commissioning-step" data-step={step.id} data-done={step.done}>
            <p className="flex items-center gap-2 font-medium text-slate-900">
              {step.done ? <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" /> : <Circle className="h-4 w-4 text-slate-400" aria-hidden="true" />}
              {index + 1}. {step.title}
              {step.done && step.confirmedAt && <span className="text-xs font-normal text-slate-600">confirmed {day(step.confirmedAt)}</span>}
            </p>
            {(step.available || step.done) && <p className="mt-1 text-slate-700">{step.detail}</p>}
            {(step.available || step.done) && step.check.facts.length > 0 && <ul className="mt-1 list-disc pl-5 text-slate-800">{step.check.facts.map((fact) => <li key={fact} className={step.id === "identity" ? "font-mono" : ""}>{fact}</li>)}</ul>}
            {step.done && step.note && <p className="mt-1 text-xs text-slate-600">Note: {step.note}</p>}
            {step.available && step.check.problems.map((problem) => <p key={problem} className="mt-1 flex items-start gap-1.5 text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{problem}</p>)}
            {step.available && (
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-slate-800"><input type="checkbox" className="mt-1" checked={attest} onChange={(event) => setAttest(event.target.checked)} />I checked this myself, at the robot.</label>
                <input className={`${input} w-full`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Note (optional): what you checked" aria-label="Note for this step" />
                <button type="button" className={primary} disabled={busy || !attest} onClick={() => void confirm(step.id)}>{step.id === "approval" ? "Approve for operation" : "Confirm this step"}</button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {error && <Notice tone="rose">{error}</Notice>}
      {view.done > 0 && <button type="button" className={button} disabled={busy} onClick={() => { const reason = window.prompt("Why is commissioning being withdrawn? The robot may not move until it is done again."); if (reason !== null) void Robotics.withdrawCommissioning(robot.id, reason).then((next) => { setView(next); onChanged(); }).catch((cause) => setError(message(cause))); }}>Withdraw commissioning</button>}
    </section>
  );
}

/** Named places the robot can be sent to. A name is a place only once it is on this list. */
export function DestinationsPanel({ robot, picked }: { robot: Robot; picked: { x: number; y: number } | null }) {
  const [data, setData] = useState<Destinations | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void Robotics.destinations(robot.id).then(setData).catch((reason) => setError(message(reason))); }, [robot.id]);
  useEffect(load, [load, robot.configVersion, robot.mapName]);
  if (robot.status !== "enrolled" || !data) return null;
  const run = async (work: () => Promise<Destinations>) => {
    setBusy(true); setError("");
    try { setData(await work()); setName(""); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const pending = data.reported.filter((place) => !place.usable);
  return (
    <section className={`${card} space-y-3`} data-testid="destinations">
      <h3 className="font-semibold text-slate-900">Destinations{data.map ? <span className="ml-2 text-xs font-normal text-slate-600">map: {data.map}</span> : null}</h3>
      <p className="text-sm text-slate-700">{data.rule} Each is checked against the robot's workspace and its map when it is added, and belongs to that map.</p>
      {data.destinations.length === 0 ? <p className="text-sm text-slate-600">None yet.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {data.destinations.map((item) => (
            <li key={`${item.name}-${item.id || "robot"}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5" data-testid="destination">
              <span><MapPin className="mr-1 inline h-3.5 w-3.5 text-sky-700" aria-hidden="true" /><span className="font-medium text-slate-900">{item.name}</span> <span className="text-slate-600">({fixed(item.x)}, {fixed(item.y)}) · {item.frame} · {item.source === "owner" ? "defined by you" : item.source === "robot-profile" ? "from the robot, approved by you" : "reported by the simulator"}</span></span>
              {item.id && <button type="button" className={button} disabled={busy} aria-label={`Remove ${item.name}`} onClick={() => void run(() => Robotics.removeDestination(robot.id, item.id as string))}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <div>
          <p className={heading}>Reported by the robot, not yet approved</p>
          <ul className="mt-1 space-y-1 text-sm">{pending.map((place) => <li key={place.name} className="flex flex-wrap items-center justify-between gap-2"><span>{place.name} <span className="text-slate-600">({fixed(place.x)}, {fixed(place.y)})</span></span><button type="button" className={button} disabled={busy} onClick={() => void run(() => Robotics.addDestination(robot.id, { fromPlace: place.name }))}>Approve as a destination</button></li>)}</ul>
        </div>
      )}
      {data.stale.length > 0 && <Notice tone="amber">Made for another map and not used now: {data.stale.map((item) => `${item.name} (${item.map})`).join(", ")}.</Notice>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (picked) void run(() => Robotics.addDestination(robot.id, { name: name.trim(), x: picked.x, y: picked.y })); }}>
        <label className="text-sm text-slate-700">New destination at the point picked on the map<input className={`${input} mt-1 block w-56`} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Name, for example Kitchen" /></label>
        <button type="submit" className={button} disabled={busy || !picked || !name.trim()}>{picked ? `Add at (${fixed(picked.x)}, ${fixed(picked.y)})` : "Pick a point on the map first"}</button>
      </form>
      {error && <Notice tone="rose">{error}</Notice>}
    </section>
  );
}

/** What the robot's sensors detect. Measurements with their source, never an interpretation. */
export function SurroundingsPanel({ robot }: { robot: Robot }) {
  const seen = robot.state?.perception;
  if (robot.status !== "enrolled" || !seen) return null;
  const unmapped = seen.obstacles.filter((item) => item.kind !== "mapped obstacle");
  return (
    <section className={`${card} space-y-2`} data-testid="surroundings">
      <h3 className="font-semibold text-slate-900">What it senses{!robot.online && <span className="ml-2 text-xs font-normal text-amber-800">last report, not current</span>}</h3>
      <p className="text-xs text-slate-600">From {seen.source}. Measurements, each with the sensor it came from; HANNAH doesn't say what an object is.</p>
      {!seen.obstaclesKnown ? <Notice tone="rose">The range sensor isn't reporting. What is around the robot is unknown, and it won't be moved.</Notice> : (
        <>
          <p className="text-sm text-slate-800" data-testid="route-state">Route: {seen.route.blocked === true ? <strong className="text-rose-800">blocked</strong> : "not blocked"}. {seen.route.reason}</p>
          {unmapped.length === 0 ? <p className="text-sm text-slate-700">Nothing detected that isn't on its map.</p> : (
            <ul className="space-y-1 text-sm">{unmapped.map((item, index) => <li key={index} data-testid="detected-object" className="rounded-lg bg-amber-50 px-2 py-1 text-amber-950">An object that isn't on the map, {fixed(item.distanceM)} m away at {fixed(item.bearingDeg, 0)}° (0° is straight ahead), about {fixed(item.widthM)} m wide. {item.returns} returns from the {item.sensor}; confidence {fixed(item.confidence)}.</li>)}</ul>
          )}
          <p className="text-xs text-slate-600">{seen.obstacles.length - unmapped.length} mapped obstacle{seen.obstacles.length - unmapped.length === 1 ? "" : "s"} in range. {seen.changes.length ? `${seen.changes.length} place${seen.changes.length === 1 ? "" : "s"} differ from the map.` : "The map matches what it sees."}</p>
        </>
      )}
      {seen.sensorHealth.some((sensor) => !sensor.ok) && <p className="text-sm text-rose-800">Not reporting: {seen.sensorHealth.filter((sensor) => !sensor.ok).map((sensor) => sensor.id).join(", ")}.</p>}
    </section>
  );
}

/** The robot's condition, from what it reported and what was recorded; and its maintenance log. */
export function DiagnosticsPanel({ robot }: { robot: Robot }) {
  const [report, setReport] = useState<Diagnostics | null>(null);
  const [log, setLog] = useState<MaintenanceEntry[]>([]);
  const [kind, setKind] = useState("inspection");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void Robotics.diagnostics(robot.id).then(setReport).catch(() => undefined);
    void Robotics.maintenance(robot.id).then(setLog).catch(() => undefined);
  }, [robot.id]);
  useEffect(() => { load(); const timer = window.setInterval(() => { if (!document.hidden) load(); }, 5000); return () => window.clearInterval(timer); }, [load]);
  if (robot.status !== "enrolled" || !report) return null;
  const tone = { error: "border-rose-200 bg-rose-50 text-rose-900", warning: "border-amber-200 bg-amber-50 text-amber-950", info: "border-slate-200 bg-slate-50 text-slate-800" };
  const Icon = { error: XCircle, warning: AlertTriangle, info: CheckCircle2 };
  return (
    <section className={`${card} space-y-3`} data-testid="diagnostics">
      <h3 className="font-semibold text-slate-900">Condition: <span className="font-normal">{report.summary}</span></h3>
      <p className="text-xs text-slate-600">{report.basis}</p>
      <ul className="space-y-1.5">
        {report.findings.map((finding) => { const Mark = Icon[finding.severity]; return (
          <li key={finding.title + finding.evidence} className={`rounded-xl border px-3 py-2 text-sm ${tone[finding.severity]}`} data-testid="finding" data-severity={finding.severity}>
            <p className="flex items-center gap-1.5 font-medium"><Mark className="h-4 w-4" aria-hidden="true" />{finding.title}</p>
            <p>{finding.evidence}</p>
            {finding.recommendation && <p className="mt-0.5 text-xs">{finding.recommendation}</p>}
          </li>
        ); })}
      </ul>
      <div>
        <p className={heading}>Maintenance log</p>
        {log.length === 0 ? <p className="mt-1 text-sm text-slate-600">No entries.</p> : <ul className="mt-1 space-y-1 text-sm text-slate-800">{log.slice(0, 6).map((entry) => <li key={entry.id}><span className="text-slate-500">{day(entry.at)} · {entry.kind} · </span>{entry.note}</li>)}</ul>}
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); setError(""); void Robotics.addMaintenance(robot.id, kind, note).then((entries) => { setLog(entries); setNote(""); load(); }).catch((reason) => setError(message(reason))); }}>
          <select className={input} value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Kind of entry">{["inspection", "repair", "replacement", "calibration", "note"].map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <input className={`${input} min-w-[14rem] flex-1`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="What was done or found" aria-label="Maintenance note" />
          <button type="submit" className={button} disabled={!note.trim()}>Add entry</button>
        </form>
        {error && <Notice tone="rose">{error}</Notice>}
      </div>
    </section>
  );
}

/** Every robot at a glance, and a way to hand a task to whichever one can best take it. */
export function FleetPanel({ onSelect, onAsked }: { onSelect: (robotId: string) => void; onAsked: (record: ActionRecord | null, error?: string) => void }) {
  const [rows, setRows] = useState<FleetRow[]>([]);
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => { void Robotics.fleet().then(setRows).catch(() => undefined); };
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 2500);
    return () => window.clearInterval(timer);
  }, []);
  if (rows.length < 2) return null;
  const places = [...new Set(rows.flatMap((row) => row.destinations))].sort();
  const assign = async (task: "navigate_to" | "return_to_dock", params: Record<string, unknown>) => {
    setBusy(true);
    try { const record = await Robotics.assign(task, params); onAsked(record); if (record.resource?.id) onSelect(record.resource.id); } catch (reason) { onAsked(null, message(reason)); } finally { setBusy(false); }
  };
  return (
    <section className={`${card} space-y-3`} data-testid="fleet">
      <h2 className="font-semibold text-slate-900">Fleet</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-600"><tr><th className="py-1 pr-3 font-medium">Robot</th><th className="py-1 pr-3 font-medium">Kind</th><th className="py-1 pr-3 font-medium">State</th><th className="py-1 pr-3 font-medium">Battery</th><th className="py-1 pr-3 font-medium">Mission</th><th className="py-1 font-medium">Can take a task</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-slate-100" data-testid="fleet-row" data-available={row.available}>
                <td className="py-1.5 pr-3"><button type="button" className="font-medium text-slate-900 underline-offset-2 hover:underline" onClick={() => onSelect(row.id)}>{row.name}</button></td>
                <td className="py-1.5 pr-3 text-slate-700">{row.kind === "simulation" ? "Simulation" : "Physical"}</td>
                <td className="py-1.5 pr-3 text-slate-700">{row.connection === "online" ? row.mode : row.connection.replace(/-/g, " ")}</td>
                <td className="py-1.5 pr-3 text-slate-700">{row.batteryPercent === null ? "–" : `${Math.round(row.batteryPercent)}%${row.charging ? " ↯" : ""}`}</td>
                <td className="py-1.5 pr-3 text-slate-700">{row.mission ? `${row.mission.what} (${row.mission.status})` : "none"}</td>
                <td className="py-1.5 text-slate-700">{row.available ? <span className="text-emerald-800">Yes</span> : row.problems.length ? row.problems.join("; ") : row.mission ? "Busy" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-slate-700">Send whichever robot is best placed to
          <select className={`${input} mt-1 block w-48`} value={place} onChange={(event) => setPlace(event.target.value)} aria-label="Destination for the fleet"><option value="">a destination…</option>{places.map((item) => <option key={item} value={item}>{item}</option>)}</select>
        </label>
        <button type="button" className={primary} disabled={busy || !place} onClick={() => void assign("navigate_to", { place })} data-testid="fleet-assign">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Choose a robot and ask</button>
      </div>
      <p className="text-xs text-slate-600">HANNAH picks the nearest robot that is connected, ready, not busy and has that destination on its own map, and tells you why. You approve that robot, by name. Two robots aren't sent to the same spot. It does not manage traffic between robots sharing a corridor.</p>
    </section>
  );
}
