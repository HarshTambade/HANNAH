import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from "electron";
// A named import: electron-updater is compiled with __esModule and has no
// default export, so a default import is undefined at runtime and crashed the
// app on launch in 1.3.0.
import { autoUpdater } from "electron-updater";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCapacitorElectronApp } from "@capawesome/capacitor-electron";
import config from "./capacitor.electron.config";
const REPOSITORY = "https://github.com/HarshTambade/Shanaya-Your-AI-companion";
const isMac = process.platform === "darwin";
/** The one global shortcut: bring HANNAH to the front on the chat screen. */
const TALK_SHORTCUT = "CommandOrControl+Shift+H";
/** `hannah://<screen>` links open one of these screens; anything else is ignored. */
const DEEP_LINK_SCREENS: Record<string, string> = {
  chat: "/chat", dashboard: "/dashboard", agents: "/agents", models: "/models", memory: "/memory",
  automations: "/automations", settings: "/settings", marketplace: "/marketplace", integrations: "/integrations",
};
type UpdateChannel = "stable" | "beta";
type UpdateSettings = { channel: UpdateChannel };
type UpdateHistoryEntry = { version: string; at: number };

// Links and sign-in pages (Google and Microsoft refuse sign-in inside an app's
// web view) open in the system browser; the app never opens new windows itself.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
});

// Windows shows notifications (reminders) only for an app whose identity
// matches its installer; electron-builder uses the appId for it.
if (process.platform === "win32") app.setAppUserModelId("com.hannah.companion");

// ---------- settings kept in the app's data folder (never in the web page) ----------

function dataFile(name: string) {
  const folder = app.getPath("userData");
  mkdirSync(folder, { recursive: true });
  return path.join(folder, name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return existsSync(dataFile(name)) ? (JSON.parse(readFileSync(dataFile(name), "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown) {
  try {
    writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
  } catch {
    // The setting still applies for this run.
  }
}

function readUpdateSettings(): UpdateSettings {
  const saved = readJson<Partial<UpdateSettings>>("update-settings.json", {});
  return { channel: saved.channel === "beta" ? "beta" : "stable" };
}

/** Versions this installation has run, newest first (the update history). */
function recordVersion(): UpdateHistoryEntry[] {
  const history = readJson<UpdateHistoryEntry[]>("update-history.json", []).filter((entry) => entry && typeof entry.version === "string");
  if (history[0]?.version !== app.getVersion()) {
    history.unshift({ version: app.getVersion(), at: Date.now() });
    writeJson("update-history.json", history.slice(0, 50));
  }
  return history;
}

// ---------- updates ----------

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;
let updateSettings = readUpdateSettings();
// Beta: releases marked as pre-releases on GitHub (tags such as v1.5.0-beta.1).
autoUpdater.allowPrerelease = updateSettings.channel === "beta";
let lastUpdateCheck: { at: number; outcome: string; version?: string } | null = null;

function applyUpdateChannel(channel: UpdateChannel) {
  updateSettings = { channel };
  autoUpdater.allowPrerelease = channel === "beta";
  writeJson("update-settings.json", updateSettings);
}

/** Tell the page (as a window event, the way its toast listens). */
function tellPage(event: string, detail: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.getURL().startsWith("capacitor-electron://")) continue;
    void window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}, { detail: ${JSON.stringify(detail)} }))`).catch(() => undefined);
  }
}

autoUpdater.on("update-available", (info) => {
  lastUpdateCheck = { at: Date.now(), outcome: "available", version: info.version };
});
autoUpdater.on("update-not-available", () => {
  lastUpdateCheck = { at: Date.now(), outcome: "up-to-date" };
});
autoUpdater.on("update-downloaded", (info) => {
  lastUpdateCheck = { at: Date.now(), outcome: "downloaded", version: info.version };
  tellPage("hannah:update-available", { version: info.version, channel: updateSettings.channel, releaseNotesUrl: `${REPOSITORY}/releases/tag/v${info.version}` });
});
autoUpdater.on("error", (error) => {
  lastUpdateCheck = { at: Date.now(), outcome: `failed: ${error?.message ?? "unknown error"}` };
});

async function checkForUpdates(): Promise<{ available: boolean; version?: string; outcome: string }> {
  if (!app.isPackaged) return { available: false, outcome: "development build: updates are checked in the installed app" };
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const available = Boolean(latest && latest !== app.getVersion());
    lastUpdateCheck = { at: Date.now(), outcome: available ? "available" : "up-to-date", ...(latest ? { version: latest } : {}) };
    return { available, outcome: lastUpdateCheck.outcome, ...(latest ? { version: latest } : {}) };
  } catch (error) {
    lastUpdateCheck = { at: Date.now(), outcome: `failed: ${error instanceof Error ? error.message : String(error)}` };
    return { available: false, outcome: lastUpdateCheck.outcome };
  }
}

async function checkForUpdatesInteractively() {
  if (!app.isPackaged) {
    await dialog.showMessageBox({ type: "info", message: "Updates are checked in the installed app.", detail: "This is a development build." });
    return;
  }
  const result = await checkForUpdates();
  if (result.outcome.startsWith("failed")) {
    await dialog.showMessageBox({ type: "warning", message: "HANNAH couldn't check for updates.", detail: "Check your connection, or download the latest release from GitHub." });
    return;
  }
  await dialog.showMessageBox({
    type: "info",
    message: result.available ? `HANNAH ${result.version} is available.` : "HANNAH is up to date.",
    detail: result.available ? "It's downloading now and installs when you quit HANNAH." : `You have version ${app.getVersion()}${updateSettings.channel === "beta" ? " (beta channel)" : ""}.`,
  });
}

// ---------- windows, screens and deep links ----------

function mainWindow() {
  return BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith("capacitor-electron://")) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function showWindow() {
  const window = mainWindow();
  if (!window) return null;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

/** Move the app to one of its screens without reloading it. */
function openScreen(path: string) {
  const window = showWindow();
  if (!window) return;
  // `path` is one of the fixed strings in the menu and DEEP_LINK_SCREENS, never user input.
  void window.webContents.executeJavaScript(
    `window.history.pushState(null, "", ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent("popstate"));`,
  );
}

/** A `hannah://` link: only a known screen name is acted on. Returns the screen path, or null. */
function openDeepLink(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "hannah:") return null;
  const screen = (parsed.hostname || parsed.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
  const path = DEEP_LINK_SCREENS[screen];
  if (!path) return null;
  openScreen(path);
  return path;
}

const deepLinkFromArgs = (argv: string[]) => argv.find((arg) => arg.startsWith("hannah://"));

// One running copy: a second launch (a double-clicked link on Windows or Linux) hands its link to the first.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkFromArgs(argv);
    if (!link || !openDeepLink(link)) showWindow();
  });
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) openDeepLink(url);
  else app.whenReady().then(() => openDeepLink(url));
});

// ---------- tray and shortcut ----------

let tray: Tray | null = null;

function trayIcon() {
  const assets = path.join(app.getAppPath(), "assets");
  const file = isMac ? "trayTemplate.png" : process.platform === "win32" ? "tray-16.png" : "tray-32.png";
  const image = nativeImage.createFromPath(path.join(assets, file));
  if (isMac) image.setTemplateImage(true);
  return image;
}

/** HANNAH's app icon (assets/icon.png, generated from public/icon.svg). */
function appIcon() {
  return nativeImage.createFromPath(path.join(app.getAppPath(), "assets", "icon.png"));
}

/**
 * Windows and Linux take the window and taskbar icon from the window itself
 * (the packaged .exe and .desktop icons come from electron-builder); a
 * development run on macOS would otherwise show Electron's icon in the Dock.
 */
function brandWindows() {
  const icon = appIcon();
  if (icon.isEmpty()) return;
  if (isMac) {
    if (!app.isPackaged) app.dock?.setIcon(icon);
    return;
  }
  for (const window of BrowserWindow.getAllWindows()) window.setIcon(icon);
  app.on("browser-window-created", (_event, window) => window.setIcon(icon));
}

function buildTray() {
  try {
    const icon = trayIcon();
    if (icon.isEmpty()) return;
    tray = new Tray(icon);
    tray.setToolTip("HANNAH");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open HANNAH", click: () => showWindow() },
      { label: "Talk to HANNAH", accelerator: TALK_SHORTCUT, click: () => openScreen("/chat") },
      { type: "separator" },
      { label: "Check for Updates…", click: () => void checkForUpdatesInteractively() },
      { type: "separator" },
      { label: isMac ? "Quit HANNAH" : "Exit", click: () => app.quit() },
    ]));
    tray.on("click", () => showWindow());
  } catch (error) {
    console.error("HANNAH couldn't add its tray icon.", error);
    tray = null;
  }
}

function buildMenu() {
  const separator: MenuItemConstructorOptions = { type: "separator" };
  const go: MenuItemConstructorOptions[] = [
    { label: "Chat", accelerator: "CmdOrCtrl+1", click: () => openScreen("/chat") },
    { label: "Dashboard", accelerator: "CmdOrCtrl+2", click: () => openScreen("/dashboard") },
    { label: "Agents", accelerator: "CmdOrCtrl+3", click: () => openScreen("/agents") },
    { label: "Models", accelerator: "CmdOrCtrl+4", click: () => openScreen("/models") },
    { label: "Memory and Style", accelerator: "CmdOrCtrl+5", click: () => openScreen("/memory") },
    { label: "Automations", accelerator: "CmdOrCtrl+6", click: () => openScreen("/automations") },
    separator,
    { label: "Marketplace", click: () => openScreen("/marketplace") },
    { label: "Integrations", click: () => openScreen("/integrations") },
    separator,
    { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory.goBack() },
    { label: "Forward", accelerator: isMac ? "Cmd+]" : "Alt+Right", click: () => BrowserWindow.getFocusedWindow()?.webContents.navigationHistory.goForward() },
  ];
  const settings: MenuItemConstructorOptions = { label: isMac ? "Settings…" : "Settings", accelerator: "CmdOrCtrl+,", click: () => openScreen("/settings") };
  const updates: MenuItemConstructorOptions = { label: "Check for Updates…", click: () => void checkForUpdatesInteractively() };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
        label: app.name,
        submenu: [
          { role: "about" },
          updates,
          separator,
          settings,
          separator,
          { role: "services" },
          separator,
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          separator,
          { role: "quit" },
        ],
      } as MenuItemConstructorOptions]
      : []),
    {
      label: isMac ? "File" : "&File",
      submenu: isMac ? [{ role: "close" }] : [settings, separator, { role: "quit", label: "Exit" }],
    },
    // Copy, paste, undo and select-all only work in Electron when an Edit menu provides them.
    { role: "editMenu" },
    {
      label: isMac ? "View" : "&View",
      submenu: [
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
        separator,
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        separator,
        { role: "togglefullscreen" },
      ],
    },
    { label: isMac ? "Go" : "&Go", submenu: [{ label: "Talk to HANNAH", accelerator: TALK_SHORTCUT, click: () => openScreen("/chat") }, separator, ...go] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(isMac ? [] : [updates, separator]),
        { label: "HANNAH Documentation", click: () => void shell.openExternal(`${REPOSITORY}#readme`) },
        { label: "Release Notes", click: () => void shell.openExternal(`${REPOSITORY}/releases`) },
        { label: "Report a Problem", click: () => void shell.openExternal(`${REPOSITORY}/issues/new`) },
        ...(isMac ? [] : [separator, { role: "about", label: "About HANNAH" } as MenuItemConstructorOptions]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** What the desktop app offers, for Settings → Desktop app and for checks. */
function desktopInfo() {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    channel: updateSettings.channel,
    prerelease: autoUpdater.allowPrerelease,
    lastUpdateCheck,
    updateHistory: readJson<UpdateHistoryEntry[]>("update-history.json", []),
    shortcut: { accelerator: TALK_SHORTCUT, registered: globalShortcut.isRegistered(TALK_SHORTCUT) },
    tray: tray !== null,
    // HANNAH's own icon loaded (assets/icon.png); the CI launch check fails without it.
    appIcon: !appIcon().isEmpty(),
    deepLinks: { scheme: "hannah", screens: Object.keys(DEEP_LINK_SCREENS), registered: app.isPackaged ? app.isDefaultProtocolClient("hannah") : false },
  };
}

// The HannahDesktop plugin (plugins/desktop-tools) reaches these; the web page can't call Electron directly.
(globalThis as Record<string, unknown>).__hannahMain = {
  desktopInfo,
  setUpdateChannel: (channel: unknown) => { applyUpdateChannel(channel === "beta" ? "beta" : "stable"); return desktopInfo(); },
  checkForUpdates,
  openDeepLink,
};

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: "HANNAH",
    applicationVersion: app.getVersion(),
    copyright: "© 2026 Harsh Tambade and HANNAH contributors",
    website: REPOSITORY,
    ...(isMac ? {} : { iconPath: path.join(app.getAppPath(), "assets", "icon.png") }),
  });
  brandWindows();
  buildMenu();
  buildTray();
  recordVersion();
  if (!globalShortcut.register(TALK_SHORTCUT, () => openScreen("/chat"))) console.error(`HANNAH couldn't register ${TALK_SHORTCUT}; another app holds it.`);
  // hannah:// links. Registered for the installed app only, so a development copy doesn't take over the scheme.
  if (app.isPackaged) app.setAsDefaultProtocolClient("hannah");
  const link = deepLinkFromArgs(process.argv);
  if (link) setTimeout(() => openDeepLink(link), 1500);
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("ready", () => {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdatesAndNotify().catch(() => {
    console.error("HANNAH could not check for desktop updates.");
  });
});

ipcMain.handle("hannah:check-for-updates", () => checkForUpdates());

// CI launch check: start, load the app page, print a marker and quit.
// Any crash on the way (like a bad import) fails the build instead of shipping.
if (process.env.HANNAH_SMOKE_TEST === "1") {
  // Also written to a file: Windows GUI apps don't always reach the console.
  const report = (line: string) => {
    console.log(line);
    if (process.env.HANNAH_SMOKE_FILE) {
      try {
        writeFileSync(process.env.HANNAH_SMOKE_FILE, `${line}\n`);
      } catch {
        // The console line is still there.
      }
    }
  };
  // CI's macOS machines are slow to start an unsigned app (two minutes isn't unusual), so CI sets a longer limit.
  const limitMs = Number(process.env.HANNAH_SMOKE_TIMEOUT_MS) > 0 ? Number(process.env.HANNAH_SMOKE_TIMEOUT_MS) : 60_000;
  const timer = setTimeout(() => {
    report(`HANNAH_SMOKE_FAIL: within ${Math.round(limitMs / 1000)} seconds the app page did not load or HannahDesktop did not answer.`);
    app.exit(1);
  }, limitMs);
  // Probe from the app page: the bridge works, the files-and-terminal plugin
  // answers, and the desktop info (tray, shortcut, update channel) is there.
  const probe = `(async () => {
    const plugin = window.Capacitor.registerPlugin("HannahDesktop");
    const result = await Promise.race([
      plugin.recentActivity(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("HannahDesktop didn't answer")), 15000)),
    ]);
    if (!Array.isArray(result?.activity)) throw new Error("HannahDesktop answered unexpectedly");
    const info = await plugin.desktopInfo();
    if (!info?.shortcut?.registered) throw new Error("the Talk to HANNAH shortcut isn't registered");
    if (!info.tray) throw new Error("the tray icon is missing");
    if (!info.appIcon) throw new Error("HANNAH's app icon (assets/icon.png) is missing");
    return document.title + " channel=" + info.channel;
  })()`;
  app.on("browser-window-created", (_event, window) => {
    // The splash screen is a window too; only the app page counts.
    window.webContents.on("did-finish-load", () => {
      if (!window.webContents.getURL().startsWith("capacitor-electron://")) return;
      window.webContents.executeJavaScript(probe).then((title) => {
        clearTimeout(timer);
        report(`HANNAH_SMOKE_OK ${app.getVersion()} "${title}"`);
        app.exit(0);
      }, (error: unknown) => {
        report(`HANNAH_SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
        app.exit(1);
      });
    });
    window.webContents.once("did-fail-load", (_e, code, description, url) => {
      if (!url.startsWith("capacitor-electron://")) return;
      report(`HANNAH_SMOKE_FAIL: ${code} ${description}`);
      app.exit(1);
    });
  });
}

createCapacitorElectronApp(config);
