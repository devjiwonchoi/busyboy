import { contextBridge, ipcRenderer } from "electron";

import {
  APP_VERSION_CHANNEL,
  DESKTOP_BRIDGE_KEY,
  INSTALL_UPDATE_CHANNEL,
  UPDATE_READY_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type DesktopBridge,
} from "../web/lib/desktop-bridge";

// why: Sandboxed, with context isolation, so the page gets these functions and nothing else from Electron.
const bridge: DesktopBridge = {
  readyUpdate: () => ipcRenderer.invoke(UPDATE_STATE_CHANNEL),
  appVersion: () => ipcRenderer.invoke(APP_VERSION_CHANNEL),
  onUpdateReady: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, version: unknown) => {
      if (typeof version === "string") listener(version);
    };
    ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
    return () => void ipcRenderer.off(UPDATE_READY_CHANNEL, handler);
  },
  installUpdate: () => ipcRenderer.invoke(INSTALL_UPDATE_CHANNEL),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
