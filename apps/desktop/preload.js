const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hannahDesktop", Object.freeze({
  platform: process.platform,
  confirmAction: (message) => ipcRenderer.invoke("hannah:confirm", String(message).slice(0, 2000)),
}));
