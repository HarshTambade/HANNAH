import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import { createCapacitorElectronApp } from "@capawesome/capacitor-electron";
import config from "./capacitor.electron.config";

const { autoUpdater } = electronUpdater;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on("update-available", (info) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("shanaya:update-available", info);
  }
});

app.on("ready", () => {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdatesAndNotify().catch(() => {
    console.error("Shanaya could not check for desktop updates.");
  });
});

// Expose a manual check hook for the renderer if a preload bridge is added later.
ipcMain.handle("shanaya:check-for-updates", async () => {
  if (!app.isPackaged) return { available: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { available: Boolean(result?.updateInfo) };
  } catch {
    return { available: false };
  }
});

createCapacitorElectronApp(config);
