/**
 * Update packages and staged rollouts (PART 10), and firmware operations.
 *
 * - Publisher keys are pinned to the account; a package is accepted only when
 *   signed by one of them.
 * - Each package is validated for every robot (signature, publisher,
 *   compatibility, dependencies, tests, configuration, backup, rollback).
 * - A rollout goes in waves to robots you pick, never all at once by default;
 *   each wave needs your approval, and a failed health check rolls that robot
 *   back and halts the rollout.
 * - Firmware is a separate operation; flashing a physical robot has no driver
 *   in HANNAH and is shown as BLOCKED_EXTERNAL_DEPENDENCY.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, PackageCheck, RefreshCw } from "lucide-react";
import { RobotOps, WAVE_STAGES, pickedWaves, toneOf, type FirmwareOp, type PublisherKey, type Rollout, type RobotValidation, type UpdatePackage } from "../../services/RobotOps";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";
const input = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const WAVE_TITLES: Record<string, string> = { development: "Development robot", test: "Test robot", limited: "Limited group", selected: "Selected fleet", wider: "Wider fleet" };

export default function UpdatesPanel() {
  const [keys, setKeys] = useState<PublisherKey[]>([]);
  const [packages, setPackages] = useState<UpdatePackage[]>([]);
  const [rollouts, setRollouts] = useState<Rollout[]>([]);
  const [firmware, setFirmware] = useState<FirmwareOp[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [validation, setValidation] = useState<RobotValidation[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [keyForm, setKeyForm] = useState({ owner: "", publicKey: "" });
  const [manifestText, setManifestText] = useState("");
  const [confirm, setConfirm] = useState<Record<string, { name: string; serial: string }>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "rose" | "slate" } | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, p, r, f] = await Promise.all([RobotOps.keys(), RobotOps.packages(), RobotOps.rollouts(), RobotOps.firmwareOps()]);
      setKeys(k); setPackages(p); setRollouts(r); setFirmware(f);
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "Couldn't load updates.", tone: "rose" });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!selected) { setValidation([]); return; }
    RobotOps.validatePackage(selected).then((result) => setValidation(result.robots)).catch(() => setValidation([]));
  }, [selected]);

  const act = async (label: string, run: () => Promise<unknown>, done = "Done.") => {
    setBusy(label);
    setMessage(null);
    try {
      await run();
      setMessage({ text: done, tone: "slate" });
      await load();
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "That didn't work.", tone: "rose" });
    } finally {
      setBusy("");
    }
  };
  const parseManifest = () => { try { return JSON.parse(manifestText); } catch { throw new Error("That isn't valid JSON. Paste the signed hannah-update.json."); } };

  return (
    <section className={`${card} mt-4 space-y-4`} data-testid="updates-panel">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><PackageCheck className="h-4 w-4" /> Update packages and staged rollouts</h2>
        <button type="button" className={button} onClick={() => void load()}><RefreshCw className="h-4 w-4" />Refresh</button>
      </div>
      {message && <p className={`rounded-lg border px-3 py-2 text-sm ${message.tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-slate-200 bg-slate-50 text-slate-800"}`} role="status">{message.text}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 p-3">
          <p className={heading}>Publisher keys pinned to your account</p>
          {keys.length === 0 && <p className="mt-1 text-sm text-slate-600">None yet. A package is accepted only when signed by a key pinned here.</p>}
          <ul className="mt-1 space-y-1 text-sm">{keys.map((key) => <li key={key.keyId} className="flex items-center justify-between gap-2"><span>{key.owner} <span className="font-mono text-xs text-slate-500">{key.keyId}</span>{key.revokedAt ? <span className="ml-1 text-xs text-rose-700">revoked</span> : null}</span>{!key.revokedAt && <button type="button" className="text-xs text-rose-700 underline" onClick={() => void act("revoke", () => RobotOps.revokeKey(key.keyId), "Key revoked.")}>Revoke</button>}</li>)}</ul>
          <form className="mt-2 grid gap-2" onSubmit={(event) => { event.preventDefault(); void act("key", () => RobotOps.addKey(keyForm.owner, keyForm.publicKey), "Key pinned."); }}>
            <input className={input} placeholder="Publisher (as their manifests name it)" value={keyForm.owner} onChange={(event) => setKeyForm({ ...keyForm, owner: event.target.value })} />
            <textarea className={`${input} h-20 font-mono text-xs`} placeholder="-----BEGIN PUBLIC KEY-----" value={keyForm.publicKey} onChange={(event) => setKeyForm({ ...keyForm, publicKey: event.target.value })} />
            <button type="submit" className={button} disabled={busy === "key" || !keyForm.owner || !keyForm.publicKey}>Pin key</button>
          </form>
        </div>
        <div className="rounded-xl border border-slate-200 p-3">
          <p className={heading}>Add a signed package</p>
          <p className="mt-1 text-xs text-slate-600">Build and sign it with <code>node server/scripts/robot-update.js sign</code>, then paste its hannah-update.json.</p>
          <textarea className={`${input} mt-2 h-28 w-full font-mono text-xs`} value={manifestText} onChange={(event) => setManifestText(event.target.value)} placeholder='{"schema": "hannah-update/1", …}' />
          <button type="button" className={`${button} mt-2`} disabled={busy === "upload" || !manifestText.trim()} onClick={() => void act("upload", () => RobotOps.uploadPackage(parseManifest()), "Package accepted: the signature and publisher verified.")}>Check and add</button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 p-3">
        <p className={heading}>Packages</p>
        {packages.length === 0 && <p className="mt-1 text-sm text-slate-600">No packages yet.</p>}
        <div className="mt-1 flex flex-wrap gap-2">{packages.map((pkg) => <button key={pkg.id} type="button" className={`${button} ${selected === pkg.id ? "border-slate-900" : ""}`} onClick={() => { setSelected(pkg.id); setChoice({}); }}>{pkg.packageId} {pkg.version} <span className="text-xs text-slate-500">({pkg.kind})</span></button>)}</div>
        {selected && (
          <div className="mt-3 space-y-2">
            {validation.map((item) => (
              <div key={item.robotId} className="rounded-lg border border-slate-100 p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{item.robotName}{item.simulated ? " (simulated)" : ""} · <span className={item.ok ? "text-emerald-700" : "text-rose-700"}>{item.ok ? "eligible" : "not eligible"}</span></span>
                  {item.ok && <select className={input} value={choice[item.robotId] || ""} onChange={(event) => setChoice({ ...choice, [item.robotId]: event.target.value })}><option value="">Not in this rollout</option>{WAVE_STAGES.map((stage) => <option key={stage} value={stage}>{WAVE_TITLES[stage]}</option>)}</select>}
                </div>
                <ul className="mt-1 grid gap-0.5 text-xs sm:grid-cols-2">{item.checks.map((check) => <li key={check.id} className={check.ok ? "text-slate-600" : check.pending ? "text-amber-700" : "text-rose-700"}>{check.ok ? "✓" : check.pending ? "…" : "✗"} {check.id}: {check.detail}</li>)}</ul>
              </div>
            ))}
            <button type="button" className={primary} disabled={busy === "plan" || !Object.values(choice).some(Boolean)} onClick={() => void act("plan", () => RobotOps.createRollout(selected, pickedWaves(choice)), "Rollout planned. Approve its first wave to start.")}>Plan rollout</button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 p-3">
        <p className={heading}>Rollouts</p>
        {rollouts.length === 0 && <p className="mt-1 text-sm text-slate-600">No rollouts yet.</p>}
        {rollouts.map((item) => (
          <div key={item.id} className="mt-2 rounded-lg border border-slate-100 p-2 text-sm">
            <p className="font-medium">{item.package.id} {item.package.version} · <span className={toneOf(item.status)}>{item.status}</span>{item.autoRollback ? <span className="text-xs text-slate-500"> · automatic rollback on a failed health check</span> : null}</p>
            {item.waves.map((wave, index) => (
              <div key={wave.stage} className="mt-1 pl-2">
                <p className="text-xs"><span className="font-medium">{WAVE_TITLES[wave.stage]}</span> · <span className={toneOf(wave.status)}>{wave.status}</span>{wave.approval ? ` · approved by ${wave.approval.by}` : ""}
                  {wave.status === "planned" && item.status !== "halted" && item.status !== "cancelled" && <button type="button" className="ml-2 text-xs font-medium text-slate-900 underline" disabled={Boolean(busy)} onClick={() => void act("wave", () => RobotOps.approveWave(item.id, index), "Wave approved: its robots are being updated.")}>Approve and start</button>}
                </p>
                <ul className="text-xs text-slate-700">{wave.robotIds.map((robotId) => { const target = item.targets[robotId]; return <li key={robotId}>{robotId}: <span className={toneOf(target.status)}>{target.status}</span>{target.reason ? ` — ${target.reason}` : ""}{target.health ? ` (health: ${target.health.results.map((result) => `${result.id} ${result.ok ? "passed" : "failed"}`).join(", ")})` : ""}{["healthy", "failed"].includes(target.status) && <button type="button" className="ml-2 text-rose-700 underline" onClick={() => void act("rollback", () => RobotOps.rollbackRobot(item.id, robotId, "Rolled back from the Updates screen"), "Rollback sent.")}>Roll back</button>}</li>; })}</ul>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-rose-200 p-3">
        <p className={heading}>Firmware (separate, higher-risk)</p>
        <p className="mt-1 text-xs text-slate-600">Firmware is never part of a rollout. Each flash needs the exact hardware identity, the right firmware for it, compatibility, power and a stopped robot, a recovery procedure, and your typed authorisation. HANNAH has no driver that flashes physical hardware: for a physical robot the operation stops at BLOCKED_EXTERNAL_DEPENDENCY with every check recorded.</p>
        {firmware.length === 0 && <p className="mt-1 text-sm text-slate-600">No firmware operations.</p>}
        {firmware.map((op) => (
          <div key={op.id} className="mt-2 rounded-lg border border-slate-100 p-2 text-sm">
            <p className="font-medium">{op.robotName}: {op.package.controller} → {op.package.version} · <span className={toneOf(op.status)}>{op.status}</span></p>
            {op.result && <p className="text-xs text-slate-700">{op.result.simulated ? "Simulated: " : ""}{op.result.detail}</p>}
            {op.status === "checking" && (
              <div className="mt-1 flex flex-wrap items-end gap-2">
                <input className={`${input} w-36`} placeholder="Robot name" value={confirm[op.id]?.name || ""} onChange={(event) => setConfirm({ ...confirm, [op.id]: { name: event.target.value, serial: confirm[op.id]?.serial || "" } })} />
                <input className={`${input} w-36`} placeholder="Serial number" value={confirm[op.id]?.serial || ""} onChange={(event) => setConfirm({ ...confirm, [op.id]: { name: confirm[op.id]?.name || "", serial: event.target.value } })} />
                <button type="button" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-900 disabled:opacity-50" disabled={Boolean(busy)} onClick={() => void act("flash", () => RobotOps.authorizeFirmware(op.id, confirm[op.id]?.name || "", confirm[op.id]?.serial || ""), "Recorded.")}>{busy === "flash" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}I am at the robot: authorise</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
