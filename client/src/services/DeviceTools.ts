import { AppLauncher } from "@capacitor/app-launcher";
import { Capacitor } from "@capacitor/core";
import { Device } from "@capacitor/device";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Network } from "@capacitor/network";
import type { DeviceTool as MobileClawTool } from "capacitor-mobile-claw";
import { HITLDeniedError, SafetyGuard, type SensitiveAction } from "./SafetyGuard";
import { ReminderService, resolveDueAt } from "./ReminderService";
import { MemoryService } from "./MemoryService";
import { CATEGORY_LABELS, SOURCE_LABELS } from "./MemoryModel";
import { notifyMemoryChanged } from "./MemoryStore";
import { getDesktopFileTools } from "./DesktopFiles";
import { getConnectionTools } from "./Connections";

export type ToolSchema = {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
};

export type HANNAHTool = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  requiresApproval?: boolean;
  sensitive?: SensitiveAction;
  /** What the approval card shows, when it isn't the raw arguments. */
  approvalDetails?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** The tool itself waits for the user's yes (a system dialog), without HANNAH's approval card. */
  asksUser?: boolean;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

const deviceTools: HANNAHTool[] = [
  {
    name: "list_app_files",
    description: "List files and directories in HANNAH's private app Documents area. This cannot access other apps or arbitrary device paths.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Optional relative folder path; omit to list the app Documents root." } },
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path, true);
      const result = await Filesystem.readdir({ path, directory: Directory.Data });
      return {
        path: path || ".",
        totalEntries: result.files.length,
        truncated: result.files.length > 200,
        files: result.files.slice(0, 200).map(({ name, type, size }) => ({ name, type, size })),
      };
    },
  },
  {
    name: "read_app_file",
    description: "Read a UTF-8 text file up to 128 KB from HANNAH's private app Documents area. Cloud-mode file contents are sent to the selected model provider.",
    requiresApproval: true,
    sensitive: "read_file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path inside HANNAH's app Documents area." } },
      required: ["path"],
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path);
      const stat = await Filesystem.stat({ path, directory: Directory.Data });
      if (stat.type !== "file") throw new Error("Only files can be read.");
      if (stat.size > 128_000) throw new Error("The file exceeds the 128 KB read limit.");
      const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      const content = typeof data === "string" ? data : await data.text();
      return { path, content };
    },
  },
  {
    name: "write_app_file",
    description: "Create or replace a UTF-8 text file up to 1 MB inside HANNAH's private app Documents area. Always requires user confirmation.",
    requiresApproval: true,
    sensitive: "write_file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path inside HANNAH's app Documents area." },
        content: { type: "string", description: "Exact UTF-8 text content to write." },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path);
      if (typeof args.content !== "string") throw new Error("File content must be text.");
      const bytes = new TextEncoder().encode(args.content).byteLength;
      if (bytes > 1_000_000) throw new Error("The file exceeds the 1 MB write limit.");
      await Filesystem.writeFile({
        path,
        data: args.content,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      return { ok: true, path, bytesWritten: bytes };
    },
  },
  {
    name: "delete_app_file",
    description: "Delete a file from HANNAH's private app Documents area. Directories and paths outside app storage are not allowed. Always requires user confirmation.",
    requiresApproval: true,
    sensitive: "delete_file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative file path inside HANNAH's app Documents area." } },
      required: ["path"],
    },
    execute: async (args) => {
      const path = safeDocumentPath(args.path);
      const stat = await Filesystem.stat({ path, directory: Directory.Data });
      if (stat.type !== "file") throw new Error("Directories cannot be deleted with this tool.");
      await Filesystem.deleteFile({ path, directory: Directory.Data });
      return { ok: true, path, deleted: true };
    },
  },
  {
    name: "open_app",
    description: "Open a supported app or public web page. Use make_call for a phone number and send_message for a text draft.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", enum: ["browser", "maps", "phone", "messages", "settings"], description: "Which app or system surface to open." },
        url: { type: "string", description: "Optional public HTTPS URL; only used with app=browser." },
        query: { type: "string", description: "Optional search phrase; only used with app=maps." },
      },
      required: ["app"],
    },
    execute: async (args) => {
      const app = String(args.app ?? "");
      if (app === "browser") {
        const target = String(args.url ?? "https://www.google.com");
        const parsed = new URL(target);
        if (parsed.protocol !== "https:") throw new Error("Only HTTPS browser links are allowed.");
        await AppLauncher.openUrl({ url: parsed.toString() });
        return { ok: true, message: "Opened the requested HTTPS page." };
      }
      if (app === "settings") {
        await AppLauncher.openUrl({ url: "app-settings:" });
        return { ok: true, message: "Opened HANNAH's app settings." };
      }
      if (app === "maps") {
        const query = String(args.query ?? "").trim();
        const url = query ? `geo:0,0?q=${encodeURIComponent(query)}` : "geo:0,0";
        await AppLauncher.openUrl({ url });
        return { ok: true, message: "Opened the system maps app." };
      }
      if (app === "phone" || app === "messages") {
        throw new Error("Use the confirmed make_call or send_message tool to prepare a phone action.");
      }
      throw new Error("That app is not in HANNAH's supported app list.");
    },
  },
  {
    name: "make_call",
    description: "After confirmation, open the phone dialer with the requested number. The user must tap Call.",
    requiresApproval: true,
    sensitive: "make_call",
    inputSchema: {
      type: "object",
      properties: { recipient: { type: "string", description: "Phone number including country code where possible." } },
      required: ["recipient"],
    },
    execute: async (args) => {
      const recipient = String(args.recipient ?? "").trim();
      if (!/^\+?[0-9 ().-]{3,24}$/.test(recipient)) throw new Error("Enter a valid phone number.");
      await AppLauncher.openUrl({ url: `tel:${recipient.replace(/[ ().-]/g, "")}` });
      return { ok: true, message: "Opened the phone dialer. Review the number and tap Call." };
    },
  },
  {
    name: "toggle_setting",
    description: "After explicit confirmation, toggle the flashlight. Wi-Fi and Bluetooth toggles are blocked by iOS and Android; report how the user can change them manually.",
    requiresApproval: true,
    sensitive: "toggle_setting",
    inputSchema: {
      type: "object",
      properties: {
        setting: { type: "string", enum: ["flashlight", "wifi", "bluetooth"] },
        enabled: { type: "boolean", description: "Desired on/off state." },
      },
      required: ["setting", "enabled"],
    },
    execute: async (args) => {
      const setting = String(args.setting ?? "");
      const enabled = Boolean(args.enabled);
      if (setting === "wifi" || setting === "bluetooth") {
        return { ok: false, message: `The operating system does not let HANNAH toggle ${setting} directly. Use Control Center or Quick Settings to turn it ${enabled ? "on" : "off"}.` };
      }
      if (setting !== "flashlight") throw new Error("Unsupported setting.");
      if (!Capacitor.isNativePlatform()) throw new Error("Flashlight control requires the iOS or Android app.");
      const { Torch } = await import("@capawesome/capacitor-torch");
      const available = await Torch.isAvailable();
      if (!available.available) throw new Error("This device does not have an available flashlight.");
      if (enabled) await Torch.enable();
      else await Torch.disable();
      return { ok: true, message: `Flashlight turned ${enabled ? "on" : "off"}.` };
    },
  },
  {
    name: "send_message",
    description: "After confirmation, open the SMS composer with the exact recipient and text. The user must tap Send.",
    requiresApproval: true,
    sensitive: "send_message",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Phone number including country code where possible." },
        message: { type: "string", description: "Exact SMS body to prepare." },
      },
      required: ["recipient", "message"],
    },
    execute: async (args) => {
      const recipient = String(args.recipient ?? "").trim();
      const message = String(args.message ?? "").trim();
      if (!/^\+?[0-9 ().-]{3,24}$/.test(recipient)) throw new Error("Enter a valid phone number for the SMS draft.");
      if (!message || message.length > 2000) throw new Error("The message must contain 1 to 2,000 characters.");
      await AppLauncher.openUrl({ url: `sms:${recipient.replace(/[ ().-]/g, "")}?body=${encodeURIComponent(message)}` });
      return { ok: true, message: "Opened the SMS draft. Review it and tap Send in your messaging app." };
    },
  },
  {
    name: "get_device_status",
    description: "Read basic device platform, operating system, online state, and connection type. Does not access device identifiers or personal files.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const [info, network] = await Promise.all([Device.getInfo(), Network.getStatus()]);
      return {
        platform: info.platform,
        operatingSystem: info.operatingSystem,
        osVersion: info.osVersion,
        isVirtual: info.isVirtual,
        online: network.connected,
        connectionType: network.connectionType,
      };
    },
  },
  {
    name: "get_battery_status",
    description: "Read the device battery percentage and charging status.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const info = await Device.getBatteryInfo();
      return {
        batteryPercent: typeof info.batteryLevel === "number" ? Math.round(info.batteryLevel * 100) : null,
        charging: info.isCharging ?? null,
      };
    },
  },
  {
    name: "create_reminder",
    // A getter so the model always sees the current local time.
    get description() {
      const now = new Date();
      return `Create a reminder that alerts the user in HANNAH at a set time. Current local time: ${now.toString()} (ISO ${now.toISOString()}). Use in_minutes for relative times ("in 20 minutes"), or due_at as ISO 8601 with the user's UTC offset for a clock time.`;
    },
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about, in their words." },
        in_minutes: { type: "number", description: "Minutes from now." },
        due_at: { type: "string", description: "ISO 8601 date-time with offset, e.g. 2026-11-17T09:00:00+05:30." },
      },
      required: ["text"],
    },
    execute: async (args) => {
      const reminder = ReminderService.create(String(args.text ?? ""), resolveDueAt(args));
      return { created: true, id: reminder.id, text: reminder.text, dueAt: new Date(reminder.dueAt).toString() };
    },
  },
  {
    name: "list_reminders",
    description: "List the user's upcoming reminders with their ids and due times.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({
      reminders: ReminderService.upcoming().map((item) => ({ id: item.id, text: item.text, dueAt: new Date(item.dueAt).toString() })),
    }),
  },
  {
    name: "cancel_reminder",
    description: "Cancel one upcoming reminder by id. Call list_reminders first to find the id.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Reminder id from list_reminders." } }, required: ["id"] },
    execute: async (args) => {
      const cancelled = ReminderService.cancel(String(args.id ?? ""));
      if (!cancelled) throw new Error("No reminder has that id.");
      return { cancelled: true, text: cancelled.text };
    },
  },
  {
    name: "search_memories",
    description: "Search the facts the user asked HANNAH to remember on this device. Returns the best matches first, with each memory's category and where it came from. Sensitive memories are never returned here.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for. Leave empty to list recent memories." } } },
    execute: async (args) => {
      const result = MemoryService.search(String(args.query ?? "").slice(0, 300));
      if (result.off) return { memories: [], note: "The user turned memory off." };
      return {
        memories: result.memories.map((record) => ({ id: record.id, content: record.content, category: CATEGORY_LABELS[record.category], source: SOURCE_LABELS[record.source.kind], savedAt: record.createdAt })),
        ...(result.hiddenSensitive ? { note: `${result.hiddenSensitive} sensitive memor${result.hiddenSensitive === 1 ? "y is" : "ies are"} not shared through this tool.` } : {}),
      };
    },
  },
  {
    name: "save_memory",
    description: "Save one fact the user explicitly asked HANNAH to remember. The user approves each save.",
    inputSchema: { type: "object", properties: { content: { type: "string", description: "The fact, in one short sentence (up to 300 characters)." } }, required: ["content"] },
    requiresApproval: true,
    sensitive: "store_memory",
    execute: async (args) => {
      const content = String(args.content ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, 300);
      const result = MemoryService.remember(content, { source: { kind: "assistant" } });
      if (!result.ok) throw new Error(result.reason);
      notifyMemoryChanged();
      return { saved: true, id: result.record.id, content: result.record.content, category: CATEGORY_LABELS[result.record.category], ...(result.merged ? { note: "This updated a memory that said nearly the same thing." } : {}) };
    },
  },
];

function safeDocumentPath(value: unknown, allowRoot = false) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw && allowRoot) return "";
  const path = raw.replaceAll("\\", "/");
  const segments = path.split("/");
  if (!path || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("Use a relative path inside HANNAH's app Documents area; parent and absolute paths are blocked.");
  }
  return segments.join("/");
}

// Tools from outside MCP servers, registered at runtime (see McpTools.ts).
let externalTools: HANNAHTool[] = [];

export function setExternalTools(tools: HANNAHTool[]) {
  externalTools = tools.filter((tool) => tool.requiresApproval && tool.sensitive);
}

export function getDeviceTools() {
  const desktop = getDesktopFileTools();
  const connections = getConnectionTools();
  return desktop.length || connections.length || externalTools.length ? [...deviceTools, ...desktop, ...connections, ...externalTools] : deviceTools;
}

/**
 * The only way HANNAH runs a tool: GuardianAgent reviews every call, then
 * tools that change something also need the user's explicit confirmation.
 */
export async function executeHANNAHTool(tool: HANNAHTool, args: Record<string, unknown>, context: { intent?: string } = {}) {
  SafetyGuard.screen(tool.name, args, context.intent);
  if (tool.requiresApproval) {
    if (!tool.sensitive) throw new Error(`The approval-required tool "${tool.name}" has no SafetyGuard action configured.`);
    if (!await SafetyGuard.confirm(tool.sensitive, tool.approvalDetails ? tool.approvalDetails(args) : args)) throw new HITLDeniedError();
  }
  return tool.execute(args);
}

export function getMobileClawTools(): MobileClawTool[] {
  return deviceTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (args) => {
      return executeHANNAHTool(tool, args);
    },
  }));
}
