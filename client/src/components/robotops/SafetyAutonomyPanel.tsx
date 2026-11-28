/**
 * Operating mode, safety profile and autonomy policy for one robot, with the
 * safety audit. Every value is the server's record; every button is a real
 * request that the server checks against the transition table and the
 * robot's condition (server/robotics/safety_manager.js).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, OctagonX, ShieldCheck } from "lucide-react";
import { RobotSafety, type AutonomyView, type ModeId, type PolicyId, type SafetyProfile } from "../../services/RobotSafety";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const danger = "inline-flex items-center gap-1.5 rounded-lg bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800 disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const when = (at: number) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Notice({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "rose" | "amber" }) {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-700", rose: "border-rose-200 bg-rose-50 text-rose-800", amber: "border-amber-200 bg-amber-50 text-amber-900" };
  return <p role={tone === "rose" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

const numberOrUndefined = (text: string) => (text.trim() === "" ? undefined : Number(text));
const list = (text: string) => text.split(",").map((item) => item.trim()).filter(Boolean);

export function SafetyAutonomyPanel({ robotId, canChange }: { robotId: string; canChange: boolean }) {
  const [view, setView] = useState<AutonomyView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState({ maxLinearSpeed: "", minBatteryPercent: "", commsTimeoutS: "", restricted: "", approveMotion: false, area: "" });
  const [policy, setPolicy] = useState<{ id: PolicyId; missions: string }>({ id: "approved_low_risk", missions: "" });

  const load = useCallback(async () => {
    try {
      const next = await RobotSafety.autonomy(robotId);
      setView(next);
      setError("");
      return next;
    } catch (reason_) { setError(message(reason_)); return null; }
  }, [robotId]);
  useEffect(() => {
    void load().then((next) => {
      if (!next) return;
      const profile = next.profile || {};
      setDraft({ maxLinearSpeed: profile.maxLinearSpeed?.toString() ?? "", minBatteryPercent: profile.minBatteryPercent?.toString() ?? "", commsTimeoutS: profile.commsTimeoutS?.toString() ?? "", restricted: (profile.restrictedDestinations || []).join(", "), approveMotion: profile.approval?.motion === "always", area: profile.operatingArea ? JSON.stringify(profile.operatingArea.polygon) : "" });
      setPolicy({ id: next.policy.account?.policy || next.policy.default, missions: (next.policy.account?.missions || []).join(", ") });
    });
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label); setError("");
    try { await run(); await load(); } catch (reason_) { setError(message(reason_)); } finally { setBusy(""); }
  };
  if (!view) return <section className={card}>{error ? <Notice tone="rose">{error}</Notice> : <p className="text-sm text-slate-600"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" aria-hidden="true" />Loading the operating mode…</p>}</section>;

  const saveProfile = () => {
    let area: number[][] | undefined;
    if (draft.area.trim()) {
      try { area = JSON.parse(draft.area) as number[][]; } catch { setError("The operating area must be a list of [x, y] points, like [[-2,-2],[2,-2],[2,2],[-2,2]]."); return; }
    }
    const profile: SafetyProfile = {
      ...(view.profile || {}),
      maxLinearSpeed: numberOrUndefined(draft.maxLinearSpeed), minBatteryPercent: numberOrUndefined(draft.minBatteryPercent), commsTimeoutS: numberOrUndefined(draft.commsTimeoutS),
      restrictedDestinations: list(draft.restricted), approval: { motion: draft.approveMotion ? "always" : "policy", capabilities: view.profile?.approval?.capabilities || [] },
      operatingArea: area ? { name: view.profile?.operatingArea?.name || "operating area", polygon: area } : undefined,
    };
    void act("profile", () => RobotSafety.setProfile(robotId, JSON.parse(JSON.stringify(profile)) as SafetyProfile));
  };
  const hardware = view.hardwareLimits as Record<string, number | undefined>;

  return (
    <section className={`${card} space-y-3`} data-testid="safety-autonomy" data-mode={view.mode}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 font-semibold text-slate-900"><ShieldCheck className="h-4 w-4" aria-hidden="true" />Operating mode and safety</h3>
          <p className="text-sm text-slate-700"><span className="font-medium" data-testid="operating-mode">{view.label}</span>{" — "}{view.description}</p>
          <p className="text-xs text-slate-600" data-testid="mode-confirmed">{view.confirmed ? "The robot confirmed this mode." : view.reported?.refusedSeq ? `The robot refused the change: ${view.reported.refusedReason || "no reason given"}. It is still in ${view.reported.mode}.` : "Waiting for the robot to confirm this mode."}{view.teleop ? ` ${view.teleop.operator} holds manual control.` : ""}</p>
        </div>
        <button type="button" className={danger} disabled={busy === "safety_stop" || view.mode === "safety_stop"} onClick={() => void act("safety_stop", () => RobotSafety.setMode(robotId, "safety_stop", reason || "Safety Stop pressed"))} data-testid="safety-stop"><OctagonX className="h-4 w-4" aria-hidden="true" />Safety Stop</button>
      </div>
      <Notice tone="amber">{view.disclaimer} {view.estop.note}{view.estop.engaged ? " The emergency stop is engaged now." : ""}</Notice>
      {error && <Notice tone="rose">{error}</Notice>}

      <div>
        <p className={heading}>Change to</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {view.transitions.map((item) => (
            <span key={item.to} className="inline-flex flex-col">
              <button type="button" className={button} disabled={!canChange || !item.allowed || Boolean(busy)} title={item.reasons.map((problem) => problem.message).join(" ")} onClick={() => void act(item.to, () => RobotSafety.setMode(robotId, item.to as ModeId, reason))} data-testid={`mode-${item.to}`}>{item.label}</button>
              {!item.allowed && <span className="max-w-[14rem] text-[11px] text-slate-500">{item.reasons[0]?.message}</span>}
            </span>
          ))}
        </div>
        <label className="mt-2 block text-sm text-slate-700">Reason (kept in the audit)<input className={`${input} mt-1 w-full`} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        {!canChange && <p className="mt-1 text-xs text-slate-600">Only a person signed in to the app can change modes, except Safety Stop.</p>}
      </div>

      <div>
        <p className={heading}>Safety profile (can only tighten the robot's own limits)</p>
        <form className="mt-1 grid gap-2 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); saveProfile(); }}>
          <label className="text-sm text-slate-700">Top speed, m/s (robot: {hardware.maxLinearSpeed ?? "–"})<input className={`${input} mt-1 w-full`} type="number" step="0.05" value={draft.maxLinearSpeed} onChange={(event) => setDraft({ ...draft, maxLinearSpeed: event.target.value })} /></label>
          <label className="text-sm text-slate-700">Minimum battery, % (robot: {hardware.minBatteryPercent ?? "–"})<input className={`${input} mt-1 w-full`} type="number" value={draft.minBatteryPercent} onChange={(event) => setDraft({ ...draft, minBatteryPercent: event.target.value })} /></label>
          <label className="text-sm text-slate-700">Stop after this long without HANNAH, s (robot: {hardware.linkTimeoutS ?? "–"})<input className={`${input} mt-1 w-full`} type="number" value={draft.commsTimeoutS} onChange={(event) => setDraft({ ...draft, commsTimeoutS: event.target.value })} /></label>
          <label className="text-sm text-slate-700">Restricted destinations (comma-separated)<input className={`${input} mt-1 w-full`} value={draft.restricted} onChange={(event) => setDraft({ ...draft, restricted: event.target.value })} /></label>
          <label className="text-sm text-slate-700 sm:col-span-2">Operating area, [x, y] points in metres<input className={`${input} mt-1 w-full font-mono`} value={draft.area} placeholder="[[-2,-2],[2,-2],[2,2],[-2,2]]" onChange={(event) => setDraft({ ...draft, area: event.target.value })} /></label>
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-800"><input type="checkbox" checked={draft.approveMotion} onChange={(event) => setDraft({ ...draft, approveMotion: event.target.checked })} />Ask before every movement</label>
          <span><button type="submit" className={button} disabled={!canChange || busy === "profile"}>Save profile</button></span>
        </form>
      </div>

      <div>
        <p className={heading}>Autonomy policy for your account</p>
        <p className="text-sm text-slate-700" data-testid="effective-policy">In force: {view.policy.policies[view.policy.effective.policy].label}{view.policy.effective.sources.some((source) => source.scope === "team") ? ` (strictest of yours and your teams': ${view.policy.effective.sources.map((source) => `${source.name || source.scope}: ${view.policy.policies[source.policy]?.label}`).join(", ")})` : ""}. {view.policy.note}</p>
        <div className="mt-1 flex flex-wrap items-end gap-2">
          <select className={input} aria-label="Autonomy policy" value={policy.id} onChange={(event) => setPolicy({ ...policy, id: event.target.value as PolicyId })}>
            {Object.entries(view.policy.policies).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
          </select>
          {policy.id === "approved_missions" && <input className={input} aria-label="Approved missions" placeholder="navigate_to:dock, return_to_dock" value={policy.missions} onChange={(event) => setPolicy({ ...policy, missions: event.target.value })} />}
          <button type="button" className={button} disabled={!canChange || busy === "policy"} onClick={() => void act("policy", () => RobotSafety.setPolicy(policy.id, list(policy.missions)))}>Save policy</button>
        </div>
        <p className="mt-1 text-xs text-slate-600">{view.policy.policies[policy.id].description}</p>
      </div>

      <div>
        <p className={heading}>Safety audit</p>
        {view.audit.length === 0 ? <p className="text-sm text-slate-600">No changes yet.</p> : (
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto text-sm" data-testid="safety-audit">
            {view.audit.map((entry) => <li key={entry.id} className="text-slate-800"><span className="text-slate-500">{when(entry.at)} · {entry.kind} · {entry.actor} · </span>{entry.summary}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

export default SafetyAutonomyPanel;
