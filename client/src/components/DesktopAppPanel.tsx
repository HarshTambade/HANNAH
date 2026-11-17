import { useEffect, useState } from "react";
import { Download, Keyboard, Link2, RefreshCw } from "lucide-react";
import { desktopFilesAvailable, hannahDesktop, type DesktopInfo, type UpdateChannel } from "../services/DesktopFiles";

/** Settings → Desktop app: updates (channel, check, history), the shortcut and hannah:// links. Desktop only. */
export default function DesktopAppPanel() {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!desktopFilesAvailable()) return;
    hannahDesktop().desktopInfo().then(setInfo).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "The desktop app didn't answer."));
  }, []);

  if (!desktopFilesAvailable()) return null;

  const changeChannel = async (channel: UpdateChannel) => {
    setBusy(true);
    try {
      setInfo(await hannahDesktop().setUpdateChannel({ channel }));
      setStatus(channel === "beta" ? "Beta channel: you'll get pre-releases as soon as they're published. Switch back to Stable any time; a beta already installed stays until the next stable release is newer." : "Stable channel: only finished releases.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't change the channel.");
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setStatus("Checking…");
    try {
      const result = await hannahDesktop().checkForUpdates();
      setStatus(result.available ? `HANNAH ${result.version} is available. It downloads now and installs when you quit.` : result.outcome.startsWith("failed") ? `Couldn't check: ${result.outcome.slice(8)}` : result.outcome.startsWith("development") ? "Updates are checked in the installed app, not a development build." : "HANNAH is up to date.");
      setInfo(await hannahDesktop().desktopInfo());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't check for updates.");
    } finally {
      setBusy(false);
    }
  };

  const shortcut = info?.shortcut.accelerator.replace("CommandOrControl", info.platform === "darwin" ? "⌘" : "Ctrl").replace(/\+/g, " + ") ?? "";
  return (
    <section className="deck-frame" aria-label="Desktop app">
      <div className="deck-card tone-plain">
        <h2 className="font-display text-lg font-medium tracking-tight text-ink">Desktop app</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">Updates come from HANNAH's GitHub releases, download in the background and install when you quit. Every package carries a checksum and a build attestation you can verify with GitHub's <code>gh attestation verify</code>.</p>
        {info && (
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-slate-500"><Download size={15} /> Version</dt>
              <dd className="font-medium text-ink">{info.version}{info.packaged ? "" : " (development build)"}</dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-slate-500"><RefreshCw size={15} /> Update channel</dt>
              <dd className="flex items-center gap-2">
                <select value={info.channel} disabled={busy} onChange={(event) => void changeChannel(event.target.value as UpdateChannel)} aria-label="Update channel" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm text-ink">
                  <option value="stable">Stable</option>
                  <option value="beta">Beta (pre-releases)</option>
                </select>
                <button type="button" disabled={busy} onClick={() => void check()} className="btn-outline !py-1.5 text-xs">Check for updates</button>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-slate-500"><Keyboard size={15} /> Talk to HANNAH</dt>
              <dd className="font-medium text-ink">{shortcut}{info.shortcut.registered ? "" : " (another app holds this shortcut)"} · also in the {info.platform === "darwin" ? "menu bar" : "system tray"}{info.tray ? "" : " (icon unavailable)"}</dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-slate-500"><Link2 size={15} /> Links</dt>
              <dd className="text-right text-ink"><code>hannah://chat</code>, <code>hannah://settings</code> and the other screens open this app{info.deepLinks.registered ? "" : info.packaged ? " once the system has registered it" : " (installed app only)"}.</dd>
            </div>
          </dl>
        )}
        {status && <p role="status" className="mt-3 text-sm text-slate-700">{status}</p>}
        {info && info.updateHistory.length > 0 && (
          <details className="mt-3 text-xs text-slate-600">
            <summary className="cursor-pointer font-medium text-ink">Update history ({info.updateHistory.length})</summary>
            <ul className="mt-1 space-y-0.5">{info.updateHistory.map((entry) => <li key={`${entry.version}-${entry.at}`}>{entry.version} · first run {new Date(entry.at).toLocaleString()}</li>)}</ul>
          </details>
        )}
      </div>
    </section>
  );
}
