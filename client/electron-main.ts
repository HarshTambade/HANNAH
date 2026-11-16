import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import electronUpdater from "electron-updater";
import { createCapacitorElectronApp } from "@capawesome/capacitor-electron";
import config from "./capacitor.electron.config";

const { autoUpdater } = electronUpdater;
const REPOSITORY = "https://github.com/HarshTambade/Shanaya-Your-AI-companion";
const isMac = process.platform === "darwin";

// Windows shows notifications (reminders) only for an app whose identity
// matches its installer; electron-builder uses the appId for it.
if (process.platform === "win32") app.setAppUserModelId("com.hannah.companion");

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on("update-available", (info) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("hannah:update-available", info);
  }
});

/** Move the app to one of its screens without reloading it. */
function openScreen(path: string) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  // `path` is one of the fixed strings in the menu below, never user input.
  void window.webContents.executeJavaScript(
    `window.history.pushState(null, "", ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent("popstate"));`,
  );
}

async function checkForUpdatesInteractively() {
  if (!app.isPackaged) {
    await dialog.showMessageBox({ type: "info", message: "Updates are checked in the installed app.", detail: "This is a development build." });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const newer = Boolean(latest && latest !== app.getVersion());
    await dialog.showMessageBox({
      type: "info",
      message: newer ? `HANNAH ${latest} is available.` : "HANNAH is up to date.",
      detail: newer ? "It's downloading now and installs when you quit HANNAH." : `You have version ${app.getVersion()}.`,
    });
  } catch {
    await dialog.showMessageBox({ type: "warning", message: "HANNAH couldn't check for updates.", detail: "Check your connection, or download the latest release from GitHub." });
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
    { label: isMac ? "Go" : "&Go", submenu: go },
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

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: "HANNAH",
    applicationVersion: app.getVersion(),
    copyright: "© 2026 Harsh Tambade and HANNAH contributors",
    website: REPOSITORY,
  });
  buildMenu();
});

app.on("ready", () => {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdatesAndNotify().catch(() => {
    console.error("HANNAH could not check for desktop updates.");
  });
});

// Expose a manual check hook for the renderer if a preload bridge is added later.
ipcMain.handle("hannah:check-for-updates", async () => {
  if (!app.isPackaged) return { available: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { available: Boolean(result?.updateInfo) };
  } catch {
    return { available: false };
  }
});

createCapacitorElectronApp(config);
