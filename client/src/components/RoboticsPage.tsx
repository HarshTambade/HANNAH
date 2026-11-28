/**
 * Robots: the registry, each robot's live state, its missions and what it is
 * allowed to do.
 *
 * Everything shown is the server's record of what the robot itself reported
 * (services/Robotics.ts → server/robotics). The screen never moves anything:
 * it asks for a mission through the Action Engine, shows the approval that
 * the mission needs, and then shows what the robot did.
 *
 * Three things are always visible, because confusing them would be dangerous:
 *   - whether a robot is a SIMULATION or a PHYSICAL robot;
 *   - how old the state on screen is (an offline robot's is marked as old);
 *   - that Stop is a software request, not an emergency stop.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AlertTriangle, BatteryCharging, BatteryMedium, Bot, CheckCircle2, CircleSlash, Clock, Loader2, MapPin, OctagonX, Plus, Radio, ShieldCheck, Trash2, WifiOff, XCircle } from "lucide-react";
import { ACCOUNT_EVENT, isAccountSession } from "../services/api";
import { OPERATOR_EVENT, Operator, type ActionRecord } from "../services/Operator";
import { AnalyticsPanel, ArmPanel, CameraPanel, CommissioningPanel, DestinationsPanel, DiagnosticsPanel, FleetPanel, PlansPanel, SurroundingsPanel } from "./RobotPanels";
import SimToRealPanel from "./robotops/SimToRealPanel";
import { EdgeResourcesPanel } from "./robotops/EdgeResourcesPanel";
import { Robotics, type Capability, type Enrollment, type Mission, type Robot, type RobotEvent, type TelemetrySample } from "../services/Robotics";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const danger = "inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const clock = (at: number | null | undefined) => (at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "never");
const fixed = (value: number | null | undefined, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "–");
const SIMULATORS: Record<string, string> = { "hannah-arm-kinematic": "HANNAH's built-in arm simulator (not MoveIt or Gazebo)", "hannah-kinematic": "HANNAH's built-in simulator (not Gazebo)", "gazebo-harmonic": "Gazebo Harmonic", "stand-in": "scripted test robot" };
const CONNECTION: Record<Robot["connection"], { label: string; tone: string }> = {
  online: { label: "Connected", tone: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  offline: { label: "Offline", tone: "bg-amber-50 text-amber-900 border-amber-200" },
  "never-connected": { label: "Enrolled, never connected", tone: "bg-slate-100 text-slate-800 border-slate-200" },
  "awaiting-enrollment": { label: "Waiting for its runtime to enroll", tone: "bg-sky-50 text-sky-900 border-sky-200" },
  revoked: { label: "Access revoked", tone: "bg-rose-50 text-rose-800 border-rose-200" },
};
const MODE: Record<string, string> = { manipulating: "Moving the arm", paused: "Paused", idle: "Idle", navigating: "Driving", holding: "Holding position", stopping: "Stopping", docked: "In its dock", estopped: "Emergency stop engaged", fault: "Fault", offline: "Offline", starting: "Starting", unknown: "Unknown" };
const MISSION: Record<string, { label: string; tone: string; Icon: typeof Clock }> = {
  queued: { label: "Waiting to be delivered", tone: "bg-sky-50 text-sky-900 border-sky-200", Icon: Clock },
  sent: { label: "Delivered, not accepted yet", tone: "bg-sky-50 text-sky-900 border-sky-200", Icon: Clock },
  accepted: { label: "Running", tone: "bg-sky-50 text-sky-900 border-sky-200", Icon: Loader2 },
  paused: { label: "Paused", tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: Clock },
  succeeded: { label: "Finished, verified", tone: "bg-emerald-50 text-emerald-800 border-emerald-200", Icon: CheckCircle2 },
  unverified: { label: "Reported done, not confirmed", tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertTriangle },
  failed: { label: "Failed", tone: "bg-rose-50 text-rose-800 border-rose-200", Icon: XCircle },
  rejected: { label: "Refused by the robot", tone: "bg-rose-50 text-rose-800 border-rose-200", Icon: XCircle },
  "timed-out": { label: "Ran out of time", tone: "bg-rose-50 text-rose-800 border-rose-200", Icon: XCircle },
  cancelled: { label: "Cancelled", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  expired: { label: "Never started", tone: "bg-slate-100 text-slate-800 border-slate-200", Icon: CircleSlash },
  lost: { label: "Outcome unknown", tone: "bg-amber-50 text-amber-900 border-amber-200", Icon: AlertTriangle },
};

function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "rose" | "amber" }) {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-700", rose: "border-rose-200 bg-rose-50 text-rose-800", amber: "border-amber-200 bg-amber-50 text-amber-900" };
  return <p role={tone === "rose" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}
function Chip({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return <span data-testid={testId} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{children}</span>;
}
/** The one badge that must never be missed. */
function KindBadge({ robot }: { robot: Pick<Robot, "simulated" | "simulator" | "status"> }) {
  if (robot.simulated) return <Chip testId="robot-kind" tone="border-violet-300 bg-violet-50 text-violet-900"><Radio className="h-3.5 w-3.5" aria-hidden="true" />SIMULATION{robot.simulator ? ` · ${SIMULATORS[robot.simulator] || robot.simulator}` : ""}</Chip>;
  return <Chip testId="robot-kind" tone="border-orange-300 bg-orange-50 text-orange-900"><AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />PHYSICAL ROBOT</Chip>;
}

/** A small trend line inside a figure. One series, no axes: the number beside it is the reading. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <span className="text-xs text-slate-500">Not enough history yet</span>;
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const points = values.map((value, index) => `${((index / (values.length - 1)) * 100).toFixed(1)},${(22 - ((value - low) / span) * 20).toFixed(1)}`).join(" ");
  return <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full" role="img" aria-label={label}><polyline points={points} fill="none" stroke="#475569" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></svg>;
}
function Figure({ label, value, note, children }: { label: string; value: string; note?: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className={heading}>{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
      {note && <p className="text-xs text-slate-600">{note}</p>}
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** The robot on its map: what it reports, never a prediction. */
function MapView({ robot, target, onPick }: { robot: Robot; target: { x: number; y: number } | null; onPick: (point: { x: number; y: number }) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const bounds = robot.world?.bounds;
  if (!bounds) return <Notice>This robot didn't send a map of its surroundings.</Notice>;
  const state = robot.state;
  const pose = state?.pose;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const radius = robot.limits.robotRadius || 0.2;
  const pick = (event: MouseEvent<SVGSVGElement>) => {
    const matrix = ref.current?.getScreenCTM();
    if (!matrix || !ref.current) return;
    const point = ref.current.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const at = point.matrixTransform(matrix.inverse());
    onPick({ x: Number(at.x.toFixed(2)), y: Number((-at.y).toFixed(2)) });
  };
  const ranges = state?.sensors?.lidar?.ranges;
  const maxRange = Number(state?.sensors?.lidar?.maxRange) || 8;
  const hits = pose && Array.isArray(ranges) ? ranges.map((range, index) => (range < maxRange - 0.01 ? [pose.x + range * Math.cos((pose.yaw || 0) + (2 * Math.PI * index) / ranges.length), pose.y + range * Math.sin((pose.yaw || 0) + (2 * Math.PI * index) / ranges.length)] : null)).filter((hit): hit is number[] => hit !== null) : [];
  const polygon = (points: number[][]) => points.map(([x, y]) => `${x},${-y}`).join(" ");
  const truth = state?.sim?.truth;
  return (
    <figure>
      <svg ref={ref} data-testid="robot-map" viewBox={`${bounds.minX - 0.2} ${-bounds.maxY - 0.2} ${width + 0.4} ${height + 0.4}`} className="w-full cursor-crosshair rounded-xl border border-slate-300 bg-slate-50" role="img" onClick={pick}
        aria-label={`Map of ${robot.world?.name || "the robot's area"}. ${pose ? `The robot reports position ${fixed(pose.x)}, ${fixed(pose.y)}.` : "No position reported."}`}>
        <rect x={bounds.minX} y={-bounds.maxY} width={width} height={height} fill="#ffffff" stroke="#0f172a" strokeWidth="0.06" />
        {robot.limits.keepOut.map((zone) => <polygon key={zone.name} points={polygon(zone.polygon)} fill="#fecdd3" stroke="#be123c" strokeWidth="0.03" strokeDasharray="0.12 0.08"><title>Keep-out zone: {zone.name}</title></polygon>)}
        {(robot.world?.obstacles || []).map((rect, index) => <rect key={index} x={rect.x} y={-(rect.y + rect.h)} width={rect.w} height={rect.h} fill="#94a3b8" stroke="#475569" strokeWidth="0.03" />)}
        {(state?.map?.discovered || []).map(([x, y], index) => <rect key={`d${index}`} x={x - 0.05} y={-y - 0.05} width="0.1" height="0.1" fill="#f59e0b"><title>Seen by the range sensor; not on the robot's map</title></rect>)}
        {Object.entries(robot.places).map(([name, place]) => (
          <g key={name}>
            <circle cx={place.x} cy={-place.y} r="0.09" fill="#0369a1" />
            <text x={place.x + 0.14} y={-place.y + 0.07} fontSize="0.24" fill="#0f172a">{name}</text>
          </g>
        ))}
        {robot.online && hits.map(([x, y], index) => <circle key={`h${index}`} cx={x} cy={-y} r="0.035" fill="#dc2626" />)}
        {robot.online && (state?.perception?.obstacles || []).filter((item) => item.kind !== "mapped obstacle").map((item, index) => <circle key={`o${index}`} cx={item.x} cy={-item.y} r={Math.max(0.15, item.widthM / 2)} fill="none" stroke="#b45309" strokeWidth="0.05"><title>An object that isn't on the map, detected by the {item.sensor} (confidence {item.confidence})</title></circle>)}
        {robot.online && state?.nav?.path && state.nav.path.length > 1 && <polyline points={polygon(state.nav.path)} fill="none" stroke="#2563eb" strokeWidth="0.05" strokeDasharray="0.15 0.1" />}
        {robot.online && state?.nav?.goal && <g><circle cx={state.nav.goal.x} cy={-state.nav.goal.y} r="0.16" fill="none" stroke="#2563eb" strokeWidth="0.05" /><title>The goal the robot is driving to</title></g>}
        {target && <g><path d={`M ${target.x - 0.15} ${-target.y} h 0.3 M ${target.x} ${-target.y - 0.15} v 0.3`} stroke="#7c3aed" strokeWidth="0.05" /><title>The point you picked</title></g>}
        {robot.simulated && truth && pose && Math.hypot(truth.x - pose.x, truth.y - pose.y) > 0.05 && <circle cx={truth.x} cy={-truth.y} r={radius} fill="none" stroke="#64748b" strokeWidth="0.03" strokeDasharray="0.06 0.06"><title>Simulator ground truth</title></circle>}
        {pose && (
          <g opacity={robot.online ? 1 : 0.45} data-testid="robot-marker">
            <circle cx={pose.x} cy={-pose.y} r={radius} fill={state?.estop?.engaged || state?.faults?.length ? "#e11d48" : "#0f172a"} />
            <line x1={pose.x} y1={-pose.y} x2={pose.x + radius * 1.5 * Math.cos(pose.yaw || 0)} y2={-(pose.y + radius * 1.5 * Math.sin(pose.yaw || 0))} stroke="#ffffff" strokeWidth="0.06" strokeLinecap="round" />
          </g>
        )}
      </svg>
      <figcaption className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-slate-900 align-middle" />Robot, as it reports</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-slate-400 align-middle" />Mapped obstacle</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-600 align-middle" />Range sensor return</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-amber-500 align-middle" />Seen, not on the map</span>
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border border-rose-700 bg-rose-200 align-middle" />Keep-out zone</span>
        {robot.simulated && <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full border border-dashed border-slate-500 align-middle" />Simulator ground truth</span>}
        <span>Click the map to pick a point.</span>
      </figcaption>
    </figure>
  );
}

function EnrollmentBox({ enrollment, robot }: { enrollment: Enrollment; robot: Robot }) {
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950" data-testid="enrollment">
      <p className="font-medium">One-time enrollment code: <span data-testid="enrollment-code" className="font-mono text-base">{enrollment.enrollment.code}</span></p>
      <p className="mt-1">Valid until {clock(enrollment.enrollment.expiresAt)}, for one use. On the robot's computer, in <span className="font-mono">robotics/runtime</span>, run:</p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-2 font-mono text-xs text-slate-900">{enrollment.command}{robot.simulated ? "" : " --profile <the robot's profile file>"}{"\n"}python3 -m hannah_robot run{robot.simulated ? "" : " --profile <the robot's profile file>"}</pre>
      <p className="mt-2 text-xs">{robot.simulated ? "With no profile this starts HANNAH's built-in simulator. It is not Gazebo." : "A physical robot needs the ROS 2 adapter and a profile with the robot's own limits. That adapter is written and has not been run on hardware yet."}</p>
    </div>
  );
}

function AddRobot({ canEnroll, onAdded }: { canEnroll: boolean; onAdded: (enrollment: Enrollment) => void }) {
  const [name, setName] = useState("");
  const [simulated, setSimulated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    setBusy(true); setError("");
    try { onAdded(await Robotics.create(name.trim(), simulated)); setName(""); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  if (!canEnroll) return <Notice tone="amber">This server can't enroll robots yet: it has no key vault to keep a robot's secret in.</Notice>;
  return (
    <form className={`${card} space-y-3`} onSubmit={(event) => { event.preventDefault(); void add(); }} data-testid="add-robot">
      <h2 className="font-semibold text-slate-900">Add a robot</h2>
      <label className="block text-sm text-slate-700">Name<input className={`${input} mt-1`} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Rover" required /></label>
      <fieldset className="text-sm text-slate-700">
        <legend className="mb-1">What is it?</legend>
        <label className="mr-4 inline-flex items-center gap-1.5"><input type="radio" name="kind" checked={simulated} onChange={() => setSimulated(true)} />A simulated robot</label>
        <label className="inline-flex items-center gap-1.5"><input type="radio" name="kind" checked={!simulated} onChange={() => setSimulated(false)} />A physical robot</label>
      </fieldset>
      <p className="text-xs text-slate-600">{simulated ? "A simulation can be given standing permission to move without asking each time." : "A physical robot's movement always needs your approval, whatever permissions you set. HANNAH has not been tested on physical hardware."} A runtime of the other kind is refused when it tries to enroll.</p>
      {error && <Notice tone="rose">{error}</Notice>}
      <button type="submit" className={primary} disabled={busy || !name.trim()}><Plus className="h-4 w-4" aria-hidden="true" />Create and get a code</button>
    </form>
  );
}

function Approval({ record, onChanged }: { record: ActionRecord; onChanged: (decided: ActionRecord | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = async (approve: boolean) => {
    setBusy(true); setError("");
    let decided: ActionRecord | null = null;
    try { decided = await Operator.decide(record.id, approve); } catch (reason) { setError(message(reason)); } finally { setBusy(false); onChanged(decided); }
  };
  return (
    <div className="rounded-xl border border-sky-300 bg-sky-50 p-3" data-testid="robot-approval">
      <p className="font-medium text-slate-900">{record.preview?.title}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-slate-800">{(record.preview?.lines || []).map((line) => <div key={line.label} className="contents"><dt className="text-slate-600">{line.label}</dt><dd>{line.value}</dd></div>)}</dl>
      {record.preview?.body && <p className="mt-1 text-sm text-slate-700">{record.preview.body}</p>}
      {(record.preview?.warnings || []).map((warning) => <p key={warning} className="mt-1 flex items-start gap-1.5 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{warning}</p>)}
      <p className="mt-1 text-xs text-slate-600">{record.permission?.reason}{record.agent ? ` Asked by: ${record.agent}.` : ""}</p>
      {error && <Notice tone="rose">{error}</Notice>}
      <div className="mt-2 flex gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => void answer(true)}>Approve and start</button>
        <button type="button" className={button} disabled={busy} onClick={() => void answer(false)}>Decline</button>
      </div>
    </div>
  );
}

function RobotDetail({ robotId, enrollment, capabilities, onGone, robots = [] }: { robotId: string; enrollment: Enrollment | null; capabilities: Capability[]; onGone: () => void; robots?: Robot[] }) {
  const [data, setData] = useState<{ robot: Robot; missions: Mission[]; events: RobotEvent[] } | null>(null);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [waiting, setWaiting] = useState<ActionRecord[]>([]);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<{ text: string; tone: "slate" | "rose" | "amber" } | null>(null);
  const [busy, setBusy] = useState("");
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null);
  const [place, setPlace] = useState("");
  const [code, setCode] = useState<Enrollment | null>(enrollment);
  const [speed, setSpeed] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [next, approvals] = await Promise.all([Robotics.get(robotId), Operator.list({ status: "waiting", service: "robots", limit: 20 })]);
      setData(next);
      setWaiting(approvals.actions.filter((record) => record.resource?.id === robotId && record.status === "waiting-approval"));
      setError("");
    } catch (reason) { setError(message(reason)); }
  }, [robotId]);
  useEffect(() => {
    setData(null); setOutcome(null); setTarget(null); setCode(enrollment);
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 1000);
    const listener = () => { void refresh(); };
    window.addEventListener(OPERATOR_EVENT, listener);
    return () => { window.clearInterval(timer); window.removeEventListener(OPERATOR_EVENT, listener); };
  }, [refresh, enrollment]);
  useEffect(() => {
    const load = () => { void Robotics.telemetry(robotId).then(setSamples).catch(() => undefined); };
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [robotId]);

  const robot = data?.robot;
  const active = useMemo(() => data?.missions.find((mission) => !mission.final) || null, [data]);
  if (error && !robot) return <Notice tone="rose">{error}</Notice>;
  if (!robot) return <p className="text-sm text-slate-600"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" />Loading…</p>;
  const state = robot.state;
  const isArm = robot.robotType === "manipulator-arm";
  const offered = capabilities.filter((item) => robot.capabilities.includes(item.id));
  const can = (id: string) => robot.capabilities.includes(id) && !robot.disabled.includes(id);
  const show = (record: ActionRecord) => setOutcome({ text: record.outcome, tone: record.status === "failed" || record.status === "denied" ? "rose" : record.status === "unverified" || record.status === "unknown" ? "amber" : "slate" });
  const ask = async (label: string, action: Parameters<typeof Robotics.ask>[0], params: Record<string, unknown>) => {
    setBusy(label); setOutcome(null);
    try { show(await Robotics.ask(action, { robot: robot.id, ...params })); } catch (reason) { setOutcome({ text: message(reason), tone: "rose" }); } finally { setBusy(""); void refresh(); }
  };
  const stop = async () => {
    setBusy("stop"); setOutcome(null);
    try { show((await Robotics.stop(robot.id)).record); } catch (reason) { setOutcome({ text: message(reason), tone: "rose" }); } finally { setBusy(""); void refresh(); }
  };
  const control = async (label: string, run: () => Promise<{ record: ActionRecord }>) => {
    setBusy(label); setOutcome(null);
    try { show((await run()).record); } catch (reason) { setOutcome({ text: message(reason), tone: "rose" }); } finally { setBusy(""); void refresh(); }
  };
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label); setError("");
    try { await run(); } catch (reason) { setError(message(reason)); } finally { setBusy(""); void refresh(); }
  };
  const speeds = samples.map((sample) => Math.abs(sample.v ?? 0));
  const batteries = samples.filter((sample) => sample.battery !== null).map((sample) => sample.battery as number);
  const errors = data.events.filter((event) => event.severity !== "info").slice(0, 8);

  return (
    <div className="space-y-4" data-testid="robot-detail" data-robot={robot.id}>
      <section className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <h2 className="text-lg font-semibold text-slate-900">{robot.name}</h2>
            <p className="text-sm text-slate-600">{[robot.manufacturer, robot.model].filter(Boolean).join(" ") || "Not described yet"}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <KindBadge robot={robot} />
              <Chip testId="robot-connection" tone={CONNECTION[robot.connection].tone}>{robot.connection === "offline" && <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />}{CONNECTION[robot.connection].label}</Chip>
              {robot.status === "enrolled" && <Chip testId="robot-mode" tone="border-slate-200 bg-slate-100 text-slate-800">{MODE[robot.mode] || robot.mode}</Chip>}
              {robot.status === "enrolled" && robot.commissioning.required && <Chip testId="robot-commissioning" tone={robot.commissioning.status === "approved" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}>{robot.commissioning.status === "approved" ? "Commissioned" : robot.commissioning.status === "trial" ? "Commissioning trial" : `Not commissioned (${robot.commissioning.done} of ${robot.commissioning.total})`}</Chip>}
            </div>
          </div>
          {robot.status === "enrolled" && (
            <div className="shrink-0 text-right">
              <button type="button" className={danger} onClick={() => void stop()} disabled={busy === "stop"} data-testid="stop-robot"><OctagonX className="h-4 w-4" aria-hidden="true" />Stop</button>
              <p className="mt-1 max-w-[16rem] text-xs text-slate-600">A software request to the robot's controller. Not an emergency stop{robot.simulated ? "." : ": in danger, use the red button on the robot."}</p>
            </div>
          )}
        </div>
        {code && robot.enrollmentExpiresAt && robot.status !== "enrolled" && <EnrollmentBox enrollment={code} robot={robot} />}
        {robot.status === "enrolled" && !robot.online && <Notice tone="amber">{robot.lastSeenAt ? `This robot last reported at ${clock(robot.lastSeenAt)}. What you see below is that last report, not where it is now. A robot that loses its link stops by itself${robot.limits.linkTimeoutS ? ` within ${robot.limits.linkTimeoutS} seconds` : ""}.` : "This robot is enrolled and its runtime has never connected."}</Notice>}
        {state?.estop?.engaged && <Notice tone="rose">The emergency stop is engaged. It has to be released at the robot; HANNAH can't release it.</Notice>}
        {(state?.faults || []).map((fault) => <Notice key={fault.code} tone="rose">Fault: {fault.message}</Notice>)}
        {outcome && <div data-testid="robot-outcome"><Notice tone={outcome.tone}>{outcome.text}</Notice></div>}
        {waiting.map((record) => <Approval key={record.id} record={record} onChanged={(decided) => { if (decided) show(decided); void refresh(); }} />)}
      </section>

      {robot.status === "enrolled" && <CommissioningPanel robot={robot} onChanged={() => void refresh()} />}

      {isArm && <ArmPanel robot={robot} busy={Boolean(busy)} onAsk={(action, params) => void ask(action, action, params)} />}
      {isArm && active && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950" data-testid="active-mission">
          <span>{active.summary}</span>
          <button type="button" className={button} onClick={() => void act("cancel", () => Robotics.cancel(active.id))} disabled={busy === "cancel" || Boolean(active.cancelRequestedAt)}>{active.cancelRequestedAt ? "Cancelling…" : "Cancel"}</button>
        </div>
      )}

      {robot.status === "enrolled" && !isArm && (
        <section className={`${card} space-y-3`}>
          <h3 className="font-semibold text-slate-900">Where it is</h3>
          <MapView robot={robot} target={target} onPick={setTarget} />
          {state?.pose && <p className="text-sm text-slate-700" data-testid="robot-pose">Reported position ({fixed(state.pose.x)}, {fixed(state.pose.y)}) m, from {state.pose.source || "the robot"}{robot.stateAgeS !== null ? `, ${robot.stateAgeS.toFixed(1)} s ago` : ""}.{robot.simulated && state.sim?.odometryError !== undefined ? ` The simulator's ground truth differs by ${fixed(state.sim.odometryError)} m.` : ""}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm text-slate-700">Go to
              <select className={`${input} mt-1 w-44`} value={place} onChange={(event) => setPlace(event.target.value)} aria-label="Place to drive to">
                <option value="">a place…</option>
                {Object.keys(robot.places).map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <button type="button" className={primary} disabled={!place || !can("navigate_to") || Boolean(busy)} onClick={() => void ask("go", "robots.navigate_to", { place })} data-testid="go-place"><MapPin className="h-4 w-4" aria-hidden="true" />Ask to drive there</button>
            {target && <button type="button" className={button} disabled={!can("navigate_to") || Boolean(busy)} onClick={() => void ask("go", "robots.navigate_to", target)}>Ask to drive to ({fixed(target.x)}, {fixed(target.y)})</button>}
            <button type="button" className={button} disabled={!can("return_to_dock") || Boolean(busy)} onClick={() => void ask("dock", "robots.return_to_dock", {})}>Ask to return to dock</button>
            {Object.keys(robot.devices).map((device) => <button key={device} type="button" className={button} disabled={!can("set_supported_device_state") || Boolean(busy)} onClick={() => void ask(device, "robots.set_supported_device_state", { device, state: state?.devices?.[device] === "on" ? "off" : "on" })}>Switch {device} {state?.devices?.[device] === "on" ? "off" : "on"}</button>)}
          </div>
          <p className="text-xs text-slate-600">Each of these asks. You see the goal, the limits and the checks before anything starts, unless a standing permission you gave covers this robot.</p>
          {active && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-950" data-testid="active-mission">
              <span>{active.summary}</span>
              <span className="flex flex-wrap gap-2">
                {active.status === "accepted" && <button type="button" className={button} data-testid="pause-mission" disabled={Boolean(busy) || Boolean(active.pauseRequestedAt)} onClick={() => void control("pause", () => Robotics.pause(active.id))}>{active.pauseRequestedAt ? "Pausing…" : "Pause"}</button>}
                {active.status === "paused" && <button type="button" className={primary} data-testid="resume-mission" disabled={Boolean(busy) || Boolean(active.resumeRequestedAt)} onClick={() => void control("resume", () => Robotics.resume(active.id))}>Ask to resume</button>}
                <button type="button" className={button} onClick={() => void act("cancel", () => Robotics.cancel(active.id))} disabled={busy === "cancel" || Boolean(active.cancelRequestedAt)}>{active.cancelRequestedAt ? "Cancelling…" : "Cancel mission"}</button>
              </span>
            </div>
          )}
        </section>
      )}

      <PlansPanel robot={robot} busy={Boolean(busy)} onAsk={(plan) => void control("plan", async () => ({ record: await Robotics.runPlan(robot.id, plan) }))} />
      {!isArm && <DestinationsPanel robot={robot} picked={target} />}
      <SurroundingsPanel robot={robot} />
      <CameraPanel robot={robot} busy={Boolean(busy)} onAsk={() => void ask("picture", "robots.capture_image", {})} onChanged={() => void refresh()} />

      {robot.status === "enrolled" && state && (
        <section className={`${card} space-y-3`}>
          <h3 className="font-semibold text-slate-900">Telemetry{!robot.online && <span className="ml-2 text-xs font-normal text-amber-800">last report, not current</span>}</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {isArm
              ? <Figure label="Fastest joint" value={`${fixed(Math.abs(state.velocity?.angular ?? 0))} rad/s`} note={`Limit ${fixed(robot.limits.maxJointSpeed)} rad/s`} />
              : <Figure label="Speed" value={`${fixed(Math.abs(state.velocity?.linear ?? 0))} m/s`} note={`Limit ${fixed(robot.limits.maxLinearSpeed)} m/s`}><Sparkline values={speeds} label="Speed over the last 15 minutes" /></Figure>}
            <Figure label="Battery" value={state.battery ? `${Math.round(state.battery.percent)}%` : "Not reported"} note={state.battery?.charging ? "Charging" : `Minimum to start ${robot.limits.minBatteryPercent ?? "–"}%`}>
              {state.battery && <span className="inline-flex items-center gap-1 text-xs text-slate-600">{state.battery.charging ? <BatteryCharging className="h-4 w-4" aria-hidden="true" /> : <BatteryMedium className="h-4 w-4" aria-hidden="true" />}</span>}
              <Sparkline values={batteries} label="Battery over the last 15 minutes" />
            </Figure>
            <Figure label="Emergency stop" value={state.estop?.engaged ? "Engaged" : "Released"} note={robot.limits.estop?.hardware ? robot.limits.estop.description || "Hardware" : robot.limits.estop?.description || "No hardware emergency stop reported"} />
            <Figure label="Link to HANNAH" value={state.link?.ok === false ? "Lost" : robot.online ? "Up" : "Down"} note={`Robot stops itself after ${robot.limits.linkTimeoutS ?? "–"} s of silence`} />
          </div>
          <div>
            <p className={heading}>Sensors</p>
            <ul className="mt-1 grid gap-1 text-sm text-slate-800 sm:grid-cols-2">
              {robot.sensors.map((sensor) => {
                const reading = state.sensors?.[sensor.id];
                const summary = !reading ? "no reading" : sensor.id === "lidar" ? `nearest return ${fixed(reading.minRange as number)} m` : sensor.id === "odometry" ? `${fixed(reading.travelled as number, 1)} m travelled` : sensor.id === "bumper" ? (reading.pressed ? "pressed" : "clear") : sensor.id === "battery" ? `${fixed(reading.percent as number, 0)}%` : "reporting";
                return <li key={sensor.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1"><span><span className="font-medium">{sensor.id}</span> <span className="text-slate-600">{sensor.type}</span></span><span className={reading?.ok === false ? "text-rose-700" : "text-slate-700"}>{reading?.ok === false ? "not working" : summary}</span></li>;
              })}
            </ul>
          </div>
        </section>
      )}
      {robot.status === "enrolled" && <EdgeResourcesPanel robotId={robot.id} />}

      <section className={`${card} space-y-2`}>
        <h3 className="font-semibold text-slate-900">Missions</h3>
        {data.missions.length === 0 ? <p className="text-sm text-slate-600">No missions yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {data.missions.map((mission) => {
              const item = MISSION[mission.status] || MISSION.lost;
              return (
                <li key={mission.id} className="py-2" data-testid="mission-row" data-status={mission.status}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900">{mission.title}{typeof mission.params.place === "string" ? `: ${mission.params.place}` : typeof mission.params.x === "number" ? `: (${fixed(mission.params.x as number)}, ${fixed(mission.params.y as number)})` : ""}</span>
                    <Chip tone={item.tone}><item.Icon className={`h-3.5 w-3.5 ${mission.status === "accepted" ? "animate-spin" : ""}`} aria-hidden="true" />{item.label}</Chip>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-700">{mission.verification?.evidence || mission.error || mission.summary}</p>
                  <p className="text-xs text-slate-500">{clock(mission.createdAt)}{mission.finishedAt ? ` → ${clock(mission.finishedAt)}` : ""}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {errors.length > 0 && (
        <section className={`${card} space-y-2`}>
          <h3 className="font-semibold text-slate-900">Warnings and errors</h3>
          <ul className="space-y-1 text-sm">{errors.map((event) => <li key={event.id} className={event.severity === "error" ? "text-rose-800" : "text-amber-900"}><span className="text-slate-500">{clock(event.at)} · {event.source === "robot" ? "robot" : "server"} · </span>{event.message}</li>)}</ul>
        </section>
      )}

      {robot.status === "enrolled" && (
        <section className={`${card} space-y-3`}>
          <h3 className="font-semibold text-slate-900">What it can do, and what it may do</h3>
          <ul className="space-y-2">
            {offered.map((item) => {
              const off = robot.disabled.includes(item.id);
              const asks = robot.alwaysAsk.includes(item.id);
              const fixedRule = item.kind === "read" || item.deescalates;
              return (
                <li key={item.id} className="rounded-xl border border-slate-200 p-2 text-sm" data-testid="capability" data-capability={item.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">{item.title}</span>
                    <span className="text-xs text-slate-600">{item.riskLabel}</span>
                  </div>
                  <p className="text-slate-700">{item.description}</p>
                  <p className="mt-0.5 text-xs text-slate-600">Checked how: {item.verification.description}</p>
                  {fixedRule ? <p className="mt-1 text-xs text-slate-600">{item.deescalates ? "Never needs approval and can't be switched off." : "Reading needs no approval."}</p> : (
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-800">
                      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={!off} onChange={() => void act(item.id, () => Robotics.update(robot.id, { disabled: off ? robot.disabled.filter((id) => id !== item.id) : [...robot.disabled, item.id] }))} />Allowed on this robot</label>
                      <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={asks || (item.motion && !robot.simulated)} disabled={item.motion && !robot.simulated} onChange={() => void act(item.id, () => Robotics.update(robot.id, { alwaysAsk: asks ? robot.alwaysAsk.filter((id) => id !== item.id) : [...robot.alwaysAsk, item.id] }))} />Always ask me first{item.motion && !robot.simulated ? " (always, for a physical robot)" : ""}</label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {(robot.refusedCapabilities || []).length > 0 && <p className="text-xs text-slate-600">The robot also offered, and HANNAH refused: {(robot.refusedCapabilities || []).map((item) => `${item.id} (${item.reason})`).join("; ")}</p>}
          <div>
            <p className={heading}>Limits in force</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm text-slate-800">
              <dt className="text-slate-600">Top speed</dt><dd>{isArm ? `${fixed(robot.limits.maxJointSpeed)} rad/s at any joint (the robot's own)` : `${fixed(robot.limits.maxLinearSpeed)} m/s${robot.safety.owner?.maxLinearSpeed !== undefined ? " (you lowered it)" : " (the robot's own)"}`}</dd>
              <dt className="text-slate-600">Workspace</dt><dd>{robot.limits.workspaces.length ? "Goals outside it are refused" : "None reported: HANNAH won't move this robot"}</dd>
              <dt className="text-slate-600">Keep-out zones</dt><dd>{robot.limits.keepOut.map((zone) => zone.name).join(", ") || "None"}</dd>
              <dt className="text-slate-600">A command is valid for</dt><dd>{robot.limits.commandTtlS} s</dd>
              <dt className="text-slate-600">Environment</dt><dd>{robot.limits.environment || "Not declared"}</dd>
            </dl>
            <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void act("limits", () => Robotics.update(robot.id, { limits: { ...(speed ? { maxLinearSpeed: Number(speed) } : {}), motionRequiresApproval: robot.limits.motionRequiresApproval } })); }}>
              <label className="text-sm text-slate-700">Lower the top speed to (m/s)<input className={`${input} mt-1 w-32`} type="number" step="0.05" min="0.05" max={robot.limits.maxLinearSpeed} value={speed} onChange={(event) => setSpeed(event.target.value)} placeholder={fixed(robot.limits.maxLinearSpeed)} /></label>
              <button type="submit" className={button} disabled={busy === "limits"}>Save</button>
              <label className="inline-flex items-center gap-1.5 text-sm text-slate-800"><input type="checkbox" checked={robot.limits.motionRequiresApproval} onChange={() => void act("limits", () => Robotics.update(robot.id, { limits: { ...(robot.safety.owner?.maxLinearSpeed !== undefined ? { maxLinearSpeed: robot.safety.owner.maxLinearSpeed } : {}), motionRequiresApproval: !robot.limits.motionRequiresApproval } }))} />Ask before every movement</label>
            </form>
            <p className="mt-1 text-xs text-slate-600">You can only tighten these. The robot enforces its own limits itself, with or without HANNAH. The permission level for all robots is under Actions → Permissions → Robots.</p>
          </div>
        </section>
      )}

      <DiagnosticsPanel robot={robot} />

      {robot.status === "enrolled" && !robot.simulated && <SimToRealPanel robot={robot} robots={robots} />}

      <section className={`${card} space-y-2`}>
        <h3 className="font-semibold text-slate-900">Device</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm text-slate-800">
          <dt className="text-slate-600">Device id</dt><dd className="font-mono text-xs">{robot.id}</dd>
          <dt className="text-slate-600">Fingerprint</dt><dd className="font-mono text-xs" data-testid="robot-fingerprint">{robot.fingerprint || "–"}</dd>
          <dt className="text-slate-600">Serial number</dt><dd>{robot.serialNumber || "not reported"}</dd>
          <dt className="text-slate-600">Configuration version</dt><dd>{robot.configVersion}</dd>
          <dt className="text-slate-600">Operating mode</dt><dd>{robot.simulated ? "Simulation" : "Physical hardware"}</dd>
          <dt className="text-slate-600">Type</dt><dd>{robot.robotType || "–"}{robot.category ? ` (${robot.category})` : ""}</dd>
          <dt className="text-slate-600">Computer</dt><dd>{[robot.compute, robot.os].filter(Boolean).join(", ") || "–"}</dd>
          <dt className="text-slate-600">ROS distribution</dt><dd>{robot.rosDistro || "none"}</dd>
          <dt className="text-slate-600">Software, firmware</dt><dd>{robot.softwareVersion || "–"}, {robot.firmwareVersion || "–"}</dd>
          <dt className="text-slate-600">HANNAH runtime</dt><dd>{robot.runtimeVersion || "–"}{robot.adapter ? ` (${robot.adapter} adapter)` : ""}</dd>
          <dt className="text-slate-600">Connection</dt><dd>{robot.network?.transport || "–"}{(robot.protocols || []).length ? `, ${(robot.protocols || []).join(", ")}` : ""}</dd>
          <dt className="text-slate-600">Actuators</dt><dd>{robot.actuators.map((item) => `${item.id} (${item.type})`).join(", ") || "–"}</dd>
          <dt className="text-slate-600">Owner</dt><dd>Your account</dd>
          <dt className="text-slate-600">Enrolled</dt><dd>{robot.enrolledAt ? new Date(robot.enrolledAt).toLocaleString() : "not yet"}</dd>
        </dl>
        {error && <Notice tone="rose">{error}</Notice>}
        {code && robot.enrollmentExpiresAt && robot.status === "enrolled" && <EnrollmentBox enrollment={code} robot={robot} />}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void act("code", async () => setCode(await Robotics.newCode(robot.id)))}>{robot.status === "enrolled" ? "Replace its secret (new code)" : "New enrollment code"}</button>
          {robot.status === "enrolled" && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Revoke ${robot.name}'s access? It will stop where it is and can't connect until it enrolls again.`)) void act("revoke", () => Robotics.revoke(robot.id)); }}>Revoke access</button>}
          <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Remove ${robot.name} and its mission history?`)) void act("remove", async () => { await Robotics.remove(robot.id); onGone(); }); }}><Trash2 className="h-4 w-4" aria-hidden="true" />Remove</button>
        </div>
      </section>
    </div>
  );
}

export default function RoboticsPage() {
  const [signedIn, setSignedIn] = useState(isAccountSession());
  const [robots, setRobots] = useState<Robot[] | null>(null);
  const [canEnroll, setCanEnroll] = useState(true);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [fleetOutcome, setFleetOutcome] = useState<{ text: string; tone: "slate" | "rose" } | null>(null);

  const refresh = useCallback(async () => {
    if (!isAccountSession()) return;
    try {
      const answer = await Robotics.list();
      setRobots(answer.robots); setCanEnroll(answer.canEnroll); setError("");
      setSelected((current) => (current && answer.robots.some((robot) => robot.id === current) ? current : answer.robots[0]?.id ?? null));
    } catch (reason) { setError(message(reason)); }
  }, []);
  useEffect(() => {
    const account = () => setSignedIn(isAccountSession());
    window.addEventListener(ACCOUNT_EVENT, account);
    return () => window.removeEventListener(ACCOUNT_EVENT, account);
  }, []);
  useEffect(() => {
    if (!signedIn) return undefined;
    void refresh();
    void Robotics.contract().then((contract) => setCapabilities(contract.capabilities)).catch(() => undefined);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => window.clearInterval(timer);
  }, [signedIn, refresh]);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6" data-testid="robotics-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900"><Bot className="h-6 w-6" aria-hidden="true" />Robots</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-700">Robots you enrolled, what each reports, and the missions HANNAH started on them. HANNAH sends a robot a goal; the robot's own planner and controller drive it inside the robot's own limits.</p>
        </div>
        {signedIn && <button type="button" className={primary} onClick={() => setAdding((value) => !value)} aria-expanded={adding}><Plus className="h-4 w-4" aria-hidden="true" />Add a robot</button>}
      </header>
      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950" role="note">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p><strong>Stop is not an emergency stop.</strong> It asks the robot's controller to stop, over the network. An emergency stop is a physical button wired into the robot. HANNAH is not safety-certified, and so far it has been run only with its own built-in simulator.</p>
      </div>
      {!signedIn && <Notice>Sign in to use robots. A robot belongs to an account, and every movement is recorded in that account's history.</Notice>}
      {error && <Notice tone="rose">{error}</Notice>}
      {signedIn && adding && <AddRobot canEnroll={canEnroll} onAdded={(created) => { setEnrollment(created); setSelected(created.robot.id); setAdding(false); void refresh(); }} />}
      {signedIn && robots && robots.length === 0 && !adding && (
        <div className={card}>
          <p className="font-medium text-slate-900">No robots yet.</p>
          <p className="mt-1 text-sm text-slate-700">Add one to get a one-time code, then start HANNAH's robot runtime with it. With no robot of your own, the runtime starts a built-in simulated differential-drive robot in a small room, so you can try a whole mission on this computer.</p>
        </div>
      )}
      {signedIn && robots && robots.length > 1 && <FleetPanel onSelect={setSelected} onAsked={(record, problem) => setFleetOutcome(record ? { text: record.outcome, tone: "slate" } : { text: problem || "That didn't work.", tone: "rose" })} />}
      {fleetOutcome && <div data-testid="fleet-outcome"><Notice tone={fleetOutcome.tone}>{fleetOutcome.text}</Notice></div>}
      {signedIn && robots && robots.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <ul className="space-y-2" aria-label="Registered robots">
            {robots.map((robot) => (
              <li key={robot.id}>
                <button type="button" onClick={() => { setSelected(robot.id); if (enrollment?.robot.id !== robot.id) setEnrollment(null); }} aria-pressed={selected === robot.id} data-testid="robot-card" data-connection={robot.connection}
                  className={`w-full rounded-2xl border p-3 text-left shadow-sm ${selected === robot.id ? "border-slate-900 bg-white" : "border-slate-200 bg-white hover:border-slate-400"}`}>
                  <span className="block font-semibold text-slate-900">{robot.name}</span>
                  <span className="mt-1 flex flex-wrap gap-1"><KindBadge robot={{ ...robot, simulator: null }} /><Chip tone={CONNECTION[robot.connection].tone}>{CONNECTION[robot.connection].label}</Chip></span>
                  <span className="mt-1 block text-xs text-slate-600">{robot.status === "enrolled" ? `${MODE[robot.mode] || robot.mode}${robot.online && robot.state?.battery ? ` · battery ${Math.round(robot.state.battery.percent)}%` : ""}` : robot.robotType || "Not enrolled yet"}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected && <RobotDetail key={selected} robotId={selected} enrollment={enrollment?.robot.id === selected ? enrollment : null} capabilities={capabilities} robots={robots || []} onGone={() => { setSelected(null); setEnrollment(null); void refresh(); }} />}
        </div>
      )}
      {signedIn && robots && robots.length > 0 && <AnalyticsPanel />}
    </main>
  );
}
