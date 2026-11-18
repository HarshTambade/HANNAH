import { useCallback, useEffect, useState } from "react";
import { UserCheck, UserX } from "lucide-react";
import { desktopFilesAvailable, hannahDesktop, type LocalChannel, type LocalChannelKind } from "../services/DesktopFiles";

/** iMessage and Signal on this computer (desktop app): turn on, approve people, see who's asking. */
export default function LocalChatApps() {
  const desktop = desktopFilesAvailable();
  const [channels, setChannels] = useState<LocalChannel[]>([]);
  const [account, setAccount] = useState("");
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const load = useCallback(() => {
    if (!desktop) return;
    hannahDesktop().localChannelsStatus().then((status) => setChannels(status.channels)).catch((failure: Error) => setError(failure.message));
  }, [desktop]);
  useEffect(load, [load]);
  const act = async (work: () => Promise<unknown>) => {
    setError("");
    try { await work(); load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "That didn't work."); }
  };

  if (!desktop) return <p className="mt-3 text-[11px] text-slate-500">iMessage and Signal work in the HANNAH desktop app, where the messages are.</p>;
  return (
    <div className="mt-4 border-t border-slate-100 pt-3" role="group" aria-label="Chat apps on this computer">
      <p className="text-xs font-semibold text-ink">On this computer</p>
      {channels.map((channel) => (
        <div key={channel.kind} className="mt-2 rounded-xl border border-slate-200 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{channel.label}</span>
            <span className={channel.enabled ? "text-emerald-700" : "text-slate-500"}>{!channel.available ? channel.reason : channel.enabled ? `On${channel.account ? ` · ${channel.account}` : ""}` : "Off"}</span>
            {channel.available && (
              <span className="ml-auto flex items-center gap-1">
                {channel.kind === "signal" && !channel.enabled && <input aria-label="Signal number used by signal-cli" value={account} onChange={(event) => setAccount(event.target.value)} placeholder="+91…" className="w-32 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px]" />}
                <button type="button" onClick={() => void act(() => (channel.enabled ? hannahDesktop().disableLocalChannel({ kind: channel.kind }) : hannahDesktop().enableLocalChannel({ kind: channel.kind, account: channel.kind === "signal" ? account : undefined })))} className="btn-ghost !px-2 !py-1 text-[11px]">{channel.enabled ? "Turn off" : "Turn on"}</button>
              </span>
            )}
          </div>
          {channel.lastError && <p className="mt-1 text-[11px] text-amber-800">{channel.lastError}</p>}
          {channel.enabled && (
            <>
              <p className="mt-1 text-[11px] text-slate-600">Approved: {channel.allowed.length ? channel.allowed.map((handle) => <button key={handle} type="button" title="Remove" onClick={() => void act(() => hannahDesktop().removeLocalSender({ kind: channel.kind, handle }))} className="mr-1 underline decoration-dotted">{handle} ×</button>) : "nobody yet"}</p>
              <div className="mt-1 flex gap-1">
                <input aria-label={`Approve someone on ${channel.label}`} value={handles[channel.kind] || ""} onChange={(event) => setHandles((current) => ({ ...current, [channel.kind]: event.target.value }))} placeholder={channel.kind === "imessage" ? "+91… or name@example.com" : "+91…"} className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px]" />
                <button type="button" onClick={() => void act(async () => { await hannahDesktop().allowLocalSender({ kind: channel.kind as LocalChannelKind, handle: handles[channel.kind] || "" }); setHandles((current) => ({ ...current, [channel.kind]: "" })); })} className="btn-ghost !px-2 !py-1 text-[11px]">Approve</button>
              </div>
              {channel.asking.map((person) => (
                <div key={person.from} className="mt-1 flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate">{person.name || person.from} · “{person.preview}”</span>
                  <button type="button" aria-label={`Approve ${person.from}`} onClick={() => void act(() => hannahDesktop().allowLocalSender({ kind: channel.kind, handle: person.from }))} className="btn-ghost !px-2 !py-1 text-emerald-700"><UserCheck size={11} /></button>
                  <button type="button" aria-label={`Dismiss ${person.from}`} onClick={() => void act(() => hannahDesktop().removeLocalSender({ kind: channel.kind, handle: person.from }))} className="btn-ghost !px-2 !py-1 text-rose-600"><UserX size={11} /></button>
                </div>
              ))}
            </>
          )}
        </div>
      ))}
      {error && <p role="alert" className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] text-rose-800">{error}</p>}
    </div>
  );
}
