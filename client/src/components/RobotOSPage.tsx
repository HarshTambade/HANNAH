/**
 * HANNAH Robot OS administration screen.
 *
 * Reads signed envelopes reported by onboard Robot OS instances through the
 * account-scoped bridge store. Nothing here commands a robot: motion still
 * goes through the Action Engine and the safety gateways.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiFetch, apiUrl } from "../services/api";
import { Operator } from "../services/Operator";
import DiagnosticsPanel from "./robotops/DiagnosticsPanel";

type EnvelopeView = {
  envelopeId: string;
  robotId: string;
  kind: string;
  tsMs: number;
  receivedAt: number;
  hasSignature: boolean;
  payload: Record<string, unknown>;
};

export type CommandView = {
  id: string;
  robotId: string;
  capability: string;
  status: string;
  ackReason: string;
  issuedAt: number;
  expiresAt: number;
};

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";

/** Pure helpers exported for tests. */
export function formatEnvelopeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";
  return new Date(ts).toLocaleString();
}

export type StageUpdateForm = { robot: string; version: string; artifact: string; sha256: string; signature: string; signer: string };

export function stageActionParams(form: StageUpdateForm) {
  return {
    robot: form.robot.trim(),
    version: form.version.trim(),
    artifact: form.artifact.trim(),
    sha256: form.sha256.trim(),
    signature: form.signature.trim(),
    signer: form.signer.trim(),
  };
}

export function rollbackActionParams(robot: string, reason: string) {
  return { robot: robot.trim(), reason: reason.trim() };
}

export function commandTone(status: string): string {
  if (status === "acked") return "text-emerald-700";
  if (status === "failed" || status === "expired") return "text-rose-700";
  if (status === "pending") return "text-amber-700";
  return "text-slate-700";
}

export function envelopeSummary(envelopes: EnvelopeView[]) {
  const byKind: Record<string, number> = {};
  let faults = 0;
  let unsigned = 0;
  for (const env of envelopes) {
    byKind[env.kind] = (byKind[env.kind] || 0) + 1;
    if (!env.hasSignature) unsigned += 1;
    const type = typeof env.payload.type === "string" ? env.payload.type.toLowerCase() : "";
    if (env.kind === "event" && /fault|estop|error/.test(type)) faults += 1;
  }
  return { total: envelopes.length, byKind, faults, unsigned };
}

export default function RobotOSPage() {
  const [envelopes, setEnvelopes] = useState<EnvelopeView[]>([]);
  const [commands, setCommands] = useState<CommandView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stageForm, setStageForm] = useState<StageUpdateForm>({ robot: "", version: "", artifact: "", sha256: "", signature: "", signer: "" });
  const [rollbackReason, setRollbackReason] = useState("");
  const [confirm, setConfirm] = useState<{ action: "robotos.stage_update" | "robotos.activate_update" | "robotos.rollback_update"; params: Record<string, unknown>; label: string } | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [envelopeResponse, commandResponse] = await Promise.all([
        apiFetch(apiUrl("/api/robots/os/envelopes?limit=100")),
        apiFetch(apiUrl("/api/robots/os/commands?limit=50")),
      ]);
      if (!envelopeResponse.ok) throw new Error(`Server answered ${envelopeResponse.status}.`);
      const data = await envelopeResponse.json();
      setEnvelopes(Array.isArray(data?.envelopes) ? data.envelopes : []);
      if (commandResponse.ok) {
        const commandData = await commandResponse.json();
        setCommands(Array.isArray(commandData?.commands) ? commandData.commands : []);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't load Robot OS status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = envelopeSummary(envelopes);

  async function runConfirmed() {
    if (!confirm) return;
    setBusy(true);
    setActionMessage("");
    try {
      const record = await Operator.run(confirm.action, confirm.params, { request: confirm.label });
      setActionMessage(record.status === "waiting-approval" ? "A signed-in person must approve this before anything is sent to the robot." : `Action ${record.status}: nothing is applied until the robot confirms it.`);
      void load();
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "Couldn't queue the action.");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-10 pt-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">HANNAH Robot OS</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Onboard operating environment status. Reports arrive signed from each robot; this screen never drives motors directly.
          </p>
        </div>
        <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </header>

      {error ? <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{error}</p> : null}

      <DiagnosticsPanel />

      <section className="mb-4 grid gap-3 sm:grid-cols-4">
        <div className={card}><p className={heading}>Envelopes</p><p className="mt-1 text-2xl font-semibold text-slate-900">{summary.total}</p></div>
        <div className={card}><p className={heading}>Telemetry</p><p className="mt-1 text-2xl font-semibold text-slate-900">{summary.byKind.telemetry || 0}</p></div>
        <div className={card}><p className={heading}>Fault events</p><p className="mt-1 text-2xl font-semibold text-rose-700">{summary.faults}</p></div>
        <div className={card}><p className={heading}>Unsigned</p><p className="mt-1 text-2xl font-semibold text-slate-900">{summary.unsigned}</p></div>
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Recent reports</h2>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {!loading && envelopes.length === 0 ? (
          <p className="text-sm text-slate-600">No Robot OS envelopes yet. The bridge is opt-in: enable it on the server and enroll a robot key before reports appear.</p>
        ) : null}
        {!loading && envelopes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-slate-500"><tr><th className="pb-2">Time</th><th className="pb-2">Robot</th><th className="pb-2">Kind</th><th className="pb-2">Payload</th><th className="pb-2">Signed</th></tr></thead>
              <tbody>
                {envelopes.slice(0, 50).map((env) => (
                  <tr key={env.envelopeId} className="border-t border-slate-100">
                    <td className="py-2 pr-3 text-slate-700">{formatEnvelopeTime(env.tsMs)}</td>
                    <td className="py-2 pr-3 text-slate-700">{env.robotId}</td>
                    <td className="py-2 pr-3 text-slate-700">{env.kind}</td>
                    <td className="py-2 pr-3 text-slate-500">{JSON.stringify(env.payload).slice(0, 160)}</td>
                    <td className="py-2 text-slate-700">{env.hasSignature ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className={`${card} mt-4`}>
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Command audit</h2>
        {!loading && commands.length === 0 ? <p className="text-sm text-slate-600">No Robot OS commands have been queued for this account.</p> : null}
        {!loading && commands.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-slate-500"><tr><th className="pb-2">Issued</th><th className="pb-2">Robot</th><th className="pb-2">Capability</th><th className="pb-2">Status</th><th className="pb-2">Robot's answer</th></tr></thead>
              <tbody>
                {commands.slice(0, 50).map((command) => (
                  <tr key={command.id} className="border-t border-slate-100">
                    <td className="py-2 pr-3 text-slate-700">{formatEnvelopeTime(command.issuedAt)}</td>
                    <td className="py-2 pr-3 text-slate-700">{command.robotId}</td>
                    <td className="py-2 pr-3 text-slate-700">{command.capability}</td>
                    <td className={`py-2 pr-3 font-medium ${commandTone(command.status)}`}>{command.status}</td>
                    <td className="py-2 text-slate-600">{command.ackReason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className={`${card} mt-4`}>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Commissioning & safety</h2>
        <p className="text-sm text-slate-600">
          Physical checkout is recorded in HANNAH_ROBOT_OS's commissioning checklist and must be signed by a qualified operator.
          A software stop is not an emergency stop; HANNAH is not safety-certified. Robot OS only accepts commands that pass the
          local safety gateway, motor limits and command expiry.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Administration (needs approval)</h2>
        <p className="mb-3 text-sm text-slate-600">Nothing here flashes firmware directly. Each button creates an action that a signed-in person must approve; the robot verifies the signed command before applying it.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 p-3">
            <h3 className="mb-2 text-sm font-medium text-slate-800">Stage a signed update</h3>
            <div className="grid gap-2">
              {(["robot", "version", "artifact", "sha256", "signature", "signer"] as const).map((key) => (
                <label key={key} className="text-xs text-slate-600">
                  {key}
                  <input
                    className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900"
                    value={stageForm[key]}
                    onChange={(event) => setStageForm((current) => ({ ...current, [key]: event.target.value }))}
                  />
                </label>
              ))}
              <button type="button" className="mt-1 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !stageActionParams(stageForm).version} onClick={() => setConfirm({ action: "robotos.stage_update", params: stageActionParams(stageForm), label: "Stage a Robot OS update" })}>
                Review update
              </button>
              <button type="button" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 disabled:opacity-50" disabled={busy || !stageForm.robot.trim() || !stageForm.version.trim()} onClick={() => setConfirm({ action: "robotos.activate_update", params: { robot: stageForm.robot.trim(), version: stageForm.version.trim() }, label: "Activate staged Robot OS update" })}>
                Review activation
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <h3 className="mb-2 text-sm font-medium text-slate-800">Roll back to last good slot</h3>
            <label className="text-xs text-slate-600">
              Robot name or id
              <input className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900" value={stageForm.robot} onChange={(event) => setStageForm((current) => ({ ...current, robot: event.target.value }))} />
            </label>
            <label className="mt-2 block text-xs text-slate-600">
              Why
              <input className="mt-0.5 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900" value={rollbackReason} onChange={(event) => setRollbackReason(event.target.value)} />
            </label>
            <button type="button" className="mt-3 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-900 disabled:opacity-50" disabled={busy || !stageForm.robot.trim() || !rollbackReason.trim()} onClick={() => setConfirm({ action: "robotos.rollback_update", params: rollbackActionParams(stageForm.robot, rollbackReason), label: "Roll back Robot OS" })}>
              Review rollback
            </button>
          </div>
        </div>
        {actionMessage ? <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800" role="status">{actionMessage}</p> : null}
      </section>

      {confirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">Confirm: {confirm.label}</h2>
            <p className="mt-2 text-sm text-slate-600">This queues a signed command. A signed-in person must approve it in Actions before the robot receives anything.</p>
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-100 p-2 text-xs text-slate-800">{JSON.stringify(confirm.params, null, 2)}</pre>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void runConfirmed()}>Create action</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
