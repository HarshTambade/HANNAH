/**
 * A robot's black box on the Robots screen: its event timeline, "why did it
 * stop?", mission replay, and what is recorded and kept.
 *
 * Every item is the server's record (services/BlackBox.ts). The incident report
 * keeps "confirmed (from records)" apart from "suspected", with the record ids
 * each line rests on; a model-written summary is only shown labelled as one.
 * A replay is always marked PLAYBACK. A simulated robot's records say so.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, FileJson, HelpCircle, Loader2, Pause, Play, Search, ShieldAlert, Trash2 } from "lucide-react";
import { BlackBox, type BlackBoxSettingsView, type IncidentReport, type Narrative, type Replay, type Segment, type Timeline, type TimelineEvent } from "../../services/BlackBox";
import { Robotics, type Mission, type Robot } from "../../services/Robotics";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const when = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ORIGIN: Record<string, string> = { "robot-blackbox": "robot black box", "robot-os": "Robot OS", "robot-sync": "robot report", server: "HANNAH" };
const SEVERITY: Record<string, string> = { critical: "text-rose-800", error: "text-rose-800", warning: "text-amber-900", info: "text-slate-800", debug: "text-slate-500" };
const SOURCES = ["", "safety", "motor", "sensor", "navigation", "link", "mission", "ai", "os", "server"];
const RANGES: Array<[string, number]> = [["Last hour", 3_600_000], ["Last 24 hours", 86_400_000], ["Last 7 days", 7 * 86_400_000], ["Last 30 days", 30 * 86_400_000]];
type Tab = "timeline" | "incident" | "replay" | "recording";

function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "rose" | "amber" | "sky" }) {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-700", rose: "border-rose-200 bg-rose-50 text-rose-800", amber: "border-amber-200 bg-amber-50 text-amber-900", sky: "border-sky-200 bg-sky-50 text-sky-950" };
  return <p role={tone === "rose" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

function ClockMark({ event }: { event: Pick<TimelineEvent, "clock" | "origin"> }) {
  if (event.origin === "server") return null;
  return event.clock.synced
    ? <span className="text-xs text-slate-500" title={event.clock.note}>±{event.clock.uncertaintyMs} ms</span>
    : <span className="inline-flex items-center gap-0.5 text-xs text-amber-800" title={event.clock.note}><Clock className="h-3 w-3" aria-hidden="true" />clock not synced</span>;
}

const Ids = ({ ids }: { ids: string[] }) => <span className="ml-1 font-mono text-[11px] text-slate-500">{ids.map((value) => `[${value}]`).join(" ")}</span>;

function download(name: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Timeline items, newest first, each with where it came from and how sure its time is. */
export function TimelineList({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="max-h-96 space-y-1 overflow-y-auto text-sm">
      {[...events].reverse().map((event) => (
        <li key={event.id} className="rounded-lg border border-slate-100 px-2 py-1" data-testid="blackbox-event" data-origin={event.origin}>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span>{when(event.at)}</span><span>{event.source}/{event.type}</span><span>· {ORIGIN[event.origin] || event.origin}</span><ClockMark event={event} />
            {event.sensitivity === "sensitive" && <span className="inline-flex items-center gap-0.5 text-violet-800"><ShieldAlert className="h-3 w-3" aria-hidden="true" />sensitive</span>}
            {event.missionId && <span className="font-mono">{event.missionId}</span>}
          </div>
          <p className={SEVERITY[event.severity] || "text-slate-800"}>{event.summary}</p>
        </li>
      ))}
    </ol>
  );
}

function TimelineTab({ robot }: { robot: Robot }) {
  const [range, setRange] = useState(RANGES[1][1]);
  const [source, setSource] = useState("");
  const [severity, setSeverity] = useState("");
  const [words, setWords] = useState("");
  const [view, setView] = useState<Timeline | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    void BlackBox.timeline(robot.id, { from: Date.now() - range, source, severity, q: words.trim(), limit: 300 }).then(setView).catch((reason) => setError(message(reason)));
  }, [robot.id, range, source, severity, words]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-2" data-testid="blackbox-timeline">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); load(); }}>
        <select className={input} value={range} onChange={(event) => setRange(Number(event.target.value))} aria-label="Time range">{RANGES.map(([label, ms]) => <option key={ms} value={ms}>{label}</option>)}</select>
        <select className={input} value={source} onChange={(event) => setSource(event.target.value)} aria-label="Source">{SOURCES.map((item) => <option key={item} value={item}>{item || "Every source"}</option>)}</select>
        <select className={input} value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Lowest severity">{["", "warning", "error"].map((item) => <option key={item} value={item}>{item ? `${item} and above` : "Every severity"}</option>)}</select>
        <input className={`${input} min-w-[10rem] flex-1`} value={words} onChange={(event) => setWords(event.target.value)} placeholder="Words in the event" aria-label="Search the timeline" maxLength={80} />
        <button type="submit" className={button}><Search className="h-4 w-4" aria-hidden="true" />Search</button>
      </form>
      {error && <Notice tone="rose">{error}</Notice>}
      {view && view.clock.unsynchronised > 0 && <Notice tone="amber">{view.clock.note}</Notice>}
      {view && (view.events.length === 0 ? <p className="text-sm text-slate-600">Nothing recorded for this robot in this time{source || severity || words ? " with these filters" : ""}.</p> : <TimelineList events={view.events} />)}
      {view?.truncated && <p className="text-xs text-slate-500">Only the latest 300 items are shown; narrow the time or the filters.</p>}
    </div>
  );
}

/** The report itself: what the records confirm, apart from what is only suspected, each line with its record ids. */
export function IncidentReportView({ report, simulated }: { report: IncidentReport; simulated: boolean }) {
  if (!report.found) return <Notice>{report.reason}</Notice>;
  return (
    <>
          <Notice tone={simulated ? "sky" : "slate"}>{report.label} {report.method}</Notice>
          <div>
            <p className={heading}>Confirmed (from records)</p>
            <ul className="mt-1 space-y-1 text-sm text-slate-900" data-testid="incident-confirmed">{(report.confirmed || []).map((line) => <li key={line.id} className="flex items-start gap-1.5"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" /><span>{line.text}<Ids ids={line.evidence} /></span></li>)}</ul>
          </div>
          <div>
            <p className={heading}>Suspected (not verified)</p>
            {(report.suspected || []).length === 0 ? <p className="mt-1 text-sm text-slate-600">No rule matched the records, so nothing is suspected.</p> : (
              <ul className="mt-1 space-y-1.5 text-sm" data-testid="incident-suspected">{(report.suspected || []).map((item) => (
                <li key={item.id} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950">
                  <p className="flex items-start gap-1.5 font-medium"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>Suspected: {item.cause}<Ids ids={item.evidence} /></span></p>
                  <p className="text-xs">Why: {item.rule}. To confirm: {item.check}</p>
                </li>
              ))}</ul>
            )}
          </div>
          {report.history && <p className="text-sm text-slate-700">{report.history.text}{report.history.evidence.length > 0 && <Ids ids={report.history.evidence} />}</p>}
          {[...(report.gaps || []), ...(report.clock?.notes || [])].map((note) => <Notice key={note} tone="amber">{note}</Notice>)}
          {report.recovery && (
            <div>
              <p className={heading}>Recovery steps</p>
              <p className="text-xs text-slate-600">{report.recovery.note}</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-slate-800">{report.recovery.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            </div>
          )}
    </>
  );
}

function IncidentTab({ robot, missions }: { robot: Robot; missions: Mission[] }) {
  const [mission, setMission] = useState("");
  const [report, setReport] = useState<IncidentReport | null>(null);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [scenario, setScenario] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const ended = missions.filter((item) => item.final && item.status !== "succeeded");
  const run = async (what: string, work: () => Promise<void>) => { setBusy(what); setError(""); try { await work(); } catch (reason) { setError(message(reason)); } finally { setBusy(""); } };
  return (
    <div className="space-y-3" data-testid="blackbox-incident">
      <div className="flex flex-wrap items-end gap-2">
        <select className={input} value={mission} onChange={(event) => setMission(event.target.value)} aria-label="Which stop">
          <option value="">The latest stop</option>
          {ended.map((item) => <option key={item.id} value={item.id}>{when(item.finishedAt || item.createdAt)} · {item.capability} {item.status}</option>)}
        </select>
        <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void run("why", async () => { setNarrative(null); setScenario(null); setReport(await BlackBox.incident(robot.id, mission || undefined)); })}>
          {busy === "why" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <HelpCircle className="h-4 w-4" aria-hidden="true" />}Why did it stop?
        </button>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
      {report && <IncidentReportView report={report} simulated={robot.simulated} />}
      {report?.found && (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void run("narrate", async () => setNarrative((await BlackBox.narrative(robot.id, mission || undefined)).narrative))}>{busy === "narrate" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Model-written summary</button>
            {report.anchor?.missionId && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void run("scenario", async () => setScenario((await BlackBox.scenario(robot.id, report.anchor?.missionId || undefined)).scenario))}><FileJson className="h-4 w-4" aria-hidden="true" />Make a regression scenario</button>}
          </div>
          {narrative && (narrative.ok && narrative.text
            ? <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-950" data-testid="incident-narrative"><p className={heading}>{narrative.label}</p><p className="mt-1">{narrative.text}</p></div>
            : <Notice tone="amber">No model-written summary: {narrative.problems.join(" ")}</Notice>)}
          {scenario && (
            <div className="space-y-1">
              <p className="text-xs text-slate-600">For HANNAH&apos;s built-in simulator: save it under robotics/scenarios and run <code>python3 -m hannah_robot.scenarios FILE</code>. Passing it is not a test on the robot.</p>
              <pre className="max-h-48 overflow-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">{JSON.stringify(scenario, null, 2)}</pre>
              <button type="button" className={button} onClick={() => download(`${String(scenario.name || "incident")}.json`, `${JSON.stringify(scenario, null, 2)}\n`, "application/json")}><Download className="h-4 w-4" aria-hidden="true" />Download scenario</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A replay is never shown without this: it is what was recorded, not the robot now. */
export function PlaybackBanner({ replay }: { replay: Pick<Replay, "label" | "robot"> }) {
  return <p className="rounded-xl border-2 border-dashed border-violet-400 bg-violet-50 px-3 py-2 text-sm font-semibold text-violet-950" data-testid="playback-banner">{replay.label}{replay.robot.kind === "simulation" ? " Recorded from a simulation." : ""}</p>;
}

function ReplayTab({ robot, missions }: { robot: Robot; missions: Mission[] }) {
  const [mission, setMission] = useState("");
  const [replay, setReplay] = useState<Replay | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!playing || !replay) return undefined;
    const timer = window.setInterval(() => setPosition((at) => { const next = Math.min(replay.to, at + 500); if (next >= replay.to) setPlaying(false); return next; }), 250);
    return () => window.clearInterval(timer);
  }, [playing, replay]);
  const frame = useMemo(() => (replay ? [...replay.frames].reverse().find((item) => item.at <= position) || null : null), [replay, position]);
  const shown = useMemo(() => (replay ? replay.events.filter((item) => item.at <= position) : []), [replay, position]);
  const bounds = useMemo(() => {
    if (!replay?.frames.length) return null;
    const xs = replay.frames.map((item) => item.pose.x);
    const ys = replay.frames.map((item) => item.pose.y);
    const pad = 0.5;
    return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minY: Math.min(...ys) - pad, maxY: Math.max(...ys) + pad };
  }, [replay]);
  const point = (x: number, y: number) => (bounds ? `${((x - bounds.minX) / (bounds.maxX - bounds.minX || 1)) * 300},${150 - ((y - bounds.minY) / (bounds.maxY - bounds.minY || 1)) * 150}` : "0,0");
  return (
    <div className="space-y-2" data-testid="blackbox-replay">
      <div className="flex flex-wrap items-end gap-2">
        <select className={input} value={mission} onChange={(event) => setMission(event.target.value)} aria-label="Mission to replay">
          <option value="">Choose a mission</option>
          {missions.map((item) => <option key={item.id} value={item.id}>{when(item.createdAt)} · {item.capability} {item.status}</option>)}
        </select>
        <button type="button" className={button} disabled={!mission} onClick={() => { setError(""); setPlaying(false); void BlackBox.replay(robot.id, mission).then((value) => { setReplay(value); setPosition(value.from); }).catch((reason) => setError(message(reason))); }}>Load replay</button>
      </div>
      {error && <Notice tone="rose">{error}</Notice>}
      {replay && (
        <>
          <PlaybackBanner replay={replay} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={button} onClick={() => { if (position >= replay.to) setPosition(replay.from); setPlaying(!playing); }}>{playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}{playing ? "Pause playback" : "Play back"}</button>
            <input type="range" className="min-w-[12rem] flex-1" min={replay.from} max={replay.to} step={100} value={position} onChange={(event) => { setPlaying(false); setPosition(Number(event.target.value)); }} aria-label="Playback position" />
            <span className="text-xs text-slate-600">{when(position)}</span>
          </div>
          {bounds ? (
            <svg viewBox="0 0 300 150" className="h-40 w-full rounded-lg bg-slate-50" role="img" aria-label="Recorded track">
              <polyline fill="none" stroke="#94a3b8" strokeWidth="1.5" points={replay.frames.map((item) => point(item.pose.x, item.pose.y)).join(" ")} />
              {frame && <circle r="5" fill="#7c3aed" cx={point(frame.pose.x, frame.pose.y).split(",")[0]} cy={point(frame.pose.x, frame.pose.y).split(",")[1]} />}
            </svg>
          ) : <p className="text-sm text-slate-600">{replay.note}</p>}
          {frame && <p className="text-sm text-slate-800">Recorded position ({frame.pose.x.toFixed(2)}, {frame.pose.y.toFixed(2)}){typeof frame.speed === "number" ? `, ${frame.speed.toFixed(2)} m/s` : ""}{frame.mode ? `, ${frame.mode}` : ""}{frame.estop ? ", emergency stop engaged" : ""} · from {frame.from}</p>}
          <ol className="max-h-48 space-y-0.5 overflow-y-auto text-sm">{shown.map((event) => <li key={event.id} className={SEVERITY[event.severity] || ""}><span className="text-xs text-slate-500">{when(event.at)} · {ORIGIN[event.origin] || event.origin} · </span>{event.summary}</li>)}</ol>
          <p className="text-xs text-slate-500">{replay.note}</p>
        </>
      )}
    </div>
  );
}

function RecordingTab({ robot }: { robot: Robot }) {
  const [view, setView] = useState<BlackBoxSettingsView | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const load = useCallback(() => {
    void BlackBox.settings(robot.id).then(setView).catch((reason) => setError(message(reason)));
    void BlackBox.segments(robot.id).then(setSegments).catch(() => undefined);
  }, [robot.id]);
  useEffect(() => { load(); }, [load]);
  const change = (patch: Parameters<typeof BlackBox.updateSettings>[1]) => { setError(""); setDone(""); void BlackBox.updateSettings(robot.id, patch).then((value) => { setView(value); load(); }).catch((reason) => setError(message(reason))); };
  if (!view) return error ? <Notice tone="rose">{error}</Notice> : null;
  const settings = view.settings;
  const toggle = (key: "enabled" | "acceptSegments" | "acceptSensitive", label: string, hint: string, disabled = false) => (
    <label className="flex items-start gap-2 text-sm text-slate-800"><input type="checkbox" className="mt-1" checked={settings[key]} disabled={disabled} onChange={(event) => change({ [key]: event.target.checked })} /><span>{label}<span className="block text-xs text-slate-600">{hint}</span></span></label>
  );
  const days = (key: "retentionDays" | "sensitiveRetentionDays" | "segmentRetentionDays", label: string, max: number) => (
    <label className="flex items-center gap-2 text-sm text-slate-800">{label}<input type="number" className={`${input} w-20`} min={1} max={max} defaultValue={settings[key]} key={`${key}-${settings[key]}`} onBlur={(event) => { const value = Number(event.target.value); if (value !== settings[key]) change({ [key]: value }); }} />days</label>
  );
  return (
    <div className="space-y-3" data-testid="blackbox-recording">
      <p className="text-sm text-slate-700">The robot keeps its own recording on its disk, with its own per-topic rules (robotics/runtime: <code>--record</code>, <code>--blackbox-config</code>). These settings decide what this server accepts from it and how long it keeps it. Cameras and microphones are never recorded by a wildcard rule on the robot, and only their metadata unless raw recording is switched on there.</p>
      {toggle("enabled", "Keep this robot's black box events", "Off: the robot is told, and nothing it uploads is stored.")}
      {toggle("acceptSegments", "Accept raw recording uploads", view.storage.durable ? `Telemetry segments are stored as files (${view.storage.kind} storage), never in the database.` : "This server has no durable file storage: recordings would be lost, so they are refused.", !settings.enabled)}
      {toggle("acceptSensitive", "Also accept recordings and details marked sensitive", "Camera, microphone and other sensitive topics. Only a signed-in person can see or download them.", !settings.acceptSegments)}
      <div className="flex flex-wrap gap-4">{days("retentionDays", "Keep events", 365)}{days("sensitiveRetentionDays", "Sensitive events", 30)}{days("segmentRetentionDays", "Recordings", 90)}</div>
      <div>
        <p className={heading}>Uploaded recordings</p>
        {segments.length === 0 ? <p className="mt-1 text-sm text-slate-600">None stored.</p> : (
          <ul className="mt-1 space-y-1 text-sm">{segments.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{item.id}</span><span className="text-slate-600">{item.stream} · {item.records} records · {(item.bytes / 1024).toFixed(1)} KB{item.fromAt ? ` · ${when(item.fromAt)}` : ""}{item.simulated ? " · simulation" : ""}{item.verified ? "" : " · not closed (unverified)"}</span>
              {item.sensitivity === "sensitive" && <span className="text-xs text-violet-800">sensitive</span>}
              <button type="button" className={button} disabled={!item.downloadable} onClick={() => void BlackBox.downloadSegment(robot.id, item.id).then((blob) => download(`${robot.id}-${item.id}.hbx.gz`, blob, "application/gzip")).catch((reason) => setError(message(reason)))}><Download className="h-4 w-4" aria-hidden="true" />Download</button></li>
          ))}</ul>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => void BlackBox.exportData(robot.id).then((data) => download(`blackbox-${robot.id}.json`, `${JSON.stringify(data, null, 2)}\n`, "application/json")).catch((reason) => setError(message(reason)))}><Download className="h-4 w-4" aria-hidden="true" />Export everything</button>
        <button type="button" className={button} onClick={() => { if (window.confirm(`Delete ${robot.name}'s black box events and recordings on the server? The robot's own copy and the mission history are kept.`)) void BlackBox.remove(robot.id).then((removed) => { setDone(`Deleted ${removed.events} events and ${removed.segments} recordings. ${removed.note}`); load(); }).catch((reason) => setError(message(reason))); }}><Trash2 className="h-4 w-4" aria-hidden="true" />Delete black box data</button>
      </div>
      {done && <Notice>{done}</Notice>}
      {error && <Notice tone="rose">{error}</Notice>}
    </div>
  );
}

export default function BlackBoxPanel({ robot }: { robot: Robot }) {
  const [tab, setTab] = useState<Tab>("timeline");
  const [missions, setMissions] = useState<Mission[]>([]);
  useEffect(() => { void Robotics.missions(robot.id, 30).then(setMissions).catch(() => undefined); }, [robot.id, tab]);
  if (robot.status === "pending") return null;
  const tabs: Array<[Tab, string]> = [["timeline", "Timeline"], ["incident", "Why did it stop?"], ["replay", "Replay"], ["recording", "Recording & privacy"]];
  return (
    <section className={`${card} space-y-3`} data-testid="blackbox">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900">Black box{robot.simulated && <span className="ml-2 text-xs font-normal text-sky-800">simulation records</span>}</h3>
        <div role="tablist" aria-label="Black box" className="flex flex-wrap gap-1">
          {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={`rounded-lg px-2.5 py-1 text-sm ${tab === id ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </div>
      {tab === "timeline" && <TimelineTab robot={robot} />}
      {tab === "incident" && <IncidentTab robot={robot} missions={missions} />}
      {tab === "replay" && <ReplayTab robot={robot} missions={missions} />}
      {tab === "recording" && <RecordingTab robot={robot} />}
    </section>
  );
}
