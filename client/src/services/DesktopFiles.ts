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
  /** The desktop app itself: version, update channel and checks, tray, shortcut, hannah:// links. */
  desktopInfo(): Promise<DesktopInfo>;
  setUpdateChannel(options: { channel: UpdateChannel }): Promise<DesktopInfo>;
  checkForUpdates(): Promise<{ available: boolean; version?: string; outcome: string }>;
}

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
