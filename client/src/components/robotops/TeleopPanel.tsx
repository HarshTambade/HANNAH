/**
 * Teleoperation and rescue: the handoff, then manual control by keyboard,
 * mouse or touch (the on-screen pad) or a gamepad, with the deadman, latency
 * and telemetry freshness in view.
 *
 * The robot moves only while the deadman is held here AND fresh commands reach
 * it: it holds by itself when input stops, the link drops or the session ends
 * (robotics/runtime). This is not an emergency stop; the robot's own stays
 * the way to stop it in danger.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CheckCircle2, Circle, Gamepad2, Loader2, XCircle } from "lucide-react";
import { RobotOps, createTeleopSender, velocityFromGamepad, velocityFromKeys, velocityFromPad, type TeleopView, type Velocity } from "../../services/RobotOps";
import type { Robot } from "../../services/Robotics";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const ms = (value: number | null | undefined) => (typeof value === "number" ? `${Math.round(value)} ms` : "–");
const RATE_MS = 100;
const DRIVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D", " "]);

function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "rose" | "amber" }) {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-700", rose: "border-rose-200 bg-rose-50 text-rose-800", amber: "border-amber-200 bg-amber-50 text-amber-900" };
  return <p role={tone === "rose" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

export function TeleopPanel({ robot, canOperate }: { robot: Robot; canOperate: boolean }) {
  const [view, setView] = useState<TeleopView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fingerprint, setFingerprint] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [sending, setSending] = useState<Velocity & { deadman: boolean; source: string }>({ linear: 0, angular: 0, deadman: false, source: "" });
  const [rtt, setRtt] = useState<number | null>(null);
  const [gamepad, setGamepad] = useState<string | null>(null);
  const keys = useRef(new Set<string>());
  const pad = useRef<{ x: number; y: number; down: boolean }>({ x: 0, y: 0, down: false });
  const sender = useRef<ReturnType<typeof createTeleopSender> | null>(null);

  const load = useCallback(async () => {
    try { setView(await RobotOps.teleop(robot.id)); setError(""); } catch (reason) { setError(message(reason)); }
  }, [robot.id]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 1000);
    return () => window.clearInterval(timer);
  }, [load]);

  const session = view?.session && view.session.status !== "ended" ? view.session : null;
  const mine = Boolean(session && token);
  const limits = session?.limits || view?.limits || { deadmanMs: 500, commandTtlMs: 400 };

  // The input loop: ten times a second, while this screen holds the session.
  useEffect(() => {
    if (!session || !token || session.status !== "active") { sender.current = null; return undefined; }
    const current = createTeleopSender((command) => RobotOps.command(robot.id, session.id, { token, ...command }));
    sender.current = current;
    const timer = window.setInterval(() => {
      let deadman = false;
      let velocity: Velocity = { linear: 0, angular: 0 };
      let source = "";
      const pads = typeof navigator !== "undefined" && navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      const first = pads[0];
      setGamepad(first ? first.id : null);
      if (first) {
        const read = velocityFromGamepad(first.axes, first.buttons, limits);
        if (read.deadman) { deadman = true; velocity = read.velocity; source = "gamepad"; }
      }
      if (!deadman && pad.current.down) { deadman = true; velocity = velocityFromPad(pad.current.x, pad.current.y, limits); source = "pad"; }
      if (!deadman && keys.current.has(" ")) { deadman = true; velocity = velocityFromKeys(keys.current, limits); source = "keyboard"; }
      setSending({ ...velocity, deadman, source });
      void current.tick(deadman, velocity).then(() => setRtt(current.stats.lastRttMs));
    }, RATE_MS);
    return () => window.clearInterval(timer);
  }, [session?.id, session?.status, token, robot.id, limits.maxLinearSpeed, limits.maxAngularSpeed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mine) return undefined;
    const down = (event: KeyboardEvent) => { if (DRIVE_KEYS.has(event.key)) { keys.current.add(event.key); event.preventDefault(); } };
    const up = (event: KeyboardEvent) => { keys.current.delete(event.key); };
    const clear = () => { keys.current.clear(); pad.current.down = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", clear); document.removeEventListener("visibilitychange", clear); clear(); };
  }, [mine]);

  const start = async () => {
    setBusy(true); setError("");
    try {
      const started = await RobotOps.startTeleop(robot.id, { robotId: robot.id, ...(robot.simulated ? {} : { fingerprint }) });
      setToken(started.token);
      setView(started);
    } catch (reason) {
      setError(message(reason));
      await load();
    } finally { setBusy(false); }
  };
  const end = async () => {
    if (!session) return;
    setBusy(true);
    try { setView(await RobotOps.endTeleop(robot.id, session.id)); setToken(null); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const padMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    pad.current.x = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
    pad.current.y = Math.max(-1, Math.min(1, 1 - ((event.clientY - box.top) / box.height) * 2));
  };

  if (!view) return <section className={card}>{error ? <Notice tone="rose">{error}</Notice> : <p className="text-sm text-slate-600"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" />Loading manual control…</p>}</section>;
  const steps = session?.steps || view.session?.steps || view.steps.map((step) => ({ ...step, ok: null as boolean | null, detail: undefined as string | undefined }));
  const link = session?.link;
  const stale = (link?.telemetryAgeS ?? 99) > 2;

  return (
    <section className={`${card} space-y-3`} data-testid="teleop" data-status={session?.status || "none"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 font-semibold text-slate-900"><Gamepad2 className="h-4 w-4" aria-hidden="true" />Manual control (teleoperation)</h3>
          <p className="text-sm text-slate-700">{session ? `${session.operator} holds manual control (${session.status === "active" ? "active" : "waiting for the robot to confirm"}).` : view.session?.endReason ? `The last session ended: ${view.session.endReason}.` : "Nobody holds manual control."} {robot.simulated ? "This is a SIMULATED robot." : "This is a PHYSICAL robot."}</p>
        </div>
        {session && <button type="button" className={button} disabled={busy} onClick={() => void end()} data-testid="teleop-end">End manual control</button>}
      </div>
      <Notice tone="amber">Manual control is a software link. The robot stops by itself when your input stops, the link drops or the session ends; it is not an emergency stop. Keep the robot's own emergency stop in reach.</Notice>
      {error && <Notice tone="rose">{error}</Notice>}

      {!session && (
        <div className="space-y-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-800"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} data-testid="teleop-confirm" />I can see {robot.name} ({robot.id}) and its surroundings{robot.simulated ? " in the simulator" : ""}.</label>
          {!robot.simulated && <label className="block text-sm text-slate-700">Key fingerprint shown on the robot<input className={`${input} mt-1 w-full font-mono`} value={fingerprint} onChange={(event) => setFingerprint(event.target.value)} placeholder="XXXX XXXX XXXX XXXX" /></label>}
          <button type="button" className={primary} disabled={!canOperate || !confirmed || busy} onClick={() => void start()} data-testid="teleop-start">Take manual control</button>
          {!canOperate && <p className="text-xs text-slate-600">Only a person signed in to the app can hold manual control.</p>}
        </div>
      )}

      <ol className="grid gap-1 text-sm sm:grid-cols-2" data-testid="teleop-steps">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-1.5" data-step={step.id} data-ok={String(step.ok)}>
            {step.ok === true ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" aria-hidden="true" /> : step.ok === false ? <XCircle className="mt-0.5 h-4 w-4 text-rose-700" aria-hidden="true" /> : <Circle className="mt-0.5 h-4 w-4 text-slate-400" aria-hidden="true" />}
            <span><span className="font-medium text-slate-900">{step.title}</span>{step.detail ? <span className="block text-xs text-slate-600">{step.detail}</span> : null}</span>
          </li>
        ))}
      </ol>

      {session && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <p className={heading}>Drive</p>
            <div
              role="application" aria-label="On-screen drive pad: press and hold, then move to drive" data-testid="teleop-pad"
              className={`relative h-44 w-full touch-none select-none rounded-xl border ${mine && session.status === "active" ? "border-slate-400 bg-slate-50" : "border-slate-200 bg-slate-100 opacity-60"}`}
              onPointerDown={(event) => { if (!mine) return; event.currentTarget.setPointerCapture(event.pointerId); pad.current.down = true; padMove(event); }}
              onPointerMove={(event) => { if (pad.current.down) padMove(event); }}
              onPointerUp={() => { pad.current.down = false; }} onPointerCancel={() => { pad.current.down = false; }} onLostPointerCapture={() => { pad.current.down = false; }}
            >
              <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-500" />
              <span className="absolute bottom-1 left-2 text-[11px] text-slate-500">Hold to drive · let go to stop</span>
            </div>
            <p className="text-xs text-slate-600">Keyboard: hold Space (the deadman) and use the arrow keys or WASD. Gamepad: hold LB or A and use the left stick. {gamepad ? `Gamepad: ${gamepad}.` : "No gamepad connected."}</p>
            {!mine && <p className="text-xs text-slate-600">This session belongs to another screen. Only that screen can drive.</p>}
          </div>
          <div className="space-y-2">
            <p className={heading}>Link and freshness</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm text-slate-800" data-testid="teleop-link">
              <dt className="text-slate-600">Sending</dt><dd data-testid="teleop-sending">{sending.deadman ? `${sending.linear.toFixed(2)} m/s, ${sending.angular.toFixed(2)} rad/s (${sending.source})` : "nothing (deadman released)"}</dd>
              <dt className="text-slate-600">This screen → server</dt><dd>{ms(rtt)} round trip</dd>
              <dt className="text-slate-600">Server → robot</dt><dd>{ms(link?.serverToRobotMs)}</dd>
              <dt className="text-slate-600">Robot applied</dt><dd data-testid="teleop-applied">{link?.robotApplied ? `${link.robotApplied.linear.toFixed(2)} m/s, ${link.robotApplied.angular.toFixed(2)} rad/s${link.robotApplied.holding ? `, holding${link.robotApplied.reason ? `: ${link.robotApplied.reason}` : ""}` : ""}` : "not yet"}</dd>
              <dt className="text-slate-600">Telemetry</dt><dd className={stale ? "text-rose-700" : ""}>{link?.telemetryAgeS !== null && link?.telemetryAgeS !== undefined ? `${link.telemetryAgeS.toFixed(1)} s old${stale ? " — stale, don't drive by it" : ""}` : "none"}</dd>
              <dt className="text-slate-600">Limits</dt><dd>{limits.maxLinearSpeed ?? "–"} m/s, {limits.maxAngularSpeed ?? "–"} rad/s; holds after {limits.deadmanMs} ms without input</dd>
              <dt className="text-slate-600">Camera</dt><dd data-testid="teleop-video">{session.video.available ? "live" : `No camera stream. ${session.video.reason}`}</dd>
            </dl>
            {robot.state?.pose && <p className="text-xs text-slate-600">Position ({robot.state.pose.x.toFixed(2)}, {robot.state.pose.y.toFixed(2)}) m · speed {(robot.state.velocity?.linear ?? 0).toFixed(2)} m/s · emergency stop {robot.state.estop?.engaged ? "ENGAGED" : "released"} · nearest lidar return {typeof robot.state.sensors?.lidar?.minRange === "number" ? `${robot.state.sensors.lidar.minRange.toFixed(2)} m` : "–"}</p>}
          </div>
        </div>
      )}
    </section>
  );
}

export default TeleopPanel;
