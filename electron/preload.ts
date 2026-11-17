import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  DESKTOP_BRIDGE_KEY,
  FOCUS_CHANNEL,
  INSTALL_UPDATE_CHANNEL,
  OPEN_IN_EDITOR_CHANNEL,
  PICK_FOLDERS_CHANNEL,
  REVEAL_IN_FOLDER_CHANNEL,
  UPDATE_READY_CHANNEL,
  UPDATE_STATE_CHANNEL,
  type DesktopBridge,
} from "../src/lib/desktop-bridge";

// Sandboxed, with context isolation, so the page gets these functions and nothing else from Electron.
const bridge: DesktopBridge = {
  pickFolders: () => ipcRenderer.invoke(PICK_FOLDERS_CHANNEL),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onFocus: (listener) => {
    // Only the target text reaches the page, never the IPC event and its sender.
    const handler = (_event: Electron.IpcRendererEvent, target: unknown) => {
      if (typeof target === "string") listener(target);
    };
    ipcRenderer.on(FOCUS_CHANNEL, handler);
    return () => void ipcRenderer.off(FOCUS_CHANNEL, handler);
  },
  readyUpdate: () => ipcRenderer.invoke(UPDATE_STATE_CHANNEL),
  onUpdateReady: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, version: unknown) => {
      if (typeof version === "string") listener(version);
    };
    ipcRenderer.on(UPDATE_READY_CHANNEL, handler);
    return () => void ipcRenderer.off(UPDATE_READY_CHANNEL, handler);
  },
  installUpdate: () => ipcRenderer.invoke(INSTALL_UPDATE_CHANNEL),
  openInEditor: (folder) => ipcRenderer.invoke(OPEN_IN_EDITOR_CHANNEL, folder),
  revealInFolder: (folder) => ipcRenderer.invoke(REVEAL_IN_FOLDER_CHANNEL, folder),
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge);
