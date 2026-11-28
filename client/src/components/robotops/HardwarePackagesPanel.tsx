/**
 * Hardware packages in the marketplace: drivers, adapters, sensor
 * integrations and the rest, each checked by the server before it is kept.
 * The status shown is a fact, not a badge: "Developer-published", or
 * "Compatibility tested" with what was tested, on what and where, as the
 * developer reported it. HANNAH runs no certification programme.
 */
import { useCallback, useEffect, useState } from "react";
import { RobotTrust, packageStatusText, type HardwarePackage, type PackageInstall } from "../../services/RobotTrust";
import { ACCOUNT_EVENT, isAccountSession } from "../../services/api";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900";
const message = (error: unknown) => (error instanceof Error ? error.message : "That didn't work.");

export default function HardwarePackagesPanel() {
  const [packages, setPackages] = useState<HardwarePackage[] | null>(null);
  const [installs, setInstalls] = useState<PackageInstall[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [upload, setUpload] = useState("");
  const [target, setTarget] = useState("");
  const [signedIn, setSignedIn] = useState(isAccountSession());
  useEffect(() => {
    const changed = () => setSignedIn(isAccountSession());
    window.addEventListener(ACCOUNT_EVENT, changed);
    return () => window.removeEventListener(ACCOUNT_EVENT, changed);
  }, []);
  const refresh = useCallback(async () => {
    if (!isAccountSession()) return;
    try { const listed = await RobotTrust.packages(); setPackages(listed.packages); setInstalls(listed.installs); } catch (error) { setProblem(message(error)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, signedIn]);
  const run = async (task: () => Promise<string | null>) => { setProblem(null); setOutcome(null); try { setOutcome(await task()); await refresh(); } catch (error) { setProblem(message(error)); } };

  return (
    <section className={`${card} mt-8`} aria-labelledby="hardware-packages-heading" data-testid="hardware-packages">
      <h2 id="hardware-packages-heading" className="text-sm font-semibold text-ink">Hardware packages</h2>
      <p className="mt-1 text-xs leading-5 text-slate-600">Robot adapters, drivers, sensor integrations, diagnostics, maintenance rules, mission skills, simulation scenarios, teleoperation interfaces, hardware profiles and workflow templates. Each is checked before it is kept: the publisher's signature, every file, its dependencies, its permissions and the hardware it says it opens. Installed, it gets only what it declares. Installing on a robot always asks you first.</p>
      {!signedIn && <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">Sign in to see and install hardware packages. They belong to an account, with the publisher keys you trust.</p>}
      {problem && <p role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{problem}</p>}
      {outcome && <p role="status" className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800">{outcome}</p>}
      {packages && packages.length === 0 && <p className="mt-3 text-xs text-slate-500">No hardware packages yet. Add a publisher's key under Devices, then add a signed package here.</p>}
      <ul className="mt-3 grid gap-3 md:grid-cols-2">
        {(packages || []).map((item) => (
          <li key={`${item.id}@${item.version}`} className="rounded-xl border border-slate-200 p-3 text-xs" data-testid="hardware-package">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{item.name}</span>
              <span className="text-slate-500">{item.kindLabel} · v{item.version} · by {item.publisher}</span>
            </div>
            <p className="mt-1 text-slate-600">{item.description}</p>
            <p className="mt-1 font-medium text-slate-800" data-testid="package-status">{packageStatusText(item.status)}</p>
            {item.status.note && <p className="text-slate-500">{item.status.note}</p>}
            <p className="mt-1 text-slate-600">Permissions: {item.permissions.join(", ") || "none"} · Hardware: {item.hardwareInterfaces.map((hw) => `${hw.type} ${hw.match}`).join(", ") || "none"}</p>
            {item.safetyConstraints.length > 0 && <p className="text-slate-600">Safety: {item.safetyConstraints.join("; ")}</p>}
            {item.revoked && <p className="mt-1 font-semibold text-rose-800">Revoked: {item.revoked.reason}</p>}
            {item.installedOn.length > 0 && <p className="text-slate-600">Installed on {item.installedOn.join(", ")}</p>}
            {!item.revoked && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={button} disabled={!target} onClick={() => void run(async () => (await RobotTrust.installPackage(item.id, item.version, target)).record.outcome)}>Install on robot</button>
                <button type="button" className={button} onClick={() => void run(async () => `${(await RobotTrust.revokePackage(item.id, item.version, "Revoked from the marketplace")).disabledInstalls} install(s) disabled.`)}>Revoke</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {installs.some((item) => item.previousVersion) && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Installs that can roll back">
          {installs.filter((item) => item.previousVersion && item.status === "active").map((item) => (
            <li key={`${item.packageId}@${item.target}`} className="flex items-center justify-between gap-2">
              <span>{item.packageId} {item.version} on {item.target}</span>
              <button type="button" className={button} onClick={() => void run(async () => (await RobotTrust.rollbackPackage(item.packageId, item.target)).record.outcome)}>Roll back to {item.previousVersion}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_12rem]">
        <label className="text-xs text-slate-700">Add a signed package ({"{"} manifest, files {"}"} as JSON)<textarea className={`${input} h-20 font-mono`} value={upload} onChange={(event) => setUpload(event.target.value)} /></label>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-slate-700">Robot id to install on<input className={input} value={target} onChange={(event) => setTarget(event.target.value)} /></label>
          <button type="button" className={button} disabled={!upload.trim()} onClick={() => void run(async () => {
            let parsed: { manifest?: unknown; files?: Record<string, string> };
            try { parsed = JSON.parse(upload); } catch { throw new Error("That isn't JSON."); }
            const report = await RobotTrust.uploadPackage(parsed.manifest, parsed.files || {});
            return report.stored ? "Checked and kept." : `Not kept: ${report.problems.join(" ")}`;
          })}>Check and add</button>
        </div>
      </div>
    </section>
  );
}
