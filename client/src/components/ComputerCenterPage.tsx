/**
 * Computer Center — your computers: cloud workspaces, local declarations,
 * the filesystem, the allow-listed terminal, the browser, sessions and the
 * human handoff. Everything is the server's real records; a cloud computer
 * workspace is a real filesystem under the server.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Folder, FolderOpen, FileText, Image as ImageIcon, Laptop, PlayCircle, RefreshCw, RotateCcw, Trash2, Upload, X, Zap } from "lucide-react";
import workforce, { type Computer, type ComputerSession, type LocalPermissions } from "../services/Workforce";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const button = "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900";
const heading = "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500";
const Notice = ({ tone = "slate", role, children }: { tone?: "slate" | "rose" | "amber" | "emerald"; role?: "alert" | "status"; children: React.ReactNode }) => {
  const tones = { slate: "border-slate-200 bg-slate-50 text-slate-800", rose: "border-rose-200 bg-rose-50 text-rose-900", amber: "border-amber-200 bg-amber-50 text-amber-900", emerald: "border-emerald-200 bg-emerald-50 text-emerald-900" };
  return <p className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`} role={role || (tone === "rose" ? "alert" : "status")}>{children}</p>;
};
const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const formatTime = (at: number | null) => (at ? new Date(at).toLocaleString() : "never");
const statusTones: Record<string, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  running: "border-emerald-200 bg-emerald-50 text-emerald-800",
  stopped: "border-amber-200 bg-amber-50 text-amber-900",
  "not-connected": "border-slate-200 bg-slate-100 text-slate-700",
};
const statusLabel: Record<string, string> = { active: "Active", running: "Running", stopped: "Stopped", "not-connected": "Not connected" };

type FileEntry = { name: string; path: string; type: string; size: number; modifiedAt: number };

function NewComputer({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: "", kind: "cloud", image: "", storageMb: "512", terminal: true, browser: true, downloads: true, network: "public", localMode: "ask" });
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    try {
      await workforce.computerCreate({ name: form.name.trim(), kind: form.kind, image: form.image || undefined,
        permissions: { terminal: form.terminal, browser: form.browser, downloads: form.downloads, network: form.network, localMode: form.localMode },
        limits: { storageMb: Number(form.storageMb) || 512 } });
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); }
  };
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-2 sm:p-6" data-testid="new-computer-modal">
      <div className={card} style={{ maxWidth: "30rem" }}>
        <h2 className="text-base font-semibold text-ink">Add a computer</h2>
        <div className="mt-3 grid gap-3">
          <label className="block"><span className={heading}>Name</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={input} required /></label>
          <label className="block"><span className={heading}>Kind</span>
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} className={input}>
              <option value="cloud">Cloud computer (runs on the server)</option>
              <option value="local">Local computer (your desktop — the desktop app runs it)</option>
            </select>
          </label>
          <label className="block"><span className={heading}>Storage limit (MB)</span><input value={form.storageMb} onChange={(event) => setForm({ ...form, storageMb: event.target.value })} className={input} /></label>
          <div className="grid grid-cols-2 gap-3">
            {(["terminal", "browser", "downloads"] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form[key]} onChange={() => setForm({ ...form, [key]: !form[key] })} /> {key[0].toUpperCase() + key.slice(1)}</label>
            ))}
            <label className="block"><span className={heading}>Network</span>
              <select value={form.network} onChange={(event) => setForm({ ...form, network: event.target.value })} className={input}>
                <option value="public">Public (default)</option><option value="allowlist">Allow-listed</option><option value="none">None</option>
              </select>
            </label>
            <label className="block"><span className={heading}>Local execution</span>
              <select value={form.localMode} onChange={(event) => setForm({ ...form, localMode: event.target.value })} className={input}>
                <option value="ask">Ask every time (default)</option><option value="never">Never</option>
              </select>
            </label>
          </div>
        </div>
        {error && <Notice tone="rose">{error}</Notice>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={button} onClick={onCancel}>Cancel</button>
          <button type="button" className={primary} onClick={() => void submit()}><Zap size={13} /> Add computer</button>
        </div>
      </div>
    </div>
  );
}

const LOCAL_KINDS: Array<[string, string]> = [["browser", "Read a web page"], ["coding", "Coding in a shared folder"], ["open", "Open apps and links"], ["notify", "Desktop notifications"]];

/** What a local computer takes from teammates. The desktop app still asks before every job. */
function LocalComputerPanel({ computer }: { computer: Computer }) {
  const stored = computer.permissions as { localMode?: string; localKinds?: string[]; localFolders?: string[]; localElevated?: Array<"terminal" | "control"> };
  const [mode, setMode] = useState<LocalPermissions["mode"]>((["ask", "tasks", "workspaces", "never"].includes(String(stored.localMode)) ? stored.localMode : stored.localMode === "allow" ? "tasks" : "ask") as LocalPermissions["mode"]);
  const [kinds, setKinds] = useState<string[]>(stored.localKinds ?? []);
  const [folders, setFolders] = useState((stored.localFolders ?? []).join("\n"));
  const [elevated, setElevated] = useState<Array<"terminal" | "control">>(stored.localElevated ?? []);
  const [note, setNote] = useState("");
  const save = async () => {
    setNote("");
    try {
      const saved = await workforce.localPermissions(computer.id, { mode, kinds, folders: folders.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), elevated });
      setElevated(saved.permissions.elevated ?? []);
      setNote("Saved.");
    } catch (error) { setNote(error instanceof Error ? error.message : "That didn't work."); }
  };
  return (
    <div className="mt-4 space-y-3" data-testid="local-computer-panel">
      <p className="text-sm text-slate-600">This is your own computer. Teammates can't reach it directly: from a teammate's task you send a job here, the HANNAH desktop app (signed in, with “Run workflow tasks” on in Settings → Desktop access) shows its own system dialog naming the teammate, and runs it only if you say yes. These settings decide which jobs may be sent at all; they're separate from any cloud computer's permissions.</p>
      <fieldset className="space-y-1.5">
        <legend className={heading}>Teammate jobs</legend>
        {([["ask", "Ask every time — web pages, coding, opening apps and notifications (default)"], ["tasks", "Only some kinds of job"], ["workspaces", "Only coding, in some shared folders"], ["never", "Never"]] as const).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" name={`local-mode-${computer.id}`} checked={mode === value} onChange={() => setMode(value)} /> {label}</label>
        ))}
      </fieldset>
      {mode === "tasks" && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">{LOCAL_KINDS.map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5 text-sm text-slate-700"><input type="checkbox" checked={kinds.includes(value)} onChange={() => setKinds((list) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]))} /> {label}</label>
        ))}</div>
      )}
      {mode === "workspaces" && (
        <label className="block"><span className={heading}>Shared folder names (one per line, as shown in Settings → Desktop access)</span><textarea className={`${input} min-h-20`} value={folders} onChange={(event) => setFolders(event.target.value)} /></label>
      )}
      {mode !== "never" && (
        <fieldset className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <legend className={heading}>Also allow (off unless you turn it on)</legend>
          {([
            ["terminal", "Terminal commands", "One exact command in a shared folder, run without a shell. The desktop shows the command and asks every time; “always allow” never applies to a teammate."],
            ["control", "Desktop control", "Using your apps for a task. You allow a timed session in a system dialog; it reads the screen before every action, asks before anything that sends, deletes or buys, never types passwords, and stops at once from the menu bar."],
          ] as const).filter(([value]) => mode !== "workspaces" || value === "terminal").map(([value, label, help]) => (
            <label key={value} className="flex items-start gap-2 text-sm text-slate-700"><input type="checkbox" className="mt-1" checked={elevated.includes(value)} onChange={() => setElevated((list) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]))} data-testid={`local-elevated-${value}`} /> <span><span className="font-medium">{label}</span><span className="block text-xs text-slate-600">{help}</span></span></label>
          ))}
        </fieldset>
      )}
      <div className="flex items-center gap-2"><button type="button" className={primary} onClick={() => void save()} data-testid="local-permissions-save">Save</button>{note && <span className="text-sm text-slate-600" role="status">{note}</span>}</div>
    </div>
  );
}

export default function ComputerCenterPage() {
  const [computers, setComputers] = useState<Computer[]>([]);
  const [detail, setDetail] = useState<Computer | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [contentFile, setContentFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [writePath, setWritePath] = useState("");
  const [writeContent, setWriteContent] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalOutput, setTerminalOutput] = useState<string[]>([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [sessions, setSessions] = useState<ComputerSession[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [navUrl, setNavUrl] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [clickSelector, setClickSelector] = useState("");
  const [error, setError] = useState("");

  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : "That didn't work."); };

  const loadComputers = useCallback(async () => { const data = await workforce.computers(); setComputers(data.computers); }, []);
  useEffect(() => {
    void loadComputers().catch(fail);
    const timer = setInterval(() => void loadComputers().catch(() => undefined), 12_000);
    return () => clearInterval(timer);
  }, [loadComputers]);

  const openDetail = useCallback(async (computer: Computer) => {
    setDetail(computer); setError(""); setCurrentPath(""); setContentFile(null); setSessions([]); setScreenshotUrl(null);
    // A local computer's files, terminal and browser live in the desktop app; this server can't list them.
    if (computer.kind === "local") return;
    const [filesData, sessionsData] = await Promise.all([workforce.computerFiles(computer.id), workforce.computerSessions(computer.id)]);
    setFiles(filesData.files.slice(0, 100)); setSessions(sessionsData.sessions);
  }, []);

  useEffect(() => {
    if (!detail || detail.kind === "local") return;
    void workforce.computerFiles(detail.id, currentPath).then((data) => setFiles(data.files.slice(0, 100))).catch(() => undefined);
    void workforce.computerSessions(detail.id).then((data) => setSessions(data.sessions)).catch(() => undefined);
    const timer = setInterval(() => void workforce.computerSessions(detail.id).then((data) => setSessions(data.sessions)).catch(() => undefined), 8_000);
    return () => clearInterval(timer);
  }, [detail, currentPath]);

  const pollScreenshot = useCallback(async (sessionId: string, live = false) => {
    const blob = await workforce.computerScreenshot(sessionId, live);
    setScreenshotUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
    setScreenshotAt(Date.now());
  }, []);

  // Live view: a fresh capture of the session's browser every two seconds while it's on.
  const [liveSession, setLiveSession] = useState<string | null>(null);
  const [screenshotAt, setScreenshotAt] = useState<number | null>(null);
  useEffect(() => {
    if (!liveSession) return;
    let stopped = false;
    const tick = () => void pollScreenshot(liveSession, true).catch(() => { if (!stopped) setLiveSession(null); });
    tick();
    const timer = window.setInterval(tick, 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [liveSession, pollScreenshot]);
  useEffect(() => { if (!detail) setLiveSession(null); }, [detail]);

  const viewFile = async (file: FileEntry) => {
    if (file.type === "folder") { setCurrentPath(file.path); setContentFile(null); setContent(""); return; }
    setContentFile(file.path);
    try { setContent((await workforce.computerFileContent(detail!.id, file.path)).content || ""); } catch (e) { setContent(`(Can't open: ${(e as Error).message})`); }
  };
  const writeFile = async () => { setError(""); if (!detail || !writePath.trim()) return; try { await workforce.computerWriteFile(detail.id, writePath.trim(), writeContent, "utf8"); setWritePath(""); setWriteContent(""); setError("File written."); } catch (e) { fail(e); } };
  const newFolder = async () => { setError(""); if (!detail) return; try { await workforce.computerCreateFolder(detail.id, currentPath ? `${currentPath}/` : "folder"); setError("Folder created."); } catch (e) { fail(e); } };
  const deleteFile = async (path: string) => { setError(""); try { await workforce.computerDeleteFiles(detail!.id, path, false); setContentFile(null); setContent(""); setError("Deleted."); } catch (e) { fail(e); } };
  const runTerminal = async () => { setTerminalRunning(true); setError(""); setTerminalOutput((output) => [...output, `$ ${terminalInput.trim()}`]); try { const { result } = await workforce.computerTerminal(detail!.id, { command: terminalInput.trim(), args: [] }); setTerminalOutput((output) => [...output, ...(result.stdout ? [String(result.stdout)] : []), ...(result.stderr ? [String(result.stderr)] : [])]); setTerminalInput(""); } catch (e) { setTerminalOutput((output) => [...output, `error: ${(e as Error).message}`]); } finally { setTerminalRunning(false); } };
  const browserAction = async (action: Record<string, unknown>, label: string) => { setError(""); try { await workforce.computerBrowserAction(detail!.id, action); setError(`${label} done.`); } catch (e) { fail(e); } };
  const startSession = async () => { setError(""); try { await workforce.computerStartSession(detail!.id); setError("Session started."); } catch (e) { fail(e); } };
  const handoff = async (sessionId: string) => { setError(""); try { const r = await workforce.computerHandoff(sessionId, {}); setError(`Handoff started: ${r.reason}. Resume when you're done.`); } catch (e) { fail(e); } };
  const resumeSession = async (sessionId: string) => { setError(""); try { await workforce.computerResume(sessionId); setError("Session resumed."); } catch (e) { fail(e); } };

  return (
    <main className="mx-auto max-w-6xl px-3 pb-12 pt-5 sm:px-6 sm:pt-8" data-testid="computer-center">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display-title text-[clamp(2.2rem,5vw,3.5rem)]">Computer Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">Cloud workspaces (real filesystems and terminals) and local computers (declared, run in the desktop app). Open a computer to browse files, drive the browser, run the allow-listed terminal, or hand off to a human.</p>
        </div>
        <button type="button" onClick={() => setShowNew(true)} className={primary} data-testid="new-computer"><Zap size={16} /> New computer</button>
      </div>
      {error && <Notice tone="rose" role="alert">{error}</Notice>}

      <section className="mb-6" aria-label="Computers">
        <div className="mb-3 flex items-center justify-between"><span className={heading}>Computers</span><button type="button" onClick={() => void loadComputers()} className="btn-outline text-xs"><RefreshCw size={12} /> Refresh</button></div>
        {computers.length === 0 ? (
          <div className={card} data-testid="computers-empty"><p className="text-sm text-slate-500">No computers yet. Cloud computers run here; local computers are managed by the desktop app.</p></div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {computers.map((computer) => (
              <li key={computer.id} className={card} data-testid={`computer-${computer.id}`}>
                <div className="flex items-center gap-3">
                  <Laptop size={22} className="text-slate-900" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{computer.name}</p><p className="truncate text-xs text-slate-500">{computer.kind === "local" ? "Local · desktop runtime" : `Cloud · ${computer.risk}`}</p></div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusTones[computer.status] || "border-slate-200 bg-slate-100 text-slate-700"}`}>{statusLabel[computer.status] || computer.status}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                  {computer.usage ? <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">{formatBytes(computer.usage.bytes)} used</span> : null}
                  {computer.lastStartedAt ? <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">last {new Date(computer.lastStartedAt).toLocaleDateString()}</span> : null}
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">{computer.kind === "local" ? "desktop" : "server"}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void openDetail(computer)} className={button} data-testid={`computer-open-${computer.id}`}><FolderOpen size={13} /> Open</button>
                  {computer.kind === "cloud" && (
                    <>
                      <button type="button" onClick={() => workforce.computerStart(computer.id).then(() => void loadComputers()).catch((e) => fail(e))} className={button} data-testid={`computer-start-${computer.id}`}><PlayCircle size={13} /> Start</button>
                      <button type="button" onClick={() => workforce.computerStop(computer.id).then(() => void loadComputers()).catch((e) => fail(e))} className={button} data-testid={`computer-stop-${computer.id}`}><RotateCcw size={13} /> Stop</button>
                    </>
                  )}
                  <button type="button" onClick={() => workforce.computerDelete(computer.id).then(() => void loadComputers()).catch((e) => fail(e))} className="btn-ghost text-rose-600" data-testid={`computer-delete-${computer.id}`}><Trash2 size={13} /> Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid={`computer-detail-${detail.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Laptop size={22} className="text-slate-900" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">{detail.name}</h2>
                <p className="text-xs text-slate-500">{detail.kind === "local" ? "Local computer — run from the desktop app" : `Cloud computer · ${detail.risk}`} · {statusLabel[detail.status] || detail.status}</p>
              </div>
            </div>
            <button type="button" onClick={() => setDetail(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close computer"><X size={16} /></button>
          </div>
          {detail.kind === "local" ? <LocalComputerPanel computer={detail} /> : <>

          {/* Files */}
          <div className="mt-4" data-testid="computer-files">
            <span className={heading}>Files</span>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
              {[...Array(Math.max(1, currentPath.split("/").filter(Boolean).length + 1))].map((_, index) => {
                const parts = currentPath.split("/").filter(Boolean);
                return (
                  <button key={index} type="button" onClick={() => setCurrentPath(parts.slice(0, index + 1).join("/"))} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 font-mono text-[11px] text-slate-700 hover:bg-slate-100">{parts.slice(0, index + 1).join("/") || "Workspace root"}</button>
                );
              })}
            </div>
            <div className="mt-3 max-h-72 space-y-0.5 overflow-y-auto">
              {files.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">This folder is empty.</p> : (
                files.map((file) => (
                  <div key={file.path} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-50" data-testid={`file-${file.path}`}>
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2" onClick={() => void viewFile(file)}>
                      {file.type === "folder" ? <FolderOpen size={16} className="text-slate-500" /> : <FileText size={16} className="text-slate-400" />}
                      <span className="truncate font-mono text-xs">{file.name}</span>
                    </button>
                    <span className="w-20 text-right text-[11px] text-slate-500">{formatBytes(file.size)}</span>
                    <button type="button" onClick={() => void newFolder()} className="btn-outline !py-1 !px-2 text-xs"><Folder size={12} /> New folder</button>
                    <button type="button" onClick={() => void deleteFile(file.path)} className="btn-ghost text-rose-600"><Trash2 size={12} /></button>
                  </div>
                ))
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <form onSubmit={(event) => { event.preventDefault(); void writeFile(); }} className="flex gap-2">
                <input value={writePath} onChange={(event) => setWritePath(event.target.value)} placeholder="new file path" className={input} style={{ maxWidth: "220px" }} />
                <textarea value={writeContent} onChange={(event) => setWriteContent(event.target.value)} placeholder="Contents (up to 8 MB)" className="h-20 w-56 resize-y rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" />
                <button type="submit" className={button} disabled={!writePath.trim()}><Upload size={12} /> Write file</button>
              </form>
            </div>
            {contentFile && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
                <p className="mb-1 font-mono text-xs text-slate-600">{contentFile}</p>
                <pre className="max-h-64 overflow-auto rounded-lg bg-white p-2 text-[11px] text-slate-800">{content || <span className="text-slate-500">(empty or binary — files over 2 MB are downloaded, not opened)</span>}</pre>
                <div className="mt-2"><button type="button" onClick={() => setContentFile(null)} className={button}>Close</button></div>
              </div>
            )}
          </div>

          {/* Terminal */}
          {detail.kind === "cloud" && (
            <div className="mt-4" data-testid="computer-terminal">
              <span className={heading}>Terminal</span>
              <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center gap-2">
                  <input value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runTerminal(); }} placeholder="Run an approved command…" className={input} style={{ maxWidth: "280px" }} />
                  <button type="button" onClick={() => void runTerminal()} className={primary} disabled={terminalRunning || !terminalInput.trim()}>{terminalRunning ? "Running…" : "Run"}</button>
                </div>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-white p-2 text-[11px] text-slate-700">{terminalOutput.length ? terminalOutput.join("\n") : <span className="text-slate-500">Output appears here. The terminal is allow-listed and runs inside the workspace.</span>}</pre>
              </div>
            </div>
          )}

          {/* Browser */}
          <div className="mt-4" data-testid="computer-browser">
            <span className={heading}>Browser &amp; sessions</span>
            {detail.kind === "cloud" && (
              <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void browserAction({ action: "navigate", url: navUrl.trim() }, "Navigation"); }}>
                <input value={navUrl} onChange={(event) => setNavUrl(event.target.value)} placeholder="Navigate to a URL" className={input} style={{ maxWidth: "200px" }} />
                <button type="submit" className={button} disabled={!navUrl.trim()}>Go</button>
              </form>
            )}
            <ul className="mt-3 space-y-2">
              {sessions.map((session) => (
                <li key={session.id} className={card} data-testid={`session-${session.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="pill-badge" data-status={session.status}>{session.status}</span>
                      {session.url ? <span className="font-mono text-[11px] text-slate-600">{session.url}</span> : null}
                      <span className="text-[11px] text-slate-500">started {formatTime(session.startedAt)}</span>
                      {session.botId ? <span className="text-[11px] text-slate-500">a teammate's session</span> : null}
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void pollScreenshot(session.id)} className={button}><ImageIcon size={12} /> Screenshot</button>
                      {session.status !== "ended" && <button type="button" onClick={() => setLiveSession((current) => (current === session.id ? null : session.id))} className={liveSession === session.id ? primary : button} aria-pressed={liveSession === session.id} data-testid={`live-view-${session.id}`}>{liveSession === session.id ? "Stop live view" : "Live view"}</button>}
                      {session.status === "waiting-human" && <button type="button" onClick={() => void resumeSession(session.id)} className={primary}><RotateCcw size={12} /> Resume</button>}
                      {session.status !== "ended" && session.status !== "waiting-human" && <button type="button" onClick={() => void handoff(session.id)} className={button}><AlertTriangle size={12} /> Handoff to a human</button>}
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {(session.activity || []).slice(0, 12).map((entry, index) => <li key={index} className="text-[11px] text-slate-600">{String(entry.at ? new Date(Number(entry.at)).toLocaleTimeString() : "")} {String(entry.kind || "")}{entry.detail ? " — " + JSON.stringify(entry.detail).slice(0, 140) : ""}</li>)}
                  </ul>
                </li>
              ))}
              {sessions.length === 0 && <li className="text-sm text-slate-500">No sessions recorded.</li>}
            </ul>
            {screenshotUrl && <img src={screenshotUrl} alt="Browser session screenshot" className="mt-3 max-h-96 w-full rounded-xl border border-slate-200 shadow-sm" data-testid="browser-screenshot-preview" />}
            {screenshotUrl && screenshotAt && <p className="mt-1 text-[11px] text-slate-500">{liveSession ? "Live: " : ""}captured {new Date(screenshotAt).toLocaleTimeString()}</p>}
            {detail.kind === "cloud" && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <input value={navUrl} onChange={(event) => setNavUrl(event.target.value)} placeholder="Navigate to a URL" className={input} data-testid="browser-nav-url" />
                <input value={clickSelector} onChange={(event) => setClickSelector(event.target.value)} placeholder="Click a CSS selector" className={input} data-testid="browser-click-selector" />
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Extract / wait query" className={input} data-testid="browser-extract-query" />
                <button type="button" onClick={() => void browserAction({ action: "navigate", url: navUrl }, "Navigate")} disabled={!navUrl.trim()} className={button} data-testid="browser-navigate"><Zap size={12} /> Navigate</button>
                <button type="button" onClick={() => void browserAction({ action: "click", selector: clickSelector }, "Click")} disabled={!clickSelector.trim()} className={button} data-testid="browser-click"><Zap size={12} /> Click</button>
                <button type="button" onClick={() => void startSession()} className={primary} data-testid="computer-start-session"><PlayCircle size={13} /> Start browser session</button>
              </div>
            )}
          </div>
          </>}
        </section>
      )}

      {showNew && <NewComputer onDone={() => { setShowNew(false); void loadComputers(); }} onCancel={() => setShowNew(false)} />}
    </main>
  );
}
