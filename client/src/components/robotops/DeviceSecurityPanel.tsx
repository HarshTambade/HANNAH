/**
 * Device identities: who is enrolled with a certificate from this account's
 * CA, who is quarantined, the policy for unknown devices and credentials, and
 * the security audit. Everything is the server's record (server/trust).
 */
import { useCallback, useEffect, useState } from "react";
import { RobotOps, type AuditEntry, type DeviceIdentity, type DevicePolicy } from "../../services/RobotOps";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");
const day = (at: number | null) => (at ? new Date(at).toLocaleString() : "–");
const STATUS: Record<DeviceIdentity["status"], string> = { pending: "Waiting to enroll", active: "Enrolled", quarantined: "Quarantined", revoked: "Revoked" };

export default function DeviceSecurityPanel() {
  const [identities, setIdentities] = useState<DeviceIdentity[] | null>(null);
  const [policy, setPolicy] = useState<DevicePolicy | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [draft, setDraft] = useState({ deviceId: "", kind: "robot", hardwareId: "" });
  const refresh = useCallback(async () => {
    try {
      const [listed, log] = await Promise.all([RobotOps.identities(), RobotOps.audit()]);
      setIdentities(listed.identities); setPolicy(listed.policy); setAudit(log.audit);
    } catch (error) { setProblem(message(error)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (task: () => Promise<unknown>) => { setProblem(null); try { await task(); await refresh(); } catch (error) { setProblem(message(error)); } };

  const quarantined = (identities || []).filter((item) => item.status === "quarantined");
  const known = (identities || []).filter((item) => item.status !== "quarantined");
  return (
    <section className={card} aria-labelledby="device-security-heading" data-testid="device-security-panel">
      <h2 id="device-security-heading" className="text-base font-semibold text-slate-900">Device identity and security</h2>
      <p className="mt-1 text-sm text-slate-700">Each device enrolls with its own key and gets a short-lived certificate from your account's authority. Devices nobody registered are kept out.</p>
      {problem && <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{problem}</p>}
      {quarantined.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3" data-testid="quarantine-list">
          <h3 className={heading}>Quarantined: seen without being registered</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {quarantined.map((item) => (
              <li key={item.deviceId} className="flex flex-wrap items-center justify-between gap-2">
                <span><strong>{item.deviceId}</strong> · {item.reason} · first seen {day(item.firstSeenAt)}</span>
                <button type="button" className={button} onClick={() => void run(() => RobotOps.dismissQuarantined(item.deviceId))}>Dismiss</button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-900">A quarantined device gets nothing. Register it below if you know it.</p>
        </div>
      )}
      <ul className="mt-3 space-y-1 text-sm" aria-label="Device identities">
        {known.map((item) => (
          <li key={item.deviceId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-2 py-1">
            <span><strong>{item.deviceId}</strong> ({item.kind}) · {STATUS[item.status]}{item.status === "active" ? ` · certificate ${item.certificate.state}, until ${day(item.certificate.notAfter)}` : ""}{item.hardwareId ? ` · hardware ${item.hardwareId}` : ""}</span>
            {item.status !== "revoked" && <button type="button" className={button} onClick={() => void run(() => RobotOps.revokeDevice(item.deviceId))}>Revoke</button>}
          </li>
        ))}
        {identities && known.length === 0 && <li className="text-slate-600">No device identities yet.</li>}
      </ul>
      <div className="mt-3 grid gap-2 md:grid-cols-4">
        <label className="text-xs text-slate-700">Device id<input className={input} value={draft.deviceId} onChange={(event) => setDraft({ ...draft, deviceId: event.target.value })} /></label>
        <label className="text-xs text-slate-700">Kind<select className={input} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>{["robot", "hub", "agv", "sensor", "controller", "gateway", "other"].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
        <label className="text-xs text-slate-700">Hardware id (optional)<input className={input} value={draft.hardwareId} onChange={(event) => setDraft({ ...draft, hardwareId: event.target.value })} /></label>
        <div className="flex items-end"><button type="button" className={button} disabled={!draft.deviceId} onClick={() => void run(async () => setCode((await RobotOps.registerDevice(draft.deviceId, draft.kind, draft.hardwareId || undefined)).enrollment.code))}>Register</button></div>
      </div>
      {code && <p role="status" className="mt-2 text-sm">One-time enrollment code (15 minutes): <code className="font-mono font-semibold">{code}</code></p>}
      {policy && (
        <div className="mt-4" data-testid="device-policy">
          <h3 className={heading}>Policy</h3>
          <div className="mt-1 grid gap-2 text-xs md:grid-cols-3">
            <label className="text-slate-700">Unknown devices<select className={input} value={policy.unknownDevices} onChange={(event) => void run(() => RobotOps.setPolicy({ unknownDevices: event.target.value as DevicePolicy["unknownDevices"] }))}><option value="quarantine">Quarantine for review</option><option value="reject">Reject</option></select></label>
            <label className="text-slate-700">Certificate lifetime (days)<input type="number" min={1} max={90} className={input} defaultValue={policy.certificateDays} onBlur={(event) => void run(() => RobotOps.setPolicy({ certificateDays: Number(event.target.value) }))} /></label>
            <label className="text-slate-700">Credential lifetime (minutes)<input type="number" min={1} max={60} className={input} defaultValue={policy.credentialMinutes} onBlur={(event) => void run(() => RobotOps.setPolicy({ credentialMinutes: Number(event.target.value) }))} /></label>
            <label className="text-slate-700">Robot secret expires after (days, empty: never)<input type="number" min={1} max={730} className={input} defaultValue={policy.robotSecretMaxAgeDays ?? ""} onBlur={(event) => void run(() => RobotOps.setPolicy({ robotSecretMaxAgeDays: event.target.value ? Number(event.target.value) : null }))} /></label>
            <label className="flex items-center gap-2 text-slate-700"><input type="checkbox" checked={policy.requireMtlsForRobotLink} onChange={(event) => void run(() => RobotOps.setPolicy({ requireMtlsForRobotLink: event.target.checked }))} />Robots must connect with mutual TLS (only on a server that terminates TLS itself)</label>
          </div>
        </div>
      )}
      {audit.length > 0 && (
        <div className="mt-4">
          <h3 className={heading}>Security audit</h3>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs text-slate-700" aria-label="Security audit">
            {audit.map((item) => <li key={item.id}><span className="text-slate-500">{day(item.at)}</span> · {item.kind} · <strong className={item.decision === "refused" || item.decision === "rejected" ? "text-rose-800" : ""}>{item.decision}</strong>{item.deviceId ? ` · ${item.deviceId}` : ""} · {item.reason}</li>)}
          </ul>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-500">DDS (ROS 2) stays on the robot and its private network; HANNAH never needs it exposed. Each robot's SROS 2 keystore and firewall policy can be generated from its profile.</p>
    </section>
  );
}
