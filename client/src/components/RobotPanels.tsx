/**
 * Panels of the Robots screen beyond the live view: commissioning a physical
 * robot, its destinations, what its sensors detect, its condition, and the
 * fleet. Each one shows the server's record (services/Robotics.ts) and every
 * button is a real request; nothing here holds invented robot data.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, MapPin, MinusCircle, Trash2, XCircle } from "lucide-react";
import { Robotics, type Analytics, type CameraSetting, type Commissioning, type RobotImage, type Destinations, type Diagnostics, type FleetRow, type MaintenanceEntry, type Plan, type PlanTemplate, type Robot } from "../services/Robotics";
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

/** A robot arm seen from above: where its joints say it is, what it holds, and the three things it can be asked to do. */
export function ArmPanel({ robot, busy, onAsk }: { robot: Robot; busy: boolean; onAsk: (action: "robots.move_robot_arm" | "robots.grasp_object" | "robots.release_object", params: Record<string, unknown>) => void }) {
  const [pose, setPose] = useState("");
  const [object, setObject] = useState("");
  const bounds = robot.world?.bounds;
  const state = robot.state;
  if (robot.status !== "enrolled" || !bounds || !state?.arm) return null;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const polygon = (points: number[][]) => points.map(([x, y]) => `${x},${-y}`).join(" ");
  const objects = state.scene?.objects || [];
  const holding = state.gripper?.holding || null;
  const can = (id: string) => robot.capabilities.includes(id) && !robot.disabled.includes(id);
  return (
    <section className={`${card} space-y-3`} data-testid="arm-panel">
      <h3 className="font-semibold text-slate-900">The arm{!robot.online && <span className="ml-2 text-xs font-normal text-amber-800">last report, not current</span>}</h3>
      <svg data-testid="arm-view" viewBox={`${bounds.minX - 0.05} ${-bounds.maxY - 0.05} ${width + 0.1} ${height + 0.1}`} className="w-full max-w-xl rounded-xl border border-slate-300 bg-slate-50" role="img"
        aria-label={`The arm seen from above. Its tool is at ${fixed(state.pose?.x, 3)}, ${fixed(state.pose?.y, 3)}. ${holding ? `It is holding the ${holding}.` : "Its gripper is empty."}`}>
        <rect x={bounds.minX} y={-bounds.maxY} width={width} height={height} fill="#ffffff" stroke="#0f172a" strokeWidth="0.01" />
        {robot.limits.keepOut.map((zone) => <polygon key={zone.name} points={polygon(zone.polygon)} fill="#fecdd3" stroke="#be123c" strokeWidth="0.006" strokeDasharray="0.03 0.02"><title>Keep-out zone: {zone.name}</title></polygon>)}
        {(robot.world?.obstacles || []).map((rect, index) => <rect key={index} x={rect.x} y={-(rect.y + rect.h)} width={rect.w} height={rect.h} fill="#94a3b8" stroke="#475569" strokeWidth="0.006"><title>A fixture the arm must not touch</title></rect>)}
        {Object.entries(robot.places).map(([name, place]) => <g key={name}><circle cx={place.x} cy={-place.y} r="0.012" fill="#0369a1" /><text x={place.x + 0.02} y={-place.y + 0.012} fontSize="0.04" fill="#0f172a">{name}</text></g>)}
        {objects.map((item) => <g key={item.id}><rect x={item.x - 0.02} y={-item.y - 0.02} width="0.04" height="0.04" fill={item.held ? "#7c3aed" : "#b45309"} /><text x={item.x + 0.03} y={-item.y - 0.025} fontSize="0.035" fill="#0f172a">{item.id}</text></g>)}
        <polyline points={polygon(state.arm.points)} fill="none" stroke={state.estop?.engaged ? "#e11d48" : "#0f172a"} strokeWidth="0.03" strokeLinecap="round" strokeLinejoin="round" opacity={robot.online ? 1 : 0.45} />
        {state.arm.points.map(([x, y], index) => <circle key={index} cx={x} cy={-y} r={index === state.arm!.points.length - 1 ? 0.018 : 0.014} fill={index === state.arm!.points.length - 1 ? "#2563eb" : "#ffffff"} stroke="#0f172a" strokeWidth="0.006" />)}
      </svg>
      <p className="text-sm text-slate-700" data-testid="arm-state">Tool at ({fixed(state.pose?.x, 3)}, {fixed(state.pose?.y, 3)}) m, from {state.pose?.source || "the robot"}. Gripper {state.gripper?.open ? "open" : "closed"}{holding ? `, holding the ${holding}` : ", holding nothing"}.</p>
      <p className="text-xs text-slate-600">Objects shown are {state.scene?.source || "what the robot reports"}. HANNAH grasps only what the robot itself reports at its tool, and the gripper's own feedback decides whether it has it.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-slate-700">Move the tool to
          <select className={`${input} mt-1 block w-44`} value={pose} onChange={(event) => setPose(event.target.value)} aria-label="Where to move the arm">
            <option value="">a pose or an object…</option>
            {Object.keys(robot.places).map((name) => <option key={name} value={`pose:${name}`}>{name}</option>)}
            {objects.map((item) => <option key={item.id} value={`object:${item.id}`}>over the {item.id}</option>)}
          </select>
        </label>
        <button type="button" className={primary} data-testid="arm-move" disabled={busy || !pose || !can("move_robot_arm")} onClick={() => { const [kind, name] = [pose.slice(0, pose.indexOf(":")), pose.slice(pose.indexOf(":") + 1)]; const item = objects.find((entry) => entry.id === name); onAsk("robots.move_robot_arm", kind === "pose" ? { place: name } : { x: item?.x, y: item?.y }); }}>Ask to move there</button>
        <label className="text-sm text-slate-700">Grasp
          <select className={`${input} mt-1 block w-36`} value={object} onChange={(event) => setObject(event.target.value)} aria-label="Object to grasp"><option value="">an object…</option>{objects.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>
        </label>
        <button type="button" className={button} data-testid="arm-grasp" disabled={busy || !object || Boolean(holding) || !can("grasp_object")} onClick={() => onAsk("robots.grasp_object", { object })}>Ask to grasp</button>
        <button type="button" className={button} data-testid="arm-release" disabled={busy || !holding || !can("release_object")} onClick={() => onAsk("robots.release_object", {})}>Ask to release</button>
      </div>
      <p className="text-xs text-slate-600">An arm is high risk: every step asks you, whatever your permission level. The arm's own planner chooses the joint motion; HANNAH sends a target, never joint values. This is HANNAH's built-in planar arm simulator when the badge says so: not MoveIt 2, not Gazebo.</p>
    </section>
  );
}

const PLAN_STATUS: Record<Plan["status"], { label: string; tone: string }> = {
  queued: { label: "Waiting", tone: "bg-slate-100 text-slate-800" }, running: { label: "Running", tone: "bg-sky-100 text-sky-900" }, succeeded: { label: "Finished, verified", tone: "bg-emerald-100 text-emerald-900" },
  failed: { label: "Stopped at a step", tone: "bg-rose-100 text-rose-900" }, cancelled: { label: "Cancelled", tone: "bg-amber-100 text-amber-900" }, expired: { label: "Never started", tone: "bg-amber-100 text-amber-900" },
};
/** What an observation step recorded, in a line. Always the robot's own report. */
function recorded(output: Record<string, unknown> | null): string {
  if (!output) return "";
  const kind = output.kind === "physical" ? "physical robot" : "simulation";
  const at = typeof output.at === "number" ? new Date(output.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  return `Recorded ${at} from the robot's own report (${kind}).`;
}

/**
 * Plans: several steps on one robot under one approval. The launcher offers
 * only the templates this robot has the hardware for; the list shows each
 * plan with every step's real outcome.
 */
export function PlansPanel({ robot, busy, onAsk }: { robot: Robot; busy: boolean; onAsk: (plan: { template: string; inputs: Record<string, unknown> }) => void }) {
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [chosen, setChosen] = useState("");
  const [place, setPlace] = useState("");
  const [route, setRoute] = useState<string[]>([]);
  const [sensor, setSensor] = useState("");
  const [object, setObject] = useState("");
  const [cancelling, setCancelling] = useState("");
  const [error, setError] = useState("");
  const capabilities = robot.capabilities.join(",");
  useEffect(() => { void Robotics.templates(robot.id).then(setTemplates).catch(() => setTemplates([])); }, [robot.id, capabilities]);
  useEffect(() => {
    const load = () => { void Robotics.plans(robot.id, 6).then(setPlans).catch(() => undefined); };
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [robot.id]);
  if (robot.status !== "enrolled") return null;
  const template = templates.find((item) => item.id === chosen) || null;
  const places = Object.keys(robot.places || {});
  const objects = robot.state?.scene?.objects || [];
  const inputs: Record<string, unknown> | null = !template ? null
    : template.id === "go_and_return" ? (place ? { place } : null)
    : template.id === "inspection_route" ? (route.length ? { places: route, ...(sensor ? { sensor } : {}) } : null)
    : template.id === "pick_and_place" ? (object && place ? { object, to: place } : null)
    : {};
  const cancel = async (plan: Plan) => {
    setCancelling(plan.id); setError("");
    try { const answer = await Robotics.cancelPlan(plan.id); setPlans((current) => current.map((item) => (item.id === plan.id ? answer.plan : item))); } catch (reason) { setError(message(reason)); } finally { setCancelling(""); }
  };
  return (
    <section className={`${card} space-y-3`} data-testid="plans">
      <div>
        <h2 className="font-semibold text-slate-900">Plans</h2>
        <p className="text-sm text-slate-600">Several steps under one approval. You see every step before you approve; each is checked again when it is sent; the plan stops at the first step that doesn't finish, and nothing is retried.</p>
      </div>
      {!robot.simulated && <Notice tone="amber">This is a physical robot. Each of its movements is approved by itself, so a plan that moves it is refused. A status report, which sends it nothing, is allowed.</Notice>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-slate-700">Template
          <select className={`${input} mt-1 block w-56`} value={chosen} onChange={(event) => { setChosen(event.target.value); setPlace(""); setRoute([]); setObject(""); setSensor(""); }} aria-label="Plan template">
            <option value="">Choose…</option>
            {templates.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.title}{item.available ? "" : " (not available)"}</option>)}
          </select>
        </label>
        {template?.id === "pick_and_place" && (
          <label className="text-sm text-slate-700">Object
            <select className={`${input} mt-1 block w-40`} value={object} onChange={(event) => setObject(event.target.value)} aria-label="Object to pick"><option value="">Choose…</option>{objects.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>
          </label>
        )}
        {(template?.id === "go_and_return" || template?.id === "pick_and_place") && (
          <label className="text-sm text-slate-700">{template.id === "pick_and_place" ? "Put it at" : "Destination"}
            <select className={`${input} mt-1 block w-40`} value={place} onChange={(event) => setPlace(event.target.value)} aria-label={template.id === "pick_and_place" ? "Pose to place at" : "Plan destination"}><option value="">Choose…</option>{places.filter((name) => name !== "dock").map((name) => <option key={name} value={name}>{name}</option>)}</select>
          </label>
        )}
        {template?.id === "inspection_route" && (
          <>
            <fieldset className="text-sm text-slate-700"><legend>Visit, in the order you tick them</legend>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{places.filter((name) => name !== "dock").map((name) => (
                <label key={name} className="inline-flex items-center gap-1.5 text-slate-800"><input type="checkbox" checked={route.includes(name)} onChange={() => setRoute((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]))} />{name}{route.includes(name) ? ` (${route.indexOf(name) + 1})` : ""}</label>
              ))}</div>
            </fieldset>
            <label className="text-sm text-slate-700">Read a sensor at each
              <select className={`${input} mt-1 block w-40`} value={sensor} onChange={(event) => setSensor(event.target.value)} aria-label="Sensor to read at each place"><option value="">None</option>{robot.sensors.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>
            </label>
          </>
        )}
        <button type="button" className={primary} disabled={busy || !template || !inputs || !robot.online} onClick={() => template && inputs && onAsk({ template: template.id, inputs })} data-testid="plan-ask">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Check and ask</button>
      </div>
      {template && <p className="text-xs text-slate-600">{template.description}</p>}
      {templates.some((item) => !item.available) && <p className="text-xs text-slate-600">Not available on this robot: {templates.filter((item) => !item.available).map((item) => `${item.title} (${item.reason})`).join(" ")}</p>}
      {error && <Notice tone="rose">{error}</Notice>}
      {plans.length > 0 && (
        <ul className="space-y-2">
          {plans.map((plan) => (
            <li key={plan.id} className="rounded-xl border border-slate-200 p-3" data-testid="plan" data-status={plan.status}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-slate-900">{plan.title}</span><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PLAN_STATUS[plan.status].tone}`}>{PLAN_STATUS[plan.status].label}</span><span className="text-xs text-slate-600">{day(plan.createdAt)}</span></div>
                {!plan.final && <button type="button" className={button} disabled={cancelling === plan.id} onClick={() => void cancel(plan)} data-testid="plan-cancel">{cancelling === plan.id ? "Cancelling…" : "Cancel plan"}</button>}
              </div>
              <p className="mt-1 text-sm text-slate-700">{plan.summary}</p>
              <ol className="mt-2 space-y-1">
                {plan.steps.map((step) => (
                  <li key={step.n} className="flex items-start gap-2 text-sm" data-testid="plan-step" data-status={step.status}>
                    {step.status === "succeeded" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" /> : step.status === "failed" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" aria-hidden="true" /> : step.status === "running" ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-700" aria-hidden="true" /> : step.status === "pending" ? <Circle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" /> : <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />}
                    <span className="text-slate-800">
                      <span className="font-medium">{step.n}. {step.text}</span>
                      <span className="text-slate-600"> — {step.status === "skipped" ? "not run" : step.status}</span>
                      {step.evidence && <span className="block text-xs text-slate-600">{step.evidence} {step.kind === "observation" ? recorded(step.output) : ""}</span>}
                      {step.error && <span className="block text-xs text-rose-800">{step.error}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const share = (value: number | null) => (value === null ? "no data" : `${Math.round(value * 100)}%`);
const seconds = (value: number | null) => (value === null ? "no data" : value >= 90 ? `${(value / 60).toFixed(1)} min` : `${value.toFixed(0)} s`);

/** Fleet figures from stored records. A figure with no records behind it reads "no data". */
export function AnalyticsPanel() {
  const [days, setDays] = useState(7);
  const [figures, setFigures] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => { void Robotics.analytics(days).then((answer) => { if (live) { setFigures(answer); setError(""); } }).catch((reason) => { if (live) setError(message(reason)); }); };
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [days]);
  if (error) return <section className={card}><Notice tone="rose">{error}</Notice></section>;
  if (!figures || !figures.robots.length) return null;
  const problems = (list: Record<string, number>) => Object.entries(list).map(([type, count]) => `${count} ${type.replace(/-/g, " ")}`).join(", ") || "none recorded";
  return (
    <section className={`${card} space-y-3`} data-testid="analytics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">Figures</h2>
        <label className="text-sm text-slate-700">Period <select className={`${input} ml-1`} value={days} onChange={(event) => setDays(Number(event.target.value))} aria-label="Period for the figures"><option value={1}>Last day</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-600"><tr><th className="py-1 pr-3 font-medium">Robot</th><th className="py-1 pr-3 font-medium">Missions ended</th><th className="py-1 pr-3 font-medium">Verified as succeeded</th><th className="py-1 pr-3 font-medium">Typical duration</th><th className="py-1 pr-3 font-medium">Command latency</th><th className="py-1 pr-3 font-medium">Busy</th><th className="py-1 font-medium">Problems recorded</th></tr></thead>
          <tbody>
            {figures.robots.map((row) => (
              <tr key={row.id} className="border-t border-slate-100" data-testid="analytics-row">
                <td className="py-1.5 pr-3 font-medium text-slate-900">{row.name} <span className="font-normal text-slate-600">({row.kind === "simulation" ? "simulation" : "physical"})</span></td>
                <td className="py-1.5 pr-3 text-slate-700">{row.missions.ended}{row.missions.open ? ` (+${row.missions.open} open)` : ""}</td>
                <td className="py-1.5 pr-3 text-slate-700">{row.missions.successRate === null ? "no data" : `${row.missions.succeededVerified} of ${row.missions.ended} (${share(row.missions.successRate)})`}</td>
                <td className="py-1.5 pr-3 text-slate-700">{seconds(row.durationS.median)}{row.durationS.samples ? ` (${row.durationS.samples})` : ""}</td>
                <td className="py-1.5 pr-3 text-slate-700">{row.commandLatencyMs.median === null ? "no data" : `${row.commandLatencyMs.median} ms (${row.commandLatencyMs.samples})`}</td>
                <td className="py-1.5 pr-3 text-slate-700">{share(row.utilization)}</td>
                <td className="py-1.5 text-slate-700">{problems(row.problems)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-600">{figures.notes.join(" ")} Numbers in brackets are how many records a figure came from.</p>
    </section>
  );
}

/**
 * A robot's camera: off until a person switches it on, one picture at a time
 * on request, kept for a limited time, and opening a picture is logged. The
 * boxes drawn on a picture are what the detector reported, nothing more.
 */
export function CameraPanel({ robot, busy, onAsk, onChanged }: { robot: Robot; busy: boolean; onAsk: () => void; onChanged: () => void }) {
  const [setting, setSetting] = useState<CameraSetting>(robot.camera);
  const [images, setImages] = useState<RobotImage[]>([]);
  const [open, setOpen] = useState<RobotImage | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => { void Robotics.images(robot.id).then((answer) => { setSetting(answer.camera); setImages(answer.images); }).catch(() => undefined); }, [robot.id]);
  useEffect(() => { load(); const timer = window.setInterval(() => { if (!document.hidden) load(); }, 3000); return () => window.clearInterval(timer); }, [load]);
  if (robot.status !== "enrolled" || !robot.camera?.cameras?.length) return null;
  const change = async (camera: { enabled?: boolean; retentionHours?: number }) => {
    const before = setting;
    // Shown at once, and put back if the server refuses.
    setSaving(true); setError(""); setSetting({ ...setting, ...camera });
    try { setSetting((await Robotics.update(robot.id, { camera })).robot.camera); onChanged(); } catch (reason) { setSetting(before); setError(message(reason)); } finally { setSaving(false); }
  };
  const view = async (image: RobotImage) => {
    setError("");
    try { setOpen(await Robotics.image(robot.id, image.id)); } catch (reason) { setError(message(reason)); }
  };
  const remove = async (image: RobotImage) => {
    setError("");
    try { const answer = await Robotics.deleteImage(robot.id, image.id); setImages(answer.images); if (open?.id === image.id) setOpen(null); } catch (reason) { setError(message(reason)); }
  };
  const health = robot.state?.sensors?.camera;
  return (
    <section className={`${card} space-y-3`} data-testid="camera">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-slate-900">Camera <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">{robot.simulated ? "Simulated camera" : "Physical camera"}</span></h2>
          <p className="text-sm text-slate-600">Off until you switch it on. One picture at a time, when asked for. HANNAH reports regions of colour it detects; it does not identify objects or people.</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-900"><input type="checkbox" checked={setting.enabled} disabled={saving} onChange={(event) => void change({ enabled: event.target.checked })} aria-label="Allow camera use" />Allow camera use</label>
      </div>
      {health?.ok === false && <Notice tone="rose">The camera isn't reporting. No picture can be taken.</Notice>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm text-slate-700">Keep pictures for
          <select className={`${input} mt-1 block w-36`} value={setting.retentionHours} disabled={saving} onChange={(event) => void change({ retentionHours: Number(event.target.value) })} aria-label="How long pictures are kept">{[1, 2, 24, 72, 168, 720].map((hours) => <option key={hours} value={hours}>{hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${hours / 24} day${hours === 24 ? "" : "s"}`}</option>)}</select>
        </label>
        <button type="button" className={primary} disabled={busy || !setting.enabled || !robot.online || health?.ok === false} onClick={onAsk} data-testid="take-picture">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}Take a picture</button>
      </div>
      {!setting.enabled && <p className="text-sm text-slate-700">Camera use is off for this robot. HANNAH and its agents are refused a picture until you switch it on.</p>}
      {!robot.simulated && setting.enabled && <Notice tone="amber">Whoever is in front of this robot will be in its pictures. Make sure they know.</Notice>}
      {error && <Notice tone="rose">{error}</Notice>}
      {images.length > 0 && (
        <ul className="space-y-1">
          {images.map((image) => (
            <li key={image.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm" data-testid="picture">
              <span className="text-slate-800">{day(image.capturedAt)} · frame {image.frame ?? "?"} · {image.detections.length ? image.detections.map((item) => `${item.label}${typeof item.distanceM === "number" ? ` ${fixed(item.distanceM)} m` : ""} (${fixed(item.confidence)})`).join(", ") : "nothing detected"}<span className="block text-xs text-slate-600">{image.kind === "simulation" ? "Simulated camera" : "Physical camera"} · deleted {day(image.expiresAt)}</span></span>
              <span className="flex gap-2"><button type="button" className={button} onClick={() => void view(image)}>Open</button><button type="button" className={button} onClick={() => void remove(image)} aria-label={`Delete the picture from ${day(image.capturedAt)}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button></span>
            </li>
          ))}
        </ul>
      )}
      {open?.dataUrl && (
        <figure className="space-y-2" data-testid="picture-open">
          <div className="relative inline-block max-w-full overflow-hidden rounded-xl border border-slate-300 bg-slate-900" style={{ width: Math.min(480, open.width * 7.5) }}>
            <img src={open.dataUrl} alt={`Picture from ${robot.name}'s ${open.sensor}, frame ${open.frame ?? "unknown"}, ${open.kind === "simulation" ? "simulated" : "physical"} camera`} className="block w-full" style={{ imageRendering: "pixelated" }} />
            {open.detections.map((item, index) => (
              <span key={index} className="absolute border-2 border-white" style={{ left: `${(item.box.x / open.width) * 100}%`, top: `${(item.box.y / open.height) * 100}%`, width: `${(item.box.w / open.width) * 100}%`, height: `${(item.box.h / open.height) * 100}%` }} aria-hidden="true" />
            ))}
          </div>
          <figcaption className="text-xs text-slate-600">{open.source}. {open.detections.length} region{open.detections.length === 1 ? "" : "s"} detected by {open.detector?.model || "the detector"} ({open.detector?.kind || "detector"}). It cannot {open.detector?.cannot || "say what an object is"}. Opening this picture was logged.</figcaption>
          <button type="button" className={button} onClick={() => setOpen(null)}>Close</button>
        </figure>
      )}
      <p className="text-xs text-slate-600">Pictures are stored on the HANNAH server for this account only and deleted after the time above. Each opening of a picture is written to this robot's events with who opened it. The camera's own computer records every capture too.</p>
    </section>
  );
}
