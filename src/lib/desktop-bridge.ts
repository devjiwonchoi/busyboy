// The small API the desktop app's preload script (electron/preload.ts) gives
// the page. In a plain browser (`next dev`, journeys) it is missing, and the
// UI falls back to typing a folder path.

/** IPC channel of the native folder picker. */
export const PICK_FOLDERS_CHANNEL = 'busyboy:pick-folders'

/** IPC channel on which the desktop app asks an open window to show a tray or notification item. */
export const FOCUS_CHANNEL = 'busyboy:focus'

/** IPC channel on which the desktop app tells an open window that an update was downloaded. */
export const UPDATE_READY_CHANNEL = 'busyboy:update-ready'

/** IPC channel that answers with the version of the downloaded update, or null. */
export const UPDATE_STATE_CHANNEL = 'busyboy:update-state'

/** IPC channel that restarts the app into the downloaded update. */
export const INSTALL_UPDATE_CHANNEL = 'busyboy:install-update'

/** Name of the bridge on `window`. */
export const DESKTOP_BRIDGE_KEY = 'busyboyDesktop'

export type DesktopBridge = {
  /** Opens the native folder picker. Resolves to the chosen folders, or [] when cancelled. */
  pickFolders(): Promise<string[]>
  /** The absolute path of a dropped file or folder (Electron hides `File.path` since v32). */
  pathForFile(file: File): string
  /**
   * Calls `listener` with a focus target (src/lib/focus-target.ts, as text)
   * whenever the user picks an item in the tray or clicks a notification.
   * Returns the function that stops listening.
   */
  onFocus(listener: (target: string) => void): () => void
  /** The version of an update that is downloaded and ready to install, or null. */
  readyUpdate(): Promise<string | null>
  /** Calls `listener` with the version when an update finishes downloading. Returns the function that stops listening. */
  onUpdateReady(listener: (version: string) => void): () => void
  /** Restarts the app into the downloaded update. */
  installUpdate(): Promise<void>
}

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as Record<string, DesktopBridge | undefined>)[DESKTOP_BRIDGE_KEY]
}
