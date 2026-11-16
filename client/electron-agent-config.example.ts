import { BrowserWindow } from "electron";
import { defineConfig } from "@capawesome/capacitor-electron/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installHANNAHComputerBridge } from "./electron-agent-main.example.cjs";

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  hooks: {
    // Keep every security option from the platform and replace only its preload
    // with the combined Capacitor + HANNAH preload example.
    windowFactory: (options) => new BrowserWindow({
      ...options,
      webPreferences: {
        ...options.webPreferences,
        preload: path.join(electronDirectory, "electron-agent-preload.cjs"),
      },
    }),
    onWindowCreated: (window) => installHANNAHComputerBridge(window),
  },
});
