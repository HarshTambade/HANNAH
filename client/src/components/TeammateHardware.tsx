/**
 * What a teammate with the robots or devices tool can see: the account's
 * registered robots, active missions, hubs and devices with their latest
 * readings and how old each is. Read-only: a robot or device action a
 * teammate suggests goes to the Action Engine only when a person sends it.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import workforce, { type Bot, type HardwareView } from "../services/Workforce";

const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50";
const ago = (at: number | null, now: number) => (at ? `${Math.max(0, Math.round((now - at) / 1000))} s ago` : "never");

export default function TeammateHardware({ bot }: { bot: Bot }) {
  const [view, setView] = useState<HardwareView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => { setView(await workforce.botHardware(bot.id)); }, [bot.id]);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : "That didn't work.")); }, [load]);
  if (error) return <p className="mt-3 text-sm text-rose-700" role="alert">{error}</p>;
  if (!view) return <p className="mt-3 text-sm text-slate-500">Loading…</p>;
  const snap = view.snapshot;
  if (!snap) return <p className="mt-3 text-sm text-slate-600">{view.note}</p>;
  if (!snap.available) return <p className="mt-3 text-sm text-slate-600">{snap.reason}</p>;
  return (
    <section className="mt-3 space-y-3 text-sm" aria-label={`What ${bot.name} sees of your hardware`} data-testid="teammate-hardware">
      <div className="flex items-center justify-between gap-2"><p className="text-slate-600">What {bot.name} sees, read just now. It can suggest an action; you send it for approval from the task.</p><button type="button" className={button} onClick={() => void load()}><RefreshCw size={13} /> Refresh</button></div>
      {snap.access.robots && (
        <div><span className={heading}>Robots</span>
          <ul className="mt-1 space-y-1">{snap.robots.map((robot) => <li key={robot.id}>{robot.name} <span className="text-xs text-slate-500">· {robot.simulated ? "simulation" : "physical"} · {robot.connection} · {robot.mode}{robot.battery !== null ? ` · battery ${robot.battery}%` : ""} · last seen {ago(robot.lastSeenAt, snap.readAt)}</span></li>)}
            {!snap.robots.length && <li className="text-slate-500">No robots registered. Add one under <a className="underline" href="/robotics">Robots</a>.</li>}</ul>
          {!!snap.missions.length && <ul className="mt-1 text-xs text-slate-600">{snap.missions.map((mission) => <li key={mission.id}>Mission “{mission.title || mission.capability}”: {mission.status}</li>)}</ul>}
        </div>
      )}
      {snap.access.devices && (
        <div><span className={heading}>Devices</span>
          <ul className="mt-1 space-y-1">{snap.devices.map((device) => (
            <li key={device.id}>{device.name}{device.location ? ` (${device.location})` : ""} <span className="text-xs text-slate-500">· {device.connection}{Object.entries(device.readings).map(([key, point]) => ` · ${key} ${String(point.value)}${point.unit ? ` ${point.unit}` : ""} (${point.ageS}s${point.live ? "" : ", not live"})`).join("")}</span></li>
          ))}{!snap.devices.length && <li className="text-slate-500">No devices registered. Add one under <a className="underline" href="/devices">Devices</a>.</li>}</ul>
        </div>
      )}
      {!!view.actions.length && <p className="text-xs text-slate-500">Actions it may suggest: {view.actions.map((action) => action.title).join(", ")}.</p>}
    </section>
  );
}
