/**
 * Every robot across adapters (HANNAH's link, VDA 5050), what each can do,
 * and normalized missions. A mission is checked first ("Check") and then
 * asked for through the Action Engine ("Send"): it waits for approval like
 * any other movement. Simulation and physical are always labelled, and a
 * report's age is always shown.
 */
import { useCallback, useEffect, useState } from "react";
import { MISSION_LABELS, RobotOps, connectionText, type CapabilityRow, type InteropRobot, type MissionType, type Verdict } from "../../services/RobotOps";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const MOTION: MissionType[] = ["navigate", "inspect", "deliver", "dock"];

/** The inputs a normalized mission takes, from a few simple fields. */
export function missionParams(type: MissionType, fields: { place: string; x: string; y: string; to: string }): Record<string, unknown> {
  const point = (text: string) => { const [x, y] = text.split(",").map((part) => Number(part.trim())); return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : text.trim() ? { place: text.trim() } : undefined; };
  if (type === "navigate") return fields.place.trim() ? { place: fields.place.trim() } : { x: Number(fields.x), y: Number(fields.y) };
  if (type === "inspect") return { waypoints: fields.place.split(";").map((item) => point(item)).filter(Boolean) };
  if (type === "deliver") return { from: point(fields.place), to: point(fields.to) };
  return {};
}

export default function InteropPanel() {
  const [robots, setRobots] = useState<InteropRobot[] | null>(null);
  const [matrix, setMatrix] = useState<CapabilityRow[]>([]);
  const [adapters, setAdapters] = useState<Array<{ id: string; label: string; protocol: { verifiedWith: string } }>>([]);
  const [robotId, setRobotId] = useState("");
  const [type, setType] = useState<MissionType>("navigate");
  const [fields, setFields] = useState({ place: "", x: "", y: "", to: "" });
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [fleet, capabilities] = await Promise.all([RobotOps.fleet(), RobotOps.capabilities()]);
      setRobots(fleet.robots); setAdapters(fleet.adapters); setMatrix(capabilities.robots);
      setRobotId((current) => current || fleet.robots[0]?.id || "");
    } catch (error) { setProblem(message(error)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const params = () => missionParams(type, fields);
  const check = async () => { setOutcome(null); setProblem(null); try { setVerdict((await RobotOps.assess(robotId, type, params())).verdict); } catch (error) { setProblem(message(error)); } };
  const send = async () => { setProblem(null); try { setOutcome((await RobotOps.send(robotId, type, params())).record.outcome); void refresh(); } catch (error) { setProblem(message(error)); } };
  const assist = async () => { setProblem(null); try { setOutcome((await RobotOps.assist(robotId, "Asked from the Interop panel")).record.outcome); void refresh(); } catch (error) { setProblem(message(error)); } };

  return (
    <section className={card} aria-labelledby="interop-heading" data-testid="interop-panel">
      <h2 id="interop-heading" className="text-base font-semibold text-slate-900">All robots, every adapter</h2>
      <p className="mt-1 text-sm text-slate-700">Robots on HANNAH's own link and vehicles that speak another protocol, in one list. {adapters.map((item) => `${item.label}: ${item.protocol.verifiedWith}`).join(" ")}</p>
      {problem && <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{problem}</p>}
      {robots && robots.length === 0 && <p className="mt-3 text-sm text-slate-600">No robots yet, on any adapter.</p>}
      {robots && robots.length > 0 && (
        <ul className="mt-3 grid gap-2 md:grid-cols-2" aria-label="Robots across adapters">
          {robots.map((robot) => (
            <li key={robot.id} className="rounded-xl border border-slate-200 p-3 text-sm" data-testid="interop-robot">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-900">{robot.name}</span>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${robot.kind === "simulation" ? "border-sky-200 bg-sky-50 text-sky-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>{robot.kind === "simulation" ? "SIMULATION" : "PHYSICAL"}</span>
                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-700">{robot.identity.protocol}{robot.identity.protocolVersion ? ` ${robot.identity.protocolVersion}` : ""}</span>
              </div>
              <p className="mt-1 text-xs text-slate-600">{connectionText(robot)} · mode {robot.mode.vendor || robot.mode.normalized}{robot.battery ? ` · battery ${Math.round(robot.battery.percent)}%` : ""}{robot.mission ? ` · mission ${robot.mission.status}` : ""}</p>
              {robot.diagnostics.errors.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-rose-800">
                  {robot.diagnostics.errors.slice(0, 4).map((item, index) => <li key={index}>{item.title}: {item.message}{item.vendor && typeof item.vendor.errorType === "string" ? ` (vendor: ${item.vendor.errorType})` : ""}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {matrix.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <h3 className={heading}>What each robot can do</h3>
          <table className="mt-1 w-full text-left text-xs">
            <thead><tr><th className="py-1 pr-2">Robot</th>{(Object.keys(MISSION_LABELS) as MissionType[]).map((item) => <th key={item} className="py-1 pr-2">{MISSION_LABELS[item]}</th>)}</tr></thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-medium">{row.name}</td>
                  {(Object.keys(MISSION_LABELS) as MissionType[]).map((item) => <td key={item} className="py-1 pr-2" title={row.missions[item]?.explanation}>{row.missions[item]?.supported ? "Yes" : "No"}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {robots && robots.length > 0 && (
        <div className="mt-4 grid gap-2 md:grid-cols-5">
          <label className="text-xs text-slate-700">Robot<select className={input} value={robotId} onChange={(event) => setRobotId(event.target.value)}>{robots.map((robot) => <option key={robot.id} value={robot.id}>{robot.name}</option>)}</select></label>
          <label className="text-xs text-slate-700">Mission<select className={input} value={type} onChange={(event) => { setType(event.target.value as MissionType); setVerdict(null); }}>{MOTION.map((item) => <option key={item} value={item}>{MISSION_LABELS[item]}</option>)}</select></label>
          <label className="text-xs text-slate-700">{type === "deliver" ? "From (place or x,y)" : type === "inspect" ? "Points (x,y; x,y)" : "Place"}<input className={input} value={fields.place} onChange={(event) => setFields({ ...fields, place: event.target.value })} /></label>
          {type === "deliver" ? <label className="text-xs text-slate-700">To (place or x,y)<input className={input} value={fields.to} onChange={(event) => setFields({ ...fields, to: event.target.value })} /></label>
            : type === "navigate" ? <label className="text-xs text-slate-700">or x, y<input className={input} value={`${fields.x}${fields.y ? `,${fields.y}` : ""}`} onChange={(event) => { const [x = "", y = ""] = event.target.value.split(","); setFields({ ...fields, x: x.trim(), y: y.trim() }); }} /></label> : <span />}
          <div className="flex items-end gap-2">
            <button type="button" className={button} onClick={() => void check()} disabled={!robotId}>Check</button>
            <button type="button" className={button} onClick={() => void send()} disabled={!robotId || !verdict?.ok}>Send</button>
          </div>
        </div>
      )}
      {verdict && (
        <div className="mt-2 text-sm" data-testid="interop-verdict">
          {verdict.ok ? <p className="text-emerald-800">It can do this now. Sending asks for approval as usual.</p> : <ul className="list-disc pl-5 text-rose-800">{verdict.violations.map((item, index) => <li key={index}>{item.message}</li>)}</ul>}
          {verdict.warnings.map((item, index) => <p key={index} className="text-amber-900">{item}</p>)}
        </div>
      )}
      {outcome && <p role="status" className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{outcome}</p>}
      {robots && robots.length > 0 && <button type="button" className={`${button} mt-3`} onClick={() => void assist()} disabled={!robotId}>Stop and ask for help</button>}
      <p className="mt-2 text-xs text-slate-500">“Stop and ask for help” is a software request to hold (VDA 5050: startPause). It is not an emergency stop.</p>
    </section>
  );
}
