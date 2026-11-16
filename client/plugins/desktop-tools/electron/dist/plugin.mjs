// Electron side of the HannahDesktop Capacitor plugin. One instance lives in
// the main process; the web page reaches only the methods in BRIDGED_METHODS.
// Native dialogs come from here, so web content can't fake an approval.
import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";
import { BRIDGED_METHODS, createDesktopTools } from "./core.mjs";

const parentWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

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
      reveal: async (folder) => {
        const error = await shell.openPath(folder);
        if (error) throw new Error(error);
      },
    });
  }
}

for (const method of BRIDGED_METHODS) {
  HannahDesktopImpl.prototype[method] = function bridged(options) {
    return this.tools[method](options ?? {});
  };
}

HannahDesktopImpl.__capacitorElectronPlugin = { name: "HannahDesktop", methods: [...BRIDGED_METHODS] };

export { HannahDesktopImpl as HannahDesktop };
