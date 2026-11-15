import { app } from "electron";
import electronUpdater from "electron-updater";
import { createCapacitorElectronApp } from "@capawesome/capacitor-electron";
import config from "./capacitor.electron.config";

const { autoUpdater } = electronUpdater;

app.on("ready", () => {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdatesAndNotify().catch(() => {
    console.error("Shanaya could not check for desktop updates.");
  });
});

createCapacitorElectronApp(config);
