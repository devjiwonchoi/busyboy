import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_BRIDGE_KEY, PICK_FOLDERS_CHANNEL, type DesktopBridge } from '../src/lib/desktop-bridge'

// Runs sandboxed with context isolation, so the page gets these two functions
// and nothing else from Electron.
const bridge: DesktopBridge = {
  pickFolders: () => ipcRenderer.invoke(PICK_FOLDERS_CHANNEL),
  pathForFile: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_KEY, bridge)
