/**
 * Files and terminal on desktop.
 *
 * In the desktop app, HANNAH can work in folders you share in Settings →
 * Desktop access. The rules are enforced by the HannahDesktop plugin in
 * Electron's main process (client/plugins/desktop-tools), not here and not by
 * the model: paths must stay inside a shared folder, writes need a read-write
 * folder, and every write or command waits for your yes in a native dialog.
 * On the web and on phones these tools don't exist.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import type { HANNAHTool } from "./DeviceTools";

export type FolderAccess = "read" | "read-write";
export type SharedFolder = { id: string; name: string; path: string; access: FolderAccess; addedAt: number };
export type AllowedCommand = { folderId: string; folder: string; command: string; addedAt: number };
export type DesktopActivity = { at: number; kind: string; folder?: string; detail?: string; exitCode?: number | null };
export type DirectoryEntry = { name: string; type: "file" | "directory" | "other"; size: number | null };
export type CommandResult = { folder: string; command: string; cwd: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; durationMs: number };

export interface HannahDesktopPlugin {
  listFolders(): Promise<{ folders: SharedFolder[]; allowedCommands: AllowedCommand[]; platform: string }>;
  addFolder(options: { access: FolderAccess }): Promise<{ folder: SharedFolder | null }>;
  removeFolder(options: { id: string }): Promise<{ removed: boolean }>;
  setAccess(options: { id: string; access: FolderAccess }): Promise<{ folder: SharedFolder }>;
  revealFolder(options: { id: string }): Promise<void>;
  listDirectory(options: { folderId: string; path?: string }): Promise<{ folder: string; path: string; entries: DirectoryEntry[]; truncated: boolean; total: number }>;
  readFile(options: { folderId: string; path: string }): Promise<{ folder: string; path: string; content: string; bytes: number }>;
  writeFile(options: { folderId: string; path: string; content: string }): Promise<{ folder: string; path: string; bytesWritten: number; created: boolean }>;
  runCommand(options: { folderId: string; path?: string; command: string }): Promise<CommandResult>;
  forgetCommand(options: { folderId: string; command: string }): Promise<{ allowedCommands: AllowedCommand[] }>;
  recentActivity(): Promise<{ activity: DesktopActivity[] }>;
  /** Tasks sent by server workflows: off until turned on (with a system dialog); each task asks again. */
  workflowTaskSettings(): Promise<{ enabled: boolean }>;
  setWorkflowTasks(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  approveWorkflowTask(options: { workflowName: string; summary: string; folderId: string }): Promise<{ approved: boolean }>;
  readWebPage(options: { url: string; waitFor?: string; screenshot?: boolean; workflowName: string }): Promise<{ approved: boolean; page?: WebPageRead }>;
  /** Screen: one screenshot per request, after a system dialog; a session is shown in the tray and can be paused or stopped. */
  screenStatus(): Promise<ScreenStatus>;
  captureScreen(options: { reason: string }): Promise<ScreenCapture>;
  pauseScreenSession(options: { paused: boolean }): Promise<ScreenSessionState>;
  stopScreenSession(): Promise<ScreenSessionState>;
  openScreenSettings(): Promise<void>;
  /** Apps from the system's own launchers; opening asks first (or not, for apps marked "always"), then checks the process. */
  listApps(options?: { query?: string }): Promise<{ apps: InstalledApp[]; total: number; allowedApps: AllowedApp[]; platform: string }>;
  openApp(options: { name: string; folderId?: string }): Promise<AppLaunch>;
  forgetApp(options: { id: string }): Promise<{ allowedApps: AllowedApp[] }>;
  /** Startup routine: saved after a system dialog; runs at login only when turned on. */
  startupSettings(): Promise<StartupSettings>;
  saveStartupRoutine(options: { steps: StartupStep[] }): Promise<StartupSettings>;
  setStartupEnabled(options: { enabled: boolean }): Promise<StartupSettings>;
  runStartupRoutine(options: { trigger: "manual" }): Promise<{ ran: boolean } & Partial<StartupRun>>;
  /** HANNAH's browser: a visible, signed-out window. Starting it asks once; typing and pressing buttons that change things ask each time. */
  browserStatus(): Promise<{ open: boolean; startedAt: number | null; actions: number; url: string | null }>;
  browserOpen(options: { url: string; reason?: string }): Promise<BrowserPage>;
  browserSearch(options: { query: string; site?: "web" | "youtube" }): Promise<BrowserPage | YouTubeResults>;
  browserRead(): Promise<BrowserPage>;
  browserScroll(options: { direction: "down" | "up" | "top" }): Promise<BrowserPage>;
  browserBack(): Promise<BrowserPage>;
  browserClick(options: { ref: string }): Promise<BrowserPage>;
  browserType(options: { ref: string; text: string; submit?: boolean }): Promise<BrowserPage>;
  browserScreenshot(): Promise<{ image: string; mediaType: "image/jpeg"; width: number; height: number; url: string }>;
  youtubeVideo(options?: { url?: string; maxChars?: number; partChars?: number }): Promise<YouTubeVideo>;
  browserClose(): Promise<{ open: false }>;
  /** Notes as a PDF in a read-write shared folder, after a system dialog; checked on disk. */
  saveNotesPdf(options: { folderId: string; fileName?: string; title: string; creator?: string; sourceUrl?: string; topic?: string; markdown: string }): Promise<SavedPdf>;
  revealNotes(options: { folderId: string; path: string }): Promise<void>;
  /**
   * Computer control (plugins/desktop-tools/electron/dist/control.mjs): a session the user starts in a
   * system dialog, actions only on a fresh observation, each verified by observing again, in a task history.
   */
  controlStatus(): Promise<ControlStatus>;
  requestControlAccess(): Promise<{ accessibility: boolean }>;
  startControl(options: { reason: string; minutes?: number }): Promise<ControlSession>;
  pauseControl(options: { paused: boolean }): Promise<ControlSession>;
  stopControl(options?: { emergency?: boolean }): Promise<ControlSession>;
  startControlTask(options: { request: string; plan: string[] }): Promise<ControlTask>;
  finishControlTask(options: { taskId: string; status: "completed" | "failed"; summary?: string }): Promise<ControlTask>;
  controlTasks(): Promise<{ tasks: ControlTask[]; session: ControlSession }>;
  observeScreen(options: { taskId?: string; app?: string }): Promise<ControlObservation>;
  controlAct(options: ControlActRequest): Promise<ControlActResult>;
  runningApps(): Promise<{ apps: Array<{ name: string; bundleId: string; active: boolean }> }>;
  focusApp(options: { app: string; taskId?: string }): Promise<{ app: string; frontmost: boolean }>;
  quitApp(options: { app: string; taskId?: string }): Promise<{ app: string; quit: boolean; note?: string }>;
  controlWindow(options: { app?: string; index?: number; action: "raise" | "minimize" | "restore" | "fullscreen" | "close" | "move" | "resize"; x?: number; y?: number; width?: number; height?: number; taskId?: string }): Promise<{ app: string; window: string; action: string; confirmed: boolean; windows: Array<{ index: number; title: string; minimized: boolean }> }>;
  /** The desktop app itself: version, update channel and checks, tray, shortcut, hannah:// links. */
  desktopInfo(): Promise<DesktopInfo>;
  setUpdateChannel(options: { channel: UpdateChannel }): Promise<DesktopInfo>;
  checkForUpdates(): Promise<{ available: boolean; version?: string; outcome: string }>;
}

export type WebPageRead = { title: string; url: string; description: string; text: string; textTruncated: boolean; links: Array<{ text: string; href: string }>; status: number | null; loadedInMs: number; screenshot?: string | null };

export type ScreenSessionState = { state: "inactive" | "observing" | "paused"; startedAt: number | null; expiresAt: number | null; captures: number };
export type ScreenStatus = ScreenSessionState & { permission: string; platform: string };
export type ScreenCapture = { image: string; mediaType: "image/jpeg" | "image/png"; width: number; height: number; windows: string[]; capturedAt: number; session: ScreenSessionState };
export type InstalledApp = { id: string; name: string };
export type AllowedApp = { id: string; name: string; addedAt: number };
export type AppLaunch = { app: InstalledApp; folder: string | null; verified: boolean | null; alreadyRunning: boolean; outcome: string; project?: { loaded: boolean | null; windowTitle?: string; windowTitles?: string[]; reason?: string } };
export type StartupStep = { kind: "app"; app: InstalledApp; folderId?: string } | { kind: "url"; url: string } | { kind: "wait"; seconds: number };
export type StartupRun = { at: number; trigger: "login" | "manual"; ok: boolean; steps: Array<{ label: string; ok: boolean; detail?: string }> };
export type StartupSettings = { enabled: boolean; steps: Array<StartupStep & { label: string }>; history: StartupRun[]; loginItem: { openAtLogin: boolean; status: string; where: string } | null };

export type BrowserElement = { ref: string; role: string; name: string; type?: string; href?: string; value?: string; submits?: boolean; search?: boolean; sensitive?: boolean; inView?: boolean };
export type BrowserPage = { title: string; url: string; text: string; textTruncated: boolean; status?: number | null; navigated?: boolean; elements: BrowserElement[]; scrolledTo?: number; pageHeight?: number };
export type YouTubeResults = { url: string; title: string; results: Array<{ title: string; url: string; channel: string; duration: string; details: string }> };
export type YouTubeVideo = { url: string; title: string; channel: string; description: string; transcriptAvailable: boolean; transcript: string; transcriptTruncated: boolean; coveredUntil: string | null; videoLength: string | null; segments: number; timestamps: string[]; parts?: Array<{ from: string; to: string; text: string }>; reason?: string };
export type SavedPdf = { folder: string; path: string; bytes: number; pages: number; verified: boolean; transcriptBased: boolean; outcome: string };

export type ControlSession = { state: "inactive" | "controlling" | "paused"; startedAt: number | null; expiresAt: number | null; reason?: string; stopShortcut: string };
export type ControlStatus = { platform: string; available: boolean; reason: string | null; accessibility: boolean | null; screenRecording: boolean | null; frontmost: { name: string } | null; session: ControlSession };
export type ControlElement = { path: string; role: string; label?: string; value?: string; secure?: boolean; enabled?: boolean; focused?: boolean; selected?: boolean; actions?: string[]; frame?: { x: number; y: number; width: number; height: number } };
export type ControlObservation = {
  observationId: string; observedAt: number;
  app: { name: string; bundleId: string } | null;
  window: { title: string; index: number; frame?: { x: number; y: number; width: number; height: number } } | null;
  windows: Array<{ index: number; title: string; minimized: boolean }>;
  focused: { role: string; label?: string; secure?: boolean } | null;
  dialogs: string[]; errors: string[]; text: string; elements: ControlElement[]; truncated: boolean; note?: string;
};
export type ControlAction = "press" | "show-menu" | "focus" | "set-value" | "select-text" | "increment" | "decrement" | "click" | "double-click" | "right-click" | "scroll" | "drag" | "type" | "key";
export type ControlActRequest = { taskId: string; observationId: string; action: ControlAction; path?: string; text?: string; key?: string; modifiers?: string[]; x?: number; y?: number; dx?: number; dy?: number; fromX?: number; fromY?: number; toX?: number; toY?: number; location?: number; length?: number };
export type ControlStep = { at: number; kind: "observation" | "action"; action?: string; status?: "action-attempted" | "action-confirmed" | "failed" | "denied"; target?: { app?: string; window?: string; element?: string | null }; verification?: { confirmed: boolean; evidence: string; changes?: string[] }; result?: unknown };
export type ControlTask = { id: string; request: string; plan: string[]; status: "planned" | "executing" | "waiting-approval" | "completed" | "failed" | "cancelled"; createdAt: number; finishedAt: number | null; actions: ControlStep[]; observations: number; failure: string | null; summary: string | null };
export type ControlActResult = Partial<ControlObservation> & { taskId: string; action: ControlAction; status: "action-attempted" | "action-confirmed"; verification?: { confirmed: boolean; evidence: string; changes?: string[] }; note: string };

export type UpdateChannel = "stable" | "beta";
export type DesktopInfo = {
  version: string;
  packaged: boolean;
  platform: string;
  channel: UpdateChannel;
  /** The updater accepts pre-releases (the beta channel). */
  prerelease: boolean;
  lastUpdateCheck: { at: number; outcome: string; version?: string } | null;
  updateHistory: Array<{ version: string; at: number }>;
  shortcut: { accelerator: string; registered: boolean };
  tray: boolean;
  appIcon?: boolean;
  deepLinks: { scheme: string; screens: string[]; registered: boolean };
};

// No web implementation on purpose: on custom platforms such as Electron,
// Capacitor prefers a web implementation over the native bridge, which would
// hide the real plugin. Everything that calls this checks
// desktopFilesAvailable() first.
let plugin: HannahDesktopPlugin | undefined;
/** The plugin, registered on first use so importing this file has no side effects. */
export function hannahDesktop() {
  plugin ??= registerPlugin<HannahDesktopPlugin>("HannahDesktop");
  return plugin;
}

export function desktopFilesAvailable() {
  return Capacitor.getPlatform() === "electron";
}

/** Find a shared folder by id or by name (case-insensitive). */
async function resolveFolder(value: unknown) {
  const wanted = String(value ?? "").trim();
  const { folders } = await hannahDesktop().listFolders();
  if (!folders.length) throw new Error("No folders are shared with HANNAH yet. Add one in Settings → Desktop access.");
  const folder = folders.find((item) => item.id === wanted) ?? folders.find((item) => item.name.toLowerCase() === wanted.toLowerCase()) ?? (wanted ? undefined : folders.length === 1 ? folders[0] : undefined);
  if (!folder) throw new Error(`“${wanted}” isn't a shared folder. Shared folders: ${folders.map((item) => item.name).join(", ")}.`);
  return folder;
}

const MAX_OUTPUT_TO_MODEL = 12_000;
const clip = (text: string) => (text.length > MAX_OUTPUT_TO_MODEL ? `${text.slice(0, MAX_OUTPUT_TO_MODEL)}\n… (shortened)` : text);

const folderProp = { type: "string", description: "Name or id of a shared folder (see desktop_folders). Optional when only one folder is shared." };

const desktopTools: HANNAHTool[] = [
  {
    name: "desktop_folders",
    description: "List the folders on this computer that the user shared with HANNAH, and whether each is read-only or read-write.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const { folders } = await hannahDesktop().listFolders();
      return { folders: folders.map(({ id, name, access }) => ({ id, name, access })), note: folders.length ? undefined : "No folders are shared. Ask the user to add one in Settings → Desktop access." };
    },
  },
  {
    name: "desktop_list_files",
    description: "List files and subfolders inside a folder the user shared with HANNAH on this computer.",
    inputSchema: { type: "object", properties: { folder: folderProp, path: { type: "string", description: "Optional path relative to the shared folder." } } },
    execute: async (args) => {
      const folder = await resolveFolder(args.folder);
      return hannahDesktop().listDirectory({ folderId: folder.id, path: typeof args.path === "string" ? args.path : "" });
    },
  },
  {
    name: "desktop_read_file",
    description: "Read a text file (up to 256 KB) from a folder the user shared with HANNAH. In cloud mode the contents go to the selected AI provider.",
    inputSchema: { type: "object", properties: { folder: folderProp, path: { type: "string", description: "File path relative to the shared folder." } }, required: ["path"] },
    execute: async (args) => {
      const folder = await resolveFolder(args.folder);
      const result = await hannahDesktop().readFile({ folderId: folder.id, path: String(args.path ?? "") });
      return { ...result, content: clip(result.content) };
    },
  },
  {
    name: "desktop_write_file",
    asksUser: true,
    description: "Create or replace a text file (up to 1 MB) in a read-write folder the user shared. The user confirms every write in a system dialog that shows the path and content.",
    inputSchema: {
      type: "object",
      properties: { folder: folderProp, path: { type: "string", description: "File path relative to the shared folder." }, content: { type: "string", description: "The complete new file content." } },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const folder = await resolveFolder(args.folder);
      return hannahDesktop().writeFile({ folderId: folder.id, path: String(args.path ?? ""), content: String(args.content ?? "") });
    },
  },
  {
    name: "desktop_run_command",
    asksUser: true,
    description: "Run one program (for example `npm test`, `git status`, `python script.py`) inside a shared folder and return its output. No shell: pipes, redirects, `&&` and variables aren't supported. The user approves each command in a system dialog; it times out after 60 seconds.",
    inputSchema: {
      type: "object",
      properties: { folder: folderProp, command: { type: "string", description: "The command line, such as `git status`." }, path: { type: "string", description: "Optional subfolder to run it in." } },
      required: ["command"],
    },
    execute: async (args) => {
      const folder = await resolveFolder(args.folder);
      const result = await hannahDesktop().runCommand({ folderId: folder.id, command: String(args.command ?? ""), path: typeof args.path === "string" ? args.path : "" });
      return { ...result, stdout: clip(result.stdout), stderr: clip(result.stderr) };
    },
  },
];

/** The desktop tools, only in the desktop app. */
export function getDesktopFileTools(): HANNAHTool[] {
  return desktopFilesAvailable() ? desktopTools : [];
}

export const DESKTOP_TOOL_NAMES = desktopTools.map((tool) => tool.name);

/**
 * The desktop tools held to one shared folder, for a task a workflow sent:
 * the person approved that folder, so the agent can't read another one.
 * Writes and commands still ask in the system dialog (the plugin enforces it).
 */
export function scopedDesktopTools(folder: { id: string; name: string; access: FolderAccess }, { allowCommands }: { allowCommands: boolean }): HANNAHTool[] {
  return desktopTools
    .filter((tool) => allowCommands || tool.name !== "desktop_run_command")
    .filter((tool) => folder.access === "read-write" || tool.name !== "desktop_write_file")
    .map((tool) => tool.name === "desktop_folders"
      ? { ...tool, description: "The one folder this task may use.", execute: async () => ({ folders: [{ id: folder.id, name: folder.name, access: folder.access }] }) }
      : { ...tool, description: `${tool.description} This task may only use the folder “${folder.name}”.`, execute: (args) => tool.execute({ ...args, folder: folder.id }) });
}
