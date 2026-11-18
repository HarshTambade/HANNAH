// Electron side of the HannahDesktop Capacitor plugin. One instance lives in
// the main process; the web page reaches only the methods in BRIDGED_METHODS.
// Native dialogs come from here, so web content can't fake an approval.
import { app, BrowserWindow, desktopCapturer, dialog, Notification, screen, session, shell, systemPreferences } from "electron";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppLauncher } from "./apps.mjs";
import { createPageLoader } from "./browse.mjs";
import { BRIDGED_METHODS, createDesktopTools } from "./core.mjs";

const parentWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
const LOGIN_FLAG = "--hannah-login";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function screenPermission() {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("screen");
}

/**
 * One screenshot of the display the pointer is on, as a JPEG no larger than
 * 1568 px on its long side. HANNAH's own windows are hidden for a moment so
 * the picture shows what you're looking at, not the chat.
 */
async function captureScreen() {
  // Denied or restricted: don't try (macOS answers with an error, not a picture).
  // Not determined: trying is what makes macOS ask.
  const before = screenPermission();
  if (before === "denied" || before === "restricted") return { permission: before };
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const ours = BrowserWindow.getAllWindows().filter((window) => window.isVisible() && !window.isMinimized());
  const focused = BrowserWindow.getFocusedWindow();
  const ownSources = new Set(BrowserWindow.getAllWindows().map((window) => { try { return window.getMediaSourceId(); } catch { return ""; } }));
  ours.forEach((window) => window.hide());
  try {
    if (ours.length) await wait(350);
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    } catch {
      return { permission: screenPermission() === "granted" ? "unavailable" : screenPermission() };
    }
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    const windows = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    if (screenPermission() !== "granted" || !source || source.thumbnail.isEmpty()) return { permission: screenPermission() === "granted" ? "unavailable" : screenPermission() };
    const image = source.thumbnail.toJPEG(72).toString("base64");
    const names = windows.filter((item) => !ownSources.has(item.id) && item.name && item.name !== "HANNAH").map((item) => item.name.slice(0, 160));
    return { permission: "granted", image, mediaType: "image/jpeg", width: thumbnailSize.width, height: thumbnailSize.height, windows: [...new Set(names)] };
  } finally {
    ours.forEach((window) => (window === focused ? window.show() : window.showInactive()));
  }
}

// Start at login. macOS and Windows use the system's login items; Linux uses
// an XDG autostart entry (~/.config/autostart), the documented mechanism.
const linuxAutostart = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "hannah.desktop");
const devLoginItemBlocked = () => !app.isPackaged && process.env.HANNAH_ALLOW_DEV_LOGIN_ITEM !== "1";
const loginItem = {
  async get() {
    if (process.platform === "linux") {
      const exists = await fsp.access(linuxAutostart()).then(() => true, () => false);
      return { openAtLogin: exists, status: exists ? "enabled" : "not-registered", where: linuxAutostart() };
    }
    const settings = app.getLoginItemSettings({ args: [LOGIN_FLAG] });
    return { openAtLogin: settings.openAtLogin, status: settings.status ?? (settings.openAtLogin ? "enabled" : "not-registered"), where: process.platform === "darwin" ? "System Settings → General → Login Items" : "Settings → Apps → Startup" };
  },
  async set(enabled) {
    if (enabled && devLoginItemBlocked()) throw new Error("Starting at login works in the installed HANNAH app, not a development copy.");
    if (process.platform === "linux") {
      if (!enabled) { await fsp.rm(linuxAutostart(), { force: true }); return; }
      const exec = process.env.APPIMAGE || process.execPath;
      const quoted = `"${exec.replace(/(["`$\\])/g, "\\$1")}"`;
      await fsp.mkdir(path.dirname(linuxAutostart()), { recursive: true });
      await fsp.writeFile(linuxAutostart(), `[Desktop Entry]\nType=Application\nName=HANNAH\nComment=Starts HANNAH and your startup routine\nExec=${quoted} ${LOGIN_FLAG}\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o644 });
      return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: [LOGIN_FLAG] });
  },
};

const launchedAtLogin = () => process.argv.includes(LOGIN_FLAG) || (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true);

class HannahDesktopImpl {
  constructor(context) {
    this.context = context;
    this.tools = null;
  }

  async load() {
    this.tools = createDesktopTools({
      storePath: path.join(app.getPath("userData"), "desktop-access.json"),
      chooseFolder: async () => {
        const result = await dialog.showOpenDialog(parentWindow(), {
          title: "Choose a folder for HANNAH",
          buttonLabel: "Share with HANNAH",
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      confirm: async ({ title, message, detail, buttons }) => {
        const result = await dialog.showMessageBox(parentWindow(), {
          type: "warning",
          title,
          message,
          detail,
          buttons,
          defaultId: buttons.length - 1,
          cancelId: buttons.length - 1,
          noLink: true,
        });
        return result.response;
      },
      // Workflow page reads: a hidden, signed-out window (browse.mjs).
      loadPage: createPageLoader({ BrowserWindow, session }),
      reveal: async (folder) => {
        const error = await shell.openPath(folder);
        if (error) throw new Error(error);
      },
      screenPermission,
      captureScreen,
      onScreenSession: (state) => globalThis.__hannahMain?.setScreenIndicator?.(state),
      openScreenSettings: async () => {
        if (process.platform === "darwin") await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      },
      apps: createAppLauncher({
        platform: process.platform,
        home: os.homedir(),
        env: process.env,
        readShortcut: process.platform === "win32" ? (file) => shell.readShortcutLink(file) : undefined,
        openPath: (file) => shell.openPath(file),
      }),
      loginItem,
      openUrl: (url) => shell.openExternal(url),
      notify: ({ title, body }) => { if (Notification.isSupported()) new Notification({ title, body }).show(); },
    });
    // The tray menu (main.ts) can stop or pause screen viewing.
    globalThis.__hannahDesktopTools = this.tools;
    if (launchedAtLogin()) {
      // Let the desktop settle before opening apps.
      setTimeout(() => { void this.tools.runStartupRoutine({ trigger: "login" }).catch((error) => console.error("HANNAH's startup routine failed:", error?.message ?? error)); }, 5000);
    }
  }
}

for (const method of BRIDGED_METHODS) {
  HannahDesktopImpl.prototype[method] = function bridged(options) {
    return this.tools[method](options ?? {});
  };
}

// The desktop app itself (main.ts): update channel, update checks, tray and shortcut state.
const main = () => globalThis.__hannahMain ?? null;
HannahDesktopImpl.prototype.desktopInfo = async function desktopInfo() {
  const api = main();
  if (!api) throw new Error("The desktop app isn't available.");
  return api.desktopInfo();
};
HannahDesktopImpl.prototype.setUpdateChannel = async function setUpdateChannel(options) {
  const api = main();
  if (!api) throw new Error("The desktop app isn't available.");
  return api.setUpdateChannel(options?.channel);
};
HannahDesktopImpl.prototype.checkForUpdates = async function checkForUpdates() {
  const api = main();
  if (!api) throw new Error("The desktop app isn't available.");
  return api.checkForUpdates();
};
const DESKTOP_METHODS = ["desktopInfo", "setUpdateChannel", "checkForUpdates"];

HannahDesktopImpl.__capacitorElectronPlugin = { name: "HannahDesktop", methods: [...BRIDGED_METHODS, ...DESKTOP_METHODS] };

export { HannahDesktopImpl as HannahDesktop };
