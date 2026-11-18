// why: In a plain browser the preload bridge is missing, and the UI falls back to typing a folder path.

export const PICK_FOLDERS_CHANNEL = "busyboy:pick-folders";

export const FOCUS_CHANNEL = "busyboy:focus";

export const UPDATE_READY_CHANNEL = "busyboy:update-ready";

export const UPDATE_STATE_CHANNEL = "busyboy:update-state";

export const APP_VERSION_CHANNEL = "busyboy:app-version";

export const INSTALL_UPDATE_CHANNEL = "busyboy:install-update";

export const OPEN_IN_EDITOR_CHANNEL = "busyboy:open-in-editor";

export const REVEAL_IN_FOLDER_CHANNEL = "busyboy:reveal-in-folder";

export const DESKTOP_BRIDGE_KEY = "busyboyDesktop";

export type DesktopBridge = {
  pickFolders(): Promise<string[]>;
  /*why: * The absolute path of a dropped file or folder (Electron hides `File.path` since v32). */
  pathForFile(file: File): string;
  // why: Electron hides File.path since v32, so the bridge is the only way to read a dropped path.
  onFocus(listener: (target: string) => void): () => void;
  readyUpdate(): Promise<string | null>;
  onUpdateReady(listener: (version: string) => void): () => void;
  // why: release.yml builds the Next bundle before the release version exists. Electron stamps it later.
  appVersion(): Promise<string>;
  installUpdate(): Promise<void>;
  openInEditor(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
};

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, DesktopBridge | undefined>)[DESKTOP_BRIDGE_KEY];
}
