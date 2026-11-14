// The small API the desktop app's preload script (electron/preload.ts) gives
// the page. In a plain browser (`next dev`, journeys) it is missing, and the
// UI falls back to typing a folder path.

/** IPC channel of the native folder picker. */
export const PICK_FOLDERS_CHANNEL = 'busyboy:pick-folders'

/** Name of the bridge on `window`. */
export const DESKTOP_BRIDGE_KEY = 'busyboyDesktop'

export type DesktopBridge = {
  /** Opens the native folder picker. Resolves to the chosen folders, or [] when cancelled. */
  pickFolders(): Promise<string[]>
  /** The absolute path of a dropped file or folder (Electron hides `File.path` since v32). */
  pathForFile(file: File): string
}

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as Record<string, DesktopBridge | undefined>)[DESKTOP_BRIDGE_KEY]
}
