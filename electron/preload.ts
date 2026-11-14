import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_BRIDGE_KEY, FOCUS_CHANNEL, PICK_FOLDERS_CHANNEL, type DesktopBridge } from '../src/lib/desktop-bridge'

// Runs sandboxed with context isolation, so the page gets these functions
// and nothing else from Electron.
const bridge: DesktopBridge = {
  pickFolders: () => ipcRenderer.invoke(PICK_FOLDERS_CHANNEL),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onFocus: (listener) => {
    // Only the target text reaches the page, never the IPC event and its sender.
    const handler = (_event: Electron.IpcRendererEvent, target: unknown) => {
      if (typeof target === 'string') listener(target)
    }
    ipcRenderer.on(FOCUS_CHANNEL, handler)
    return () => void ipcRenderer.off(FOCUS_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge)
