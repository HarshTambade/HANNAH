require("@capawesome/capacitor-electron/preload");

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hannahDesktop", {
  confirmAction: (action, input) => ipcRenderer.invoke("hannah:computer:confirm", { action, input }),
  screenshot: (approvalToken) => ipcRenderer.invoke("hannah:computer:screenshot", approvalToken),
  perform: (action, input, approvalToken) => ipcRenderer.invoke("hannah:computer:perform", { action, input, approvalToken }),
});
