import { useCallback, useEffect, useState } from "react";
import { FolderLock, FolderOpen, FolderPlus, Terminal, Trash2 } from "lucide-react";
import { hannahDesktop, type AllowedCommand, type DesktopActivity, type FolderAccess, type SharedFolder } from "../services/DesktopFiles";

const activityLabel: Record<string, string> = {
  "folder-added": "Shared folder",
  "folder-removed": "Stopped sharing",
  "access-changed": "Changed access",
  read: "Read",
  write: "Wrote",
  "write-denied": "You declined a write",
  command: "Ran",
  "command-denied": "You declined a command",
  "workflow-tasks-on": "Turned on workflow tasks",
  "workflow-tasks-off": "Turned off workflow tasks",
  "workflow-page-read": "A workflow read a page",
  "workflow-page-declined": "You declined a workflow's page",
  "workflow-task-approved": "Started a workflow's coding task",
  "workflow-task-declined": "You declined a workflow's coding task",
};

/** Settings → Desktop access. Only rendered in the desktop app. */
export default function DesktopAccessPanel() {
  const [folders, setFolders] = useState<SharedFolder[]>([]);
  const [commands, setCommands] = useState<AllowedCommand[]>([]);
  const [activity, setActivity] = useState<DesktopActivity[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [workflowTasks, setWorkflowTasks] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [state, recent, tasks] = await Promise.all([hannahDesktop().listFolders(), hannahDesktop().recentActivity(), hannahDesktop().workflowTaskSettings().catch(() => ({ enabled: false }))]);
      setWorkflowTasks(tasks.enabled);
      setFolders(state.folders);
      setCommands(state.allowedCommands);
      setActivity(recent.activity);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Shared folders</h3>
          <div className="flex gap-2">
            <button type="button" className="btn-outline" disabled={busy} onClick={() => void act(() => hannahDesktop().addFolder({ access: "read" }))}><FolderPlus size={14} /> Share a folder</button>
          </div>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-600">HANNAH can list and read text files in these folders and send them to your AI model when a task needs them. In read-write folders she can also create and change files, and she can run commands in any shared folder. Every write and every command asks you first in a system dialog.</p>
        {folders.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-600">No folders shared. HANNAH can't see any of your files until you share a folder.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white" aria-label="Shared folders">
            {folders.map((folder) => (
              <li key={folder.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-ink">{folder.access === "read" ? <FolderLock size={14} className="text-slate-500" /> : <FolderOpen size={14} className="text-violet-600" />} {folder.name}</p>
                  <p className="truncate font-mono text-[11px] text-slate-500" title={folder.path}>{folder.path}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-700">
                    <span className="sr-only">Access for {folder.name}</span>
                    <select value={folder.access} disabled={busy} onChange={(event) => void act(() => hannahDesktop().setAccess({ id: folder.id, access: event.target.value as FolderAccess }))} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
                      <option value="read">Read only</option>
                      <option value="read-write">Read and write</option>
                    </select>
                  </label>
                  <button type="button" className="btn-ghost" onClick={() => void act(() => hannahDesktop().revealFolder({ id: folder.id }))}>Open</button>
                  <button type="button" className="btn-ghost text-rose-700" disabled={busy} onClick={() => void act(() => hannahDesktop().removeFolder({ id: folder.id }))} aria-label={`Stop sharing ${folder.name}`}><Trash2 size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {commands.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-ink">Commands that don't ask again</h3>
          <ul className="mt-2 space-y-1.5" aria-label="Always-allowed commands">
            {commands.map((item) => (
              <li key={`${item.folderId}:${item.command}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <span className="min-w-0 truncate font-mono text-xs text-slate-800"><Terminal size={12} className="mr-1.5 inline" />{item.command} <span className="font-sans text-slate-500">in {item.folder}</span></span>
                <button type="button" className="btn-ghost text-rose-700" onClick={() => void act(() => hannahDesktop().forgetCommand({ folderId: item.folderId, command: item.command }))}>Ask again</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1" checked={workflowTasks} disabled={busy} onChange={(event) => void act(() => hannahDesktop().setWorkflowTasks({ enabled: event.target.checked }))} />
          <span>
            <span className="block text-sm font-semibold text-ink">Run workflow tasks</span>
            <span className="mt-0.5 block text-xs leading-5 text-slate-600">Server workflows signed in to your account can send this computer two kinds of task: read a web page in a hidden, signed-out window, and a coding task in a shared folder. Each task asks you here before it starts, and a coding task still asks before every file change and command. Only while this app is open.</span>
          </span>
        </label>
      </div>

      {activity.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-ink">Recent activity</summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-700">
            {activity.slice(0, 20).map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{activityLabel[entry.kind] ?? entry.kind}{entry.folder ? ` · ${entry.folder}` : ""}{entry.detail ? ` · ${entry.detail}` : ""}{typeof entry.exitCode === "number" ? ` (exit ${entry.exitCode})` : ""}</span>
                <span className="shrink-0 text-slate-500">{new Date(entry.at).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">{error}</p>}
    </div>
  );
}
