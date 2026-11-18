export const UPDATE_READY_CHANNEL = "busyboy:update-ready";

export const UPDATE_STATE_CHANNEL = "busyboy:update-state";

export const APP_VERSION_CHANNEL = "busyboy:app-version";

export const INSTALL_UPDATE_CHANNEL = "busyboy:install-update";

export const DESKTOP_BRIDGE_KEY = "busyboyDesktop";

export type DesktopBridge = {
  readyUpdate(): Promise<string | null>;
  onUpdateReady(listener: (version: string) => void): () => void;
  // why: release.yml builds the Next bundle before the release version exists. Electron stamps it later.
  appVersion(): Promise<string>;
  installUpdate(): Promise<void>;
};
